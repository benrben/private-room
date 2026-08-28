/**
 * Download-on-first-use runtimes for local MCP connectors: `uv` (Python
 * servers) and `node` (Node servers), fetched once into the app's own data
 * folder — never inside a room file — the first time a connector needs one,
 * so the user is never told to open a terminal and install a toolchain by
 * hand.
 *
 * Ported from `src-tauri/src/commands/runtimes.rs` (555 lines, read in full
 * including its `#[cfg(test)] mod tests`).
 *
 * CORRECTING THE BATCH BRIEF: the task that produced this file guessed
 * `runtimes.rs` was "CLI-engine/runtime detection (claude-cli/codex-cli
 * availability, versions)". It is not — that is `externalAdvisor.ts`'s
 * territory (`commands/external.rs`), a completely different Rust file. This
 * module has nothing to do with cloud CLIs; it is the MCP-connector
 * runtime-provisioning door the Rust source's own header describes: pinned,
 * checksummed downloads of `uv`/`node` so a stdio connector's `uvx`/`npx` has
 * something to run on a Mac that never installed either. Confirmed against
 * the Rust tree: `mcp_runtime_for_command`/`mcp_provision_runtime` are wired
 * ONLY into `lib.rs`'s `invoke_handler` (an ordinary `#[tauri::command]`
 * reached from the Settings/Connectors screen) — grepping the whole
 * `src-tauri/src` tree finds no `#[tool]`/dispatch-table entry for either
 * name, and `src/api.ts` confirms the same two names are invoked from
 * `ConnectorsView.tsx`, not from the agent loop. So there is no `execTool.ts`
 * arm to wire (rule 6 is satisfied by there being nothing to add).
 *
 * IN THE BUILD, Rust side: the Rust module's own header records that this was
 * written and unit-tested but never declared for a while (audit findings 80 +
 * 228) — a "Download runtime" button that fetches 45 MB into a folder nothing
 * looks in is worse than no button. The same four pieces this port's
 * ecosystem still owes:
 *   1. This file — done.
 *   2. `mcp.rs`'s launcher prepending the downloaded bin dirs to the
 *      connector's PATH — no Electron port of the stdio launcher's actual
 *      spawn call exists yet in this migration (`mcpClient.ts`'s
 *      `StdioConnectOptions.cachedPathPrefix` is the injection point, default
 *      `""`, documented in that file as awaiting exactly this).
 *   3. `scriptRun.ts`'s own pre-existing stand-in cell
 *      ({@link cachedPathPrefix}/{@link setCachedPathPrefix} there) — THAT
 *      one this file DOES close: {@link refreshPathPrefix} below publishes to
 *      both this module's own cell and `scriptRun.ts`'s, exactly what that
 *      file's module doc says is still owed to it ("a future `runtimes.ts`
 *      batch calls the setter... that batch needs no change here"). Rust has
 *      ONE `cached_path_prefix()` global that every reader consults; this
 *      migration has two cells only because the two consumers were ported in
 *      different batches with no shared module to hold one, so publishing to
 *      both from here is what keeps them from drifting the way the Rust
 *      source never could.
 *   4. The "Download runtime" prompt in `ConnectorsView.tsx`'s Electron
 *      equivalent — no Phase 2 renderer work exists in this migration yet.
 *      {@link registerRuntimesIpc} exists, tested directly, and is NOT wired
 *      into any bootstrap, per `recIpc.ts`'s precedent (rule 4).
 *
 * REUSED, NOT RE-PORTED:
 *   - `mcpClient.ts`'s {@link loginShellPath} IS `crate::mcp::login_shell_path`
 *     — the exact function `status_for` calls in the Rust source. Injectable
 *     via {@link RuntimeStatusDeps.resolveLoginPath} for tests (mirroring the
 *     `resolvePath` seam `mcpClient.ts`'s own `StdioConnectOptions` already
 *     uses), defaulting to the real one.
 *   - `ytdlp.ts`'s {@link HttpResponseLike}, {@link SpawnFn} and
 *     {@link SpawnedProcess} — the same minimal "a real fetch Response / a
 *     real ChildProcess satisfies this structurally" DI shapes `jobDownload.ts`
 *     already reuses from that module rather than re-declaring. This file
 *     does NOT reuse `ytdlp.ts`'s `FetchLike` itself: `provision`'s request
 *     needs a `User-Agent` header (`reqwest::Client::builder().user_agent`),
 *     which that narrower type has no room for, so {@link RuntimeFetchLike}
 *     is declared fresh with a headers-carrying `init`.
 *   - `turn.ts`'s {@link EventSender} — `(event, payload) => void`, exactly
 *     `tauri::Emitter::emit`'s shape and exactly what `skillsCmds.ts` (there
 *     named `EmitFn`) and `ytdlp.ts` already inject progress/change events
 *     through.
 *
 * TWO DELIBERATE, DOCUMENTED PORT-TIME ADAPTATIONS (not fidelity breaks):
 *   - ARCH STRINGS. Rust reads `std::env::consts::ARCH`, which spells Apple
 *     Silicon `"aarch64"` and Intel `"x86_64"`. Node's `process.arch` spells
 *     the same chips `"arm64"`/`"x64"`. {@link runtimeAsset} switches on the
 *     Node spelling and still produces the IDENTICAL URLs/digests Rust would
 *     for the same machine — the mapping is a translation of the input
 *     vocabulary, not a behavior change.
 *   - `.asset()` TAKES AN ARCH PARAMETER (default `process.arch`) where Rust's
 *     is a zero-arg method reading the ambient constant. With no argument
 *     supplied it behaves identically to Rust; the parameter exists so a test
 *     can exercise the "no build for this chip" branch without needing to run
 *     on that chip.
 *
 * ONE BYTE-LEVEL DETAIL PRESERVED ON PURPOSE, because it looked like a bug at
 * first read and is not one: `provision`'s cleanup is ASYMMETRIC around the
 * tar step. A tar SPAWN failure (`.output().await` erroring — practically
 * unreachable, since `/usr/bin/tar` ships with every macOS) propagates
 * immediately and leaves BOTH the downloaded `.download` temp file and the
 * freshly-created (empty) install dir on disk; a tar EXIT failure or a
 * missing marker after a successful run each clean up. Rust's `?` after
 * `.output().await` short-circuits before the `remove_file` line is ever
 * reached — {@link provisionRuntime} reproduces that exact ordering rather
 * than "fixing" it into uniform cleanup.
 *
 * NO TIMEOUT AND NO SIZE CAP on the runtime download itself, matching the
 * Rust source's own `provision` (unlike `ensureYtdlp` next door, it sets
 * neither `reqwest::Client::builder().timeout()` nor a byte ceiling) — ported
 * as found, not hardened.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { loginShellPath } from "./mcpClient.js";
import { setCachedPathPrefix } from "./scriptRun.js";
import type { EventSender } from "./turn.js";
import type { HttpResponseLike, SpawnedProcess, SpawnFn } from "./ytdlp.js";
import type { RuntimeStatus } from "../shared/apiTypes.js";
import type { RuntimeProgressEvent } from "../shared/events.js";

export type { RuntimeStatus };

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
export const UV_SHA256_AARCH64 = "5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62";
export const UV_SHA256_X86_64 = "b3b2137477cf96c9686ebfb71524614cec780c673fd73e59bce099aef02e70e8";
export const NODE_SHA256_ARM64 = "2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde";
export const NODE_SHA256_X64 = "668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465";

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
export function runtimeForCommand(cmd: string): RuntimeKind | null {
  switch (leafOf(cmd)) {
    case "uvx":
    case "uv":
    case "uvenv":
      return "uv";
    case "npx":
    case "npm":
    case "node":
      return "node";
    default:
      return null;
  }
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
export function runtimeAsset(kind: RuntimeKind, arch: string = process.arch): RuntimeAsset {
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
export function isInstalled(appDataDir: string, kind: RuntimeKind): boolean {
  try {
    return fs.existsSync(path.join(installDir(appDataDir, kind), runtimeMarker(kind)));
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
 * Recompute and publish the prefix. Call after a provision (and, once a
 * startup hook exists in this migration, at launch) — a runtime downloaded
 * mid-session must reach the next connector launch without a restart. Ported
 * from `refresh_path_prefix`, EXTENDED to also publish to `scriptRun.ts`'s
 * pre-existing stand-in cell (see this file's header for why there are two
 * cells here where Rust has one).
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
  deps: RuntimeStatusDeps = {}
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
function eqIgnoreAsciiCaseHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
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
export function checksumRefusal(kind: RuntimeKind, expected: string, got: string): string | null {
  if (eqIgnoreAsciiCaseHex(got, expected)) {
    return null;
  }
  return (
    `the ${runtimeLabel(kind)} download is not the one this app expects, so it was deleted ` +
    `rather than installed (expected SHA-256 ${expected}, got ${got}). ` +
    "Check the network you are on and try again."
  );
}

/** Best-effort delete, matching Rust's `let _ = tokio::fs::remove_file(...)`. */
async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // Intentionally ignored.
  }
}

