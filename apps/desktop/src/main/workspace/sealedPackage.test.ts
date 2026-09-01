import { readdirSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function sealedFixture(root: string, password = "correct horse battery staple") {
  const sourceRoot = path.join(root, "Source Room");
  const sourceFile = path.join(root, "source.txt");
  const sealedPath = path.join(root, "fixture.arcelle");
  const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
  const workspace = new WorkspaceService(created.db, sourceRoot);
  await writeFile(sourceFile, "fixture bytes", "utf8");
  try {
    const file = await workspace.importFile(sourceFile, "notes.txt");
    await workspace.snapshot(file.fileId, "test", "history", "version");
    await createSealedPackage(workspace, created.descriptor.roomId, password, sealedPath, password);
  } finally {
    created.db.close();
  }
  return { password, sealedPath };
}

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

  it("keeps export preflight and cleanup transactional when workspace bytes change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-create-guards-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const sourceFile = path.join(root, "source.txt");
    const password = "correct horse battery staple";
    const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    const insideDestination = path.join(sourceRoot, "inside.arcelle");
    const existingDestination = path.join(root, "existing.arcelle");
    const changedDestination = path.join(root, "changed.arcelle");
    await writeFile(sourceFile, "original bytes", "utf8");
    await writeFile(existingDestination, "keep me", "utf8");
    try {
      await workspace.importFile(sourceFile, "notes.txt");
      await expect(createSealedPackage(
        workspace, created.descriptor.roomId, password, insideDestination,
      )).rejects.toThrow("Save the sealed package outside the workspace folder.");
      await expect(createSealedPackage(
        workspace, created.descriptor.roomId, password, existingDestination,
      )).rejects.toThrow("A file already exists at the sealed package destination.");

      let changedDuringCopy = false;
      await expect(createSealedPackage(
        workspace,
        created.descriptor.roomId,
        password,
        changedDestination,
        password,
        "backup",
        { progress: (event) => {
          if (event.phase === "copying-files" && event.completed === 0 && !changedDuringCopy) {
            changedDuringCopy = true;
            writeFileSync(path.join(sourceRoot, "notes.txt"), "changed outside the database", "utf8");
          }
        } },
      )).rejects.toThrow("The workspace changed while sealing notes.txt.");
      await expect(readFile(changedDestination)).rejects.toThrow();
      expect((await readdir(root)).some((name) => name.includes("changed.arcelle") && name.endsWith(".tmp"))).toBe(false);
    } finally {
      created.db.close();
    }
  });

  it("rejects unknown extraction selections and corrupted package metadata before publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-integrity-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const sourceFile = path.join(root, "source.txt");
    const password = "correct horse battery staple";
    const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    const sealedPath = path.join(root, "good.arcelle");
    await writeFile(sourceFile, "sealed bytes", "utf8");
    try {
      await workspace.importFile(sourceFile, "notes.txt");
      await createSealedPackage(workspace, created.descriptor.roomId, password, sealedPath, password);
    } finally {
      created.db.close();
    }

    await expect(extractSealedFiles(sealedPath, password, ["missing-file"], path.join(root, "unknown")))
      .rejects.toThrow("One or more selected files are not in this sealed package.");
    await expect(readdir(path.join(root, "unknown"))).rejects.toThrow();

    const missingMetadata = path.join(root, "missing-metadata.arcelle");
    await copyFile(sealedPath, missingMetadata);
    const metadataDb = openRoom(missingMetadata, password);
    metadataDb.prepare("DELETE FROM sealed_package_meta WHERE key = 'purpose'").run();
    metadataDb.close();
    expect(() => inspectSealedPackage(missingMetadata, password)).toThrow("The sealed package metadata is incomplete.");

    const corruptBytes = path.join(root, "corrupt-bytes.arcelle");
    await copyFile(sealedPath, corruptBytes);
    const bytesDb = openRoom(corruptBytes, password);
    bytesDb.prepare("UPDATE sealed_file_chunks SET bytes = x'00' WHERE seq = 0").run();
    bytesDb.close();
    await expect(importSealedPackage(corruptBytes, password, path.join(root, "Corrupt import")))
      .rejects.toThrow("The sealed package failed its content integrity check.");
    await expect(readdir(path.join(root, "Corrupt import"))).rejects.toThrow();
  });

  it("rejects malformed sealed rows and cleans an import that fails after restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-malformed-"));
    roots.push(root);
    const { password, sealedPath } = await sealedFixture(root);

    const invalidId = path.join(root, "invalid-id.arcelle");
    await copyFile(sealedPath, invalidId);
    const invalidIdDb = openRoom(invalidId, password);
    invalidIdDb.prepare("UPDATE sealed_files SET file_id = 'not an id!'").run();
    invalidIdDb.close();
    expect(() => inspectSealedPackage(invalidId, password)).toThrow("The sealed package contains an invalid file identifier.");

    const invalidFile = path.join(root, "invalid-file.arcelle");
    await copyFile(sealedPath, invalidFile);
    const invalidFileDb = openRoom(invalidFile, password);
    invalidFileDb.prepare("UPDATE sealed_files SET size_bytes = -1").run();
    invalidFileDb.close();
    expect(() => inspectSealedPackage(invalidFile, password)).toThrow("The sealed package file manifest is damaged.");

    const invalidCount = path.join(root, "invalid-count.arcelle");
    await copyFile(sealedPath, invalidCount);
    const invalidCountDb = openRoom(invalidCount, password);
    invalidCountDb.prepare("UPDATE sealed_package_meta SET value = '2' WHERE key = 'file_count'").run();
    invalidCountDb.close();
    await expect(importSealedPackage(invalidCount, password, path.join(root, "bad count")))
      .rejects.toThrow("The sealed package item count is incorrect.");

    const unsafeObject = path.join(root, "unsafe-object.arcelle");
    await copyFile(sealedPath, unsafeObject);
    const unsafeObjectDb = openRoom(unsafeObject, password);
    unsafeObjectDb.prepare("UPDATE sealed_objects SET relative_object_path = 'outside.aobj'").run();
    unsafeObjectDb.close();
    await expect(importSealedPackage(unsafeObject, password, path.join(root, "unsafe object")))
      .rejects.toThrow("The sealed package contains an unsafe object path.");

    const mismatchedWorkspace = path.join(root, "mismatched-workspace.arcelle");
    await copyFile(sealedPath, mismatchedWorkspace);
    const mismatchDestination = path.join(root, "mismatched import");
    let changedBeforeValidation = false;
    await expect(importSealedPackage(mismatchedWorkspace, password, mismatchDestination, password, {
      progress: (event) => {
        if (event.phase === "copying-history" && event.completed === 0 && !changedBeforeValidation) {
          changedBeforeValidation = true;
          const temp = readdirSync(root).find((name) => name.includes("mismatched import") && name.endsWith(".import.tmp"));
          if (!temp) throw new Error("import temporary workspace was not created");
          writeFileSync(path.join(root, temp, "notes.txt"), "changed before validation", "utf8");
        }
      },
    }))
      .rejects.toThrow("The imported workspace failed validation for notes.txt.");
    await expect(readdir(mismatchDestination)).rejects.toThrow();

    const occupied = path.join(root, "occupied import");
    await mkdir(occupied);
    await expect(importSealedPackage(sealedPath, password, occupied))
      .rejects.toThrow("A file or folder already exists at the workspace destination.");
  }, 15_000);

  it("rejects an unsafe live workspace object before publishing a package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-unsafe-live-"));
    roots.push(root);
    const sourceRoot = path.join(root, "Source Room");
    const sourceFile = path.join(root, "source.txt");
    const password = "correct horse battery staple";
    const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    const sealedPath = path.join(root, "unsafe-live.arcelle");
    await writeFile(sourceFile, "source bytes", "utf8");
    try {
      const file = await workspace.importFile(sourceFile, "notes.txt");
      const snapshot = await workspace.snapshot(file.fileId, "test", "history", "version");
      created.db.prepare("UPDATE content_objects SET relative_object_path = 'unsafe.aobj' WHERE id = ?")
        .run(snapshot.id);
      await expect(createSealedPackage(workspace, created.descriptor.roomId, password, sealedPath, password))
        .rejects.toThrow("The workspace object store contains an unsafe path.");
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
  }, 15_000);

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
  }, 15_000);

  it("still publishes when directory fsync is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-sealed-no-dir-fsync-"));
    roots.push(root);
    const password = "correct horse battery staple";
    const sourceRoot = path.join(root, "Source Room");
    const sourceFile = path.join(root, "source.txt");
    const sealedPath = path.join(root, "without-fsync.arcelle");
    const fsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...fsPromises,
      open: (target: Parameters<typeof fsPromises.open>[0], flags: Parameters<typeof fsPromises.open>[1]) => {
        if (target === root && flags === "r") throw new Error("directory fsync unavailable");
        return fsPromises.open(target, flags);
      },
    }));
    const { createSealedPackage: createWithoutDirectoryFsync } = await import("./sealedPackage.js");
    const created = createWorkspaceRoom(sourceRoot, password, "Source Room");
    const workspace = new WorkspaceService(created.db, sourceRoot);
    await writeFile(sourceFile, "still sealed", "utf8");
    try {
      await workspace.importFile(sourceFile, "notes.txt");
      await expect(createWithoutDirectoryFsync(
        workspace, created.descriptor.roomId, password, sealedPath, password,
      )).resolves.toMatchObject({ fileCount: 1 });
    } finally {
      created.db.close();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
