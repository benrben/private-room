import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertFile } from "../db-host/files.js";
import { createRoom as createLegacyRoom } from "../db-host/open.js";
import { snapshotFileVersion } from "../db-host/versions.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { roomStorageUsage } from "./storageUsage.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("room storage usage", () => {
  it("separates normal workspace files, encrypted database state, and private objects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-usage-"));
    roots.push(root);
    const roomPath = path.join(root, "Workspace");
    const source = path.join(root, "source.txt");
    await writeFile(source, "five!", "utf8");
    const created = createWorkspaceRoom(roomPath, "correct horse battery staple", "Workspace");
    try {
      const workspace = new WorkspaceService(created.db, roomPath);
      const file = await workspace.importFile(source, "notes.txt");
      await workspace.snapshotVersion(file.fileId, "history");
      const usage = await roomStorageUsage({
        conn: created.db,
        path: roomPath,
        descriptor: created.descriptor,
      });
      expect(usage.kind).toBe("workspace");
      expect(usage.liveFileBytes).toBe(5);
      expect(usage.databaseBytes).toBeGreaterThan(0);
      expect(usage.privateHistoryBytes).toBeGreaterThan(5);
      expect(usage.totalOnDiskBytes)
        .toBe(usage.liveFileBytes + usage.databaseBytes + usage.privateHistoryBytes);
    } finally {
      created.db.close();
    }
  });

  it("reports a legacy encrypted database without double-counting its BLOBs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-legacy-usage-"));
    roots.push(root);
    const roomPath = path.join(root, "Legacy.roomai");
    const db = createLegacyRoom(roomPath, "correct horse battery staple", "Legacy");
    try {
      const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("current"), "current", "upload");
      snapshotFileVersion(db, file.id, "history");
      const usage = await roomStorageUsage({ conn: db, path: roomPath });
      expect(usage).toMatchObject({ kind: "legacy", liveFileBytes: 7, privateHistoryBytes: 7 });
      expect(usage.databaseBytes).toBeGreaterThan(0);
      expect(usage.totalOnDiskBytes).toBe(usage.databaseBytes);
    } finally {
      db.close();
    }
  });
});
