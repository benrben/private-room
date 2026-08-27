import { existsSync, lstatSync, realpathSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

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

// Native CLIs need the ordinary macOS user identity to resolve first-party
// Keychain sessions, plus a small set of non-secret process settings for
// shells and locale handling. Do not inherit the complete Electron process
// environment: it can contain unrelated provider keys or application secrets.
const SAFE_AMBIENT_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "__CF_USER_TEXT_ENCODING",
] as const;

const SAFE_EXPLICIT_ENV_KEYS = new Set<string>([
  ...SAFE_AMBIENT_ENV_KEYS,
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ARCELLE_ROOM_MCP_TOKEN",
]);

function providerEnvironmentKey(provider: NativeWorkspaceSandbox["provider"], key: string): boolean {
  if (SAFE_EXPLICIT_ENV_KEYS.has(key)) return true;
  return provider === "claude"
    ? key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")
    : key.startsWith("CODEX_") || key.startsWith("OPENAI_");
}

function nativeSandboxEnvironment(
  provider: NativeWorkspaceSandbox["provider"],
  runtimePath: string,
  ...explicitSources: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
  const username = os.userInfo().username;
  const env: NodeJS.ProcessEnv = {
    HOME: os.homedir(),
    USER: username,
    LOGNAME: username,
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
  };
  for (const key of SAFE_AMBIENT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const source of explicitSources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (providerEnvironmentKey(provider, key) && value !== undefined) env[key] = value;
    }
  }
  env.TMPDIR = runtimePath;
  env.CLAUDE_TMPDIR = runtimePath;
  env.CLAUDE_CODE_TMPDIR = runtimePath;
  return env;
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
    // Claude Code stores its first-party session in the login keychain. The
    // executable reports "not logged in" when seatbelt cannot read the
    // keychain database, even though Security.framework owns the secret
    // lookup. Expose only that encrypted database as a read-only literal;
    // sibling keychains and every keychain write remain denied.
    : [path.join(home, "Library", "Keychains", "login.keychain-db")];
  const providerState = options.provider === "claude"
    ? [path.join(home, ".claude", "session-env"), path.join(home, ".claude", "shell-snapshots")]
    : [];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* ${clauses([
      "/Users", "/Volumes", "/Applications", "/Library", "/opt", "/private",
      "/tmp", "/var", "/Network", "/home", "/cores",
    ])})`,
    `(allow file-read-metadata ${literalClauses(ancestorPaths([
      workspace, runtime, executable, ...providerRead, ...providerLiterals, ...providerState,
    ]))})`,
    // macOS hostname resolution traverses the public /var symlink before it
    // reaches /private/var. Metadata for the symlink itself is enough; file
    // data and every write below /var remain covered by the broad deny above.
    `(allow file-read-metadata (literal "/var"))`,
    `(allow file-read* ${clauses(["/Library/Apple", "/private/etc", "/private/var/db", "/dev"])})`,
    `(allow file-read* ${clauses([workspace, runtime, ...providerRead, ...providerState])} ${literalClauses(providerLiterals)})`,
    `(allow file-write* (subpath ${quoteSeatbelt(runtime)}))`,
    // Claude prepares Bash commands through these two internal state folders
    // before its own nested, fail-closed command sandbox starts. The nested
    // sandbox still grants the agent command only the verified workspace.
    providerState.length > 0 ? `(allow file-write* ${clauses(providerState)})` : "",
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
        env: nativeSandboxEnvironment(options.provider, canonicalRuntime, options.env),
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
      env: nativeSandboxEnvironment(options.provider, runtime, options.env),
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
      env: nativeSandboxEnvironment(options.provider, runtime, options.env, spawnOptions.env),
      signal: spawnOptions.signal,
      // Give every native harness its own process group. Codex and Claude can
      // create helper processes, so killing only sandbox-exec can otherwise
      // leave a descendant alive after Stop, room lock, or app shutdown.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

/** Stop the complete native harness process tree, not only its launcher. */
export function terminateNativeProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals = "SIGTERM",
  forceAfterMs = 2_000,
): boolean {
  if (child.pid === undefined) return false;
  const pid = child.pid;
  const scheduleForce = (terminated: boolean): boolean => {
    if (!terminated || signal === "SIGKILL" || forceAfterMs < 0) return terminated;
    const timer = setTimeout(() => {
      if (process.platform !== "win32") {
        try { process.kill(-pid, "SIGKILL"); return; } catch { /* group is already gone */ }
      }
      try { child.kill("SIGKILL"); } catch { /* process is already gone */ }
    }, forceAfterMs);
    timer.unref();
    return true;
  };
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return scheduleForce(true);
    } catch {
      // The launcher may have exited before its process group. Fall through
      // to the ordinary child handle as the final best-effort cleanup.
    }
  }
  try { return scheduleForce(child.kill(signal)); } catch { return false; }
}

// Old `.arcelle`-only API stays fail-closed; callers must provide a run path.
export function verifyPrivatePathSandbox(_workspacePath: string): boolean { return false; }
export function spawnWithPrivatePathSandbox(): never {
  throw new Error("A run-private path is required for native workspace isolation.");
}
