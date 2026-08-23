/**
 * Tests for `searchTools.ts` — `src-tauri/src/commands/search.rs`'s
 * `search_all` port.
 *
 * Section 1 ports `search.rs`'s own `#[cfg(test)] mod tests`
 * (`a_file_content_search_requires_every_word_the_user_typed`) against
 * {@link ftsMatchAll}, same names, same assertions.
 *
 * Section 2 exercises {@link searchAll} against a REAL fixture `.roomai`
 * room (this repo's established convention), because everything it
 * orchestrates — `filesContentFts`/`filesNameLike`/`messagesLike`/
 * `memoriesLike`/`questionTerms`/`ftsMatchExpr`/`makeSnippet` — is already
 * unit-tested elsewhere; what is NEW here, and what these tests target, is
 * the orchestration itself: the empty-query short circuit, the AND-not-OR
 * content rule the module doc explains at length, the content-then-name
 * dedup order, and the over-fetch/distinct-file/cap behaviour `search.rs`'s
 * own comment says it borrows from `db::fts_file_matches` — mirrored here
 * with the same short-chunks-rank-best construction
 * `db-host/embeddings.test.ts`'s own `ftsFileMatches` test already uses and
 * validates for that sibling function.
 *
 * Section 3 covers {@link registerSearchIpc}, mirroring `previewTools.test.ts`
 * and `recIpc.test.ts`'s own coverage of their `register*Ipc` siblings.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { insertMessage } from "./db-host/messages.js";
import { addMemory } from "./db-host/memories.js";
import {
  FILE_CONTENT_HITS,
  ftsMatchAll,
  registerSearchIpc,
  searchAll,
  type RoomSource,
} from "./searchTools.js";

// ---------------------------------------------------------------- Section 1

describe("ftsMatchAll", () => {
  it("a_file_content_search_requires_every_word_the_user_typed", () => {
    // The Files group used to OR its terms while names, messages and
    // memories all required ALL of them: one query, two meanings, side by
    // side in one result list.
    expect(ftsMatchAll(["deposit", "refund"])).toBe('"deposit" AND "refund"');
    // A single term is that term — including the whole-phrase fallback the
    // caller uses when every word was a stopword.
    expect(ftsMatchAll(["rent"])).toBe('"rent"');
    expect(ftsMatchAll(["what about rent"])).toBe('"what about rent"');
    // Terms that quote away to nothing are dropped, not AND-ed in as an
    // empty phrase that no row can contain.
    expect(ftsMatchAll(["", "rent"])).toBe('"rent"');
    // Nothing usable stays null, so the caller skips the content query
    // rather than running a MATCH with no expression in it.
    expect(ftsMatchAll([])).toBeNull();
    expect(ftsMatchAll([""])).toBeNull();
  });
});

// ---------------------------------------------------------------- Section 2

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "searchTools-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Matches `db-host/files.test.ts`'s own `addFile` helper: mime is always
 * "text/plain", and the real `insertFile` → `insertChunks` chunking pipeline
 * runs, exactly as it does for a real import. */
function addFile(db: Database.Database, name: string, text: string | null): string {
  return insertFile(
    db,
    name,
    "text/plain",
    Buffer.from(text ?? "", "utf8"),
    text,
    "upload"
  ).id;
}

/** A raw single chunk directly on `chunks`, bypassing `insertFile`'s
 * paragraph-based chunker — the same technique
 * `db-host/embeddings.test.ts`'s `addTestFile`/`addTestChunk` use to give one
 * file many short, high-bm25-ranking chunks without needing kilobytes of
 * filler text to force chunk boundaries. */
function addFileNoText(db: Database.Database, name: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(""), null, "upload").id;
}

function addChunk(db: Database.Database, fileId: string, seq: number, text: string): void {
  db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)").run(
    randomUUID(),
    fileId,
    seq,
    text
  );
}

