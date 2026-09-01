import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeWorkspaceSandboxEnvironment,
  nativeWorkspaceSeatbeltProfile,
  verifyNativeWorkspaceSandbox,
} from "./seatbelt.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-seatbelt-pure-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const runtimePath = path.join(root, "runtime", "run-one");
  await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  return { root, workspacePath, runtimePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native workspace Seatbelt pure helpers", () => {
  it("allows only provider-approved explicit settings and binds all temporary files to the run", () => {
    const ambientSecret = "ARCELLE_PURE_AMBIENT_SECRET";
    const previousSecret = process.env[ambientSecret];
    process.env[ambientSecret] = "must-not-pass";
    try {
      const claude = nativeWorkspaceSandboxEnvironment("claude", "/run/claude", {
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        ANTHROPIC_API_KEY: "mock-key",
        OPENAI_API_KEY: "wrong-provider",
        UNSAFE_SECRET: "drop-me",
      });
      expect(claude.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
      expect(claude.ANTHROPIC_API_KEY).toBe("mock-key");
      expect(claude.OPENAI_API_KEY).toBeUndefined();
      expect(claude.UNSAFE_SECRET).toBeUndefined();
      expect(claude[ambientSecret]).toBeUndefined();
      expect(claude.TMPDIR).toBe("/run/claude");
      expect(claude.CLAUDE_TMPDIR).toBe("/run/claude");
      expect(claude.CLAUDE_CODE_TMPDIR).toBe("/run/claude");

      const codex = nativeWorkspaceSandboxEnvironment("codex", "/run/codex", {
        CODEX_HOME: "/run/codex/home",
        OPENAI_API_KEY: "mock-key",
        CLAUDE_CODE_ENTRYPOINT: "wrong-provider",
        HTTP_PROXY: "http://proxy.test",
      });
      expect(codex.CODEX_HOME).toBe("/run/codex/home");
      expect(codex.OPENAI_API_KEY).toBe("mock-key");
      expect(codex.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(codex.HTTP_PROXY).toBe("http://proxy.test");
      expect(codex.HOME).toBe(os.homedir());
      expect(codex.USER).toBe(os.userInfo().username);
    } finally {
      if (previousSecret === undefined) delete process.env[ambientSecret];
      else process.env[ambientSecret] = previousSecret;
    }
  });

  it("writes a profile that grants only run and opted-in workspace access", async () => {
    const f = await fixture();
    const [workspace, runtime] = await Promise.all([
      realpath(f.workspacePath),
      realpath(f.runtimePath),
    ]);
    const readOnly = nativeWorkspaceSeatbeltProfile({
      ...f,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: false,
    });
    expect(readOnly).toContain(`(allow file-write* (subpath "${runtime}"))`);
    expect(readOnly).not.toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(readOnly).toContain(`(deny file-read* file-write* (subpath "${path.join(workspace, ".arcelle")}"))`);

    const writable = nativeWorkspaceSeatbeltProfile({
      ...f,
      executable: "/bin/sh",
      provider: "claude",
      writeEnabled: true,
    });
    expect(writable).toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(writable).not.toContain(path.join(os.homedir(), ".claude"));
  });

  it("fails closed before sandbox execution when the workspace exposes a symlink", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(f.workspacePath, "escape.txt"));
    expect(verifyNativeWorkspaceSandbox({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: true,
    })).toBe(false);
  });
});
