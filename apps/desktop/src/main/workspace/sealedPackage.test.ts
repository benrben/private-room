import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom, openWorkspaceRoom } from "./roomLayout.js";
import {
  createSealedPackage,
  extractSealedFiles,
  importSealedPackage,
  inspectSealedPackage,
} from "./sealedPackage.js";
import { WorkspaceService } from "./workspaceService.js";
import type { WorkspaceOperationProgressEvent } from "../../shared/workspaceProgress.js";
import { openRoom } from "../db-host/open.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed workspace packages", () => {
  it("refuses a weak explicit backup password before creating an output file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-password-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const roomPassword = "correct horse battery staple";
    const created = createWorkspaceRoom(sourceRoot, roomPassword, "Source Room");
    const sealedPath = path.join(root, "Weak Backup.arcelle");
    try {
      await expect(createSealedPackage(
        new WorkspaceService(created.db, sourceRoot),
        created.descriptor.roomId,
        roomPassword,
        sealedPath,
        "short",
      )).rejects.toThrow("Backup password must be at least 8 characters.");
      await expect(readFile(sealedPath)).rejects.toThrow();
    } finally {
      created.db.close();
    }
  });

  it("lists safe manifest paths and atomically extracts only selected files without overwriting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-extract-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const password = "correct horse battery staple";
    const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    const firstSource = path.join(root, "first.txt");
    const secondSource = path.join(root, "second.txt");
    const sealedPath = path.join(root, "Backup.arcelle");
    await writeFile(firstSource, "first normal file", "utf8");
    await writeFile(secondSource, "second normal file", "utf8");
    try {
      await workspace.importFile(firstSource, "first.txt");
      await workspace.importFile(secondSource, "Nested/second.txt");
      await createSealedPackage(
        workspace,
        created.descriptor.roomId,
        password,
        sealedPath,
        password,
      );
    } finally {
      created.db.close();
    }

    const inspected = inspectSealedPackage(sealedPath, password);
    expect(inspected.files.map((file) => file.relativePath)).toEqual([
      "first.txt",
      "Nested/second.txt",
    ]);
    expect(inspected.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);

    const second = inspected.files.find((file) => file.relativePath === "Nested/second.txt")!;
    const extractedRoot = path.join(root, "Selected files");
    await expect(extractSealedFiles(
      sealedPath,
      password,
      [second.fileId],
      extractedRoot,
    )).resolves.toEqual({ destinationPath: extractedRoot, fileCount: 1 });
    expect(await readFile(path.join(extractedRoot, "Nested/second.txt"), "utf8"))
      .toBe("second normal file");
    await expect(readFile(path.join(extractedRoot, "first.txt"))).rejects.toThrow();

    const occupied = path.join(root, "Occupied");
    await mkdir(occupied);
    await writeFile(path.join(occupied, "keep.txt"), "do not replace", "utf8");
    await expect(extractSealedFiles(
      sealedPath,
      password,
      [second.fileId],
      occupied,
    )).rejects.toThrow("already exists");
    expect(await readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("do not replace");

    const tampered = openRoom(sealedPath, password);
    tampered.prepare(
      "UPDATE sealed_file_chunks SET bytes = ? WHERE file_id = ? AND seq = 0",
    ).run(Buffer.from("tampered bytes"), second.fileId);
    tampered.close();
    const corruptDestination = path.join(root, "Corrupt extraction");
    await expect(extractSealedFiles(
      sealedPath,
      password,
      [second.fileId],
      corruptDestination,
    )).rejects.toThrow("failed while restoring");
    await expect(readdir(corruptDestination)).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.includes(".extract.tmp"))).toBe(false);

    const unsafe = openRoom(sealedPath, password);
    unsafe.prepare("UPDATE sealed_files SET relative_path = '../escape.txt' WHERE file_id = ?")
      .run(second.fileId);
    unsafe.close();
    expect(() => inspectSealedPackage(sealedPath, password)).toThrow("cannot leave the room");
  });

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
    const createProgress: WorkspaceOperationProgressEvent[] = [];
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
        "backup",
        { operationId: "seal-1", progress: (event) => createProgress.push(event) },
      );
      expect(info).toMatchObject({ version: 2, purpose: "backup", fileCount: 1, objectCount: 1 });
    } finally {
      created.db.close();
    }
    expect(createProgress.filter((event) => event.phase === "copying-files").map((event) => event.completed))
      .toEqual([0, 1]);
    expect(createProgress.filter((event) => event.phase === "copying-history").map((event) => event.completed))
      .toEqual([0, 1]);
    expect(createProgress.at(-1)).toMatchObject({
      operationId: "seal-1", operation: "sealed-package-create", phase: "completed",
    });

    expect(inspectSealedPackage(sealedPath, packagePassword)).toMatchObject({
      version: 2,
      fileCount: 1,
      objectCount: 1,
    });
    await expect(async () => inspectSealedPackage(sealedPath, roomPassword)).rejects.toThrow();
    expect((await readFile(sealedPath)).includes(Buffer.from("current normal bytes"))).toBe(false);
    // Imported workspace permissions must not depend on the package's mode.
    await chmod(sealedPath, 0o644);

    const importedRoot = path.join(root, "Imported Room");
    const importProgress: WorkspaceOperationProgressEvent[] = [];
    const imported = await importSealedPackage(
      sealedPath,
      packagePassword,
      importedRoot,
      importedPassword,
      { operationId: "import-1", progress: (event) => importProgress.push(event) },
    );
    expect(imported).toMatchObject({ fileCount: 1, objectCount: 1 });
    expect(importProgress.filter((event) => event.phase === "copying-files").map((event) => event.completed))
      .toEqual([0, 1]);
    expect(importProgress.filter((event) => event.phase === "copying-history").map((event) => event.completed))
      .toEqual([0, 1]);
    expect(importProgress.at(-1)).toMatchObject({
      operationId: "import-1", operation: "sealed-package-import", phase: "completed",
    });
    expect(await readFile(path.join(importedRoot, "Research/notes.txt"), "utf8"))
      .toBe("current normal bytes");
    expect((await stat(path.join(importedRoot, ".arcelle", "room.db"))).mode & 0o777)
      .toBe(0o600);

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
