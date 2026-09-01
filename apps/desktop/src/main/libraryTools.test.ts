/**
 * Vitest port of `src-tauri/src/commands/library.rs`'s `#[cfg(test)] mod
 * tests`, 1:1 in spirit (one test is behavioral rather than textual — see its
 * own note):
 *
 *   - an_over_long_memory_is_refused_rather_than_quietly_cut_in_half
 *   - both_memory_commands_check_the_cap_before_storing (adapted)
 *   - a_trashed_memory_does_not_block_re_adding_the_same_text
 *   - memory_dedup_normalization
 *   - normalize_category_accepts_vocab_rejects_junk
 *
 * PLUS, since this port turns the `#[tauri::command]` wrappers into ordinary
 * directly-callable functions rather than leaving them behind an IPC boundary
 * (the same reasoning `privacy.test.ts` gives): end-to-end coverage of every
 * command against a REAL fixture room, and a registration test for
 * `registerLibraryIpc` in `recIpc.test.ts`'s own style.
 *
 * REAL FIXTURE ROOMS throughout — every test opens a real `.roomai` file via
 * `createRoom`, this directory's established convention.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { activePolicy, clearPolicy, type PolicyDeps } from "./privacy.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  addMemory,
  createFolder,
  deleteFolder,
  deleteMemory,
  duplicateMemory,
  getSetting,
  listFolders,
  listMemories,
  memoryWithinCap,
  moveFileToFolder,
  normalizeCategory,
  registerLibraryIpc,
  renameFolder,
  restoreMemory,
  setSetting,
  updateMemory,
} from "./libraryTools.js";
import { MAX_MEMORY_CONTENT_CHARS } from "./toolSpecs.js";

let tmpDir: string | null = null;
let open: Database.Database | null = null;

afterEach(() => {
  open?.close();
  open = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
  clearPolicy();
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "libraryTools-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function addFile(db: Database.Database, name: string, body: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(body, "utf8"), body, "upload").id;
}

/** A fixed {@link RoomSource} double, matching `privacy.test.ts`'s own
 * fixture shape — `jobs.ts`'s `{ current(): RoomHandle | null }`. */
function roomSource(handle: RoomHandle | null): RoomSource {
  return { current: () => handle };
}

function policyDeps(room: RoomSource, userDataDir = mkdtempSync(path.join(os.tmpdir(), "libraryTools-priv-"))): PolicyDeps {
  return { room, userDataDir };
}

// ---------------------------------------------------------------------------
// memory_within_cap
// ---------------------------------------------------------------------------

