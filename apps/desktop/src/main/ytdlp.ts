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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { CancelFlag } from "./cancel.js";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import type { Dirent } from "node:fs";
import type { ChunkReader } from "./sidecar.js";
import type { EventSender } from "./turn.js";
import type { FileMeta, ImportReport, MediaQualityOption } from "../shared/apiTypes.js";
import type { YtdlpProgressEvent } from "../shared/events.js";

// ------------------------------------------------------------------ constants

/** Where the yt-dlp universal binary is fetched from. "latest" always, so
 * there is no published digest to pin it against — see
 * {@link looksLikeMacosBinary} for the sanity check that stands in for one. */
export const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

/** Hard cap on the fetched downloader itself. The real binary is ~35 MB; this
 * is generous headroom that still stops a misbehaving mirror from filling the
 * disk while the UI says "Getting the video downloader". */
export const MAX_YTDLP_BYTES = 200 * 1024 * 1024;

/** …and the floor. A few hundred bytes of HTML error page served with a 200
 * is the realistic failure, not a truncated executable. */
export const MIN_YTDLP_BYTES = 1024 * 1024;

/** How long the whole downloader fetch may take — connect, headers AND the
 * body stream. Rust gets this from `reqwest::Client::builder().timeout()`,
 * which spans the entire request; the equivalent here is a deadline the
 * streaming read loop races against, because a bare `fetch()` abort signal
 * that is cleared once the headers land would leave exactly the hang the Rust
 * comment was written about: "a server that accepts the connection and then
 * goes quiet left the app on 'Getting the video downloader…' forever". */
export const YTDLP_FETCH_TIMEOUT_MS = 600_000;

/** After this long the installed downloader is treated as stale and asked to
 * update itself. YouTube's player rotation breaks old extractors on roughly a
 * monthly cadence; well under that keeps downloads working between waves. */
export const YTDLP_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** How long the self-update may take before the download proceeds with the
 * old binary anyway (an update is ~38 MB from GitHub). */
export const YTDLP_UPDATE_BUDGET_MS = 180_000;

/** How often Stop and the overall budget are checked while the downloader is
 * silent. Short enough that Stop feels immediate, long enough to cost
 * nothing. */
export const CANCEL_POLL_MS = 250;

/** The longest one media download may run. Generous — a long video on a slow
 * link is a real thing — but a download with NO limit is a job that can never
 * end, and the user's only escape was a Stop button a stalled downloader
 * never noticed. */
export const MEDIA_DOWNLOAD_BUDGET_MS = 60 * 60 * 1000;

/** How many trailing stderr lines are kept to explain a failure. */
export const STDERR_TAIL_LINES = 3;

/** How long the quality probe (`-j`, metadata only) may take. */
export const FORMAT_PROBE_BUDGET_MS = 60_000;

/**
 * The room-file size cap every finished download and every quality estimate
 * is measured against.
 *
 * Owned upstream by `web/fetch.rs`
 * (`pub const MAX_DOWNLOAD_BYTES: u64 = 900 * 1024 * 1024`), which is NOT yet
 * ported to this workspace; duplicated here because this module's own logic
 * (the over-cap abort, {@link qualityOptions}'s `fits`) needs a real number
 * to be worth testing at all. Delete this copy in favour of an import the day
 * `web/fetch.ts` lands.
 *
 * DISCREPANCY WORTH THE OWNER'S EYES: the brief that commissioned this port
 * describes the cap as "800 MB". The Rust source says 900 MiB — both the
 * constant itself and `ytdlp.rs`'s own test comments ("over the 900 MB cap";
 * the error strings render MiB as "MB"). This port uses the number the code
 * actually enforces and asserts against today. If 800 MB was a newer decision,
 * it never reached `web/fetch.rs`.
 */
export const MAX_DOWNLOAD_BYTES = 900 * 1024 * 1024;

/**
 * What the room says when its internet switch is off and something tried to
 * reach the network anyway. Owned upstream by `commands.rs`
 * (`pub(crate) const WEB_OFF_MESSAGE`) — duplicated here, not reinvented, so
 * this module's refusal reads in the SAME words as every other inlet Rust
 * gates through `require_web_access`. Delete once `commands.ts` exists.
 */
export const WEB_OFF_MESSAGE =
  "This room is offline. Turn on Settings → Online features to fetch from the internet.";

// -------------------------------------------------------------- pure helpers

/**
 * Is this the head of a macOS executable?
 *
 * The binary is fetched from a fixed HTTPS address, marked runnable and run,
 * always at whatever "latest" happens to be — so there is no published digest
 * to pin it against. This is not a signature check and does not pretend to be
 * one; it is the cheap sanity check that catches what actually goes wrong: a
 * captive portal, an error page or a truncated body arriving with a 200 and
 * being chmod +x'd.
 */
