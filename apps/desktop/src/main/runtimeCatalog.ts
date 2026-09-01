/** Runtime metadata, filesystem discovery, and availability checks. */

import * as fs from "node:fs";
import * as path from "node:path";

import { loginShellPath } from "./mcpClient.js";
import { setCachedPathPrefix } from "./scriptRun.js";
import type { RuntimeStatus } from "../shared/apiTypes.js";

// ============================================================================
// Constants — runtimes.rs's own module-level `const`s, verbatim values.
// ============================================================================

/** Node LTS pinned for the bundled-on-demand Node runtime. */
export const NODE_VERSION = "v22.11.0";

/** uv release pinned. A moving `releases/latest` would mean two installs of
 * the SAME build of this app could execute different binaries, with no
 * digest to check either against — see the constants below. */
export const UV_VERSION = "0.12.5";

/**
 * What the pinned asset must hash to, per arch, taken from the publishers'
 * own checksums for these exact versions (nodejs.org's `SHASUMS256.txt`, the
 * `.sha256` beside each astral-sh/uv 0.12.5 asset). A substituted download —
 * even one served over a session that itself terminated the (real) TLS
 * connection — is refused rather than run.
 */
export const UV_SHA256_AARCH64 =
  "5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62";
export const UV_SHA256_X86_64 =
  "b3b2137477cf96c9686ebfb71524614cec780c673fd73e59bce099aef02e70e8";
export const NODE_SHA256_ARM64 =
  "2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde";
export const NODE_SHA256_X64 =
  "668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465";

/** A pinned download: the URL, and the SHA-256 the bytes must have. */
export interface RuntimeAsset {
  url: string;
  sha256: string;
}

/**
 * A runtime the app can download on demand. Serializes as the bare string
 * ("uv" | "node") on the wire — Rust's `#[serde(rename_all = "lowercase")]`
 * enum and this string-literal union carry the same values, so nothing here
 * needs a separate `.slug()`: the kind IS its own slug.
 */
export type RuntimeKind = "uv" | "node";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["uv", "node"];

/** Ported from `RuntimeKind::parse`. */
export function parseRuntimeKind(s: string): RuntimeKind | null {
  return s === "uv" || s === "node" ? s : null;
}

/** `cmd.rsplit('/').next().unwrap_or(cmd)` — the leaf after the last `/`, or
 * the whole string when there is none. Shared by {@link runtimeForCommand}
 * and {@link whichIn}, exactly as the Rust source shares the same idiom
 * inline in both. */
function leafOf(cmd: string): string {
  const idx = cmd.lastIndexOf("/");
  return idx === -1 ? cmd : cmd.slice(idx + 1);
}

/** Which runtime a connector's command needs, if it's one we can provide.
 * Ported from `RuntimeKind::for_command`. Pure. */
const UV_RUNTIME_COMMANDS = new Set(["uvx", "uv", "uvenv"]);
const NODE_RUNTIME_COMMANDS = new Set(["npx", "npm", "node"]);

export function runtimeForCommand(cmd: string): RuntimeKind | null {
  const command = leafOf(cmd);
  if (UV_RUNTIME_COMMANDS.has(command)) return "uv";
  if (NODE_RUNTIME_COMMANDS.has(command)) return "node";
  return null;
}

/** A friendly label for the UI. Ported from `RuntimeKind::label`. */
export function runtimeLabel(kind: RuntimeKind): string {
  return kind === "uv" ? "Python runtime (uv)" : "Node.js runtime";
}

/** Where it's fetched from + rough size. Ported from `RuntimeKind::source`. */
export function runtimeSource(kind: RuntimeKind): string {
  return kind === "uv" ? "astral.sh · ~22 MB" : "nodejs.org · ~45 MB";
}

/**
 * The download for a given CPU arch: where it comes from, and what it must
 * hash to. One function so a URL can never be changed without its digest.
 * Ported from `RuntimeKind::asset`, over Node's arch spelling — see this
 * file's header for why `arch` is a parameter here. Throws (Rust's
 * `Result::Err`) for an arch with no published build.
 */
