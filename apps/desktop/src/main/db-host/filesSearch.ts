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
  columnExists,
  currentDate,
  fileNamesHint,
  fileMetaRow,
  inTransaction,
  insertChunks,
  isWorkspaceDatabase,
  searchKey,
  type FileMeta,
  type TrashedFile,
} from "./filesModel.js";

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
export function findNewestNamed<T>(
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
