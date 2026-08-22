/**
 * ADD-13/CHG-15: chunk embeddings — the blob codec, cosine similarity, and
 * the streaming vector-scan retrieval queries built on them. Ported from
 * `src-tauri/src/db/embeddings.rs`.
 *
 * NUMERIC PRECISION: Rust stores and scores these as `f32`. The ON-DISK
 * FORMAT is preserved exactly — `Buffer`'s `read/writeFloatLE` round-trip
 * through real IEEE-754 binary32, the same as Rust's
 * `f32::from_le_bytes`/`to_le_bytes` — so a blob this code writes or reads is
 * byte-for-byte what the Rust build produces, and a room is portable between
 * them. The COSINE ARITHMETIC, however, accumulates in JS's native double
 * precision rather than re-rounding to f32 after every multiply and add the
 * way Rust's `f32` operations do; JS has no native f32 arithmetic short of
 * `Math.fround` after every operation, which would cost more than the
 * agreement is worth. The divergence is bounded by float32's own ~7
 * significant digits — far below anything a similarity ranking or threshold
 * notices — and it does not weaken the ported tests, which compare this
 * file's own two paths (streamed vs. materialized, blob vs. decoded) against
 * each other rather than against a golden constant from the Rust build.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryRows } from "./util.js";

// -------------------------------------------------------------- blob codec

/** ADD-13: encode an embedding as a compact little-endian f32 BLOB for
 * storage in `chunks.embedding`. Round-trips with {@link blobToEmbedding}. */
export function embeddingToBlob(v: readonly number[]): Buffer {
  const out = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    out.writeFloatLE(v[i] as number, i * 4);
  }
  return out;
}

/** ADD-13: decode a little-endian f32 BLOB back into a vector. A blob whose
 * length is not a whole number of f32s (corrupt / foreign) reads as `null` so
 * the caller silently skips it rather than mis-scoring it. */
export function blobToEmbedding(b: Uint8Array): number[] | null {
  if (b.length === 0 || b.length % 4 !== 0) {
    return null;
  }
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    out.push(buf.readFloatLE(i));
  }
  return out;
}

/** ADD-13: cosine similarity of two vectors. Returns `0` when the lengths
 * differ, either is empty, or either has zero magnitude — a safe "no signal"
 * value for the blend. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cosine similarity between a query vector and an embedding STILL IN its
 * little-endian BLOB form — the same maths, and the same accumulation order,
 * as {@link cosineSimilarity}, without decoding the blob into an array first.
 * A blob that is not a whole number of f32s, or that is a different width
 * from the query, scores `0` — exactly what `blobToEmbedding` +
 * `cosineSimilarity` did for those rows. */
