import { chmod, cp, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { listFileVersions, setVersionPinned } from "../db-host/fileVersionsList.js";
import { scanWorkspaceManifest } from "./manifest.js";
import {
  acquireWorkspaceLease,
  createWorkspaceRoom,
  openWorkspaceRoom,
  readWorkspaceMarker,
  registerWorkspaceCopyIdentity,
  releaseWorkspaceLease,
  REMOTE_LEASE_STALE_MS,
} from "./roomLayout.js";
import { assertNoSymlinkSegments, normalizeRelativePath } from "./pathSafety.js";
import { ContentConflictError, WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-workspace-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace path safety", () => {
  it("rejects traversal, absolute paths and the private directory", () => {
    expect(() => normalizeRelativePath("../secret.txt")).toThrow(/leave the room/i);
    expect(() => normalizeRelativePath("/tmp/secret.txt")).toThrow(/relative/i);
    expect(() => normalizeRelativePath(".arcelle/room.db")).toThrow(/private/i);
  });

  it("rejects an existing symlink segment", async () => {
    const root = await temporaryRoot();
    await symlink(os.tmpdir(), path.join(root, "escape"));
    await expect(assertNoSymlinkSegments(root, "escape/file.txt", true)).rejects.toThrow(/symlink/i);
  });

  it("rejects a symlink used as the workspace root", async () => {
    const parent = await temporaryRoot();
    const realRoot = path.join(parent, "Real Room");
    const aliasRoot = path.join(parent, "Room Alias");
    const { db } = createWorkspaceRoom(realRoot, "correct horse battery staple", "Real Room");
    try {
      await symlink(realRoot, aliasRoot);
      expect(() => new WorkspaceService(db, aliasRoot)).toThrow(/symlink.*root/i);
    } finally {
      db.close();
    }
  });
});

