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
  fileMetaRow,
  inTransaction,
  insertChunks,
  isWorkspaceDatabase,
  searchKey,
  type FileMeta,
  type TrashedFile,
} from "./filesModel.js";

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
