/** Cohesive extraction from recBridge.ts; its public API remains on that module. */
import { randomUUID, createDecipheriv } from "node:crypto";
import { open as openFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Readable } from "node:stream";

import { authToken, authedHeaders, busy, ensureUp } from "./sidecar.js";
import {
  deleteFile,
  getFileBytes,
  getFileFull,
  getFileMeta,
  getFileName,
  inTransaction,
  insertFile,
  setDerivedFrom,
  setFileExtractedText,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import {
  appendRecChunk,
  finalizeRecAudio,
  finalizeRecAudioHybrid,
  getRecMeta,
  recoverRecChunks,
  recoverRecChunksHybrid,
  setRecMeta,
} from "./db-host/recordings.js";
import {
  enrollVoice,
  forgetVoice,
  identityPrint,
  knownVoices,
  rejectVoice,
  savedVoices,
  type KnownVoice,
  type SavedVoice,
} from "./db-host/voices.js";
import {
  addCut,
  csOfSamples,
  cutShiftBefore,
  decodeWav,
  defaultRecMeta,
  displaySpeaker,
  encodeWav,
  formatStamp,
  insideCut,
  noteKindOf,
  segmentVisibleText,
  spliceOut,
  transcriptText,
  type RecCut,
  type RecMeta,
  type RecSegment,
  type RecWord,
  type VoicePrint,
} from "./recFormat.js";
import { stripThinkSpans } from "./engineRouting.js";
import * as obs from "./obs.js";
import type { OpenRoom } from "./turnEngine.js";

export type { FileMeta, KnownVoice, SavedVoice };
import { RecControlError, coerceRecMeta, parseRecMeta, postControl, requireLive } from "./recBridgeControl.js";
import { attachHostWs, closeLiveSession, encodeF32Base64 } from "./recBridgeMeta.js";
import { RecBridgeCtx, RecLiveControl, RecLiveStatus, RecStart, refuseWhileRetranscribing } from "./recBridgeState.js";
// =============================================================================
// ---- rec_start / pause / resume / stop / live_stt / live_translate ---------
// =============================================================================

/** Rust names a fresh recording from SQLite's own
 * `strftime('%Y-%m-%d %H.%M','now','localtime')`. Same local wall clock, same
 * format, as a pure function — so nothing outside `db-host/` reaches for a raw
 * `db.prepare`, and the name is testable without a room. */
export function recordingStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}`
  );
}

/**
 * Start recording — a brand-new recording file, or resuming an existing one
 * (its audio continues seamlessly; wall-clock gaps are not recorded).
 *
 * Nothing about the participants is asked or configured: the meeting's speakers
 * are discovered from their voices as they talk.
 *
 * The "a recording is already running" gate exists on BOTH sides on purpose.
 * The sidecar's `RecSessionManager` is the authority and answers 409
 * `REC_ALREADY_LIVE`; the local check in front of it is what preserves Rust's
 * two distinct sentences — a session that is SAVING cannot be "stopped first",
 * so telling the user to would be an instruction nobody can follow.
 */
export type RecStartOptions = {
  fileId?: string | null;
  systemAudio: boolean;
  liveTranslate?: string | null;
};

export type PreparedRecording = {
  fileId: string;
  name: string;
  meta: RecMeta;
  baseSamples: Float32Array;
  freshFileId: string | null;
};

export function recStartModel(ctx: RecBridgeCtx): string {
  const model = ctx.deps.resolveSttModel();
  if (model === null) throw new Error("STT_MODEL_MISSING");
  return model;
}

export function refuseExistingLiveRecording(ctx: RecBridgeCtx): void {
  const fileId = ctx.state.liveFileId;
  if (fileId === null) return;
  throw existingRecordingError(fileId, ctx.state.liveStatus);
}

export function existingRecordingError(
  fileId: string,
  status: RecLiveStatus | null,
): Error {
  if (status === "saving") {
    return new Error(
      `The last recording (file ${fileId}) is still being saved. ` +
        "It finishes on its own — start the next one in a moment.",
    );
  }
  return new Error(
    `A recording is already running (file ${fileId}). Stop it first.`,
  );
}

export function resumeRecordingId(opts: RecStartOptions): string | null {
  return opts.fileId == null || opts.fileId === "" ? null : opts.fileId;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function recordingRoom(ctx: RecBridgeCtx): OpenRoom {
  const room = ctx.deps.currentRoom();
  if (room === null) throw new Error("No room is open.");
  return room;
}

export function liveTranslation(opts: RecStartOptions): string | null {
  return opts.liveTranslate != null && opts.liveTranslate.trim() !== ""
    ? opts.liveTranslate
    : null;
}

export async function prepareRecording(
  db: Database.Database,
  room: OpenRoom,
  resumeId: string | null,
): Promise<PreparedRecording> {
  if (resumeId === null) return createFreshRecording(db, room);
  return resumeRecording(db, room, resumeId);
}

export async function resumeRecording(
  db: Database.Database,
  room: OpenRoom,
  fileId: string,
): Promise<PreparedRecording> {
  await recoverRecordingChunks(db, room);
  const [name, , storedBytes] = getFileFull(db, fileId);
  const meta = parseRecMeta(getRecMeta(db, fileId));
  const baseSamples = await resumeBaseSamples(room, fileId, storedBytes);
  return { fileId, name, meta, baseSamples, freshFileId: null };
}

export async function recoverRecordingChunks(
  db: Database.Database,
  room: OpenRoom,
): Promise<void> {
  try {
    if (room.workspace === undefined) recoverRecChunks(db);
    else await recoverRecChunksHybrid(db, room.workspace);
  } catch (err) {
    throw new Error(
      `This recording can't be continued yet. ${errMessage(err)}`,
    );
  }
}

