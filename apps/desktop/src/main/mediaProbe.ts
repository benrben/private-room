/**
 * Port of `src-tauri/src/media_probe.rs` (534 lines, read in full) — what a
 * video ACTUALLY is: duration, display size, codec, frame rate and whether it
 * carries sound, read from the container itself rather than guessed from a
 * mime type and an extension.
 *
 * EVERY FIELD IS OPTIONAL AND MEANS IT, same doctrine as the Rust source's own
 * header: a container that never stated its frame rate leaves `frameRate`
 * `null`, and the viewer must render that as "unknown", never as a plausible
 * default. A file the probing engine cannot open at all probes to `null`, not
 * to an object full of zeros.
 *
 * ============================================================================
 * ENGINE SWAP — READ THIS FIRST, IT IS THE WHOLE STORY OF THIS PORT
 * ============================================================================
 * The Rust source reads every fact through AVFoundation (`objc2_av_foundation`
 * — `AVURLAsset`, `AVAssetTrack`, `CMFormatDescription`), the same OS media
 * stack `avconvert` already decodes audio tracks with, "so there is no ffmpeg
 * to bundle, sign or notarize" (its own module doc, verbatim). Node has no
 * binding to AVFoundation at all — that door really is shut, exactly the kind
 * of "genuine native dependency" this migration expects here.
 *
 * But per this task's own instruction, checked before writing a stub:
 * `ytdlp.ts` already establishes the house convention for a media tool this
 * app does NOT bundle but WILL use opportunistically if the owner's Mac has
 * one — {@link findFfmpeg} here mirrors `ytdlp.ts`'s own `findFfmpeg` almost
 * exactly (same three Homebrew/MacPorts paths, same PATH scan), and
 * `textUtil.ts` sets the nearer precedent still: a real macOS/third-party CLI
 * Node CAN reach directly via `child_process` is a REAL port, not a stub,
 * even though it is a different engine than the Rust source's own. `ffprobe`
 * (bundled with any `ffmpeg` install) reads a container's `streams`/`format`
 * exactly as AVFoundation does — different C library, same facts on disk — so
 * {@link probePath}/{@link probeBytes} call it FOR REAL when this Mac has one,
 * via {@link ffprobeEngine}, and answer `null` — the same honest "nothing
 * learned" this module already uses everywhere else — when it does not. That
 * `null` covers BOTH of the Rust source's own `None` reasons: "this OS has no
 * media stack" (its `#[cfg(not(target_os = "macos"))]` arm) and "the stack
 * opened the file and found nothing" (its "0 tracks" guard) — `ffprobeEngine`
 * folds "no ffprobe on this Mac" into the first and "ffprobe exited non-zero /
 * reported zero streams" into the second, and a caller cannot tell the two
 * apart from the Rust side either.
 *
 * {@link lastFramePng} gets the same treatment via `ffmpeg` itself
 * ({@link ffmpegLastFrameEngine}) — see that function's own doc for the
 * mechanism swap (a `-sseof`/`-update` capture in place of
 * `AVAssetImageGenerator`'s CMTime-tolerance retry).
 *
 * WHAT DID NOT SURVIVE THE SWAP, spelled out rather than silently absorbed:
 *   - `display_size`'s exact 2×2 transform-matrix math (`t.a.abs()*w + …`)
 *     becomes {@link normalizeRotation}'s nearest-90° read of ffprobe's own
 *     `side_data_list[].rotation` / `tags.rotate` — exact for every
 *     axis-aligned rotation (0/90/180/270), which is every rotation a real
 *     phone or camera actually writes (the exact scenario the Rust doc
 *     comment itself calls out: "a portrait iPhone clip"). An arbitrary
 *     non-axis-aligned transform (no real file has ever been observed to
 *     carry one) would round to the nearest 90° instead of computing the true
 *     bounding box; Rust's own math has no such gap, so this is a real,
 *     narrow fidelity loss, not a rounding nicety.
 *   - `fourcc_string` read four raw bytes out of a `CMFormatDescription`;
 *     {@link fourccString} here validates ffprobe's ALREADY-DECODED
 *     `codec_tag_string`, because that is the only shape this engine hands
 *     over. It rejects the same "not printable ASCII" case Rust's byte-range
 *     check does, plus one Rust never had to consider: ffprobe's own
 *     `"[N][N][N][N]"` placeholder for a tag that is not printable ASCII to
 *     begin with (WAV/AIFF PCM's numeric `wFormatTag`, for one — see
 *     {@link trackCodec}'s doc for the concrete WAV case this costs).
 *   - `estimatedDataRate()` is a property AVFoundation computes FOR the video
 *     TRACK specifically. ffprobe's closest per-stream analogue is that
 *     stream's own `bit_rate` field, which some containers simply do not
 *     populate (VBR without an explicit `btrt`/`esds` rate box); this port
 *     never falls back to the FORMAT-level bitrate to fill that gap, because
 *     the format bitrate is video+audio combined and reporting it as the
 *     video track's own rate would be exactly the kind of claim this module
 *     exists not to make. `bitrateKbps` stays `null` there instead.
 *
 * ============================================================================
 * NOT A MODEL TOOL
 * ============================================================================
 * `media_probe.rs` itself carries no `#[tauri::command]` of its own — grepped
 * the Rust tree: its ONLY caller-side command, `probe_video_meta`, lives in
 * `commands/video.rs` (516 lines, a SEPARATE Rust file, read in full but out
 * of this port's scope — it also holds `video_trim`/`save_video_frame`, an
 * `avconvert`-cutting command surface unrelated to reading a container's own
 * facts). Confirmed the same way over this migration's `toolSpecs.ts`/
 * `toolSchema.ts`/`execTool.ts`: no reference to `media_probe`, `probe_bytes`,
 * `probe_video_meta`, or `MediaMeta` anywhere in any of the three — the only
 * video-shaped model tool at all is `view_media_frame`
 * (`mediaTools.ts`'s own doc already tracks that one; it is unrelated —
 * container METADATA vs. a decoded FRAME the model looks at). Nothing in this
 * batch touches `execTool.ts`, per this migration's rule 6: there is no arm
 * to add additively because no arm calls this module.
 *
 * NO IPC WIRING in this batch either, and for a sharper reason than the usual
 * "Phase 2 needs an explicit go-ahead" — `probe_video_meta`'s own wire
 * contract entry already exists (`ipc-contract.ts`'s `probe_video_meta: {
 * args: { id: string }; result: MediaMeta | null }`), but its REAL Rust body
 * (`commands/video.rs:210-246`) reads/writes `files.media_meta` through
 * `db::get_media_meta`/`set_media_meta`, re-checks the room path and epoch
 * across the `await`, and reads the file's bytes via `take_media_bytes` (a
 * `commands/video.rs`-local helper this port does not have) — none of which
 * belongs to `media_probe.rs`. A `registerMediaProbeIpc` written here that
 * skipped all of that would not be the Rust command; it would be a smaller,
 * subtly wrong thing wearing its channel name. That command is `commands/
 * video.rs`'s port to write, whenever that 516-line file's turn comes — this
 * module hands it real, injectable {@link probePath}/{@link probeBytes}
 * functions to call, exactly as `media_probe.rs` itself hands `commands/
 * video.rs` `probe_bytes`/`probe_path` to call.
 *
 * ============================================================================
 * `MediaMeta` IS NOT REDECLARED
 * ============================================================================
 * It already exists, field-for-field with the Rust struct (which itself
 * derives `#[serde(rename_all = "camelCase")]`), in `../shared/apiTypes.ts` —
 * the same type `FileContent.mediaMeta` and `ipc-contract.ts`'s
 * `probe_video_meta` result already use. Importing it here is what keeps this
 * port and that not-yet-written IPC layer from ever drifting apart.
 *
 * PRIVACY NOTE, same bargain `quicklook.rs`/`textutil.rs`/`peaks.rs`'s ports
 * already state and already ported verbatim here: `ffprobe`/`ffmpeg` take
 * file PATHS, so {@link probeBytes}/{@link lastFramePng} write the decrypted
 * bytes to an owner-only (`0o600`, created exclusively) temp file for the
 * moment the call takes and remove it on EVERY exit path, success or failure,
 * via `finally`. {@link probePath} never writes anything: the caller's own
 * file is already on disk there, so it is probed in place, exactly as Rust's
 * `probe_path` is.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MediaMeta } from "../shared/apiTypes.js";
import {
  EMPTY_MEDIA_META,
  codecName,
  fourccString,
  fractionOf,
  isEmptyMediaMeta,
  saneFrameRate,
  type FfprobeOutput,
  type FfprobeStream,
} from "./mediaProbeMetadata.js";

export {
  EMPTY_MEDIA_META,
  codecName,
  fourccString,
  isEmptyMediaMeta,
  saneFrameRate,
} from "./mediaProbeMetadata.js";

// ------------------------------------------------------------------- MediaMeta

/** ffprobe's `side_data_list[].rotation` (newer, a signed degree value) with
 * `tags.rotate` (older, a string) as the fallback — the two shapes real
 * encoders actually use for a QuickTime/MP4 display-transform rotation. `0`
 * (no rotation stated) when neither is present, matching an untransformed
 * `AVAssetTrack`. */
