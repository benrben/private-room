/**
 * Port of `src-tauri/src/commands/video.rs` (515 lines, read in full) — video
 * as a thing you can WORK ON, not only play: read what the container actually
 * says (`probe_video_meta`), cut a span out of it (`video_trim`), and keep a
 * still from it (`save_video_frame`).
 *
 * NOT MODEL TOOLS. Grepped `agent.rs` for `probe_video_meta`/`video_trim`/
 * `save_video_frame`: zero `exec_tool` arms. `lib.rs` registers all three in
 * its plain `invoke_handler` list only. The ONE video-shaped model tool this
 * app has, `view_media_frame`, is a completely different Rust function
 * (`agent.rs`, a clip frame-grab for the model to LOOK at) with its own
 * `execTool.ts` arm ALREADY ported and deliberately still `notImplemented(
 * "the AgentUi screen-driving bridge, downscale_png_b64/perceive_image, and
 * the video frame-grab path — Batch D")` — for a reason unrelated to this
 * file (it needs the UI screen-driving round-trip). Per rule 6, nothing here
 * changes that arm or adds a new one: this batch adds nothing to
 * `execTool.ts`.
 *
 * TWO EXTERNAL BINARIES, BOTH PORTED FOR REAL — verified by hand rather than
 * assumed, per this migration's "do NOT default to stubbing" rule:
 *
 *   - `run_avconvert` (the CUT) spawns `/usr/bin/avconvert`, a plain
 *     fixed-path CLI binary macOS ships on every machine — exactly the same
 *     shape as `textutil.rs`'s already-ported `/usr/bin/textutil` bridge
 *     (`textUtil.ts`), not a native-framework binding. Verified live on this
 *     dev Mac before writing a line of the port: `/usr/bin/avconvert --help`
 *     lists no info/probe mode (it converts media; it does not describe it),
 *     but DOES cut one — `avconvert -p PresetPassthrough -s <src> -o <dst>
 *     --start 1 --duration 2 --replace` against the same system wallpaper
 *     `.mov` `media_probe.rs`'s own test fixture uses produced a real,
 *     shorter clip. So the CUT is ported FOR REAL here via `node:child_process`,
 *     not stubbed — this file's tests spawn the real binary (skipped, not
 *     faked, when it or the fixture source is absent from the machine
 *     running them, same convention `textUtil.test.ts` already uses for its
 *     own real-binary tests).
 *   - `media_probe.rs`'s PROBE (duration, display size, codec, frame rate,
 *     audio track) is `objc2`/AVFoundation in Rust — `AVURLAsset`,
 *     `AVAssetTrack`, `CMFormatDescription` — which Node genuinely cannot
 *     bind to. It is NOT stubbed here regardless, because a real, different
 *     ENGINE for the same facts already exists in this tree:
 *     `mediaProbe.ts`'s {@link probePath}, a full port of `media_probe.rs`
 *     backed by `ffprobe` (found the same opportunistic Homebrew/MacPorts/
 *     PATH way `ytdlp.ts` already finds `ffmpeg` for YouTube merges — not
 *     bundled, used when present). {@link probeVideoWithFfprobe} is this
 *     file's default {@link ProbeVideoFn} and calls it directly, so
 *     {@link probeVideoMeta} and {@link videoTrim} read a real container's
 *     real facts today.
 *
 *     WHEN THIS MAC HAS NO `ffprobe`, that engine answers `null` — which is
 *     not a fabrication and not a hidden gap: it is exactly the `None` Rust's
 *     own `#[cfg(not(target_os = "macos"))]` arm returns for "there is
 *     nothing to probe with, and inventing fields would be worse than saying
 *     so", and exactly what its macOS arm returns for a file AVFoundation
 *     opens and learns nothing from. `probe_video_meta`'s whole contract is
 *     `Option<MediaMeta>`, and its Rust doc comment already names this
 *     outcome: "the viewer then shows the fields as unknown rather than
 *     inventing them." An earlier draft of this file defaulted the seam to a
 *     NOT_IMPLEMENTED rejection; that was wrong twice over — it contradicted
 *     `mediaProbe.ts`, which had already established (with passing end-to-end
 *     subprocess tests) that this IS reachable from Node, and it turned a
 *     Rust command that cannot fail into one that throws.
 *
 *     What DOES change engine is documented at length in `mediaProbe.ts`'s own
 *     "ENGINE SWAP" header — nearest-90° rotation instead of the exact
 *     transform matrix, a WAV's `pcm_s16le` instead of "Linear PCM", no
 *     format-level bitrate fallback. Those are that file's narrow, named
 *     fidelity losses, not this one's, and the seam stays injectable so a
 *     future real AVFoundation/PyObjC bridge (`sidecar/arcelle_sidecar/media/
 *     probe.py` is already written, and already wired to no HTTP route —
 *     checked: `server.py` has no `/probe` endpoint) can replace it without
 *     touching a caller.
 *
 * `video_trim`'s OWN use of `media_probe::probe_path` (on the just-cut clip,
 * to store its `media_meta`) is BEST-EFFORT, matching Rust exactly: an
 * `Option`, filtered through `.is_empty()`, silently dropped on `None` — the
 * trim never depended on it succeeding. {@link videoTrim} calls the same
 * injected `probe` there and swallows BOTH a `null` and a rejection (an
 * injected prober may throw where Rust's own could only answer `None`) to
 * "no metadata to store": a real, working cut must never fail because the
 * clip's own codec could not be read back afterwards.
 *
 * `enqueue_stt`/`JobMeta`/`OCR_TX`/`STT_TX`/`run_stt_job` (`commands/files.rs`
 * lines ~360-472) are a THIRD, unrelated gap: a whole background worker-lane
 * subsystem (an mpsc channel draining into a dedicated OS thread) that has NO
 * Electron port anywhere in this tree — confirmed by grep (only
 * `autoIndex.ts`'s own doc comment names `run_stt_job` in passing, as a
 * FUTURE caller of a `schedule_auto_index`-shaped hook, not a real
 * implementation). Unlike the two gaps above, this one is NOT the point of
 * `video_trim` — the trim has already fully succeeded (cut, staged, inserted)
 * by the moment Rust calls `enqueue_stt`, and Rust's own call cannot fail
 * (its internal channel-send failure is swallowed with `let _ =`). Making a
 * real, successful trim throw because a transcription-scheduling side
 * channel is not wired up would be strictly worse than Rust's own behaviour,
 * so {@link videoTrim} takes it as an OPTIONAL {@link EnqueueSttFn} dep,
 * called best-effort: with none supplied (the default), a trimmed clip lands
 * in the room but is not automatically queued for transcription — an honest,
 * narrow gap, not a fabricated queue.
 *
 * ROOM-PIN DISCIPLINE — `commands/video.rs` does NOT import `agent.rs`'s
 * `RoomPin` struct (checked by grep: zero hits in this file). It re-derives
 * the same "is the room open right now still the exact one this call started
 * in" check BY HAND at each of its two deferred-write sites
 * (`probe_video_meta`'s cache write-back, `video_trim`'s file insert),
 * comparing `room.path`/`state.room_epoch()` against the `(room_path, epoch)`
 * pair `take_media_bytes` captured before the async native work began. This
 * port does the same by hand — plain `roomPath`/`epoch` fields on
 * {@link StagedVideoBytes}, matching Rust's own tuple shape exactly, rather
 * than introducing a class this Rust file itself does not use.
 *
 * ROOM ACCESS mirrors `peaksTools.ts`'s/`previewTools.ts`'s own
 * {@link RoomSource}: an already-open `Database.Database`/path pair,
 * `turnEngine.ts`'s {@link OpenRoom}, resolved via `currentRoom()`. This file
 * additionally needs `roomEpoch()` (the two peers above do not: neither of
 * them defers a write across an `await`), so its own {@link RoomSource} is
 * one method wider.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts`/`recIpc.ts`/
 * `peaksTools.ts`/`previewTools.ts`: Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead. {@link registerVideoIpc} exists, ready to be
 * wired, under the exact three channel names `src/api.ts`'s
 * `probeVideoMeta`/`videoTrim`/`saveVideoFrame` already `invoke()` (checked
 * against that file) — `probe_video_meta`, `video_trim`, `save_video_frame` —
 * with the exact same argument shapes (`{ id }`, `{ id, startSecs, endSecs }`,
 * `{ id, pngB64, atSecs }`), so a future renderer/preload needs no rename.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { MediaMeta } from "../shared/apiTypes.js";
import {
  availableName,
  getFileName,
  getMediaMeta,
  insertFile,
  setMediaMeta,
  type FileMeta,
} from "./db-host/files.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";
import { extensionOf } from "./editMatchExtraction.js";
import { probePath } from "./mediaProbe.js";
import { mediaKind } from "./peaksTools.js";
import { clampChars } from "./textClamp.js";
import { removeQuietly, writePrivate } from "./textUtil.js";
import type { OpenRoom } from "./turnEngine.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------ constants

/** A clip shorter than this is not a cut, it is a mistake. Ported verbatim
 * from `video.rs`'s `MIN_TRIM_SECS`. */