describe("memoryWithinCap", () => {
  it("an_over_long_memory_is_refused_rather_than_quietly_cut_in_half", () => {
    // Exactly the cap is a memory, not an error.
    const atCap = "a".repeat(MAX_MEMORY_CONTENT_CHARS);
    expect([...memoryWithinCap(atCap)].length).toBe(MAX_MEMORY_CONTENT_CHARS);
    expect(memoryWithinCap("")).toBe("");
    // One past it is refused — the paragraph used to come back 500 characters
    // long, with the rest gone and nothing to restore it from.
    const over = "a".repeat(MAX_MEMORY_CONTENT_CHARS + 1);
    expect(() => memoryWithinCap(over)).toThrowError(String(MAX_MEMORY_CONTENT_CHARS + 1));
    // Counted in Unicode CODE POINTS: a full-length note typed in Hebrew stays
    // exactly at the cap rather than being rationed differently than English.
    const hebrew = "א".repeat(MAX_MEMORY_CONTENT_CHARS);
    expect(memoryWithinCap(hebrew)).toBe(hebrew);
  });

  // ADVERSARIAL: an ASTRAL-PLANE note is the case that tells the three
  // plausible length units apart. Rust counts `chars()` — Unicode scalar
  // values — so an emoji is ONE character. `content.length` in JS counts
  // UTF-16 code units, where the same emoji is TWO, and would have refused a
  // note Rust accepts at exactly half the length. Hebrew (the Rust suite's own
  // fixture) only separates bytes from characters; it cannot catch this,
  // because every Hebrew letter is a single UTF-16 unit.
  it("an emoji note is rationed by code points, exactly as chars().count() does — not by UTF-16 units", () => {
    const atCap = "\u{1F600}".repeat(MAX_MEMORY_CONTENT_CHARS);
    expect(atCap.length).toBe(MAX_MEMORY_CONTENT_CHARS * 2); // the fixture must be surrogate-paired
    expect(memoryWithinCap(atCap)).toBe(atCap);
    const over = "\u{1F600}".repeat(MAX_MEMORY_CONTENT_CHARS + 1);
    expect(() => memoryWithinCap(over)).toThrowError(String(MAX_MEMORY_CONTENT_CHARS + 1));
  });

  it("the same cap, through the real add_memory, stores the at-cap emoji note and refuses the one past it", () => {
    const db = freshRoom();
    const atCap = "\u{1F600}".repeat(MAX_MEMORY_CONTENT_CHARS);
    expect(() => addMemory(db, atCap)).not.toThrow();
    expect(() => addMemory(db, "\u{1F600}".repeat(MAX_MEMORY_CONTENT_CHARS + 1))).toThrow();
    expect(listMemories(db)).toHaveLength(1);
  });

  it("both add_memory and update_memory refuse an over-long memory before storing", () => {
    // The Rust suite pins this textually (`include_str!` counting call
    // sites) because a Rust unit test cannot drive a `#[tauri::command]`
    // taking `State<'_, AppState>`. This port turns both commands into
    // ordinary functions, so the same guarantee is checked BEHAVIORALLY: a
    // real fixture room must refuse the write, not merely refuse in theory.
    const db = freshRoom();
    const over = "a".repeat(MAX_MEMORY_CONTENT_CHARS + 1);
    expect(() => addMemory(db, over)).toThrowError(String(MAX_MEMORY_CONTENT_CHARS + 1));
    expect(listMemories(db)).toEqual([]);

    const m = addMemory(db, "short note");
    expect(() => updateMemory(db, m.id, over)).toThrowError(String(MAX_MEMORY_CONTENT_CHARS + 1));
    expect(listMemories(db)[0]?.content).toBe("short note");
  });
});

// ---------------------------------------------------------------------------
// duplicate_memory
// ---------------------------------------------------------------------------