describe("searchAll", () => {
  it("an empty or whitespace-only query returns everything empty, even though the room has matching content", () => {
    const db = freshRoom();
    addFile(db, "deposit.txt", "the deposit and the refund");
    insertMessage(db, "c1", "user", "a deposit refund message", [], null);
    addMemory(db, "a deposit refund memory", null);

    expect(searchAll(db, "")).toEqual({ files: [], messages: [], memories: [] });
    expect(searchAll(db, "   ")).toEqual({ files: [], messages: [], memories: [] });
  });

  it("a file-content hit requires BOTH words in the SAME ~1200-char chunk, not merely the same document", () => {
    const db = freshRoom();
    // Two paragraphs long enough that the real chunker (CHUNK_TARGET_CHARS
    // = 1200) splits them into separate chunks: one holds "deposit", the
    // other holds "refund", never both at once.
    const para1 = `${"alpha ".repeat(150)}deposit`;
    const para2 = `${"beta ".repeat(150)}refund`;
    const splitId = addFile(db, "split.txt", `${para1}\n\n${para2}`);
    // One file whose single chunk holds both words together.
    const bothId = addFile(db, "both.txt", "the deposit and the refund, together");

    const result = searchAll(db, "deposit refund");
    const ids = result.files.map((f) => f.id);
    expect(ids).not.toContain(splitId);
    expect(ids).toContain(bothId);
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.snippet.length).toBeGreaterThan(0);
  });

  it("a name-only match carries an EMPTY snippet, never the file name repeated as a preview", () => {
    const db = freshRoom();
    const id = addFile(db, "deposit refund contract.txt", null);

    const result = searchAll(db, "deposit refund");
    expect(result.files).toEqual([{ id, name: "deposit refund contract.txt", snippet: "" }]);
  });

  it("a file matching BOTH by content and by name is listed ONCE, with the content snippet — content runs before names", () => {
    const db = freshRoom();
    const id = addFile(db, "deposit refund contract.txt", "deposit and refund noted here");

    const result = searchAll(db, "deposit refund");
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.id).toBe(id);
    // Non-empty: the content pass populated `seen` first, so the later
    // name-only pass (which would have written an empty snippet) never got
    // to touch this id.
    expect(result.files[0]?.snippet).not.toBe("");
  });

  it("one file's many short, high-ranking chunks does not crowd every OTHER matching file out of the list", () => {
    // Mirrors `db-host/embeddings.test.ts`'s own `ftsFileMatches` crowd-out
    // test: short chunks bm25-rank best, so without the over-fetch this
    // file's chunks alone would fill `filesContentFts`'s row budget and no
    // other file could ever appear — the exact regression `search.rs`'s own
    // module comment describes ("a 15-chunk fetch then listed a single file
    // and dropped every other document that matched, unreachably").
    const db = freshRoom();
    const floodedId = addFileNoText(db, "flooded.txt");
    for (let i = 0; i < 20; i++) {
      addChunk(db, floodedId, i, "widget report");
    }
    const otherIds: string[] = [];
    for (let i = 0; i < 14; i++) {
      const id = addFileNoText(db, `other-${i}.txt`);
      addChunk(
        db,
        id,
        0,
        `a much longer paragraph that only in passing mentions the widget report and then moves on to unrelated matters entirely, file number ${i}`
      );
      otherIds.push(id);
    }

    const result = searchAll(db, "widget report");
    const ids = new Set(result.files.map((f) => f.id));
    // 1 flooded file + 14 others = 15 distinct files, under the cap — every
    // one of them must survive, not just the flooded file.
    expect(ids.size).toBe(FILE_CONTENT_HITS);
    expect(ids.has(floodedId)).toBe(true);
    for (const id of otherIds) {
      expect(ids.has(id), `other file ${id} was crowded out`).toBe(true);
    }
  });

  it("the Files group is capped at FILE_CONTENT_HITS distinct files even when more than that many match", () => {
    const db = freshRoom();
    for (let i = 0; i < FILE_CONTENT_HITS + 6; i++) {
      const id = addFileNoText(db, `many-${i}.txt`);
      addChunk(db, id, 0, `widget report number ${i}`);
    }

    const result = searchAll(db, "widget report");
    expect(result.files.length).toBe(FILE_CONTENT_HITS);
    expect(new Set(result.files.map((f) => f.id)).size).toBe(FILE_CONTENT_HITS);
  });

  it("messages require every word, in any order, and carry a snippet + chat/message ids", () => {
    const db = freshRoom();
    const both = insertMessage(db, "chat-1", "user", "speaker diarisation notes", [], null);
    insertMessage(db, "chat-2", "user", "diarisation only, no mention of the other word", [], null);

    const result = searchAll(db, "diarisation speaker");
    expect(result.messages).toEqual([
      {
        chatId: "chat-1",
        messageId: both.id,
        snippet: expect.stringContaining("speaker"),
      },
    ]);
  });

  it("memories require every word, in any order, and carry a snippet + id", () => {
    const db = freshRoom();
    const both = addMemory(db, "the rent is due on the first", null);
    addMemory(db, "the rent went up but nothing about the date", null);

    const result = searchAll(db, "rent first");
    expect(result.memories).toEqual([
      { id: both.id, snippet: expect.stringContaining("rent") },
    ]);
  });

  it("one query, three domains: files, messages and memories are all populated from a single call", () => {
    const db = freshRoom();
    const fileId = addFile(db, "lease.txt", "the tenant pays the deposit on the first");
    const msg = insertMessage(db, "chat-1", "user", "remember the deposit is due", [], null);
    const mem = addMemory(db, "note: deposit amount confirmed", null);

    const result = searchAll(db, "deposit");
    expect(result.files.some((f) => f.id === fileId)).toBe(true);
    expect(result.messages.some((m) => m.messageId === msg.id)).toBe(true);
    expect(result.memories.some((m) => m.id === mem.id)).toBe(true);
  });

  it("hostile FTS5 syntax in the typed query never escapes into the MATCH expression", () => {
    // The overlay hands `search_all` whatever the user typed, and it lands in
    // an FTS5 `MATCH` — the one place in this function where raw input becomes
    // a QUERY LANGUAGE rather than a bound parameter. `ftsMatchExpr` strips
    // `"` and wraps each term in its own quotes, so none of these can close
    // the string literal or introduce an operator; an unescaped one is a
    // thrown `fts5: syntax error`, i.e. a ⌘F overlay that dies on a keystroke.
    const db = freshRoom();
    addFile(db, "notes.txt", "the deposit and the refund");
    insertMessage(db, "c1", "user", "a deposit refund message", [], null);
    addMemory(db, "a deposit refund memory", null);

    for (const q of [
      'deposit" OR "refund',
      'deposit" OR chunks_fts MATCH "x',
      "NEAR(deposit refund)",
      "deposit AND refund",
      "*",
      "^deposit",
      '"',
      '""',
      "()",
      "?!",
      "-",
      "deposit*",
      "{a b}",
      "a:b",
      "deposit\u0000refund",
    ]) {
      expect(() => searchAll(db, q), `query ${JSON.stringify(q)} threw`).not.toThrow();
    }
    // …and the ordinary query still works afterwards, so "never throws" was
    // not bought by short-circuiting everything.
    expect(searchAll(db, "deposit refund").files.length).toBe(1);
  });

  it("an oversized query is answered, not choked on", () => {
    // `question_terms` caps at 24 distinct terms and stops; nothing else here
    // bounds the input. A pasted page of text is a realistic ⌘F paste.
    const db = freshRoom();
    const id = addFile(db, "notes.txt", "the deposit amount");
    const huge = `${"deposit ".repeat(12_500)}${"z".repeat(50_000)}`;
    expect(huge.length).toBeGreaterThan(100_000);
    let result!: ReturnType<typeof searchAll>;
    expect(() => {
      result = searchAll(db, huge);
    }).not.toThrow();
    // Every term must be present in one chunk, and "zzz…" is in none, so the
    // honest answer is nothing — not a crash and not a false hit.
    expect(result.files.map((f) => f.id)).not.toContain(id);
    expect(searchAll(db, "deposit ".repeat(12_500)).files.map((f) => f.id)).toContain(id);
  });

  it("FILE_CONTENT_HITS caps the CONTENT pass only — the name pass appends past it", () => {
    // Rust checks `files.len() >= FILE_CONTENT_HITS` INSIDE the content loop
    // and nowhere else, so `files_name_like`'s own `LIMIT 20` is the only
    // bound on the second pass. A port that capped the whole Files group at 15
    // would silently drop five name matches the shipped app lists.
    const db = freshRoom();
    for (let i = 0; i < 25; i++) {
      addFileNoText(db, `widget report ${i}.txt`); // name matches, no chunks
    }
    const result = searchAll(db, "widget report");
    expect(result.files.length).toBeGreaterThan(FILE_CONTENT_HITS);
    expect(result.files.length).toBe(20); // filesNameLike's own LIMIT 20
    expect(result.files.every((f) => f.snippet === "")).toBe(true);
  });

  it("an all-stopword query degrades file content search to a literal whole-phrase match, unlike messages/memories which keep AND-of-words", () => {
    // `question_terms("the it")` drops both words (both are stopwords), so
    // `ftsMatchAll` falls back to quoting the WHOLE trimmed+lowercased query
    // as one phrase ('"the it"') — a literal adjacency match, not an AND of
    // two tokens. Messages/memories never apply the stopword filter at all
    // (`searchTerms` just splits on whitespace), so they still match on
    // "the" and "it" appearing anywhere, in any order.
    const db = freshRoom();
    // Content chunk containing "the" and "it" scattered, never adjacent as
    // "the it" — the AND-of-tokens reading would match this; the literal
    // phrase reading must not.
    const scattered = addFile(db, "scattered.txt", "the lease mentions it later on");
    // Content chunk containing the literal adjacent phrase "the it".
    const literal = addFile(db, "literal.txt", "an odd sentence: the it factor was undeniable");
    insertMessage(db, "chat-1", "user", "it was signed under the old terms", [], null);
    addMemory(db, "the amount changed after it was signed", null);

    const result = searchAll(db, "the it");
    const fileIds = result.files.map((f) => f.id);
    expect(fileIds).not.toContain(scattered);
    expect(fileIds).toContain(literal);
    // Messages/memories still work as an ordinary (unfiltered) AND-of-words
    // search over the same stopword-only input.
    expect(result.messages.length).toBe(1);
    expect(result.memories.length).toBe(1);
  });
});