export const MIN_TRIM_SECS = 0.1;

/** `commands/files.rs`'s own room-wide file-size ceiling (files.rs has no
 * Electron port yet in this tree — see this module's doc for the OCR/STT
 * lane gap, a different corner of that same unported file). Verbatim value;
 * a future `files.ts` port should absorb this copy rather than the reverse,
 * the same standing `peaksTools.ts` leaves for its own `mediaKind` copy. */
const MAX_IMPORT_BYTES = 1_000_000_000;

/** `AppState::with_room`'s own refusal, spelled the way every other port in
 * this tree already spells it. */
const NO_ROOM_OPEN = "No room is open.";

// -------------------------------------------------------------- pure helpers

/** Rust's `{:.1}` fixed-precision float format — one digit after the point.
 * Every value this module formats this way comes from a UI-supplied seconds
 * count or an already-probed duration, never a value near a half-ULP
 * rounding boundary, so `toFixed`'s rounding rule (vs. Rust's) never
 * disagrees for any input either side of this port actually produces. */
function fmt1(n: number): string {
  return n.toFixed(1);
}

/**
 * `[start, end)` must sit somewhere the cut means something. Ported verbatim
 * from `video.rs`'s `validate_span`; throws instead of returning
 * `Result<(f64, f64), String>`, this port's house style.
 *
 * An unknown `duration` (`null`) is NOT a reason to refuse — it only removes
 * the upper bound; a tail that overruns a KNOWN duration is clamped rather
 * than refused (the "drag to the end" case), because the user's intent there
 * is unambiguous.
 */
