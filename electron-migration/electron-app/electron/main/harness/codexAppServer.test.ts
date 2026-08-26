import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "./codexAppServer.js";

const roots: string[] = [];

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
  printf '%s' '{"title":"Installed Codex protocol"}' > "$4/protocol.json"
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
});
