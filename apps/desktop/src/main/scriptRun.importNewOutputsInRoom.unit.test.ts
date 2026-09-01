import path from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import type { FileMeta } from "./db-host/files.js";
import {
  MAX_IMPORT_BYTES,
  MAX_NEW_FILES,
  importNewOutputsInRoomForTest,
  type NewOutputImportDeps,
} from "./scriptRun.js";

const FAKE_DB = {} as Database.Database;
const ROOM_PATH = "/fake-room";
const WORKSPACE = "/fake-workspace";
const CAUSE = "Script ran — fake.js";

function fakeMeta(name: string): FileMeta {
  return { id: `file-${name}`, name } as FileMeta;
}

function fakeOutputDeps(
  files: Readonly<Record<string, Buffer>>,
  writeOutput: NewOutputImportDeps["writeOutput"],
  sizes: Readonly<Record<string, number>> = {},
): NewOutputImportDeps {
  return {
    listWorkspaceFiles: () => Object.keys(files).sort(),
    fileSize: (filePath) => sizes[path.basename(filePath)] ?? files[path.basename(filePath)]!.length,
    readFile: (filePath) => files[path.basename(filePath)]!,
    writeOutput,
  };
}

describe("importNewOutputsInRoomForTest", () => {
  it("imports unhandled outputs and marks an undeclared replacement", async () => {
    const writes: Array<{ name: string; bytes: Buffer; cause: string }> = [];
    const deps = fakeOutputDeps(
      {
        "existing.txt": Buffer.from("replacement"),
        "fresh.txt": Buffer.from("fresh"),
        "script.js": Buffer.from("not an output"),
      },
      async (_db, _roomPath, name, bytes, cause) => {
        writes.push({ name, bytes, cause });
        return { meta: fakeMeta(name), replaced: name === "existing.txt" };
      },
    );

    const result = await importNewOutputsInRoomForTest(
      FAKE_DB, ROOM_PATH, WORKSPACE, CAUSE, ["script.js"], deps,
    );

    expect(result.imported.map((item) => item.name)).toEqual(["existing.txt", "fresh.txt"]);
    expect(result.skipped).toEqual([
      "existing.txt: a room file of that name already existed — the script's version was saved over it as a new version (undo via Time Machine); declare it in room-outputs to make that explicit",
    ]);
    expect(writes).toEqual([
      { name: "existing.txt", bytes: Buffer.from("replacement"), cause: CAUSE },
      { name: "fresh.txt", bytes: Buffer.from("fresh"), cause: CAUSE },
    ]);
  });

  it("returns an empty report when the workspace has no new outputs", async () => {
    const deps: NewOutputImportDeps = {
      listWorkspaceFiles: () => [],
      fileSize: () => { throw new Error("must not stat an absent output"); },
      readFile: () => { throw new Error("must not read an absent output"); },
      writeOutput: async () => { throw new Error("must not write an absent output"); },
    };

    await expect(
      importNewOutputsInRoomForTest(FAKE_DB, ROOM_PATH, WORKSPACE, CAUSE, [], deps),
    ).resolves.toEqual({ imported: [], skipped: [] });
  });

  it("refuses overflow files without reading or writing them", async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_NEW_FILES + 1 }, (_, index) => [
        `output-${String(index).padStart(2, "0")}.txt`,
        Buffer.from("x"),
      ]),
    ) as Record<string, Buffer>;
    const writes: string[] = [];
    const deps = fakeOutputDeps(files, async (_db, _roomPath, name) => {
      writes.push(name);
      return { meta: fakeMeta(name), replaced: false };
    });

    const result = await importNewOutputsInRoomForTest(
      FAKE_DB, ROOM_PATH, WORKSPACE, CAUSE, [], deps,
    );

    expect(writes).toHaveLength(MAX_NEW_FILES);
    expect(result.imported).toHaveLength(MAX_NEW_FILES);
    expect(result.skipped).toEqual([
      `output-${String(MAX_NEW_FILES).padStart(2, "0")}.txt: skipped (new-file import cap reached)`,
    ]);
  });

  it("refuses an oversized output before reading or writing it", async () => {
    const baseDeps = fakeOutputDeps(
      { "too-large.bin": Buffer.from("placeholder") },
      async () => { throw new Error("must not write an oversized output"); },
      { "too-large.bin": MAX_IMPORT_BYTES + 1 },
    );
    const deps: NewOutputImportDeps = {
      ...baseDeps,
      readFile: () => { throw new Error("must not read an oversized output"); },
    };

    await expect(
      importNewOutputsInRoomForTest(FAKE_DB, ROOM_PATH, WORKSPACE, CAUSE, [], deps),
    ).resolves.toEqual({
      imported: [],
      skipped: ["too-large.bin: skipped (new-file import cap reached)"],
    });
  });

  it("propagates a write failure, preserving earlier writes and stopping later outputs", async () => {
    const writes: string[] = [];
    const deps = fakeOutputDeps(
      {
        "01-first.txt": Buffer.from("first"),
        "02-broken.txt": Buffer.from("broken"),
        "03-later.txt": Buffer.from("later"),
      },
      async (_db, _roomPath, name) => {
        writes.push(name);
        if (name === "02-broken.txt") throw new Error("fabricated workspace write failure");
        return { meta: fakeMeta(name), replaced: false };
      },
    );

    await expect(
      importNewOutputsInRoomForTest(FAKE_DB, ROOM_PATH, WORKSPACE, CAUSE, [], deps),
    ).rejects.toThrow("fabricated workspace write failure");

    expect(writes).toEqual(["01-first.txt", "02-broken.txt"]);
  });
});
