import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom, openWorkspaceRoom } from "./roomLayout.js";
import {
  createSealedPackage,
  importSealedPackage,
  inspectSealedPackage,
} from "./sealedPackage.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed workspace packages", () => {
  it("exports, verifies and imports current files plus encrypted history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const sourceFile = path.join(root, "source.txt");
    const roomPassword = "correct horse battery staple";
    const packagePassword = "different sealed package password";
    const importedPassword = "different imported workspace password";
    await writeFile(sourceFile, "current normal bytes", "utf8");
    const created = createWorkspaceRoom(sourceRoot, roomPassword, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    const sealedPath = path.join(root, "Backup.arcelle");
    let snapshotId: string;
    try {
      const file = await workspace.importFile(sourceFile, "Research/notes.txt");
      const snapshot = await workspace.snapshot(file.fileId, "test", "history", "version");
      snapshotId = snapshot.id;
      const info = await createSealedPackage(
        workspace,
        created.descriptor.roomId,
        roomPassword,
        sealedPath,
        packagePassword,
      );
      expect(info).toMatchObject({ version: 2, purpose: "backup", fileCount: 1, objectCount: 1 });
    } finally {
      created.db.close();
    }

    expect(inspectSealedPackage(sealedPath, packagePassword)).toMatchObject({
      version: 2,
      fileCount: 1,
      objectCount: 1,
    });
    await expect(async () => inspectSealedPackage(sealedPath, roomPassword)).rejects.toThrow();
    expect((await readFile(sealedPath)).includes(Buffer.from("current normal bytes"))).toBe(false);

    const importedRoot = path.join(root, "Imported Room");
    const imported = await importSealedPackage(
      sealedPath,
      packagePassword,
      importedRoot,
      importedPassword,
    );
    expect(imported).toMatchObject({ fileCount: 1, objectCount: 1 });
    expect(await readFile(path.join(importedRoot, "Research/notes.txt"), "utf8"))
      .toBe("current normal bytes");

    const reopened = openWorkspaceRoom(importedRoot, importedPassword);
    try {
      const service = new WorkspaceService(reopened.db, importedRoot);
      const restoredPath = path.join(root, "restored-history.txt");
      await service.objects.restoreTo(snapshotId!, restoredPath);
      expect(await readFile(restoredPath, "utf8")).toBe("current normal bytes");
      const row = reopened.db.prepare(
        "SELECT original_bytes, storage_kind, relative_path FROM files WHERE relative_path = ?",
      ).get("Research/notes.txt") as {
        original_bytes: Buffer | null;
        storage_kind: string;
        relative_path: string;
      };
      expect(row).toEqual({
        original_bytes: null,
        storage_kind: "workspace",
        relative_path: "Research/notes.txt",
      });
    } finally {
      reopened.db.close();
    }
  });
});
