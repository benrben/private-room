/**
 * Vitest port of the `messages.rs` tests (`src-tauri/src/db/messages.rs`,
 * `mod tests`):
 *
 *   - like_wildcards_in_the_query_are_taken_literally
 *   - every_word_has_to_appear_but_the_order_does_not
 *   - insert_message_leaves_kind_null
 *   - insert_handoff_message_sets_kind_and_effects
 *   - recent_messages_limit_minus_one_means_no_limit
 *   - recent_messages_returns_everything_with_no_handoff_marker
 *   - recent_messages_truncates_at_the_latest_handoff_marker
 *   - recent_messages_uses_the_latest_of_several_handoff_markers
 *   - list_messages_shows_the_handoff_marker_in_place
 *
 * Plus three the Rust suite has no equivalent for, covering exported
 * functions its own tests never reach: `deleteMessage`,
 * `recentMessageSources` and `roomCounts`.
 *
 * DEVIATION from the Rust test module: it builds a hand-rolled ad hoc
 * `messages` table (`fn mem()`, local to that file). This port uses a REAL
 * fixture room via `createRoom` (this repo's established convention — see
 * `open.test.ts`/`meta.test.ts`), which is strictly more faithful than
 * re-declaring a parallel copy that could drift from `schema.sql`. The real
 * `messages` table has no FK from `chat_id` to `chats`, same as the Rust
 * test's own table, so an arbitrary chat id like `"c1"` works with no
 * matching `chats` row.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  deleteMessage,
  insertHandoffMessage,
  insertMessage,
  likeEscape,
  listMessages,
  messagesLike,
  recentMessages,
  recentMessageSources,
  roomCounts,
  searchTerms,
} from "./messages.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-messages-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** A row in `files`, live or trashed. Raw SQL because `files.ts` (and with it
 * the real `insert_file`) is a later batch — `roomCounts` only needs the rows
 * to exist and to carry the right `trashed_at`. */
function addFile(db: Database.Database, name: string, trashedAt: string | null = null): void {
  db.prepare(
    `INSERT INTO files(id, name, mime_type, size_bytes, source, trashed_at)
     VALUES (?, ?, 'text/plain', 0, 'upload', ?)`
  ).run(randomUUID(), name, trashedAt);
}