export function validateSpan(
  start: number,
  end: number,
  duration: number | null
): [number, number] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("The trim points aren't real numbers.");
  }
  if (start < 0) {
    throw new Error("A trim can't start before the beginning of the video.");
  }
  if (end - start < MIN_TRIM_SECS) {
    throw new Error(
      `That span is too short to trim — the end has to be at least ${MIN_TRIM_SECS}s after the start.`
    );
  }
  if (duration !== null) {
    if (start >= duration) {
      throw new Error(
        `The trim starts at ${fmt1(start)}s but the video is only ${fmt1(duration)}s long.`
      );
    }
    return [start, Math.min(end, duration)];
  }
  return [start, end];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Seconds → the "1-23" form used inside a file name (colons are legal in a
 * room name but read as a Finder path separator on export). Ported verbatim
 * from `video.rs`'s `stamp_for_name`. */
export function stampForName(secs: number): string {
  const s = Math.round(Math.max(secs, 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}-${pad2(m)}-${pad2(sec)}`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}-${pad2(sec)}`;
}

/**
 * A file name split into (stem, extension), KEEPING the extension's own
 * case. NOT `editMatchExtraction.ts`'s `extensionOf`: that lowercases, and
 * stripping a lowercased suffix off the real name silently fails to match a
 * camera's `IMG_0042.MOV` — the bug this module's own Rust doc comment
 * names by the exact garbled name it used to produce. Ported verbatim from
 * `video.rs`'s `split_name`.
 */
export function splitName(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  // A leading dot (idx === 0) is not an extension — ".hidden" is the whole
  // name — and a trailing dot (idx === name.length - 1) leaves no extension
  // either; `rsplit_once` requires both halves non-empty.
  if (idx > 0 && idx < name.length - 1) {
    return [name.slice(0, idx), name.slice(idx + 1)];
  }
  return [name, ""];
}

/** `talk.mp4` + 7.3s-19.0s -> `talk (trim 0-07 to 0-19).mp4`. Ported
 * verbatim from `video.rs`'s `trimmed_name`. */
export function trimmedName(name: string, start: number, end: number): string {
  const [stem, ext] = splitName(name);
  const a = stampForName(start);
  const b = stampForName(end);
  return ext === "" ? `${stem} (trim ${a} to ${b})` : `${stem} (trim ${a} to ${b}).${ext}`;
}

/** `talk.mp4` at 83.4s -> `talk @ 1-23.png`. Ported verbatim from
 * `video.rs`'s `frame_name`. */
export function frameName(name: string, secs: number): string {
  const [stem] = splitName(name);
  return `${stem} @ ${stampForName(secs)}.png`;
}

/** What went wrong with the cut, said in a sentence. Ported verbatim from
 * `video.rs`'s `describe_convert_error`. */
export function describeConvertError(err: string): string {
  if (err.includes("NotFound") || err.includes("No such file or directory")) {
    return "This Mac has no /usr/bin/avconvert, which is the tool that cuts video here — " +
      "nothing was trimmed.";
  }
  return `The video couldn't be trimmed: ${err}`;
}

/** `MediaMeta::is_empty()` (`meta == MediaMeta::default()`) — every field
 * independently unknown. Ported verbatim from `media_probe.rs`. */
function isEmptyMediaMeta(m: MediaMeta): boolean {
  return (
    m.durationSecs === null &&
    m.width === null &&
    m.height === null &&
    m.videoCodec === null &&
    m.frameRate === null &&
    m.bitrateKbps === null &&
    m.hasAudio === null &&
    m.audioCodec === null
  );
}

// -------------------------------------------------------------- base64/png

/** `base64::engine::general_purpose::STANDARD.decode` — strict: standard
 * alphabet, canonical padding, no whitespace. A FOURTH local copy of the
 * same strict decoder `chatCmds.ts`/`externalAdvisor.ts`/`skillsCmds.ts`
 * each already carry — see `chatCmds.ts`'s module doc for why Node's own
 * lenient `Buffer.from(s, "base64")` used alone is unsafe here (it never
 * throws, which would turn a corrupt paste into a corrupt file silently
 * written into the room). */
function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, "base64");
}

