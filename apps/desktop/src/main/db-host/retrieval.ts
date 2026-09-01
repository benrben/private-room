/**
 * The RAG context-gathering core: markup stripping, question-term extraction,
 * FTS5 match-expression construction, the keyword/vector blended retrieval
 * (`retrieveContext` / `retrieveContextExcluding` / `retrieveContextLimited`),
 * snippet extraction, chat-history compaction and memory selection. Ported
 * from `src-tauri/src/commands/retrieval.rs`.
 *
 * REUSES PART A's `embeddings.ts` for the whole vector half —
 * `forEachChunkEmbedding` (the streaming (rowid, blob) scan),
 * `cosineSimilarityBlob` (scoring off the borrowed bytes, no decode),
 * `chunksByRowids` (hydrating only the winners), `searchChunksFtsRanked` and
 * `recentChunks`. None of that is reimplemented here; this file only POOLS
 * and RANKS what those return. Per `embeddings.ts`'s own header the on-disk
 * f32 format is byte-exact while the cosine arithmetic accumulates in JS
 * doubles — a divergence far below anything a ranking or the 0.55 floor
 * notices.
 *
 * REUSES `files.ts`'s `stripHebrewMarks` for the question side of a search
 * (`questionTerms`), so a pointed query and the already-stripped indexed text
 * agree on what "the same word" is.
 *
 * BORROWED CONSTANTS: `MAX_CONTEXT_CHUNKS` (6) and `RETRIEVE_CANDIDATES`
 * (6 * 4) are declared in `commands.rs`, not `retrieval.rs` — but
 * `retrieval.rs` uses both directly and `commands.rs` has no port yet. Their
 * values are copied verbatim rather than invented, and re-exported here so
 * the eventual `commands.ts` can take them from one place.
 *
 * BYTE- VS. CHARACTER-BUDGETING is load-bearing and ASYMMETRIC in the Rust
 * source, deliberately preserved rather than "tidied":
 *   - `compact_history`'s budget counts `String::len()` — UTF-8 BYTES — so
 *     {@link compactHistory} measures and cuts through a `Buffer`, on real
 *     UTF-8 boundaries, via a JS port of Rust's `floor_boundary`.
 *   - `select_memories`' budget counts `chars().count()` — CODE POINTS —
 *     because CHG-8 fixed exactly that byte/char confusion there (a Hebrew
 *     note cost double what the same note cost in English, in a room where
 *     Hebrew is first-class) and did NOT touch history. So
 *     {@link selectMemories} counts `Array.from(m).length`.
 *   - `question_terms`' `word.len() >= 2` is likewise BYTES, which is why
 *     {@link questionTerms} measures `Buffer.byteLength`: a single Hebrew or
 *     CJK letter is already 2-3 UTF-8 bytes and survives that filter in the
 *     Rust build, while `.length` (UTF-16 units) would call it 1 and drop it.
 *
 * NOT PORTED (out of scope for this batch): `backfill.rs` (`embed_question`,
 * `spawn_reextract_backfill` — Tauri/Ollama orchestration, not DB query
 * logic) and everything under retrieval.rs's "chat commands" heading (the
 * `#name`/`@name` pipeline, which calls into these functions but is not
 * itself part of the query layer).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  chunksByRowids,
  cosineSimilarityBlob,
  forEachChunkEmbedding,
  recentChunks,
  searchChunksFtsRanked,
} from "./embeddings.js";
import { ftsMatchExpr, questionTerms } from "./retrievalText.js";
import { queryRows } from "./util.js";

export {
  ftsMatchExpr,
  makeSnippet,
  NOT_ALPHANUMERIC,
  questionTerms,
  STOPWORDS,
  stripMarkupBlocks,
} from "./retrievalText.js";
export { compactHistory, selectMemories } from "./retrievalHistory.js";

// ------------------------------------------------------------- constants

/** `commands.rs`'s own constant — the chunk cap a normal (non-#find)
 * question's context is built from. */
export const MAX_CONTEXT_CHUNKS = 6;

/** `commands.rs`'s own constant: `MAX_CONTEXT_CHUNKS * 4` — widen the
 * per-signal candidate pool before RRF blending so a strong vector-only
 * (synonym) chunk can surface above weak keyword hits. */
export const RETRIEVE_CANDIDATES = MAX_CONTEXT_CHUNKS * 4;