export async function resumeBaseSamples(
  room: OpenRoom,
  fileId: string,
  storedBytes: Buffer | null,
): Promise<Float32Array> {
  try {
    const bytes =
      room.workspace === undefined
        ? storedBytes
        : await room.workspace.readBuffer(fileId);
    return decodeRecordingSamples(bytes);
  } catch (err) {
    throw new Error(`This file can't be continued: ${errMessage(err)}`);
  }
}

export function decodeRecordingSamples(bytes: Buffer | null): Float32Array {
  if (bytes === null || bytes.length === 0) return new Float32Array(0);
  return decodeWav(bytes);
}

export async function createFreshRecording(
  db: Database.Database,
  room: OpenRoom,
): Promise<PreparedRecording> {
  const name = `Recording ${recordingStamp()}.wav`;
  const meta = defaultRecMeta();
  const file = await createRecordingFile(db, room, name);
  setRecMeta(db, file.id, JSON.stringify(meta));
  return {
    fileId: file.id,
    name,
    meta,
    baseSamples: new Float32Array(0),
    freshFileId: file.id,
  };
}

export async function createRecordingFile(
  db: Database.Database,
  room: OpenRoom,
  name: string,
): Promise<FileMeta> {
  const emptyWav = encodeWav(new Float32Array(0));
  if (room.workspace === undefined) {
    return insertFile(
      db,
      name,
      "audio/wav",
      emptyWav,
      "(live recording)\n",
      "recording",
    );
  }
  const entry = await room.workspace.createFile(
    name,
    Readable.from([emptyWav]),
    "recording",
  );
  setFileExtractedText(db, entry.fileId, "(live recording)\n");
  db.prepare("UPDATE files SET mime_type = 'audio/wav' WHERE id = ?").run(
    entry.fileId,
  );
  return getFileMeta(db, entry.fileId);
}

export function knownRecordingVoices(db: Database.Database): KnownVoice[] {
  try {
    return knownVoices(db);
  } catch {
    return [];
  }
}

export function recordingDiarizePath(ctx: RecBridgeCtx): string | null {
  return ctx.deps.diarizeModelPath?.() ?? null;
}

