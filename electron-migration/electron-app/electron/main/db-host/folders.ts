/**
 * ADD-16: one flat level of folders a file can sit inside. Port of the WHOLE
 * `src-tauri/src/db/folders.rs` (218 lines): `listFolders`, `createFolder`,
 * `renameFolder`, `deleteFolder`, `moveFileToFolder`, plus the private
 * blank-name/clash/`FOLDER_GONE` helpers they share.
 *
 * The `folders` table and `files.folder_id` were already in `schema.sql` —
 * this is the first port of the code that reads and writes them. Until now
 * `files.test.ts` stood the create/move paths in with direct SQL against the
 * table (see that file's own "ADAPTED" header note); nothing new needs to.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`/`files.ts` (see those module
 * comments for the full rationale): every read/write goes through
 * `queryOpt`/`queryRows`/`executeOne`/`executeExisting`/`executeUnique`
 * rather than a bare `db.prepare` call site; rows are read positionally via
 * `.raw()`, matching Rust's `r.get(i)` order; and a reused Rust `?N` becomes a
 * `?` repeated in the params array in the ORDER the placeholders occur in the
 * SQL TEXT, not the order `params![…]` lists them. `renameFolder` is the
 * example to read twice: the Rust SQL is `SET name = ?2 WHERE id = ?1` against
 * `params![id, name]`, so the array here is `[name, id]`.
 *
 * `inTransaction` is imported from `files.ts` rather than re-declared — it is
 * the one transaction helper this directory shares, and `deleteFolder` needs
 * exactly the already-in-a-transaction nesting it provides.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import {
  executeExisting,
  executeOne,
  executeUnique,
  queryOpt,
  queryRows,
  type Row,
} from "./util.js";
import { inTransaction } from "./files.js";

/** Mirrors the Rust `Folder` struct (`commands.rs`, `#[serde(rename_all =
 * "camelCase")]`), which is field-for-field the `Folder` in
 * `shared/apiTypes.ts` — a folder row goes out to the frontend unchanged. */
export interface Folder {
  id: string;
  name: string;
}

function folderRow(r: Row): Folder {
  return { id: r[0] as string, name: r[1] as string };
}

/** Every folder in the room, alphabetically and case-insensitively — the
 * sidebar's own order. */
export function listFolders(db: Database.Database): Folder[] {
  return queryRows(
    db,
    "SELECT id, name FROM folders ORDER BY name COLLATE NOCASE ASC",
    [],
    folderRow
  );
}

function rejectBlankFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Folder name cannot be empty.");
  }
  return trimmed;
}

function folderNameTaken(name: string): string {
  return `A folder named "${name}" already exists.`;
}

/** What every folder write says when the row it was aimed at is gone — the
 * sidebar can be a moment out of date (the assistant's `organize_files` removes
 * folders too), and answering Ok to a write that found nothing left the user
 * looking at a list that disagreed with what they had just been told. */
const FOLDER_GONE = "That folder no longer exists.";

/** The folders table's UNIQUE index is case-SENSITIVE, so "Legal" and "legal"
 * could both exist and look identical in the sidebar. Reject the clash here.
 * `exceptId` lets a rename keep its own current name (including a pure change
 * of capitalization, which is a legitimate rename). */
function folderNameClashes(
  db: Database.Database,
  name: string,
  exceptId: string | null
): boolean {
  return (
    queryOpt(
      db,
      "SELECT 1 FROM folders WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1",
      [name, exceptId, exceptId],
      () => true
    ) ?? false
  );
}

/** Create a folder. Names are UNIQUE (and, here, unique ignoring case), so a
 * clash is reported in plain language. */
export function createFolder(db: Database.Database, name: string): Folder {
  const trimmed = rejectBlankFolderName(name);
  if (folderNameClashes(db, trimmed, null)) {
    throw new Error(folderNameTaken(trimmed));
  }
  const id = randomUUID();
  executeUnique(db, "INSERT INTO folders(id, name) VALUES (?, ?)", [id, trimmed], () =>
    folderNameTaken(trimmed)
  );
  return { id, name: trimmed };
}

/** Rename a folder. Trimmed, refused blank, refused onto another folder's
 * name — but a folder may always be re-capitalized into its own. */
export function renameFolder(db: Database.Database, id: string, name: string): void {
  const trimmed = rejectBlankFolderName(name);
  if (folderNameClashes(db, trimmed, id)) {
    throw new Error(folderNameTaken(trimmed));
  }
  // The clash is refused above, so a zero-row UPDATE here can only mean the
  // folder was removed since the sidebar drew it — reporting "renamed" then is
  // a claim about a folder that is not in the list that follows.
  executeExisting(db, "UPDATE folders SET name = ? WHERE id = ?", [trimmed, id], FOLDER_GONE);
}

/** Delete a folder. Its files are moved back to the top level (folder_id →
 * NULL) FIRST — deleting a folder must never delete or hide files (ADD-16).
 * Both writes are one transaction: a failure between them used to leave the
 * folder in place with every file already emptied out of it. */
export function deleteFolder(db: Database.Database, id: string): void {
  inTransaction(db, () => {
    // Zero rows here is legitimate — an empty folder.
    executeOne(db, "UPDATE files SET folder_id = NULL WHERE folder_id = ?", [id]);
    executeExisting(db, "DELETE FROM folders WHERE id = ?", [id], FOLDER_GONE);
  });
}

/**
 * Move a file into a folder, or to the top level when `folderId` is null.
 *
 * Both ends are checked: a folder removed since the Move menu opened would
 * otherwise take the file out of the sidebar entirely (listed under no folder,
 * and not at the top level), and a trashed or absent file would answer "moved"
 * having moved nothing.
 */
export function moveFileToFolder(
  db: Database.Database,
  fileId: string,
  folderId: string | null
): void {
  if (folderId !== null) {
    const exists = queryOpt(db, "SELECT 1 FROM folders WHERE id = ?", [folderId], () => true);
    if (exists === null) {
      throw new Error(FOLDER_GONE);
    }
  }
  executeExisting(
    db,
    "UPDATE files SET folder_id = ? WHERE id = ? AND trashed_at IS NULL",
    [folderId, fileId],
    "That file is no longer in this room."
  );
}