/** The 8-byte PNG signature. `png.starts_with(b"\x89PNG\r\n\x1a\n")`. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

// ---------------------------------------------------------- real: avconvert

/** One attempt with one preset. */
interface AvconvertAttempt {
  success: boolean;
  stderrText: string;
  statusText: string;
}

function spawnFailureText(err: NodeJS.ErrnoException): string {
  // Node's spawn-level failure carries a STRING `code` ("ENOENT", …), unlike
  // a completed-but-nonzero exit (a NUMBER `code`) — see `runOnePreset`. This
  // mirrors what Rust's own `io::Error` Debug-prints for the same failure
  // (`Os { code: 2, kind: NotFound, message: "No such file or directory" }`)
  // closely enough for `describeConvertError`'s substring check to fire.
  if (err.code === "ENOENT") {
    return "No such file or directory (os error 2)";
  }
  return err.message ?? String(err.code ?? "spawn failed");
}

/**
 * Run `/usr/bin/avconvert` once with `preset`. Resolves `{success: true}`
 * only on a clean exit (the caller still checks `dst` really exists, exactly
 * as `run_avconvert` does); resolves `{success: false, …}` with whatever
 * stderr/status came back for a completed-but-failed run; THROWS only for a
 * spawn-level failure (the binary itself could not be found/run) — mirroring
 * Rust's `Command::output()`'s own split between "the OS could not even run
 * this" (`io::Error`, the `?` after `.output()`) and "it ran and told us it
 * failed" (`Output` with a non-success `status`).
 */
async function runOnePreset(
  preset: string,
  src: string,
  dst: string,
  start: number,
  dur: number
): Promise<AvconvertAttempt> {
  const args = [
    "-p",
    preset,
    "-s",
    src,
    "-o",
    dst,
    "--start",
    String(start),
    "--duration",
    String(dur),
    "--replace",
  ];
  try {
    await execFileAsync("/usr/bin/avconvert", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, stderrText: "", statusText: "exit code: 0" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stderr?: string;
      signal?: NodeJS.Signals | null;
    };
    if (typeof err.code === "string") {
      throw new Error(describeConvertError(spawnFailureText(err)));
    }
    const stderrText = typeof err.stderr === "string" ? err.stderr : "";
    const statusText =
      typeof err.code === "number"
        ? `exit code: ${err.code}`
        : err.signal
          ? `signal: ${err.signal}`
          : "unknown exit";
    return { success: false, stderrText, statusText };
  }
}

/**
 * Cut `[start, start+dur)` out of `src` into `dst` with the OS's own
 * converter. `PresetPassthrough` copies the encoded samples (no re-encode,
 * no generation loss); a container it refuses falls back to a real
 * re-encode (`PresetHighestQuality`). Ported verbatim from `video.rs`'s
 * `run_avconvert` — a REAL subprocess port, not a stub; see this module's
 * doc for why.
 *
 * Throws {@link describeConvertError}'s message on failure — including
 * IMMEDIATELY on a spawn-level failure (never tries the second preset),
 * mirroring Rust's own `?` after `.output()`.
 */
export async function runAvconvert(
  src: string,
  dst: string,
  start: number,
  dur: number
): Promise<void> {
  let last = "";
  for (const preset of ["PresetPassthrough", "PresetHighestQuality"]) {
    const attempt = await runOnePreset(preset, src, dst, start, dur);
    if (attempt.success && fs.existsSync(dst)) {
      return;
    }
    last = clampChars(attempt.stderrText, 300).trim();
    if (last === "") {
      last = `${preset} exited with ${attempt.statusText}`;
    }
  }
  throw new Error(describeConvertError(last));
}

// -------------------------------------------------------- real: media_probe

/** `media_probe::probe_path(path) -> Option<MediaMeta>` — the injectable
 * engine seam. Defaults to {@link probeVideoWithFfprobe}, a REAL read; kept
 * injectable so a future AVFoundation/PyObjC bridge can replace the engine
 * without touching a caller. See this module's doc. */