export function looksLikeMacosBinary(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const magics: readonly (readonly [number, number, number, number])[] = [
    [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
    [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
    [0xca, 0xfe, 0xba, 0xbe], // universal (FAT), big-endian
    [0xbe, 0xba, 0xfe, 0xca], // universal (FAT), little-endian
  ];
  return magics.some((m) => m[0] === head[0] && m[1] === head[1] && m[2] === head[2] && m[3] === head[3]);
}

/** Where the fetched yt-dlp binary lives (app data, outside any room). The
 * user-data directory is passed in explicitly, matching this port's other
 * files (`keychain.ts`, `windowGeometry.ts`) rather than reaching for
 * electron's `app` module from a unit-testable seam. */
export function ytdlpPath(dataDir: string): string {
  return path.join(dataDir, "bin", "yt-dlp");
}

/** Percentage out of a yt-dlp `--newline` progress line, e.g.
 * `[download]  42.7% of 12.3MiB at 1.2MiB/s`. */
export function parseYtdlpPercent(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[download]")) return null;
  for (const tok of trimmed.split(/\s+/)) {
    if (!tok.endsWith("%")) continue;
    const body = tok.slice(0, -1);
    // Rust's `.parse::<f64>()` fails on an empty string; `Number("")` is 0,
    // which would report a bare "%" token as 0% progress.
    if (body.length === 0) return null;
    const n = Number(body);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The download's TOTAL size out of the same progress line — `42.7% of
 * 871.20MiB` (or `of ~ 871.20MiB`, HLS totals are estimates and both
 * spellings occur). The first progress line announces where the download is
 * headed, so a video the room will refuse anyway is stopped in its first
 * second, not after the hour it takes to arrive.
 *
 * Lines that merely CONTAIN "of" (fragment counters, retry counters) must
 * never parse as a size: a false positive here aborts a legitimate download.
 */
export function parseYtdlpTotalBytes(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[download]")) return null;
  const toks = trimmed.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== "of") continue;
    // `of ~ 871.20MiB` and `of ~871.20MiB` both occur.
    const sizeTok = toks[i + 1] === "~" ? toks[i + 2] : toks[i + 1];
    if (sizeTok === undefined) return null;
    const size = sizeTok.replace(/^~+/, "");
    const m = /^([0-9.]+)([A-Za-z]+)$/.exec(size);
    if (m === null) return null;
    const numStr = m[1];
    const unit = m[2];
    if (numStr === undefined || unit === undefined) return null;
    const scale =
      unit === "B"
        ? 1
        : unit === "KiB"
          ? 1024
          : unit === "MiB"
            ? 1024 * 1024
            : unit === "GiB"
              ? 1024 * 1024 * 1024
              : null;
    if (scale === null) return null;
    const n = Number(numStr);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n * scale);
  }
  return null;
}

/** Last-N-lines-in-original-order tail of captured output — Rust's
 * `.lines().rev().take(N)` re-reversed, joined with a space. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join(" ");
}

/** Injection points for {@link findFfmpeg}, so both "this Mac has one" and
 * "this Mac has none" can be tested on any machine. Production callers pass
 * nothing. */
export interface FindFfmpegOptions {
  isFile?: (p: string) => boolean;
  pathEnv?: string;
}

/**
 * A system ffmpeg, if this Mac has one. The app's no-ffmpeg doctrine is about
 * BUNDLING (nothing to sign or notarize) — it has never forbidden using an
 * ffmpeg the owner already installed. The explicit paths come first because a
 * GUI app's PATH is the bare system one: Homebrew, Intel-Homebrew and
 * MacPorts don't appear in it.
 */
export function findFfmpeg(opts: FindFfmpegOptions = {}): string | null {
  const isFile = opts.isFile ?? defaultIsFile;
  const candidates: string[] = [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg",
  ];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "ffmpeg"));
  }
  return candidates.find(isFile) ?? null;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Which formats to ask yt-dlp for. YouTube increasingly serves ONLY separate
 * video and audio streams (no pre-muxed file at all — first seen 2026-08-21),
 * and joining them needs ffmpeg. Without one, the merge branches must not be
 * OFFERED: yt-dlp would pick them anyway and leave two unmerged files behind.
 *
 * The merge branches prefer h264 (`avc1`): AVFoundation does not decode the
 * VP9 that yt-dlp's plain "best" picks, so best-by-bitrate would import a
 * video the room can't play. No automatic size preference on purpose (owner
 * call, 2026-08-22): quality is never traded away to fit a limit — the
 * RESOLUTION is the user's to pick, and their pick leads the chain with
 * unconstrained fallbacks behind it, so a stale choice degrades to "best
 * available" instead of failing.
 */
export function formatSelector(hasFfmpeg: boolean, maxHeight?: number | null): string {
  const free = hasFfmpeg
    ? "b[ext=mp4]/bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b/bv*+ba"
    : "b[ext=mp4]/b";
  if (maxHeight === undefined || maxHeight === null) return free;
  const h = maxHeight;
  const capped = hasFfmpeg
    ? `b[ext=mp4][height<=${h}]` +
      `/bv*[vcodec^=avc1][height<=${h}]+ba[ext=m4a]` +
      `/bv*[ext=mp4][height<=${h}]+ba[ext=m4a]` +
      `/b[height<=${h}]/bv*[height<=${h}]+ba`
    : `b[ext=mp4][height<=${h}]/b[height<=${h}]`;
  return `${capped}/${free}`;
}

/**
 * The user-facing failure. The one failure shape the user can actually do
 * something about — split-stream-only media on a machine with no ffmpeg —
 * says what to do; everything else surfaces yt-dlp's own words.
 */
export function explainDownloadFailure(stderrTail: string, hasFfmpeg: boolean): string {
  let msg = `The download failed: ${stderrTail}`;
  if (!hasFfmpeg && stderrTail.includes("Requested format is not available")) {
    msg +=
      " This video is only offered as separate picture and sound streams, " +
      "and joining them needs ffmpeg — install it (brew install ffmpeg) " +
      "and try again.";
  }
  return msg;
}

// ---------------------------------------------------------- quality options

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `serde_json::Value::as_u64` — a non-negative integer, or nothing. yt-dlp
 * states sizes as whole bytes; anything else is treated as "size unknown"
 * rather than rounded into a number the picker would present as fact. */
function asByteCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function maxOpt(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Fold yt-dlp's `formats` array into the height choices the picker offers,
 * best first. Without ffmpeg only pre-muxed formats are downloadable, so only
 * their heights are offered — a chip the downloader can't honor is worse than
 * a short list. Sizes mirror what the downloader will pick at that height
 * (best h264 video plus the largest stated audio-only track), and an UNKNOWN
 * size is offered as fitting: refusing on a guess would be a false claim, and
 * the download itself still enforces the real limit.
 */
export function qualityOptions(info: unknown, hasFfmpeg: boolean): MediaQualityOption[] {
  const obj = asObject(info);
  const formats = obj !== null && Array.isArray(obj["formats"]) ? (obj["formats"] as unknown[]) : null;
  if (formats === null) return [];

  const sizeOf = (f: Record<string, unknown>): number | null =>
    asByteCount(f["filesize"]) ?? asByteCount(f["filesize_approx"]);
  const has = (f: Record<string, unknown>, key: string): boolean => {
    const v = asString(f[key]);
    return v !== null && v !== "none";
  };

  // The audio that rides along with a merged pick: the largest stated
  // audio-only size, so the estimate errs honest (never under).
  let audioBytes: number | null = null;
  for (const raw of formats) {
    const f = asObject(raw);
    if (f === null) continue;
    if (has(f, "vcodec") || !has(f, "acodec")) continue;
    audioBytes = maxOpt(audioBytes, sizeOf(f));
  }

  // height → (pre-muxed size, avc1 video-only size, any video-only size). A
  // pre-muxed file already CARRIES its audio; only a video-only pick pays for
  // the audio track on top.
  interface Heights {
    premuxed: number | null;
    avcOnly: number | null;
    anyOnly: number | null;
  }
  const byHeight = new Map<number, Heights>();
  for (const raw of formats) {
    const f = asObject(raw);
    if (f === null) continue;
    if (!has(f, "vcodec")) continue;
    const premuxed = has(f, "acodec");
    if (!hasFfmpeg && !premuxed) continue;
    const height = asByteCount(f["height"]);
    if (height === null || height <= 0) continue;
    const entry = byHeight.get(height) ?? { premuxed: null, avcOnly: null, anyOnly: null };
    const size = sizeOf(f);
    const vcodec = asString(f["vcodec"]);
    const isAvc = vcodec !== null && vcodec.startsWith("avc");
    if (premuxed) {
      entry.premuxed = maxOpt(entry.premuxed, size);
    } else if (isAvc) {
      entry.avcOnly = maxOpt(entry.avcOnly, size);
    } else {
      entry.anyOnly = maxOpt(entry.anyOnly, size);
    }
    byHeight.set(height, entry);
  }

  const out: MediaQualityOption[] = [];
  for (const height of Array.from(byHeight.keys()).sort((a, b) => b - a)) {
    const h = byHeight.get(height);
    if (h === undefined) continue;
    let approx: number | null = h.premuxed;
    if (approx === null) {
      const videoOnly = h.avcOnly ?? h.anyOnly;
      if (videoOnly !== null) approx = videoOnly + (audioBytes ?? 0);
    }
    if (approx !== null && approx <= 0) approx = null;
    out.push({ height, approxBytes: approx, fits: approx === null || approx <= MAX_DOWNLOAD_BYTES });
  }
  return out;
}

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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  const host = stripPrefixRepeated(stripPrefixRepeated(parsed.hostname.toLowerCase(), "www."), "m.");
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (host === "youtu.be") {
    const first = segments[0];
    return first !== undefined && isYoutubeId(first) ? first : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (segments.length === 0 || segments[0] === "watch") {
      const v = parsed.searchParams.get("v");
      return v !== null && isYoutubeId(v) ? v : null;
    }
    const kind = segments[0];
    const id = segments[1];
    if ((kind === "shorts" || kind === "embed" || kind === "live") && id !== undefined && isYoutubeId(id)) {
      return id;
    }
    return null;
  }
  return null;
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

const noopProgress: MediaProgress = () => {
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
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

const realSpawn: SpawnFn = (command, args) =>
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

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<HttpResponseLike>;

const realFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponseLike>;

function killQuietly(child: SpawnedProcess): void {
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // Best-effort, matching Rust's `let _ = std::fs::remove_file(...)`.
  }
}

async function safeRmdir(dir: string): Promise<void> {
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
  timeoutMs: number
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
  const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // An over-budget run is abandoned, not left running — yt-dlp replaces
      // itself atomically at the end of `-U`, so a kill mid-fetch just keeps
      // the old binary (Rust's `kill_on_drop`).
      killQuietly(child);
      resolve({ kind: "timeout", stdout: decode(stdoutChunks), stderr: decode(stderrChunks) });
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "spawn-error", error: err instanceof Error ? err.message : String(err) });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "exited", code, stdout: decode(stdoutChunks), stderr: decode(stderrChunks) });
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

function swapDownloading(next: boolean): boolean {
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
  deps: RefreshYtdlpDeps = {}
): Promise<void> {
  const now = deps.now ?? Date.now;
  let mtimeMs: number;
  try {
    mtimeMs = (await fsp.stat(dest)).mtimeMs;
  } catch {
    return;
  }
  if (now() - mtimeMs <= YTDLP_STALE_AFTER_MS) return;
  // The first-install guard doubles as the update guard; contended means
  // someone else is already refreshing, and the current binary still works.
  if (swapDownloading(true)) return;
  try {
    progress("Updating the video downloader…", null);
    const spawnFn = deps.spawnFn ?? realSpawn;
    const result = await runCapturing(
      spawnFn,
      dest,
      ["-U"],
      deps.updateBudgetMs ?? YTDLP_UPDATE_BUDGET_MS
    );
    if (result.kind === "exited" && result.code === 0) {
      // "Already up to date" leaves the file (and its mtime) untouched, which
      // would re-run this check on every download for the rest of the release
      // gap — mark the check done either way.
      const stamp = new Date(now());
      try {
        await fsp.utimes(dest, stamp, stamp);
      } catch {
        // Best-effort.
      }
    }
  } finally {
    swapDownloading(false);
  }
}

export interface EnsureYtdlpDeps {
  fetchFn?: FetchLike;
  spawnFn?: SpawnFn;
  now?: () => number;
  /** Test-only overrides of {@link MAX_YTDLP_BYTES}/{@link MIN_YTDLP_BYTES}/
   * {@link YTDLP_FETCH_TIMEOUT_MS}. They exist so the oversized, undersized
   * and stalled-body branches can be exercised with a few hundred bytes and a
   * few milliseconds instead of 200 MB and ten minutes. Production callers
   * never pass them. */
  maxBytes?: number;
  minBytes?: number;
  fetchTimeoutMs?: number;
}

/** A deadline fired while waiting for something that has no timeout of its
 * own. */
const DEADLINE = Symbol("deadline");

function raceDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T | typeof DEADLINE> {
  if (deadline.aborted) return Promise.resolve(DEADLINE);
  return new Promise<T | typeof DEADLINE>((resolve, reject) => {
    const onAbort = (): void => resolve(DEADLINE);
    deadline.addEventListener("abort", onAbort, { once: true });
    // `work`'s own rejection is handled here whether or not the deadline won
    // the race, so abandoning it can never surface as an unhandled rejection.
    work.then(
      (v) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        deadline.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Fetch the yt-dlp binary if it isn't installed yet, or let it refresh itself
 * if it's stale. `.part` + rename so a failed download never leaves a half
 * binary behind (stt_download_model's pattern).
 */
export async function ensureYtdlp(
  dataDir: string,
  progress: MediaProgress,
  deps: EnsureYtdlpDeps = {}
): Promise<string> {
  const dest = ytdlpPath(dataDir);
  if (fs.existsSync(dest)) {
    await refreshYtdlpIfStale(dest, progress, { spawnFn: deps.spawnFn, now: deps.now });
    return dest;
  }
  if (swapDownloading(true)) {
    throw new Error("The video downloader is already being installed — try again in a moment.");
  }
  try {
    await downloadYtdlpBinary(dest, progress, deps);
    return dest;
  } finally {
    swapDownloading(false);
  }
}

async function downloadYtdlpBinary(
  dest: string,
  progress: MediaProgress,
  deps: EnsureYtdlpDeps
): Promise<void> {
  const maxBytes = deps.maxBytes ?? MAX_YTDLP_BYTES;
  const minBytes = deps.minBytes ?? MIN_YTDLP_BYTES;
  const timeoutMs = deps.fetchTimeoutMs ?? YTDLP_FETCH_TIMEOUT_MS;
  const fetchFn = deps.fetchFn ?? realFetch;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  progress("Getting the video downloader (first time only)…", null);
  const part = `${dest}.part`;

  // ONE deadline for the whole fetch — connect, headers and body — because
  // that is what Rust's `reqwest::Client::builder().timeout()` covers. Timing
  // out only the headers would re-create the hang this timeout was added for.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const timedOut = new Error(
    `downloader fetch failed: gave up after ${Math.floor(timeoutMs / 1000)}s with no answer`
  );
  try {
    let resp: HttpResponseLike;
    try {
      resp = await fetchFn(YTDLP_URL, { signal: deadline.signal });
    } catch (err) {
      if (deadline.signal.aborted) throw timedOut;
      throw new Error(`downloader fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      throw new Error(`downloader fetch failed: HTTP ${resp.status}`);
    }

    const declaredHeader = resp.headers.get("content-length");
    const declaredRaw = declaredHeader !== null ? Number(declaredHeader) : null;
    const declared = declaredRaw !== null && Number.isFinite(declaredRaw) ? declaredRaw : null;
    if (declared !== null && declared > maxBytes) {
      throw new Error("The video downloader download is implausibly large — refused.");
    }
    const total = declared ?? 35 * 1024 * 1024;

    if (!resp.body) {
      throw new Error("downloader fetch failed: empty response body");
    }
    const reader = resp.body.getReader();
    const handle = await fsp.open(part, "w");
    let got = 0;
    const headBytes: number[] = [];
    let oversized = false;
    let stalled = false;
    try {
      for (;;) {
        const step = await raceDeadline(reader.read(), deadline.signal);
        if (step === DEADLINE) {
          stalled = true;
          break;
        }
        if (step.done || !step.value) break;
        const value = step.value;
        got += value.length;
        if (got > maxBytes) {
          oversized = true;
          break;
        }
        if (headBytes.length < 4) {
          const need = 4 - headBytes.length;
          for (let i = 0; i < Math.min(need, value.length); i++) {
            const b = value[i];
            if (b !== undefined) headBytes.push(b);
          }
        }
        await handle.write(value);
        progress(
          "Getting the video downloader (first time only)…",
          Math.min((got / total) * 100, 100)
        );
      }
    } finally {
      await handle.close();
    }

    // Every rejection removes the partial file, so the next attempt starts
    // clean rather than inheriting whatever arrived.
    if (stalled) {
      await safeUnlink(part);
      throw timedOut;
    }
    if (oversized) {
      await safeUnlink(part);
      throw new Error("The video downloader download is implausibly large — refused.");
    }
    if (got < minBytes || !looksLikeMacosBinary(Uint8Array.from(headBytes))) {
      await safeUnlink(part);
      throw new Error(
        "What arrived is not the video downloader — the download was refused rather than run."
      );
    }
    await fsp.chmod(part, 0o755);
    await fsp.rename(part, dest);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- the download

/** A media file staged by yt-dlp: the work dir to sweep and the file inside
 * it. */
export interface MediaDownload {
  workDir: string;
  path: string;
}

/** The minimal shape {@link pumpDownloadProgress} needs — satisfied by a real
 * `ChildProcess`, by {@link SpawnedProcess}, and by a bare `{ stdout }` in a
 * test that wants to drive the loop with nothing but a `PassThrough`. */
export interface StdoutSource {
  readonly stdout: NodeJS.ReadableStream | null;
}

/**
 * Read the downloader's stdout line by line, watching three things at once —
 * exactly Rust's `tokio::select!` loop: an announced total over the cap
 * (abandon in the first second, not after the file fully arrives), the Stop
 * flag, and the overall budget. Returns the abandonment reason, or `null` if
 * the stream simply ended (the process is on its way out; the caller reads
 * its real exit code next).
 *
 * Stop used to be checked only when a progress line ARRIVED, so a stalled
 * download ignored it completely — hence the timer racing the read rather
 * than a check inside the line handler. The race is on the pending read
 * itself rather than on closing the reader from a timer, so nothing depends
 * on `Interface#close()` interrupting an in-flight `next()`.
 *
 * Exported as its own seam so the cancellation/budget/oversize logic can be
 * exercised deterministically against a scripted `PassThrough`, without
 * spawning anything or waiting out the real one-hour budget.
 */
export async function pumpDownloadProgress(
  child: StdoutSource,
  cancel: CancelFlag | undefined,
  progress: MediaProgress,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
  budgetMs: number = MEDIA_DOWNLOAD_BUDGET_MS,
  pollMs: number = CANCEL_POLL_MS
): Promise<string | null> {
  if (!child.stdout) return null;
  const rl = createInterface({ input: child.stdout });
  const iter = rl[Symbol.asyncIterator]();
  // A stream error means the process is on its way out; the caller reads its
  // real exit code and explains the failure from stderr, so a rejection here
  // is folded into "the stream ended" rather than thrown from the pump.
  const nextLine = (): Promise<IteratorResult<string>> =>
    iter.next().catch(() => ({ done: true, value: undefined }) as IteratorResult<string>);

  const started = Date.now();
  let pending = nextLine();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = new Promise<{ tag: "poll" }>((resolve) => {
        timer = setTimeout(() => resolve({ tag: "poll" }), pollMs);
      });
      const winner = await Promise.race([pending.then((r) => ({ tag: "line" as const, r })), poll]);
      clearTimeout(timer);
      if (winner.tag === "line") {
        if (winner.r.done) return null; // stdout closed: the process is on its way out.
        const line: string = winner.r.value;
        pending = nextLine();
        // A file the room will refuse is abandoned on the FIRST progress
        // line, not after it fully arrives — same truthful refusal, an hour
        // earlier.
        const total = parseYtdlpTotalBytes(line);
        if (total !== null && total > maxBytes) {
          return (
            `This video is about ${Math.floor(total / (1024 * 1024))} MB — larger than the ` +
            `${Math.floor(maxBytes / (1024 * 1024))} MB limit for a room file. ` +
            "Stopped before downloading it."
          );
        }
        const pct = parseYtdlpPercent(line);
        if (pct !== null) progress("Downloading the video…", pct);
      }
      if (cancel?.load() === true) return "Stopped.";
      if (Date.now() - started > budgetMs) {
        return `The video download gave up after ${Math.floor(budgetMs / 60_000)} minutes — it may be stalled.`;
      }
    }
  } finally {
    rl.close();
  }
}

/** Everything {@link downloadMediaToTemp} takes beyond the data dir and the
 * URL. The `*Fn`/`*Ms`/`maxDownloadBytes`/`tempDir` members are injection
 * points for the test suite; production callers pass only `maxHeight`,
 * `cancel` and `progress`. */
export interface DownloadMediaOptions {
  maxHeight?: number | null;
  /** Polled the same way Rust's `Option<&AtomicBool>` was: a Stop lands
   * within {@link CANCEL_POLL_MS} even while the downloader is silent. */
  cancel?: CancelFlag;
  progress: MediaProgress;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  maxDownloadBytes?: number;
  tempDir?: string;
  cancelPollMs?: number;
  mediaDownloadBudgetMs?: number;
}

/**
 * BROWSE-2: download the media at any yt-dlp-supported URL into a temp work
 * dir. Format choice is {@link formatSelector}'s: pre-muxed first, split
 * streams joined by a system ffmpeg when the machine has one.
 *
 * D16: yt-dlp is a subprocess doing its own networking, so the SSRF guard
 * cannot pin its connections — it gets a pre-flight instead (literal check +
 * DNS resolve of the target). The redirect residual risk is documented and
 * accepted, the same posture the YouTube feature always shipped with.
 * D15: the size cap is enforced on the finished file before import, AND on
 * the first progress line that announces an over-cap total.
 */
export async function downloadMediaToTemp(
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions
): Promise<MediaDownload> {
  const parsed = checkPublicHttpUrl(url);
  await resolvePublicAddr(parsed.hostname, knownPortOrDefault(parsed));
  return runYtdlpDownload(dataDir, url, opts);
}

/** `URL.port` is `""` for a default port; fill in the scheme's known default
 * the way Rust's `Url::port_or_known_default` does. */
function knownPortOrDefault(parsed: URL): number {
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "http:" ? 80 : 443;
}

/**
 * The yt-dlp subprocess engine, with the SSRF pre-flight already done by
 * {@link downloadMediaToTemp}. See this file's header for why it is exported
 * separately; nothing in production calls it directly.
 */
export async function runYtdlpDownload(
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions
): Promise<MediaDownload> {
  const bin = await ensureYtdlp(dataDir, opts.progress, {
    spawnFn: opts.spawnFn,
    fetchFn: opts.fetchFn,
  });
  const workDir = path.join(opts.tempDir ?? os.tmpdir(), `arcelle-yt-${randomUUID()}`);
  await fsp.mkdir(workDir, { recursive: true });
  opts.progress("Downloading the video…", 0);

  // Title is byte-clamped so the filename can't overflow macOS limits.
  const output = path.join(workDir, "%(title).100B.%(ext)s");
  const ffmpeg = (opts.findFfmpegFn ?? (() => findFfmpeg()))();
  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "-f",
    formatSelector(ffmpeg !== null, opts.maxHeight),
    "-o",
    output,
  ];
  if (ffmpeg !== null) args.push("--ffmpeg-location", ffmpeg);
  args.push(url);

  const child = (opts.spawnFn ?? realSpawn)(bin, args);

  // Node's spawn() does not throw synchronously the way Rust's
  // `Command::spawn()` does for e.g. "no such file" — that surfaces
  // asynchronously as an 'error' event, always followed by 'close' carrying
  // the spawn errno, so recording it and checking once the loop settles
  // cannot deadlock.
  let spawnError: string | null = null;
  child.on("error", (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });

  // Registered BEFORE the stdout loop so a process that ends almost
  // immediately can never fire 'close' with nothing listening.
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
  });

  // Drain stderr CONCURRENTLY, keeping only a bounded tail. It used to be
  // read only after the process exited, so a downloader noisy enough to fill
  // the 64 KB pipe buffer blocked writing, stopped producing progress lines,
  // and both sides waited on each other forever.
  const stderrTail: string[] = [];
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line: string) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });
  }

  const maxBytes = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const abandoned = await pumpDownloadProgress(
    child,
    opts.cancel,
    opts.progress,
    maxBytes,
    opts.mediaDownloadBudgetMs ?? MEDIA_DOWNLOAD_BUDGET_MS,
    opts.cancelPollMs ?? CANCEL_POLL_MS
  );
  if (abandoned !== null) {
    killQuietly(child);
    await closed;
    await safeRmdir(workDir);
    throw new Error(abandoned);
  }

  const { code } = await closed;
  if (spawnError !== null) {
    await safeRmdir(workDir);
    throw new Error(`couldn't start the video downloader: ${spawnError}`);
  }
  if (code !== 0) {
    await safeRmdir(workDir);
    throw new Error(explainDownloadFailure(stderrTail.join(" "), ffmpeg !== null));
  }

  // The finished file is whatever yt-dlp left behind (partials are cleaned up
  // by yt-dlp itself on success).
  const downloaded = await pickDownloadedFile(workDir);
  if (downloaded === null) {
    throw new Error("The downloader finished but produced no file.");
  }
  const size = (await fsp.stat(downloaded)).size;
  if (size > maxBytes) {
    await safeRmdir(workDir);
    throw new Error(
      `The video is ${Math.floor(size / (1024 * 1024))} MB — larger than the ` +
        `${Math.floor(maxBytes / (1024 * 1024))} MB limit for a room file.`
    );
  }
  return { workDir, path: downloaded };
}

