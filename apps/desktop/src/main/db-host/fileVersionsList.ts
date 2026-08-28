/**
 * `list_file_versions` off `src-tauri/src/db/versions.rs` (642 lines), PLUS —
 * as of the `commands/safety.rs` batch — the rest of the read/pin/delete
 * surface that module's own doc named as deliberately deferred:
 * `get_version`, `set_version_pinned`, `delete_file_version`,
 * `version_provenance_json`. `versions.ts`'s header calls this out by name as
 * the shape the follow-up would take ("porting only the read half now would
 * invite a second, inconsistent port later" — this file is that follow-up),
 * and `db-host/rekey.test.ts`'s own header independently points the same
 * checkpoint-rekey bookkeeping at "that module's own future port", i.e. this
 * one. `versions_bytes` is still NOT ported: nothing in `commands/safety.rs`
 * calls it (the History strip's per-file disk-usage line is a different,
 * uncalled command), so porting it now would be scope creep with no test to
 * anchor it.
 *
 * A new `_b`-suffixed-in-spirit extension of an EXISTING file rather than a
 * fresh one this time — unlike `list_file_versions`' own arrival here (which
 * explicitly avoided touching `versions.ts`, a file that batch did not
 * create) — because this file's own header already earmarked itself as the
 * landing spot for exactly this extension, and a second reader/writer module
 * for the same table would just be two places to keep in sync.
 *
 * Reuses `apiTypes.ts`'s already-camelCase `FileVersion` (field-for-field the
 * Rust `FileVersion` in `commands.rs`) rather than declaring a second, and
 * `artifacts.ts`'s `provenanceFromJson` for the provenance column, exactly as
 * `db/versions.rs`'s own row mapper reuses `serde_json::from_str` rather than
 * hand-rolling a second provenance parse.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { FileVersion } from "../../shared/apiTypes.js";
import { executeExisting, queryOpt, queryRows, type Row } from "./util.js";
import { provenanceFromJson } from "./artifacts.js";

/**
 * Every saved version of a file, newest first — the room's undo trail for
 * that one file. Ported verbatim from `db::list_file_versions`: a trashed
 * file (of any file whose versions dangle after the OWNING file was
 * removed — the join enforces it still exists) yields none, the same "gone
 * means gone" rule `getFileMeta` documents. `saved_at` has one-second
 * resolution, so a loop of snapshots ties on it and `rowid DESC` is the real
 * tiebreak — newest write wins, matching every other newest-first query in
 * this directory.
 */
export function listFileVersions(db: Database.Database, fileId: string): FileVersion[] {
  return queryRows(
    db,
    `SELECT v.id, v.saved_at, v.cause, v.provenance, v.pinned,
            COALESCE(o.size_bytes, LENGTH(v.bytes))
     FROM file_versions v JOIN files f ON f.id = v.file_id
     LEFT JOIN content_object_refs r
       ON r.owner_type = 'file_version' AND r.owner_id = v.id AND r.role = 'content'
     LEFT JOIN content_objects o ON o.id = r.object_id
     WHERE v.file_id = ? AND f.trashed_at IS NULL
     ORDER BY v.saved_at DESC, v.rowid DESC`,
    [fileId],
    rowToFileVersion
  );
}

function rowToFileVersion(r: Row): FileVersion {
  const rawProvenance = r[3] as string | null;
  const provenance = rawProvenance !== null ? (provenanceFromJson(rawProvenance) ?? undefined) : undefined;
  const out: FileVersion = {
    id: r[0] as string,
    savedAt: r[1] as string,
    cause: r[2] as string,
    pinned: (r[4] as number) !== 0,
    bytes: r[5] as number,
  };
  if (provenance !== undefined) {
    out.provenance = provenance;
  }
  return out;
}

/** What a command says when handed a version id that no longer resolves — the
 * History strip's own tab may be stale, or the row was deleted outright.
 * Ported from `db::set_version_pinned`/`delete_file_version`/`get_version`'s
 * shared error text. */
export const VERSION_NOT_AVAILABLE = "That version is no longer available.";

/** Pin or unpin one saved version (the History strip's "Keep" toggle). Throws
 * {@link VERSION_NOT_AVAILABLE} when the id is not a version of a live file,
 * so an unpin from a stale tab cannot silently do nothing while reporting
 * success. Ported from `db::set_version_pinned`. */
export function setVersionPinned(db: Database.Database, versionId: string, pinned: boolean): void {
  executeExisting(
    db,
    "UPDATE file_versions SET pinned = ? WHERE id = ?",
    [pinned ? 1 : 0, versionId],
    VERSION_NOT_AVAILABLE
  );
}

/** Delete ONE saved version outright — the History strip's per-row delete.
 * Deliberately not undoable (there is no history of the history), which is
 * why the UI confirms first. Ported from `db::delete_file_version`. */
export function deleteFileVersion(db: Database.Database, versionId: string): void {
  executeExisting(db, "DELETE FROM file_versions WHERE id = ?", [versionId], VERSION_NOT_AVAILABLE);
}

/** The provenance stored ON a saved version, as raw JSON (or `null` when
 * there is none, OR the version id resolves to nothing at all — both read as
 * "nothing to restore", matching `db::version_provenance_json`'s
 * `.ok().flatten()`). Restoring a version restores what made it too, so the
 * head never claims a run that produced different bytes. */
export function versionProvenanceJson(db: Database.Database, versionId: string): string | null {
  return queryOpt(
    db,
    "SELECT provenance FROM file_versions WHERE id = ?",
    [versionId],
    (r) => r[0] as string | null
  );
}

/** One saved version's full compound snapshot. `text`/`recMeta` are `null` on
 * rows saved before the compound snapshot existed. Deliberately NOT joined
 * against `files.trashed_at` — unlike {@link listFileVersions}, a version id
 * held by an open History tab still resolves here even after its file is
 * trashed (see `restoreVersionInto`'s own guard, which is where the
 * trashed-file refusal actually lives). Ported from `db::get_version`. */
export interface VersionRow {
  fileId: string;
  bytes: Buffer;
  text: string | null;
  recMeta: string | null;
}

export function getVersion(db: Database.Database, versionId: string): VersionRow {
  const row = queryOpt(
    db,
    "SELECT file_id, bytes, text, rec_meta FROM file_versions WHERE id = ?",
    [versionId],
    (r) => ({
      fileId: r[0] as string,
      bytes: r[1] as Buffer,
      text: r[2] as string | null,
      recMeta: r[3] as string | null,
    })
  );
  if (row === null) {
    throw new Error(VERSION_NOT_AVAILABLE);
  }
  return row;
}
