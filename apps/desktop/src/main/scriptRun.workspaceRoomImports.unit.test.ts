import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import type { FileMeta } from "./db-host/files.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";
import {
  importOutputsInRoomForTest,
  importModifiedOutputsInRoomForTest,
  materializeNamedInRoomForTest,
  scriptFingerprint,
  parseScriptManifest,
  type Materialized,
  type ModifiedOutputImportDeps,
  type NamedRoomMaterializationDeps,
} from "./scriptRun.js";

const FAKE_DB = {} as Database.Database;
const ROOM_PATH = "/fake-room";
const WORKSPACE = "/fake-workspace";
const CAUSE = "Script ran — fake.js";

function fakeMeta(name: string): FileMeta {
  return { id: `file-${name}`, name } as FileMeta;
}

describe("materializeNamedInRoomForTest", () => {
  it("writes each usable safe name once and returns its content fingerprint", async () => {
    const reportBytes = Buffer.from("report bytes");
    const lookedUp: string[] = [];
    const readIds: string[] = [];
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    const deps: NamedRoomMaterializationDeps = {
      findFile: (_db, name) => {
        lookedUp.push(name);
        if (name === "folder/report.csv") return { id: "report" };
        if (name === "empty.txt") return { id: "empty" };
        return null;
      },
      readRoomFile: async (room, id) => {
        expect(room).toEqual({ db: FAKE_DB, path: ROOM_PATH });
        readIds.push(id);
        return { bytes: id === "report" ? reportBytes : null };
      },
      writeWorkspaceFile: (filePath, bytes) => { writes.push({ path: filePath, bytes }); },
    };

    const result = await materializeNamedInRoomForTest(
      FAKE_DB,
      ROOM_PATH,
      WORKSPACE,
      ["folder/report.csv", "report.csv", "reserved.txt", "missing.txt", "empty.txt"],
      new Set(["reserved.txt"]),
      deps,
    );

    expect(result).toEqual([{ name: "report.csv", sha: scriptFingerprint(reportBytes) }]);
    expect(lookedUp).toEqual(["folder/report.csv", "missing.txt", "empty.txt"]);
    expect(readIds).toEqual(["report", "empty"]);
    expect(writes).toEqual([{ path: path.join(WORKSPACE, "report.csv"), bytes: reportBytes }]);
  });

  it("propagates a workspace-write error after earlier fake writes and stops later names", async () => {
    const writes: string[] = [];
    const deps: NamedRoomMaterializationDeps = {
      findFile: (_db, name) => ({ id: name }),
      readRoomFile: async (_room, id) => ({ bytes: Buffer.from(id) }),
      writeWorkspaceFile: (filePath) => {
        const name = path.basename(filePath);
        writes.push(name);
        if (name === "02-broken.txt") throw new Error("fabricated workspace write failure");
      },
    };

    await expect(
      materializeNamedInRoomForTest(
        FAKE_DB,
        ROOM_PATH,
        WORKSPACE,
        ["01-first.txt", "02-broken.txt", "03-later.txt"],
        new Set(),
        deps,
      ),
    ).rejects.toThrow("fabricated workspace write failure");

    expect(writes).toEqual(["01-first.txt", "02-broken.txt"]);
  });
});