export function runtimeAsset(
  kind: RuntimeKind,
  arch: string = process.arch,
): RuntimeAsset {
  if (kind === "uv") {
    let a: string;
    let sha256: string;
    if (arch === "arm64") {
      a = "aarch64";
      sha256 = UV_SHA256_AARCH64;
    } else if (arch === "x64") {
      a = "x86_64";
      sha256 = UV_SHA256_X86_64;
    } else {
      throw new Error(`no uv build for ${arch}`);
    }
    return {
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${a}-apple-darwin.tar.gz`,
      sha256,
    };
  }
  let a: string;
  let sha256: string;
  if (arch === "arm64") {
    a = "arm64";
    sha256 = NODE_SHA256_ARM64;
  } else if (arch === "x64") {
    a = "x64";
    sha256 = NODE_SHA256_X64;
  } else {
    throw new Error(`no node build for ${arch}`);
  }
  return {
    url: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${a}.tar.gz`,
    sha256,
  };
}

/** Subdir (under the install dir) that goes on PATH once installed. Ported
 * from `RuntimeKind::bin_subdir`. */
export function runtimeBinSubdir(kind: RuntimeKind): string {
  return kind === "uv" ? "" : "bin";
}

/** A file whose presence proves the runtime extracted successfully. Ported
 * from `RuntimeKind::marker`. */
export function runtimeMarker(kind: RuntimeKind): string {
  return kind === "uv" ? "uv" : "bin/node";
}

// ============================================================================
// Filesystem — ported from the `// filesystem` section of runtimes.rs.
// `appDataDir` stands in for `app.path().app_data_dir()`: every ported
// function here takes it as a plain parameter (the same convention
// `ytdlp.ts`'s `dataDir` argument already uses) rather than importing
// `electron`'s `app` module, so this file stays unit-testable with a scratch
// directory and has no runtime dependency on Electron being alive.
// ============================================================================

/** The per-Mac runtimes root, in the app data folder (never inside a room).
 * Ported from `runtimes_root` — including its side effect: every call
 * (re-)creates the directory, exactly as Rust's own `create_dir_all` runs on
 * every query, not just the first. */
export function runtimesRoot(appDataDir: string): string {
  const dir = path.join(appDataDir, "runtimes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ported from `install_dir`. */
export function installDir(appDataDir: string, kind: RuntimeKind): string {
  return path.join(runtimesRoot(appDataDir), kind);
}

/** Ported from `is_installed`. */
export function isInstalled(
  appDataDir: string,
  kind: RuntimeKind,
  exists: typeof fs.existsSync = fs.existsSync,
): boolean {
  try {
    return exists(
      path.join(installDir(appDataDir, kind), runtimeMarker(kind)),
    );
  } catch {
    return false;
  }
}

/** The directory to put on PATH for an installed runtime (`null` if not yet
 * installed). Ported from `bin_dir`. */
function binDirFor(appDataDir: string, kind: RuntimeKind): string | null {
  if (!isInstalled(appDataDir, kind)) {
    return null;
  }
  const d = installDir(appDataDir, kind);
  const sub = runtimeBinSubdir(kind);
  return sub === "" ? d : path.join(d, sub);
}

/** PATH fragment (colon-joined) for every runtime downloaded so far —
 * prepended to a connector's PATH so a downloaded `uvx`/`npx` wins over
 * anything on the system. Empty when nothing is downloaded. Ported from
 * `path_prefix`. */
export function pathPrefix(appDataDir: string): string {
  return RUNTIME_KINDS.map((k) => binDirFor(appDataDir, k))
    .filter((p): p is string => p !== null)
    .join(":");
}

// ---------------------------------------------------------- published prefix

/** The published PATH prefix, for readers with no live app-data-dir handle —
 * `crate::commands::cached_path_prefix()`'s stand-in. Starts empty, exactly
 * the value Rust's own `OnceLock`-backed cell returns before anything is
 * downloaded. */
let prefixCell = "";

/**
 * Recompute and publish the prefix. Runtime IPC calls this at startup and
 * after every provision, so both existing and newly downloaded runtimes reach
 * the next connector launch. Ported from `refresh_path_prefix`, EXTENDED to
 * also publish to `scriptRun.ts`'s pre-existing stand-in cell (see this file's
 * header for why there are two cells here where Rust has one).
 */
export function refreshPathPrefix(appDataDir: string): void {
  const next = pathPrefix(appDataDir);
  prefixCell = next;
  setCachedPathPrefix(next);
}

/** What a connector launcher should prepend to its PATH. Ported from
 * `cached_path_prefix`. */
export function cachedPathPrefix(): string {
  return prefixCell;
}

/** Test-only: forget the published prefix, mirroring `mcpClient.ts`'s own
 * `resetLoginShellPathCacheForTests` convention for a module-level cell that
 * outlives any one test in the same process. Not part of the Rust source
 * (whose `OnceLock` is never reset either). */
export function resetPathPrefixCellForTests(): void {
  prefixCell = "";
}

/** True when `cmd` resolves to an existing file in one of the PATH dirs.
 * Ported from `which_in`. Pure. */
export function whichIn(cmd: string, pathStr: string): boolean {
  const leaf = leafOf(cmd);
  return pathStr
    .split(":")
    .filter((p) => p !== "")
    .some((dir) => fs.existsSync(path.join(dir, leaf)));
}

// ============================================================================
// Availability — ported from the `// availability` section of runtimes.rs.
// ============================================================================

export interface RuntimeStatusDeps {
  /** Override for {@link loginShellPath} — tests inject a fixed PATH instead
   * of spawning a real login shell, the same seam `mcpClient.ts`'s own
   * `StdioConnectOptions.resolvePath` already uses. */
  resolveLoginPath?: () => Promise<string>;
}

/**
 * Decide whether `command` can run, and if not, whether a download fixes it.
 * Ported from `status_for`. Async where Rust is sync: `login_shell_path`
 * blocks a thread in Rust; `loginShellPath` here is a real `Promise` (Node
 * has no blocking-pool distinction to preserve — the same adaptation
 * `mcpClient.ts`'s own doc records for the same function).
 */
export async function statusFor(
  appDataDir: string,
  command: string,
  deps: RuntimeStatusDeps = {},
): Promise<RuntimeStatus> {
  // The exact PATH the launcher will use: downloaded runtimes first, then the
  // login-shell PATH (Homebrew, ~/.local/bin, …).
  const prefix = pathPrefix(appDataDir);
  const resolveLoginPath = deps.resolveLoginPath ?? loginShellPath;
  const base = await resolveLoginPath();
  const full = prefix === "" ? base : `${prefix}:${base}`;
  if (whichIn(command, full)) {
    return { available: true, kind: null, provisionable: false, note: "" };
  }
  const kind = runtimeForCommand(command);
  if (kind !== null) {
    return {
      available: false,
      kind,
      provisionable: true,
      note: `First install downloads the ${runtimeLabel(kind)} once (${runtimeSource(kind)}). Nothing else to set up.`,
    };
  }
  return {
    available: false,
    kind: null,
    provisionable: false,
    note:
      `This connector needs “${command}”, which the app can't download for you — ` +
      "install it yourself (e.g. Docker Desktop) to use it.",
  };
}

// ============================================================================
// Provisioning — ported from the `// provisioning` section of runtimes.rs.
// ============================================================================

/** `str::eq_ignore_ascii_case` over hex digests — ASCII-only folding, so this
 * never risks the Unicode-fold surprises `skillsCmds.ts`'s own
 * `eqIgnoreAsciiCase` documents for path comparisons (irrelevant to a 64-hex-
 * digit string, but the same discipline). */
function lowercaseAsciiCode(code: number): number {
  if (code >= 65 && code <= 90) return code + 32;
  return code;
}

function eqIgnoreAsciiCaseHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = lowercaseAsciiCode(a.charCodeAt(i));
    const y = lowercaseAsciiCode(b.charCodeAt(i));
    if (x !== y) return false;
  }
  return true;
}

/**
 * Why this download must not be unpacked, or `null` when it is the pinned
 * one. Ported from `checksum_refusal`. Says in full what was expected, what
 * arrived, and that nothing was installed — a runtime that silently declined
 * to install would send the user back to the same button forever.
 */
export function checksumRefusal(
  kind: RuntimeKind,
  expected: string,
  got: string,
): string | null {
  if (eqIgnoreAsciiCaseHex(got, expected)) {
    return null;
  }
  return (
    `the ${runtimeLabel(kind)} download is not the one this app expects, so it was deleted ` +
    `rather than installed (expected SHA-256 ${expected}, got ${got}). ` +
    "Check the network you are on and try again."
  );
}
