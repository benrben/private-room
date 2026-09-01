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
 *   2. `mcpSurfaceIpc.ts` passes the published downloaded-runtime prefix to
 *      `mcpClient.ts` for every connector launch — done.
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
 *   4. The Connectors marketplace probes and provisions runtimes through
 *      {@link registerRuntimesIpc}, which is wired by `registerAllIpc.ts` — done.
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
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  checksumRefusal,
  installDir,
  isInstalled,
  parseRuntimeKind,
  refreshPathPrefix,
  runtimeAsset,
  runtimeLabel,
  runtimesRoot,
  statusFor,
  type RuntimeAsset,
  type RuntimeKind,
  type RuntimeStatusDeps,
} from "./runtimeCatalog.js";
import type { EventSender } from "./turn.js";
import type { HttpResponseLike, SpawnedProcess, SpawnFn } from "./ytdlp.js";
import type { RuntimeStatus } from "../shared/apiTypes.js";
import type { RuntimeProgressEvent } from "../shared/events.js";

export type { RuntimeStatus };
export * from "./runtimeCatalog.js";


/** Best-effort delete, matching Rust's `let _ = tokio::fs::remove_file(...)`. */
async function safeUnlink(
  p: string,
  unlink: typeof fsp.unlink = fsp.unlink,
): Promise<void> {
  try {
    await unlink(p);
  } catch {
    // Intentionally ignored.
  }
}

/** Best-effort recursive delete, matching Rust's
 * `let _ = std::fs::remove_dir_all(...)`. */