export function warnWithoutDiarizeModel(fileId: string, diarize: string | null): void {
  if (diarize === null) {
    obs.warn("rec.start.no_diarize_model", [["file", obs.id(fileId)]]);
  }
}

export function encodedBaseSamples(baseSamples: Float32Array): string | null {
  return baseSamples.length > 0 ? encodeF32Base64(baseSamples) : null;
}

export function defaultLiveTranslationModel(ctx: RecBridgeCtx): string | null {
  return ctx.deps.defaultTranslationModel?.() ?? null;
}

export function addOllamaUrl(ctx: RecBridgeCtx, body: Record<string, unknown>): void {
  const ollama = ctx.deps.ollamaBaseUrl?.() ?? null;
  if (ollama !== null) body.baseUrl = ollama;
}

export function recStartBody(
  ctx: RecBridgeCtx,
  recording: PreparedRecording,
  model: string,
  opts: RecStartOptions,
  liveTranslate: string | null,
  known: KnownVoice[],
): Record<string, unknown> {
  const diarize = recordingDiarizePath(ctx);
  warnWithoutDiarizeModel(recording.fileId, diarize);
  const body: Record<string, unknown> = {
    fileId: recording.fileId,
    modelPath: model,
    baseSamples: encodedBaseSamples(recording.baseSamples),
    meta: recording.meta,
    systemAudio: opts.systemAudio,
    liveTranslate,
    knownVoices: known,
    diarizeModelPath: diarize,
    defaultTranslationModel: defaultLiveTranslationModel(ctx),
    spoolDir: ctx.deps.spoolDir(),
  };
  addOllamaUrl(ctx, body);
  return body;
}

export async function startRecordingControl(
  ctx: RecBridgeCtx,
  fileId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await postControl(ctx, "/rec/start", body);
  } catch (err) {
    if (!isStaleSpoolError(err)) throw err;
    await clearStaleRecordingSpool(ctx, fileId);
    return postControl(ctx, "/rec/start", body);
  }
}

export function isStaleSpoolError(err: unknown): boolean {
  return err instanceof RecControlError && err.code === "REC_SPOOL_EXISTS";
}

export async function clearStaleRecordingSpool(
  ctx: RecBridgeCtx,
  fileId: string,
): Promise<void> {
  assertSafeRecordingFileId(fileId);
  try {
    await unlink(path.join(ctx.deps.spoolDir(), `${fileId}.spool`));
  } catch (unlinkError) {
    if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `The previous recording session's temporary spool could not be cleared: ${errMessage(unlinkError)}`,
    );
  }
}

export function assertSafeRecordingFileId(fileId: string): void {
  if (fileId === "." || fileId === ".." || path.basename(fileId) !== fileId) {
    throw new Error("This recording has an invalid file id.");
  }
}

export async function startPreparedRecording(
  db: Database.Database,
  ctx: RecBridgeCtx,
  recording: PreparedRecording,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await startRecordingControl(ctx, recording.fileId, body);
  } catch (err) {
    discardFreshRecording(db, recording.freshFileId);
    throw err;
  }
}

export function discardFreshRecording(
  db: Database.Database,
  fileId: string | null,
): void {
  if (fileId === null) return;
  try {
    deleteFile(db, fileId);
  } catch {
    // Best-effort: an orphan row is better than losing the real start error.
  }
}

export function connectLiveRecording(
  ctx: RecBridgeCtx,
  room: OpenRoom,
  recording: PreparedRecording,
  response: Record<string, unknown>,
): void {
  ctx.state.liveFileId = recording.fileId;
  ctx.state.liveStatus = "recording";
  ctx.state.sessionRoomPath = room.path;
  ctx.state.spoolPath =
    typeof response.spoolPath === "string" ? response.spoolPath : null;
  ctx.state.spoolKey =
    typeof response.spoolKey === "string"
      ? Buffer.from(response.spoolKey, "base64")
      : null;
  ctx.state.lastMeta = recording.meta;
  ctx.state.hostWs = ctx.deps.connectHostWs(recording.fileId);
  attachHostWs(ctx, ctx.state.hostWs);
}