/** The largest non-`.part` file directly inside `dir`, or null if there is
 * none. */
async function pickDownloadedFile(workDir: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(workDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; size: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".part")) continue;
    const full = path.join(workDir, entry.name);
    let size = 0;
    try {
      size = (await fsp.stat(full)).size;
    } catch {
      size = 0;
    }
    if (best === null || size > best.size) best = { path: full, size };
  }
  return best?.path ?? null;
}

// -------------------------------------------------------------- format list

/** A boolean-returning check for the room's internet on/off switch —
 * injected, per the porting brief, rather than reimplementing
 * `commands::require_web_access` (a room-settings read this batch does not
 * own). `true` means the room may reach the network. */
export type WebAccessCheck = () => boolean;

export interface ListMediaFormatsOptions {
  dataDir: string;
  webAccessAllowed: WebAccessCheck;
  progress?: MediaProgress;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  /** Test-only override of {@link FORMAT_PROBE_BUDGET_MS}. */
  formatProbeBudgetMs?: number;
}

/**
 * The qualities a video actually offers, for the modal's picker. Same web
 * gating and SSRF pre-flight as the download itself — a metadata probe is
 * still an outbound reach.
 */
export async function listMediaFormats(
  url: string,
  opts: ListMediaFormatsOptions
): Promise<MediaQualityOption[]> {
  if (!opts.webAccessAllowed()) {
    throw new Error(WEB_OFF_MESSAGE);
  }
  const trimmed = url.trim();
  const parsed = checkPublicHttpUrl(trimmed);
  await resolvePublicAddr(parsed.hostname, knownPortOrDefault(parsed));
  return probeMediaFormats(trimmed, opts);
}