// ---------------------------------------------------------------- Section 3

describe("registerSearchIpc", () => {
  let db: Database.Database;
  let roomPath: string;

  function roomSource(open: boolean): RoomSource {
    return { currentRoom: () => (open ? { db, path: roomPath } : null) };
  }

  function listener(
    handle: ReturnType<typeof vi.fn>,
    channel: string
  ): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  function setup(): void {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "searchTools-ipc-"));
    roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
    db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  }

  it("registers exactly the search_all channel", () => {
    setup();
    const handle = vi.fn();
    registerSearchIpc({ handle }, roomSource(true));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toBe("search_all");
  });

  it("refuses with 'No room is open.' when no room is open", async () => {
    setup();
    const handle = vi.fn();
    registerSearchIpc({ handle }, roomSource(false));
    const fn = listener(handle, "search_all");
    await expect(Promise.resolve().then(() => fn({}, { query: "anything" }))).rejects.toThrow(
      "No room is open."
    );
  });

  it("reaches the real DB-backed logic, keyed on the `query` arg", async () => {
    setup();
    addFile(db, "deposit.txt", "the deposit amount");
    const handle = vi.fn();
    registerSearchIpc({ handle }, roomSource(true));
    const fn = listener(handle, "search_all");
    const result = await fn({}, { query: "deposit" });
    expect(result).toMatchObject({ messages: [], memories: [] });
    expect((result as { files: unknown[] }).files.length).toBe(1);
  });
});
