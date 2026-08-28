/**
 * File storage/metadata CRUD, listing, trash lifecycle, naming, dedup,
 * derived-file links, per-kind JSON metadata and full-text search. Ported
 * from `src-tauri/src/db/files.rs` (SOURCE 1), PLUS the handful of shared
 * helpers `src-tauri/src/db.rs` itself owns that are files/chunks-specific
 * and were deferred out of part A for exactly that reason (SOURCE 2):
 * `FILE_META_COLS`/`NOT_TRASHED`/`CHUNK_CAP`, `file_meta_row`,
 * `insert_chunks`, `clear_chunks`, `current_date`, `file_names_hint`,
 * `column_exists`, `table_exists`, `search_key`. They live here, alongside
 * the `files` table's own CRUD, because that is where the Rust source keeps
 * them conceptually — `db.rs`'s own top section, directly above the table
 * that is their only real caller.
 *
 * ESTABLISHED CONVENTIONS reused from part A (see `util.ts`'s module comment
 * for the full rationale): every read/write goes through `queryOne`/
 * `queryOpt`/`queryRows`/`executeOne`/`executeExisting` rather than a bare
 * `db.prepare` call site; rows are read positionally via `.raw()` (`Row`),
 * matching the Rust mappers' `r.get(i)` order column-for-column so the SQL
 * stays a character-for-character copy of the Rust SQL; a reused Rust `?1`
 * becomes a `?` repeated in the params array. Raw `db.prepare` appears in
 * exactly one place — {@link emptyTrash}, whose bulk delete has no equivalent
 * in the single-row utility helpers.
 *
 * `searchTerms`/`likeAllClause`/`likeEscape` come from `messages.ts` rather
 * than being re-spelled: {@link filesNameLike} and `messagesLike` are two
 * halves of ONE search box (`search_all` runs both off one text), and the
 * Rust bug they were written to close was precisely the two disagreeing about
 * whether a `_` in the needle is a wildcard.
 *
 * CHUNKING PRIMITIVES — `chunk_text`/`strip_hebrew_marks` fidelity.
 * {@link insertChunks} depends on two `extraction::*` helpers that are not
 * their own module in this port yet. `migrate.ts` already carries private
 * copies for its own one-time re-chunking repairs, and documents a deliberate
 * approximation there: Rust's `target_chars` comparisons are against `.len()`
 * — UTF-8 BYTES, despite the name, as `chunking.rs`'s own
 * `multibyte_text_does_not_split_inside_a_character` test says out loud — and
 * migrate.ts measures JS `.length` (UTF-16 code units) instead, ruling exact
 * byte parity "not part of migrate's own contract". That ruling does NOT
 * carry over here: this file's copy is the PRIMARY, every-file-write chunking
 * path rather than a one-time repair, and the byte/UTF-16 gap is exactly
 * two-to-one for Hebrew — a first-class language for this app, and the very
 * text {@link stripHebrewMarks} exists to prepare. So these copies measure
 * true UTF-8 byte length for every size comparison, matching `chunking.rs`
 * exactly. Flagged for whoever eventually factors a shared `chunking.ts`: a
 * file re-chunked by `migrate.ts`'s repair path and the same file chunked by
 * {@link insertFile} here can land on different chunk boundaries for
 * non-ASCII text until the two copies become one.
 */

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

// ======================================================================
// db.rs's own file/chunk-table constants and shared helpers (SOURCE 2)
// ======================================================================

/** Target chunk size (chars — really BYTES, see the module comment) for the
 * room's keyword search index. */
const CHUNK_TARGET_CHARS = 1200;

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
const FILE_META_COLS =
  "f.id, f.name, f.mime_type, f.size_bytes, f.source, " +
  "f.extracted_text, f.created_at, f.folder_id, " +
  "(SELECT count(*) FROM chunks WHERE file_id = f.id), f.origin_url, f.ai_summary, " +
  "f.origin_destination, f.library_visibility";

/** Trash: the clause that makes a query mean "files that are in this room".
 * Written once so the dozens of listing/search/count queries that must
 * exclude deleted files all say the same thing. Assumes the `files` table is
 * aliased `f` — the shape `FILE_META_COLS` already forces. Queries that don't
 * alias spell the clause out inline. */
const NOT_TRASHED = "f.trashed_at IS NULL";
/** A missing normal workspace file keeps its private history/stable id in the
 * database, but is not currently in the room. User-facing inventories must
 * therefore hide it just as they hide trash. Blob rooms are unchanged. */
const LIVE_FILE = `${NOT_TRASHED} AND NOT (f.storage_kind = 'workspace' AND f.index_state = 'offline')`;

/** Derived files used only to draw an original in the viewer.  This uses the
 * existing destination column instead of adding another schema field.  Other
 * `derived_from` files (translations, reports, transcripts) remain ordinary
 * user-visible files. */
