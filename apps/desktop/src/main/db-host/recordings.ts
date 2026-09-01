/**
 * ADD-27 per-file recording metadata + live-recording audio checkpoints. Port
 * of `src-tauri/src/db/recordings.rs` (313 lines): `setRecMeta`/`getRecMeta`/
 * `recordingsMissingRead`, the checkpoint table (`appendRecChunk`/
 * `clearRecChunks`), `finalizeRecAudio` (the one-transaction "write the WAV,
 * drop the checkpoints" step) and the crash-recovery sweep
 * (`recoverRecChunks`/`recoverOne`).
 *
 * The `RecMeta` data model and the WAV codec live in `../recFormat.ts` (the
 * data-model half of `recording.rs`) — this module only moves the blob and the
 * bytes, exactly as the Rust source does.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`/`files.ts`: every read/write
 * goes through `queryOne`/`queryOpt`/`queryRows`/`executeOne` rather than a
 * bare `db.prepare` call site, rows are read positionally via `.raw()` matching
 * Rust's `r.get(i)` order, a reused Rust `?1` becomes a `?` repeated in the
 * params array, and `inTransaction`/`updateFileContent`/`getFileBytes`/
 * `getFileExtractedText` are reused from `files.ts` rather than re-spelled
 * (`recordings.rs` calls the identical Rust functions).
 *
 * The `recordings`/`rec_chunks` tables were already in `schema.sql` (see its
 * own ADD-27 comments) — this is the first port of the code that uses them.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryOpt, queryRows, type Row } from "./util.js";
import {
  getFileBytes,
  getFileExtractedText,
  inTransaction,
  setFileExtractedText,
  updateFileContent,
} from "./files.js";
import { decodeWav, encodeWav } from "../recFormat.js";
import { Readable } from "node:stream";
import type { WorkspaceService } from "../workspace/workspaceService.js";

// ADD-27: per-file recording metadata (segments with word timings, speakers,
// cut list) as one JSON blob keyed by file id. The row's EXISTENCE is also the
// marker that turns a plain audio file into a "recording" in the viewer. The
// transcript itself is NOT here — it stays in files.extracted_text where
// search, RAG and every AI action already find it.

/** A recording's meta as raw JSON text — callers parse/stringify their own
 * `RecMeta`; this module, like the Rust source, only moves the blob. */
export function setRecMeta(db: Database.Database, fileId: string, metaJson: string): void {
  executeOne(
    db,
    `INSERT INTO recordings(file_id, meta) VALUES (?, ?)
     ON CONFLICT(file_id) DO UPDATE SET meta = excluded.meta`,
    [fileId, metaJson]
  );
}

/**
 * A recording's meta, or `null` when this file is not a recording.
 *
 * Joined to `files` for the trash clause: the meta IS the transcript —
 * segments, every word, the speakers the user named — so a by-id read of a
 * deleted recording would hand back its content in full. The `recordings` row
 * has no `trashed_at` of its own (it is keyed only by file id), and the join is
 * what keeps `get_file_meta`'s invariant true here too. The transcript-editing
 * commands reach this before they touch any filtered read, so it is their only
 * gate.
 */
export function getRecMeta(db: Database.Database, fileId: string): string | null {
  return queryOpt(
    db,
    `SELECT r.meta FROM recordings r JOIN files f ON f.id = r.file_id
     WHERE r.file_id = ? AND f.trashed_at IS NULL`,
    [fileId],
    (r: Row) => r[0] as string
  );
}

/**
 * Recordings the room has never read — the set the background sweep works
 * through so recordings made before this feature existed fill in by themselves.
 *
 * "Never read" is `readOf` being absent, read through `json_extract` rather
 * than a LIKE on the blob, so a note whose text happens to contain the word
 * cannot make a recording look read. A recording with no transcript yet is
 * skipped: there is nothing to read, and asking a model about silence wastes
 * the machine. Trashed files are excluded by the same join `getRecMeta` uses.
 */
export function recordingsMissingRead(db: Database.Database, limit: number): string[] {
  return queryRows(
    db,
    `SELECT r.file_id FROM recordings r JOIN files f ON f.id = r.file_id
     WHERE f.trashed_at IS NULL
       AND json_extract(r.meta, '$.readOf') IS NULL
       AND json_array_length(r.meta, '$.segments') > 0
     ORDER BY f.created_at DESC
     LIMIT ?`,
    [limit],
    (r: Row) => r[0] as string
  );
}

