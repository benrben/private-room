import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

function quoteSeatbelt(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function privatePathSeatbeltProfile(workspacePath: string): string {
  const privatePath = path.join(path.resolve(workspacePath), ".arcelle");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${quoteSeatbelt(privatePath)}))`,
  ].join("\n");
}

export function verifyPrivatePathSandbox(workspacePath: string): boolean {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  const privatePath = path.join(path.resolve(workspacePath), ".arcelle");
  const canary = path.join(privatePath, `sandbox-canary-${process.pid}`);
  rmSync(canary, { force: true });
  const script = 'test ! -r "$1" && ! ( : > "$2" )';
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", privatePathSeatbeltProfile(workspacePath), "/bin/sh", "-c", script, "arcelle", privatePath, canary],
    { encoding: "utf8", timeout: 5_000 },
  );
  const safe = result.status === 0 && !existsSync(canary);
  rmSync(canary, { force: true });
  return safe;
}

export function spawnWithPrivatePathSandbox(
  workspacePath: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): ChildProcessWithoutNullStreams {
  if (!verifyPrivatePathSandbox(workspacePath)) {
    throw new Error("Native direct-file mode is unavailable because private-path isolation failed.");
  }
  return spawn(
    "/usr/bin/sandbox-exec",
    ["-p", privatePathSeatbeltProfile(workspacePath), command, ...args],
    { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] },
  );
}
