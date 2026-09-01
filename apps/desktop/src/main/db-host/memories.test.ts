/**
 * Vitest port of the `memories.rs` tests (`src-tauri/src/db/memories.rs`,
 * `mod tests`):
 *
 *   - a_memory_search_takes_like_wildcards_literally
 *   - memory_update_persists
 *   - memory_category_roundtrip
 *   - memory_category_nullable_for_legacy_rows
 *   - deleting_a_memory_soft_deletes_it_content_survives
 *   - restoring_a_memory_returns_it_to_every_listing
 *   - deleting_an_already_deleted_memory_is_refused_not_re_stamped
 *   - restoring_a_memory_that_is_not_trashed_is_an_error_not_a_no_op
 *   - editing_a_trashed_memory_is_refused_and_changes_nothing
 *   - editing_a_memory_that_was_never_here_is_refused
 *
 * DEVIATION from the Rust test module: it reuses `crate::db::mem()`, a
 * full-`SCHEMA` in-memory connection shared across the whole `db` module.
 * This port uses a REAL fixture room via `createRoom` (this repo's
 * established convention); the real `memories` table already carries
 * `category`/`trashed_at`/`trashed_by`/`trashed_by_id`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  memoriesLike,
  restoreMemory,
  updateMemory,
} from "./memories.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-memories-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** The row's text as it actually sits in the table — including while trashed,
 * which every read path deliberately hides. */
function rawContent(db: Database.Database, id: string): string {
  return db.prepare("SELECT content FROM memories WHERE id = ?").pluck().get(id) as string;
}