/**
 * The `-j` probe engine, with the web gate and SSRF pre-flight already done
 * by {@link listMediaFormats}. See this file's header for why it is exported
 * separately; nothing in production calls it directly.
 */
export async function probeMediaFormats(
  url: string,
  opts: ListMediaFormatsOptions
): Promise<MediaQualityOption[]> {
  const progress = opts.progress ?? noopProgress;
  const bin = await ensureYtdlp(opts.dataDir, progress, {
    fetchFn: opts.fetchFn,
    spawnFn: opts.spawnFn,
  });
  // `-j`: the video's whole info dict as one JSON line, nothing downloaded.
  const result = await runCapturing(
    opts.spawnFn ?? realSpawn,
    bin,
    ["--no-playlist", "--no-warnings", "-j", url],
    opts.formatProbeBudgetMs ?? FORMAT_PROBE_BUDGET_MS
  );
  if (result.kind === "spawn-error") {
    throw new Error(`couldn't start the video downloader: ${result.error}`);
  }
  if (result.kind === "timeout") {
    throw new Error("Looking up this video's qualities took too long.");
  }
  if (result.code !== 0) {
    throw new Error(
      `Couldn't look up this video's qualities: ${tailLines(result.stderr, STDERR_TAIL_LINES)}`
    );
  }
  let info: unknown;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error("The site's answer about this video made no sense.");
  }
  return qualityOptions(info, (opts.findFfmpegFn ?? (() => findFfmpeg()))() !== null);
}

