/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MediaQualityOption } from "../shared/apiTypes.js";


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
  return magics.some(
    (m) =>
      m[0] === head[0] &&
      m[1] === head[1] &&
      m[2] === head[2] &&
      m[3] === head[3],
  );
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
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "of") return ytdlpSizeBytes(sizeAfterOf(tokens, index));
  }
  return null;
}


function sizeAfterOf(tokens: string[], index: number): string | undefined {
  // `of ~ 871.20MiB` and `of ~871.20MiB` both occur.
  return tokens[index + 1] === "~" ? tokens[index + 2] : tokens[index + 1];
}


function ytdlpSizeBytes(token: string | undefined): number | null {
  if (token === undefined) return null;
  const parsed = parsedYtdlpSize(token);
  if (parsed === null) return null;
  return Math.trunc(parsed.number * parsed.scale);
}


function parsedYtdlpSize(token: string): { number: number; scale: number } | null {
  const match = /^([0-9.]+)([A-Za-z]+)$/.exec(token.replace(/^~+/, ""));
  if (match === null) return null;
  const scale = ytdlpSizeScale(match[2]!);
  if (scale === null) return null;
  const number = Number(match[1]!);
  if (!Number.isFinite(number)) return null;
  return { number, scale };
}


function ytdlpSizeScale(unit: string): number | null {
  const scales: Readonly<Record<string, number>> = {
    B: 1,
    KiB: 1024,
    MiB: 1024 * 1024,
    GiB: 1024 * 1024 * 1024,
  };
  return scales[unit] ?? null;
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
const EXPLICIT_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
];


function pathFfmpegCandidates(pathEnv: string): string[] {
  const candidates: string[] = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "ffmpeg"));
  }
  return candidates;
}


export function findFfmpeg(opts: FindFfmpegOptions = {}): string | null {
  const isFile = opts.isFile ?? defaultIsFile;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const candidates = [
    ...EXPLICIT_FFMPEG_PATHS,
    ...pathFfmpegCandidates(pathEnv),
  ];
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
export function formatSelector(
  hasFfmpeg: boolean,
  maxHeight?: number | null,
): string {
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
export function explainDownloadFailure(
  stderrTail: string,
  hasFfmpeg: boolean,
): string {
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
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
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


interface Heights {
  premuxed: number | null;
  avcOnly: number | null;
  anyOnly: number | null;
}


interface DownloadableVideo {
  format: Record<string, unknown>;
  height: number;
  premuxed: boolean;
}


function formatList(info: unknown): unknown[] | null {
  const obj = asObject(info);
  return obj !== null && Array.isArray(obj["formats"])
    ? (obj["formats"] as unknown[])
    : null;
}


function formatSize(format: Record<string, unknown>): number | null {
  return (
    asByteCount(format["filesize"]) ?? asByteCount(format["filesize_approx"])
  );
}


function hasCodec(format: Record<string, unknown>, key: string): boolean {
  const value = asString(format[key]);
  return value !== null && value !== "none";
}


function isAudioOnly(format: Record<string, unknown>): boolean {
  return !hasCodec(format, "vcodec") && hasCodec(format, "acodec");
}


function largestAudioSize(formats: unknown[]): number | null {
  let audioBytes: number | null = null;
  for (const raw of formats) {
    const format = asObject(raw);
    if (format === null || !isAudioOnly(format)) continue;
    audioBytes = maxOpt(audioBytes, formatSize(format));
  }
  return audioBytes;
}


function positiveHeight(format: Record<string, unknown>): number | null {
  const height = asByteCount(format["height"]);
  return height !== null && height > 0 ? height : null;
}


function isDownloadableVideo(
  format: Record<string, unknown>,
  hasFfmpeg: boolean,
  premuxed: boolean,
): boolean {
  return hasCodec(format, "vcodec") && (hasFfmpeg || premuxed);
}


function downloadableVideo(
  raw: unknown,
  hasFfmpeg: boolean,
): DownloadableVideo | null {
  const format = asObject(raw);
  if (format === null) return null;
  const premuxed = hasCodec(format, "acodec");
  if (!isDownloadableVideo(format, hasFfmpeg, premuxed)) return null;
  const height = positiveHeight(format);
  return height === null ? null : { format, height, premuxed };
}


function videoSizeKind(
  format: Record<string, unknown>,
  premuxed: boolean,
): keyof Heights {
  if (premuxed) return "premuxed";
  const codec = asString(format["vcodec"]);
  return codec !== null && codec.startsWith("avc") ? "avcOnly" : "anyOnly";
}


function videoSizesByHeight(
  formats: unknown[],
  hasFfmpeg: boolean,
): Map<number, Heights> {
  const byHeight = new Map<number, Heights>();
  for (const raw of formats) {
    const video = downloadableVideo(raw, hasFfmpeg);
    if (video === null) continue;
    const entry = byHeight.get(video.height) ?? {
      premuxed: null,
      avcOnly: null,
      anyOnly: null,
    };
    const sizeKind = videoSizeKind(video.format, video.premuxed);
    entry[sizeKind] = maxOpt(entry[sizeKind], formatSize(video.format));
    byHeight.set(video.height, entry);
  }
  return byHeight;
}


function approximateHeightSize(
  height: Heights,
  audioBytes: number | null,
): number | null {
  if (height.premuxed !== null) return height.premuxed;
  const videoOnly = height.avcOnly ?? height.anyOnly;
  return videoOnly === null ? null : videoOnly + (audioBytes ?? 0);
}


function qualityOption(
  height: number,
  sizes: Heights,
  audioBytes: number | null,
): MediaQualityOption {
  let approxBytes = approximateHeightSize(sizes, audioBytes);
  if (approxBytes !== null && approxBytes <= 0) approxBytes = null;
  return {
    height,
    approxBytes,
    fits: approxBytes === null || approxBytes <= MAX_DOWNLOAD_BYTES,
  };
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
export function qualityOptions(
  info: unknown,
  hasFfmpeg: boolean,
): MediaQualityOption[] {
  const formats = formatList(info);
  if (formats === null) return [];
  // The audio that rides along with a merged pick: the largest stated
  // audio-only size, so the estimate errs honest (never under).
  const audioBytes = largestAudioSize(formats);
  // height → (pre-muxed size, avc1 video-only size, any video-only size). A
  // pre-muxed file already CARRIES its audio; only a video-only pick pays for
  // the audio track on top.
  const byHeight = videoSizesByHeight(formats, hasFfmpeg);
  return Array.from(byHeight.entries())
    .sort(([left], [right]) => right - left)
    .map(([height, sizes]) => qualityOption(height, sizes, audioBytes));
}
