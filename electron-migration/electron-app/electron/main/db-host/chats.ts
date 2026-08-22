/**
 * Chat conversations — the `chats` table, as distinct from the messages
 * inside them (see `messages.ts`). Ported from `src-tauri/src/db/chats.rs`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOne, queryRows, type Row } from "./util.js";

/** Mirrors the Rust `Chat` struct (`commands.rs`, `#[serde(rename_all =
 * "camelCase")]`), which is field-for-field the `Chat` in
 * `shared/apiTypes.ts` — a chat row goes out to the frontend unchanged. */
export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  /** When this conversation was last spoken in — the newest message's stamp,
   * falling back to `createdAt` for a chat nobody has written in yet.
   *
   * `createdAt` alone answered the wrong question. The list is headed
   * "Continue where you left off", and unlock restores the first row, so a
   * chat opened weeks ago and used all morning sat below one started
   * yesterday and abandoned. There is no `updated_at` column and this needs
   * none: the messages already carry the answer. */
  lastAt: string;
}

function chatRow(r: Row): Chat {
  const createdAt = r[2] as string;
  return {
    id: r[0] as string,
    title: r[1] as string,
    // Both queries below select it, so a missing value here is a real shape
    // mismatch rather than something to paper over silently — but the
    // fallback is the honest one the SQL's own COALESCE already makes
    // unreachable: a chat with no messages reports its own stamp.
    lastAt: (r[3] as string | null) ?? createdAt,
    createdAt,
  };
}

/** Newest CONVERSATION first, not newest chat row first.
 *
 * `idx_messages_chat` already covers this join, and no column is added: the
 * last message's stamp is computed on read. Ordering by `created_at` meant the
 * list headed "Continue where you left off" put a chat abandoned yesterday
 * above the one used all morning — and unlock restores the first row, so it
 * also landed the user in the wrong thread. */
export function listChats(db: Database.Database): Chat[] {
  return queryRows(
    db,
    `SELECT c.id, c.title, c.created_at,
            COALESCE(MAX(m.created_at), c.created_at) AS last_at
     FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
     GROUP BY c.id
     ORDER BY last_at DESC, c.rowid DESC`,
    [],
    chatRow
  );
}

export function createChat(db: Database.Database): Chat {
  const id = randomUUID();
  executeOne(db, "INSERT INTO chats(id, title) VALUES (?, 'New chat')", [id]);
  return queryOne(
    db,
    // Four columns, like `listChats` — a brand-new chat has no messages, so
    // its own stamp IS its last activity. Stated in the query rather than
    // left to `chatRow`'s missing-column fallback: both readers of that
    // function should hand it the same shape, and a row that happens to be
    // one column short is not a contract.
    "SELECT id, title, created_at, created_at AS last_at FROM chats WHERE id = ?",
    [id],
    chatRow
  );
}

export function deleteChat(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM messages WHERE chat_id = ?", [id]);
  executeOne(db, "DELETE FROM chats WHERE id = ?", [id]);
}

/** ADD-9: rename a chat unconditionally (user gave it an explicit title). */
export function renameChat(db: Database.Database, id: string, title: string): void {
  executeOne(db, "UPDATE chats SET title = ? WHERE id = ?", [title, id]);
}

/** First-question auto-title: only takes effect while the chat still has the
 * default "New chat" title. */
export function setChatTitleIfNew(db: Database.Database, chatId: string, title: string): void {
  executeOne(db, "UPDATE chats SET title = ? WHERE id = ? AND title = 'New chat'", [title, chatId]);
}
