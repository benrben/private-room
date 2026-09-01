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
import { HostWsLike, RecBridgeCtx, RecBridgeState } from "./recBridgeState.js";
// =============================================================================
// ---- the spool file (session_ws.py §5) --------------------------------------
// =============================================================================

export const GCM_NONCE_LEN = 12;
export const GCM_TAG_LEN = 16;

/**
 * Decrypt one on-disk spool frame — the mirror of `SpoolWriter.append`'s shape:
 *
 *     4 bytes   little-endian uint32: length of everything that follows
 *     12 bytes  this frame's own random nonce
 *     N bytes   AES-256-GCM ciphertext + its 16-byte tag
 *
 * (Python's `AESGCM.encrypt` appends the tag; Node's `crypto` wants it split out
 * via `setAuthTag`, so it is sliced off the end here.)
 *
 * The declared length is cross-checked against what was actually read: a
 * `spoolRange` that is off by even one byte then fails loudly here instead of
 * feeding GCM a shifted window, and a short read (a truncated spool from a
 * hard-killed sidecar) cannot be decrypted as though it were whole.
 */
export function decryptSpoolFrame(frame: Buffer, key: Buffer): Buffer {
  if (frame.length < 4) {
    throw new Error("Spool frame is shorter than its own length prefix.");
  }
  const declared = frame.readUInt32LE(0);
  const rest = frame.subarray(4);
  if (rest.length !== declared) {
    throw new Error(
      `Spool frame length mismatch: declared ${declared}, read ${rest.length}.`,
    );
  }
  if (rest.length < GCM_NONCE_LEN + GCM_TAG_LEN) {
    throw new Error(
      "Spool frame is too short to contain a nonce and an auth tag.",
    );
  }
  const nonce = rest.subarray(0, GCM_NONCE_LEN);
  const body = rest.subarray(GCM_NONCE_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(body.length - GCM_TAG_LEN));
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - GCM_TAG_LEN)),
    decipher.final(),
  ]);
}

/** Read `[start, end)` out of the session's spool file and decrypt it. Opened
 * and closed per call: a persist happens every few seconds at most, so this is
 * nowhere near a hot path, and holding a descriptor over a whole meeting only
 * makes a crash messier. */
export async function readSpoolFrame(
  spoolPath: string,
  range: readonly [number, number],
  key: Buffer,
): Promise<Buffer> {
  const [start, end] = range;
  const length = end - start;
  if (length <= 0) {
    throw new Error(`Spool range is empty: [${start}, ${end}).`);
  }
  const fh = await openFile(spoolPath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    if (bytesRead !== length) {
      throw new Error(
        `Spool file is short: wanted ${length} bytes at ${start}, got ${bytesRead}.`,
      );
    }
    return decryptSpoolFrame(buf, key);
  } finally {
    await fh.close();
  }
}

export function decodeF32LE(buf: Buffer): Float32Array {
  const n = Math.trunc(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

export function encodeF32Base64(samples: Float32Array): string {
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i] as number, i * 4);
  }
  return buf.toString("base64");
}

// =============================================================================
// ---- WS /rec/host: the persist request/ack protocol -------------------------
// =============================================================================

export interface PersistRequest {
  reqId: string;
  kind: "checkpoint" | "full" | "transcript";
  fromSample: number | null;
  toSample: number | null;
  spoolRange: [number, number] | null;
  metaJson: string;
  text: string;
}

export type PersistAck =
  | { reqId: string; ok: true }
  | { reqId: string; ok: false; reason: "failed" | "closed"; message: string };

/** Rust's own words on the `Err(None)` arm, so the message the user sees is the
 * one the shipped app shows. */
export const ROOM_CLOSED = "The room closed — recording stopped.";

export async function applyPersistWrite(
  room: OpenRoom,
  ctx: RecBridgeCtx,
  fileId: string,
  msg: PersistRequest,
): Promise<void> {
  switch (msg.kind) {
    case "full":
      return writeFullPersist(room, ctx, fileId, msg);
    case "checkpoint":
      return writeCheckpointPersist(room, ctx, fileId, msg);
    case "transcript":
      return writeTranscriptPersist(room.db, fileId, msg);
    default:
      return unknownPersistKind(msg);
  }
}

export function readPersistFrame(ctx: RecBridgeCtx, range: [number, number]): Promise<Buffer> {
  const { spoolPath, spoolKey } = ctx.state;
  if (spoolPath === null || spoolKey === null) {
    throw new Error("No spool file is open for this recording session.");
  }
  return ctx.deps.readSpoolFrame(spoolPath, range, spoolKey);
}

export async function writeFullPersist(
  room: OpenRoom,
  ctx: RecBridgeCtx,
  fileId: string,
  msg: PersistRequest,
): Promise<void> {
  if (msg.spoolRange === null) {
    throw new Error("A full save arrived with no spool range to read the WAV from.");
  }
  const wav = await readPersistFrame(ctx, msg.spoolRange);
  if (room.workspace === undefined) {
    finalizeRecAudio(room.db, fileId, wav, msg.text);
  } else {
    await finalizeRecAudioHybrid(room.db, room.workspace, fileId, wav, msg.text);
  }
  setRecMeta(room.db, fileId, msg.metaJson);
}

export async function writeCheckpointPersist(
  room: OpenRoom,
  ctx: RecBridgeCtx,
  fileId: string,
  msg: PersistRequest,
): Promise<void> {
  const samples = msg.spoolRange === null
    ? null
    : decodeF32LE(await readPersistFrame(ctx, msg.spoolRange));
  inTransaction(room.db, () => {
    if (samples !== null) {
      appendRecChunk(room.db, fileId, samples);
    }
    setFileExtractedText(room.db, fileId, msg.text);
    setRecMeta(room.db, fileId, msg.metaJson);
  });
}

