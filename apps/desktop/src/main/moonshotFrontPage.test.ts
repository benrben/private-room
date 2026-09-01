/**
 * Vitest port of `src-tauri/src/commands/moonshot/front_page.rs`'s own
 * `#[cfg(test)] mod tests` (`the_front_page_count_is_the_same_count_everyone
 * _else_shows`, `a_section_only_sketch_is_counted_by_the_room_not_by_the
 * _library`), plus the coverage this port adds for {@link frontPage} and
 * {@link frontPageSuggestions} — neither of which the Rust suite can
 * exercise without a live `AppState`/Tokio runtime.
 *
 * `resolveStructuredModel` itself (imported from `moonshotCmds.ts` — see
 * `moonshotFrontPage.ts`'s own OVERLAP note) is NOT re-tested here in
 * isolation; `moonshotCmds.test.ts` already covers every branch of it
 * directly. What IS specific to this file, and so tested here, is the
 * two-separate-reads fidelity `frontPageSuggestions` inherits from Rust (see
 * the "re-read independently" test below).
 *
 * REAL FIXTURE ROOMS: every test that touches the database opens a real
 * `.roomai` through `createRoom`, matching `feedbackTools.test.ts`'s/
 * `autoIndex.test.ts`'s established convention. `listModels`/`post` are
 * always injected doubles — never the real network — the same convention
 * `feedbackTools.test.ts` documents for the identical reason.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { resetBaseUrlOverrideForTests, resolvedBaseUrl } from "./engineRouting.js";
import { createRoom } from "./db-host/open.js";
import { getMeta, setMeta } from "./db-host/meta.js";
import {
  insertFile,
  insertFileFromUrl,
  listFiles,
  listPublicFiles,
  markDerivedPreview,
  markSectionOnly,
  placementNote,
  trashFile,
} from "./db-host/files.js";
import { roomCounts } from "./db-host/messages.js";
import type { RoomSource } from "./moonshotCmds.js";
import type { OpenRoom } from "./turnEngine.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import {
  FRONT_PAGE_SUGGESTIONS_KEY,
  frontPage,
  frontPageOf,
  frontPageSuggestions,
  registerFrontPageIpc,
  type FrontPageSuggestionsDeps,
} from "./moonshotFrontPage.js";

describe("front-page IPC registration", () => {
  it("serves both empty front-page views while no room is open", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerFrontPageIpc(
      { handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      } } as never,
      { currentRoom: () => null },
    );

    expect(handlers.get("front_page")!({})).toMatchObject({ fileCount: 0 });
    await expect(handlers.get("front_page_suggestions")!({})).resolves.toEqual([]);
    expect([...handlers.keys()]).toEqual(["front_page", "front_page_suggestions"]);
  });
});

let tmpDir: string;

beforeEach(() => {
  resetBaseUrlOverrideForTests();
});

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(name = "Test Room"): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "front-page-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", name);
}

function fakeRooms(handle: OpenRoom | null): RoomSource {
  return { currentRoom: () => handle };
}

/** A `RoomSource` whose `currentRoom()` answers a different handle on each
 * successive call — the only way to exercise the mid-call room-swap paths
 * `resolveStructuredModel` (`moonshotCmds.ts`) and {@link frontPageSuggestions}
 * both re-read `rooms.currentRoom()` for (see `moonshotFrontPage.ts`'s own
 * OVERLAP/fidelity note on why that re-read exists at all). The LAST entry
 * repeats for any call past the end of the list, so a test only has to name
 * the calls it cares about. */
function sequencedRooms(handles: readonly (OpenRoom | null)[]): RoomSource {
  let i = 0;
  return {
    currentRoom: () => {
      const h = handles[Math.min(i, handles.length - 1)];
      i += 1;
      return h ?? null;
    },
  };
}

const noRoom: RoomSource = fakeRooms(null);

/** A `post` double that never touches the network — records every call (for
 * assertions on the RESOLVED model / body) and resolves whatever `outcome`
 * says. */
function fakePost(outcome: SidecarPostOutcome): {
  post: NonNullable<FrontPageSuggestionsDeps["post"]>;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const post: NonNullable<FrontPageSuggestionsDeps["post"]> = async (p, body) => {
    calls.push({ path: p, body });
    return outcome;
  };
  return { post, calls };
}

// ============================================================================
// frontPageOf — ported from front_page.rs's own `#[cfg(test)] mod tests`
// ============================================================================