export const DERIVED_PREVIEW_DESTINATION = "preview";
const NOT_DERIVED_PREVIEW = `f.origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'`;

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
function fileMetaRow(r: Row): FileMeta {
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
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Rust's `str::split_whitespace()`: splits on runs of Unicode whitespace,
 * yields no empty tokens, and gives nothing for an empty/whitespace-only
 * string. `\p{White_Space}`, not `\s` — see messages.ts's own copy of this
 * same reasoning (`\s` omits U+0085 NEL and adds U+FEFF, so the two really do
 * disagree in both directions). */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

function splitWords(s: string, target: number): string[] {
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

/** Cut a paragraph that is bigger than a chunk on its own — LINES first,
 * falling back to words only for a line that is itself longer than a chunk.
 * A spreadsheet row, a log line, a table row is the structure the reader and
 * the model navigate by, and it survives for the same reason the paragraph
 * split does. */
function splitByLen(s: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const rawLine of s.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (byteLen(line) > target) {
      if (current !== "") {
        out.push(current);
        current = "";
      }
      out.push(...splitWords(line, target));
      continue;
    }
    if (current !== "" && byteLen(current) + byteLen(line) + 1 > target) {
      out.push(current);
      current = "";
    }
    if (current !== "") {
      current += "\n";
    }
    current += line;
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

/** Split text into ~targetChars (really bytes — see module comment) chunks
 * along paragraph boundaries. CRLF is normalized FIRST, or nothing below sees
 * a boundary at all: a Windows-authored document separates its paragraphs
 * with "\r\n\r\n" and would otherwise arrive as one wall of text with every
 * row and line boundary gone. */
function chunkText(text: string, targetChars: number): string[] {
  const normalized = text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
  const chunks: string[] = [];
  let current = "";
  for (const rawPara of normalized.split("\n\n")) {
    const para = rawPara.trim();
    if (para === "") {
      continue;
    }
    if (current !== "" && byteLen(current) + byteLen(para) > targetChars) {
      chunks.push(current);
      current = "";
    }
    // A single huge paragraph still needs to be cut somewhere.
    if (byteLen(para) > targetChars * 2) {
      for (const piece of splitByLen(para, targetChars)) {
        chunks.push(piece);
      }
    } else {
      if (current !== "") {
        current += "\n\n";
      }
      current += para;
    }
  }
  if (current.trim() !== "") {
    chunks.push(current);
  }
  return chunks;
}

/** Hebrew combining marks: cantillation (0591-05AF) + points (05B0-05C7),
 * excluding the punctuation characters inside that block (maqaf, paseq, sof
 * pasuq, nun hafukha). */
function isHebMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x0591 || code > 0x05c7) {
    return false;
  }
  return !(code === 0x05be || code === 0x05c0 || code === 0x05c3 || code === 0x05c6);
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
const SECTION_ORIGINS = ["sketch", "create", "recordings"] as const;

/** Insert a new file row (plus its search-index chunks) and return its
 * metadata. */
export function insertFile(
  db: Database.Database,
  name: string,
  mime: string,
  bytes: Uint8Array,
  text: string | null,
  source: string
): FileMeta {
  return insertFileFromUrl(db, name, mime, bytes, text, source, null);
}

/** BROWSE-2 (D19): like {@link insertFile}, recording where the bytes came
 * from. Every file that arrived over the network keeps its source URL. */
export function insertFileFromUrl(
  db: Database.Database,
  name: string,
  mime: string,
  bytes: Uint8Array,
  text: string | null,
  source: string,
  originUrl: string | null
): FileMeta {
  if (isWorkspaceDatabase(db)) {
    throw new Error("Workspace rooms must create current files through WorkspaceService.");
  }
  const id = randomUUID();
  inTransaction(db, () => {
    executeOne(
      db,
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text, origin_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, mime, bytes.length, source, Buffer.from(bytes), text, originUrl]
    );
    insertChunks(db, id, text);
  });
  return getFileMeta(db, id);
}

/**
 * File this object under the destination that made it, visible only there.
 *
 * Called straight after the insert by the tool-native creation paths (a new
 * sketch, a finished generation) — never by import, never by the browser's
 * Save, never by a generator writing an ordinary artifact. Those all belong
 * to the room at large and stay in the Library, which is what the column
 * defaults already say.
 *
 * Best-effort by design: the file itself is already safely in the room, and a
 * failure here means it shows up in Home as well as in its section. That is a
 * tidiness fault, not a data one, so it must not fail the creation that just
 * succeeded — but it IS logged, because a file quietly appearing in two
 * places is otherwise unexplainable after the fact.
 *
 * `origin` stays a plain `string`, as wide as Rust's `&'static str`, so a
 * future destination needs no signature change. The LOG value is narrowed
 * instead, via `obs.oneOf` against {@link SECTION_ORIGINS}: obs deliberately
 * refuses to log a runtime string (see obs.ts's privacy-boundary comment),
 * and a destination missing from that whitelist is recorded as `unexpected`
 * rather than smuggled into the log file.
 */
export function markSectionOnly(db: Database.Database, id: string, origin: string): void {
  try {
    executeOne(
      db,
      "UPDATE files SET origin_destination = ?, library_visibility = ? WHERE id = ?",
      [origin, SECTION_ONLY, id]
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    obs.warn("file.section_only.failed", [
      ["origin", obs.oneOf(origin, SECTION_ORIGINS)],
      ["err", obs.errKind(message)],
    ]);
  }
}

/**
 * Show (or stop showing) this file in Home's Library.
 *
 * Idempotent in both directions — it states the value rather than toggling
 * it, so pressing "Add to Library" twice cannot mint anything and pressing
 * "Remove" on a file that was never linked is simply a no-op. Nothing about
 * the object itself moves: same row, same id, same bytes, same history, same
 * name, same origin destination. Only whether Home lists it.
 */
export function setLibraryVisibility(db: Database.Database, id: string, linked: boolean): void {
  executeExisting(
    db,
    "UPDATE files SET library_visibility = ? WHERE id = ? AND trashed_at IS NULL",
    [linked ? LINKED : SECTION_ONLY, id],
    "That file is not in this room any more."
  );
}

/** The id and name of a file already holding EXACTLY these bytes, if any.
 * `size_bytes` is checked first so the blob comparison only ever runs against
 * same-sized rows. */
export function fileWithSameBytes(
  db: Database.Database,
  bytes: Uint8Array
): [string, string] | null {
  return queryOpt(
    db,
    `SELECT id, name FROM files
     WHERE trashed_at IS NULL AND size_bytes = ? AND original_bytes = ? LIMIT 1`,
    [bytes.length, Buffer.from(bytes)],
    (r) => [r[0] as string, r[1] as string]
  );
}

/** List every file's metadata, newest first. */
export function listFiles(db: Database.Database): FileMeta[] {
  return queryRows(
    db,
    `SELECT ${FILE_META_COLS} FROM files f WHERE ${LIVE_FILE}
     ORDER BY f.created_at DESC, f.rowid DESC`,
    [],
    fileMetaRow
  );
}

/**
 * Files the renderer may present anywhere in the room UI. Unlike Home's
 * Library query this deliberately includes section-only Sketches, Creations,
 * recordings, and similar user files; their destination views all derive from
 * the renderer's one shared inventory. Internal stored preview objects remain
 * hidden because they are implementation bytes, not user documents.
 */
export function listPublicFiles(db: Database.Database): FileMeta[] {
  return queryRows(
    db,
    `SELECT ${FILE_META_COLS} FROM files f
     WHERE ${LIVE_FILE} AND ${NOT_DERIVED_PREVIEW}
     ORDER BY f.created_at DESC, f.rowid DESC`,
    [],
    fileMetaRow
  );
}

/** Files Home's Library may show.  Internal inventories deliberately keep
 * using {@link listFiles}; a stored renderer preview is a room implementation
 * detail, not a second document row. */
export function listLibraryFiles(db: Database.Database): FileMeta[] {
  return queryRows(
    db,
    `SELECT ${FILE_META_COLS} FROM files f
     WHERE ${LIVE_FILE} AND ${NOT_DERIVED_PREVIEW} AND f.library_visibility = 'linked'
     ORDER BY f.created_at DESC, f.rowid DESC`,
    [],
    fileMetaRow
  );
}

export function libraryFileCount(db: Database.Database): number {
  return queryOne(
    db,
    `SELECT count(*) FROM files f
     WHERE ${LIVE_FILE} AND ${NOT_DERIVED_PREVIEW} AND f.library_visibility = 'linked'`,
    [],
    (r) => r[0] as number
  );
}

/**
 * How many files are in this room — the ONE definition of THAT question
 * (`roomCounts`/RoomInfo, the front page's file count).
 *
 * It is not what the Library badge counts, and the two are allowed to differ.
 * "In this room" means exactly what {@link listFiles} lists, which is why
 * this carries the same `NOT_TRASHED` clause and nothing else. The Library is
 * a narrower question — which files Home LISTS — answered in exactly one
 * place, `isLibraryVisible` in src/workspace/fileVisibility.ts, which also
 * drops the `sectionOnly` rows a sketch or a browser page can be. A room with
 * nine linked files and three section-only sketches is twelve files and a
 * badge of nine, and both numbers are true of what they name.
 *
 * A count is a claim about the same population the list shows, so the two
 * must be derived from one predicate or they drift: before this existed the
 * counts were a bare `count(*) FROM files`, and trash landed with the
 * listings filtered but the counts not.
 *
 * Nothing is excluded by KIND (owner's ruling, 2026-08-03).
 */
export function roomFileCount(db: Database.Database): number {
  return queryOne(
    db,
    `SELECT count(*) FROM files f WHERE ${LIVE_FILE}`,
    [],
    (r) => r[0] as number
  );
}

/**
 * How many files ARRIVED since `since` — the workflow condition
 * `new_files_since_last_run`.
 *
 * Deliberately NOT {@link roomFileCount} with a date on it: `source =
 * 'generated'` is excluded because a workflow that writes a file into the
 * room would otherwise see its own output as new work and run again forever.
 * That exclusion is about causation, not about what the room contains, which
 * is why this is a second named question rather than an argument to the
 * first. It does share the trash clause — "three new files" for three files
 * the user imported and then deleted would start a run over nothing.
 */
export function newSourceFileCount(db: Database.Database, since: string): number {
  return queryOne(
    db,
    `SELECT count(*) FROM files f
     WHERE f.source != 'generated' AND f.created_at > ? AND ${NOT_TRASHED}`,
    [since],
    (r) => r[0] as number
  );
}

/** (display name, mime, size bytes, cached one-liner, [origin_destination,
 * library_visibility]) for one file row — feeds the agent's `list_room_files`
 * tool. ADD-16: a filed document reads as "Folder/name". CHG-23: the cached
 * ai_summary rides along so the tool can show what each file is without a
 * search round-trip. The last field is the two placement columns TOGETHER,
 * because the agent has to be able to tell a section-only object from a
 * Library one before it offers to promote either. */
export type FileBriefRow = [string, string, number, string | null, [string, string]];

export function listFilesBrief(db: Database.Database): FileBriefRow[] {
  return queryRows(
    db,
    `SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
            coalesce(f.mime_type,''), f.size_bytes, f.ai_summary,
            f.origin_destination, f.library_visibility
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE ${LIVE_FILE}
     ORDER BY f.created_at`,
    [],
    (r): FileBriefRow => [
      r[0] as string,
      r[1] as string,
      r[2] as number,
      r[3] as string | null,
      [r[4] as string, r[5] as string],
    ]
  );
}

/** How a file's placement reads in a tool result: nothing at all for an
 * ordinary Library file (the overwhelming majority — a note on every row
 * would be noise the model pays for on every listing), and an explicit
 * "section only in X" for one that Home is not showing. */
export function placementNote(origin: string, visibility: string): string {
  if (visibility === SECTION_ONLY) {
    return ` [section only — in ${origin}, not in the Library]`;
  }
  return "";
}

/** (display name, mime type, one-liner) for the 100 NEWEST files — feeds the
 * model's file inventory in the system prompt. CHG-9: newest-first (was
 * oldest-first, which hid exactly the files the user just added), and one
 * extra row (LIMIT 101) acts as an overflow sentinel so the caller can flag a
 * partial list without a second COUNT. */
export function listFileInventory(
  db: Database.Database
): Array<[string, string, string | null]> {
  return queryRows(
    db,
    `SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
            coalesce(f.mime_type, ''), f.ai_summary
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE ${LIVE_FILE}
     ORDER BY f.created_at DESC, f.rowid DESC LIMIT 101`,
    [],
    (r) => [r[0] as string, r[1] as string, r[2] as string | null]
  );
}

/** ADD-17: one file's fields needed to build the room summary. `text` is a
 * ~1500-char probe (clipped in SQL) used to detect empty extractions — the
 * summarizer loads the full text separately per file (ADD-27), so the listing
 * stays cheap. `aiSummary` is the cached one-liner (null → still needs
 * summarizing). `folder` is the owning folder's name. */
export interface SummaryFile {
  id: string;
  name: string;
  mime: string;
  source: string;
  folder: string | null;
  text: string | null;
  aiSummary: string | null;
}

/** ADD-17: every file with the fields the summarizer needs, grouped by folder
 * (top-level files last) then creation order, so the file list reads
 * sensibly. */
export function listFilesForSummary(db: Database.Database): SummaryFile[] {
  return queryRows(
    db,
    `SELECT f.id, f.name, coalesce(f.mime_type,''), f.source, fo.name,
            substr(f.extracted_text, 1, 1500), f.ai_summary
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.trashed_at IS NULL
     ORDER BY (fo.name IS NULL), fo.name COLLATE NOCASE, f.created_at ASC`,
    [],
    (r) => ({
      id: r[0] as string,
      name: r[1] as string,
      mime: r[2] as string,
      source: r[3] as string,
      folder: r[4] as string | null,
      text: r[5] as string | null,
      aiSummary: r[6] as string | null,
    })
  );
}

/** ADD-17: cache a file's generated one-liner so re-runs skip it. */
export function setFileAiSummary(db: Database.Database, id: string, summary: string): void {
  executeOne(db, "UPDATE files SET ai_summary = ? WHERE id = ?", [summary, id]);
}

/** Room map: record that `id` was MADE from `sourceFileId`. Written by the
 * generators that actually know their input (a full pass, a translated
 * transcript) — a post-insert setter rather than another {@link insertFile}
 * parameter, so the existing insert call sites stay untouched.
 *
 * Self-reference is refused: a file cannot be made from itself, and a
 * self-loop would draw as a link the map can't explain. */
export function setDerivedFrom(db: Database.Database, id: string, sourceFileId: string): void {
  if (id === sourceFileId) {
    return;
  }
  executeOne(db, "UPDATE files SET derived_from = ? WHERE id = ?", [sourceFileId, id]);
}

export interface DerivedPreviewRef {
  id: string;
  sourceFileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKind: "blob" | "workspace";
  relativePath: string | null;
}

function derivedPreviewRow(r: Row): DerivedPreviewRef {
  return {
    id: r[0] as string,
    sourceFileId: r[1] as string,
    name: r[2] as string,
    mimeType: (r[3] as string | null) ?? "application/octet-stream",
    sizeBytes: r[4] as number,
    storageKind: r[5] === "workspace" ? "workspace" : "blob",
    relativePath: r[6] as string | null,
  };
}

/** Mark an already-created file as the hidden renderer preview for an
 * original. This is intentionally separate from generic `setDerivedFrom` so
 * generated reports and translations are never hidden or lifecycle-cascaded. */
export function markDerivedPreview(
  db: Database.Database,
  id: string,
  sourceFileId: string,
): void {
  if (id === sourceFileId) throw new Error("A file cannot preview itself.");
  inTransaction(db, () => {
    executeExisting(
      db,
      `UPDATE files SET derived_from = ?, origin_destination = ?, library_visibility = 'sectionOnly',
          folder_id = (SELECT folder_id FROM files src WHERE src.id = ?),
          extracted_text = NULL, ai_summary = NULL, index_state = 'unsupported', index_error = NULL
       WHERE id = ? AND trashed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM files src WHERE src.id = ? AND src.trashed_at IS NULL
             AND src.origin_destination <> ?
         )`,
      [sourceFileId, DERIVED_PREVIEW_DESTINATION, sourceFileId, id, sourceFileId, DERIVED_PREVIEW_DESTINATION],
      "The original or preview file is not in this room."
    );
    // Preview pixels are never a second search result for the same document.
    clearChunks(db, id);
  });
}

/** Every live preview for one original, newest first.  Multiple rows are
 * tolerated so regeneration can publish a replacement before removing the
 * stale one. */
export function derivedPreviews(
  db: Database.Database,
  sourceFileId: string,
  includeTrashed = false,
): DerivedPreviewRef[] {
  return queryRows(
    db,
    `SELECT id, derived_from, name, mime_type, size_bytes, storage_kind, relative_path
     FROM files
     WHERE derived_from = ? AND origin_destination = ?
       ${includeTrashed ? "" : "AND trashed_at IS NULL"}
     ORDER BY created_at DESC, rowid DESC`,
    [sourceFileId, DERIVED_PREVIEW_DESTINATION],
    derivedPreviewRow
  );
}

/** The current preview used to open an original, or null when none has been
 * generated. */
export function getDerivedPreview(
  db: Database.Database,
  sourceFileId: string,
): DerivedPreviewRef | null {
  return derivedPreviews(db, sourceFileId)[0] ?? null;
}

/** Room map: every recorded (source file, derived file) pair. Both ends are
 * checked to still exist, so a link never points at a deleted file — the
 * column carries no foreign key (it was added by ALTER, which cannot). Trash
 * counts as gone at BOTH ends: the map draws only what is in the room, and an
 * edge to a node the map isn't drawing is a line into nowhere. */
export function derivedLinks(db: Database.Database): Array<[string, string]> {
  return queryRows(
    db,
    `SELECT src.id, f.id FROM files f JOIN files src ON src.id = f.derived_from
     WHERE f.derived_from IS NOT NULL
       AND f.trashed_at IS NULL AND src.trashed_at IS NULL`,
    [],
    (r) => [r[0] as string, r[1] as string]
  );
}

/** Store what a probe read from a video's container (`MediaMeta` as JSON).
 * Only ever called with a probe that found SOMETHING: a probe that read
 * nothing leaves the column NULL, so "not probed yet" and "probed, all
 * unknown" stay distinguishable. */
export function setMediaMeta(db: Database.Database, id: string, json: string): void {
  executeOne(db, "UPDATE files SET media_meta = ? WHERE id = ?", [json, id]);
}

/** A file's stored technical metadata, or null when it has never been probed.
 * A missing row reads as null too — the caller's next step is to probe.
 *
 * Trashed reads as null for the reason {@link getFileMeta} spells out: the
 * viewer asks `probe_video_meta` for exactly this by id, and without the
 * clause a deleted video still answered with its real duration, size and
 * codec. */
export function getMediaMeta(db: Database.Database, id: string): string | null {
  return queryOpt(
    db,
    "SELECT media_meta FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as string | null
  );
}

/** Store what a saved web page declared about itself (`PageMeta` as JSON). A
 * page that declared nothing leaves the column NULL, so "not from the web"
 * and "from the web, said nothing about itself" never collapse into one
 * value. */
export function setWebMeta(db: Database.Database, id: string, json: string): void {
  executeOne(db, "UPDATE files SET web_meta = ? WHERE id = ?", [json, id]);
}

/** What a saved page said about itself, or null when this file did not come
 * from one. A missing row reads as null too, and so does a trashed one — the
 * title, author, site and capture date of a page ARE the page, and handing
 * them back by id would repopulate the viewer's strip for a file the room is
 * no longer showing. */
export function getWebMeta(db: Database.Database, id: string): string | null {
  return queryOpt(
    db,
    "SELECT web_meta FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as string | null
  );
}

/** CHG-22: files that still need a cached one-liner — (id, name, mime,
 * ~1500-char text probe). Skips images with no OCR (empty text) and the app's
 * own generated summary file. Feeds the background one-liner filler so the
 * work is done at ingest, not on the interactive Summarize-room path. */
export function filesMissingSummary(
  db: Database.Database,
  limit: number
): Array<[string, string, string, string]> {
  return queryRows(
    db,
    `SELECT id, name, coalesce(mime_type,''), substr(extracted_text, 1, 1500)
     FROM files
     WHERE trashed_at IS NULL
       AND ai_summary IS NULL
       AND extracted_text IS NOT NULL AND trim(extracted_text) <> ''
       AND NOT (name IN ('Room summary.md', 'Room summary.html') AND source = 'generated')
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit],
    (r) => [r[0] as string, r[1] as string, r[2] as string, r[3] as string]
  );
}

/** Wave 1b (idea 10): the NEWEST file whose name equals `name` exactly — any
 * source, so a user-made "Scratch pad.md" is adopted by the get-or-create
 * convention instead of being shadowed by a generated duplicate. */
export function fileByExactName(db: Database.Database, name: string): FileMeta | null {
  const rows = queryRows(
    db,
    `SELECT ${FILE_META_COLS} FROM files f WHERE f.name = ? AND ${LIVE_FILE}
     ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1`,
    [name],
    fileMetaRow
  );
  return rows[0] ?? null;
}

/** Split a file name into its stem and its extension (with the dot), the same
 * way `roomai::unique_name` does — "a.txt" -> ["a", ".txt"], "noext" ->
 * ["noext", ""], ".hidden" -> [".hidden", ""] since a leading dot is not an
 * extension. */
function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx > 0) {
    return [name.slice(0, idx), name.slice(idx)];
  }
  return [name, ""];
}

/**
 * `name`, or the first "stem (n).ext" no file in this room is using.
 *
 * Generated output used to reuse one fixed name per source, so re-running a
 * studio simply added a SECOND "Flashcards - clean-code.html", then a third —
 * same name, same icon, different content, and no way to tell which was the
 * run you wanted. Disambiguating at the moment of writing is the fix a user
 * already understands, because it is what Finder does.
 *
 * Compared case-insensitively: the library lists names, and two entries that
 * differ only in case read as the same duplicate to the person scanning it.
 *
 * A TRASHED file does not hold its name: the library isn't showing it, so
 * stepping the next save to "notes (2).md" because of something the user
 * deleted last week would be numbering around a file they cannot see.
 */
export function availableName(db: Database.Database, name: string): string {
  const [stem, ext] = splitExt(name);
  // "stem (%)ext", with LIKE's own wildcards escaped so a name containing %
  // or _ still matches only itself. `likeEscape` (messages.ts) escapes the
  // same three characters (`\`, `%`, `_`) the Rust source's local `esc`
  // closure did — reused rather than re-spelled.
  const pattern = `${likeEscape(stem)} (%)${likeEscape(ext)}`;
  const taken = queryRows(
    db,
    `SELECT lower(name) FROM files
     WHERE trashed_at IS NULL
       AND (lower(name) = lower(?) OR lower(name) LIKE lower(?) ESCAPE '\\')`,
    [name, pattern],
    (r) => r[0] as string
  );
  if (taken.length === 0) {
    return name;
  }
  const used = new Set(taken);
  if (!used.has(name.toLowerCase())) {
    return name;
  }
  let n = 2;
  for (;;) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
    n += 1;
  }
}

/**
 * Full metadata row for one file by id.
 *
 * Trashed files are NOT found here, and that is deliberate even though the
 * caller already holds an id. Ids outlive the library: they sit in open tabs,
 * in a chat message's `sources`, in a paused job's plan, in an agent's own
 * notes. If a by-id read kept working after a delete, every one of those
 * would quietly resurrect the file — the viewer would render it, a job would
 * summarize it, a cloud turn would carry its text — with nothing on screen
 * saying the file was in the trash. A miss here reads as "no longer in this
 * room", which is what actually happened.
 */
export function getFileMeta(db: Database.Database, id: string): FileMeta {
  return queryOne(
    db,
    `SELECT ${FILE_META_COLS} FROM files f WHERE f.id = ? AND ${LIVE_FILE}`,
    [id],
    fileMetaRow
  );
}

/** Just a file's name. */
export function getFileName(db: Database.Database, id: string): string {
  return queryOne(
    db,
    "SELECT name FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as string
  );
}

/**
 * A file's name whether or not it is in the trash — for RECEIPTS only.
 *
 * Deliberately separate from {@link getFileName}, which hides trashed rows
 * for the reason spelled out on {@link getFileMeta}. Naming one is the single
 * exception, because a batch restore or a batch destroy has to say WHICH
 * files it acted on, and by then the only rows it can name are trashed ones.
 * It returns a name and nothing else — no bytes, no text, no metadata — so it
 * cannot be the accidental route back into a deleted file.
 *
 * Null, not a throw: an id that names nothing is an ordinary outcome for a
 * batch (someone else's window may have destroyed it a second ago), and the
 * caller reports that per-file rather than failing the whole run.
 */
export function anyFileName(db: Database.Database, id: string): string | null {
  return queryOpt(db, "SELECT name FROM files WHERE id = ?", [id], (r) => r[0] as string);
}

/** Where this file came from, when it came over the network — null for
 * anything typed, imported from disk or generated in the room.
 *
 * Read on export so a downloaded file keeps the `com.apple.quarantine` mark
 * macOS shows its Gatekeeper warning off. */
export function fileOriginUrl(db: Database.Database, id: string): string | null {
  const url = queryOpt(
    db,
    "SELECT origin_url FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as string | null
  );
  if (url === null || url.trim() === "") {
    return null;
  }
  return url;
}

/** (name, mime type, bytes, extracted text) — the full payload needed to
 * serve or attach a file's content. */
export function getFileFull(
  db: Database.Database,
  id: string
): [string, string | null, Buffer | null, string | null] {
  return queryOne(
    db,
    `SELECT name, mime_type, original_bytes, extracted_text FROM files
     WHERE id = ? AND trashed_at IS NULL`,
    [id],
    (r) => [r[0] as string, r[1] as string | null, r[2] as Buffer | null, r[3] as string | null]
  );
}

/** (name, bytes) for one file. */
export function getFileBytesNamed(db: Database.Database, id: string): [string, Buffer | null] {
  return queryOne(
    db,
    "SELECT name, original_bytes FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => [r[0] as string, r[1] as Buffer | null]
  );
}

/** A file's stored bytes. */
export function getFileBytes(db: Database.Database, id: string): Buffer | null {
  return queryOne(
    db,
    "SELECT original_bytes FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as Buffer | null
  );
}

/** A file's extracted search text, if any. Missing row or missing text both
 * read as null — mirrors the original call site's error-swallowing. */
export function getFileExtractedText(db: Database.Database, id: string): string | null {
  return queryOpt(
    db,
    "SELECT extracted_text FROM files WHERE id = ? AND trashed_at IS NULL",
    [id],
    (r) => r[0] as string | null
  );
}

/** Overwrite a file's bytes and rebuild its search index. */
export function updateFileContent(
  db: Database.Database,
  id: string,
  bytes: Uint8Array,
  text: string | null
): void {
  if (isWorkspaceDatabase(db)) {
    throw new Error("Workspace files must update current bytes through WorkspaceService.");
  }
  inTransaction(db, () => {
    // ADD-17: content changed, so the cached one-liner is stale — clear it so
    // the next "Summarize room" run re-summarizes this file.
    executeOne(
      db,
      `UPDATE files SET original_bytes = ?, extracted_text = ?, size_bytes = ?,
           ai_summary = NULL
       WHERE id = ?`,
      [Buffer.from(bytes), text, bytes.length, id]
    );
    clearChunks(db, id);
    insertChunks(db, id, text);
  });
}

/** Update ONLY a file's extracted text (and its search index), leaving the
 * stored bytes alone — a live recording's periodic saves refresh the
 * transcript while the audio goes through the cheap checkpoint path. */
export function setFileExtractedText(db: Database.Database, id: string, text: string): void {
  inTransaction(db, () => {
    executeOne(db, "UPDATE files SET extracted_text = ?, ai_summary = NULL WHERE id = ?", [
      text,
      id,
    ]);
    clearChunks(db, id);
    insertChunks(db, id, text);
  });
}

// ---------------------------------------------------------------- trash / undo

/** Who deleted a file. Recorded at the moment of deletion, because "what did
 * the agent delete" cannot be reconstructed afterwards — and with "ask before
 * AI edits files" off by owner decision, it is the question the trash exists
 * to answer.
 *
 * Same shape as the MINIMAL stand-in `memories.ts` already carries (with an
 * explicit "replace once files.ts lands" TODO), so swapping that module over
 * to import from here is a pure re-export rather than a redesign. */
export type TrashActor =
  | { kind: "user" }
  | { kind: "agent"; who: string }
  | { kind: "app"; what: string };

/** (kind, id) as stored. The kind is a closed vocabulary the UI switches on;
 * the id is free-form and may be absent. Exported because `db::memories` (S9)
 * reuses the same actor type for its own soft-delete. */
export function trashActorParts(actor: TrashActor): [string, string | null] {
  switch (actor.kind) {
    case "user":
      return ["user", null];
    case "agent":
      return ["agent", actor.who];
    case "app":
      return ["app", actor.what];
  }
}

/**
 * Move a file to the room's trash: it leaves every listing, count, search and
 * retrieval path, but its row, its bytes, its version history and its
 * transcript all stay exactly where they are — inside the room's encryption
 * boundary. Nothing is written outside the room and nothing goes to the
 * system trash; "deleted" here means "flagged and unindexed", never "moved".
 *
 * The search chunks are MOVED to `trashed_chunks` rather than filtered in
 * place (see the table's comment in schema.sql) so retrieval cannot see the
 * file even through a query that forgot to ask, and so restore can put the
 * embeddings back verbatim.
 *
 * Trashing an already-trashed file is refused rather than silently
 * re-stamped: a second trash would overwrite the original actor and time —
 * losing the record of who actually deleted it — and would move an empty
 * chunk set over the real one, destroying the file's search index for good.
 * The affected-row count IS that answer, which is what `executeExisting`
 * checks.
 */
export function trashFile(db: Database.Database, id: string, actor: TrashActor): void {
  const [kind, actorId] = trashActorParts(actor);
  inTransaction(db, () => {
    executeExisting(
      db,
      `UPDATE files
       SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           trashed_by = ?, trashed_by_id = ?
       WHERE id = ? AND trashed_at IS NULL`,
      [kind, actorId, id],
      "That file is not in this room."
    );
    executeOne(
      db,
      `INSERT INTO trashed_chunks(id, file_id, seq, text, embedding)
       SELECT id, file_id, seq, text, embedding FROM chunks WHERE file_id = ?`,
      [id]
    );
    executeOne(db, "DELETE FROM chunks WHERE file_id = ?", [id]);
    // Renderer previews are hidden implementation files. They follow their
    // original into trash in the same transaction and never appear as a
    // second user action. Generic derived artifacts are intentionally not
    // included.
    executeOne(
      db,
      `UPDATE files SET trashed_at = (SELECT trashed_at FROM files WHERE id = ?),
          trashed_by = ?, trashed_by_id = ?
       WHERE derived_from = ? AND origin_destination = ? AND trashed_at IS NULL`,
      [id, kind, actorId, id, DERIVED_PREVIEW_DESTINATION]
    );
    executeOne(
      db,
      `INSERT INTO trashed_chunks(id, file_id, seq, text, embedding)
       SELECT c.id, c.file_id, c.seq, c.text, c.embedding
       FROM chunks c JOIN files p ON p.id = c.file_id
       WHERE p.derived_from = ? AND p.origin_destination = ?`,
      [id, DERIVED_PREVIEW_DESTINATION]
    );
    executeOne(
      db,
      `DELETE FROM chunks WHERE file_id IN
       (SELECT id FROM files WHERE derived_from = ? AND origin_destination = ?)`,
      [id, DERIVED_PREVIEW_DESTINATION]
    );
  });
}

/**
 * Put a trashed file back, whole: the row returns to every listing, and its
 * chunks (text AND embedding blob) go back into the search index, so the file
 * is findable by keyword and by vector the moment restore returns rather than
 * after some later background pass.
 *
 * Restoring something that is not in the trash is an error, not a no-op — a
 * UI that offers Restore on a file already in the library is showing a stale
 * list, and reporting success would confirm a state it never checked.
 */
export function restoreFile(db: Database.Database, id: string): void {
  inTransaction(db, () => {
    executeExisting(
      db,
      `UPDATE files SET trashed_at = NULL, trashed_by = NULL, trashed_by_id = NULL
       WHERE id = ? AND trashed_at IS NOT NULL`,
      [id],
      "That file is not in the trash."
    );
    executeOne(
      db,
      `INSERT INTO chunks(id, file_id, seq, text, embedding)
       SELECT id, file_id, seq, text, embedding FROM trashed_chunks WHERE file_id = ?`,
      [id]
    );
    executeOne(db, "DELETE FROM trashed_chunks WHERE file_id = ?", [id]);
    executeOne(
      db,
      `UPDATE files SET trashed_at = NULL, trashed_by = NULL, trashed_by_id = NULL
       WHERE derived_from = ? AND origin_destination = ? AND trashed_at IS NOT NULL`,
      [id, DERIVED_PREVIEW_DESTINATION]
    );
    executeOne(
      db,
      `INSERT INTO chunks(id, file_id, seq, text, embedding)
       SELECT c.id, c.file_id, c.seq, c.text, c.embedding
       FROM trashed_chunks c JOIN files p ON p.id = c.file_id
       WHERE p.derived_from = ? AND p.origin_destination = ?`,
      [id, DERIVED_PREVIEW_DESTINATION]
    );
    executeOne(
      db,
      `DELETE FROM trashed_chunks WHERE file_id IN
       (SELECT id FROM files WHERE derived_from = ? AND origin_destination = ?)`,
      [id, DERIVED_PREVIEW_DESTINATION]
    );
  });
}

/** One trashed file, for the trash view. {@link listFiles}' counterpart — and
 * the only query in the app that deliberately returns trashed rows. */
export function listTrashedFiles(db: Database.Database): TrashedFile[] {
  return queryRows(
    db,
    `SELECT id, name, coalesce(mime_type,''), size_bytes,
            trashed_at, coalesce(trashed_by,'unknown'), trashed_by_id, folder_id
     FROM files WHERE trashed_at IS NOT NULL AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'
     ORDER BY trashed_at DESC, rowid DESC`,
    [],
    (r) => ({
      id: r[0] as string,
      name: r[1] as string,
      mimeType: r[2] as string,
      sizeBytes: r[3] as number,
      trashedAt: r[4] as string,
      // A row trashed by a build that predates the actor column reads NULL,
      // which becomes 'unknown' — attributing it to the user would be a claim
      // the database cannot support.
      trashedBy: r[5] as string,
      trashedById: r[6] as string | null,
      folderId: r[7] as string | null,
    })
  );
}

/** How many files are in the trash. Its own query so the badge never has to
 * materialize the list. */
export function trashedFileCount(db: Database.Database): number {
  return queryOne(
    db,
    `SELECT count(*) FROM files WHERE trashed_at IS NOT NULL AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'`,
    [],
    (r) => r[0] as number
  );
}

/**
 * Destroy a file for good: the row, its bytes, its chunks, its stashed
 * trashed chunks, its version history and its transcript. There is no undo
 * past this point, which is why it is a separate function from
 * {@link trashFile} with a name that says so — no caller can reach it by
 * accident.
 *
 * The FK cascades (`chunks`, `trashed_chunks`, `file_versions`, `recordings`,
 * `rec_chunks`, `privacy_scans`) do the dependent rows; `foreign_keys` is ON
 * in every path that opens a room. Zero affected rows is reported as a miss
 * rather than as a successful delete.
 */
export function deleteFile(db: Database.Database, id: string): void {
  inTransaction(db, () => {
    executeOne(
      db,
      "DELETE FROM files WHERE derived_from = ? AND origin_destination = ?",
      [id, DERIVED_PREVIEW_DESTINATION]
    );
    executeExisting(db, "DELETE FROM files WHERE id = ?", [id], "That file is not in this room.");
  });
}

/** Permanently destroy everything in the trash. Returns how many files were
 * destroyed — the caller reports THAT number, so an empty trash reads as
 * "nothing to empty" instead of a cheerful "trash emptied".
 *
 * Hidden renderer previews are deleted too, but do not inflate the user-facing
 * count returned to the caller. */
export function emptyTrash(db: Database.Database): number {
  return inTransaction(db, () => {
    const visible = queryOne(
      db,
      `SELECT count(*) FROM files
       WHERE trashed_at IS NOT NULL AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'`,
      [],
      (r) => r[0] as number
    );
    db.prepare("DELETE FROM files WHERE trashed_at IS NOT NULL").run();
    return visible;
  });
}

/**
 * Rename a file.
 *
 * Zero affected rows means the file was deleted out from under the rename.
 * TRASHED counts as deleted, or the message would be a lie the one time it
 * matters: the agent's `rename_file` tool takes an id it may have been
 * holding since before the delete, and a rename that "worked" would silently
 * retitle a row only the trash view can see.
 *
 * ART-1: renaming a generated artifact releases its `artifact_key`. Giving a
 * file your own name is how you adopt it, and the next run of the generator
 * must mint a fresh file rather than version over the copy you kept.
 */
export function renameFile(db: Database.Database, id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("File name cannot be empty.");
  }
  executeExisting(
    db,
    "UPDATE files SET name = ?, artifact_key = NULL WHERE id = ? AND trashed_at IS NULL",
    [trimmed, id],
    "That file is no longer in this room."
  );
}

/** Files that carry no extracted text yet — candidates for a re-extraction
 * pass after an extractor is improved (e.g. the xlsx numeric-cell fix). Only
 * files with stored bytes are returned; OCR/STT candidates are left to their
 * own background workers. */
export function filesMissingText(
  db: Database.Database
): Array<[string, string, string, Buffer]> {
  return queryRows(
    db,
    `SELECT id, name, coalesce(mime_type,''), original_bytes FROM files
     WHERE trashed_at IS NULL
       AND (extracted_text IS NULL OR trim(extracted_text) = '')
       AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'
       AND original_bytes IS NOT NULL`,
    [],
    (r) => [
      r[0] as string,
      r[1] as string,
      r[2] as string,
      (r[3] as Buffer | null) ?? Buffer.alloc(0),
    ]
  );
}

/**
 * Every file with stored bytes, as (id, name, mime, original_bytes).
 *
 * Used by the re-extraction pass that runs after an extractor is CORRECTED
 * rather than merely extended. {@link filesMissingText} cannot find those
 * files: they already have text. The legacy `.doc`/`.ppt` readers used to
 * return the font table and binary noise, which is text by every measure the
 * database has, so those files sat in the search index with garbage in them
 * and nothing marking them as wrong.
 *
 * The caller filters by extension in TypeScript, with the same `extensionOf`
 * the extractors use — expressing "the part after the last dot" in SQL is a
 * trick rather than a statement, and the two must not be able to disagree.
 */
export function filesWithBytes(
  db: Database.Database
): Array<[string, string, string, Buffer]> {
  return queryRows(
    db,
    `SELECT id, name, coalesce(mime_type,''), original_bytes FROM files
     WHERE trashed_at IS NULL AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'
       AND original_bytes IS NOT NULL`,
    [],
    (r) => [
      r[0] as string,
      r[1] as string,
      r[2] as string,
      (r[3] as Buffer | null) ?? Buffer.alloc(0),
    ]
  );
}

/**
 * The one query behind all the fuzzy name finders: the NEWEST file whose name
 * contains `needle` (expected already lowercased). They differ only in the
 * columns they pull, whether the search is restricted to images, and whether
 * the app's OWN generated derivative outputs are excluded, so the
 * LIKE/ORDER BY/LIMIT shape lives here once. `cols`, `imagesOnly` and
 * `excludeDerived` are caller-supplied constants — `needle` stays a bound
 * parameter.
 *
 * `excludeDerived` hides the app's generated "Full pass — …" and "Room
 * summary" artifacts. Without it, a re-run resolves to the PREVIOUS output: a
 * "Full pass — clean-code.pdf.html" both contains the source's name AND is
 * newer than it, so `ORDER BY created_at DESC` returns the summary instead of
 * the book, and the pass re-summarizes its own tiny output.
 *
 * Throws (via `queryOne`) when nothing matches — every caller below turns
 * that into its own wording.
 */
function findNewestNamed<T>(
  db: Database.Database,
  cols: string,
  needle: string,
  imagesOnly: boolean,
  excludeDerived: boolean,
  map: RowMapper<T>
): T {
  const imageFilter = imagesOnly ? "AND mime_type LIKE 'image/%'" : "";
  // Same guard shape as `listFilesForSummary` — a generated artifact is
  // excluded; a user upload that happens to share the name is not.
  const derivedFilter = excludeDerived
    ? "AND NOT (source = 'generated' AND (name LIKE 'Full pass — %' OR name LIKE 'Room summary%'))"
    : "";
  return queryOne(
    db,
    // `created_at` is second-resolution, so two files added in the same second
    // tie and SQLite is free to return either. `rowid DESC` breaks the tie
    // toward the one added last — the same tiebreaker `fileByExactName` and
    // `listFiles` already use, so all three agree on "the newest match".
    `SELECT ${cols} FROM files
     WHERE lower(name) LIKE '%' || ? || '%'
       AND trashed_at IS NULL
       ${imageFilter}
       ${derivedFilter}
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [needle],
    map
  );
}

export function findFileLike(db: Database.Database, fragment: string): [string, string] {
  const needle = fragment.toLowerCase();
  try {
    return findNewestNamed(db, "id, name", needle, false, false, (r) => [
      r[0] as string,
      r[1] as string,
    ]);
  } catch {
    throw new Error(`No file matching "${fragment}" in this room.${fileNamesHint(db)}`);
  }
}

/**
 * {@link findFileLike}, but it also accepts the FOLDER-QUALIFIED name the
 * room hands out.
 *
 * THE ROUND-TRIP THIS CLOSES. {@link listFilesBrief} — which is what the
 * agent's `list_room_files` prints — renders a filed document as
 * `Invoices/q3.pdf`. Every matcher underneath searches the `name` COLUMN,
 * which holds `q3.pdf` alone. So the one string the model was just shown was
 * the one string it could not use.
 *
 * Order matters. The FULL string is tried first so a real file called
 * `notes/draft.md` (a slash is legal in a name) still wins over a same-named
 * file inside a `notes` folder; only when nothing matches is the last path
 * segment tried. Falling back first would silently prefer the wrong file.
 */
export function findFileLikeQualified(
  db: Database.Database,
  fragment: string
): [string, string] {
  try {
    return findFileLike(db, fragment);
  } catch (first) {
    const idx = fragment.lastIndexOf("/");
    if (idx === -1) {
      throw first;
    }
    const tail = fragment.slice(idx + 1).trim();
    // Empty tail ("Invoices/") names a folder, not a file — retrying on ""
    // would match the newest file in the room, which is a confident wrong
    // answer where an error is the honest one.
    if (tail === "") {
      throw first;
    }
    try {
      return findFileLike(db, tail);
    } catch {
      throw first;
    }
  }
}

/** Like {@link findFileLike}, but excludes the app's own generated "Full
 * pass — …" and "Room summary" outputs — used to resolve the SOURCE file for
 * a whole-file pass so a re-run never picks the previous run's (newer,
 * name-matching) result. */
export function findSourceFileLike(db: Database.Database, fragment: string): [string, string] {
  const needle = fragment.toLowerCase();
  try {
    return findNewestNamed(db, "id, name", needle, false, true, (r) => [
      r[0] as string,
      r[1] as string,
    ]);
  } catch {
    throw new Error(`No source file matching "${fragment}" in this room.${fileNamesHint(db)}`);
  }
}

/** Same fuzzy match as {@link findFileLike}, also returning extracted text —
 * used by the agent's open_file tool. Unlike {@link findFileLike}, the caller
 * is expected to have already lowercased `needle` (and reuses it verbatim in
 * its own error message), so this does no lowercasing of its own. */
export function findFileLikeFull(
  db: Database.Database,
  needle: string
): [string, string, string | null] {
  try {
    return findNewestNamed(db, "id, name, extracted_text", needle, false, false, (r) => [
      r[0] as string,
      r[1] as string,
      r[2] as string | null,
    ]);
  } catch {
    throw new Error(`No file matching "${needle}" in this room.${fileNamesHint(db)}`);
  }
}

/** Fuzzy match restricted to images — used by the agent's mark_image tool.
 * Like {@link findFileLikeFull}, expects an already-lowercased `needle`. */
export function findImageLike(db: Database.Database, needle: string): [string, string, Buffer] {
  try {
    return findNewestNamed(db, "id, name, original_bytes", needle, true, false, (r) => [
      r[0] as string,
      r[1] as string,
      (r[2] as Buffer | null) ?? Buffer.alloc(0),
    ]);
  } catch {
    throw new Error(`No image matching "${needle}" in this room.`);
  }
}

/** ADD-6: file rows whose name contains EVERY word of `needle` (already
 * lowercased), in any order — see `searchTerms`.
 *
 * The words are taken LITERALLY: `likeEscape` + `ESCAPE '\'`, the same
 * pairing `messagesLike` uses. `search_all` runs all three searches off one
 * text, so while only the message query escaped, searching "report_2026"
 * matched literally under Messages and wildcarded under Files in the SAME
 * result list. */
export function filesNameLike(db: Database.Database, needle: string): Array<[string, string]> {
  const terms = searchTerms(needle);
  if (terms.length === 0) {
    return [];
  }
  const sql = `SELECT id, name FROM files WHERE trashed_at IS NULL${likeAllClause("name", terms)}
     ORDER BY created_at DESC LIMIT 20`;
  return queryRows(db, sql, terms, (r) => [r[0] as string, r[1] as string]);
}

/** ADD-6: file content hits via FTS — (file id, name, matching chunk text) for
 * the best-ranked chunk. The caller trims a snippet out of the chunk text.
 *
 * The only reason this is not `searchChunksFtsRanked` (embeddings.ts) with
 * columns dropped: the search overlay OPENS the file it lists, so it needs
 * `f.id`, and the ranked variant returns the CHUNK rowid instead (the key its
 * keyword/vector blend scores on). Same MATCH/ORDER BY/LIMIT shape
 * otherwise — tune one and tune the other. */
export function filesContentFts(
  db: Database.Database,
  matchExpr: string,
  limit: number
): Array<[string, string, string]> {
  return queryRows(
    db,
    `SELECT f.id, f.name, c.text
     FROM chunks_fts
     JOIN chunks c ON c.rowid = chunks_fts.rowid
     JOIN files f ON f.id = c.file_id
     WHERE chunks_fts MATCH ? AND f.trashed_at IS NULL
     ORDER BY bm25(chunks_fts)
     LIMIT ?`,
    [matchExpr, limit],
    (r) => [r[0] as string, r[1] as string, r[2] as string]
  );
}
