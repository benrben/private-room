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
 *     future real AVFoundation/PyObjC bridge (`services/agent-sidecar/src/arcelle_sidecar/media/
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
 * lines ~360-472) were a THIRD, unrelated gap: a whole background worker-lane
 * subsystem (an mpsc channel draining into a dedicated OS thread) with no
 * Electron port anywhere in this tree. THAT GAP IS CLOSED — `ipc/registry.ts`
 * now supplies a real {@link EnqueueSttFn} that hands `job.id` to
 * `mediaTranscribeJob.ts`'s speaker-aware pass, so a clip cut out of a video
 * is transcribed like every other media file in the room instead of landing
 * permanently transcript-less. Rust's mpsc-channel-into-an-OS-thread is NOT
 * reproduced: that pass excludes a second rebuild of the SAME file and
 * nothing wider, so this seam is for the one clip a person just cut, never
 * for feeding work in bulk.
 *
 * The dep stays OPTIONAL, and that is not a leftover. Unlike the two gaps
 * above, this one is NOT the point of `video_trim` — the trim has already
 * fully succeeded (cut, staged, inserted) by the moment Rust calls
 * `enqueue_stt`, and Rust's own call cannot fail (its internal channel-send
 * failure is swallowed with `let _ =`). Making a real, successful trim throw
 * because a transcription side channel is missing would be strictly worse
 * than Rust's own behaviour, so {@link videoTrim} still calls it
 * best-effort, and a test (or any caller with no transcriber) still gets a
 * real clip with no queued job rather than a fabricated queue.
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
 * IPC IS WIRED. The go-ahead this doc used to be waiting on has been given:
 * `ipc/registry.ts` calls {@link registerVideoIpc} with a real `emit` and a
 * real {@link EnqueueSttFn}, under the exact three channel names
 * `renderer/api.ts`'s `probeVideoMeta`/`videoTrim`/`saveVideoFrame` already
 * `invoke()` — `probe_video_meta`, `video_trim`, `save_video_frame` — with the
 * exact same argument shapes (`{ id }`, `{ id, startSecs, endSecs }`,
 * `{ id, pngB64, atSecs }`), so nothing was renamed to connect them.
 *
 * WHAT {@link videoTrim} HANDS THE STT SEAM, and why each field is the one it
 * is (checked against the insert directly above the call):
 *   - `id`/`name` — the NEW clip's, from the `createRoomFile` result. The
 *     source video is never re-transcribed; the clip is the thing with no
 *     transcript.
 *   - `mime`/`ext` — the SOURCE's staged values, which is correct rather than
 *     lazy: the clip is stored under `staged.mime` verbatim, and
 *     {@link trimmedName} keeps the source's extension, so these describe the
 *     stored clip exactly. `takeMediaBytes` has already refused anything
 *     `mediaKind` does not call video, so an eligible pair is guaranteed.
 *   - `roomPath`/`epoch` — the pin captured before the cut, re-proved current
 *     by the by-hand room-pin recheck immediately above the insert. A consumer
 *     that defers work can compare them; the registry's consumer instead
 *     re-checks the live room itself inside the transcription pass.
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
import { MAX_IMPORT_BYTES, NO_ROOM_OPEN, ProbeVideoFn, decodeBase64Strict, frameName, isEmptyMediaMeta, isPng, probeBytes, probeVideoWithFfprobe, runAvconvert, trimmedName, validateSpan } from "./videoConversion.js";
export { MIN_TRIM_SECS, validateSpan, stampForName, splitName, trimmedName, frameName, describeConvertError, runAvconvert, probeVideoWithFfprobe } from "./videoConversion.js";
export type { ProbeVideoFn } from "./videoConversion.js";


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

/** `commands/files.rs`'s `JobMeta` — the queue entry the STT lane consumes.
 * Field names match the Rust struct's own, camelCased. Exported because the
 * caller that supplies {@link EnqueueSttFn} has to name this shape; see this
 * module's doc for which value each field carries for a trimmed clip. */
export interface JobMeta {
  id: string;
  name: string;
  mime: string;
  ext: string;
  roomPath: string;
  epoch: number;
}

/** `enqueue_stt(&app, job)`'s seam — see this module's doc. Optional: a
 * real trim must not fail just because this side channel is not wired up.
 *
 * Returns `void` deliberately, matching Rust's own fire-and-forget channel
 * send: the trim has already succeeded and does not wait for, or learn the
 * outcome of, the transcription. An implementation that starts async work
 * (the live one starts a whole transcription pass) therefore owns its own
 * failure reporting — `(job) => { void run(job).catch(report); }` satisfies
 * this type exactly, and a promise-returning function does too. */
export type EnqueueSttFn = (job: JobMeta) => void;

/** Injectable native conversion boundary used by focused behavior tests. */
export type ConvertVideoFn = (
  source: string,
  destination: string,
  startSecs: number,
  durationSecs: number,
) => Promise<void>;

/** Every optional native/side-effect dependency `video_trim` and
 * `save_video_frame` take, plus `probe_video_meta`'s own — bundled once so
 * {@link registerVideoIpc} can wire all three commands from one deps bag. */
export interface VideoIpcDeps {
  probe?: ProbeVideoFn;
  convert?: ConvertVideoFn;
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
  const cached = cachedMediaMeta(open, id);
  if (cached !== null) {
    return cached;
  }

  const staged = await takeMediaBytes(room, id);
  const probed = await probeBytes(staged.bytes, staged.ext, probe);
  if (probed === null) {
    return null;
  }
  cacheProbedMediaMeta(room, staged, id, probed);
  return probed;
}

function cachedMediaMeta(open: OpenRoom, id: string): MediaMeta | null {
  const cachedJson = getMediaMeta(open.db, id);
  return cachedJson === null ? null : parseCachedMediaMeta(cachedJson);
}

function roomStillMatches(room: RoomSource, staged: StagedVideoBytes, open: OpenRoom | null): boolean {
  return open !== null && open.path === staged.roomPath && room.roomEpoch() === staged.epoch;
}

function cacheProbedMediaMeta(
  room: RoomSource,
  staged: StagedVideoBytes,
  id: string,
  probed: MediaMeta
): void {
  // Best-effort write-back, matching Rust's `let _ = state.with_room(|room|
  // { if room.path == room_path && state.room_epoch() == epoch { ... } })` —
  // the room may have closed or rolled back while the probe ran.
  try {
    const after = room.currentRoom();
    if (after !== null && roomStillMatches(room, staged, after)) {
      setMediaMeta(after.db, id, JSON.stringify(probed));
    }
  } catch {
    // Swallowed deliberately — see doc above.
  }
}
import { assertTrimmedClipSize, cachedTrimDuration, enqueueTrimmedVideo, mediaMetaJson, parseCachedMediaMeta, performTrim, requirePinnedTrimRoom, saveTrimmedVideo, trimProbe } from "./videoTrimSupport.js";


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
  const knownDuration = cachedTrimDuration(room, id);
  const [start, end] = validateSpan(startSecs, endSecs, knownDuration);

  const newName = trimmedName(staged.name, start, end);
  const { clip, clipMeta } = await performTrim(
    staged.bytes,
    staged.ext,
    start,
    end,
    trimProbe(deps),
    deps.convert ?? runAvconvert,
  );
  assertTrimmedClipSize(clip);
  const metaJson = mediaMetaJson(clipMeta);

  // The room-pin recheck, done BY HAND — see this module's doc's
  // "ROOM-PIN DISCIPLINE" note. Unlike probe_video_meta's cache write-back,
  // this one is NOT best-effort: a mismatch here is a hard refusal, matching
  // Rust's own `return Err(...)` (not a `let _ =`).
  const open = requirePinnedTrimRoom(room, staged);
  const file = await saveTrimmedVideo(open, staged, newName, clip, metaJson);

  emitSafely(deps.emit, "room-files-changed", undefined);

  // Best-effort, matching Rust's own internal channel-send error swallowing
  // (`files.rs`'s `enqueue_stt`) — see this module's doc.
  enqueueTrimmedVideo(deps, file, staged);

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
 * LIVE: `ipc/registry.ts` calls this with a real `emit` and a real
 * {@link EnqueueSttFn}, so a trimmed clip is queued for transcription like
 * any other media file. `deps` stays optional so a test can drive the three
 * handlers with nothing injected.
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

export { MAX_IMPORT_BYTES, StagedVideoBytes, cachedMediaMeta, isEmptyMediaMeta, requireRoom, roomStillMatches };