describe("frontPageOf", () => {
  it("the front page count uses the renderer-visible file population", () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    insertFileFromUrl(
      db, "Google News.md", "text/markdown", Buffer.from("page"), "page", "web",
      "https://news.google.com"
    );
    // The fidelity twin a saved page also writes: no extracted text of its
    // own, still a file the room holds.
    insertFileFromUrl(
      db, "Google News.html", "text/html", Buffer.from("<p>page</p>"), null, "web",
      "https://news.google.com"
    );
    insertFileFromUrl(
      db, "report.pdf", "application/pdf", Buffer.from("%PDF"), null, "download",
      "https://example.test/report.pdf"
    );
    const temp = insertFile(
      db, "Full pass — lease.pdf.html", "text/html", Buffer.from("<p>x</p>"), null, "generated"
    );
    insertFile(db, "Room summary.md", "text/markdown", Buffer.from("s"), "s", "generated");

    let fp = frontPageOf(db);
    expect(fp.fileCount).toBe(6); // browser pages, downloads and generated artifacts are all in the room
    expect(fp.fileCount).toBe(roomCounts(db)[0]); // RoomInfo agrees
    expect(fp.fileCount).toBe(listPublicFiles(db).length);
    // The summary file is kept off the recent-files STRIP (it is the app's
    // own output, not something to reopen) — a display choice that must not
    // shrink the count.
    expect(fp.recentFiles.every((f) => f.name !== "Room summary.md")).toBe(true);

    trashFile(db, temp.id, { kind: "user" });
    fp = frontPageOf(db);
    expect(fp.fileCount).toBe(5); // a deleted file is not in the room any more
    expect(fp.fileCount).toBe(roomCounts(db)[0]);
    expect(fp.fileCount).toBe(listPublicFiles(db).length);
  });

  it("a section-only sketch is counted by the room, not by the Library", () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const sketch = insertFile(db, "Untitled.sketch", "application/json", Buffer.from("{}"), null, "generated");
    markSectionOnly(db, sketch.id, "sketch");

    const fp = frontPageOf(db);
    expect(fp.fileCount).toBe(2); // a sketch is a file the room holds
    const keptOut = listFiles(db).filter((f) => placementNote(f.originDestination, f.libraryVisibility) !== "");
    expect(keptOut.length).toBe(1); // one of the two rows is kept out of the Library
  });

  it("excludes hidden derived previews from both Home count and recent files", () => {
    const db = freshRoom();
    const original = insertFile(
      db, "camera.raw", "image/x-raw", Buffer.from("raw"), null, "upload"
    );
    const preview = insertFile(
      db, "camera-preview.jpg", "image/jpeg", Buffer.from("jpg"), null, "derived-preview"
    );
    markDerivedPreview(db, preview.id, original.id);
    const sketch = insertFile(
      db, "Flow.sketch", "application/json", Buffer.from("{}"), null, "generated"
    );
    markSectionOnly(db, sketch.id, "sketch");

    const fp = frontPageOf(db);
    expect(fp.fileCount).toBe(2);
    expect(fp.fileCount).toBe(listPublicFiles(db).length);
    expect(listFiles(db)).toHaveLength(3); // hidden storage still exists
    expect(fp.recentFiles.map((file) => file.id)).toEqual([sketch.id, original.id]);
    expect(fp.recentFiles.map((file) => file.id)).not.toContain(preview.id);
  });

  it("caps recentFiles/recentChats at 5 but never memories", () => {
    const db = freshRoom();
    for (let i = 0; i < 7; i++) {
      insertFile(db, `file-${i}.txt`, "text/plain", Buffer.from("x"), "x", "upload");
    }
    const fp = frontPageOf(db);
    expect(fp.recentFiles.length).toBe(5);
    expect(fp.fileCount).toBe(7);
  });

  it("reads whatever cached suggestions are stored under FRONT_PAGE_SUGGESTIONS_KEY", () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["What is in this room?"]));
    expect(frontPageOf(db).suggestions).toEqual(["What is in this room?"]);
  });

  it("no cached suggestions reads as an empty list, not a throw", () => {
    const db = freshRoom();
    expect(frontPageOf(db).suggestions).toEqual([]);
  });

  it("ALL of the cached array or NONE of it — one non-string element rejects the whole cache", () => {
    // serde_json::from_str::<Vec<String>>'s own all-or-nothing contract: a
    // single element that survived as a number (a hand-edited row, or a
    // future format change) fails the WHOLE typed parse in Rust, not just
    // that element.
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["a", 2, "b"]));
    expect(frontPageOf(db).suggestions).toEqual([]);
  });

  it("invalid JSON in the cache reads as empty, not a throw", () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, "{not json");
    expect(frontPageOf(db).suggestions).toEqual([]);
  });

  it("a JSON value that parses but isn't an array reads as empty", () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify({ questions: ["a"] }));
    expect(frontPageOf(db).suggestions).toEqual([]);
  });
});

