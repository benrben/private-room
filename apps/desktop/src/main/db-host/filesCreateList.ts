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

import {
  CHUNK_CAP,
  DERIVED_PREVIEW_DESTINATION,
  FILE_META_COLS,
  LINKED,
  LIVE_FILE,
  NOT_DERIVED_PREVIEW,
  NOT_TRASHED,
  SECTION_ONLY,
  SECTION_ORIGINS,
  columnExists,
  currentDate,
  fileMetaRow,
  inTransaction,
  insertChunks,
  isWorkspaceDatabase,
  searchKey,
  type FileMeta,
  type TrashedFile,
} from "./filesModel.js";
import { getFileMeta } from "./filesContent.js";

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