/** Best-effort recursive delete, matching Rust's
 * `let _ = std::fs::remove_dir_all(...)`. */
async function safeRmdir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Intentionally ignored.
  }
}

/** The minimal `fetch()` init this module needs — narrower than the DOM lib
 * this project's tsconfig doesn't have, and wider than `ytdlp.ts`'s own
 * {@link FetchLike} only in that it carries headers (`provision` sets a
 * `User-Agent`, which that type has no room for — see this file's header). */
export interface RuntimeFetchInit {
  headers?: Record<string, string>;
}

export type RuntimeFetchLike = (url: string, init?: RuntimeFetchInit) => Promise<HttpResponseLike>;

const realFetch: RuntimeFetchLike = (url, init) =>
  fetch(url, init as RequestInit | undefined) as unknown as Promise<HttpResponseLike>;

const realSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

/** No fabricated version claim (there is no `env!("CARGO_PKG_VERSION")`
 * equivalent reachable from a plain, Electron-free module) — an honest,
 * stable label rather than a guessed number. */
const RUNTIME_USER_AGENT = "Arcelle-Electron/runtimes";

/**
 * Spawn `/usr/bin/tar` and wait for it to close, distinguishing a spawn
 * failure (nothing ran) from a completed run with a non-zero exit (tar ran
 * and refused the archive) — the same settle-on-whichever-arrives-first shape
 * `externalAdvisor.ts`'s own `runCli` uses for the cloud-CLI subprocess, cut
 * down to what tar needs: no stdin, no cancel.
 */