export type ProbeVideoFn = (path: string) => Promise<MediaMeta | null>;

/**
 * The REAL default {@link ProbeVideoFn}: `mediaProbe.ts`'s {@link probePath},
 * this migration's full port of `media_probe.rs` over `ffprobe`.
 *
 * Written as a named wrapper rather than passing `probePath` itself, so this
 * file's default never silently acquires `probePath`'s SECOND parameter (its
 * own injectable `ProbeEngine`) — `ProbeVideoFn` is one argument by contract,
 * and a two-argument default would let a caller's stray second argument reach
 * a seam it knows nothing about.
 *
 * `null` for a file no engine could read — including a Mac with no `ffprobe`
 * installed — which is `media_probe.rs`'s own `None`, not a swallowed error.
 */
export const probeVideoWithFfprobe: ProbeVideoFn = (p) => probePath(p);

/**
 * Stage `bytes` to an owner-only temp file (AVFoundation dispatches on the
 * file EXTENSION as well as the container's own magic, so the temp copy
 * keeps it, and so does `ffprobe`), probe it, and remove the temp file on
 * every exit path — success, `probe` resolving `null`, or `probe` throwing.
 * Ported verbatim from `media_probe.rs`'s `probe_bytes`, with the engine read
 * taken as the injected `probe` (see this module's doc).
 *
 * A rejection from `probe` PROPAGATES. The real default never rejects (it is
 * `Option`-shaped end to end, like Rust's own `probe_bytes`), so this only
 * concerns an INJECTED prober; letting it through rather than folding it into
 * `null` keeps "this engine failed" distinguishable from "this engine looked
 * and found nothing."
 */
async function probeBytes(
  bytes: Buffer,
  ext: string,
  probe: ProbeVideoFn
): Promise<MediaMeta | null> {
  if (bytes.length === 0) {
    return null;
  }
  const stem = randomUUID();
  const file = path.join(
    os.tmpdir(),
    ext === "" ? `arcelle-probe-${stem}` : `arcelle-probe-${stem}.${ext}`
  );
  try {
    if (!writePrivate(file, bytes)) {
      return null;
    }
    return await probe(file);
  } finally {
    removeQuietly(file);
  }
}

// -------------------------------------------------------------- room access

/** The slice of the (not-yet-ported) `AppState` this file's commands need:
 * whichever room is open RIGHT NOW, plus the epoch counter used to detect a
 * room swapped out from under an in-flight async trim/probe. See this
 * module's doc's "ROOM-PIN DISCIPLINE" note for why this is one method wider
 * than `peaksTools.ts`'s/`previewTools.ts`'s own `RoomSource`. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
  /** `state.room_epoch()` — bumped by every room open/teardown. */
  roomEpoch(): number;
}

function requireRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}

/** `take_media_bytes`'s own return tuple, as a named shape. */
interface StagedVideoBytes {
  name: string;
  mime: string;
  ext: string;
  bytes: Buffer;
  roomPath: string;
  epoch: number;
}

/**
 * Read one video's bytes out of the room. Ported verbatim from `video.rs`'s
 * `take_media_bytes` — including its two error messages, and its epoch
 * capture BEFORE the DB read (matching the Rust source's own read order:
 * `state.room_epoch()`, then the file row).
 */
async function takeMediaBytes(room: RoomSource, id: string): Promise<StagedVideoBytes> {
  // Epoch read BEFORE the room-open check, mirroring Rust's own order
  // (`let epoch = state.room_epoch();` precedes `state.with_room(...)`,
  // which is what can fail with "No room is open.").
  const epoch = room.roomEpoch();
  const open = requireRoom(room);
  const file = await readRoomFile(open, id);
  const { name, bytes: bytesRaw } = file;
  const mimeRaw = file.mimeType;
  const mime = mimeRaw ?? "";
  const ext = extensionOf(name);
  if (mediaKind(mime, ext) !== "video") {
    throw new Error("This file isn't a video.");
  }
  const bytes = bytesRaw ?? Buffer.alloc(0);
  if (bytes.length === 0) {
    throw new Error("This video has no stored bytes.");
  }
  return { name, mime, ext, bytes, roomPath: open.path, epoch };
}

// ---------------------------------------------------------------- emit/stt

/** `let _ = window.emit(...)` — a best-effort UI notification that must
 * never turn a successful call into a failed one. Same contract as
 * `organizeTools.ts`'s/`fileTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/** `commands/files.rs`'s `JobMeta` — see this module's doc for why the
 * OCR/STT worker-lane subsystem it belongs to has no port here yet. Field
 * names match the Rust struct's own, camelCased. */