export function writeTranscriptPersist(
  db: Database.Database,
  fileId: string,
  msg: PersistRequest,
): void {
  inTransaction(db, () => {
    setFileExtractedText(db, fileId, msg.text);
    setRecMeta(db, fileId, msg.metaJson);
  });
}

export function unknownPersistKind(msg: PersistRequest): never {
  throw new Error(`Unknown persist kind ${JSON.stringify((msg as { kind: unknown }).kind)}.`);
}

/**
 * One incoming `WS /rec/host` persist request -> one ack. Never throws: every
 * failure becomes a `{ok:false}` ack, which is the whole point — the sidecar's
 * `_HostLink.call` awaits exactly this shape back over the socket, and an
 * exception here would leave it waiting out its 15 s timeout instead.
 *
 * The target file id is {@link RecBridgeState.liveFileId} — `WS /rec/host` is
 * already scoped to one session by its `?fileId=` query param, so the message
 * itself carries none.
 */
export async function handlePersistRequest(
  ctx: RecBridgeCtx,
  msg: PersistRequest,
): Promise<PersistAck> {
  const target = persistTarget(ctx);
  if (target === null) {
    return {
      reqId: msg.reqId,
      ok: false,
      reason: "closed",
      message: ROOM_CLOSED,
    };
  }
  try {
    await applyPersistWrite(target.room, ctx, target.fileId, msg);
    return { reqId: msg.reqId, ok: true };
  } catch (err) {
    // Disk full, a deleted row, a bad decrypt — the audio is NOT durable, and
    // the sidecar's `Engine.flush` retries on this answer. Never "closed" for a
    // write failure: that would end a recording over a transient error.
    return {
      reqId: msg.reqId,
      ok: false,
      reason: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function persistTarget(ctx: RecBridgeCtx): { room: OpenRoom; fileId: string } | null {
  const { liveFileId, sessionRoomPath } = ctx.state;
  const room = ctx.deps.currentRoom();
  if (liveFileId === null || sessionRoomPath === null || room === null || room.path !== sessionRoomPath) {
    return null;
  }
  return { room, fileId: liveFileId };
}

export function persistRequestRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object") return null;
  if (value === null) return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parsedPersistRequest(data: string): PersistRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const record = persistRequestRecord(parsed);
  if (record === null) return null;
  if (typeof record.reqId !== "string") return null;
  return record as unknown as PersistRequest;
}

/**
 * Wire a connected socket up to {@link handlePersistRequest}: parse each
 * incoming text frame, dispatch it, ack on the same socket.
 *
 * A frame that is not JSON, or carries no string `reqId`, is dropped — there is
 * nothing to ack it with, and a bad frame must never kill the socket
 * (`session_ws.py`'s own tolerance, mirrored). A frame that HAS a `reqId` but a
 * kind nobody knows is acked `failed` rather than dropped: the sidecar can
 * retry a failure immediately, whereas silence costs it the full ack timeout.
 *
 * Requests are serialized through one promise chain. `Engine` only ever awaits
 * one `persist()` at a time, so this changes nothing today — but it means two
 * frames arriving back to back can never interleave two DB transactions or ack
 * out of order if that ever stops being true.
 */
export function attachHostWs(ctx: RecBridgeCtx, ws: HostWsLike): void {
  let chain: Promise<void> = Promise.resolve();
  ws.onMessage = (data: string) => {
    const msg = parsedPersistRequest(data);
    if (msg === null) return;
    chain = chain
      .then(async () => {
        const ack = await handlePersistRequest(ctx, msg);
        ws.send(JSON.stringify(ack));
      })
      // `handlePersistRequest` never throws, but `send` on a socket that died
      // mid-dispatch does — and a rejected link would skip every request queued
      // behind it, silently. The sidecar's own ack timeout covers the frame we
      // could not answer; the next one still gets dispatched.
      .catch(() => undefined);
  };
  ws.onClose = () => {
    // A dropped host socket is NOT a stopped recording — `session_ws.py` §3 is
    // explicit that "Electron reconnecting is not the room closing", and the
    // sidecar keeps the session alive and retries. So the session slot stays;
    // only the dead handle is released, so nothing sends into it. The real
    // "this session is over" signal is the engine's own terminal state, which
    // arrives on `WS /rec/session` (the renderer's socket) — Phase 2 forwards
    // it here via {@link noteLiveSessionEnded}.
    if (ctx.state.hostWs === ws) {
      ctx.state.hostWs = null;
    }
  };
}

export function closeLiveSession(ctx: RecBridgeCtx): void {
  ctx.state.hostWs?.close();
  ctx.state.hostWs = null;
  ctx.state.liveFileId = null;
  ctx.state.liveStatus = null;
  ctx.state.sessionRoomPath = null;
  ctx.state.spoolPath = null;
  ctx.state.spoolKey = null;
  ctx.state.lastMeta = null;
}

/**
 * The sidecar ended this session without a `/rec/stop` from us — the 3-hour
 * ceiling, a room that closed under it, an engine error. Idempotent, and a
 * no-op for any file id other than the one currently tracked, so a stale
 * notification racing a newer session can never clear it.
 */
export function noteLiveSessionEnded(ctx: RecBridgeCtx, fileId: string): void {
  if (ctx.state.liveFileId === fileId) {
    closeLiveSession(ctx);
  }
}