describe("duplicateMemory", () => {
  it("a_trashed_memory_does_not_block_re_adding_the_same_text", () => {
    const db = freshRoom();
    const m1 = addMemory(db, "buy milk");
    expect(duplicateMemory(db, "buy milk")).not.toBeNull();
    deleteMemory(db, m1.id);
    expect(duplicateMemory(db, "buy milk")).toBeNull();
  });

  it("memory_dedup_normalization", () => {
    const db = freshRoom();
    addMemory(db, "The dog is named Rex");
    // Case and whitespace differences collapse to the same key (an exact
    // duplicate) …
    expect(duplicateMemory(db, "the   dog  is named rex")).not.toBeNull();
    // … but a genuinely different fact does not.
    expect(duplicateMemory(db, "The cat is named Rex")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalize_category
// ---------------------------------------------------------------------------

describe("normalizeCategory", () => {
  it("normalize_category_accepts_vocab_rejects_junk", () => {
    expect(normalizeCategory("preference")).toBe("preference");
    expect(normalizeCategory(" Fact ")).toBe("fact");
    expect(normalizeCategory("PROJECT")).toBe("project");
    expect(normalizeCategory("instruction")).toBe("instruction");
    // …and everything else degrades to uncategorized, never an error.
    expect(normalizeCategory("preferences")).toBeNull();
    expect(normalizeCategory("misc")).toBeNull();
    expect(normalizeCategory("")).toBeNull();
  });

  // ADVERSARIAL: the category is MODEL-controlled text (the Rust doc's own
  // reason for the fold: "a 4B model cannot be trusted to reproduce an enum
  // exactly"). A `switch` over a plain string cannot be tricked by a
  // prototype key the way an object lookup could, and the fold must return
  // one of the four frozen literals or `null` — never the caller's own string
  // echoed back.
  it("a prototype-shaped or otherwise hostile category is uncategorized, never echoed back", () => {
    for (const raw of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
      expect(normalizeCategory(raw)).toBeNull();
    }
    // Whitespace-only is junk; a real word wearing whitespace is not
    // (Rust trims first, and `str::trim` covers \n and \t as well as spaces).
    expect(normalizeCategory("   ")).toBeNull();
    expect(normalizeCategory("\n\tfact\r\n")).toBe("fact");
    // A recognized word only ever comes back as the frozen literal — not the
    // caller's spelling of it.
    expect(normalizeCategory("  FACT  ")).toBe("fact");
  });
});

// ---------------------------------------------------------------------------
// addMemory / updateMemory / deleteMemory / restoreMemory / listMemories
// ---------------------------------------------------------------------------

describe("memory commands", () => {
  it("adding an exact duplicate hands back the existing entry rather than a new row", () => {
    const db = freshRoom();
    const first = addMemory(db, "answers in Hebrew, please", "preference");
    const second = addMemory(db, "answers in Hebrew, please");
    expect(second).toEqual(first);
    expect(listMemories(db)).toHaveLength(1);
  });

  it("an unrecognized category degrades to uncategorized rather than erroring", () => {
    const db = freshRoom();
    const m = addMemory(db, "note", "not-a-real-category");
    expect(m.category).toBeNull();
  });

  it("update_memory carries the cap and category folding the same way add_memory does", () => {
    const db = freshRoom();
    const m = addMemory(db, "old text", "preference");
    updateMemory(db, m.id, "new text", "instruction");
    expect(listMemories(db)[0]).toMatchObject({ content: "new text", category: "instruction" });
    // Editing a note that is not in this room is refused, not a no-op.
    expect(() => updateMemory(db, "no-such-id", "x")).toThrowError("not in this room");
  });

  it("delete_memory attributes a UI delete to the user, and content survives soft-delete", () => {
    const db = freshRoom();
    const m = addMemory(db, "call every Friday");
    deleteMemory(db, m.id);
    expect(listMemories(db)).toEqual([]);
    const raw = db
      .prepare("SELECT content, trashed_by FROM memories WHERE id = ?")
      .get(m.id) as { content: string; trashed_by: string };
    expect(raw.content).toBe("call every Friday");
    expect(raw.trashed_by).toBe("user");
    // A second delete is refused, not re-stamped.
    expect(() => deleteMemory(db, m.id)).toThrowError("not in this room");
  });

  it("restore_memory returns a trashed memory to every listing", () => {
    const db = freshRoom();
    const m = addMemory(db, "call every Friday");
    deleteMemory(db, m.id);
    restoreMemory(db, m.id);
    expect(listMemories(db)).toHaveLength(1);
    expect(listMemories(db)[0]?.content).toBe("call every Friday");
  });
});

// ---------------------------------------------------------------------------
// folders (ADD-16) — thin pass-through sanity; db-host/folders.test.ts owns
// the exhaustive behavior suite.
// ---------------------------------------------------------------------------

describe("folder commands", () => {
  it("create/list/rename/delete/move all reach the real db-host logic", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Contracts");
    expect(listFolders(db)).toEqual([folder]);
    renameFolder(db, folder.id, "Legal");
    expect(listFolders(db)[0]?.name).toBe("Legal");

    const fileId = addFile(db, "a.txt", "alpha");
    moveFileToFolder(db, fileId, folder.id);
    moveFileToFolder(db, fileId, null);

    deleteFolder(db, folder.id);
    expect(listFolders(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// get_setting / set_setting
// ---------------------------------------------------------------------------

describe("settings commands", () => {
  it("get_setting/set_setting round-trip through the real settings table", () => {
    const db = freshRoom();
    expect(getSetting(db, "theme")).toBeNull();
    const deps = policyDeps(roomSource({ db, path: "irrelevant" }));
    setSetting(deps, "theme", "dark");
    expect(getSetting(db, "theme")).toBe("dark");
    // A second write on the same key replaces it rather than erroring.
    setSetting(deps, "theme", "light");
    expect(getSetting(db, "theme")).toBe("light");
  });

  it("set_setting refreshes the cached privacy policy only for a privacy or model key (PRIV-1)", () => {
    const db = freshRoom();
    const deps = policyDeps(roomSource({ db, path: "irrelevant" }));

    // An unrelated key does not touch the cache at all — it stays exactly as
    // cleared, which would NOT be true if refresh_policy had actually run
    // (this fixture's default-on global policy always computes active).
    clearPolicy();
    setSetting(deps, "some_other_setting", "x");
    expect(activePolicy()).toBeNull();

    // A key starting with "cloud_privacy" triggers the refresh …
    clearPolicy();
    setSetting(deps, "cloud_privacy_concepts", "[]");
    expect(activePolicy()).not.toBeNull();

    // … and so does the "model" key, on its own.
    clearPolicy();
    setSetting(deps, "model", "qwen3.5:4b");
    expect(activePolicy()).not.toBeNull();
  });

  it("set_setting refuses when no room is open, and never reaches the DB", () => {
    const deps = policyDeps(roomSource(null));
    expect(() => setSetting(deps, "theme", "dark")).toThrowError("No room is open.");
  });
});

// ---------------------------------------------------------------------------
// registerLibraryIpc
// ---------------------------------------------------------------------------

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

/** Every channel `registerLibraryIpc` registers, in order — pinned so a
 * channel silently dropped from the list fails here rather than shipping
 * unnoticed. These are the Rust `#[tauri::command]` names. */
const EXPECTED_CHANNELS = [
  "add_memory",
  "list_memories",
  "update_memory",
  "delete_memory",
  "restore_memory",
  "list_folders",
  "create_folder",
  "rename_folder",
  "delete_folder",
  "move_file_to_folder",
  "get_setting",
  "set_setting",
];

describe("registerLibraryIpc", () => {
  it("registers every library.rs channel exactly once", () => {
    const db = freshRoom();
    const handle = vi.fn();
    const deps = policyDeps(roomSource({ db, path: "irrelevant" }));
    registerLibraryIpc({ handle }, deps);
    expect(handle.mock.calls.map((c) => c[0] as string)).toEqual(EXPECTED_CHANNELS);
  });

  it("a handler that needs a room refuses cleanly when none is open", async () => {
    const handle = vi.fn();
    const deps = policyDeps(roomSource(null));
    registerLibraryIpc({ handle }, deps);
    await expect(
      Promise.resolve().then(() => listener(handle, "list_memories")({}))
    ).rejects.toThrowError("No room is open.");
  });

  it("a room-backed handler reaches the real DB logic, not a stub", async () => {
    const db = freshRoom();
    const handle = vi.fn();
    const deps = policyDeps(roomSource({ db, path: "irrelevant" }));
    registerLibraryIpc({ handle }, deps);

    await listener(handle, "add_memory")({}, { content: "likes tea", category: "preference" });
    const listed = (await listener(handle, "list_memories")({})) as Array<{ content: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.content).toBe("likes tea");

    const folder = (await listener(handle, "create_folder")({}, { name: "Notes" })) as { id: string };
    expect(((await listener(handle, "list_folders")({})) as unknown[]).length).toBe(1);
    await listener(handle, "delete_folder")({}, { id: folder.id });
    expect(((await listener(handle, "list_folders")({})) as unknown[]).length).toBe(0);
  });

  it("forwards memory updates, folder renames, and nullable folder moves", async () => {
    const db = freshRoom();
    const handle = vi.fn();
    const deps = policyDeps(roomSource({ db, path: "irrelevant" }));
    registerLibraryIpc({ handle }, deps);

    const memory = await listener(handle, "add_memory")({}, { content: "tea", category: null }) as { id: string };
    await listener(handle, "update_memory")({}, {
      id: memory.id,
      content: "green tea",
      category: "preference",
    });
    expect((await listener(handle, "list_memories")({}) as Array<{ content: string }>)[0]?.content)
      .toBe("green tea");

    const folder = await listener(handle, "create_folder")({}, { name: "Drafts" }) as { id: string };
    await listener(handle, "rename_folder")({}, { id: folder.id, name: "Final" });
    expect((await listener(handle, "list_folders")({}) as Array<{ name: string }>)[0]?.name).toBe("Final");

    const fileId = addFile(db, "move.txt", "content");
    await listener(handle, "move_file_to_folder")({}, { fileId, folderId: folder.id });
    await listener(handle, "move_file_to_folder")({}, { fileId });
  });
});
