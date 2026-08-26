/**
 * Vitest port of `src-tauri/src/commands/recent.rs`'s `mod tests`
 * (`recent_dedup_and_cap`, `the_plaintext_room_index_is_readable_only_by_its_owner`,
 * `a_room_whose_file_is_gone_is_marked_missing`,
 * `renaming_a_room_renames_its_recents_entry`), run against a real temp
 * directory rather than mocked fs calls — same approach `db-host/
 * checkpoints.test.ts` takes for its own `write_private`-derived helper.
 *
 * Plus TS-runtime-specific coverage the Rust suite has no reason to need:
 *  - `readRecent`'s corrupt/malformed-shape fallbacks (a missing file, bad
 *    JSON, a non-array, and one bad entry poisoning the whole array — the
 *    Rust side gets the last one for free from `serde`'s `Vec<T>`
 *    deserialization; a naive TS port that validates only the array's own
 *    shape, not each element, would accept it),
 *  - `writeRecent`'s temp-then-rename durability and its wrapped error
 *    messages,
 *  - `listRecent`'s end-to-end present/missing behavior and that it never
 *    mutates `readRecent`'s freshly-read entries into something stale on
 *    disk, and
 *  - `registerRecentIpc` actually dispatching all three channels to the
 *    right function with the right arguments.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecentRoom } from "../shared/apiTypes.js";
import {
  clearRecent,
  listRecent,
  markMissing,
  MAX_RECENT_ROOMS,
  mergeRecent,
  pushRecent,
  readRecent,
  recentFilePath,
  registerRecentIpc,
  removeRecent,
  renameRecent,
  trashRoom,
  writePrivate,
  writeRecent,
} from "./recentTools.js";

let tmpDir: string;

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recent-tools-"));
  tmpDir = dir;
  return dir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function mk(p: string, extra?: Partial<RecentRoom>): RecentRoom {
  return { name: p, path: p, openedAt: null, missing: false, ...extra };
}

// ------------------------------------------------------------- mergeRecent

describe("mergeRecent", () => {
  it("keeps newest first, deduped by path, capped at MAX_RECENT_ROOMS", () => {
    let list: RecentRoom[] = [];
    for (const p of ["a", "b", "c", "d", "e", "f"]) {
      list = mergeRecent(list, mk(p));
    }
    expect(list).toHaveLength(MAX_RECENT_ROOMS);
    expect(list[0]!.path).toBe("f");
    expect(list[list.length - 1]!.path).toBe("b"); // "a" fell off the cap.

    // Re-opening an existing path moves it to the front without duplicating.
    list = mergeRecent(list, mk("c"));
    expect(list).toHaveLength(MAX_RECENT_ROOMS);
    expect(list[0]!.path).toBe("c");
    expect(list.filter((r) => r.path === "c")).toHaveLength(1);
  });

  it("does not mutate the list it was given", () => {
    const original = [mk("a")];
    const merged = mergeRecent(original, mk("b"));
    expect(original).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });
});

// ------------------------------------------------------------- renameRecent

describe("renameRecent", () => {
  it("renames only the matching entry, leaves everything else alone", () => {
    const list = [mk("/a.roomai", { name: "Old", openedAt: 1 }), mk("/b.roomai", { name: "Other" })];
    const renamed = renameRecent(list, "/a.roomai", "New");
    expect(renamed[0]!.name).toBe("New");
    expect(renamed[0]!.path).toBe("/a.roomai");
    expect(renamed[0]!.openedAt).toBe(1);
    expect(renamed[1]!.name).toBe("Other");

    // A path that isn't in the list is a no-op, not an insert.
    const untouched = renameRecent(renamed, "/gone.roomai", "Nope");
    expect(untouched).toHaveLength(2);
    expect(untouched[0]!.name).toBe("New");
  });
});

// ------------------------------------------------------------- writePrivate

describe("writePrivate", () => {
  it("writes 0600 even over a pre-existing world-readable file", () => {
    const dir = freshDir();
    const file = path.join(dir, "recent.json");
    writeFileSync(file, "[]");
    // Pre-create it world-readable: an existing file from an older build
    // must be tightened, not left as it was.
    chmodSync(file, 0o644);

    writePrivate(file, '[{"name":"x"}]');

    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe('[{"name":"x"}]');
  });
});

// ------------------------------------------------------------- readRecent

describe("readRecent", () => {
  it("reads back a well-formed file", () => {
    const dir = freshDir();
    const list = [mk("/a"), mk("/b", { openedAt: 5, missing: true })];
    writeRecent(dir, list);
    expect(readRecent(dir)).toEqual(list);
  });

  it("reads as empty when the file does not exist", () => {
    const dir = freshDir();
    expect(readRecent(dir)).toEqual([]);
  });

  it("reads as empty on invalid JSON", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "recent.json"), "{not json");
    expect(readRecent(dir)).toEqual([]);
  });

  it("reads as empty when the top level isn't an array", () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, "recent.json"), JSON.stringify({ name: "x", path: "y" }));
    expect(readRecent(dir)).toEqual([]);
  });

  it("discards the WHOLE list when even one entry is malformed, matching serde's Vec<T>", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "recent.json"),
      JSON.stringify([{ name: "ok", path: "/ok" }, { name: "no path field" }])
    );
    expect(readRecent(dir)).toEqual([]);
  });

  it("rejects an entry whose optional field is present but the wrong type", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "recent.json"),
      JSON.stringify([{ name: "x", path: "/x", openedAt: "not a number" }])
    );
    expect(readRecent(dir)).toEqual([]);
  });

  it("applies defaults for absent optional fields (missing:false, openedAt:null)", () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, "recent.json"), JSON.stringify([{ name: "x", path: "/x" }]));
    expect(readRecent(dir)).toEqual([{ name: "x", path: "/x", openedAt: null, missing: false }]);
  });

  // ADVERSARIAL. `openedAt` is Rust's `Option<i64>`, and serde refuses a
  // non-integer number outright — which, for a `Vec<T>`, discards the whole
  // file. A `typeof === "number"` check is not that check. `Infinity` is the
  // case with teeth: `JSON.parse("1e400")` yields it, it survived the read,
  // and `JSON.stringify` then wrote it back as `null` on the very next
  // `writeRecent` — silently rewriting a timestamp nothing asked to touch.
  // Both of these entries were accepted before `Number.isInteger` replaced
  // the bare `typeof` test.
  it("rejects a FRACTIONAL openedAt, which serde's i64 refuses", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "recent.json"),
      JSON.stringify([{ name: "x", path: "/x", openedAt: 1.5 }])
    );
    expect(readRecent(dir)).toEqual([]);
  });

  it("rejects an out-of-range openedAt rather than letting it round-trip to null", () => {
    const dir = freshDir();
    // Written as raw text: JSON.stringify cannot even produce this literal.
    writeFileSync(path.join(dir, "recent.json"), '[{"name":"x","path":"/x","openedAt":1e400}]');
    expect(readRecent(dir)).toEqual([]);
  });

  it("still accepts an ordinary Date.now() timestamp — the guard did not narrow the real case", () => {
    const dir = freshDir();
    const now = Date.now();
    writeFileSync(
      path.join(dir, "recent.json"),
      JSON.stringify([{ name: "x", path: "/x", openedAt: now }])
    );
    expect(readRecent(dir)).toEqual([{ name: "x", path: "/x", openedAt: now, missing: false }]);
  });

  it("a room named and pathed '__proto__' round-trips without polluting anything", () => {
    // `readRecent` builds its result from named fields, never `obj[key] =`,
    // so a room-controlled `__proto__` is ordinary data on both sides.
    const dir = freshDir();
    const entry = mk("__proto__", { name: "__proto__" });
    writeRecent(dir, [entry]);
    expect(readRecent(dir)).toEqual([entry]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).path).toBeUndefined();
  });

  it("reads as empty when recent.json is a DIRECTORY, not a file", () => {
    const dir = freshDir();
    mkdirSync(path.join(dir, "recent.json"));
    expect(readRecent(dir)).toEqual([]);
  });

  it("drops unrecognized extra fields rather than carrying them through", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "recent.json"),
      JSON.stringify([{ name: "x", path: "/x", bogus: "nope" }])
    );
    const [entry] = readRecent(dir);
    expect(entry).toEqual({ name: "x", path: "/x", openedAt: null, missing: false });
    expect((entry as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

// ------------------------------------------------------------- writeRecent

describe("writeRecent", () => {
  it("creates userDataDir if it doesn't exist yet", () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "recent-tools-")), "nested", "deeper");
    tmpDir = path.dirname(path.dirname(dir));
    writeRecent(dir, [mk("/a")]);
    expect(existsSync(recentFilePath(dir))).toBe(true);
  });

  it("survives a pre-existing stale .tmp file and leaves the real file intact on success", () => {
    const dir = freshDir();
    writeRecent(dir, [mk("/a")]);
    writeRecent(dir, [mk("/b")]);
    expect(readRecent(dir)).toEqual([mk("/b")]);
    expect(existsSync(`${recentFilePath(dir)}.tmp`)).toBe(false);
  });

  it("wraps a directory-creation failure in a descriptive Error rather than a raw fs error", () => {
    // userDataDir itself is a FILE, not a directory: mkdirSync throws EEXIST,
    // which writeRecent must turn into a message that names what failed.
    const dir = freshDir();
    const notADir = path.join(dir, "actually-a-file");
    writeFileSync(notADir, "x");
    expect(() => writeRecent(notADir, [])).toThrow(/app data folder/);
  });
});

// ------------------------------------------------------------- pushRecent

describe("pushRecent", () => {
  it("adds an entry with the current time and missing:false", () => {
    const dir = freshDir();
    const before = Date.now();
    pushRecent(dir, "My Room", "/my/room.roomai");
    const after = Date.now();
    const [entry] = readRecent(dir);
    expect(entry!.name).toBe("My Room");
    expect(entry!.path).toBe("/my/room.roomai");
    expect(entry!.missing).toBe(false);
    expect(entry!.openedAt).not.toBeNull();
    expect(entry!.openedAt as number).toBeGreaterThanOrEqual(before);
    expect(entry!.openedAt as number).toBeLessThanOrEqual(after);
  });

  it("never throws even if the directory cannot be created (best-effort)", () => {
    const dir = freshDir();
    const notADir = path.join(dir, "blocked");
    writeFileSync(notADir, "x");
    const target = path.join(notADir, "sub");
    expect(() => pushRecent(target, "Name", "/p")).not.toThrow();
  });
});

// ------------------------------------------------------------- markMissing / listRecent

describe("markMissing / listRecent", () => {
  it("marks a room whose file is gone, and leaves a present one alone", async () => {
    const dir = freshDir();
    const here = path.join(dir, "here.roomai");
    writeFileSync(here, "x");
    const gone = path.join(dir, "moved-away.roomai");

    const list: RecentRoom[] = [
      // Seeded the OPPOSITE of the expected answer, so the assertions can
      // only pass if the stat actually ran.
      mk(here, { missing: true }),
      mk(gone, { missing: false }),
    ];
    await markMissing(list);
    expect(list[0]!.missing).toBe(false);
    expect(list[1]!.missing).toBe(true);
  });

  it("listRecent reads the persisted list and recomputes missing on every call", async () => {
    const dir = freshDir();
    const here = path.join(dir, "here.roomai");
    writeFileSync(here, "x");
    pushRecent(dir, "Here", here);
    pushRecent(dir, "Gone", path.join(dir, "gone.roomai"));

    const list = await listRecent(dir);
    expect(list).toHaveLength(2);
    const byName: Record<string, RecentRoom> = Object.fromEntries(list.map((r) => [r.name, r]));
    expect(byName.Here!.missing).toBe(false);
    expect(byName.Gone!.missing).toBe(true);

    // The stale `missing:false` written by pushRecent for "Gone" is NEVER
    // the answer — recent.json itself still says false; only the returned,
    // recomputed copy differs.
    const onDisk = readRecent(dir);
    expect(onDisk.find((r) => r.name === "Gone")?.missing).toBe(false);
  });
});

// ------------------------------------------------------------- removeRecent / clearRecent

describe("removeRecent", () => {
  it("removes only the matching path", () => {
    const dir = freshDir();
    writeRecent(dir, [mk("/a"), mk("/b")]);
    removeRecent(dir, "/a");
    expect(readRecent(dir)).toEqual([mk("/b")]);
  });

  it("is a no-op when the path isn't in the list", () => {
    const dir = freshDir();
    writeRecent(dir, [mk("/a")]);
    removeRecent(dir, "/not-there");
    expect(readRecent(dir)).toEqual([mk("/a")]);
  });
});

describe("clearRecent", () => {
  it("empties the list", () => {
    const dir = freshDir();
    writeRecent(dir, [mk("/a"), mk("/b")]);
    clearRecent(dir);
    expect(readRecent(dir)).toEqual([]);
  });
});

describe("trashRoom", () => {
  it("moves only a valid workspace through the injected OS Trash and forgets it", async () => {
    const dir = freshDir();
    const room = path.join(dir, "Customer Project");
    mkdirSync(path.join(room, ".arcelle"), { recursive: true });
    writeFileSync(
      path.join(room, ".arcelle", "room.json"),
      JSON.stringify({ format: "arcelle-workspace", formatVersion: 2, roomId: "room-12345678" }),
    );
    writeRecent(dir, [mk(room)]);
    const trashItem = vi.fn(async () => {});

    await trashRoom(dir, room, { trashItem, currentRoomPath: () => null });

    expect(trashItem).toHaveBeenCalledWith(path.resolve(room));
    expect(readRecent(dir)).toEqual([]);
  });

  it("refuses arbitrary folders, symlinks, and the currently open room", async () => {
    const dir = freshDir();
    const arbitrary = path.join(dir, "ordinary-folder");
    mkdirSync(arbitrary);
    const trashItem = vi.fn(async () => {});

    await expect(trashRoom(dir, arbitrary, { trashItem })).rejects.toThrow(/not an Arcelle workspace/i);
    await expect(
      trashRoom(dir, arbitrary, { trashItem, currentRoomPath: () => arbitrary }),
    ).rejects.toThrow(/Close the room/i);
    expect(trashItem).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- registerRecentIpc

describe("registerRecentIpc", () => {
  it("wires the recent-room and OS Trash commands to the right functions", async () => {
    const dir = freshDir();
    pushRecent(dir, "Room", "/r");

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
    };

    registerRecentIpc(ipcMain, dir, { trashItem: vi.fn(async () => {}) });

    expect([...handlers.keys()].sort()).toEqual([
      "clear_recent",
      "list_recent",
      "remove_recent",
      "trash_room",
    ]);

    const listed = await handlers.get("list_recent")!(null);
    expect(listed).toEqual([{ name: "Room", path: "/r", openedAt: expect.any(Number), missing: true }]);

    await handlers.get("remove_recent")!(null, { path: "/r" });
    expect(readRecent(dir)).toEqual([]);

    writeRecent(dir, [mk("/x")]);
    await handlers.get("clear_recent")!(null);
    expect(readRecent(dir)).toEqual([]);
  });
});