// ============================================================================
// frontPage — the #[tauri::command] layer
// ============================================================================

describe("frontPage", () => {
  it("no room open answers the all-zero page, not a throw", () => {
    expect(frontPage(noRoom)).toEqual({
      recentFiles: [],
      recentChats: [],
      memories: [],
      suggestions: [],
      fileCount: 0,
      chatCount: 0,
    });
  });

  it("a room open delegates to frontPageOf", () => {
    const db = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    expect(frontPage(rooms)).toEqual(frontPageOf(db));
  });
});

// ============================================================================
// frontPageSuggestions
// ============================================================================

describe("frontPageSuggestions", () => {
  it("no room open answers an empty list", async () => {
    const questions = await frontPageSuggestions({ rooms: noRoom });
    expect(questions).toEqual([]);
  });

  it("a room with no (non-summary) files answers empty, even if something was cached", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["stale question"]));
    // Only a summary file — filtered out of the name list before the
    // emptiness check, so this room counts as having none.
    insertFile(db, "Room summary.html", "text/html", Buffer.from("<p>s</p>"), null, "generated");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"] });
    expect(questions).toEqual([]);
  });

  it("offline (no resolvable model) falls back to the cached list", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["What's in here?"]));
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => [] });
    expect(questions).toEqual(["What's in here?"]);
  });

  it("a sidecar error falls back to the cached list", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["cached one"]));
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post } = fakePost({ kind: "error", error: { code: "ENGINE_ERROR", error: "boom", status: 500 } });
    const questions = await frontPageSuggestions({
      rooms,
      listModels: async () => ["qwen3.5:4b"],
      post,
    });
    expect(questions).toEqual(["cached one"]);
  });

  it("an empty questions array from the sidecar falls back to the cached list (and does not overwrite it)", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["cached one"]));
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post } = fakePost({ kind: "value", value: { questions: [] } });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });
    expect(questions).toEqual(["cached one"]);
    expect(getMeta(db, FRONT_PAGE_SUGGESTIONS_KEY)).toBe(JSON.stringify(["cached one"]));
  });

  it("a real reply is returned AND cached under the room it was generated for", async () => {
    const db = freshRoom("Lease Room");
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post, calls } = fakePost({
      kind: "value",
      value: { questions: ["When does the lease end?", "Who is the landlord?"] },
    });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });
    expect(questions).toEqual(["When does the lease end?", "Who is the landlord?"]);
    expect(getMeta(db, FRONT_PAGE_SUGGESTIONS_KEY)).toBe(JSON.stringify(questions));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/label");
    expect(calls[0]!.body).toEqual({
      model: "qwen3.5:4b",
      base_url: resolvedBaseUrl(),
      room_name: "Lease Room",
      files: ["lease.pdf"],
    });
  });

  it("the room's stored name is used, falling back to the filename stem only when unset", async () => {
    // createRoom always stamps a name into meta, so exercise the fallback
    // directly by clearing it, matching roomManager.ts's own
    // `getMeta(conn, "name") ?? roomNameFromPath(roomPath)` precedence.
    const db = freshRoom("Named Room");
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const roomPath = path.join(tmpDir, "My Fallback Room.roomai");
    db.prepare("DELETE FROM meta WHERE key = 'name'").run();
    const rooms = fakeRooms({ db, path: roomPath });
    const { post, calls } = fakePost({ kind: "value", value: { questions: ["q"] } });
    await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });
    expect((calls[0]!.body as { room_name: string }).room_name).toBe("My Fallback Room");
  });

  it("non-string elements in the sidecar's questions array are dropped, not fatal to the whole reply", async () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post } = fakePost({ kind: "value", value: { questions: ["a", 2, "b", null] } });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });
    expect(questions).toEqual(["a", "b"]);
  });

  it("a reply with no questions key, or a non-array questions, answers empty (falls back to cached)", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["cached"]));
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post } = fakePost({ kind: "value", value: { notQuestions: ["a"] } });
    expect(await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post })).toEqual([
      "cached",
    ]);
  });

  // ADVERSARIAL. Same discipline `feedbackTools.ts`'s `readDraft` test proves
  // for `title`/`body`: an `Object.prototype` polluted elsewhere in the app
  // must never stand in for a field the reply itself never sent.
  it("a polluted Object.prototype.questions never stands in for a missing field", async () => {
    const db = freshRoom();
    setMeta(db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["cached"]));
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const rooms = fakeRooms({ db, path: "x.roomai" });
    const { post } = fakePost({ kind: "value", value: {} });
    Object.defineProperty(Object.prototype, "questions", {
      value: ["poisoned"],
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });
      expect(questions).toEqual(["cached"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "questions");
    }
  });

  it("a room swapped mid-generation still returns the fresh questions, but does not cache them into the new room", async () => {
    const dbA = freshRoom("Room A");
    insertFile(dbA, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const dbB = freshRoom("Room B");
    setMeta(dbB, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(["room b's own cached question"]));

    const roomA: OpenRoom = { db: dbA, path: "a.roomai" };
    const roomB: OpenRoom = { db: dbB, path: "b.roomai" };
    // Snapshot (call 1) and resolveStructuredModel's own re-read (call 2) both
    // see room A; the "still open?" check after the POST (call 3) finds room
    // B — simulating a room switch that happened while the sidecar call was
    // in flight.
    const rooms = sequencedRooms([roomA, roomA, roomB]);
    const { post } = fakePost({ kind: "value", value: { questions: ["a fresh question"] } });
    const questions = await frontPageSuggestions({ rooms, listModels: async () => ["qwen3.5:4b"], post });

    expect(questions).toEqual(["a fresh question"]);
    // Room A never receives the write (nothing was open there when the
    // caching check ran, per the sequenced fake) and Room B's own cache is
    // untouched by a generation that was never about it.
    expect(getMeta(dbA, FRONT_PAGE_SUGGESTIONS_KEY)).toBeNull();
    expect(getMeta(dbB, FRONT_PAGE_SUGGESTIONS_KEY)).toBe(JSON.stringify(["room b's own cached question"]));
  });

  it("resolveStructuredModel is re-read independently — an explicit model set on the room the moment of the SECOND read is honored, matching Rust's independent re-lock", async () => {
    // FIDELITY: `resolve_structured_model(&state)` re-locks `state.room`
    // fresh rather than reusing the room this function itself snapshotted a
    // moment earlier. Modeled here by having call 2 (the one
    // resolveStructuredModel makes) answer a DIFFERENT room's db than call 1
    // (this function's own initial snapshot) — proving the model comes from
    // whichever room answers the SECOND call.
    const dbSnapshot = freshRoom("Snapshot Room");
    insertFile(dbSnapshot, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const dbSecondRead = freshRoom("Second Read Room");
    const { setSetting } = await import("./db-host/settings.js");
    setSetting(dbSecondRead, "model", "claude-cli::sonnet");

    const roomSnapshot: OpenRoom = { db: dbSnapshot, path: "snapshot.roomai" };
    const roomSecondRead: OpenRoom = { db: dbSecondRead, path: "second-read.roomai" };
    const rooms = sequencedRooms([roomSnapshot, roomSecondRead, roomSnapshot]);
    const { post, calls } = fakePost({ kind: "value", value: { questions: ["q"] } });

    await frontPageSuggestions({ rooms, listModels: async () => [], post });

    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { model: string }).model).toBe("claude-cli::sonnet");
  });
});