describe("importModifiedOutputsInRoomForTest", () => {
  it("saves only changed, undeclared materialized files and explains the version", async () => {
    const original = Buffer.from("original");
    const changed = Buffer.from("changed");
    const same = Buffer.from("same");
    const reads = new Map<string, Buffer | null>([
      ["changed.txt", changed],
      ["same.txt", same],
      ["declared.txt", changed],
      ["missing.txt", null],
    ]);
    const writes: Array<{ name: string; bytes: Buffer; cause: string }> = [];
    const deps: ModifiedOutputImportDeps = {
      readMaterialized: (_workspace, name) => reads.get(name) ?? null,
      writeOutput: async (_db, _roomPath, name, bytes, cause) => {
        writes.push({ name, bytes, cause });
        return { meta: fakeMeta(name), replaced: true };
      },
    };
    const materialized: Materialized[] = [
      { name: "changed.txt", sha: scriptFingerprint(original) },
      { name: "same.txt", sha: scriptFingerprint(same) },
      { name: "declared.txt", sha: scriptFingerprint(original) },
      { name: "missing.txt", sha: scriptFingerprint(original) },
    ];

    const result = await importModifiedOutputsInRoomForTest(
      FAKE_DB, ROOM_PATH, WORKSPACE, materialized, ["declared.txt"], CAUSE, deps,
    );

    expect(result.imported.map((item) => item.name)).toEqual(["changed.txt"]);
    expect(result.skipped).toEqual([
      "changed.txt: updated in place by the script — saved back as a new version (undo via Time Machine)",
    ]);
    expect(writes).toEqual([{ name: "changed.txt", bytes: changed, cause: CAUSE }]);
  });

  it("propagates a write failure after earlier changed outputs and skips later outputs", async () => {
    const before = Buffer.from("before");
    const reads = new Map<string, Buffer>([
      ["01-first.txt", Buffer.from("first")],
      ["02-broken.txt", Buffer.from("broken")],
      ["03-later.txt", Buffer.from("later")],
    ]);
    const writes: string[] = [];
    const deps: ModifiedOutputImportDeps = {
      readMaterialized: (_workspace, name) => reads.get(name) ?? null,
      writeOutput: async (_db, _roomPath, name) => {
        writes.push(name);
        if (name === "02-broken.txt") throw new Error("fabricated room write failure");
        return { meta: fakeMeta(name), replaced: true };
      },
    };
    const materialized: Materialized[] = [...reads.keys()].map((name) => ({
      name,
      sha: scriptFingerprint(before),
    }));

    await expect(
      importModifiedOutputsInRoomForTest(
        FAKE_DB, ROOM_PATH, WORKSPACE, materialized, [], CAUSE, deps,
      ),
    ).rejects.toThrow("fabricated room write failure");

    expect(writes).toEqual(["01-first.txt", "02-broken.txt"]);
  });
});

describe("complete workspace-room output import", () => {
  it("explains missing and unchanged declarations and versions an existing output", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "script-room-import-"));
    const roomPath = path.join(parent, "Workspace");
    const runWorkspace = path.join(parent, "run");
    fs.mkdirSync(runWorkspace);
    const { db } = createWorkspaceRoom(roomPath, "correct horse battery staple", "Test Room");
    try {
      const existing = await createRoomFile(
        { db, path: roomPath }, "existing.txt", "text/plain", Buffer.from("old"), "old", "upload",
      );
      const unchanged = await createRoomFile(
        { db, path: roomPath }, "unchanged.txt", "text/plain", Buffer.from("same"), "same", "upload",
      );
      fs.writeFileSync(path.join(runWorkspace, "existing.txt"), "new");
      fs.writeFileSync(path.join(runWorkspace, "unchanged.txt"), "same");

      const manifest = {
        ...parseScriptManifest("script.js", ""),
        outputs: ["missing.txt", "unchanged.txt", "existing.txt"],
      };
      const result = await importOutputsInRoomForTest(
        db,
        roomPath,
        runWorkspace,
        manifest,
        [{ name: "unchanged.txt", sha: scriptFingerprint(Buffer.from("same")) }],
        "script.js",
        CAUSE,
      );

      expect(result.imported.map((item) => item.id)).toEqual([existing.id]);
      expect(result.skipped).toEqual([
        "missing.txt: the script did not write this declared output",
        "unchanged.txt: unchanged from the room's copy — no new version was saved",
      ]);
      await expect(readRoomFile({ db, path: roomPath }, existing.id)).resolves.toMatchObject({ bytes: Buffer.from("new") });
      await expect(readRoomFile({ db, path: roomPath }, unchanged.id)).resolves.toMatchObject({ bytes: Buffer.from("same") });
    } finally {
      db.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
