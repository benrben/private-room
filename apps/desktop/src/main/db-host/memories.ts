/**
 * Room memories: freeform notes the assistant (or the user) has saved, with
 * Wave-1b categories and S9 soft-delete. Ported from
 * `src-tauri/src/db/memories.rs`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeExisting, executeOne, queryOne, queryRows, type Row } from "./util.js";
import { likeAllClause, searchTerms } from "./messages.js";

/** Mirrors the Rust `Memory` struct (`commands.rs`, `#[serde(rename_all =
 * "camelCase")]`), which is field-for-field the `Memory` in
 * `shared/apiTypes.ts` — a memory row goes out to the frontend unchanged. */
export interface Memory {
  id: string;
  content: string;
  /** Wave 1b (idea 5): preference | fact | project | instruction, or `null` =
   * uncategorized (every pre-category row). Callers normalize the value;
   * organizational only in v1 — prompt injection stays content-only. */
  category: string | null;
  createdAt: string;
}

// TODO: replace with the real export once `files.ts` lands. `deleteMemory`
// takes Rust's `TrashActor` (`src-tauri/src/db/files.rs`, `pub(crate)`, reused
// by `db/memories.rs`'s soft-delete for the same reason `trash_file` uses it)
// — a `db/files.rs` concern out of scope for this batch. This is a MINIMAL
// mirror of that enum and its `.parts()` method, reusing the exact three-kind
// vocabulary and (kind, id) shape the memory rows already store, so what this
// stamps into `trashed_by`/`trashed_by_id` already agrees with whatever
// `files.ts` lands with. It is not new persistence design.

/** Who deleted something. */
export type TrashActor =
  /** A person clicked delete. */
  | { kind: "user" }
  /** The AI deleted it on its own. Carries the agent/tool that did it, so the
   * answer is "the Files agent's delete_file", not just "the AI". */
  | { kind: "agent"; who: string }
  /** The app's own housekeeping. Carries the command responsible. */
  | { kind: "app"; what: string };

/** (kind, id) as stored. The kind is a closed vocabulary the UI switches on;
 * the id is free-form and may be absent. */
function trashActorParts(actor: TrashActor): [string, string | null] {
  switch (actor.kind) {
    case "user":
      return ["user", null];
    case "agent":
      return ["agent", actor.who];
    case "app":
      return ["app", actor.what];
  }
}

// ------------------------------------------------------------------ memories

/** ADD-6: memories containing every word of `needle` (which the caller has
 * already lowercased), in any order — [memory id, content]. The words are
 * taken LITERALLY; `searchTerms`/`likeAllClause` are imported from
 * `messages.ts` rather than re-spelled, because all of `search_all`'s queries
 * have to agree about what one needle means. */
export function memoriesLike(db: Database.Database, needle: string): Array<[string, string]> {
  const terms = searchTerms(needle);
  if (terms.length === 0) {
    return [];
  }
  const sql = `SELECT id, content FROM memories WHERE trashed_at IS NULL${likeAllClause(
    "content",
    terms
  )}
     ORDER BY created_at DESC LIMIT 30`;
  return queryRows(db, sql, terms, (r) => [r[0] as string, r[1] as string]);
}

/** Wave 1b (idea 5): `category` is one of preference|fact|project|instruction
 * (callers normalize via `normalizeCategory`), or `null` = uncategorized. */
export function addMemory(
  db: Database.Database,
  content: string,
  category: string | null
): Memory {
  const id = randomUUID();
  executeOne(db, "INSERT INTO memories(id, content, category) VALUES (?, ?, ?)", [
    id,
    content,
    category,
  ]);
  const createdAt = queryOne(
    db,
    "SELECT created_at FROM memories WHERE id = ?",
    [id],
    (r) => r[0] as string
  );
  return { id, content, category, createdAt };
}

function memoryRow(r: Row): Memory {
  return {
    id: r[0] as string,
    content: r[1] as string,
    category: r[2] as string | null,
    createdAt: r[3] as string,
  };
}

export function listMemories(db: Database.Database): Memory[] {
  return queryRows(
    db,
    `SELECT id, content, category, created_at FROM memories
     WHERE trashed_at IS NULL ORDER BY created_at ASC`,
    [],
    memoryRow
  );
}

/** S9 (2026-08-04): soft delete, same shape as `trash_file`/`restore_file` —
 * the row, its content and its history stay exactly where they are; only a
 * flag changes. `deleteMemory` was the app's one truly irreversible AI action
 * (every file write has a snapshot; this had nothing). Trashing an
 * already-trashed memory is refused rather than re-stamped, for the same
 * reason `trash_file` refuses it: a second trash would overwrite the record of
 * who actually deleted it. */
export function deleteMemory(db: Database.Database, id: string, actor: TrashActor): void {
  const [kind, actorId] = trashActorParts(actor);
  executeExisting(
    db,
    `UPDATE memories
     SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         trashed_by = ?, trashed_by_id = ?
     WHERE id = ? AND trashed_at IS NULL`,
    [kind, actorId, id],
    "That memory is not in this room."
  );
}

/** Put a trashed memory back — same "error, not a no-op" reasoning as
 * `restore_file`: a caller offering Restore on a memory already active is
 * showing a stale list, and silently succeeding would confirm a state it never
 * checked. Not exposed to the agent — recovery is a human action. */
export function restoreMemory(db: Database.Database, id: string): void {
  executeExisting(
    db,
    `UPDATE memories SET trashed_at = NULL, trashed_by = NULL, trashed_by_id = NULL
     WHERE id = ? AND trashed_at IS NOT NULL`,
    [id],
    "That memory is not in the trash."
  );
}

/** UX-5: overwrite a memory's text (and, Wave 1b, its category) in place.
 *
 * Scoped to a memory that is still IN the room, and an error when it is not —
 * the same invariant every by-id write to `files` carries. An edit typed into
 * a card whose memory was trashed in the meantime (the agent's forget tool, or
 * another window) landed on the trashed row, reported success, and vanished
 * from the list: the text was gone from the screen, still in the database, and
 * waiting to reappear the moment anyone restored it. */
export function updateMemory(
  db: Database.Database,
  id: string,
  content: string,
  category: string | null
): void {
  executeExisting(
    db,
    `UPDATE memories SET content = ?, category = ?
     WHERE id = ? AND trashed_at IS NULL`,
    [content, category, id],
    "That memory is not in this room."
  );
}
