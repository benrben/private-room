import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MediaMeta } from "../shared/apiTypes.js";
import { availableName, setMediaMeta, type FileMeta } from "./db-host/files.js";
import { createRoomFile } from "./workspace/roomContent.js";
import { removeQuietly, writePrivate } from "./textUtil.js";
import type { OpenRoom } from "./turnEngine.js";
import { ConvertVideoFn, JobMeta, MAX_IMPORT_BYTES, ProbeVideoFn, RoomSource, StagedVideoBytes, VideoIpcDeps, cachedMediaMeta, isEmptyMediaMeta, probeVideoWithFfprobe, requireRoom, roomStillMatches } from "./videoTools.js";

export

/** One field's expected JSON type, per {@link MediaMeta}'s own declared
 * shape. */
type FieldKind = "number" | "string" | "boolean";
export interface CheckedField {
  ok: boolean;
  value: number | string | boolean | null;
}
export const fieldTypeMatches: Record<FieldKind, (value: unknown) => boolean> = {
  number: (value) => typeof value === "number",
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
};
export function isMissingField(o: Record<string, unknown>, key: string): boolean {
  return !(key in o) || o[key] === null || o[key] === undefined;
}
export

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
): CheckedField {
  if (isMissingField(o, key)) {
    return { ok: true, value: null };
  }
  const v = o[key];
  return fieldTypeMatches[kind](v) ? { ok: true, value: v as number | string | boolean } : { ok: false, value: null };
}
export interface MediaMetaFields {
  durationSecs: CheckedField;
  width: CheckedField;
  height: CheckedField;
  videoCodec: CheckedField;
  frameRate: CheckedField;
  bitrateKbps: CheckedField;
  hasAudio: CheckedField;
  audioCodec: CheckedField;
}
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseJsonObject(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function readMediaMetaFields(o: Record<string, unknown>): MediaMetaFields {
  return {
    durationSecs: readField(o, "durationSecs", "number"),
    width: readField(o, "width", "number"),
    height: readField(o, "height", "number"),
    videoCodec: readField(o, "videoCodec", "string"),
    frameRate: readField(o, "frameRate", "number"),
    bitrateKbps: readField(o, "bitrateKbps", "number"),
    hasAudio: readField(o, "hasAudio", "boolean"),
    audioCodec: readField(o, "audioCodec", "string"),
  };
}
export function hasInvalidMediaMetaField(fields: MediaMetaFields): boolean {
  return Object.values(fields).some((field) => !field.ok);
}
export function fieldValue<T>(field: CheckedField): T | null {
  return field.value as T | null;
}
export function mediaMetaFromFields(fields: MediaMetaFields): MediaMeta {
  return {
    durationSecs: fieldValue<number>(fields.durationSecs),
    width: fieldValue<number>(fields.width),
    height: fieldValue<number>(fields.height),
    videoCodec: fieldValue<string>(fields.videoCodec),
    frameRate: fieldValue<number>(fields.frameRate),
    bitrateKbps: fieldValue<number>(fields.bitrateKbps),
    hasAudio: fieldValue<boolean>(fields.hasAudio),
    audioCodec: fieldValue<string>(fields.audioCodec),
  };
}
export

/** `serde_json::from_str::<MediaMeta>(&json).ok()` — `null` for malformed
 * JSON, a non-object JSON value, or any field of the wrong declared type. */
function parseCachedMediaMeta(json: string): MediaMeta | null {
  const obj = parseJsonObject(json);
  if (obj === null) {
    return null;
  }
  const fields = readMediaMetaFields(obj);
  if (hasInvalidMediaMetaField(fields)) {
    return null;
  }
  return mediaMetaFromFields(fields);
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
export async function performTrim(
  bytes: Buffer,
  ext: string,
  start: number,
  end: number,
  probe: ProbeVideoFn,
  convert: ConvertVideoFn,
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
    await convert(srcPath, dstPath, start, end - start);

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
export function cachedTrimDuration(room: RoomSource, id: string): number | null {
  const cached = cachedMediaMeta(requireRoom(room), id);
  return cached?.durationSecs ?? null;
}
export function trimProbe(deps: VideoIpcDeps): ProbeVideoFn {
  return deps.probe ?? probeVideoWithFfprobe;
}
export function assertTrimmedClipSize(clip: Buffer): void {
  if (clip.length === 0) {
    throw new Error("The trim produced an empty file — nothing was saved.");
  }
  if (clip.length > MAX_IMPORT_BYTES) {
    throw new Error(
      `The trimmed clip is ${Math.floor(clip.length / (1024 * 1024))} MB — larger than the ` +
        `${Math.floor(MAX_IMPORT_BYTES / (1024 * 1024))} MB limit for a room file.`
    );
  }
}
export function mediaMetaJson(clipMeta: MediaMeta | null): string | null {
  return clipMeta === null || isEmptyMediaMeta(clipMeta) ? null : JSON.stringify(clipMeta);
}
export function requirePinnedTrimRoom(room: RoomSource, staged: StagedVideoBytes): OpenRoom {
  const open = room.currentRoom();
  if (open === null || !roomStillMatches(room, staged, open)) {
    throw new Error("The room changed while the video was being trimmed — nothing was saved.");
  }
  return open;
}
export async function saveTrimmedVideo(
  open: OpenRoom,
  staged: StagedVideoBytes,
  name: string,
  clip: Buffer,
  metaJson: string | null
): Promise<FileMeta> {
  const finalName = availableName(open.db, name);
  const file = await createRoomFile(open, finalName, staged.mime, clip, null, "generated");
  if (metaJson !== null) {
    setMediaMeta(open.db, file.id, metaJson);
  }
  return file;
}
export function trimmedJob(file: FileMeta, staged: StagedVideoBytes): JobMeta {
  return {
    id: file.id,
    name: file.name,
    mime: staged.mime,
    ext: staged.ext,
    roomPath: staged.roomPath,
    epoch: staged.epoch,
  };
}
export function enqueueTrimmedVideo(deps: VideoIpcDeps, file: FileMeta, staged: StagedVideoBytes): void {
  try {
    deps.enqueueStt?.(trimmedJob(file, staged));
  } catch {
    // Swallowed deliberately — see doc above.
  }
}