describe("workspace room storage", () => {
  it("stores live bytes as normal files and private history as encrypted objects", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Customer Project");
    const source = path.join(parent, "source.txt");
    await writeFile(source, "first version", "utf8");

    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Customer Project");
    const lease = acquireWorkspaceLease(workspaceRoot);
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const imported = await workspace.importFile(source, "Research/notes.txt");
      expect(await readFile(path.join(workspaceRoot, "Research/notes.txt"), "utf8")).toBe("first version");
      const row = db.prepare(
        "SELECT storage_kind, relative_path, original_bytes FROM files WHERE id = ?",
      ).get(imported.fileId) as { storage_kind: string; relative_path: string; original_bytes: Buffer | null };
      expect(row).toEqual({
        storage_kind: "workspace",
        relative_path: "Research/notes.txt",
        original_bytes: null,
      });

      const snapshot = await workspace.snapshot(imported.fileId, "test", "snapshot", "baseline");
      const objectRow = db.prepare(
        "SELECT relative_object_path FROM content_objects WHERE id = ?",
      ).get(snapshot.id) as { relative_object_path: string };
      const encrypted = await readFile(path.join(workspaceRoot, ".arcelle", objectRow.relative_object_path));
      expect(encrypted.includes(Buffer.from("first version"))).toBe(false);

      await workspace.writeAtomic(
        imported.fileId,
        Readable.from([Buffer.from("second version")]),
        imported.sha256 ?? undefined,
      );
      await expect(
        workspace.writeAtomic(
          imported.fileId,
          Readable.from([Buffer.from("stale overwrite")]),
          imported.sha256 ?? undefined,
        ),
      ).rejects.toBeInstanceOf(ContentConflictError);

      await workspace.trash(imported.fileId);
      await expect(readFile(path.join(workspaceRoot, "Research/notes.txt"))).rejects.toThrow();
      await workspace.restore(imported.fileId);
      expect(await readFile(path.join(workspaceRoot, "Research/notes.txt"), "utf8")).toBe("second version");
    } finally {
      releaseWorkspaceLease(lease);
      db.close();
    }
  });

  it("preserves the stable file id after an external rename", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Rename Room");
    const source = path.join(parent, "source.md");
    await writeFile(source, "same bytes", "utf8");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Rename Room");
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const imported = await workspace.importFile(source, "before.md");
      await rename(path.join(workspaceRoot, "before.md"), path.join(workspaceRoot, "after.md"));
      const result = await workspace.reconcile();
      expect(result.renamed).toBe(1);
      const row = db.prepare("SELECT id, relative_path FROM files WHERE id = ?").get(imported.fileId) as {
        id: string;
        relative_path: string;
      };
      expect(row).toEqual({ id: imported.fileId, relative_path: "after.md" });
    } finally {
      db.close();
    }
  });

  it("creates and removes only safe empty normal directories with journal records", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Directory Room");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Directory Room");
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      expect(await workspace.createDirectory("Archive/Empty")).toBe(true);
      expect(await workspace.createDirectory("Archive/Empty")).toBe(false);
      expect(await workspace.directoryState("Archive/Empty")).toMatchObject({ exists: true, empty: true });

      const note = await workspace.createFile("Archive/Empty/note.md", Readable.from(["kept"]), "fixture");
      await expect(workspace.removeDirectory("Archive/Empty")).rejects.toThrow(/not empty/i);
      expect(await readFile(path.join(workspaceRoot, "Archive/Empty/note.md"), "utf8")).toBe("kept");
      await workspace.trash(note.fileId, note.sha256 ?? undefined);
      expect(await workspace.removeDirectory("Archive/Empty")).toBe(true);
      expect(await workspace.removeDirectory("Archive/Empty")).toBe(false);

      await expect(workspace.createDirectory("../escape")).rejects.toThrow(/leave the room/i);
      await expect(workspace.createDirectory(".arcelle/escape")).rejects.toThrow(/private/i);
      await symlink(os.tmpdir(), path.join(workspaceRoot, "linked"));
      await expect(workspace.createDirectory("linked/escape")).rejects.toThrow(/symlink/i);
      await expect(workspace.removeDirectory("linked")).rejects.toThrow(/symlink/i);

      expect(db.prepare(
        `SELECT operation_type, phase FROM fs_operations
         WHERE operation_type IN ('create_directory', 'remove_directory') ORDER BY created_at, rowid`,
      ).all()).toEqual([
        { operation_type: "create_directory", phase: "completed" },
        { operation_type: "remove_directory", phase: "completed" },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps ten unpinned encrypted versions, preserves pinned versions, and restores them", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "History Room");
    const source = path.join(parent, "history-source.txt");
    await writeFile(source, "version 0", "utf8");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "History Room");
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const imported = await workspace.importFile(source, "history.txt");
      const pinnedId = await workspace.snapshotVersion(imported.fileId, "pinned start");
      setVersionPinned(db, pinnedId, true);
      await workspace.writeAtomic(imported.fileId, Readable.from("version 1"));
      for (let version = 1; version <= 11; version += 1) {
        await workspace.snapshotVersion(imported.fileId, `save ${version}`);
        await workspace.writeAtomic(imported.fileId, Readable.from(`version ${version + 1}`));
      }

      const versions = listFileVersions(db, imported.fileId);
      expect(versions).toHaveLength(11);
      expect(versions.filter((version) => version.pinned)).toHaveLength(1);
      expect(versions.every((version) => version.bytes > 0)).toBe(true);
      expect(db.prepare(
        "SELECT count(*) AS n FROM file_versions WHERE length(bytes) = 0",
      ).get()).toEqual({ n: 11 });
      expect(db.prepare(
        "SELECT count(*) AS n FROM content_object_refs WHERE owner_type = 'file_version'",
      ).get()).toEqual({ n: 11 });

      await workspace.restoreVersion(pinnedId);
      expect(await readFile(path.join(workspaceRoot, "history.txt"), "utf8")).toBe("version 0");
      expect(listFileVersions(db, imported.fileId)).toHaveLength(11);

      await workspace.deleteVersion(pinnedId);
      expect(listFileVersions(db, imported.fileId).some((version) => version.id === pinnedId)).toBe(false);
      expect(db.prepare(
        "SELECT count(*) AS n FROM content_object_refs WHERE owner_type = 'file_version' AND owner_id = ?",
      ).get(pinnedId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("preserves POSIX permissions when atomically replacing a file", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Mode Room");
    const source = path.join(parent, "tool.sh");
    await writeFile(source, "#!/bin/sh\necho first\n", "utf8");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Mode Room");
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const imported = await workspace.importFile(source, "tool.sh");
      const destination = path.join(workspaceRoot, "tool.sh");
      await chmod(destination, 0o750);
      await workspace.writeAtomic(imported.fileId, Readable.from(["#!/bin/sh\necho second\n"]));
      expect((await lstat(destination)).mode & 0o7777).toBe(0o750);
    } finally {
      db.close();
    }
  });

  it("reuses a trusted hash only while stat identity is unchanged", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Scan Room");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Scan Room");
    try {
      await writeFile(path.join(workspaceRoot, "notes.txt"), "one", "utf8");
      const firstHashed: string[] = [];
      const first = await scanWorkspaceManifest(workspaceRoot, {
        onHash: (relativePath) => firstHashed.push(relativePath),
      });
      expect(firstHashed).toEqual(["notes.txt"]);
      const entry = first.get("notes.txt")!;
      const trusted = new Map([[entry.pathKey, {
        sizeBytes: entry.sizeBytes,
        mtimeNs: entry.mtimeNs,
        sha256: entry.sha256,
        fsIdentity: entry.fsIdentity,
      }]]);
      const unchangedHashed: string[] = [];
      await scanWorkspaceManifest(workspaceRoot, {
        trustedEntries: trusted,
        onHash: (relativePath) => unchangedHashed.push(relativePath),
      });
      expect(unchangedHashed).toEqual([]);

      await writeFile(path.join(workspaceRoot, "notes.txt"), "two-two", "utf8");
      const changedHashed: string[] = [];
      await scanWorkspaceManifest(workspaceRoot, {
        trustedEntries: trusted,
        onHash: (relativePath) => changedHashed.push(relativePath),
      });
      expect(changedHashed).toEqual(["notes.txt"]);
    } finally {
      db.close();
    }
  });

  it("allows only one writer lease", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Lease Room");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Lease Room");
    const lease = acquireWorkspaceLease(workspaceRoot);
    try {
      expect(() => acquireWorkspaceLease(workspaceRoot)).toThrow(/already open for writing/i);
    } finally {
      releaseWorkspaceLease(lease);
      db.close();
    }
  });

  it("ignores a copied lock root and registers a raw copy with a fresh room id", async () => {
    const parent = await temporaryRoot();
    const originalRoot = path.join(parent, "Original Room");
    const copyRoot = path.join(parent, "Finder Copy");
    const created = createWorkspaceRoom(originalRoot, "correct horse battery staple", "Original Room");
    const originalId = created.descriptor.roomId;
    const originalLease = acquireWorkspaceLease(originalRoot);
    created.db.close();
    await cp(originalRoot, copyRoot, { recursive: true });

    // The copied lock names Original Room and therefore cannot own Finder Copy.
    const copyLease = acquireWorkspaceLease(copyRoot);
    try {
      const registered = registerWorkspaceCopyIdentity(copyRoot, "correct horse battery staple");
      try {
        expect(registered.descriptor.roomId).not.toBe(originalId);
        expect(readWorkspaceMarker(copyRoot).roomId).toBe(registered.descriptor.roomId);
        expect(registered.db.prepare("SELECT value FROM meta WHERE key = 'workspace_room_id'").get())
          .toEqual({ value: registered.descriptor.roomId });
      } finally {
        registered.db.close();
      }
    } finally {
      releaseWorkspaceLease(copyLease);
      releaseWorkspaceLease(originalLease);
    }
  });

  it("supports a database-enforced read-only open while another writer owns the lease", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Read Only Room");
    const created = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Read Only Room");
    created.db.close();
    const lease = acquireWorkspaceLease(workspaceRoot);
    const readonly = openWorkspaceRoom(workspaceRoot, "correct horse battery staple", true).db;
    try {
      expect(readonly.prepare("SELECT value FROM meta WHERE key = 'name'").get()).toEqual({ value: "Read Only Room" });
      expect(() => readonly.prepare("UPDATE meta SET value = 'changed' WHERE key = 'name'").run()).toThrow();
    } finally {
      readonly.close();
      releaseWorkspaceLease(lease);
    }
  });

  it("recovers an expired remote-device lease but preserves a fresh one", async () => {
    const parent = await temporaryRoot();
    const workspaceRoot = path.join(parent, "Synced Room");
    const { db } = createWorkspaceRoom(workspaceRoot, "correct horse battery staple", "Synced Room");
    const lockPath = path.join(workspaceRoot, ".arcelle", "room.lock");
    try {
      await writeFile(lockPath, JSON.stringify({
        token: "remote",
        pid: 123,
        host: "another-device",
        renewedAt: new Date().toISOString(),
      }));
      expect(() => acquireWorkspaceLease(workspaceRoot)).toThrow(/another device/i);

      await writeFile(lockPath, JSON.stringify({
        token: "expired",
        pid: 123,
        host: "another-device",
        renewedAt: new Date(Date.now() - REMOTE_LEASE_STALE_MS - 1_000).toISOString(),
      }));
      const recovered = acquireWorkspaceLease(workspaceRoot);
      releaseWorkspaceLease(recovered);
    } finally {
      db.close();
    }
  });
});