export function cosineSimilarityBlob(query: readonly number[], blob: Uint8Array): number {
  if (query.length === 0 || blob.length % 4 !== 0 || blob.length / 4 !== query.length) {
    return 0;
  }
  const buf = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < query.length; i++) {
    const x = query[i] as number;
    const y = buf.readFloatLE(i * 4);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// -------------------------------------------------------- backfill + retrieval

/** ADD-13: a batch of chunks that still lack an embedding — [chunk id, file
 * name, text]. CHG-12: the file name is prepended when embedding as a
 * `search_document:` so a paragraph that never names its own file ("…pets
 * allowed…") can still match a question that does ("what does the lease say
 * about pets"). The background pass drains these in batches until none
 * remain. */
export function chunksMissingEmbedding(
  db: Database.Database,
  limit: number
): Array<[string, string, string]> {
  return queryRows(
    db,
    // `f.trashed_at IS NULL` is redundant with trashing MOVING the chunks out
    // of this table — and stays anyway. Two of the retrieval queries below
    // cannot express the filter at all (they never touch `files`), so the
    // move is the real guarantee; where a query does have `f` in scope,
    // saying it as well costs nothing and means a future change to how the
    // trash stores chunks cannot quietly leak deleted text into an answer.
    `SELECT c.id, f.name, c.text
     FROM chunks c JOIN files f ON f.id = c.file_id
     WHERE c.embedding IS NULL AND f.trashed_at IS NULL LIMIT ?`,
    [limit],
    (r) => [r[0] as string, r[1] as string, r[2] as string]
  );
}

/** ADD-13: store an embedding BLOB on one chunk (by chunk id). */
export function setChunkEmbedding(db: Database.Database, id: string, blob: Uint8Array): void {
  executeOne(db, "UPDATE chunks SET embedding = ? WHERE id = ?", [blob, id]);
}

/** CHG-15: hand every chunk's (rowid, embedding blob) to `visit` one row at a
 * time, straight out of SQLite's own row buffer — NO text. The brute-force
 * cosine pass scores over just these, so only the ~24 winners' text is ever
 * copied (via {@link chunksByRowids}). The rowid keys the keyword/vector
 * blend.
 *
 * It used to JOIN `c.text` for every embedded chunk on every question — tens
 * of MB of discarded allocation under the room mutex — and then, once that
 * was fixed, still copied EVERY blob into an array before scoring a single
 * one. Streaming (with {@link cosineSimilarityBlob} scoring off the borrowed
 * bytes) allocates nothing per chunk and keeps peak memory flat however large
 * the room grows. `better-sqlite3`'s `.iterate()` is the direct equivalent of
 * rusqlite's `Rows::next()` cursor: it yields row by row rather than
 * materializing the result set, which is the entire point of this function.
 * The scan is still linear in chunk count — only an approximate-nearest-
 * neighbour index would change that.
 *
 * Rows whose `embedding` is not a blob are skipped, matching
 * {@link blobToEmbedding}'s "silently skip rather than mis-score" contract. */
export function forEachChunkEmbedding(
  db: Database.Database,
  visit: (rowid: number, blob: Buffer) => void
): void {
  const stmt = db.prepare("SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL").raw();
  for (const row of stmt.iterate() as IterableIterator<unknown[]>) {
    const embedding = row[1];
    if (Buffer.isBuffer(embedding)) {
      visit(row[0] as number, embedding);
    }
  }
}

/** CHG-15: fetch [rowid, file name, chunk text] for a specific set of chunk
 * rowids — used to hydrate only the top vector candidates after scoring. */
export function chunksByRowids(
  db: Database.Database,
  rowids: readonly number[]
): Array<[number, string, string]> {
  if (rowids.length === 0) {
    return [];
  }
  const placeholders = rowids.map(() => "?").join(",");
  const sql = `SELECT c.rowid, f.name, c.text
     FROM chunks c JOIN files f ON f.id = c.file_id
     WHERE c.rowid IN (${placeholders}) AND f.trashed_at IS NULL`;
  return queryRows(db, sql, rowids, (r) => [r[0] as number, r[1] as string, r[2] as string]);
}

/** ADD-13: like a plain FTS chunk search but also returning each hit's chunk
 * rowid, so keyword and vector scores can be blended per chunk. [rowid, file
 * name, chunk text, bm25 — smaller is a better match]. */
export function searchChunksFtsRanked(
  db: Database.Database,
  matchExpr: string,
  limit: number
): Array<[number, string, string, number]> {
  return queryRows(
    db,
    `SELECT chunks_fts.rowid, f.name, c.text, bm25(chunks_fts)
     FROM chunks_fts
     JOIN chunks c ON c.rowid = chunks_fts.rowid
     JOIN files f ON f.id = c.file_id
     WHERE chunks_fts MATCH ? AND f.trashed_at IS NULL
     ORDER BY bm25(chunks_fts)
     LIMIT ?`,
    [matchExpr, limit],
    (r) => [r[0] as number, r[1] as string, r[2] as string, r[3] as number]
  );
}

/** Room map: the file IDS whose chunks match `matchExpr`, best match first and
 * each file listed once. `exclude` is dropped from the results — a generated
 * file usually writes its own name into its first line, and a file "mentioning
 * itself" is not a relation.
 *
 * Ordered by bm25 rather than left to scan order: the map's frontend only
 * re-lays-out when the edge list actually changes, so a query that returned
 * the same links in a different order every rebuild would scramble the layout
 * for no reason. */
export function ftsFileMatches(
  db: Database.Database,
  matchExpr: string,
  exclude: string,
  limit: number
): string[] {
  // Over-fetch chunk hits, then keep the first `limit` DISTINCT files:
  // several chunks of one file can all match, and `SELECT DISTINCT` cannot be
  // combined with an `ORDER BY bm25()` the projection doesn't carry.
  const rows = queryRows(
    db,
    `SELECT c.file_id
     FROM chunks_fts
     JOIN chunks c ON c.rowid = chunks_fts.rowid
     WHERE chunks_fts MATCH ? AND c.file_id <> ?
     ORDER BY bm25(chunks_fts)
     LIMIT ?`,
    [matchExpr, exclude, Math.max(limit * 20, 20)],
    (r) => r[0] as string
  );
  const out: string[] = [];
  for (const id of rows) {
    if (!out.includes(id)) {
      out.push(id);
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/** [file name, chunk text] for the most recently added chunks — the fallback
 * context when a question matches nothing in the FTS index (CHG-10). */
export function recentChunks(db: Database.Database, limit: number): Array<[string, string]> {
  return queryRows(
    db,
    `SELECT f.name, c.text FROM chunks c JOIN files f ON f.id = c.file_id
     WHERE f.trashed_at IS NULL
     ORDER BY f.created_at DESC, c.seq ASC LIMIT ?`,
    [limit],
    (r) => [r[0] as string, r[1] as string]
  );
}
