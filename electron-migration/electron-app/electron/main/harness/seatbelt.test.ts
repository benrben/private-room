import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeWorkspaceSandboxSupported,
  nativeWorkspaceSeatbeltProfile,
  verifyNativeHarnessExecutable,
  verifyNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  spawnWithNativeWorkspaceSandbox,
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
    const f = await fixture();
    const grandchildPidPath = path.join(f.runtimePath, "grandchild.pid");
    const child = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > "${grandchildPidPath}"; wait`], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let grandchildPid = 0;
    for (let attempt = 0; attempt < 100 && grandchildPid === 0; attempt += 1) {
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8").catch(() => "0"));
      if (grandchildPid === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(grandchildPid).toBeGreaterThan(0);
    expect(terminateNativeProcessTree(child)).toBe(true);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode === null || child.signalCode === "SIGTERM").toBe(true);
    let grandchildAlive = true;
    for (let attempt = 0; attempt < 100 && grandchildAlive; attempt += 1) {
      try { process.kill(grandchildPid, 0); }
      catch { grandchildAlive = false; }
      if (grandchildAlive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(grandchildAlive).toBe(false);
  });

  it.runIf(process.platform !== "win32")("escalates to SIGKILL when a native process group ignores SIGTERM", async () => {
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminateNativeProcessTree(child, "SIGTERM", 25)).toBe(true);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.signalCode).toBe("SIGKILL");
  });

  it.each([
    { provider: "codex" as const, executable: process.env.ARCELLE_CODEX_PATH ?? "codex", args: ["app-server", "--listen", "stdio://"] },
    { provider: "claude" as const, executable: process.env.ARCELLE_CLAUDE_PATH ?? "claude", args: ["-p", "--output-format", "json"] },
  ])("starts and cancels the installed $provider CLI inside the real sandbox", async ({ provider, executable, args }) => {
    if (!nativeWorkspaceSandboxSupported()) return;
    if (spawnSync(executable, ["--version"], { stdio: "ignore", timeout: 5_000 }).status !== 0) return;
    const f = await fixture();
    const child = spawnWithNativeWorkspaceSandbox({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable,
      provider,
      writeEnabled: false,
    }, args, { cwd: f.workspacePath, env: process.env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminateNativeProcessTree(child, "SIGTERM", 250)).toBe(true);
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${provider} did not exit after cancellation.`)), 5_000)),
    ]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);
});
