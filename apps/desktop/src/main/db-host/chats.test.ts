/**
 * Vitest port of the `chats.rs` tests (`src-tauri/src/db/chats.rs`, `mod
 * tests`):
 *
 *   - the_chat_you_were_last_in_comes_first
 *   - a_chat_with_no_messages_still_lists_and_reports_its_own_stamp
 *   - a_freshly_created_chat_reports_a_last_activity
 *
 * Plus two the Rust suite has no equivalent for, covering the three exported
 * mutators its own tests never reach: `renameChat`/`setChatTitleIfNew` (the
 * "only while it is still 'New chat'" guard is the whole point of having two
 * functions) and `deleteChat` (which must take the chat's messages with it).
 *
 * DEVIATION from the Rust test module: it builds a hand-rolled ad hoc
 * `chats`/`messages` pair (`fn mem()`, local to that file). This port uses a
 * REAL fixture room via `createRoom` (this repo's established convention),
 * inserting rows with explicit `created_at` stamps by raw SQL — the direct
 * equivalent of the Rust source's own `chat_at`/`message_at` helpers.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  createChat,
  deleteChat,
  listChats,
  renameChat,
  setChatTitleIfNew,
} from "./chats.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-chats-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function chatAt(db: Database.Database, id: string, createdAt: string): void {
  db.prepare("INSERT INTO chats(id, title, created_at) VALUES (?, ?, ?)").run(
    id,
    `chat ${id}`,
    createdAt
  );
}

function messageAt(db: Database.Database, chatId: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO messages(id, chat_id, role, content, created_at) VALUES (?, ?, 'user', 'hello', ?)"
  ).run(randomUUID(), chatId, createdAt);
}

describe("listChats", () => {
  // The list is headed "Continue where you left off" and unlock restores its
  // FIRST row, so "recent" has to mean the conversation, not the row. An old
  // chat used this morning belongs above a newer one nobody came back to.
  it("the_chat_you_were_last_in_comes_first", () => {
    const db = freshRoom();
    chatAt(db, "old", "2026-01-01T09:00:00Z");
    chatAt(db, "new", "2026-06-01T09:00:00Z");
    // The OLDER chat is the one still in use.
    messageAt(db, "old", "2026-08-14T10:00:00Z");
    messageAt(db, "new", "2026-06-01T09:05:00Z");

    const ids = listChats(db).map((c) => c.id);
    expect(
      ids,
      "ordering by the chat's own created_at put the abandoned conversation on top"
    ).toEqual(["old", "new"]);
    db.close();
  });

  // A chat nobody has written in yet still has to appear, and to sort by the
  // only stamp it has. An INNER join would have dropped it entirely.
  it("a_chat_with_no_messages_still_lists_and_reports_its_own_stamp", () => {
    const db = freshRoom();
    chatAt(db, "empty", "2026-08-14T12:00:00Z");
    chatAt(db, "spoken", "2026-01-01T09:00:00Z");
    messageAt(db, "spoken", "2026-02-01T09:00:00Z");

    const chats = listChats(db);
    expect(chats.length, "a chat with no messages must not vanish from the list").toBe(2);
    expect(chats[0]?.id, "the newly created chat is the most recent").toBe("empty");
    expect(chats[0]?.lastAt, "with no messages, the chat's own stamp is its last activity").toBe(
      "2026-08-14T12:00:00Z"
    );
    expect(chats[1]?.lastAt).toBe("2026-02-01T09:00:00Z");
    db.close();
  });
});

describe("createChat", () => {
  // `createChat` and `listChats` both feed `chatRow`, so they have to hand it
  // the same shape — a fresh chat reports itself as its own last activity
  // rather than falling through a missing column.
  it("a_freshly_created_chat_reports_a_last_activity", () => {
    const db = freshRoom();
    const chat = createChat(db);
    expect(chat.lastAt).toBe(chat.createdAt);
    expect(chat.lastAt.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("renameChat / setChatTitleIfNew (not in the Rust suite; added for coverage)", () => {
  it("an explicit rename always wins; an auto-title only lands on an untitled chat", () => {
    const db = freshRoom();
    const chat = createChat(db);
    expect(chat.title).toBe("New chat");

    // The auto-title takes an untouched chat…
    setChatTitleIfNew(db, chat.id, "What the lease says about pets");
    expect(listChats(db)[0]?.title).toBe("What the lease says about pets");

    // …and must NOT overwrite a title once one exists, however it got there.
    setChatTitleIfNew(db, chat.id, "A second question entirely");
    expect(listChats(db)[0]?.title).toBe("What the lease says about pets");

    // The explicit rename is unconditional.
    renameChat(db, chat.id, "Lease");
    expect(listChats(db)[0]?.title).toBe("Lease");
    db.close();
  });
});

describe("deleteChat (not in the Rust suite; added for coverage)", () => {
  it("takes the chat's messages with it and leaves other chats alone", () => {
    const db = freshRoom();
    chatAt(db, "doomed", "2026-01-01T09:00:00Z");
    chatAt(db, "kept", "2026-01-01T09:00:00Z");
    messageAt(db, "doomed", "2026-01-02T09:00:00Z");
    messageAt(db, "kept", "2026-01-02T09:00:00Z");

    deleteChat(db, "doomed");

    expect(listChats(db).map((c) => c.id)).toEqual(["kept"]);
    // The messages go too — nothing is left orphaned behind the deleted chat.
    const left = db
      .prepare("SELECT count(*) as n FROM messages WHERE chat_id = 'doomed'")
      .get() as { n: number };
    expect(left.n).toBe(0);
    const survivors = db.prepare("SELECT count(*) as n FROM messages").get() as { n: number };
    expect(survivors.n).toBe(1);
    db.close();
  });
});