async function safeRmdir(
  dir: string,
  remove: typeof fsp.rm = fsp.rm,
): Promise<void> {
  try {
    await remove(dir, { recursive: true, force: true });
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

export type RuntimeFetchLike = (
  url: string,
  init?: RuntimeFetchInit,
) => Promise<HttpResponseLike>;

const realFetch: RuntimeFetchLike = (url, init) =>
  fetch(
    url,
    init as RequestInit | undefined,
  ) as unknown as Promise<HttpResponseLike>;

const realSpawn: SpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

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
  args: string[],
): Promise<
  | { ok: true; code: number | null; stderr: string }
  | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    let child: SpawnedProcess;
    try {
      child = spawnFn("/usr/bin/tar", args);
    } catch (e) {
      resolve({
        ok: false,
        error: `could not run tar: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const stderrChunks: Buffer[] = [];
    const asBuffer = (c: Buffer | string): Buffer =>
      typeof c === "string" ? Buffer.from(c, "utf8") : c;
    child.stderr?.on("data", (c: Buffer | string) =>
      stderrChunks.push(asBuffer(c)),
    );

    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `could not run tar: ${err.message}` });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: true,
        code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

export interface ProvisionDeps {
  fetchFn?: RuntimeFetchLike;
  spawnFn?: SpawnFn;
  /** Injectable best-effort cleanup boundaries; production uses fs/promises. */
  unlinkFn?: typeof fsp.unlink;
  rmdirFn?: typeof fsp.rm;
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

type RuntimeProgressSender = (
  phase: string,
  got: number,
  total: number,
) => void;

interface RuntimeProvisionPaths {
  asset: RuntimeAsset;
  root: string;
  dir: string;
  tmp: string;
}

interface DownloadedRuntime {
  digest: string;
  got: number;
  total: number;
}

function noRuntimeProgress(): void {
  // The omitted production sender has no side effect.
}

function runtimeProvisionPaths(
  appDataDir: string,
  kind: RuntimeKind,
  deps: ProvisionDeps,
): RuntimeProvisionPaths {
  const arch = deps.arch ?? process.arch;
  const asset = (deps.assetOverride ?? runtimeAsset)(kind, arch);
  const root = runtimesRoot(appDataDir);
  return {
    asset,
    root,
    dir: installDir(appDataDir, kind),
    tmp: path.join(root, `${kind}.download`),
  };
}

function runtimeProgressSender(
  kind: RuntimeKind,
  emit: EventSender | undefined,
): RuntimeProgressSender {
  const sender = emit ?? noRuntimeProgress;
  return (phase, got, total) => {
    const payload: RuntimeProgressEvent = { kind, phase, got, total };
    try {
      sender("runtime-progress", payload);
    } catch {
      // Best-effort, matching Rust's `let _ = app.emit(...)`.
    }
  };
}

async function fetchRuntime(
  asset: RuntimeAsset,
  fetchFn: RuntimeFetchLike,
): Promise<HttpResponseLike> {
  try {
    return await fetchFn(asset.url, {
      headers: { "User-Agent": RUNTIME_USER_AGENT },
    });
  } catch (error) {
    throw new Error(
      `could not reach ${asset.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertSuccessfulDownload(
  kind: RuntimeKind,
  response: HttpResponseLike,
): void {
  if (!response.ok)
    throw new Error(
      `download of ${runtimeLabel(kind)} returned HTTP ${response.status}`,
    );
}

function declaredDownloadLength(response: HttpResponseLike): number {
  const raw = response.headers.get("content-length");
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function responseReader(
  response: HttpResponseLike,
): NonNullable<HttpResponseLike["body"]> {
  if (response.body === null)
    throw new Error("could not write the download: empty response body");
  return response.body;
}

async function openRuntimeDownload(tmp: string): Promise<fsp.FileHandle> {
  try {
    return await fsp.open(tmp, "w");
  } catch (error) {
    throw new Error(
      `could not write the download: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readRuntimeChunk(
  reader: ReturnType<NonNullable<HttpResponseLike["body"]>["getReader"]>,
): Promise<{ done: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch (error) {
    throw new Error(
      `download interrupted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeRuntimeDownload(
  tmp: string,
  body: NonNullable<HttpResponseLike["body"]>,
  total: number,
  progress: RuntimeProgressSender,
): Promise<DownloadedRuntime> {
  const reader = body.getReader();
  const hasher = createHash("sha256");
  const handle = await openRuntimeDownload(tmp);
  let got = 0;
  try {
    progress("download", 0, total);
    for (;;) {
      const step = await readRuntimeChunk(reader);
      if (step.done || !step.value) break;
      hasher.update(step.value);
      await handle.write(step.value);
      got += step.value.length;
      progress("download", got, total);
    }
  } finally {
    await handle.close();
  }
  return { digest: hasher.digest("hex"), got, total };
}

async function verifyRuntimeDownload(
  kind: RuntimeKind,
  asset: RuntimeAsset,
  tmp: string,
  digest: string,
  unlinkFn?: typeof fsp.unlink,
): Promise<void> {
  const refusal = checksumRefusal(kind, asset.sha256, digest);
  if (refusal === null) return;
  await safeUnlink(tmp, unlinkFn);
  throw new Error(refusal);
}

async function unpackRuntime(
  appDataDir: string,
  kind: RuntimeKind,
  deps: ProvisionDeps,
  paths: RuntimeProvisionPaths,
  download: DownloadedRuntime,
  progress: RuntimeProgressSender,
): Promise<void> {
  progress("extract", download.got, download.total);
  await safeRmdir(paths.dir, deps.rmdirFn);
  await fsp.mkdir(paths.dir, { recursive: true });
  const tarResult = await runTar(deps.spawnFn ?? realSpawn, [
    "-xzf",
    paths.tmp,
    "-C",
    paths.dir,
    "--strip-components=1",
  ]);
  if (!tarResult.ok) throw new Error(tarResult.error);
  await safeUnlink(paths.tmp, deps.unlinkFn);
  if (tarResult.code !== 0) {
    await safeRmdir(paths.dir, deps.rmdirFn);
    throw new Error(
      `could not unpack the ${runtimeLabel(kind)}: ${tarResult.stderr.trim()}`,
    );
  }
  if (!isInstalled(appDataDir, kind)) {
    await safeRmdir(paths.dir, deps.rmdirFn);
    throw new Error(`the ${runtimeLabel(kind)} didn't unpack as expected`);
  }
  const final = declaredProgressTotal(download.got);
  progress("done", final, final);
}

function declaredProgressTotal(got: number): number {
  return Math.max(got, 1);
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
  deps: ProvisionDeps = {},
): Promise<void> {
  if (isInstalled(appDataDir, kind)) return;
  const paths = runtimeProvisionPaths(appDataDir, kind, deps);
  const progress = runtimeProgressSender(kind, deps.emit);
  const response = await fetchRuntime(paths.asset, deps.fetchFn ?? realFetch);
  assertSuccessfulDownload(kind, response);
  const download = await writeRuntimeDownload(
    paths.tmp,
    responseReader(response),
    declaredDownloadLength(response),
    progress,
  );
  await verifyRuntimeDownload(kind, paths.asset, paths.tmp, download.digest, deps.unlinkFn);
  await unpackRuntime(appDataDir, kind, deps, paths, download, progress);
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
  deps: RuntimeStatusDeps = {},
): Promise<RuntimeStatus> {
  return statusFor(appDataDir, command, deps);
}

/** Download a runtime (`"uv"` | `"node"`) once. Emits `runtime-progress`.
 * Ported from `mcp_provision_runtime`. */
export async function mcpProvisionRuntime(
  appDataDir: string,
  kindRaw: string,
  deps: ProvisionDeps = {},
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
// registerRuntimesIpc — thin `ipcMain.handle` registration, wired by the main
// IPC composition root.
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
  emit?: EventSender,
  afterProvision: () => void | Promise<void> = () => undefined,
): void {
  refreshPathPrefix(appDataDir);
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => R,
  ): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) =>
      fn(...args),
    );
  };

  handle("mcp_runtime_for_command", (args: { command: string }) =>
    mcpRuntimeForCommand(appDataDir, args.command),
  );
  handle("mcp_provision_runtime", async (args: { kind: string }) => {
    await mcpProvisionRuntime(appDataDir, args.kind, { emit });
    await afterProvision();
  });
}