export interface JobMeta {
  id: string;
  name: string;
  mime: string;
  ext: string;
  roomPath: string;
  epoch: number;
}

/** `enqueue_stt(&app, job)`'s seam — see this module's doc. Optional: a
 * real trim must not fail just because this side channel is not wired up. */
export type EnqueueSttFn = (job: JobMeta) => void;

/** Every optional native/side-effect dependency `video_trim` and
 * `save_video_frame` take, plus `probe_video_meta`'s own — bundled once so
 * {@link registerVideoIpc} can wire all three commands from one deps bag. */
export interface VideoIpcDeps {
  probe?: ProbeVideoFn;
  emit?: EmitFn;
  enqueueStt?: EnqueueSttFn;
}

// ------------------------------------------------------------------ probe

/**
 * Port of `commands::probe_video_meta`. Reads (and caches) what a video's
 * container actually says. `null` means the OS would not open it as media,
 * or opened it and could say nothing — a real answer, not an error, per the
 * Rust doc comment.
 *
 * A stored `media_meta` value this port can no longer parse (malformed JSON,
 * or a field of the wrong JSON type — the shape `serde_json::from_str`
 * itself would refuse) is not treated as an answer: it falls through and
 * probes again, exactly as the Rust source's own comment says.
 *
 * On a cache MISS the file's bytes are staged to a private temp file and
 * handed to `probe` — {@link probeVideoWithFfprobe} by default, a real read.
 */
export async function probeVideoMeta(
  room: RoomSource,
  id: string,
  probe: ProbeVideoFn = probeVideoWithFfprobe
): Promise<MediaMeta | null> {
  const open = requireRoom(room);
  const cachedJson = getMediaMeta(open.db, id);
  if (cachedJson !== null) {
    const cached = parseCachedMediaMeta(cachedJson);
    if (cached !== null) {
      return cached;
    }
  }

  const staged = await takeMediaBytes(room, id);
  const probed = await probeBytes(staged.bytes, staged.ext, probe);
  if (probed === null) {
    return null;
  }
  const json = JSON.stringify(probed);
  // Best-effort write-back, matching Rust's `let _ = state.with_room(|room|
  // { if room.path == room_path && state.room_epoch() == epoch { ... } })` —
  // the room may have closed or rolled back while the probe ran.
  try {
    const after = room.currentRoom();
    if (after !== null && after.path === staged.roomPath && room.roomEpoch() === staged.epoch) {
      setMediaMeta(after.db, id, json);
    }
  } catch {
    // Swallowed deliberately — see doc above.
  }
  return probed;
}

/** One field's expected JSON type, per {@link MediaMeta}'s own declared
 * shape. */
type FieldKind = "number" | "string" | "boolean";

/** A present-and-correctly-typed field reads as its value (`null` counts as
 * present and correct — every `MediaMeta` field is optional); a present
 * field of the WRONG type fails the whole parse, mirroring what
 * `serde_json::from_str::<MediaMeta>` would refuse; an ABSENT field reads as
 * `null`, mirroring serde's own default treatment of a missing `Option<T>`
 * field. */
function readField(
  o: Record<string, unknown>,
  key: string,
  kind: FieldKind
): { ok: true; value: number | string | boolean | null } | { ok: false } {
  if (!(key in o) || o[key] === null || o[key] === undefined) {
    return { ok: true, value: null };
  }
  const v = o[key];
  if (kind === "number" && typeof v === "number") return { ok: true, value: v };
  if (kind === "string" && typeof v === "string") return { ok: true, value: v };
  if (kind === "boolean" && typeof v === "boolean") return { ok: true, value: v };
  return { ok: false };
}

/** `serde_json::from_str::<MediaMeta>(&json).ok()` — `null` for malformed
 * JSON, a non-object JSON value, or any field of the wrong declared type. */
function parseCachedMediaMeta(json: string): MediaMeta | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const o = obj as Record<string, unknown>;
  const durationSecs = readField(o, "durationSecs", "number");
  const width = readField(o, "width", "number");
  const height = readField(o, "height", "number");
  const videoCodec = readField(o, "videoCodec", "string");
  const frameRate = readField(o, "frameRate", "number");
  const bitrateKbps = readField(o, "bitrateKbps", "number");
  const hasAudio = readField(o, "hasAudio", "boolean");
  const audioCodec = readField(o, "audioCodec", "string");
  if (
    !durationSecs.ok ||
    !width.ok ||
    !height.ok ||
    !videoCodec.ok ||
    !frameRate.ok ||
    !bitrateKbps.ok ||
    !hasAudio.ok ||
    !audioCodec.ok
  ) {
    return null;
  }
  return {
    durationSecs: durationSecs.value as number | null,
    width: width.value as number | null,
    height: height.value as number | null,
    videoCodec: videoCodec.value as string | null,
    frameRate: frameRate.value as number | null,
    bitrateKbps: bitrateKbps.value as number | null,
    hasAudio: hasAudio.value as boolean | null,
    audioCodec: audioCodec.value as string | null,
  };
}