describe("memoriesLike", () => {
  it("treats a whitespace-only search as no query", () => {
    const db = freshRoom();
    addMemory(db, "a memory that must not match an empty query", null);
    expect(memoriesLike(db, "   ")).toEqual([]);
    db.close();
  });

  // The sibling of `messages`' LIKE-wildcard test: all three of `search_all`'s
  // queries have to agree about what the same needle means.
  it("a_memory_search_takes_like_wildcards_literally", () => {
    const db = freshRoom();
    addMemory(db, "the deposit is 50% of rent", null);
    addMemory(db, "50 pounds a week", null);
    addMemory(db, "file a_b is the master", null);
    addMemory(db, "file axb is a copy", null);

    let hits = memoriesLike(db, "50%");
    expect(hits.length, `\`%\` still wildcarded: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]?.[1]).toContain("50% of rent");

    hits = memoriesLike(db, "a_b");
    expect(hits.length, `\`_\` still wildcarded: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]?.[1]).toContain("a_b");

    expect(memoriesLike(db, "pounds").length).toBe(1);
    db.close();
  });
});

describe("listing order", () => {
  it("lists memories oldest first, and searches them newest first", () => {
    // Not in the Rust suite, whose fixtures are all one row deep — so the two
    // queries' ORDER BY clauses, which point in OPPOSITE directions on purpose,
    // were never distinguishable from each other or from no ordering at all.
    // The page reads top-to-bottom as the order things were learned in; a
    // search answers with what was learned most recently first.
    //
    // Explicit stamps: `created_at` has one-second resolution, so three inserts
    // in the same test tick would tie and leave this asserting SQLite's
    // unspecified tie-break rather than the column.
    const db = freshRoom();
    const at = (id: string, createdAt: string, content: string) =>
      db
        .prepare("INSERT INTO memories(id, content, created_at) VALUES (?, ?, ?)")
        .run(id, content, createdAt);
    at("m2", "2026-06-01T09:00:00Z", "learned second about rent");
    at("m1", "2026-01-01T09:00:00Z", "learned first about rent");
    at("m3", "2026-08-01T09:00:00Z", "learned third about rent");

    expect(listMemories(db).map((m) => m.content)).toEqual([
      "learned first about rent",
      "learned second about rent",
      "learned third about rent",
    ]);
    expect(memoriesLike(db, "rent").map(([id]) => id)).toEqual(["m3", "m2", "m1"]);

    db.close();
  });
});

describe("updateMemory", () => {
  it("memory_update_persists", () => {
    const db = freshRoom();
    const m = addMemory(db, "old text", null);
    updateMemory(db, m.id, "new text", null);
    const got = listMemories(db);
    expect(got.length).toBe(1);
    expect(got[0]?.content).toBe("new text");
    db.close();
  });
});

describe("category", () => {
  it("memory_category_roundtrip", () => {
    const db = freshRoom();
    const m = addMemory(db, "answers in Hebrew, please", "preference");
    expect(m.category).toBe("preference");
    expect(listMemories(db)[0]?.category).toBe("preference");
    // An edit can move it to another category — or clear it.
    updateMemory(db, m.id, "answers in Hebrew", "instruction");
    expect(listMemories(db)[0]?.category).toBe("instruction");
    updateMemory(db, m.id, "answers in Hebrew", null);
    expect(listMemories(db)[0]?.category).toBeNull();
    db.close();
  });

  // A row inserted the pre-category way (no category value) reads back as
  // null — exactly what migrated legacy rooms hold.
  it("memory_category_nullable_for_legacy_rows", () => {
    const db = freshRoom();
    db.prepare("INSERT INTO memories(id, content) VALUES ('legacy', 'old note')").run();
    const got = listMemories(db);
    expect(got.length).toBe(1);
    expect(got[0]?.category).toBeNull();
    db.close();
  });
});

describe("deleteMemory / restoreMemory", () => {
  it("deleting_a_memory_soft_deletes_it_content_survives", () => {
    const db = freshRoom();
    const m = addMemory(db, "call every Friday", null);
    deleteMemory(db, m.id, { kind: "agent", who: "delete_memory" });
    // Gone from every read path an agent or the UI would use…
    expect(listMemories(db)).toEqual([]);
    expect(memoriesLike(db, "Friday")).toEqual([]);
    // …but the row itself, and its text, are still there.
    expect(rawContent(db, m.id)).toBe("call every Friday");
    db.close();
  });

  it("records WHO deleted it, in the closed vocabulary the UI switches on", () => {
    // Not in the Rust suite, which never reads the columns back. The whole
    // reason a second trash is refused is that it would overwrite this — so
    // the actor has to actually land, and `user` has to leave the id NULL
    // rather than writing the string "user" into it twice.
    const db = freshRoom();
    const byAgent = addMemory(db, "a", null);
    const byUser = addMemory(db, "b", null);
    const byApp = addMemory(db, "c", null);
    deleteMemory(db, byAgent.id, { kind: "agent", who: "delete_memory" });
    deleteMemory(db, byUser.id, { kind: "user" });
    deleteMemory(db, byApp.id, { kind: "app", what: "prune_generated" });

    const stamp = (id: string) =>
      db.prepare("SELECT trashed_by, trashed_by_id FROM memories WHERE id = ?").get(id) as {
        trashed_by: string;
        trashed_by_id: string | null;
      };
    expect(stamp(byAgent.id)).toEqual({ trashed_by: "agent", trashed_by_id: "delete_memory" });
    expect(stamp(byUser.id)).toEqual({ trashed_by: "user", trashed_by_id: null });
    expect(stamp(byApp.id)).toEqual({ trashed_by: "app", trashed_by_id: "prune_generated" });
    db.close();
  });

  it("restoring_a_memory_returns_it_to_every_listing", () => {
    const db = freshRoom();
    const m = addMemory(db, "call every Friday", null);
    deleteMemory(db, m.id, { kind: "user" });
    expect(listMemories(db)).toEqual([]);
    restoreMemory(db, m.id);
    const got = listMemories(db);
    expect(got.length).toBe(1);
    expect(got[0]?.content).toBe("call every Friday");
    db.close();
  });

  // Same reasoning as `trash_file`: a second trash would overwrite the record
  // of who actually deleted it.
  it("deleting_an_already_deleted_memory_is_refused_not_re_stamped", () => {
    const db = freshRoom();
    const m = addMemory(db, "x", null);
    deleteMemory(db, m.id, { kind: "agent", who: "delete_memory" });
    expect(() => deleteMemory(db, m.id, { kind: "user" })).toThrow("not in this room");
    db.close();
  });

  it("restoring_a_memory_that_is_not_trashed_is_an_error_not_a_no_op", () => {
    const db = freshRoom();
    const m = addMemory(db, "x", null);
    expect(() => restoreMemory(db, m.id)).toThrow("not in the trash");
    db.close();
  });

  // Editing a memory that has been trashed since the card was opened is
  // REFUSED, not silently swallowed. The old UPDATE matched on id alone, so
  // the typed text landed on the trashed row: the save said nothing, the
  // refetched list no longer held it, and restoring the memory later brought
  // back the post-deletion text as if it had always been there.
  it("editing_a_trashed_memory_is_refused_and_changes_nothing", () => {
    const db = freshRoom();
    const m = addMemory(db, "call every Friday", null);
    deleteMemory(db, m.id, { kind: "agent", who: "delete_memory" });

    expect(() => updateMemory(db, m.id, "call every Tuesday", null)).toThrow("not in this room");

    // The trashed row still says what it said when it was trashed.
    expect(rawContent(db, m.id)).toBe("call every Friday");
    // …and putting it back cannot resurrect an edit nobody could see.
    restoreMemory(db, m.id);
    expect(listMemories(db)[0]?.content).toBe("call every Friday");
    db.close();
  });

  it("editing_a_memory_that_was_never_here_is_refused", () => {
    const db = freshRoom();
    expect(() => updateMemory(db, "no-such-id", "text", null)).toThrow("not in this room");
    db.close();
  });
});
