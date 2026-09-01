import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import {
  executeExisting,
  executeOne,
  queryOne,
  queryOpt,
  queryRows,
  type Row,
  type RowMapper,
} from "./util.js";
import { likeAllClause, likeEscape, searchTerms } from "./messages.js";
import * as obs from "../obs.js";

export const CHUNK_TARGET_CHARS = 1200;

/** HLT-4: hard cap on chunks indexed per file. A file that hits it is only
 * partially searchable; `FileMeta.partiallyIndexed` surfaces that live via a
 * chunk-count check, so this cap and that flag must agree.
 *
 * Was 2000 (~2M chars) — a 1,200-page Hebrew Bible overflowed it and its last
 * books silently missed the index. 20,000 chunks covers any real document. */
export const CHUNK_CAP = 20_000;

/** Column list shared by every FileMeta query: the base row plus folder_id
 * and a live chunk count for `partiallyIndexed` (HLT-4). Kept as one constant
 * so the row mapper's indices always line up with the SELECT. */
export const FILE_META_COLS =
  "f.id, f.name, f.mime_type, f.size_bytes, f.source, " +
  "f.extracted_text, f.created_at, f.folder_id, " +
  "(SELECT count(*) FROM chunks WHERE file_id = f.id), f.origin_url, f.ai_summary, " +
  "f.origin_destination, f.library_visibility";

/** Trash: the clause that makes a query mean "files that are in this room".
 * Written once so the dozens of listing/search/count queries that must
 * exclude deleted files all say the same thing. Assumes the `files` table is
 * aliased `f` — the shape `FILE_META_COLS` already forces. Queries that don't
 * alias spell the clause out inline. */
export const NOT_TRASHED = "f.trashed_at IS NULL";
/** A missing normal workspace file keeps its private history/stable id in the
 * database, but is not currently in the room. User-facing inventories must
 * therefore hide it just as they hide trash. Blob rooms are unchanged. */
export const LIVE_FILE = `${NOT_TRASHED} AND NOT (f.storage_kind = 'workspace' AND f.index_state = 'offline')`;

/** Derived files used only to draw an original in the viewer.  This uses the
 * existing destination column instead of adding another schema field.  Other
 * `derived_from` files (translations, reports, transcripts) remain ordinary
 * user-visible files. */
export const DERIVED_PREVIEW_DESTINATION = "preview";
export const NOT_DERIVED_PREVIEW = `f.origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'`;

/** Mirrors the Rust `FileMeta` struct (`commands.rs`, `#[serde(rename_all =
 * "camelCase")]`), which is field-for-field the `FileMeta` in
 * `shared/apiTypes.ts` — a file row goes out to the frontend unchanged. */
export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  hasText: boolean;
  createdAt: string;
  /** ADD-16: owning folder, or null when the file sits at the top level. */
  folderId: string | null;
  /** HLT-4: true when indexing hit the chunk cap, so only the first part of
   * the file is searchable. Derived live from the chunk count, no column. */
  partiallyIndexed: boolean;
  /** BROWSE-2/BROWSE-3: the address this file arrived from, or null for
   * anything that came off this Mac. */
  originUrl: string | null;
  /** The cached one-liner from the auto-index filler or a manual
   * Summarize-room run. Null until that has run for this file. */
  aiSummary: string | null;
  /** Which destination MADE this file: "library", "sketch", "create",
   * "recordings". */
  originDestination: string;
  /** Whether Home's Library shows it: "linked" or "sectionOnly". */
  libraryVisibility: string;
}

/** Mirrors the Rust `TrashedFile` struct — one trashed file, for the trash
 * view. */
export interface TrashedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** When it was deleted (room-local ISO-8601, same clock as createdAt). */
  trashedAt: string;
  /** WHAT deleted it: "user" | "agent" | "app" | "unknown". Never blank. */
  trashedBy: string;
  /** WHICH one, when the kind alone isn't the answer. Null = not recorded. */
  trashedById: string | null;
  /** ADD-16: the folder it goes back to on restore, or null for top level. */
  folderId: string | null;
}