function rotationOf(stream: FfprobeStream): number {
  return sideDataRotation(stream.side_data_list) ?? tagRotation(stream.tags) ?? 0;
}

function sideDataRotation(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const rotation = sideDataEntryRotation(entry);
    if (rotation !== null) return rotation;
  }
  return null;
}

function sideDataEntryRotation(entry: unknown): number | null {
  if (typeof entry !== "object" || entry === null) return null;
  return finiteNumber((entry as Record<string, unknown>).rotation);
}

function tagRotation(tags: FfprobeStream["tags"]): number | null {
  if (tags?.rotate === undefined) return null;
  return finiteNumber(Number(tags.rotate));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Nearest axis-aligned quarter turn, in `[0, 360)`. See this module's own
 * "ENGINE SWAP" doc for why nearest-90° stands in for Rust's exact 2×2
 * transform-matrix math. */
function normalizeRotation(deg: number): number {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

/**
 * `display_size` — the video stream's DISPLAY size, with an axis-aligned
 * rotation already applied (width/height swapped at 90°/270°). `null` when
 * the stream states no usable positive size, matching Rust's
 * `w >= 1.0 && h >= 1.0 && w.is_finite() && h.is_finite()` guard (ffprobe's
 * `width`/`height` are already whole, finite pixel counts when present, so
 * the finiteness half of that guard is automatic here).
 */
function displaySize(stream: FfprobeStream): { width: number; height: number } | null {
  const { width, height } = stream;
  if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) {
    return null;
  }
  const rotated = normalizeRotation(rotationOf(stream)) % 180 !== 0;
  return rotated ? { width: height, height: width } : { width, height };
}

/**
 * `track_codec` — the human name where {@link CODEC_NAMES} knows the tag,
 * otherwise a HONEST fallback this Rust source never needed: ffprobe's own
 * `codec_name` (its internal codec id, e.g. `"h264"`, `"pcm_s16le"`) shown
 * verbatim when the container gave no fourcc-shaped tag at all.
 *
 * THE CONCRETE COST: a WAV/AIFF file's linear-PCM stream reports
 * `codec_tag_string` as ffmpeg's numeric placeholder (`"[1][0][0][0]"` —
 * see {@link FFMPEG_UNTAGGED}), which {@link fourccString} correctly refuses
 * as not a real tag; this falls back to `codec_name`'s `"pcm_s16le"` rather
 * than the `"Linear PCM"` AVFoundation's own `'lpcm'` FourCharCode would
 * produce. Left as `"pcm_s16le"` rather than hand-mapping ffmpeg's codec ids
 * through {@link CODEC_NAMES} too: that table is a verbatim port of a table
 * keyed on FOURCC values Rust actually reads, and extending it with
 * ffmpeg-specific ids Rust never had would be inventing a second naming
 * scheme the Rust source does not define, not porting the one it does. (In
 * this app's own usage this rarely bites: `commands/files.rs` only ever
 * probes files `stt::media_kind` calls VIDEO — plain audio recordings, which
 * are exactly where a bare WAV would show up, never reach `media_probe` at
 * all.)
 */
function trackCodec(stream: FfprobeStream | undefined): string | null {
  if (stream === undefined) return null;
  const tag = fourccString(stream.codec_tag_string ?? null);
  if (tag !== null) return codecName(tag);
  const raw = stream.codec_name?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}

function bitrateKbpsOf(stream: FfprobeStream): number | null {
  const bits = Number(stream.bit_rate);
  return Number.isFinite(bits) && bits > 0 ? Math.round(bits / 1000) : null;
}

function durationSecsOf(raw: string | undefined): number | null {
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

/**
 * The pure half of the ffprobe engine: ffprobe's own `-print_format json`
 * text in, a `MediaMeta` out. Exported and directly testable against literal
 * JSON — real captured ffprobe output AND synthetic edge cases (a rotated
 * stream, a missing `bit_rate`, a corrupt document) — exactly how the Rust
 * source's own `sane_frame_rate`/`codec_name`/`fourcc_string` are unit-tested
 * without ever opening an `AVAsset`.
 *
 * `null` on malformed JSON (mirrors a file AVFoundation refuses outright) and
 * when neither a video nor an audio stream is present (Rust's own "0 tracks"
 * guard: "a text file renamed .mp4 opens as an empty asset rather than
 * failing, and storing '0 tracks, unknown everything' for it would be a claim
 * that we probed a video").
 */
export function parseFfprobeOutput(stdout: string): MediaMeta | null {
  const output = parseFfprobeDocument(stdout);
  if (output === null) return null;
  const tracks = mediaTracks(output);
  if (tracks.video === undefined && tracks.audio === undefined) return null;
  const meta = mediaMetaForTracks(output, tracks.audio);
  return tracks.video === undefined ? nonEmptyMeta(meta) : videoMeta(meta, tracks.video);
}

function parseFfprobeDocument(stdout: string): FfprobeOutput | null {
  try {
    return ffprobeOutput(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function ffprobeOutput(value: unknown): FfprobeOutput | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as FfprobeOutput)
    : null;
}

function mediaTracks(output: FfprobeOutput): { video: FfprobeStream | undefined; audio: FfprobeStream | undefined } {
  const streams = ffprobeStreams(output.streams);
  return { video: trackOfType(streams, "video"), audio: trackOfType(streams, "audio") };
}

function ffprobeStreams(value: unknown): FfprobeStream[] {
  return Array.isArray(value) ? value.filter(isFfprobeStream) : [];
}

function isFfprobeStream(value: unknown): value is FfprobeStream {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trackOfType(streams: readonly FfprobeStream[], type: string): FfprobeStream | undefined {
  return streams.find((stream) => stream.codec_type === type);
}

function mediaMetaForTracks(output: FfprobeOutput, audio: FfprobeStream | undefined): MediaMeta {
  return {
    ...EMPTY_MEDIA_META,
    hasAudio: audio !== undefined,
    audioCodec: trackCodec(audio),
    durationSecs: durationSecsOf(output.format?.duration),
  };
}

function videoMeta(meta: MediaMeta, video: FfprobeStream): MediaMeta | null {
  const fraction = fractionOf(video.r_frame_rate) ?? fractionOf(video.avg_frame_rate);
  const enriched: MediaMeta = {
    ...meta,
    ...videoSize(video),
    videoCodec: trackCodec(video),
    frameRate: fraction === null ? null : saneFrameRate(fraction),
    bitrateKbps: bitrateKbpsOf(video),
  };
  return nonEmptyMeta(enriched);
}

function videoSize(video: FfprobeStream): Partial<MediaMeta> {
  const size = displaySize(video);
  return size === null ? {} : size;
}

function nonEmptyMeta(meta: MediaMeta): MediaMeta | null {
  // Belt-and-suspenders, matching Rust's `(!meta.is_empty()).then_some(meta)`.
  return isEmptyMediaMeta(meta) ? null : meta;
}

// ------------------------------------------------------- binary discovery

/** Injection points for {@link findFfmpeg}/{@link findFfprobe}, so both "this
 * Mac has one" and "this Mac has none" can be tested on any machine — the
 * same shape `ytdlp.ts`'s own `FindFfmpegOptions` uses. */
export interface FindBinaryOptions {
  isFile?: (p: string) => boolean;
  pathEnv?: string;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `ytdlp.ts`'s `findFfmpeg`, reproduced rather than imported: this module
 * has no other reason to depend on the YouTube downloader, and duplicating
 * three lines of candidate paths is cheaper than a cross-feature import for
 * two unrelated ports to share. Explicit paths first because a GUI app's PATH
 * is the bare system one — Homebrew, Intel-Homebrew and MacPorts don't appear
 * in it. */
function findBinary(name: "ffmpeg" | "ffprobe", opts: FindBinaryOptions = {}): string | null {
  const isFile = opts.isFile ?? defaultIsFile;
  return binaryCandidates(name, binaryPath(opts)).find(isFile) ?? null;
}

function binaryPath(opts: FindBinaryOptions): string {
  return opts.pathEnv ?? process.env.PATH ?? "";
}

function binaryCandidates(name: "ffmpeg" | "ffprobe", pathEnv: string): string[] {
  return [...explicitBinaryCandidates(name), ...pathBinaryCandidates(name, pathEnv)];
}

function explicitBinaryCandidates(name: "ffmpeg" | "ffprobe"): string[] {
  return [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/local/bin/${name}`,
  ];
}

function pathBinaryCandidates(name: "ffmpeg" | "ffprobe", pathEnv: string): string[] {
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => path.join(dir, name));
}

export function findFfmpeg(opts?: FindBinaryOptions): string | null {
  return findBinary("ffmpeg", opts);
}

export function findFfprobe(opts?: FindBinaryOptions): string | null {
  return findBinary("ffprobe", opts);
}

// ------------------------------------------------------------- real engines

/** `imp::probe`'s injectable seam — `probePath`'s default calls
 * {@link ffprobeEngine}; a test supplies a scripted one instead, exactly how
 * `previewTools.ts`'s `PreviewRenderFn` and `peaksTools.ts`'s decode seam
 * work. */
export type ProbeEngine = (filePath: string) => Promise<MediaMeta | null>;

function runFfprobe(ffprobePath: string, filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : null)
    );
  });
}

/**
 * The REAL, default {@link ProbeEngine} — `null` when this Mac has no
 * `ffprobe` (mirrors the Rust source's `#[cfg(not(target_os = "macos"))]`
 * arm: "there is nothing to probe with, and inventing fields would be worse
 * than saying so"), otherwise a real subprocess call whose JSON output
 * {@link parseFfprobeOutput} turns into a `MediaMeta`.
 */
export async function ffprobeEngine(filePath: string): Promise<MediaMeta | null> {
  const ffprobe = findFfprobe();
  if (ffprobe === null) return null;
  const stdout = await runFfprobe(ffprobe, filePath);
  return stdout === null ? null : parseFfprobeOutput(stdout);
}

/** `imp::last_frame`'s injectable seam. */
export type LastFrameEngine = (filePath: string) => Promise<Buffer | null>;

function runFfmpegToFile(ffmpegPath: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { maxBuffer: 32 * 1024 * 1024 }, (error) => resolve(error === null));
  });
}

/**
 * The REAL, default {@link LastFrameEngine}.
 *
 * MECHANISM SWAP from `AVAssetImageGenerator`'s CMTime-tolerance retry (an
 * exact zero-tolerance request at `duration - 1/30s`, then a lenient one):
 * `-sseof -3 -i <path> -update 1 -frames:v 1 <out.png>` seeks to 3s before
 * end-of-stream and lets the `image2` muxer's `-update 1` mode keep
 * overwriting ONE output file as it decodes forward, so whatever is on disk
 * when ffmpeg finishes IS the last frame it successfully decoded — the same
 * INTENT the Rust doc comment states ("the REAL final frame … Capturing the
 * frame the finished clip ACTUALLY ends on"), reached without needing this
 * engine's own exact-vs-keyframe tolerance concept at all. A clip shorter
 * than 3s seeks before its own start, which ffmpeg clamps to 0 — the same
 * `.max(0.0)` clamp Rust's own `at_secs` computation applies by hand.
 *
 * `null` when this Mac has no `ffmpeg`, the source is not decodable video
 * (garbage bytes, an unsupported codec), or ffmpeg produced nothing —
 * collapsing the same set of "no port" and "OS declined" outcomes the Rust
 * doc comment describes for its own `None` ("a codec AVFoundation does not
 * decode … the caller falls back to the drawn still").
 */
export async function ffmpegLastFrameEngine(filePath: string): Promise<Buffer | null> {
  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) return null;
  const outPath = path.join(os.tmpdir(), `arcelle-lastframe-${randomUUID()}.png`);
  try {
    const ok = await runFfmpegToFile(ffmpeg, [
      "-y",
      "-sseof",
      "-3",
      "-i",
      filePath,
      "-update",
      "1",
      "-frames:v",
      "1",
      outPath,
    ]);
    if (!ok) return null;
    const stat = await fsp.stat(outPath).catch(() => null);
    if (stat === null || stat.size === 0) return null;
    return await fsp.readFile(outPath);
  } finally {
    removeQuietly(outPath);
  }
}

// -------------------------------------------------------------- temp hygiene

/** `write_private`, ported verbatim (same convention `textUtil.ts`'s own
 * `writePrivate` already uses for the same reason): create the file
 * EXCLUSIVELY (`"wx"` — Rust's `create_new(true)`) and owner-only (`0o600`),
 * so a decrypted copy is never briefly world-readable between create and
 * chmod. Exported so the delete-on-every-exit-path guarantee can be tested
 * directly against the mechanism, same as `textUtil.ts`'s own note explains. */
export function writePrivate(filePath: string, bytes: Buffer): boolean {
  try {
    fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** `let _ = std::fs::remove_file(...)` — best-effort, never throws. A path
 * that was never created (a failed {@link writePrivate}) is not an error
 * here either. */
export function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort by design.
  }
}

// ------------------------------------------------------------------- public

/**
 * `probe_path` — a file already on disk, never copied. `null` = zero-byte or
 * unreadable (matches `std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
 * == 0`, which reads a missing file as size 0 exactly like a real empty one —
 * neither ever reaches the probing engine), or the engine had nothing to say.
 */
export async function probePath(
  filePath: string,
  engine: ProbeEngine = ffprobeEngine
): Promise<MediaMeta | null> {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  return engine(filePath);
}

/**
 * `probe_bytes` — bytes that live encrypted in the room. The temp copy keeps
 * `ext` because the probing engine dispatches on the file extension as well
 * as the container's own magic bytes, same as Rust's own comment: "an .mov
 * handed over as `.bin` reads as a different (or no) container."
 */
export async function probeBytes(
  bytes: Buffer,
  ext: string,
  engine: ProbeEngine = ffprobeEngine
): Promise<MediaMeta | null> {
  if (bytes.length === 0) return null;
  const stem = randomUUID();
  const file = path.join(
    os.tmpdir(),
    ext.length === 0 ? `arcelle-probe-${stem}` : `arcelle-probe-${stem}.${ext}`
  );
  if (!writePrivate(file, bytes)) {
    // A partial write (disk full mid-file) already created the file; remove
    // it unconditionally rather than only on the success path, matching the
    // Rust source's own comment on exactly this case.
    removeQuietly(file);
    return null;
  }
  try {
    return await engine(file);
  } finally {
    removeQuietly(file);
  }
}

/**
 * `last_frame_png` — the REAL final frame of a clip, as PNG bytes. Same
 * privacy bargain and temp-file shape as {@link probeBytes}; see
 * {@link ffmpegLastFrameEngine}'s doc for the mechanism this stands in for.
 */
export async function lastFramePng(
  bytes: Buffer,
  ext: string,
  engine: LastFrameEngine = ffmpegLastFrameEngine
): Promise<Buffer | null> {
  if (bytes.length === 0) return null;
  const stem = randomUUID();
  const file = path.join(
    os.tmpdir(),
    ext.length === 0 ? `arcelle-endframe-${stem}` : `arcelle-endframe-${stem}.${ext}`
  );
  if (!writePrivate(file, bytes)) {
    removeQuietly(file);
    return null;
  }
  try {
    return await engine(file);
  } finally {
    removeQuietly(file);
  }
}