describe("messagesLike", () => {
  it("like_wildcards_in_the_query_are_taken_literally", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "the deposit is 50% of rent", [], null);
    insertMessage(db, "c1", "user", "we owe 50 pounds", [], null);
    insertMessage(db, "c1", "user", "table a_b", [], null);
    insertMessage(db, "c1", "user", "table axb", [], null);

    // "50%" used to match "50 pounds" too — % is a LIKE wildcard.
    let hits = messagesLike(db, "50%");
    expect(hits.length).toBe(1);
    expect(hits[0]?.[2]).toContain("50% of rent");

    // "_" is the other one: it matched any single character.
    hits = messagesLike(db, "a_b");
    expect(hits.length).toBe(1);
    expect(hits[0]?.[2].endsWith("a_b")).toBe(true);

    // An ordinary query is unaffected.
    expect(messagesLike(db, "deposit").length).toBe(1);
    expect(likeEscape("100% _sure_")).toBe("100\\% \\_sure\\_");

    db.close();
  });

  it("every_word_has_to_appear_but_the_order_does_not", () => {
    // Search matched ONE literal substring, so a reader who typed the right
    // words in the wrong order got "nothing found" from a room that plainly
    // contained them.
    const db = freshRoom();
    insertMessage(db, "c1", "user", "speaker diarisation notes", [], null);
    insertMessage(db, "c1", "user", "diarisation of one speaker", [], null);
    insertMessage(db, "c1", "user", "speakers at the conference", [], null);

    // Both orders find both rows that hold both words — and only those.
    for (const q of ["speaker diarisation", "diarisation speaker"]) {
      const hits = messagesLike(db, q);
      expect(hits.length, `${q} found ${JSON.stringify(hits)}`).toBe(2);
    }
    // A word that is missing still excludes the row: this is AND, not OR.
    expect(messagesLike(db, "speaker rhubarb").length).toBe(0);
    // Extra whitespace is not a term, and a whitespace-only query is not a
    // match-everything query.
    expect(messagesLike(db, "  speaker   notes  ").length).toBe(1);
    expect(messagesLike(db, "   ").length).toBe(0);
    // Wildcards stay literal per-word, exactly as for a one-word query.
    expect(searchTerms("50% a_b")).toEqual(["50\\%", "a\\_b"]);

    db.close();
  });

  it("stops at eight words, and the ones it drops widen the search rather than narrowing it", () => {
    // Not in the Rust suite, which never exercises MAX_SEARCH_TERMS at all —
    // every fixture query there is two words. The cap's own comment promises a
    // direction ("words past the cap are IGNORED, which widens the result set —
    // never narrows it"), and which direction it goes is the whole reason to
    // have a cap rather than an error: raising or lowering the number silently
    // changes what a pasted paragraph finds.
    const nine = "one two three four five six seven eight rhubarb";
    expect(searchTerms(nine)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ]);

    const db = freshRoom();
    insertMessage(db, "c1", "user", "one two three four five six seven eight", [], null);
    // The ninth word is not in that row — and is ignored, so the row is found.
    expect(messagesLike(db, nine).length).toBe(1);
    // A word INSIDE the cap still has to appear: the cap widens, AND does not.
    expect(messagesLike(db, "one two three four five six seven rhubarb").length).toBe(0);

    db.close();
  });

  it("splits on the same whitespace Rust's split_whitespace does, not on JS's `\\s`", () => {
    // `\s` and `char::is_whitespace` are DIFFERENT sets, and the two disagree
    // in both directions on characters that really do turn up in pasted text.
    // U+0085 NEL is a line break Rust splits on and `\s` does not — leaving one
    // joined term no row can contain, which narrows the result to nothing.
    expect(searchTerms("speaker\u0085notes")).toEqual(["speaker", "notes"]);
    // U+FEFF is the other way round: `\s` matches it, Rust does not, so a BOM
    // pasted in from a file used to split one word into two.
    expect(searchTerms("speaker\uFEFFnotes")).toEqual(["speaker\uFEFFnotes"]);
    // Non-breaking and ideographic spaces are whitespace to both.
    expect(searchTerms("\u00a0speaker\u3000notes\u00a0")).toEqual(["speaker", "notes"]);
    // And a needle of nothing but separators is still not a match-everything
    // query, whichever separators they are.
    expect(searchTerms("\u00a0\u3000 ")).toEqual([]);
  });

  it("skips orphan rows that belong to no chat", () => {
    // `chat_id IS NOT NULL` in the query: a hit is rendered as "found in this
    // conversation", and a row with no conversation to open has nowhere to send
    // the reader. Not in the Rust suite, whose fixtures all set a chat id.
    const db = freshRoom();
    insertMessage(db, "c1", "user", "the lease mentions pets", [], null);
    db.prepare("INSERT INTO messages(id, chat_id, role, content) VALUES (?, NULL, 'user', ?)").run(
      randomUUID(),
      "the lease mentions pets"
    );

    const hits = messagesLike(db, "pets");
    expect(hits.length, "the orphan row was returned with a null chat id").toBe(1);
    expect(hits[0]?.[0]).toBe("c1");

    db.close();
  });
});

describe("insertMessage / insertHandoffMessage", () => {
  it("drops malformed persisted source/effect JSON instead of leaking invalid shapes", () => {
    const db = freshRoom();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO messages(id, chat_id, role, content, sources, effects) VALUES (?, 'c1', 'user', 'legacy', ?, ?)",
    ).run(id, "not-json", "not-json");
    const malformedJson = listMessages(db, "c1")[0];
    expect(malformedJson).toMatchObject({ id, sources: [], effects: null });

    db.prepare("UPDATE messages SET sources = ? WHERE id = ?").run('["valid", 42]', id);
    expect(listMessages(db, "c1")[0]?.sources).toEqual([]);
    db.close();
  });

  it("insert_message_leaves_kind_null", () => {
    const db = freshRoom();
    const m = insertMessage(db, "c1", "user", "hi", [], null);
    expect(m.kind).toBeNull();
    db.close();
  });

  it("insert_handoff_message_sets_kind_and_effects", () => {
    const db = freshRoom();
    const usage = { total_tokens: 42 };
    const m = insertHandoffMessage(db, "c1", "the recap", usage);
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("the recap");
    expect(m.kind).toBe("handoff");
    expect((m.effects as { total_tokens: number }).total_tokens).toBe(42);
    db.close();
  });
});

