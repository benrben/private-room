import { EventEmitter } from "node:events";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import { inspectCodexSchemaDirectory } from "./codexSchema.js";
import { nativeWorkspaceSandboxSupported } from "./seatbelt.js";

const roots: string[] = [];
const installedCodex = spawnSync(process.env.ARCELLE_CODEX_PATH ?? "codex", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeCodex(body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-fake-codex-"));
  roots.push(root);
  const executable = path.join(root, "codex");
  await writeFile(executable, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

function probeChild(
  behavior: "initialize" | "exit" | "hang",
  writes: string[],
  kills: NodeJS.Signals[],
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_654,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      kills.push(signal);
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    writes.push(chunk.toString());
    if (behavior === "initialize") {
      stdout.write(`${JSON.stringify({ id: "arcelle-capability", result: { userAgent: "fake" } })}\n`);
    }
  });
  // Raw diagnostics may contain private paths/content. The probe must drain
  // them without returning or retaining them.
  stderr.write("SECRET /Users/person/private-room\n");
  if (behavior === "exit") queueMicrotask(() => child.emit("exit", 1, null));
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("Codex app-server compatibility probe", () => {
  it("requires the installed Codex version to generate its stable schema", async () => {
    const executable = await fakeCodex(`
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  mkdir -p "$4"
  printf '%s' '{"methods":["thread/start","turn/start","turn/interrupt","item/started","item/completed","turn/completed"]}' > "$4/protocol.json"
  exit 0
fi
exit 2`);
    await expect(new CodexAppServerRuntime(executable).available()).resolves.toBe(true);
  });

  it("fails closed when app-server exists but its matching schema cannot be generated", async () => {
    const executable = await fakeCodex(`
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi
exit 2`);
    await expect(new CodexAppServerRuntime(executable).available()).resolves.toBe(false);
  });

  it.runIf(installedCodex)("loads and validates the schema from the installed Codex release", async () => {
    const runtime = new CodexAppServerRuntime();
    await expect(runtime.available()).resolves.toBe(true);
    expect(runtime.installedSchemaCompatibility()).toMatchObject({ compatible: true });
    expect(runtime.installedSchemaCompatibility()?.files).toBeGreaterThan(0);
  });

  it("requires a real initialized app-server, not a successful help command", async () => {
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const child = probeChild("initialize", writes, kills);
    const spawn = ((_options: unknown, args: string[]) => {
      expect(args).toEqual(["app-server", "--listen", "stdio://"]);
      return child;
    }) as never;
    const runtime = new CodexAppServerRuntime("codex", spawn, 100);
    await expect(runtime.verifyExposure("/workspace/SECRET-room", "/runtime", false)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"method":"initialize"');
    expect(writes[0]).not.toContain("/workspace/SECRET-room");
    expect(writes[0]).not.toContain("SECRET /Users/person/private-room");
    expect(kills).toContain("SIGTERM");
  });

  it.each(["exit", "hang"] as const)("fails closed when app-server %s before initialization", async (behavior) => {
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => probeChild(behavior, writes, kills)) as never,
      10,
    );
    await expect(runtime.verifyExposure("/workspace", "/runtime", false)).resolves.toBe(false);
    if (behavior === "hang") expect(kills).toContain("SIGTERM");
  });

  it.runIf(installedCodex && nativeWorkspaceSandboxSupported())(
    "rejects the installed app-server when real sandbox initialization cannot complete",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-live-probe-"));
      roots.push(root);
      const workspacePath = path.join(root, "workspace");
      const runtimePath = path.join(root, "runtime");
      await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
      await mkdir(runtimePath, { recursive: true });
      const runtime = new CodexAppServerRuntime();
      await expect(runtime.verifyExposure(workspacePath, runtimePath, false)).resolves.toBe(false);
    },
    15_000,
  );

  it("accepts legacy core and current collaboration schema fixtures", async () => {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    for (const fixture of ["codex-schema-v1-core.json", "codex-schema-v2-collab.json"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-fixture-"));
      roots.push(root);
      await cp(path.join(fixtureRoot, fixture), path.join(root, "protocol.json"));
      const compatibility = await inspectCodexSchemaDirectory(root);
      expect(compatibility.compatible, fixture).toBe(true);
      expect(compatibility.collaborationEvents, fixture).toBe(fixture.includes("v2"));
    }
  });

  it("fails closed when an installed schema omits a required lifecycle method", async () => {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-fixture-"));
    roots.push(root);
    await cp(path.join(fixtureRoot, "codex-schema-incompatible.json"), path.join(root, "protocol.json"));
    const compatibility = await inspectCodexSchemaDirectory(root);
    expect(compatibility.compatible).toBe(false);
    expect(compatibility.missingMethods).toContain("turn/interrupt");
    expect(compatibility.missingMethods).toContain("item/completed");
  });
});