/** db.rs's `file_meta_row`: the row mapper every FileMeta query shares. */
export function fileMetaRow(r: Row): FileMeta {
  const chunkCount = r[8] as number;
  return {
    id: r[0] as string,
    name: r[1] as string,
    mimeType: (r[2] as string | null) ?? "",
    sizeBytes: r[3] as number,
    source: r[4] as string,
    hasText: r[5] !== null,
    createdAt: r[6] as string,
    folderId: r[7] as string | null,
    // HLT-4: hitting the cap means only the first part is searchable.
    partiallyIndexed: chunkCount >= CHUNK_CAP,
    originUrl: r[9] as string | null,
    aiSummary: r[10] as string | null,
    originDestination: r[11] as string,
    libraryVisibility: r[12] as string,
  };
}

// ---------------------------------------------------------- chunking helpers
// extraction::chunking / extraction::pdf, ported only as far as insertChunks
// needs them — see the module comment's fidelity note.

/** UTF-8 byte length, which is what Rust's `str::len()` (and therefore every
 * `target_chars` comparison in `chunking.rs`) actually measures. */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Rust's `str::split_whitespace()`: splits on runs of Unicode whitespace,
 * yields no empty tokens, and gives nothing for an empty/whitespace-only
 * string. `\p{White_Space}`, not `\s` — see messages.ts's own copy of this
 * same reasoning (`\s` omits U+0085 NEL and adds U+FEFF, so the two really do
 * disagree in both directions). */
export function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

export function splitWords(s: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of splitWhitespace(s)) {
    if (current !== "" && byteLen(current) + byteLen(word) + 1 > target) {
      out.push(current);
      current = "";
    }
    if (current !== "") {
      current += " ";
    }
    current += word;
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

export function flushChunk(out: string[], current: string): string {
  if (current !== "") {
    out.push(current);
  }
  return "";
}

export function appendChunkLine(out: string[], current: string, rawLine: string, target: number): string {
  const line = rawLine.trim();
  if (line === "") {
    return current;
  }
  if (byteLen(line) > target) {
    flushChunk(out, current);
    out.push(...splitWords(line, target));
    return "";
  }
  if (current !== "" && byteLen(current) + byteLen(line) + 1 > target) {
    current = flushChunk(out, current);
  }
  return current === "" ? line : `${current}\n${line}`;
}

/** Cut a paragraph that is bigger than a chunk on its own — LINES first,
 * falling back to words only for a line that is itself longer than a chunk.
 * A spreadsheet row, a log line, a table row is the structure the reader and
 * the model navigate by, and it survives for the same reason the paragraph
 * split does. */
export function splitByLen(s: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const rawLine of s.split("\n")) {
    current = appendChunkLine(out, current, rawLine, target);
  }
  flushChunk(out, current);
  return out;
}

export function nonEmptyParagraphs(text: string): string[] {
  const normalized = text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
  return normalized
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

export function appendChunkParagraph(out: string[], current: string, paragraph: string, target: number): string {
  if (current !== "" && byteLen(current) + byteLen(paragraph) > target) {
    current = flushChunk(out, current);
  }
  if (byteLen(paragraph) > target * 2) {
    out.push(...splitByLen(paragraph, target));
    return current;
  }
  return current === "" ? paragraph : `${current}\n\n${paragraph}`;
}

/** Split text into ~targetChars (really bytes — see module comment) chunks
 * along paragraph boundaries. CRLF is normalized FIRST, or nothing below sees
 * a boundary at all: a Windows-authored document separates its paragraphs
 * with "\r\n\r\n" and would otherwise arrive as one wall of text with every
 * row and line boundary gone. */
export function chunkText(text: string, targetChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of nonEmptyParagraphs(text)) {
    current = appendChunkParagraph(chunks, current, paragraph, targetChars);
  }
  flushChunk(chunks, current);
  return chunks;
}

/** Hebrew combining marks: cantillation (0591-05AF) + points (05B0-05C7),
 * excluding the punctuation characters inside that block (maqaf, paseq, sof
 * pasuq, nun hafukha). */
export function isHebrewMarkRange(code: number): boolean {
  return code >= 0x0591 && code <= 0x05c7;
}

export function isHebrewBlockPunctuation(code: number): boolean {
  return code === 0x05be || code === 0x05c0 || code === 0x05c3 || code === 0x05c6;
}

export function isHebMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return isHebrewMarkRange(code) && !isHebrewBlockPunctuation(code);
}

/** Drop nikud + cantillation. The FTS tokenizer (unicode61) treats these
 * combining marks as SEPARATORS, so a pointed word like קֹהֶלֶת indexes as
 * meaningless single-letter fragments and a plain קהלת query can never
 * match — search text must be consonantal. Exported: `retrieval.ts`'s
 * `questionTerms` needs the exact same stripping for the QUESTION side of a
 * search, and must not reimplement it or the two sides would disagree about
 * what "the same word" is. */