// ============================================================================
// ADVERSARIAL — the cache write is best-effort (`let _ = db::set_meta(...)`)
// ============================================================================

describe("frontPageSuggestions — adversarial", () => {
  it("still answers the generated questions when the meta CACHE write fails", async () => {
    // Rust: `if let Ok(json) = serde_json::to_string(&questions) { let _ =
    // db::set_meta(&room.conn, FRONT_PAGE_SUGGESTIONS_KEY, &json); }` — BOTH
    // the serialize and the write are discarded, and `Ok(questions)` is
    // returned regardless. This port let `setMeta` throw straight out of the
    // command, so a room whose DB was momentarily read-only (a full disk, a
    // backup holding the file, a rollback mid-swap) turned a generation that
    // had just cost minutes of local-model time into a failed command with
    // nothing to show — and would do it again on every retry.
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("%PDF"), "rent", "upload");
    const room: OpenRoom = { db, path: "/tmp/one.roomai" };
    const { post } = fakePost({ kind: "value", value: { questions: ["What is the deposit?"] } });
    db.pragma("query_only = true");
    await expect(
      frontPageSuggestions({ rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post })
    ).resolves.toEqual(["What is the deposit?"]);
    db.pragma("query_only = false");
    // Nothing was cached — the answer was returned, not invented from a cache
    // it never managed to write.
    expect(getMeta(db, FRONT_PAGE_SUGGESTIONS_KEY)).toBeNull();
  });
});