// ------------------------------------------------------------ entry points

/**
 * The shared "bring this downloaded file into the encrypted room" funnel
 * (Rust's `import_download`: extraction, OCR/STT lanes, auto-index, privacy
 * scan, and the `source="download"` provenance with its origin URL). Takes
 * the staged file's path, its display name and the URL it came from; returns
 * (or resolves to) the room's `FileMeta`, or throws/rejects on failure.
 *
 * Typed as possibly-async even though Rust's is synchronous: the real
 * implementation is a future batch's to write and may reasonably do async
 * I/O. Every call site awaits it either way, which is a no-op for a
 * synchronous return.
 */
export type ImportDownloadFn = (
  filePath: string,
  displayName: string,
  sourceUrl: string
) => FileMeta | Promise<FileMeta>;

export interface ImportMediaOptions {
  dataDir: string;
  maxHeight?: number | null;
  webAccessAllowed: WebAccessCheck;
  importDownload: ImportDownloadFn;
  progress?: MediaProgress;
  /** Defaults to the process-global {@link MEDIA_CANCEL} — the interactive
   * Stop button. A job runner passes its own run's flag instead. */
  cancel?: CancelFlag;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  maxDownloadBytes?: number;
  tempDir?: string;
  cancelPollMs?: number;
  mediaDownloadBudgetMs?: number;
}