export function stripHebrewMarks(text: string): string {
  const chars = Array.from(text);
  if (!chars.some(isHebMark)) {
    return text;
  }
  return chars.filter((ch) => !isHebMark(ch)).join("");
}

// -------------------------------------------------------- transaction helper

/**
 * Run `body` inside a transaction — unless the caller already opened one (the
 * batch-edit path in `commands::edit_match` wraps several writes of its own,
 * and SQLite has no nested `BEGIN`).
 *
 * Two things ride on this. A file row and its search chunks must land
 * TOGETHER: written separately, a failure partway through indexing reported
 * the import as failed while leaving the file in the library, only partly
 * searchable and with nothing marking it. And a book-length file produces
 * thousands of chunk INSERTs, each its own commit and its own disk write —
 * one transaction turns that back into one.
 *
 * `pub(crate)` in Rust; exported here (a mild visibility widening —
 * TypeScript has no module-private-but-test-visible concept) so the ported
 * test `a_write_and_its_index_land_together_or_not_at_all` can call it
 * directly, exactly as the Rust test does via `use super::*`.
 */
export function inTransaction<T>(db: Database.Database, body: () => T): T {
  if (db.inTransaction) {
    return body();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort, mirrors the Rust `let _ = conn.execute_batch("ROLLBACK")`
    }
    throw e;
  }
}

/**
 * Chunk `text` (if any) into the search index for `fileId`. Hebrew
 * nikud/cantillation are stripped first — see {@link stripHebrewMarks}.
 *
 * Trash: a TRASHED file's chunks are written to `trashed_chunks` instead of
 * the live index. This is not a detail — the background OCR and transcription
 * workers finish long after the import that queued them, and a file deleted
 * in the meantime would otherwise have its freshly extracted text indexed
 * into a room that is no longer showing the file. Routing here (rather than
 * at the three call sites) keeps the invariant the retrieval queries depend
 * on — `chunks` holds only the text of files that are IN the room — true by
 * construction. It also keeps the stash current, so a restore months later
 * brings back the text the file actually has, not the text it had when it was
 * deleted.
 *
 * LOAD-BEARING ATOMICITY: a book-length import is up to `CHUNK_CAP` rows, and
 * each row also fires the `chunks_fts_ai` trigger. One autocommitted insert
 * per chunk meant one fsync per chunk — seconds of import turned into
 * minutes — and a failure part-way through left the file HALF-indexed, which
 * reads as "the search index has this document" while most of it is missing.
 * A SAVEPOINT (not BEGIN: `updateFileContent`/`setFileExtractedText` and the
 * commit-plans/restore-version paths already hold a transaction when they
 * reach here, and SAVEPOINTs nest) makes the whole chunking one atomic,
 * one-fsync unit, and one prepared statement is compiled rather than one per
 * row. On failure the savepoint is rolled back so "indexed" never half-means
 * it, and the error is rethrown.
 *
 * Exported beyond Rust's `pub(crate)` for the same test-visibility reason as
 * {@link inTransaction}.
 */
export function insertChunks(db: Database.Database, fileId: string, text: string | null): void {
  if (text === null) {
    return;
  }
  // A missing row reads as "not trashed": the only caller that can be in that
  // position is `insertFileFromUrl`, which has just written the row.
  const trashed =
    queryOpt(
      db,
      "SELECT trashed_at IS NOT NULL FROM files WHERE id = ?",
      [fileId],
      (r) => r[0] === 1
    ) ?? false;
  const sql = trashed
    ? "INSERT INTO trashed_chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)"
    : "INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)";
  const stripped = stripHebrewMarks(text);
  const sp = `chunk_${randomUUID().replace(/-/g, "")}`;
  db.exec(`SAVEPOINT "${sp}"`);
  try {
    const stmt = db.prepare(sql);
    const pieces = chunkText(stripped, CHUNK_TARGET_CHARS).slice(0, CHUNK_CAP);
    pieces.forEach((chunk, seq) => {
      stmt.run(randomUUID(), fileId, seq, chunk);
    });
  } catch (e) {
    // Roll the partial index back so "indexed" never half-means it.
    try {
      db.exec(`ROLLBACK TO "${sp}"; RELEASE "${sp}"`);
    } catch {
      // best-effort, mirrors the Rust `let _ = conn.execute_batch(...)`
    }
    throw e;
  }
  db.exec(`RELEASE "${sp}"`);
}

