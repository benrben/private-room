import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeWorkspaceSandboxSupported,
  nativeWorkspaceSeatbeltProfile,
  verifyNativeHarnessExecutable,
  verifyNativeWorkspaceSandbox,
  terminateNativeProcessTree,
} from "./seatbelt.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-sandbox-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const runtimePath = path.join(root, "runtime", "run-one");
  await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  return { root, workspacePath, runtimePath };
}

describe("native workspace Seatbelt", () => {
  it("uses broad data-root denies and narrower workspace/private rules", async () => {
    const f = await fixture();
    const profile = nativeWorkspaceSeatbeltProfile({
      ...f,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: true,
    });
    const canonicalWorkspace = await realpath(f.workspacePath);
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users")');
    expect(profile).toContain(`(allow file-write* (subpath "${canonicalWorkspace}"))`);
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${path.join(canonicalWorkspace, ".arcelle")}"))`);
  });

  it.runIf(nativeWorkspaceSandboxSupported())("proves read/write isolation for a write run", async () => {
    const f = await fixture();
    expect(verifyNativeWorkspaceSandbox({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: true,
    })).toBe(true);
  });

  it.runIf(nativeWorkspaceSandboxSupported())("proves that read-only mode cannot write the workspace", async () => {
    const f = await fixture();
    expect(verifyNativeWorkspaceSandbox({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: false,
    })).toBe(true);
  });

  it.runIf(nativeWorkspaceSandboxSupported())("refuses an exposed workspace symlink", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(f.workspacePath, "escape.txt"));
    expect(verifyNativeWorkspaceSandbox({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: true,
    })).toBe(false);
  });

  it.runIf(nativeWorkspaceSandboxSupported())("starts the selected executable inside the same sandbox", async () => {
    const f = await fixture();
    expect(verifyNativeHarnessExecutable({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: false,
    }, ["-c", "exit 0"])).toBe(true);
  });

  it.runIf(process.platform !== "win32")("terminates the native harness process group", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    expect(terminateNativeProcessTree(child)).toBe(true);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode === null || child.signalCode === "SIGTERM").toBe(true);
  });
});