// ------------------------------------------------------------------- trim

/** `run_avconvert` + `media_probe::probe_path` under one temp-file lifetime,
 * exactly `video_trim`'s own `spawn_blocking` closure. Ported verbatim,
 * including the "the source AND the result may not outlive the call as
 * plaintext" guarantee (`finally` removes both on EVERY exit path — a
 * staging failure, a failed cut, a failed read-back, or a thrown `probe`
 * rejection all clean up the same way).
 *
 * DEVIATION, same one `previewTools.ts`/`peaksTools.ts` document for their
 * own injected native seam: Rust's outer `.map_err(|e| format!("The trim
 * could not be started: {e}"))` wraps only a `spawn_blocking` JOIN failure
 * (the blocking task PANICKED) — a layer with no JS analogue. This function's
 * own thrown errors (a staging failure, {@link runAvconvert}'s own message,
 * or a failed read-back) are left UNWRAPPED end to end; {@link videoTrim}
 * does not re-wrap them either. */
async function performTrim(
  bytes: Buffer,
  ext: string,
  start: number,
  end: number,
  probe: ProbeVideoFn
): Promise<{ clip: Buffer; clipMeta: MediaMeta | null }> {
  const stamp = randomUUID();
  const suffix = ext === "" ? "mp4" : ext;
  const srcPath = path.join(os.tmpdir(), `arcelle-trim-in-${stamp}.${suffix}`);
  const dstPath = path.join(os.tmpdir(), `arcelle-trim-out-${stamp}.${suffix}`);
  try {
    if (!writePrivate(srcPath, bytes)) {
      throw new Error("The video couldn't be staged: the temp file could not be created.");
    }
    // A failed cut propagates straight through — `probe_path`/`fs.read` are
    // never reached, exactly like Rust's `run_avconvert(...).and_then(...)`.
    await runAvconvert(srcPath, dstPath, start, end - start);

    // Best-effort, matching Rust's own `Option`-returning `probe_path`:
    // neither a `null` nor a rejection from an INJECTED prober may fail a
    // real, successful cut.
    let clipMeta: MediaMeta | null = null;
    try {
      clipMeta = await probe(dstPath);
    } catch {
      clipMeta = null;
    }

    let clip: Buffer;
    try {
      clip = await fsp.readFile(dstPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`The trimmed video couldn't be read back: ${message}`);
    }
    return { clip, clipMeta };
  } finally {
    removeQuietly(srcPath);
    removeQuietly(dstPath);
  }
}

/**
 * Port of `commands::video_trim`. Cut `[startSecs, endSecs)` out of a video
 * into a NEW room file — the original is never touched.
 *
 * The clip carries NO transcript of its own (the parent's `[m:ss]` stamps
 * would all be off by `startSecs`) and gets no `recordings` row (that marks
 * a LIVE recording, and an MP4 with one opens in the recording studio and is
 * parsed as a WAV) — this port matches by simply never writing either.
 */
export async function videoTrim(
  room: RoomSource,
  id: string,
  startSecs: number,
  endSecs: number,
  deps: VideoIpcDeps = {}
): Promise<FileMeta> {
  const staged = await takeMediaBytes(room, id);
  const cachedJson = getMediaMeta(requireRoom(room).db, id);
  const knownDuration = cachedJson !== null ? parseCachedMediaMeta(cachedJson)?.durationSecs ?? null : null;
  const [start, end] = validateSpan(startSecs, endSecs, knownDuration);

  const newName = trimmedName(staged.name, start, end);
  const { clip, clipMeta } = await performTrim(
    staged.bytes,
    staged.ext,
    start,
    end,
    deps.probe ?? probeVideoWithFfprobe
  );

  if (clip.length === 0) {
    throw new Error("The trim produced an empty file — nothing was saved.");
  }
  if (clip.length > MAX_IMPORT_BYTES) {
    throw new Error(
      `The trimmed clip is ${Math.floor(clip.length / (1024 * 1024))} MB — larger than the ` +
        `${Math.floor(MAX_IMPORT_BYTES / (1024 * 1024))} MB limit for a room file.`
    );
  }

  const metaJson =
    clipMeta !== null && !isEmptyMediaMeta(clipMeta) ? JSON.stringify(clipMeta) : null;

  // The room-pin recheck, done BY HAND — see this module's doc's
  // "ROOM-PIN DISCIPLINE" note. Unlike probe_video_meta's cache write-back,
  // this one is NOT best-effort: a mismatch here is a hard refusal, matching
  // Rust's own `return Err(...)` (not a `let _ =`).
  const open = room.currentRoom();
  if (open === null || open.path !== staged.roomPath || room.roomEpoch() !== staged.epoch) {
    throw new Error("The room changed while the video was being trimmed — nothing was saved.");
  }

  // Several trims of one video are normal; disambiguate.
  const finalName = availableName(open.db, newName);
  const file = await createRoomFile(open, finalName, staged.mime, clip, null, "generated");
  if (metaJson !== null) {
    setMediaMeta(open.db, file.id, metaJson);
  }

  emitSafely(deps.emit, "room-files-changed", undefined);

  // Best-effort, matching Rust's own internal channel-send error swallowing
  // (`files.rs`'s `enqueue_stt`) — see this module's doc.
  try {
    deps.enqueueStt?.({
      id: file.id,
      name: file.name,
      mime: staged.mime,
      ext: staged.ext,
      roomPath: staged.roomPath,
      epoch: staged.epoch,
    });
  } catch {
    // Swallowed deliberately — see doc above.
  }

  return file;
}

