import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeCliExecutable } from "./nativeCli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("nativeCliExecutable", () => {
  it("finds the normal user install when a Finder-style PATH omits it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-cli-"));
    roots.push(home);
    const bin = path.join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const target = path.join(home, "codex-real");
    await writeFile(target, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, path.join(bin, "codex"));

    expect(nativeCliExecutable("codex", { PATH: "/usr/bin:/bin" }, home)).toBe(await realpath(target));
  });

  it("keeps an explicit application override authoritative", () => {
    expect(nativeCliExecutable("claude", {
      PATH: "/usr/bin:/bin",
      ARCELLE_CLAUDE_PATH: "/managed/claude",
    }, "/unused")).toBe("/managed/claude");
  });
});
