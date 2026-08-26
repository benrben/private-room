import { EventEmitter } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime, prepareCodexRuntimeHome } from "./codexAppServer.js";
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

async function codexHomeFixture(): Promise<{
  root: string;
  sourceHome: string;
  runtimePath: string;
  workspacePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-home-test-"));
  roots.push(root);
  const sourceHome = path.join(root, "source-home");
  const runtimePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "test-auth", { mode: 0o644 });
  await writeFile(path.join(sourceHome, "config.toml"), "model = 'test'", { mode: 0o644 });
  await writeFile(path.join(sourceHome, "history.jsonl"), "private history", { mode: 0o600 });
  return { root, sourceHome, runtimePath, workspacePath };
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

function completingTurnChild(
  requests: Array<Record<string, unknown>>,
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_655,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      const id = message.id;
      if (id === undefined) continue;
      if (message.method === "initialize") {
        queueMicrotask(() => stdout.write(`${JSON.stringify({ id, result: { userAgent: "fake" } })}\n`));
      } else if (message.method === "thread/start") {
        queueMicrotask(() => stdout.write(`${JSON.stringify({ id, result: { thread: { id: "thread-1" } } })}\n`));
      } else if (message.method === "turn/start") {
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ id, result: { turn: { id: "turn-1" } } })}\n`);
          setImmediate(() => stdout.write(`${JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          })}\n`));
        });
      }
    }
  });
  stdin.on("finish", () => queueMicrotask(() => child.emit("exit", 0, null)));
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("Codex app-server compatibility probe", () => {
  it("creates a private runtime home with only auth and config", async () => {
    const fixture = await codexHomeFixture();
    const runtimeHome = await prepareCodexRuntimeHome(fixture.runtimePath, fixture.sourceHome);

    expect(path.dirname(runtimeHome)).toBe(await realpath(fixture.runtimePath));
    expect((await stat(runtimeHome)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(runtimeHome, "auth.json"), "utf8")).toBe("test-auth");
    expect(await readFile(path.join(runtimeHome, "config.toml"), "utf8")).toBe("model = 'test'");
    expect((await stat(path.join(runtimeHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(runtimeHome, "config.toml"))).mode & 0o777).toBe(0o600);
    await expect(access(path.join(runtimeHome, "history.jsonl"))).rejects.toThrow();
  });

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
    const fixture = await codexHomeFixture();
    const expectedRuntimeHome = path.join(await realpath(fixture.runtimePath), "codex-home");
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const child = probeChild("initialize", writes, kills);
    const spawn = ((_options: unknown, args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(spawnOptions.env?.CODEX_HOME).toBe(expectedRuntimeHome);
      return child;
    }) as never;
    const runtime = new CodexAppServerRuntime("codex", spawn, 100, fixture.sourceHome);
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"method":"initialize"');
    expect(writes[0]).not.toContain("/workspace/SECRET-room");
    expect(writes[0]).not.toContain("SECRET /Users/person/private-room");
    expect(kills).toContain("SIGTERM");
  });

  it.each(["exit", "hang"] as const)("fails closed when app-server %s before initialization", async (behavior) => {
    const fixture = await codexHomeFixture();
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => probeChild(behavior, writes, kills)) as never,
      10,
      fixture.sourceHome,
    );
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(false);
    if (behavior === "hang") expect(kills).toContain("SIGTERM");
  });

  it("uses the isolated runtime home for the real turn process", async () => {
    const fixture = await codexHomeFixture();
    const expectedRuntimeHome = path.join(await realpath(fixture.runtimePath), "codex-home");
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    let spawnedHome: string | undefined;
    const runtime = new CodexAppServerRuntime(
      "codex",
      ((_options: unknown, _args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
        spawnedHome = spawnOptions.env?.CODEX_HOME;
        return probeChild("hang", writes, kills);
      }) as never,
      100,
      fixture.sourceHome,
    );

    const run = await runtime.startTurn({
      runId: "run-1",
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: true,
    }, { text: "Read the workspace." });

    expect(spawnedHome).toBe(expectedRuntimeHome);
    expect(writes[0]).toContain('"method":"initialize"');
    await run.cancel();
    for await (const _event of run.events) { /* drain terminal cleanup */ }
    expect(kills).toContain("SIGTERM");
  });

  it.each([
    { writeEnabled: false, threadSandbox: "read-only", turnSandbox: { type: "readOnly" } },
    {
      writeEnabled: true,
      threadSandbox: "workspace-write",
      turnSandbox: { type: "workspaceWrite", networkAccess: false },
    },
  ])("uses current Codex request enums when writeEnabled=$writeEnabled", async ({
    writeEnabled,
    threadSandbox,
    turnSandbox,
  }) => {
    const fixture = await codexHomeFixture();
    const requests: Array<Record<string, unknown>> = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => completingTurnChild(requests)) as never,
      100,
      fixture.sourceHome,
    );
    const run = await runtime.startTurn({
      runId: `run-${writeEnabled ? "write" : "read"}`,
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled,
      exposureVerified: true,
    }, { text: "Review notes.md." });
    for await (const _event of run.events) { /* wait for the complete protocol */ }

    const threadStart = requests.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: threadSandbox,
    });
    const turnStart = requests.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: turnSandbox,
    });
  });

  it.runIf(installedCodex && nativeWorkspaceSandboxSupported())(
    "initializes the installed app-server with isolated mutable state",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-live-probe-"));
      roots.push(root);
      const workspacePath = path.join(root, "workspace");
      const runtimePath = path.join(root, "runtime");
      await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
      await mkdir(runtimePath, { recursive: true });
      const runtime = new CodexAppServerRuntime();
      await expect(runtime.verifyExposure(workspacePath, runtimePath, false)).resolves.toBe(true);
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