// ---------------------------------------------------------------- still

/**
 * Port of `commands::save_video_frame`. Keep one frame of a video as a PNG
 * file in the room. The pixels come from the viewer (a canvas draw off the
 * `roommedia://` stream) — this end only stores them, and checks the
 * payload really is a PNG first.
 *
 * Synchronous, matching Rust's own `pub fn` (not `pub async fn`): base64
 * decode, a magic-byte check, and one DB insert — no native call, no
 * subprocess, no `await` anywhere in the Rust source either.
 */
export function saveVideoFrame(
  room: RoomSource,
  id: string,
  pngB64: string,
  atSecs: number,
  emit?: EmitFn
): FileMeta {
  const png = decodeBase64Strict(pngB64.trim());
  if (png === null) {
    throw new Error("That frame didn't arrive as valid image data — nothing was saved.");
  }
  if (!isPng(png)) {
    throw new Error("That frame didn't arrive as a PNG — nothing was saved.");
  }
  const open = requireRoom(room);
  const name = getFileName(open.db, id);
  const still = availableName(open.db, frameName(name, atSecs));
  const file = insertFile(open.db, still, "image/png", png, null, "generated");
  emitSafely(emit, "room-files-changed", undefined);
  return file;
}

export async function saveVideoFrameInRoom(
  room: RoomSource,
  id: string,
  pngB64: string,
  atSecs: number,
  emit?: EmitFn,
): Promise<FileMeta> {
  const png = decodeBase64Strict(pngB64.trim());
  if (png === null) throw new Error("That frame didn't arrive as valid image data — nothing was saved.");
  if (!isPng(png)) throw new Error("That frame didn't arrive as a PNG — nothing was saved.");
  const open = requireRoom(room);
  const name = getFileName(open.db, id);
  const still = availableName(open.db, frameName(name, atSecs));
  const file = await createRoomFile(open, still, "image/png", png, null, "generated");
  emitSafely(emit, "room-files-changed", undefined);
  return file;
}

// -------------------------------------------------------------------- IPC

/**
 * Registers {@link probeVideoMeta}/{@link videoTrim}/{@link saveVideoFrame}
 * on the exact three Tauri command names `src/api.ts` already `invoke()`s
 * (`probe_video_meta`, `video_trim`, `save_video_frame`) with the exact same
 * argument shapes, so a future renderer/preload needs no rename. `ipcMain`
 * is accepted as a parameter, typed against the real `electron` module
 * without importing it at runtime, matching `registerPeaksIpc`/
 * `registerPreviewIpc`.
 *
 * Exported and directly testable, but — same as those two — NOT called from
 * any live main-process entrypoint by this batch. Wiring it in is Phase 2
 * work pending an explicit owner go-ahead.
 */
export function registerVideoIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  deps: VideoIpcDeps = {}
): void {
  ipcMain.handle(
    "probe_video_meta",
    (_event: IpcMainInvokeEvent, args: { id: string }) => probeVideoMeta(room, args.id, deps.probe)
  );
  ipcMain.handle(
    "video_trim",
    (_event: IpcMainInvokeEvent, args: { id: string; startSecs: number; endSecs: number }) =>
      videoTrim(room, args.id, args.startSecs, args.endSecs, deps)
  );
  ipcMain.handle(
    "save_video_frame",
    (_event: IpcMainInvokeEvent, args: { id: string; pngB64: string; atSecs: number }) =>
      saveVideoFrameInRoom(room, args.id, args.pngB64, args.atSecs, deps.emit)
  );
}
