import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
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
const loginKeychainPath = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
const keychainDirectory = path.dirname(loginKeychainPath);

function existingKeychainSibling(kind: "file" | "directory"): string | null {
  try {
    for (const name of readdirSync(keychainDirectory)) {
      if (name === path.basename(loginKeychainPath)) continue;
      const candidate = path.join(keychainDirectory, name);
      const info = lstatSync(candidate);
      if (kind === "file" ? info.isFile() : info.isDirectory()) return candidate;
    }
  } catch {
    // Some test hosts do not have a user keychain directory. The live tests
    // below are conditional on the exact paths that are present.
  }
  return null;
}

const siblingKeychainFile = existingKeychainSibling("file");
const siblingKeychainDirectory = existingKeychainSibling("directory");

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
    expect(profile).toContain('(allow file-read-metadata (literal "/var"))');
    const broadDeny = profile.split("\n").find((line) => line.startsWith("(deny file-read* file-write*"));
    expect(broadDeny).toContain('(subpath "/var")');
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

  it.runIf(existsSync(loginKeychainPath))("exposes only Claude's login keychain as a read-only literal", async () => {
    const f = await fixture();
    const profile = nativeWorkspaceSeatbeltProfile({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "claude",
      writeEnabled: true,
    });
    const keychainLiteral = `(literal "${loginKeychainPath}")`;
    const keychainSubpath = `(subpath "${keychainDirectory}")`;
    const readRule = profile.split("\n").find((line) => line.startsWith("(allow file-read*") && line.includes(keychainLiteral));
    const writeRules = profile.split("\n").filter((line) => line.startsWith("(allow file-write*"));
    const claudeSessionEnv = path.join(os.homedir(), ".claude", "session-env");
    const claudeShellSnapshots = path.join(os.homedir(), ".claude", "shell-snapshots");

    expect(readRule).toContain(keychainLiteral);
    expect(readRule).not.toContain(keychainSubpath);
    expect(writeRules.every((line) => !line.includes(loginKeychainPath) && !line.includes(keychainDirectory))).toBe(true);
    expect(writeRules).toContain(`(allow file-write* (subpath "${claudeSessionEnv}") (subpath "${claudeShellSnapshots}"))`);
    expect(writeRules.every((line) => !line.includes(path.join(os.homedir(), ".claude", "history.jsonl")))).toBe(true);
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${path.join(await realpath(f.workspacePath), ".arcelle")}"))`);
  });

  it.runIf(nativeWorkspaceSandboxSupported() && existsSync(loginKeychainPath))(
    "lets Claude read login.keychain-db but denies opening it for write and still hides .arcelle",
    async () => {
      const f = await fixture();
      const privateCanary = path.join(f.workspacePath, ".arcelle", "private.txt");
      await writeFile(privateCanary, "private", "utf8");
      const profile = nativeWorkspaceSeatbeltProfile({
        workspacePath: f.workspacePath,
        runtimePath: f.runtimePath,
        executable: "/bin/sh",
        provider: "claude",
        writeEnabled: true,
      });
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          "/bin/sh",
          "-c",
          'cat "$1" >/dev/null && ! ( exec 3>> "$1" ) 2>/dev/null && ! cat "$2" >/dev/null 2>&1',
          "arcelle",
          loginKeychainPath,
          privateCanary,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status).toBe(0);
    },
  );

  it.runIf(nativeWorkspaceSandboxSupported() && siblingKeychainFile !== null)(
    "denies Claude read access to a sibling keychain file",
    async () => {
      const f = await fixture();
      const profile = nativeWorkspaceSeatbeltProfile({
        workspacePath: f.workspacePath,
        runtimePath: f.runtimePath,
        executable: "/bin/sh",
        provider: "claude",
        writeEnabled: false,
      });
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/sh", "-c", '! cat "$1" >/dev/null 2>&1', "arcelle", siblingKeychainFile!],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status).toBe(0);
    },
  );

  it.runIf(nativeWorkspaceSandboxSupported() && siblingKeychainDirectory !== null)(
    "denies Claude directory reads for a sibling keychain directory",
    async () => {
      const f = await fixture();
      const profile = nativeWorkspaceSeatbeltProfile({
        workspacePath: f.workspacePath,
        runtimePath: f.runtimePath,
        executable: "/bin/sh",
        provider: "claude",
        writeEnabled: false,
      });
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/sh", "-c", '! /bin/ls "$1" >/dev/null 2>&1', "arcelle", siblingKeychainDirectory!],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status).toBe(0);
    },
  );

  it.runIf(nativeWorkspaceSandboxSupported())("allows /var symlink traversal without exposing its file data", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside-via-var.txt");
    await writeFile(outside, "outside", "utf8");
    const canonicalOutside = await realpath(outside);
    expect(canonicalOutside.startsWith("/private/var/")).toBe(true);
    const aliasOutside = canonicalOutside.replace(/^\/private\/var/, "/var");
    const profile = nativeWorkspaceSeatbeltProfile({
      workspacePath: f.workspacePath,
      runtimePath: f.runtimePath,
      executable: "/bin/sh",
      provider: "codex",
      writeEnabled: false,
    });
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/sh", "-c", 'test -d /var && ! cat "$1" >/dev/null 2>&1', "arcelle", aliasOutside],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(0);
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

  it.runIf(nativeWorkspaceSandboxSupported())(
    "derives a GUI-safe identity, preserves provider settings, and drops ambient secrets",
    async () => {
      const f = await fixture();
      const ambientSecretKey = "ARCELLE_SANDBOX_AMBIENT_SECRET_CANARY";
      const previousSecret = process.env[ambientSecretKey];
      const previousUser = process.env.USER;
      process.env[ambientSecretKey] = "must-not-be-inherited";
      delete process.env.USER;
      try {
        const child = spawnWithNativeWorkspaceSandbox({
          workspacePath: f.workspacePath,
          runtimePath: f.runtimePath,
          executable: "/bin/sh",
          provider: "claude",
          writeEnabled: false,
        }, [
          "-c",
          'test "$USER" = "$1" && test -n "$HOME" && test "$CLAUDE_CODE_ENTRYPOINT" = "sdk-ts" && test -z "$ARCELLE_SANDBOX_AMBIENT_SECRET_CANARY"',
          "arcelle",
          os.userInfo().username,
        ], {
          cwd: f.workspacePath,
          // The real Claude SDK sends a copy of the complete process env.
          env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
        });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        expect(result).toEqual({ code: 0, signal: null });
      } finally {
        if (previousSecret === undefined) delete process.env[ambientSecretKey];
        else process.env[ambientSecretKey] = previousSecret;
        if (previousUser === undefined) delete process.env.USER;
        else process.env.USER = previousUser;
      }
    },
  );

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
    // `app-server` eagerly opens Codex's mutable global SQLite state and may
    // correctly exit when this strict workspace sandbox denies that location
    // (or another installed Codex process owns it). `exec-server` is Codex's
    // long-running stdin service and exercises the same installed executable,
    // Seatbelt wrapper, detached process group, and cancellation path without
    // depending on unrelated provider-global state.
    { provider: "codex" as const, executable: process.env.ARCELLE_CODEX_PATH ?? "codex", args: ["exec-server"] },
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
    }, args, { cwd: f.workspacePath });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // Subscribe before Stop. A small native process can acknowledge SIGTERM
    // before the next JavaScript statement; attaching afterwards misses the
    // one-shot exit event and turns successful cleanup into a timeout.
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(terminateNativeProcessTree(child, "SIGTERM", 250)).toBe(true);
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${provider} did not exit after cancellation.`)), 5_000)),
    ]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);
});