/**
 * How close a chunk's vector has to be to the question's before it counts as
 * a match at all.
 *
 * Measured on the embed model this app actually runs (nomic-embed-text with
 * the `search_query:`/`search_document:` prefixes, 2026-08-16): a question
 * nothing in the room answers ("asdf qwerty", "kzzzt vorplex") scores
 * 0.32-0.49 against EVERY chunk, while a real paraphrase of a chunk scores
 * 0.64-0.83. Any positive cosine used to pool a chunk, so once the backfill
 * had run no question could ever be reported as unanswered: the six chunks
 * with the highest cosine came back under a header calling them context from
 * the room, when all that distinguished them was being least-unrelated. A
 * FLOOR, not "any positive value".
 */
export const MIN_CHUNK_SIMILARITY = 0.55;

/** How many vector candidates one question may carry into hydration.
 *
 * `chunksByRowids` binds one SQL variable per rowid and SQLite binds at most
 * 32,766 of them, so an unlimited request (`limit: null`) over a room with
 * more embedded chunks than that failed the whole query rather than answering
 * it. Far above anything a caller displays, and far below the bind limit. */
export const MAX_VECTOR_CANDIDATES = 2_000;

/** RRF damping constant; standard value. */
const RRF_K = 60;

export interface ScoredChunk {
  rowid: number;
  fileName: string;
  text: string;
  score: number;
}

// -------------------------------------------------------------- retrieval

/** HLT-3 + ADD-13: retrieve context by blending the FTS5 keyword score with
 * vector (cosine) similarity over stored chunk embeddings, then taking the
 * top {@link MAX_CONTEXT_CHUNKS}. `questionEmbedding` is the question's
 * vector; pass `null` to run the pure keyword path unchanged — when the embed
 * model is absent or no chunks are embedded yet, retrieval degrades cleanly
 * to keywords.
 *
 * Returns `[chunks, fallback]`: `fallback` is true when nothing matched and
 * recent content was padded in instead (CHG-10 — such filler must not be
 * credited as a "source"). */
export function retrieveContext(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null
): [ScoredChunk[], boolean] {
  return retrieveContextExcluding(db, question, questionEmbedding, new Set());
}

/** Retrieve prompt context only from files the user explicitly named.
 *
 * An explicit path is a stronger relevance signal than room-wide FTS/vector
 * similarity. The old gatherer still ran ordinary room retrieval for
 * “summarize notes.md and Research/findings.md”, so unrelated script/PDF/report
 * chunks entered the prompt and appeared as source chips (ARC-QA-005).
 *
 * Names are canonical display paths from `listFileInventory`, not model text.
 * Each target contributes one chunk when indexed, then matching chunks fill
 * the remaining budget, then early chunks fill any space left. There is NO
 * recent-room fallback: if a named file has no extracted text, unrelated
 * content is worse than no context. */
type FileContextRow = [number, string, string];

interface NamedFile {
  readonly name: string;
  readonly folded: string;
}

function normalizedNamedFile(raw: string): NamedFile | null {
  const name = raw.normalize("NFC").trim();
  return name === "" ? null : { name, folded: name.toLowerCase() };
}

function namedFiles(fileNames: readonly string[]): string[] {
  const names: string[] = [];
  const seenNames = new Set<string>();
  for (const raw of fileNames) {
    const named = normalizedNamedFile(raw);
    if (named === null || seenNames.has(named.folded)) continue;
    seenNames.add(named.folded);
    names.push(named.name);
    if (names.length >= 12) break;
  }
  return names;
}

function contextLimit(limit: number): number {
  return Math.max(0, Math.min(Math.trunc(limit), MAX_CONTEXT_CHUNKS));
}

function fileRowsByName(
  db: Database.Database,
  names: readonly string[],
  cap: number,
  displayName: string
): Map<string, FileContextRow[]> {
  const perFile = new Map<string, FileContextRow[]>();
  for (const name of names) {
    const rows = queryRows(
      db,
      `SELECT c.rowid, ${displayName}, c.text
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.trashed_at IS NULL AND ${displayName} = ?
       ORDER BY c.seq ASC LIMIT ?`,
      [name, cap],
      (row): FileContextRow => [row[0] as number, row[1] as string, row[2] as string],
    );
    perFile.set(name.toLowerCase(), rows);
  }
  return perFile;
}

function matchingFileRows(
  db: Database.Database,
  question: string,
  names: readonly string[],
  cap: number,
  displayName: string
): FileContextRow[] {
  const expr = ftsMatchExpr(questionTerms(question));
  if (expr === null) return [];
  const placeholders = names.map(() => "?").join(",");
  return queryRows(
    db,
    `SELECT chunks_fts.rowid, ${displayName}, c.text
     FROM chunks_fts
     JOIN chunks c ON c.rowid = chunks_fts.rowid
     JOIN files f ON f.id = c.file_id
     LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE chunks_fts MATCH ?
       AND f.trashed_at IS NULL
       AND ${displayName} IN (${placeholders})
     ORDER BY bm25(chunks_fts) LIMIT ?`,
    [expr, ...names, Math.max(cap * 4, cap)],
    (row): FileContextRow => [row[0] as number, row[1] as string, row[2] as string],
  );
}

