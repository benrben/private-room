/**
 * `list_file_versions` — the ONE reader off `src-tauri/src/db/versions.rs`
 * (642 lines) this batch needs. `versions.ts`'s own module doc lists it among
 * "NOT PORTED, left for a deliberate future batch: ... `list_file_versions`
 * ... — the History strip's whole read/pin/delete surface. Nothing in this
 * batch calls any of them" — that was true of the batch that wrote it, and is
 * no longer true of this one: `commands/jobs/file_pass.rs`'s own
 * `#[cfg(test)]` module calls `db::list_file_versions` directly (see
 * `publish_replays_onto_the_same_file_instead_of_duplicating_it`, ported to
 * `filePass_b.test.ts`), to prove that replaying `publish` overwrites the
 * same file as an undoable VERSION rather than minting a duplicate.
 *
 * A new `_b`-suffixed file rather than an addition to `versions.ts`, which
 * this batch did not create and may not modify — the same reason
 * `sidecarJsonCancellable_b.ts` is its own file rather than a change to
 * `sidecar.ts`.
 *
 * Scoped to exactly this one reader, matching `versions.ts`'s own
 * "porting only the read half now would invite a second, inconsistent port
 * later" caution — that caution is about `set_version_pinned`/
 * `delete_file_version`/`version_provenance_json`/`get_version`, none of
 * which any test in this batch's scope calls; only `list_file_versions` does,
 * so only it is ported here.
 *
 * Reuses `apiTypes.ts`'s already-camelCase `FileVersion` (field-for-field the
 * Rust `FileVersion` in `commands.rs`) rather than declaring a second, and
 * `artifacts.ts`'s `provenanceFromJson` for the provenance column, exactly as
 * `db/versions.rs`'s own row mapper reuses `serde_json::from_str` rather than
 * hand-rolling a second provenance parse.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { FileVersion } from "../../shared/apiTypes.js";
import { queryRows, type Row } from "./util.js";
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
    `SELECT v.id, v.saved_at, v.cause, v.provenance, v.pinned, LENGTH(v.bytes)
     FROM file_versions v JOIN files f ON f.id = v.file_id
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
