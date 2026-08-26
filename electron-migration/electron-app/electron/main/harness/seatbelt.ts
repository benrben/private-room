import { existsSync, lstatSync, realpathSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

function quoteSeatbelt(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function canonical(value: string): string {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

function clauses(paths: readonly string[]): string {
  return paths.map((entry) => `(subpath ${quoteSeatbelt(path.resolve(entry))})`).join(" ");
}

function literalClauses(paths: readonly string[]): string {
  return paths.filter(existsSync).map((entry) => `(literal ${quoteSeatbelt(path.resolve(entry))})`).join(" ");
}

function ancestorPaths(paths: readonly string[]): string[] {
  const result = new Set<string>(["/"]);
  for (const entry of paths) {
    let current = path.resolve(entry);
    while (current !== "/") {
      result.add(current);
      current = path.dirname(current);
    }
  }
  return [...result];
}

function executablePath(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidate = path.isAbsolute(command)
    ? command
    : spawnSync("/usr/bin/which", [command], { encoding: "utf8", env }).stdout.trim();
  if (candidate.length === 0 || !existsSync(candidate)) return null;
  try { return realpathSync(candidate); } catch { return null; }
}

export interface NativeWorkspaceSandbox {
  workspacePath: string;
  runtimePath: string;
  executable: string;
  provider: "codex" | "claude";
  writeEnabled: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Fail-closed outer process sandbox for writable macOS data locations. */
export function nativeWorkspaceSeatbeltProfile(options: NativeWorkspaceSandbox): string {
  const workspace = canonical(options.workspacePath);
  const runtime = canonical(options.runtimePath);
  const executable = executablePath(options.executable, options.env ?? process.env);
  if (executable === null) throw new Error(`The ${options.provider} executable could not be resolved.`);
  const home = os.homedir();
  const providerRead = options.provider === "codex"
    ? [path.dirname(executable), path.join(home, ".codex", "packages", "standalone")]
    : [path.dirname(executable)];
  const providerLiterals = options.provider === "codex"
    ? [path.join(home, ".codex", "auth.json"), path.join(home, ".codex", "config.toml")]
    : [];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* ${clauses([
      "/Users", "/Volumes", "/Applications", "/Library", "/opt", "/private",
      "/tmp", "/var", "/Network", "/home", "/cores",
    ])})`,
    `(allow file-read-metadata ${literalClauses(ancestorPaths([
      workspace, runtime, executable, ...providerRead, ...providerLiterals,
    ]))})`,
    `(allow file-read* ${clauses(["/Library/Apple", "/private/etc", "/private/var/db", "/dev"])})`,
    `(allow file-read* ${clauses([workspace, runtime, ...providerRead])} ${literalClauses(providerLiterals)})`,
    `(allow file-write* (subpath ${quoteSeatbelt(runtime)}))`,
    options.writeEnabled ? `(allow file-write* (subpath ${quoteSeatbelt(workspace)}))` : "",
    `(deny file-read* file-write* (subpath ${quoteSeatbelt(path.join(workspace, ".arcelle"))}))`,
  ].filter((line) => line.length > 0).join("\n");
}

export function nativeWorkspaceSandboxSupported(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

function containsExposedSymlink(rootPath: string): boolean {
  if (lstatSync(rootPath).isSymbolicLink()) return true;
  const walk = (directory: string, root: boolean): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (root && entry.name.toLocaleLowerCase("en-US") === ".arcelle") continue;
      const candidate = path.join(directory, entry.name);
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) return true;
      if (info.isDirectory() && walk(candidate, false)) return true;
    }
    return false;
  };
  return walk(rootPath, true);
}

/** Tests room access, `.arcelle` denial and sibling read/write denial. */
export function verifyNativeWorkspaceSandbox(options: NativeWorkspaceSandbox): boolean {
  if (!nativeWorkspaceSandboxSupported()) return false;
  try {
    if (containsExposedSymlink(options.workspacePath)) return false;
  } catch {
    return false;
  }
  const workspace = canonical(options.workspacePath);
  const runtime = path.resolve(options.runtimePath);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const canonicalRuntime = canonical(runtime);
  const token = randomUUID();
  // Matches WorkspaceWatcher's ignored atomic-temp form, so a capability
  // canary cannot briefly appear as a user file in the room UI.
  const allowed = path.join(workspace, `.sandbox.arcelle-${token}.tmp`);
  const privateCanary = path.join(workspace, ".arcelle", token);
  const outside = path.join(path.dirname(canonicalRuntime), `${token}-outside`);
  const runtimeCanary = path.join(canonicalRuntime, token);
  try {
    writeFileSync(allowed, "allowed", { mode: 0o600, flag: "wx" });
    writeFileSync(privateCanary, "private", { mode: 0o600, flag: "wx" });
    writeFileSync(outside, "outside", { mode: 0o600, flag: "wx" });
    const script = options.writeEnabled
      ? 'cat "$1" >/dev/null && ! cat "$2" >/dev/null 2>&1 && ! cat "$3" >/dev/null 2>&1 && ! ( : > "$3" ) 2>/dev/null && : > "$4" && : > "$1"'
      : 'cat "$1" >/dev/null && ! cat "$2" >/dev/null 2>&1 && ! cat "$3" >/dev/null 2>&1 && ! ( : > "$3" ) 2>/dev/null && : > "$4" && ! ( : > "$1" ) 2>/dev/null';
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", nativeWorkspaceSeatbeltProfile(options), "/bin/sh", "-c", script, "arcelle", allowed, privateCanary, outside, runtimeCanary],
      {
        encoding: "utf8",
        timeout: 5_000,
        cwd: workspace,
        env: { ...options.env, TMPDIR: canonicalRuntime, CLAUDE_TMPDIR: canonicalRuntime, CLAUDE_CODE_TMPDIR: canonicalRuntime },
      },
    );
    return result.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(allowed, { force: true });
    rmSync(privateCanary, { force: true });
    rmSync(outside, { force: true });
    rmSync(runtimeCanary, { force: true });
  }
}

/** Sandbox canaries plus a real provider startup probe. */
export function verifyNativeHarnessExecutable(
  options: NativeWorkspaceSandbox,
  args: readonly string[],
): boolean {
  if (!verifyNativeWorkspaceSandbox(options)) return false;
  const executable = executablePath(options.executable, options.env ?? process.env);
  if (executable === null) return false;
  const runtime = canonical(options.runtimePath);
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", nativeWorkspaceSeatbeltProfile(options), executable, ...args],
    {
      cwd: canonical(options.workspacePath),
      env: { ...options.env, TMPDIR: runtime, CLAUDE_TMPDIR: runtime, CLAUDE_CODE_TMPDIR: runtime },
      stdio: "ignore",
      timeout: 5_000,
    },
  );
  return result.status === 0;
}

export function spawnWithNativeWorkspaceSandbox(
  options: NativeWorkspaceSandbox,
  args: string[],
  spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): ChildProcessWithoutNullStreams {
  if (!verifyNativeWorkspaceSandbox(options)) {
    throw new Error("Native direct-file mode is unavailable because workspace isolation failed.");
  }
  const runtime = path.resolve(options.runtimePath);
  const executable = executablePath(options.executable, spawnOptions.env ?? options.env ?? process.env);
  if (executable === null) throw new Error(`The ${options.provider} executable could not be resolved.`);
  return spawn(
    "/usr/bin/sandbox-exec",
    ["-p", nativeWorkspaceSeatbeltProfile(options), executable, ...args],
    {
      cwd: spawnOptions.cwd,
      env: { ...spawnOptions.env, TMPDIR: runtime, CLAUDE_TMPDIR: runtime, CLAUDE_CODE_TMPDIR: runtime },
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

// Old `.arcelle`-only API stays fail-closed; callers must provide a run path.
export function verifyPrivatePathSandbox(_workspacePath: string): boolean { return false; }
export function spawnWithPrivatePathSandbox(): never {
  throw new Error("A run-private path is required for native workspace isolation.");
}
