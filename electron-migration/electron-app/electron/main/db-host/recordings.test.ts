/**
 * Vitest port of `src-tauri/src/db/recordings.rs`'s own `mod tests`, plus
 * `the_unread_set_is_exact_about_what_has_been_read` (physically inside
 * `db/voices.rs`'s test module in the Rust source, but it exercises
 * `recordings_missing_read` end to end, so it lives with the code — the same
 * "port to where the code now lives" rule `files.test.ts`'s header states) and
 * the trash-clause gate `getRecMeta` exists for.
 *
 * The pure WAV-codec and transcript helpers live in `../recFormat.ts` and are
 * covered by `../recFormat.test.ts`.
 *
 * REAL FIXTURE ROOMS, matching this directory's convention (`files.test.ts`,
 * `open.test.ts`): every test opens a real `.roomai` through `createRoom`.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  deleteFile,
  getFileBytes,
  getFileExtractedText,
  insertFile,
  trashFile,
  updateFileContent,
} from "./files.js";
import { decodeWav, encodeWav } from "../recFormat.js";
import {
  appendRecChunk,
  clearRecChunks,
  finalizeRecAudio,
  getRecMeta,
  recordingsMissingRead,
  recoverRecChunks,
  setRecMeta,
} from "./recordings.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-recordings-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Matches Rust's `crate::db::add_file` test helper exactly. */
function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

function chunkCount(db: Database.Database, fileId: string): number {
  return db.prepare("SELECT count(*) FROM rec_chunks WHERE file_id = ?").pluck().get(fileId) as number;
}

describe("setRecMeta / getRecMeta", () => {
  it("round-trips, upserts, and cascades off the file it belongs to", () => {
    const db = freshRoom();
    const id = addFile(db, "call.wav", "(live recording)");
    expect(getRecMeta(db, id)).toBeNull();
    setRecMeta(db, id, '{"version":1}');
    expect(getRecMeta(db, id)).toBe('{"version":1}');
    setRecMeta(db, id, '{"version":2}');
    expect(getRecMeta(db, id)).toBe('{"version":2}');
    // Deleting the file takes the meta row with it (ON DELETE CASCADE).
    deleteFile(db, id);
    expect(getRecMeta(db, id)).toBeNull();
  });

  it("hides a TRASHED recording's meta — the meta IS the transcript", () => {
    // The `recordings` row has no `trashed_at` of its own; the join to `files`
    // is the only thing keeping a by-id read of a deleted recording from
    // handing back its segments, every word, and the speakers the user named.
    const db = freshRoom();
    const id = addFile(db, "call.wav", "(live recording)");
    setRecMeta(db, id, '{"durationCs":10,"segments":[],"cuts":[]}');
    trashFile(db, id, { kind: "user" });
    expect(getRecMeta(db, id)).toBeNull();
  });
});

describe("appendRecChunk / clearRecChunks", () => {
  it("numbers chunks from 1 and stores them as little-endian 16-bit PCM", () => {
    const db = freshRoom();
    const id = addFile(db, "call.wav", "(live recording)");
    appendRecChunk(db, id, Float32Array.from([0.5, -0.5]));
    appendRecChunk(db, id, Float32Array.from([1]));
    const rows = db
      .prepare("SELECT seq, pcm FROM rec_chunks WHERE file_id = ? ORDER BY seq")
      .raw()
      .all(id) as Array<[number, Buffer]>;
    expect(rows.map((r) => r[0])).toEqual([1, 2]);
    expect((rows[0] as [number, Buffer])[1].length).toBe(4);
    expect((rows[0] as [number, Buffer])[1].readInt16LE(0)).toBe(16383); // 0.5 * 32767, truncated
    expect((rows[1] as [number, Buffer])[1].readInt16LE(0)).toBe(32767);
    clearRecChunks(db, id);
    expect(chunkCount(db, id)).toBe(0);
  });
});

describe("finalizeRecAudio", () => {
  it("writes the WAV and clears the checkpoints together", () => {
    const db = freshRoom();
    const id = addFile(db, "call.wav", "(live recording)");
    const tail = new Float32Array(800).fill(0.5);
    appendRecChunk(db, id, tail);
    appendRecChunk(db, id, tail);

    const whole = encodeWav(new Float32Array(1600).fill(0.5));
    finalizeRecAudio(db, id, whole, "(live recording)\n");
    expect(getFileBytes(db, id)?.equals(whole)).toBe(true);
    expect(chunkCount(db, id)).toBe(0);

    // Recovery over a finalized recording is a no-op, so nothing is appended to
    // audio that already contains it.
    expect(recoverRecChunks(db)).toBe(0);
    expect(getFileBytes(db, id)?.equals(whole)).toBe(true);

    // A write that fails leaves the checkpoints alone, so the next flush can
    // still retry the whole tail. (The transaction is what makes the two halves
    // inseparable in either direction.)
    appendRecChunk(db, id, tail);
    db.exec("BEGIN IMMEDIATE");
    expect(() => finalizeRecAudio(db, id, whole, null)).not.toThrow();
    db.exec("ROLLBACK");
    expect(chunkCount(db, id)).toBe(1);
  });
});

