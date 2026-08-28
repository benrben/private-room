/**
 * Vitest port of the `embeddings.rs` tests (`src-tauri/src/db/embeddings.rs`,
 * `mod tests`):
 *
 *   - embedding_blob_round_trips
 *   - cosine_similarity_basics
 *   - embedding_backfill_columns_work
 *   - streaming_scan_scores_exactly_like_the_materializing_one
 *   - blob_cosine_matches_decoded_cosine_including_the_skip_cases
 *
 * Plus two the Rust suite has no equivalent for, covering the three exported
 * retrieval queries its own tests never reach: `searchChunksFtsRanked`,
 * `ftsFileMatches` and `recentChunks`.
 *
 * DEVIATION from the Rust test module: it uses `crate::db::mem()` (full
 * `SCHEMA`, in-memory) plus `crate::db::add_file`, a `#[cfg(test)]` helper
 * that calls the REAL `insert_file` (`db/files.rs`, a future batch) to create
 * and chunk a file. This port uses a real fixture room via `createRoom` for
 * the schema, and `addTestFile` below in place of the not-yet-ported
 * `insert_file` — see that helper's own comment.
 *
 * FLOAT PRECISION: Rust's fixture vectors are `f32` LITERALS, already at
 * binary32 precision before any round trip starts. `Math.fround` is the exact
 * JS equivalent, and it is what lets the two assertions the Rust source makes
 * bit-exactly (`assert_eq!` on a round trip, and on blob-vs-decoded cosine)
 * stay bit-exact here rather than being relaxed to an approximate compare.
 * See `embeddings.ts`'s header for what does and does not diverge.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  blobToEmbedding,
  chunksByRowids,
  chunksMissingEmbedding,
  cosineSimilarity,
  cosineSimilarityBlob,
  embeddingToBlob,
  forEachChunkEmbedding,
  ftsFileMatches,
  recentChunks,
  searchChunksFtsRanked,
  setChunkEmbedding,
} from "./embeddings.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-embeddings-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/**
 * TODO: drop this once `files.ts` lands with the real `insert_file` and its
 * chunking pipeline. Minimal test-only stand-in: one `files` row plus ONE
 * `chunks` row holding `text` verbatim — the fixture text here is short
 * enough that real chunking would produce exactly one chunk too. These tests
 * only need a chunk with a given `file_id`/`text` to exist; nothing here
 * reimplements `insert_file`'s chunking, summary or Hebrew-mark handling.
 */
function addTestFile(
  db: Database.Database,
  name: string,
  text: string,
  createdAt?: string
): string {
  const fileId = randomUUID();
  if (createdAt === undefined) {
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, extracted_text)
       VALUES (?, ?, 'text/plain', ?, 'upload', ?)`
    ).run(fileId, name, Buffer.byteLength(text), text);
  } else {
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, extracted_text, created_at)
       VALUES (?, ?, 'text/plain', ?, 'upload', ?, ?)`
    ).run(fileId, name, Buffer.byteLength(text), text, createdAt);
  }
  addTestChunk(db, fileId, 0, text);
  return fileId;
}

/** One more chunk on a file that already exists — several chunks of one file
 * matching the same query is the case `ftsFileMatches` dedupes. */
function addTestChunk(db: Database.Database, fileId: string, seq: number, text: string): void {
  db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)").run(
    randomUUID(),
    fileId,
    seq,
    text
  );
}

/** Flag a file as trashed, the way `trash_file` will once `files.ts` lands. */
function trashTestFile(db: Database.Database, fileId: string): void {
  db.prepare("UPDATE files SET trashed_at = '2026-02-01T09:00:00Z' WHERE id = ?").run(fileId);
}

/** The whole embedded set, collected off the streaming scan — what
 * `chunk_embedding_vectors` used to return before the retrieval pass stopped
 * materializing it. */
function collectVectors(db: Database.Database): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  forEachChunkEmbedding(db, (rowid, blob) => out.push([rowid, Buffer.from(blob)]));
  return out;
}

