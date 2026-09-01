/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
/**
 * ADD-26 → BROWSE-2: on-demand media download via yt-dlp (YouTube, and
 * anything else yt-dlp supports).
 *
 * Ported from `src-tauri/src/commands/ytdlp.rs` (949 lines), most recently
 * shipped as v0.25.0 (the quality picker + split-stream merge).
 *
 * yt-dlp is NOT bundled: it downloads on first use into the app's data dir
 * (the Whisper-model doctrine — nothing else to install, nothing GPL-linked
 * riding in the DMG) and keeps ITSELF current. YouTube rotates its player
 * scheme every few weeks; a copy older than {@link YTDLP_STALE_AFTER_MS} runs
 * its own `-U` BEFORE the next download is attempted (a precondition, never a
 * retry after a failure), or every download starts failing with `HTTP Error
 * 403` — which happened for real on 2026-08-21 with a July binary.
 *
 * OWNER DECISIONS PRESERVED EXACTLY — do not soften or reinterpret:
 *   - The room-file size cap REFUSES; it never downgrades quality to fit.
 *     There is no automatic size preference anywhere in
 *     {@link formatSelector}: the RESOLUTION is the user's to pick, their
 *     pick leads the chain, and an over-cap download is abandoned with a
 *     truthful message (on the first progress line where possible, and on
 *     the finished file otherwise). See {@link MAX_DOWNLOAD_BYTES} for a
 *     discrepancy this port found against its own commissioning brief.
 *   - {@link formatSelector}'s ffmpeg-present vs ffmpeg-absent behaviour
 *     differs exactly as the Rust does: without ffmpeg the merge branches are
 *     not OFFERED at all, because yt-dlp would otherwise pick a split
 *     video+audio pair and leave two half-files behind with nothing to join
 *     them. The merge branches prefer h264 (`avc1`) because AVFoundation —
 *     the app's playback and probe stack — does not decode the VP9 that plain
 *     "best" picks.
 *   - The interactive Stop flag is ARMED (cleared) at the start of every
 *     download, so a Stop pressed a moment too late can never kill the NEXT
 *     one. See {@link armMediaCancel}.
 *
 * INTERFACE SEAMS this batch does not own — injected, not reimplemented:
 *   - {@link ImportDownloadFn} stands in for Rust's `import_download` (the
 *     shared "bring this file into the encrypted room" funnel, still in the
 *     not-yet-ported files layer).
 *   - {@link WebAccessCheck} stands in for `commands::require_web_access`
 *     (the room's internet on/off switch, a room-settings read). Injected as
 *     a plain boolean-returning check; this module still owns the refusal
 *     STRING so its wording matches every other gated inlet — see
 *     {@link WEB_OFF_MESSAGE}.
 *   - Progress is a plain callback ({@link MediaProgress}, Rust's
 *     `&(dyn Fn(&str, Option<f64>) + Sync)` verbatim); cancellation is a
 *     {@link CancelFlag} from `cancel.ts` — the already-ported `AtomicBool`
 *     stand-in — rather than a second cancellation vocabulary. That matters
 *     beyond taste: Rust's `download_media_to_temp` takes the agent job's
 *     own run flag, and in this port those flags come out of `cancel.ts`'s
 *     tree, so a future job-queue batch can pass one straight in.
 *   - `checkPublicHttpUrl`/`resolvePublicAddr` are NOT stubbed: the SSRF
 *     pre-flight is already ported in `browser/guard.ts`, so this module
 *     imports and uses the real thing.
 *
 * OUT OF SCOPE, deliberately: `src-tauri/src/commands/jobs/download.rs` (the
 * background-job wrapper — `start_download_job`/`spawn_download`/the queue).
 * {@link downloadMediaToTemp}, {@link importMediaUrl} and
 * {@link listMediaFormats} are directly-callable async functions a future
 * job-queue batch can wire up without re-deriving any of this.
 *
 * TESTING SEAMS: the two subprocess-driving entry points are each split in
 * two — {@link downloadMediaToTemp}/{@link runYtdlpDownload} and
 * {@link listMediaFormats}/{@link probeMediaFormats}. The public half runs
 * the SSRF pre-flight and delegates; the inner half is the bare engine. That
 * split exists for exactly one reason: it lets the wire suite drive a REAL
 * yt-dlp against a REAL loopback HTTP server — genuine subprocess coverage
 * with no network egress and no dependency on YouTube being reachable —
 * without weakening or mocking around the private-address guard, which must
 * never be bypassed for a real caller. Nothing in production calls the inner
 * halves directly.
 */
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import { CancelFlag } from "./cancel.js";
import type { ChunkReader } from "./sidecar.js";
import type { EventSender } from "./turn.js";
import type { YtdlpProgressEvent } from "../shared/events.js";
import { isStaleYtdlp, refreshYtdlp } from "./ytdlpInstall.js";


// -------------------------------------------------------------- YouTube id

