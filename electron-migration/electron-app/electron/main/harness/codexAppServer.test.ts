import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import { inspectCodexSchemaDirectory } from "./codexSchema.js";

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