function canAddContextRow(
  row: FileContextRow | undefined,
  out: readonly ScoredChunk[],
  seenRows: ReadonlySet<number>,
  cap: number
): row is FileContextRow {
  return row !== undefined && out.length < cap && !seenRows.has(row[0]);
}

function addContextRow(
  out: ScoredChunk[],
  seenRows: Set<number>,
  cap: number,
  row: FileContextRow | undefined,
  score: number
): void {
  if (!canAddContextRow(row, out, seenRows, cap)) return;
  seenRows.add(row[0]);
  out.push({ rowid: row[0], fileName: row[1], text: row[2], score });
}

function addNamedFileRows(
  names: readonly string[],
  matches: readonly FileContextRow[],
  perFile: ReadonlyMap<string, FileContextRow[]>,
  out: ScoredChunk[],
  seenRows: Set<number>,
  cap: number
): void {
  for (const name of names) {
    const folded = name.toLowerCase();
    const row = matches.find((candidate) => candidate[1].normalize("NFC").toLowerCase() === folded)
      ?? perFile.get(folded)?.[0];
    addContextRow(out, seenRows, cap, row, 1);
  }
}

function addMatchingRows(
  matches: readonly FileContextRow[],
  out: ScoredChunk[],
  seenRows: Set<number>,
  cap: number
): void {
  matches.forEach((row, rank) => addContextRow(out, seenRows, cap, row, 1 / (RRF_K + rank)));
}

function addEarlyFileRows(
  names: readonly string[],
  perFile: ReadonlyMap<string, FileContextRow[]>,
  out: ScoredChunk[],
  seenRows: Set<number>,
  cap: number
): void {
  for (let sequence = 0; out.length < cap; sequence += 1) {
    let found = false;
    for (const name of names) {
      const row = perFile.get(name.toLowerCase())?.[sequence];
      found ||= row !== undefined;
      addContextRow(out, seenRows, cap, row, 0);
    }
    if (!found) return;
  }
}

export function retrieveContextForFiles(
  db: Database.Database,
  question: string,
  fileNames: readonly string[],
  limit = MAX_CONTEXT_CHUNKS,
): [ScoredChunk[], false] {
  const names = namedFiles(fileNames);
  const cap = contextLimit(limit);
  if (names.length === 0 || cap === 0) return [[], false];

  const displayName = "CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END";
  const perFile = fileRowsByName(db, names, cap, displayName);
  const matches = matchingFileRows(db, question, names, cap, displayName);

  const out: ScoredChunk[] = [];
  const seenRows = new Set<number>();

  // One best matching (or first) chunk from every named file before one long
  // file can consume the whole prompt budget.
  addNamedFileRows(names, matches, perFile, out, seenRows, cap);
  addMatchingRows(matches, out, seenRows, cap);
  addEarlyFileRows(names, perFile, out, seenRows, cap);
  return [out, false];
}

/** CHG-13 + CHG-15 + CHG-16: as {@link retrieveContext}, but excludes chunk
 * rowids in `exclude` (used by search_room to skip chunks already injected
 * into the prompt). Blends keyword and vector signals with Reciprocal Rank
 * Fusion — scale-free, no min-max degeneracy, no "vec=0 for a good keyword
 * hit". */
export function retrieveContextExcluding(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null,
  exclude: ReadonlySet<number>
): [ScoredChunk[], boolean] {
  return retrieveContextLimited(db, question, questionEmbedding, exclude, MAX_CONTEXT_CHUNKS);
}

interface Cand {
  fileName: string;
  text: string;
  kwRank: number | null;
  vecRank: number | null;
}

function retrievalCandidateCount(limit: number | null): number {
  return limit === null ? MAX_VECTOR_CANDIDATES : Math.max(limit * 4, RETRIEVE_CANDIDATES);
}

function pooledCandidate(pool: Map<number, Cand>, rowid: number, fileName: string, text: string): Cand {
  const existing = pool.get(rowid);
  if (existing !== undefined) return existing;
  const created = { fileName, text, kwRank: null, vecRank: null };
  pool.set(rowid, created);
  return created;
}

function addKeywordCandidates(db: Database.Database, question: string, candidates: number, pool: Map<number, Cand>): void {
  const expression = ftsMatchExpr(questionTerms(question));
  if (expression === null) return;
  searchChunksFtsRanked(db, expression, candidates).forEach(([rowid, name, text], rank) => {
    pooledCandidate(pool, rowid, name, text).kwRank = rank;
  });
}