function isYoutubeId(s: string): boolean {
  return s.length >= 8 && s.length <= 16 && /^[A-Za-z0-9_-]+$/.test(s);
}


function stripPrefixRepeated(s: string, prefix: string): string {
  let out = s;
  while (out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}


/**
 * Video id when `url` is a YouTube watch/short/embed/live/youtu.be link, else
 * null — the switch a caller uses to decide whether a link is a YouTube link
 * at all.
 *
 * Owned upstream by `web/fetch.rs` (`pub fn youtube_video_id`), not this
 * module's territory; ported minimally here because
 * {@link importYoutubeVideo}'s validation gate needs it and nothing upstream
 * exists yet to import. Delete this copy once `web/fetch.ts` lands.
 */
export function youtubeVideoId(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return null;
  const host = stripPrefixRepeated(
    stripPrefixRepeated(parsed.hostname.toLowerCase(), "www."),
    "m.",
  );
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  if (host === "youtu.be") return shortYoutubeId(segments);
  if (host === "youtube.com" || host === "youtube-nocookie.com")
    return youtubeComId(parsed, segments);
  return null;
}


function parseHttpUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}


function shortYoutubeId(segments: string[]): string | null {
  const id = segments[0];
  return id !== undefined && isYoutubeId(id) ? id : null;
}


function watchYoutubeId(parsed: URL): string | null {
  const id = parsed.searchParams.get("v");
  return id !== null && isYoutubeId(id) ? id : null;
}


function isNamedYoutubePath(kind: string | undefined): boolean {
  return kind === "shorts" || kind === "embed" || kind === "live";
}


function namedYoutubeId(segments: string[]): string | null {
  const kind = segments[0];
  const id = segments[1];
  return isNamedYoutubePath(kind) && id !== undefined && isYoutubeId(id)
    ? id
    : null;
}


function youtubeComId(parsed: URL, segments: string[]): string | null {
  if (segments.length === 0 || segments[0] === "watch")
    return watchYoutubeId(parsed);
  return namedYoutubeId(segments);
}


// ------------------------------------------------------------- media cancel

/**
 * The Stop flag for the INTERACTIVE download (the Add-link modal's "Video
 * from this page", the toolbar's Download video).
 *
 * `downloadMediaToTemp` has always been able to be stopped — the agent's
 * `download_media` job passes its own run's flag — but the interactive
 * command used to pass none, so a video the user started by mistake ran to
 * completion (up to the whole {@link MEDIA_DOWNLOAD_BUDGET_MS}) with no way
 * to abandon it short of quitting the app.
 *
 * Process-global is right here rather than per-call, exactly as the Rust
 * `MEDIA_CANCEL` static's own doc explains: there is exactly one interactive
 * download at a time, and the Stop button belongs to whichever one is
 * running. This is deliberately NOT a node in `cancel.ts`'s per-run tree.
 */
export const MEDIA_CANCEL = new CancelFlag();


/** Stop the interactive video download that is running now. Idempotent, and
 * harmless when nothing is downloading — the flag is cleared at the start of
 * every download, so a stale Stop can never kill the NEXT one. */
export function cancelMediaDownload(): void {
  MEDIA_CANCEL.store(true);
}


/** Arm a fresh download. Separate from the entry points so the
 * clear-before-start order is a thing a test can hold onto (the port of
 * `stop_is_armed_per_download_not_left_latched`). */
export function armMediaCancel(): void {
  MEDIA_CANCEL.store(false);
}


// ---------------------------------------------------------------- progress

/** Progress sink for media downloads: (status, percent). Ported verbatim from
 * Rust's `MediaProgress` type alias — a plain callback, tied to no IPC
 * mechanism. The user path forwards to the `ytdlp-progress` event; the
 * download-job runner forwards to `job-progress` — one engine, two
 * dashboards. */
export type MediaProgress = (status: string, percent: number | null) => void;


export const noopProgress: MediaProgress = () => {
  // Intentionally empty — the default when a caller doesn't care.
};


/**
 * Adapt a plain {@link MediaProgress} into the `ytdlp-progress` wire event a
 * real window listens for — the TS shape of Rust's own
 * `emit_progress(window, status, percent)`. NOT wired to any
 * `ipcMain`/`BrowserWindow` here (that belongs to the batch that calls these
 * functions for real); provided so that batch need not re-derive the
 * envelope.
 */
export function mediaProgressToEventSender(send: EventSender): MediaProgress {
  return (status, percent) => {
    const payload: YtdlpProgressEvent = { status, percent };
    try {
      send("ytdlp-progress", payload);
    } catch {
      // Swallowed deliberately, matching turn.ts's TurnId.emit — a closed
      // window must never fail a running download.
    }
  };
}


// ------------------------------------------------------------ subprocess DI

/** The minimal slice of a spawned child process this module needs — a real
 * Node `ChildProcess` satisfies it structurally, and a test supplies a
 * lightweight fake (an `EventEmitter` with `PassThrough` stdio). Same DI idea
 * `sidecar.ts` uses for its own reads. */
export interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}


export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;


export const realSpawn: SpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });


/** The minimal slice of a `fetch()` response this module needs, so a test can
 * script an HTTP response without a DOM lib (this project's tsconfig has
 * none). `body`'s reader shape is exactly {@link ChunkReader} — the same
 * minimal interface `sidecar.ts` already streams through. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): ChunkReader } | null;
}


export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<HttpResponseLike>;


export const realFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as Promise<HttpResponseLike>;


export function killQuietly(child: SpawnedProcess): void {
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}


export async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // Best-effort, matching Rust's `let _ = std::fs::remove_file(...)`.
  }
}


export async function safeRmdir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort, matching Rust's `let _ = std::fs::remove_dir_all(...)`.
    // `recursive` is load-bearing: `fs.rm` throws on a non-empty directory
    // without it, and every one of these call sites is sweeping a work dir
    // that still has a partial download in it.
  }
}


/** The result of running a short subprocess to completion with a timeout —
 * used for both the `-U` self-update and the `-j` format probe, neither of
 * which streams progress.
 *
 * Settles on 'close', never 'exit': Node's 'exit' fires when the process
 * ends, but its stdio pipes may still have unread bytes in them, and a `-j`
 * info dict is hundreds of KB. 'close' is the documented point at which the
 * captured output is complete. ('close' also fires — with the spawn errno as
 * its code — when the binary could not be executed at all, which is why the
 * spawn-error branch cannot deadlock.) */
export type RunOutcome =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "spawn-error"; error: string };


export async function runCapturing(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunOutcome> {
  const child = spawnFn(command, args);
  // BYTES, decoded once at the end — never `chunk.toString("utf8")` per chunk.
  // A pipe hands over ~64 KB at a time and a `-j` info dict is hundreds of KB,
  // so a multi-byte character straddling a read boundary is routine, not
  // exotic: decoding chunk-wise turns each half into U+FFFD, silently mangling
  // every non-ASCII title, description and error line (the halves stay valid
  // inside a JSON string, so nothing throws and the damage is invisible).
  // Rust reads the whole `Vec<u8>` — `serde_json::from_slice(&out.stdout)`,
  // `String::from_utf8_lossy(&out.stderr)` — so buffering is what faithful
  // means here, not a nicety.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const asBuffer = (chunk: Buffer | string): Buffer =>
    typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutChunks.push(asBuffer(chunk));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(asBuffer(chunk));
  });
  const decode = (chunks: Buffer[]): string =>
    Buffer.concat(chunks).toString("utf8");

  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // An over-budget run is abandoned, not left running — yt-dlp replaces
      // itself atomically at the end of `-U`, so a kill mid-fetch just keeps
      // the old binary (Rust's `kill_on_drop`).
      killQuietly(child);
      resolve({
        kind: "timeout",
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
      });
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        kind: "spawn-error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        kind: "exited",
        code,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
      });
    });
  });
}


// ------------------------------------------------------------ ensure/refresh

/** Single-flight guard so two clicks can't download (or update) the binary
 * twice. Safe as a plain boolean: Node is single-threaded and every
 * check-then-act pair below is synchronous with no `await` between the read
 * and the write, so there is no interleaving window a second caller could
 * land in. */
let ytdlpDownloading = false;


export function swapDownloading(next: boolean): boolean {
  const previous = ytdlpDownloading;
  ytdlpDownloading = next;
  return previous;
}


export interface RefreshYtdlpDeps {
  spawnFn?: SpawnFn;
  now?: () => number;
  /** Test-only override of {@link YTDLP_UPDATE_BUDGET_MS}, so the give-up
   * path can be exercised in milliseconds instead of three minutes.
   * Production callers never pass it. */
  updateBudgetMs?: number;
}


/**
 * Let a downloader older than {@link YTDLP_STALE_AFTER_MS} update itself
 * BEFORE it is used. Best-effort on purpose: offline, GitHub down, or over
 * budget all leave the old binary in place — it is still worth trying, and
 * the download that follows will say so truthfully if it isn't.
 */
export async function refreshYtdlpIfStale(
  dest: string,
  progress: MediaProgress,
  deps: RefreshYtdlpDeps = {},
): Promise<void> {
  const mtimeMs = await ytdlpMtime(dest);
  if (mtimeMs === null) return;
  const now = deps.now ?? Date.now;
  if (!isStaleYtdlp(mtimeMs, now)) return;
  // The first-install guard doubles as the update guard; contended means
  // someone else is already refreshing, and the current binary still works.
  if (swapDownloading(true)) return;
  try {
    await refreshYtdlp(dest, progress, deps, now);
  } finally {
    swapDownloading(false);
  }
}


async function ytdlpMtime(dest: string): Promise<number | null> {
  try {
    return (await fsp.stat(dest)).mtimeMs;
  } catch {
    return null;
  }
}