export async function recStart(
  db: Database.Database,
  ctx: RecBridgeCtx,
  opts: RecStartOptions,
): Promise<RecStart> {
  const model = recStartModel(ctx);
  refuseExistingLiveRecording(ctx);
  const resumeId = resumeRecordingId(opts);
  if (resumeId !== null) refuseWhileRetranscribing(resumeId);
  const room = recordingRoom(ctx);
  const recording = await prepareRecording(db, room, resumeId);
  const body = recStartBody(
    ctx,
    recording,
    model,
    opts,
    liveTranslation(opts),
    knownRecordingVoices(db),
  );
  const response = await startPreparedRecording(db, ctx, recording, body);
  connectLiveRecording(ctx, room, recording, response);
  ctx.deps.notifyFilesChanged?.();
  return {
    fileId: recording.fileId,
    name: recording.name,
    meta: recording.meta,
    sessionUrl: await ctx.deps.sessionWsUrl(recording.fileId),
  };
}

/**
 * Retired: mic audio no longer reaches the recording through Electron. Kept
 * exported and IPC-wired, matching `src/api.ts:1264`'s call shape, so a stale
 * caller fails with an instruction rather than with "no handler registered" —
 * see §5.
 */
export async function recPushAudio(
  _rate: number,
  _dataB64: string,
): Promise<never> {
  throw new Error(
    'Mic audio no longer reaches the recording through Electron: the renderer connects directly to "WS /rec/session" ' +
      "(electron-python-migration-plan-2026-08-22.md line 349). This IPC handler is retired and exists only so a " +
      "stale caller fails loudly instead of silently recording nothing.",
  );
}

export async function recPause(ctx: RecBridgeCtx): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/pause", { fileId });
  ctx.state.liveStatus = "paused";
}

export async function recResume(ctx: RecBridgeCtx): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/resume", { fileId });
  ctx.state.liveStatus = "recording";
}

/** Toggle live translation mid-recording (`null` turns it off). */
export async function recSetLiveTranslate(
  ctx: RecBridgeCtx,
  language: string | null,
): Promise<void> {
  const fileId = requireLive(ctx);
  const lang = language != null && language.trim() !== "" ? language : null;
  await postControl(ctx, "/rec/set_live_translate", { fileId, lang });
}

/** Toggle live transcription mid-recording. Off: the audio keeps recording but
 * no text is decoded. Session-scoped — nothing persists; every start begins ON. */
export async function recSetLiveStt(
  ctx: RecBridgeCtx,
  on: boolean,
): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/set_live_stt", { fileId, on });
}

/**
 * Stop and save. There is deliberately NO deadline: the work at the end of a
 * stop grows with the recording's length (a long meeting's speaker pass alone
 * runs for minutes), and the sidecar's own `/rec/stop` has none either for the
 * same reason.
 *
 * The session is released whatever the answer — the sidecar finalizes the
 * session before it replies, success or failure (`session_ws.py` §1), so the
 * slot is provably free either way and Electron must not keep believing a
 * recording is live once the sidecar has torn it down.
 */
export async function recStop(ctx: RecBridgeCtx): Promise<RecMeta> {
  const fileId = requireLive(ctx);
  ctx.state.liveStatus = "saving";
  let resp: Record<string, unknown>;
  try {
    resp = await postControl(ctx, "/rec/stop", { fileId });
  } finally {
    closeLiveSession(ctx);
  }
  return coerceRecMeta(resp.meta);
}

/** The live session, if any — lets a reopened view re-attach to a recording
 * that kept running while the user looked at other files. See
 * {@link RecLiveControl} for what this can and cannot honestly report. */
export async function recLiveStatus(
  ctx: RecBridgeCtx,
): Promise<RecLiveControl | null> {
  if (ctx.state.liveFileId === null) {
    return null;
  }
  const fileId = ctx.state.liveFileId;
  return {
    fileId,
    status: ctx.state.liveStatus ?? "recording",
    sessionUrl: await ctx.deps.sessionWsUrl(fileId),
  };
}
