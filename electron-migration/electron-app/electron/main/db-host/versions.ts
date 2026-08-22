/**
 * A deliberately NARROW slice of `src-tauri/src/db/versions.rs` (642 lines,
 * read in full). That Rust file is three unrelated features stapled together
 * under one name, and only part of one of them belongs in this batch:
 *
 *   1. FILE VERSION HISTORY (ADD-2) — `snapshot_file_version` + `VERSIONS_KEPT`
 *      (PORTED, below), and `set_file_provenance` (PORTED, below).
 *   2. password / maintenance — `verify_password`, `rekey`, `rekey_copy`,
 *      `vacuum`, `vacuum_into`, `reclaimable_bytes`, `open_in_memory_schema`.
 *      ALREADY PORTED as `rekey.ts` (its header cites the same line range).
 *   3. recovery key — `write_recovery`, `recover_password`,
 *      `open_with_recovery`, `has_recovery`, `remove_recovery` and the
 *      surrounding PBKDF2/AES-GCM code. ALREADY PORTED as `recovery.ts`.
 *
 * WHY `snapshotFileVersion` IS HERE. The assigned function was
 * `set_file_provenance`, which depends on nothing but `executeOne`. But
 * `artifacts.ts`'s `commitStaged` — ported whole in the same batch — calls
 * `snapshot_file_version` directly on every regeneration, and cannot reproduce
 * the Rust behaviour without it: skipping it would silently turn every
 * "AI regenerated" version into a plain overwrite, which is precisely the
 * destruction the ART-1 funnel exists to prevent. So it is ported here as a
 * hard dependency of an in-scope caller.
 *
 * NOT PORTED, left for a deliberate future batch: `set_version_pinned`,
 * `delete_file_version`, `versions_bytes`, `list_file_versions`,
 * `version_provenance_json`, `get_version` — the History strip's whole
 * read/pin/delete surface. Nothing in this batch calls any of them, and
 * porting only the read half now would invite a second, inconsistent port
 * later. `versions.test.ts` and `artifacts.test.ts` therefore read
 * `file_versions` back with raw SQL wherever the Rust tests went through those
 * readers — the same stand-in convention `files.test.ts`'s own header
 * documents.
 *
 * NOT FOLDED INTO `artifacts.ts`: both functions here are about the
 * `file_versions` table and the `files.provenance` column, a distinct concern
 * from artifacts.rs's staging funnel (which merely CALLS one of them). Keeping
 * them in the module named after the Rust file that owns them means the batch
 * that ports the rest of `versions.rs` extends this file rather than untangling
 * two intermingled ones.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`: every read/write goes through
 * `queryOpt`/`executeOne` rather than a bare `db.prepare` call site, rows are
 * read positionally via `.raw()` matching Rust's `r.get(i)` order, and a reused
 * Rust `?N` becomes a `?` repeated in the params array in the order the
 * placeholders occur in the SQL text.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOpt } from "./util.js";

/** How many UNPINNED versions of one file the room keeps. Pinned versions sit
 * outside this window entirely (see the `pinned` column in `schema.sql`; the
 * pin/unpin toggle itself is not ported yet, but the prune below already
 * respects it). Exported so the History strip can STATE the number rather than
 * letting the user discover it by losing the eleventh save. */
export const VERSIONS_KEPT = 10;

/**
 * Copy a file's CURRENT state into history before it is overwritten, labelled
 * with `cause`, then keep only the newest {@link VERSIONS_KEPT} UNPINNED
 * versions of that file.
 *
 * The snapshot is compound — bytes, extracted text, and any recording meta —
 * because for a Recording the bytes are the unchanged WAV and what is being
 * replaced IS the transcript: restoring bytes alone could never bring the old
 * words, speakers, or cuts back.
 *
 * A file with no stored bytes yet, or no row at all, has nothing to preserve
 * and is a silent no-op.
 */
export function snapshotFileVersion(
  db: Database.Database,
  fileId: string,
  cause: string
): void {
  const current = queryOpt(
    db,
    "SELECT original_bytes, extracted_text, provenance FROM files WHERE id = ?",
    [fileId],
    (r) => ({
      bytes: r[0] as Buffer | null,
      text: r[1] as string | null,
      provenance: r[2] as string | null,
    })
  );
  if (current === null || current.bytes === null) {
    return;
  }
  const { bytes, text, provenance } = current;
  // The Rust source ends this read in `.ok()`: a missing `recordings` row (the
  // overwhelming majority of files are not recordings) reads as `None`, which
  // is exactly what `queryOpt` already returns for "no row" — no try/catch is
  // needed to get the same "no recording → no rec_meta" behaviour.
  const recMeta = queryOpt(
    db,
    "SELECT meta FROM recordings WHERE file_id = ?",
    [fileId],
    (r) => r[0] as string
  );
  executeOne(
    db,
    `INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), fileId, bytes, text, recMeta, cause, provenance]
  );
  // A PINNED version is neither counted nor deleted: pinning it is the user
  // saying "this is the one I might need back", and a rolling window that could
  // still evict it would be a promise the room does not keep.
  executeOne(
    db,
    `DELETE FROM file_versions WHERE file_id = ? AND pinned = 0 AND id NOT IN (
       SELECT id FROM file_versions WHERE file_id = ? AND pinned = 0
       ORDER BY saved_at DESC, rowid DESC LIMIT ${VERSIONS_KEPT})`,
    [fileId, fileId]
  );
}

/**
 * Point a file's CURRENT provenance at `json`, or clear it with `null`.
 *
 * Deliberately `executeOne`, not `executeExisting`: this is the tail of a write
 * that has already succeeded (the file's own content is in), so an id that
 * matches nothing must not turn a completed save into a reported failure. It
 * takes raw JSON rather than a `Provenance` because the caller that needs it
 * most — restoring a saved version — copies the string stored ON that version
 * across verbatim, and re-encoding it would risk the head claiming a shape the
 * version never had.
 */
export function setFileProvenance(
  db: Database.Database,
  fileId: string,
  json: string | null
): void {
  executeOne(db, "UPDATE files SET provenance = ? WHERE id = ?", [json, fileId]);
}
