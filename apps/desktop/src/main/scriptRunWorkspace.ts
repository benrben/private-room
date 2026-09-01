/** Cohesive extraction from scriptRun.ts; its public API remains on that module. */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";

import type { CancelFlag } from "./cancel.js";
import { extractText } from "./editMatch.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  fileByExactName,
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileMeta,
  inTransaction,
  insertFile,
  listFiles,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { clampBytesMarked } from "./textClamp.js";
import type { ScriptManifest } from "../shared/apiTypes.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export type { ScriptManifest };
import { ScriptLang, hasDeps } from "./scriptRunManifest.js";
// ============================================================================
// Interpreter selection — pure policy + the real-machine probes
// ============================================================================

/** Which runtime a script runs on. Pure policy output (decision 4). */
export type RunnerChoice = "uv" | "python3" | "node";

/** A resolved runtime: the program path + the argv prefix before the script. */
export interface Runner {
  readonly program: string;
  readonly argvPrefix: string[];
}

/**
 * Pure runtime-selection policy (decision 4), split out for the unit-test
 * matrix (uv/no-uv × deps/no-deps × py/js). `uv`/`py3`/`node` say whether each
 * is installed. Throws with the exact user-facing sentence Rust's
 * `Result<RunnerChoice, String>` carries; {@link resolveInterpreter} is the
 * only caller that enriches it.
 */
export function interpreterPolicy(
  uv: boolean,
  py3: boolean,
  node: boolean,
  lang: ScriptLang,
  scriptHasDeps: boolean
): RunnerChoice {
  return lang === "py"
    ? pythonInterpreterPolicy(uv, py3, scriptHasDeps)
    : javascriptInterpreterPolicy(node, scriptHasDeps);
}

export function pythonInterpreterPolicy(uv: boolean, py3: boolean, scriptHasDeps: boolean): RunnerChoice {
  // uv handles both dependency-free and PEP-723 scripts.
  if (uv) return "uv";
  if (scriptHasDeps) {
    throw new Error(
      "This script needs extra Python packages. Install uv (run `brew install uv`) to run scripts with dependencies."
    );
  }
  if (py3) return "python3";
  throw new Error(
    "No Python interpreter was found. Install Python 3, or uv (`brew install uv`), to run this script."
  );
}

export function javascriptInterpreterPolicy(node: boolean, scriptHasDeps: boolean): RunnerChoice {
  if (scriptHasDeps) {
    throw new Error(
      "JavaScript scripts with dependencies aren't supported yet — remove the dependency declaration to run this script."
    );
  }
  if (node) return "node";
  throw new Error("Node.js isn't installed. Install it (`brew install node`) to run JavaScript scripts.");
}

export function home(): string {
  return process.env["HOME"] ?? "";
}

/** Probe a binary by an absolute-path candidate list, then a login-shell
 * fallback (a GUI launch has only a bare launchd PATH; user tools live in PATH
 * via `.zshrc`). Mirrors `ollama_lifecycle::ollama_bin`. */
export function probeBin(
  candidates: readonly string[],
  loginProbe: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  runLoginShell: LoginShellSpawn = defaultLoginShellSpawn,
): string | null {
  return firstExistingBin(candidates, exists) ?? loginShellBin(loginProbe, runLoginShell);
}

export function firstExistingBin(
  candidates: readonly string[],
  exists: (candidate: string) => boolean = fs.existsSync,
): string | null {
  for (const candidate of candidates) {
    if (candidate !== "" && exists(candidate)) return candidate;
  }
  return null;
}

export interface LoginShellResult {
  readonly status: number | null;
  readonly stdout: unknown;
}

export type LoginShellSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => LoginShellResult;

export function defaultLoginShellSpawn(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): LoginShellResult {
  const result = spawnSync(command, args, options);
  return { status: result.status, stdout: result.stdout };
}