describe("recoverRecChunks", () => {
  it("splices the checkpointed tail onto the stored WAV and keeps the transcript", () => {
    const db = freshRoom();
    const id = addFile(db, "board meeting.wav", "(live recording)");
    updateFileContent(db, id, encodeWav(new Float32Array(400).fill(0.25)), "so far\n");
    appendRecChunk(db, id, new Float32Array(200).fill(0.5));

    expect(recoverRecChunks(db)).toBe(1);
    const rescued = decodeWav(getFileBytes(db, id) as Buffer);
    expect(rescued.length).toBe(600);
    expect(rescued[0]).toBeCloseTo(0.25, 3);
    expect(rescued[599]).toBeCloseTo(0.5, 3);
    // The transcript was checkpointed by every flush and is CURRENT — a rescue
    // that dropped it would erase everything said since the last full write.
    expect(getFileExtractedText(db, id)).toBe("so far\n");
    expect(chunkCount(db, id)).toBe(0);
  });

  it("does not let a trashed recording take the crash rescue of the others down with it", () => {
    const db = freshRoom();
    const deletedId = addFile(db, "old call.wav", "(live recording)");
    const liveId = addFile(db, "board meeting.wav", "(live recording)");
    updateFileContent(db, liveId, encodeWav(new Float32Array(400).fill(0.25)), null);
    appendRecChunk(db, deletedId, new Float32Array(200).fill(0.1));
    appendRecChunk(db, liveId, new Float32Array(200).fill(0.3));
    trashFile(db, deletedId, { kind: "user" });

    expect(recoverRecChunks(db)).toBe(1);
    expect(chunkCount(db, liveId)).toBe(0);
    // The trashed one's tail is KEPT rather than thrown away: trash is
    // reversible, so a restore must still find something to recover.
    expect(chunkCount(db, deletedId)).toBe(1);
  });

  it("does not let one unrescuable recording cancel the rescue of the others", () => {
    const db = freshRoom();
    const damagedId = addFile(db, "garbled.wav", "(live recording)");
    const goodId = addFile(db, "board meeting.wav", "(live recording)");
    updateFileContent(db, damagedId, Buffer.from("this is not a wav file"), null);
    updateFileContent(db, goodId, encodeWav(new Float32Array(400).fill(0.25)), null);
    appendRecChunk(db, damagedId, new Float32Array(200).fill(0.1));
    appendRecChunk(db, goodId, new Float32Array(200).fill(0.3));

    let message = "";
    try {
      recoverRecChunks(db);
      expect.unreachable("a failed rescue must be reported");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/1 of 2/);
    // The message must never read as a total loss.
    expect(message).toMatch(/still stored/);
    // The healthy one was rescued anyway…
    expect(chunkCount(db, goodId)).toBe(0);
    // …and the damaged one keeps its tail for the next attempt.
    expect(chunkCount(db, damagedId)).toBe(1);
  });
});

describe("recordingsMissingRead", () => {
  it("is exact about what has been read", () => {
    const db = freshRoom();
    const add = (name: string, meta: string): string => {
      const id = addFile(db, name, "(live recording)");
      setRecMeta(db, id, meta);
      return id;
    };
    const seg = '{"id":"s","source":"sys","speaker":"Speaker 1","t0":0,"t1":10,"text":"hi","words":[]}';
    const unread = add("unread.wav", `{"durationCs":10,"segments":[${seg}],"cuts":[]}`);
    const read = add(
      "read.wav",
      `{"durationCs":10,"segments":[${seg}],"cuts":[],"readOf":{"turns":1,"chars":2}}`
    );
    const silent = add("silent.wav", '{"durationCs":10,"segments":[],"cuts":[]}');
    // Read through `json_extract`, not a LIKE on the blob — a note whose text
    // happens to contain the word must not make a recording look read.
    const tricky = add(
      "tricky.wav",
      `{"durationCs":10,"segments":[${seg}],"cuts":[],"notes":[{"id":"n","t0":0,"kind":"point","text":"we discussed readOf today","by":"room"}]}`
    );

    const missing = recordingsMissingRead(db, 10);
    expect(missing).toContain(unread);
    expect(missing).toContain(tricky);
    expect(missing).not.toContain(read);
    expect(missing).not.toContain(silent);

    // A JSON `null` readOf — what this port writes for "never read" — is still
    // unread, because `json_extract` hands SQL NULL back for it.
    const explicitNull = add("null.wav", `{"durationCs":10,"segments":[${seg}],"cuts":[],"readOf":null}`);
    expect(recordingsMissingRead(db, 10)).toContain(explicitNull);

    trashFile(db, unread, { kind: "user" });
    expect(recordingsMissingRead(db, 10)).not.toContain(unread);
  });

  it("honours the limit", () => {
    const db = freshRoom();
    const seg = '{"id":"s","source":"sys","speaker":"S","t0":0,"t1":10,"text":"hi","words":[]}';
    for (let i = 0; i < 4; i++) {
      const id = addFile(db, `r${i}.wav`, "(live recording)");
      setRecMeta(db, id, `{"durationCs":10,"segments":[${seg}],"cuts":[]}`);
    }
    expect(recordingsMissingRead(db, 2)).toHaveLength(2);
  });
});
