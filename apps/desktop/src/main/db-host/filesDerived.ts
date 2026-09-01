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

export interface DerivedPreviewRef {
  id: string;
  sourceFileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKind: "blob" | "workspace";
  relativePath: string | null;
  /** Persisted generation route: Quick Look snapshot vs extracted/converted. */
  provenance: "snapshot" | "generated";
}

export function derivedPreviewRow(r: Row): DerivedPreviewRef {
  return {
    id: r[0] as string,
    sourceFileId: r[1] as string,
    name: r[2] as string,
    mimeType: (r[3] as string | null) ?? "application/octet-stream",
    sizeBytes: r[4] as number,
    storageKind: r[5] === "workspace" ? "workspace" : "blob",
    relativePath: r[6] as string | null,
    provenance: r[7] === "derived-preview-snapshot" ? "snapshot" : "generated",
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
    `SELECT id, derived_from, name, mime_type, size_bytes, storage_kind, relative_path, source
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