export function loginShellBin(
  loginProbe: string,
  runLoginShell: LoginShellSpawn = defaultLoginShellSpawn,
): string | null {
  try {
    return loginShellOutput(runLoginShell("zsh", ["-ilc", loginProbe], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return null;
  }
}

export function loginShellOutput(result: LoginShellResult): string | null {
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return firstLoginShellLine(result.stdout);
}

export function firstLoginShellLine(stdout: string): string | null {
  // Rust reads `lines().next()` — the FIRST line only, non-empty or nothing.
  const first = stdout.split("\n")[0]?.trim() ?? "";
  return first === "" ? null : first;
}

/**
 * What `commands::runtimes::refresh_path_prefix` publishes for readers with no
 * app handle. No provisioning system exists in this migration yet (see the
 * module header), so the cell starts and stays empty until a future
 * `runtimes.ts` batch calls {@link setCachedPathPrefix}.
 */
export let pathPrefixCell = "";

export function cachedPathPrefix(): string {
  return pathPrefixCell;
}

/** For a future `runtimes.ts` port — or a test — to publish a prefix. */
export function setCachedPathPrefix(prefix: string): void {
  pathPrefixCell = prefix;
}

/** `<dir>/<leaf>` for every directory in the app's published runtime prefix —
 * the copies the app downloaded, ahead of anything on the system. */
export function provisionedFirst(prefix: string, leaf: string, system: readonly string[]): string[] {
  return [
    ...prefix
      .split(":")
      .filter((d) => d !== "")
      .map((d) => `${d}/${leaf}`),
    ...system,
  ];
}

/**
 * One binary's probe result, cached against the runtime PATH prefix it was
 * probed under.
 *
 * Rust used a plain `OnceLock` and cached the FIRST answer for the life of the
 * process, so a `uv` downloaded mid-session for an MCP connector was invisible
 * here and a script with dependencies was refused with "install uv" while uv
 * sat in the app's own data folder. Keying on the published prefix picks up a
 * mid-session download on the next run without re-running the `zsh -ilc` probe
 * every time.
 */
export interface BinCache {
  prefix: string;
  found: string | null;
}

export function cachedBin(
  cell: { value: BinCache | null },
  candidates: (prefix: string) => string[],
  loginProbe: string
): string | null {
  const prefix = cachedPathPrefix();
  if (cell.value !== null && cell.value.prefix === prefix) {
    return cell.value.found;
  }
  const found = probeBin(candidates(prefix), loginProbe);
  cell.value = { prefix, found };
  return found;
}

export const uvCache: { value: BinCache | null } = { value: null };
export function uvBin(): string | null {
  return cachedBin(
    uvCache,
    (prefix) => {
      const c = provisionedFirst(prefix, "uv", []);
      c.push(`${home()}/.local/bin/uv`);
      c.push("/opt/homebrew/bin/uv");
      c.push("/usr/local/bin/uv");
      return c;
    },
    "command -v uv"
  );
}

export const python3Cache: { value: BinCache | null } = { value: null };
export function python3Bin(): string | null {
  return cachedBin(
    python3Cache,
    () => ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"],
    "command -v python3"
  );
}

export const nodeCache: { value: BinCache | null } = { value: null };
export function nodeBin(): string | null {
  return cachedBin(
    nodeCache,
    (prefix) =>
      provisionedFirst(prefix, "node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]),
    "command -v node"
  );
}

/** Test-only: forget every cached probe result. Rust needs no such reset —
 * each `#[test]` gets its own process — but a single long-lived vitest process
 * does, or one test's stubbed candidate path silently answers the next one. */
export function resetBinCachesForTests(): void {
  uvCache.value = null;
  python3Cache.value = null;
  nodeCache.value = null;
}

/** Resolve the runtime for a script, per {@link interpreterPolicy} + the
 * probes. Enriches the deps-need-uv error with the actual package names. */
export function resolveInterpreter(manifest: ScriptManifest): Runner {
  const binaries = availableBinaries();
  const choice = selectedInterpreter(manifest, binaries);
  return runnerForChoice(choice, manifest.deps, binaries);
}

export interface AvailableBinaries {
  readonly uv: string | null;
  readonly python3: string | null;
  readonly node: string | null;
}

export function availableBinaries(): AvailableBinaries {
  return { uv: uvBin(), python3: python3Bin(), node: nodeBin() };
}

export function selectedInterpreter(manifest: ScriptManifest, binaries: AvailableBinaries): RunnerChoice {
  try {
    return interpreterPolicy(
      binaries.uv !== null,
      binaries.python3 !== null,
      binaries.node !== null,
      manifest.interpreter,
      hasDeps(manifest),
    );
  } catch (error) {
    throw enrichedInterpreterError(manifest, binaries, error);
  }
}

export function enrichedInterpreterError(
  manifest: ScriptManifest,
  binaries: AvailableBinaries,
  error: unknown,
): unknown {
  if (!needsUvInstallationMessage(manifest, binaries)) return error;
  return new Error(
    `This script needs ${manifest.deps.join(", ")}. Install uv (\`brew install uv\`) to run scripts with dependencies.`,
  );
}

export function needsUvInstallationMessage(manifest: ScriptManifest, binaries: AvailableBinaries): boolean {
  return manifest.interpreter === "py" && hasDeps(manifest) && binaries.uv === null;
}

export function runnerForChoice(
  choice: RunnerChoice,
  dependencies: readonly string[],
  binaries: AvailableBinaries,
): Runner {
  if (choice === "uv") {
    // Install declared deps via explicit `--with` flags rather than relying on
    // uv's own PEP-723 parse: a bare `# dependencies = [...]` line (no full
    // `# /// script … # ///` fence) then still installs, so the assistant only
    // has to list the packages — uv does the rest, no manual pip. `--with` is
    // idempotent and cached across runs.
    return { program: binaryOrEmpty(binaries.uv), argvPrefix: uvArguments(dependencies) };
  }
  if (choice === "python3") {
    return { program: binaryOrEmpty(binaries.python3), argvPrefix: [] };
  }
  return { program: binaryOrEmpty(binaries.node), argvPrefix: [] };
}

export function binaryOrEmpty(binary: string | null): string {
  return binary === null ? "" : binary;
}

export function uvArguments(dependencies: readonly string[]): string[] {
  const argv = ["run", "--no-project"];
  for (const dependency of dependencies) argv.push("--with", dependency);
  return argv;
}