/** Drop a file's search chunks from BOTH the live index and the trash stash,
 * ahead of re-indexing it. Every content rewrite goes through here: clearing
 * only `chunks` would leave a trashed file's stash holding the text it had
 * when it was deleted, and a restore would put that stale text back into the
 * index beside the file's real, newer content. */
export function clearChunks(db: Database.Database, fileId: string): void {
  executeOne(db, "DELETE FROM chunks WHERE file_id = ?", [fileId]);
  executeOne(db, "DELETE FROM trashed_chunks WHERE file_id = ?", [fileId]);
}

/** Today's date as YYYY-MM-DD, from SQLite so it matches stored timestamps.
 * Any failure reads as `""` — the Rust source's `.unwrap_or_default()`, kept
 * because every caller treats this as a label, not a checked value. */
export function currentDate(db: Database.Database): string {
  try {
    return queryOne(db, "SELECT strftime('%Y-%m-%d','now')", [], (r) => r[0] as string);
  } catch {
    return "";
  }
}

/** ADD-22: a short "(Files in this room: …)" hint appended to file-not-found
 * errors, so a small model can correct the name from the real list instead of
 * guessing again. Best-effort (Rust: `.unwrap_or_default()`) and capped at 10
 * names, so it can never fail — or bloat — the tool result it decorates. */
export function fileNamesHint(db: Database.Database): string {
  let names: string[];
  try {
    names = queryRows(
      db,
      "SELECT name FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 10",
      [],
      (r) => r[0] as string
    );
  } catch {
    names = [];
  }
  if (names.length === 0) {
    return " This room has no files yet.";
  }
  return ` Files in this room: ${names.join(", ")}.`;
}

/** True when `table` has a column named `column` (used to guard ALTER TABLE
 * migrations so they run exactly once). `PRAGMA table_info` is read
 * positionally like every other query here: column 1 is the name, exactly
 * where the Rust source reads `r.get::<_, String>(1)`.
 *
 * Exported (Rust: `pub(crate)`) so the ported migration tests, which call it
 * directly via `use super::*`, can do the same. */
export function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = queryRows(db, `PRAGMA table_info(${table})`, [], (r) => r[1] as string);
  return cols.includes(column);
}

/** True when a table (or virtual table/view) named `name` exists. */
export function tableExists(db: Database.Database, name: string): boolean {
  const count = queryOne(
    db,
    "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    [name],
    (r) => r[0] as number
  );
  return count > 0;
}

/** CHG-33: normalize a search query for cache keying — lowercase, trim,
 * collapse internal whitespace — so exact repeats and case/spacing variants
 * share a row.
 *
 * Ported here because it is one of `db.rs`'s own top-level `pub(crate)`
 * helpers that part A deferred alongside the files/chunks ones. Its own Rust
 * doc comment ties it to the `web_searches` cache (`browse.rs`/`web_cache.rs`)
 * rather than to the files table, so it has no caller in this file yet. */
export function searchKey(query: string): string {
  return splitWhitespace(query).join(" ").toLowerCase();
}

// ======================================================================
// files.rs (SOURCE 1)
// ======================================================================

/** The two visibility values a file can carry, spelled once so the Rust
 * side, the commands and the UI can never drift into three spellings of one
 * word. */
export const LINKED = "linked";
export const SECTION_ONLY = "sectionOnly";

/** True when current file bytes belong on the normal filesystem, never in
 * `files.original_bytes`. Legacy-only writers use this as a fail-closed guard
 * so a missed hybrid call site cannot create an unopenable ghost row. */
export function isWorkspaceDatabase(db: Database.Database): boolean {
  return db.prepare(
    "SELECT 1 FROM meta WHERE key = 'room_kind' AND value = 'workspace-folder'",
  ).get() !== undefined;
}

/** The destinations {@link markSectionOnly} is called from today. NOT the
 * parameter's type — see that function's own comment for why the signature
 * stays as wide as Rust's while the LOG value is whitelisted. */
export const SECTION_ORIGINS = ["sketch", "create", "recordings"] as const;

/** Insert a new file row (plus its search-index chunks) and return its
 * metadata. */