// ---- live-recording audio checkpoints -------------------------------------
//
// A live session's periodic saves used to rewrite the file's ENTIRE growing WAV
// (an hour in ~115 MB, re-encrypted every minute). Instead, the audio recorded
// since the last full write is APPENDED here as raw 16-bit PCM chunks;
// pause/stop assemble the real WAV once and clear the chunks. After a crash the
// chunks still hold everything since the last pause — reassembled the next time
// the room opens.

/** Append one checkpoint of mono 16 kHz samples for a live recording. */
export function appendRecChunk(
  db: Database.Database,
  fileId: string,
  samples: Float32Array | readonly number[]
): void {
  const n = samples.length;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const clamped = Math.min(Math.max(samples[i] as number, -1), 1);
    pcm.writeInt16LE(Math.trunc(clamped * 32767), i * 2);
  }
  executeOne(
    db,
    `INSERT INTO rec_chunks(file_id, seq, pcm)
     VALUES (?, 1 + COALESCE((SELECT MAX(seq) FROM rec_chunks WHERE file_id = ?), 0), ?)`,
    [fileId, fileId, pcm]
  );
}

/** Drop a file's checkpoints — the full WAV was just written. */
export function clearRecChunks(db: Database.Database, fileId: string): void {
  executeOne(db, "DELETE FROM rec_chunks WHERE file_id = ?", [fileId]);
}

/**
 * Write the assembled WAV (plus its transcript) and drop the now-redundant
 * checkpoints as ONE transaction.
 *
 * These used to be two independent statements, and nothing tied them together:
 * a failure — or a crash — between them left a complete recording with its
 * checkpoints still on disk, and the next `recoverRecChunks` dutifully spliced
 * that tail onto the end of audio that already contained it, so part of the
 * recording played twice. Either both land or neither does; the flush that
 * failed simply retries.
 */
export function finalizeRecAudio(
  db: Database.Database,
  fileId: string,
  wav: Uint8Array,
  text: string | null
): void {
  inTransaction(db, () => {
    updateFileContent(db, fileId, wav, text);
    clearRecChunks(db, fileId);
  });
}

/** Hybrid-room final save. Current audio is written to the normal workspace
 * file; transcript/search metadata and crash checkpoints remain encrypted in
 * SQLCipher. */
