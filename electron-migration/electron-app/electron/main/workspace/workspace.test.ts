import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkspaceLease, createWorkspaceRoom, releaseWorkspaceLease } from "./roomLayout.js";
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
});
