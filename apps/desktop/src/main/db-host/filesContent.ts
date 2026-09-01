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
  clearChunks,
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
export function splitExt(name: string): [string, string] {
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