function runTar(
  spawnFn: SpawnFn,
  args: string[]
): Promise<{ ok: true; code: number | null; stderr: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: SpawnedProcess;
    try {
      child = spawnFn("/usr/bin/tar", args);
    } catch (e) {
      resolve({ ok: false, error: `could not run tar: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const stderrChunks: Buffer[] = [];
    const asBuffer = (c: Buffer | string): Buffer => (typeof c === "string" ? Buffer.from(c, "utf8") : c);
    child.stderr?.on("data", (c: Buffer | string) => stderrChunks.push(asBuffer(c)));

    let settled = false;
    let spawnError: string | null = null;
    child.on("error", (err) => {
      spawnError = err.message;
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `could not run tar: ${err.message}` });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (spawnError !== null) {
        resolve({ ok: false, error: `could not run tar: ${spawnError}` });
        return;
      }
      resolve({ ok: true, code, stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
  });
}

export interface ProvisionDeps {
  fetchFn?: RuntimeFetchLike;
  spawnFn?: SpawnFn;
  /** `app.emit("runtime-progress", …)`'s stand-in. Defaults to a no-op —
   * production callers of {@link mcpProvisionRuntime} pass a real sender. */
  emit?: EventSender;
  /** Test-only override of {@link runtimeAsset}'s arch (see this file's
   * header for why `runtimeAsset` itself takes one). */
  arch?: string;
  /** Test-only override of the pinned {@link runtimeAsset} lookup itself, so
   * a test can point the download at a scratch fixture with a real, matching
   * digest instead of GitHub/nodejs.org. No Rust analog — `asset()` has no
   * override point there, and no test in `runtimes.rs` exercises the network
   * path at all. Defaults to the real, pinned {@link runtimeAsset}. */
  assetOverride?: (kind: RuntimeKind, arch: string) => RuntimeAsset;
}

/**
 * Download + extract a runtime, emitting `runtime-progress` events.
 * Idempotent: a runtime that's already installed returns immediately. Ported
 * from `provision` — see this file's header for the two places this
 * deliberately preserves a Rust ordering that looks like it could be
 * "cleaned up" and isn't (the tar-spawn-failure cleanup asymmetry; no
 * timeout/size cap).
 */
export async function provisionRuntime(
  appDataDir: string,
  kind: RuntimeKind,
  deps: ProvisionDeps = {}
): Promise<void> {
  if (isInstalled(appDataDir, kind)) {
    return;
  }
  const arch = deps.arch ?? process.arch;
  const asset = (deps.assetOverride ?? runtimeAsset)(kind, arch);
  const root = runtimesRoot(appDataDir);
  const dir = installDir(appDataDir, kind);
  const tmp = path.join(root, `${kind}.download`);

  const emit = deps.emit ?? (() => {});
  const sendProgress = (phase: string, got: number, total: number): void => {
    const payload: RuntimeProgressEvent = { kind, phase, got, total };
    try {
      emit("runtime-progress", payload);
    } catch {
      // Best-effort, matching Rust's `let _ = app.emit(...)`.
    }
  };

  const fetchFn = deps.fetchFn ?? realFetch;
  let resp: HttpResponseLike;
  try {
    resp = await fetchFn(asset.url, { headers: { "User-Agent": RUNTIME_USER_AGENT } });
  } catch (e) {
    throw new Error(`could not reach ${asset.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) {
    throw new Error(`download of ${runtimeLabel(kind)} returned HTTP ${resp.status}`);
  }
  const declaredHeader = resp.headers.get("content-length");
  const declaredRaw = declaredHeader !== null ? Number(declaredHeader) : NaN;
  const total = Number.isFinite(declaredRaw) && declaredRaw >= 0 ? declaredRaw : 0;

  if (!resp.body) {
    throw new Error("could not write the download: empty response body");
  }
  const reader = resp.body.getReader();
  const hasher = createHash("sha256");
  let got = 0;
  // Rust wraps this exact step —
  // `File::create(&tmp).map_err(|e| format!("could not write the download: {e}"))?`
  // — and it was the ONE failure in this whole pipeline that reached the
  // Connectors screen as a bare OS message with no sentence saying what the
  // app had been trying to do. Reachable for real: a stray directory at the
  // fixed `<kind>.download` path (EISDIR), a read-only volume, a full disk.
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(tmp, "w");
  } catch (e) {
    throw new Error(`could not write the download: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    sendProgress("download", 0, total);
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      try {
        step = await reader.read();
      } catch (e) {
        throw new Error(`download interrupted: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (step.done || !step.value) break;
      const value = step.value;
      hasher.update(value);
      await handle.write(value);
      got += value.length;
      sendProgress("download", got, total);
    }
  } finally {
    await handle.close();
  }

  // BEFORE anything is unpacked, let alone put on a connector's PATH: this is
  // executable content, and TLS alone only says the bytes came from whoever
  // terminated the connection.
  const digest = hasher.digest("hex");
  const refusal = checksumRefusal(kind, asset.sha256, digest);
  if (refusal !== null) {
    await safeUnlink(tmp);
    throw new Error(refusal);
  }

  // Extract into a clean dir. macOS ships bsdtar at /usr/bin/tar, which
  // auto-detects gzip; strip the archive's single top-level dir.
  sendProgress("extract", got, total);
  await safeRmdir(dir);
  await fsp.mkdir(dir, { recursive: true });
  const spawnFn = deps.spawnFn ?? realSpawn;
  const tarResult = await runTar(spawnFn, ["-xzf", tmp, "-C", dir, "--strip-components=1"]);
  if (!tarResult.ok) {
    // A spawn failure short-circuits here — see this file's header. Neither
    // the temp file nor the (empty) install dir is cleaned up, matching
    // Rust's `?` right after `.output().await`.
    throw new Error(tarResult.error);
  }
  await safeUnlink(tmp);
  if (tarResult.code !== 0) {
    await safeRmdir(dir);
    throw new Error(`could not unpack the ${runtimeLabel(kind)}: ${tarResult.stderr.trim()}`);
  }
  if (!isInstalled(appDataDir, kind)) {
    await safeRmdir(dir);
    throw new Error(`the ${runtimeLabel(kind)} didn't unpack as expected`);
  }
  sendProgress("done", Math.max(got, 1), Math.max(got, 1));
}

// ============================================================================
// Commands — ported from the `// commands` section of runtimes.rs (the
// `#[tauri::command]` functions themselves).
// ============================================================================

/** Whether a connector's command can run, and if not, whether one download
 * fixes it — drives the "Download runtime" prompt in the install drawer.
 * Ported from `mcp_runtime_for_command`. */
export async function mcpRuntimeForCommand(
  appDataDir: string,
  command: string,
  deps: RuntimeStatusDeps = {}
): Promise<RuntimeStatus> {
  return statusFor(appDataDir, command, deps);
}

/** Download a runtime (`"uv"` | `"node"`) once. Emits `runtime-progress`.
 * Ported from `mcp_provision_runtime`. */
export async function mcpProvisionRuntime(
  appDataDir: string,
  kindRaw: string,
  deps: ProvisionDeps = {}
): Promise<void> {
  const kind = parseRuntimeKind(kindRaw);
  if (kind === null) {
    throw new Error(`unknown runtime "${kindRaw}"`);
  }
  await provisionRuntime(appDataDir, kind, deps);
  // Publish immediately: without this the freshly-downloaded bin dir is on no
  // PATH any child sees until the next launch, and the connector the user
  // downloaded it FOR would still fail.
  refreshPathPrefix(appDataDir);
}

// ============================================================================
// registerRuntimesIpc — thin `ipcMain.handle` registration, per `recIpc.ts`'s
// precedent. NOT wired into any bootstrap yet: it exists, and it is tested
// directly (rule 4).
// ============================================================================

/**
 * Register the two Connectors-screen channels on `ipcMain`. Channel names are
 * the Rust `#[tauri::command]` names `src/api.ts`'s `invoke(...)` calls
 * already use, so a future renderer needs no rename (confirmed against
 * `src/shared/ipc-contract.ts`'s own `mcp_runtime_for_command`/
 * `mcp_provision_runtime` entries). `appDataDir` is fixed for the app's
 * lifetime (an OS path, not room state), so — unlike `recIpc.ts`'s
 * `RoomSource` — it is a plain string captured once at registration rather
 * than a live resolver.
 */
export function registerRuntimesIpc(
  ipcMain: Pick<IpcMain, "handle">,
  appDataDir: string,
  emit?: EventSender
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("mcp_runtime_for_command", (args: { command: string }) =>
    mcpRuntimeForCommand(appDataDir, args.command)
  );
  handle("mcp_provision_runtime", (args: { kind: string }) =>
    mcpProvisionRuntime(appDataDir, args.kind, { emit })
  );
}