/**
 * BROWSE-2: the same download for ANY yt-dlp-supported site — what the
 * toolbar's "Download video" and the Add-link modal's non-YouTube video
 * option call. yt-dlp failing on an unsupported site surfaces truthfully.
 *
 * FAITHFUL-PORT NOTE: Rust removes the work dir and emits "Done" 100%
 * UNCONDITIONALLY — even when `import_download` itself fails — and only the
 * final `Result` differs on that path. A failed import still saying "Done"
 * reads as an inconsistency, but it is what the source does and this port
 * preserves behaviour rather than quietly improving it. Flagged here, and
 * pinned by a test, for the owner to decide.
 */
export async function importMediaUrl(
  url: string,
  opts: ImportMediaOptions
): Promise<ImportReport> {
  const trimmed = url.trim();
  // Fail fast (and fetch nothing) when the room's internet switch is off:
  // downloading a video is as much a network reach as the browser's address
  // bar, which has been gated since BROWSE-1.
  if (!opts.webAccessAllowed()) {
    throw new Error(WEB_OFF_MESSAGE);
  }
  // Clear FIRST: a Stop pressed against a download that already ended must
  // not cancel the next one before it has fetched a byte.
  armMediaCancel();
  const progress = opts.progress ?? noopProgress;
  const media = await downloadMediaToTemp(opts.dataDir, trimmed, {
    maxHeight: opts.maxHeight ?? null,
    cancel: opts.cancel ?? MEDIA_CANCEL,
    progress,
    spawnFn: opts.spawnFn,
    fetchFn: opts.fetchFn,
    findFfmpegFn: opts.findFfmpegFn,
    maxDownloadBytes: opts.maxDownloadBytes,
    tempDir: opts.tempDir,
    cancelPollMs: opts.cancelPollMs,
    mediaDownloadBudgetMs: opts.mediaDownloadBudgetMs,
  });

  progress("Sealing the video into the room…", null);
  const name = path.basename(media.path) || "video.mp4";
  let imported: FileMeta | null = null;
  let importError: unknown = null;
  try {
    imported = await opts.importDownload(media.path, name, trimmed);
  } catch (err) {
    importError = err;
  }
  // See the FAITHFUL-PORT NOTE: both of these run even when the import just
  // failed.
  await safeRmdir(media.workDir);
  progress("Done", 100);
  if (importError !== null) throw importError;
  return { imported: [imported as FileMeta], errors: [] };
}

/**
 * Download a YouTube video into the room. Fetches yt-dlp on first use, saves
 * the best format it can get to a private temp folder, imports it through the
 * download funnel (so preview + background transcription just happen, and the
 * file keeps its origin URL), then removes the temp copy. The captions-only
 * import (ADD-19) remains a separate, cheaper path.
 */
export async function importYoutubeVideo(
  url: string,
  opts: ImportMediaOptions
): Promise<ImportReport> {
  const trimmed = url.trim();
  if (youtubeVideoId(trimmed) === null) {
    throw new Error("That doesn't look like a YouTube video link.");
  }
  return importMediaUrl(trimmed, opts);
}