function vectorCandidates(
  db: Database.Database,
  questionEmbedding: readonly number[],
  candidates: number,
): Array<[number, number]> {
  const scored: Array<[number, number]> = [];
  forEachChunkEmbedding(db, (rowid, blob) => {
    const cosine = cosineSimilarityBlob(questionEmbedding, blob);
    if (cosine >= MIN_CHUNK_SIMILARITY) scored.push([rowid, cosine]);
  });
  scored.sort((left, right) => right[1] - left[1]);
  return scored.slice(0, candidates);
}

function addVectorCandidates(
  db: Database.Database,
  questionEmbedding: readonly number[],
  candidates: number,
  pool: Map<number, Cand>,
): void {
  const ranked = vectorCandidates(db, questionEmbedding, candidates);
  const rowids = ranked.map(([rowid]) => rowid).filter((rowid) => !pool.has(rowid));
  const hydrated = new Map(chunksByRowids(db, rowids).map(([rowid, name, text]) => [rowid, [name, text] as const]));
  ranked.forEach(([rowid], rank) => {
    const entry = pool.get(rowid);
    if (entry !== undefined) {
      entry.vecRank = rank;
      return;
    }
    const value = hydrated.get(rowid);
    if (value !== undefined) pooledCandidate(pool, rowid, value[0], value[1]).vecRank = rank;
  });
}

function reciprocalRank(candidate: Cand): number {
  const keyword = candidate.kwRank === null ? 0 : 1 / (RRF_K + candidate.kwRank);
  const vector = candidate.vecRank === null ? 0 : 1 / (RRF_K + candidate.vecRank);
  return keyword + vector;
}

function rankedContext(pool: ReadonlyMap<number, Cand>, exclude: ReadonlySet<number>, limit: number | null): ScoredChunk[] {
  const ranked: ScoredChunk[] = [];
  for (const [rowid, candidate] of pool) {
    if (!exclude.has(rowid)) {
      ranked.push({ rowid, fileName: candidate.fileName, text: candidate.text, score: reciprocalRank(candidate) });
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  return limit === null ? ranked : ranked.slice(0, limit);
}

function fallbackContext(db: Database.Database, limit: number | null): [ScoredChunk[], true] {
  const recent = recentChunks(db, limit ?? MAX_CONTEXT_CHUNKS).map(
    ([fileName, text]): ScoredChunk => ({ rowid: -1, fileName, text, score: 0 })
  );
  return [recent, true];
}

/**
 * As {@link retrieveContextExcluding}, but with the result count as a
 * parameter. `null` means every match, for callers that are SHOWING results
 * rather than spending a context window on them (#find): capping a search
 * result list at the six chunks a prompt can afford hides matches the user
 * came to see.
 *
 * The vector pass scores over (rowid, blob) only — no text shuttled, via
 * {@link forEachChunkEmbedding} + {@link cosineSimilarityBlob} — and hydrates
 * only the top candidates the keyword pass did not already provide (via
 * {@link chunksByRowids}), so a large room no longer allocates every chunk's
 * text per question.
 */
export function retrieveContextLimited(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null,
  exclude: ReadonlySet<number>,
  limit: number | null
): [ScoredChunk[], boolean] {
  // Rank enough candidates per signal to fill the requested result count; an
  // unlimited request pools everything the index can return, bounded by
  // MAX_VECTOR_CANDIDATES so hydration still fits SQLite's bind limit.
  const candidates = retrievalCandidateCount(limit);

  const pool = new Map<number, Cand>();
  addKeywordCandidates(db, question, candidates, pool);

  // Vector signal: brute-force cosine over (rowid, blob) — no text shuttled.
  // Pool only chunks AT OR ABOVE THE FLOOR, ranked by cosine -> RRF rank;
  // hydrate text for the winners not already present from the keyword pass.
  if (questionEmbedding !== null) {
    addVectorCandidates(db, questionEmbedding, candidates, pool);
  }

  // A real match means the pool was populated by keyword or above-floor
  // cosine hits — gate the fallback on that (BEFORE any exclusion) so
  // no-match questions still fall back and CHG-10 keeps refusing to credit
  // filler as a source.
  if (pool.size > 0) {
    // Every RRF-pooled chunk scores > 0; empty only when exclusion removed
    // all of them — the caller distinguishes that from a true no-match.
    return [rankedContext(pool, exclude, limit), false];
  }

  // Generic questions ("summarize this") match nothing; fall back to the most
  // recently added content so the model still sees the room.
  return fallbackContext(db, limit);
}