export async function finalizeRecAudioHybrid(
  db: Database.Database,
  workspace: WorkspaceService,
  fileId: string,
  wav: Uint8Array,
  text: string | null,
): Promise<void> {
  const row = db.prepare(
    "SELECT storage_kind, content_sha256 FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(fileId) as { storage_kind: string; content_sha256: string | null } | undefined;
  if (row === undefined) throw new Error("That recording is no longer in the room.");
  if (row.storage_kind !== "workspace") {
    finalizeRecAudio(db, fileId, wav, text);
    return;
  }
  await workspace.writeAtomic(
    fileId,
    Readable.from([Buffer.from(wav)]),
    row.content_sha256 ?? undefined,
  );
  if (text !== null) setFileExtractedText(db, fileId, text);
  clearRecChunks(db, fileId);
}

function recordingStorageKind(db: Database.Database, fileId: string): string | undefined {
  const row = db.prepare(
    "SELECT storage_kind FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(fileId) as { storage_kind: string } | undefined;
  return row?.storage_kind;
}

function checkpointSamples(db: Database.Database, fileId: string, base: Float32Array): Float32Array {
  const chunks = queryRows(
    db,
    "SELECT pcm FROM rec_chunks WHERE file_id = ? ORDER BY seq",
    [fileId],
    (row: Row) => row[0] as Buffer,
  );
  let total = base.length;
  for (const pcm of chunks) total += Math.trunc(pcm.length / 2);
  const samples = new Float32Array(total);
  samples.set(base, 0);
  let at = base.length;
  for (const pcm of chunks) {
    for (let index = 0; index < Math.trunc(pcm.length / 2); index++) {
      samples[at++] = pcm.readInt16LE(index * 2) / 32768;
    }
  }
  return samples;
}

async function recoverWorkspaceRecording(
  db: Database.Database,
  workspace: WorkspaceService,
  fileId: string,
): Promise<void> {
  const stored = await workspace.readBuffer(fileId);
  const base = stored.length > 0 ? decodeWav(stored) : new Float32Array(0);
  const samples = checkpointSamples(db, fileId, base);
  await finalizeRecAudioHybrid(db, workspace, fileId, encodeWav(samples), getFileExtractedText(db, fileId));
}

async function recoverKnownRecordingHybrid(
  db: Database.Database,
  workspace: WorkspaceService,
  fileId: string,
  storageKind: string,
): Promise<boolean> {
  try {
    if (storageKind === "workspace") {
      await recoverWorkspaceRecording(db, workspace, fileId);
    } else {
      recoverOne(db, fileId, getFileBytes(db, fileId));
    }
    return true;
  } catch {
    return false;
  }
}

function recoveryFailure(ids: string[], recovered: number, failed: number): Error | undefined {
  if (failed === 0) {
    return undefined;
  }
  return new Error(
    `${failed} of ${ids.length} interrupted recording(s) could not be restored ` +
      `(${recovered} were). Their audio is still stored in the room and the ` +
      "rescue runs again the next time you unlock it.",
  );
}

/** Recover live PCM checkpoints for a workspace recording without moving its
 * current WAV back into `files.original_bytes`. */
export async function recoverRecChunksHybrid(
  db: Database.Database,
  workspace: WorkspaceService,
): Promise<number> {
  const ids = queryRows(db, "SELECT DISTINCT file_id FROM rec_chunks", [], (r: Row) => r[0] as string);
  let recovered = 0;
  let failed = 0;
  for (const id of ids) {
    const storageKind = recordingStorageKind(db, id);
    if (storageKind === undefined) {
      continue;
    }
    if (await recoverKnownRecordingHybrid(db, workspace, id, storageKind)) {
      recovered++;
    } else {
      failed++;
    }
  }
  const failure = recoveryFailure(ids, recovered, failed);
  if (failure !== undefined) {
    throw failure;
  }
  return recovered;
}

/**
 * Recover any recording whose live session died before its final write: splice
 * the checkpointed tail onto the stored WAV and clear the chunks. Idempotent,
 * and free when there is nothing to recover (the normal case).
 *
 * Throws when one or more recordings genuinely could not be rescued — the
 * message counts BOTH the failures and the successes, so it can never read as
 * a total loss.
 */
export function recoverRecChunks(db: Database.Database): number {
  const ids = queryRows(db, "SELECT DISTINCT file_id FROM rec_chunks", [], (r: Row) => r[0] as string);
  let recovered = 0;
  // One recording that cannot be rescued must not take the others down with it.
  // A damaged WAV, a failing write — anything — used to abort the loop on the
  // spot, so a single bad file meant every OTHER interrupted recording in the
  // room stayed unrescued, on every unlock, forever. Failures are counted here
  // and reported at the end; their checkpoints stay put, so the next unlock
  // tries again.
  let failed = 0;
  for (const id of ids) {
    // A file trashed while its live session was still checkpointing has no row
    // this read can find (`getFileBytes` throws for a missing/trashed row, the
    // shape of Rust's `Err` from the same query). SKIPPED, not failed: `?` here
    // aborted the whole loop, so one deleted recording took the rescue of every
    // OTHER interrupted recording down with it — and the user was told the
    // recovery failed. The checkpoints stay put, so a restore still finds its
    // tail waiting on the next open.
    let stored: Buffer | null;
    try {
      stored = getFileBytes(db, id);
    } catch {
      continue;
    }
    try {
      recoverOne(db, id, stored);
      recovered++;
    } catch {
      failed++;
    }
  }
  const failure = recoveryFailure(ids, recovered, failed);
  if (failure !== undefined) {
    throw failure;
  }
  return recovered;
}

/** Splice one recording's checkpointed tail onto its stored WAV. */
function recoverOne(db: Database.Database, id: string, stored: Buffer | null): void {
  // Mirrors Rust's `stored.map(decode_wav).transpose()?.unwrap_or_default()`
  // exactly: no stored bytes at all is a silent base, but ANY stored bytes go
  // through `decodeWav`, which throws if they are not a valid WAV. A real
  // recording's initial bytes are always a valid (if silent) WAV, so the only
  // rows this rejects are genuinely damaged ones — which is the point: their
  // checkpoints are kept for the next attempt rather than spliced onto rubble.
  const base = stored !== null ? decodeWav(stored) : new Float32Array(0);
  const samples = checkpointSamples(db, id, base);
  const wav = encodeWav(samples);
  // The transcript was checkpointed by every flush and is CURRENT — it must
  // ride through, or this rescue would erase it.
  const text = getFileExtractedText(db, id);
  // The write and the checkpoint drop are one step, for the same reason
  // `finalizeRecAudio` is: a WAV that already contains its tail, with the
  // checkpoints still on disk, gets that tail spliced on AGAIN next time.
  finalizeRecAudio(db, id, wav, text);
}