describe("embedding blob codec", () => {
  it("embedding_blob_round_trips", () => {
    // ADD-13: f32 vector <-> little-endian BLOB is lossless. `Math.fround`
    // stands in for Rust's `f32` literals — 1e-6 is not exactly representable
    // in binary32, so an untouched f64 literal was never the value the byte
    // format could have stored in the first place.
    const v = [0.0, 1.5, -2.25, 3.125, 1e-6].map(Math.fround);
    const blob = embeddingToBlob(v);
    expect(blob.length).toBe(v.length * 4);
    expect(blobToEmbedding(blob)).toEqual(v);
    // Empty and misaligned blobs decode to null (skipped, not mis-scored).
    expect(blobToEmbedding(new Uint8Array())).toBeNull();
    expect(blobToEmbedding(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("cosineSimilarity", () => {
  it("cosine_similarity_basics", () => {
    // Identical direction → 1; orthogonal → 0; opposite → -1.
    expect(cosineSimilarity([1.0, 0.0], [2.0, 0.0])).toBeCloseTo(1.0, 6);
    expect(cosineSimilarity([1.0, 0.0], [0.0, 1.0])).toBeCloseTo(0.0, 6);
    expect(cosineSimilarity([1.0, 0.0], [-1.0, 0.0])).toBeCloseTo(-1.0, 6);
    // Mismatched length or zero vector → safe 0.
    expect(cosineSimilarity([1.0, 0.0], [1.0])).toBe(0);
    expect(cosineSimilarity([0.0, 0.0], [1.0, 1.0])).toBe(0);
  });
});

describe("chunksMissingEmbedding / setChunkEmbedding / chunksByRowids", () => {
  it("embedding_backfill_columns_work", () => {
    // ADD-13: chunks start with NULL embedding; storing a blob makes them
    // visible to the vector pass and clears them from the missing list.
    const db = freshRoom();
    addTestFile(db, "a.txt", "The office holiday party is on Friday.");
    const missing = chunksMissingEmbedding(db, 10);
    expect(missing.length).toBe(1);
    expect(collectVectors(db)).toEqual([]);

    const blob = embeddingToBlob([0.1, 0.2, 0.3]);
    setChunkEmbedding(db, missing[0]?.[0] as string, blob);
    expect(chunksMissingEmbedding(db, 10)).toEqual([]);
    expect(collectVectors(db).length).toBe(1);

    // CHG-15: hydrating the winning rowids returns the chunk text.
    const rowids = collectVectors(db).map(([rowid]) => rowid);
    const hydrated = chunksByRowids(db, rowids);
    expect(hydrated.length).toBe(1);
    expect(hydrated[0]?.[2]).toContain("holiday party");

    db.close();
  });
});

describe("forEachChunkEmbedding / cosineSimilarityBlob", () => {
  it("streaming_scan_scores_exactly_like_the_materializing_one", () => {
    // The vector pass used to copy every blob out of SQLite and decode each
    // into an array before scoring one of them — tens of MB per question on a
    // big room. Streaming must score identically, row for row.
    const db = freshRoom();
    const vectors = [
      [1.0, 0.0, 0.0],
      [0.5, 0.5, 0.0],
      [0.0, 0.0, 1.0],
    ];
    for (const [i, v] of vectors.entries()) {
      addTestFile(db, `f${i}.txt`, `chunk number ${i}`);
      const missing = chunksMissingEmbedding(db, 10);
      setChunkEmbedding(db, missing[0]?.[0] as string, embeddingToBlob(v));
    }
    const q = [1.0, 0.0, 0.0];
    const streamed: Array<[number, number]> = [];
    forEachChunkEmbedding(db, (rowid, blob) => {
      streamed.push([rowid, cosineSimilarityBlob(q, blob)]);
    });
    const materialized = collectVectors(db).map(
      ([rowid, blob]): [number, number] => [
        rowid,
        cosineSimilarity(q, blobToEmbedding(blob) as number[]),
      ]
    );
    expect(streamed.length).toBe(3);
    expect(streamed).toEqual(materialized);
    db.close();
  });

  it("blob_cosine_matches_decoded_cosine_including_the_skip_cases", () => {
    // Same maths, same accumulation order, same "safe 0" for anything that
    // `blobToEmbedding` would have refused to decode. `v` is rounded to
    // binary32 up front (Rust's is a `Vec<f32>`), so encoding it loses
    // nothing and the two paths agree bit-for-bit; `q` is never blob-encoded
    // on either side of the comparison, so it needs no rounding.
    const q = [0.3, -0.7, 1.25, 0.0];
    const v = [-0.1, 0.4, 2.0, 3.5].map(Math.fround);
    const decoded = cosineSimilarity(q, v);
    expect(cosineSimilarityBlob(q, embeddingToBlob(v))).toBe(decoded);
    // Truncated / foreign blobs and width mismatches score 0 rather than
    // being mis-scored against a shorter vector.
    expect(cosineSimilarityBlob(q, new Uint8Array([1, 2, 3]))).toBe(0);
    expect(cosineSimilarityBlob(q, new Uint8Array())).toBe(0);
    expect(cosineSimilarityBlob(q, embeddingToBlob([1.0, 2.0]))).toBe(0);
    expect(cosineSimilarityBlob([], embeddingToBlob(v))).toBe(0);
    // A zero-magnitude stored vector is "no signal", not a NaN.
    expect(cosineSimilarityBlob(q, embeddingToBlob([0.0, 0.0, 0.0, 0.0]))).toBe(0);
  });
});

describe("searchChunksFtsRanked / ftsFileMatches / recentChunks (not in the Rust suite)", () => {
  it("finds chunks by FTS match, ranks them, and dedupes to one row per file", () => {
    const db = freshRoom();
    // Explicit, strictly-increasing `created_at` stamps: the column has
    // one-second resolution, and three inserts in the same test tick would
    // tie — leaving `recentChunks`' ordering assertion below dependent on
    // SQLite's unspecified tie-break rather than on the column this query
    // actually promises to sort by.
    addTestFile(db, "lease.txt", "the lease says pets are allowed here", "2026-01-01T09:00:00Z");
    addTestFile(db, "notes.txt", "unrelated meeting notes", "2026-01-01T09:00:01Z");
    addTestFile(db, "lease2.txt", "another mention of pets in the lease", "2026-01-01T09:00:02Z");

    const ranked = searchChunksFtsRanked(db, "pets", 10);
    expect(ranked.length).toBe(2);
    expect(ranked.every(([, , text]) => text.includes("pets"))).toBe(true);

    const files = ftsFileMatches(db, "pets", "__none__", 10);
    expect(files.length).toBe(2);
    expect(new Set(files).size, "each matching file is listed once").toBe(2);

    const recent = recentChunks(db, 10);
    expect(recent.length).toBe(3);
    // Newest file (created last) comes first.
    expect(recent[0]?.[0]).toBe("lease2.txt");

    db.close();
  });

  it("ftsFileMatches excludes the named file even when it matches", () => {
    // A generated file usually writes its own name into its first line, and a
    // file "mentioning itself" is not a relation.
    const db = freshRoom();
    const selfId = addTestFile(db, "self.txt", "self.txt mentions itself here");
    const otherId = addTestFile(db, "other.txt", "this one also mentions itself here");

    expect(ftsFileMatches(db, "mentions", selfId, 10)).toEqual([otherId]);
    db.close();
  });

  it("ftsFileMatches names each file once however many of its chunks match, and stops at the limit", () => {
    // The existing test above gives every file exactly ONE chunk, so its
    // "each matching file is listed once" assertion could not tell the dedupe
    // from its absence — `new Set(files).size` and `files.length` are the same
    // number whatever the loop does. The map's frontend only re-lays-out when
    // the edge list changes, so a file arriving three times is three edges
    // where there is one relation.
    const db = freshRoom();
    // Three one-word chunks on ONE file: shortest documents, so bm25 ranks all
    // three above the longer ones below and the dedupe has to do real work
    // before a second file can appear at all.
    const many = addTestFile(db, "many.txt", "pets");
    addTestChunk(db, many, 1, "pets");
    addTestChunk(db, many, 2, "pets");
    const other = addTestFile(
      db,
      "other.txt",
      "the lease document says a great deal about pets and other domestic animals kept here"
    );
    const third = addTestFile(
      db,
      "third.txt",
      "another long clause that also happens to mention pets somewhere in the middle of it"
    );

    const all = ftsFileMatches(db, "pets", "__none__", 10);
    expect(all.length, "one file arrived once per matching chunk").toBe(3);
    expect(new Set(all)).toEqual(new Set([many, other, third]));
    expect(all[0], "the best-matching file still comes first").toBe(many);

    // The limit counts DISTINCT files, not chunk hits — which is also why the
    // query over-fetches: stopping the SQL at `limit` rows would have spent all
    // of them on one file's chunks and returned a single edge.
    const two = ftsFileMatches(db, "pets", "__none__", 2);
    expect(two.length).toBe(2);
    expect(new Set(two).size).toBe(2);
  });
});

describe("a trashed file's chunks never reach a retrieval path", () => {
  it("every query that can see `files` filters on trashed_at", () => {
    // Not in the Rust suite, which never trashes anything. Trashing MOVES the
    // chunks into `trashed_chunks` (see `schema.sql`), so these `f.trashed_at
    // IS NULL` clauses are the belt to that braces — and they were the only
    // four lines in this file that no test could tell from a comment. Flagging
    // the row WITHOUT moving its chunks is exactly the state the clauses exist
    // for: the day the trash's storage changes, deleted text must not turn up
    // in an answer.
    const db = freshRoom();
    addTestFile(db, "live.txt", "the lease says pets are allowed", "2026-01-01T09:00:00Z");
    const goneId = addTestFile(
      db,
      "gone.txt",
      "the lease says pets are forbidden",
      "2026-01-01T09:00:01Z"
    );
    trashTestFile(db, goneId);
    expect(
      db.prepare("SELECT count(*) FROM chunks").pluck().get(),
      "the fixture must leave BOTH chunks in place or this proves nothing"
    ).toBe(2);

    // 1. the background embedding backfill
    expect(chunksMissingEmbedding(db, 10).map(([, name]) => name)).toEqual(["live.txt"]);
    // 2. keyword retrieval
    expect(searchChunksFtsRanked(db, "pets", 10).map(([, name]) => name)).toEqual(["live.txt"]);
    // 3. the no-match fallback context
    expect(recentChunks(db, 10).map(([name]) => name)).toEqual(["live.txt"]);
    // 4. hydrating the winning rowids after the vector scan
    const rowids = db.prepare("SELECT rowid FROM chunks").pluck().all() as number[];
    expect(chunksByRowids(db, rowids).map(([, name]) => name)).toEqual(["live.txt"]);

    db.close();
  });

  it("the two queries that cannot see `files` are the reason the chunks MOVE", () => {
    // Pinned, not fixed: `forEachChunkEmbedding` and `ftsFileMatches` never
    // join `files`, so there is no `f` to filter on and no clause anyone could
    // add here. That is precisely why trashing moves the rows out of `chunks`
    // instead of every reader remembering to ask — and why a future reader
    // should not read the missing clause as an oversight in those two.
    const db = freshRoom();
    const goneId = addTestFile(db, "gone.txt", "the lease says pets are forbidden");
    trashTestFile(db, goneId);
    setChunkEmbedding(
      db,
      chunksMissingEmbeddingIgnoringTrash(db),
      embeddingToBlob([1.0, 0.0, 0.0])
    );

    expect(ftsFileMatches(db, "pets", "__none__", 10)).toEqual([goneId]);
    expect(collectVectors(db).length).toBe(1);

    db.close();
  });
});

/** The trashed file's chunk id — deliberately NOT via `chunksMissingEmbedding`,
 * which filters it out. */
function chunksMissingEmbeddingIgnoringTrash(db: Database.Database): string {
  return db.prepare("SELECT id FROM chunks WHERE embedding IS NULL").pluck().get() as string;
}