describe("recentMessages", () => {
  it("recent_messages_limit_minus_one_means_no_limit", () => {
    // `#`-commands read the WHOLE conversation with limit -1 (SQLite's "no
    // limit") instead of the last 12 turns — if that ever stopped meaning
    // unlimited, every command would silently reason over an empty history.
    const db = freshRoom();
    for (let i = 0; i < 40; i++) {
      insertMessage(db, "c1", "user", `m${i}`, [], null);
    }
    expect(recentMessages(db, "c1", -1).length).toBe(40);
    expect(recentMessages(db, "c1", 12).length).toBe(12);
    db.close();
  });

  it("recent_messages_returns_everything_with_no_handoff_marker", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "one", [], null);
    insertMessage(db, "c1", "assistant", "two", [], null);
    const rows = recentMessages(db, "c1", 10);
    // newest-first
    expect(rows).toEqual([
      ["assistant", "two"],
      ["user", "one"],
    ]);
    db.close();
  });

  it("recent_messages_truncates_at_the_latest_handoff_marker", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "old question", [], null);
    insertMessage(db, "c1", "assistant", "old answer", [], null);
    insertHandoffMessage(db, "c1", "recap of the above", null);
    insertMessage(db, "c1", "user", "new question", [], null);

    const rows = recentMessages(db, "c1", 10);
    // The pre-handoff turns are gone; the marker's own content (the recap) IS
    // included — it's the model's first "turn" going forward.
    expect(rows).toEqual([
      ["user", "new question"],
      ["assistant", "recap of the above"],
    ]);
    expect(rows.some(([, c]) => c === "old question" || c === "old answer")).toBe(false);
    db.close();
  });

  it("recent_messages_uses_the_latest_of_several_handoff_markers", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "turn 1", [], null);
    insertHandoffMessage(db, "c1", "first recap", null);
    insertMessage(db, "c1", "user", "turn 2", [], null);
    insertHandoffMessage(db, "c1", "second recap", null);
    insertMessage(db, "c1", "user", "turn 3", [], null);

    const rows = recentMessages(db, "c1", 10);
    expect(rows.map(([, c]) => c)).toEqual(["turn 3", "second recap"]);
    db.close();
  });
});

describe("listMessages", () => {
  it("list_messages_shows_the_handoff_marker_in_place", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "q", [], null);
    insertHandoffMessage(db, "c1", "recap", null);
    insertMessage(db, "c1", "user", "q2", [], null);

    const all = listMessages(db, "c1");
    expect(all.length).toBe(3);
    expect(all[1]?.kind).toBe("handoff");
    expect(all[0]?.kind).toBeNull();
    expect(all[2]?.kind).toBeNull();
    db.close();
  });

  it("round-trips sources and effects through their JSON columns", () => {
    // Not in the Rust suite. `listMessages` is the only reader that decodes
    // both columns, and `insert*`'s return value never goes through it — so
    // without this the encode and decode halves are only ever tested apart.
    const db = freshRoom();
    insertMessage(db, "c1", "assistant", "cited", ["a.txt", "b.txt"], { boxes: [1, 2] });
    insertMessage(db, "c1", "user", "plain", [], null);

    const all = listMessages(db, "c1");
    expect(all[0]?.sources).toEqual(["a.txt", "b.txt"]);
    expect(all[0]?.effects).toEqual({ boxes: [1, 2] });
    // A message with neither reads as an empty list and a null, never
    // undefined — `sources` is `Vec<String>` in Rust, not `Option`.
    expect(all[1]?.sources).toEqual([]);
    expect(all[1]?.effects).toBeNull();
    db.close();
  });
});

describe("deleteMessage (not in the Rust suite; added for coverage)", () => {
  it("removes exactly the named message", () => {
    const db = freshRoom();
    const keep = insertMessage(db, "c1", "user", "keep me", [], null);
    const drop = insertMessage(db, "c1", "user", "drop me", [], null);
    deleteMessage(db, drop.id);
    const remaining = listMessages(db, "c1");
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe(keep.id);
    db.close();
  });
});

describe("recentMessageSources / roomCounts (not in the Rust suite; added for coverage)", () => {
  it("returns the newest cited answers first, skipping the uncited ones", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "assistant", "no sources here", [], null);
    insertMessage(db, "c1", "assistant", "cites one", ["File A.pdf"], null);
    insertMessage(db, "c1", "assistant", "cites two", ["File B.pdf", "File C.pdf"], null);

    expect(recentMessageSources(db, 10)).toEqual([
      ["File B.pdf", "File C.pdf"],
      ["File A.pdf"],
    ]);
    db.close();
  });

  it("roomCounts reports files and messages", () => {
    const db = freshRoom();
    insertMessage(db, "c1", "user", "hi", [], null);
    insertMessage(db, "c1", "assistant", "hello", [], null);
    expect(roomCounts(db)).toEqual([0, 2]);
    db.close();
  });

  it("roomCounts counts the files still in the room, not the trashed ones", () => {
    // An empty room makes the file half of this pair vacuous: zero is what a
    // count of the WRONG thing returns too. RoomInfo's "3 files" has to mean
    // three files you can still open, and a trashed file has left every other
    // listing — the badge saying otherwise is the room contradicting itself.
    const db = freshRoom();
    insertMessage(db, "c1", "user", "hi", [], null);
    addFile(db, "lease.pdf");
    addFile(db, "notes.txt");
    addFile(db, "deleted-last-week.txt", "2026-02-01T09:00:00Z");

    expect(roomCounts(db)).toEqual([2, 1]);
    db.close();
  });
});
