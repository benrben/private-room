import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./db-host/open.js";
import {
  deleteFile,
  derivedPreviews,
  getDerivedPreview,
  insertFile,
  libraryFileCount,
  listFiles,
  listLibraryFiles,
  listPublicFiles,
  listTrashedFiles,
  markDerivedPreview,
  restoreFile,
  setDerivedFrom,
  trashFile,
  trashedFileCount,
} from "./db-host/files.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { createRoomFile } from "./workspace/roomContent.js";
import {
  MAX_DERIVED_PREVIEW_BYTES,
  regenerateDerivedPreview,
  resolveDerivedPreview,
  restoreFileWithDerivedPreviews,
  snapshotUnknownFormat,
  storeDerivedPreview,
  trashFileWithDerivedPreviews,
} from "./derivedPreview.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function blobRoom() {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcelle-derived-blob-"));
  roots.push(root);
  return {
    db: createRoom(path.join(root, "Room.roomai"), "correct horse battery staple", "Room"),
    path: path.join(root, "Room.roomai"),
  };
}

describe("derived preview database lifecycle", () => {
  it("hides only renderer previews and cascades them without touching normal derived artifacts", () => {
    const room = blobRoom();
    try {
      const original = insertFile(room.db, "camera.raw", "image/x-raw", Buffer.from("raw"), null, "upload");
      const preview = insertFile(room.db, "camera-preview.jpg", "image/jpeg", Buffer.from("jpg"), "pixels", "derived-preview");
      const report = insertFile(room.db, "camera-report.md", "text/markdown", Buffer.from("report"), "report", "generated");
      const sketch = insertFile(room.db, "flow.sketch", "application/x-arcelle-sketch", Buffer.from("{}"), "{}", "sketch");
      markDerivedPreview(room.db, preview.id, original.id);
      setDerivedFrom(room.db, report.id, original.id);
      room.db.prepare("UPDATE files SET library_visibility = 'sectionOnly' WHERE id = ?").run(sketch.id);

      expect(listFiles(room.db).map((file) => file.id)).toContain(preview.id);
      expect(listPublicFiles(room.db).map((file) => file.id)).toEqual(
        expect.arrayContaining([original.id, report.id, sketch.id]),
      );
      expect(listPublicFiles(room.db).map((file) => file.id)).not.toContain(preview.id);
      expect(listLibraryFiles(room.db).map((file) => file.id)).toEqual(expect.arrayContaining([original.id, report.id]));
      expect(listLibraryFiles(room.db).map((file) => file.id)).not.toContain(sketch.id);
      expect(listLibraryFiles(room.db).map((file) => file.id)).not.toContain(preview.id);
      expect(libraryFileCount(room.db)).toBe(2);
      expect(getDerivedPreview(room.db, original.id)?.id).toBe(preview.id);
      expect(room.db.prepare("SELECT index_state, extracted_text FROM files WHERE id = ?").get(preview.id))
        .toEqual({ index_state: "unsupported", extracted_text: null });

      trashFile(room.db, original.id, { kind: "user" });
      expect(derivedPreviews(room.db, original.id)).toEqual([]);
      expect(derivedPreviews(room.db, original.id, true).map((file) => file.id)).toEqual([preview.id]);
      expect(listTrashedFiles(room.db).map((file) => file.id)).toEqual([original.id]);
      expect(trashedFileCount(room.db)).toBe(1);
      expect(listFiles(room.db).map((file) => file.id)).toContain(report.id);

      restoreFile(room.db, original.id);
      expect(getDerivedPreview(room.db, original.id)?.id).toBe(preview.id);
      deleteFile(room.db, original.id);
      expect(room.db.prepare("SELECT id FROM files WHERE id IN (?, ?)").all(original.id, preview.id)).toEqual([]);
      expect(room.db.prepare("SELECT id FROM files WHERE id = ?").get(report.id)).toBeDefined();
    } finally {
      room.db.close();
    }
  });
});

describe("stored unknown-format snapshots", () => {
  it("renders once, stores real blob bytes, resolves through the original, and enforces the cap", async () => {
    const room = blobRoom();
    try {
      const original = insertFile(room.db, "diagram.graffle", "application/octet-stream", Buffer.from("document"), null, "upload");
      let renders = 0;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const render = async () => { renders += 1; return png; };
      const [first, concurrent] = await Promise.all([
        snapshotUnknownFormat(room, original.id, render),
        snapshotUnknownFormat(room, original.id, render),
      ]);
      expect(first.kind).toBe("stored");
      expect(concurrent.kind).toBe("stored");
      expect(renders).toBe(1);
      expect((await snapshotUnknownFormat(room, original.id, render)).kind).toBe("reused");
      expect(renders).toBe(1);
      expect((await resolveDerivedPreview(room, original.id))?.bytes).toEqual(png);
      expect(getDerivedPreview(room.db, original.id)?.provenance).toBe("snapshot");

      const another = insertFile(room.db, "huge.unknown", "application/octet-stream", Buffer.from("x"), null, "upload");
      const oversized = { byteLength: MAX_DERIVED_PREVIEW_BYTES + 1 } as Uint8Array;
      expect(await storeDerivedPreview(room, another.id, oversized, "image/png", "png"))
        .toEqual({ kind: "too_large", sizeBytes: MAX_DERIVED_PREVIEW_BYTES + 1 });
      expect(getDerivedPreview(room.db, another.id)).toBeNull();
    } finally {
      room.db.close();
    }
  });

  it("treats Quick Look failure as unavailable instead of failing the import", async () => {
    const room = blobRoom();
    try {
      const original = insertFile(room.db, "broken.unknown", "application/octet-stream", Buffer.from("x"), null, "upload");
      await expect(snapshotUnknownFormat(room, original.id, async () => {
        throw new Error("renderer timed out");
      })).resolves.toEqual({ kind: "unavailable" });
      expect(getDerivedPreview(room.db, original.id)).toBeNull();
    } finally {
      room.db.close();
    }
  });

  it("invalidates a stale preview before publishing regenerated bytes", async () => {
    const room = blobRoom();
    try {
      const original = insertFile(room.db, "changing.raw", "image/x-raw", Buffer.from("v1"), null, "upload");
      const first = await storeDerivedPreview(room, original.id, Buffer.from("old"), "image/jpeg", "jpg");
      expect(first.kind).toBe("stored");
      expect(getDerivedPreview(room.db, original.id)?.provenance).toBe("generated");
      const oldId = first.kind === "stored" ? first.preview.id : "";
      const result = await regenerateDerivedPreview(room, original.id, async () => ({
        bytes: Buffer.from("new"),
        mimeType: "image/jpeg",
        extension: "jpg",
      }));
      expect(result.kind).toBe("stored");
      expect(getDerivedPreview(room.db, original.id)?.id).not.toBe(oldId);
      expect(room.db.prepare("SELECT 1 FROM files WHERE id = ?").get(oldId)).toBeUndefined();
      expect((await resolveDerivedPreview(room, original.id))?.bytes.toString()).toBe("new");
    } finally {
      room.db.close();
    }
  });

  it("stores a normal workspace PNG and trashes/restores both physical files as one document", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-derived-workspace-"));
    roots.push(parent);
    const root = path.join(parent, "Room");
    const created = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const room = { db: created.db, path: root };
    try {
      const original = await createRoomFile(
        room,
        "Designs/diagram.graffle",
        "application/octet-stream",
        Buffer.from("document"),
        null,
        "import",
      );
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
      expect((await snapshotUnknownFormat(room, original.id, async () => png)).kind).toBe("stored");
      const preview = getDerivedPreview(room.db, original.id)!;
      expect(preview.storageKind).toBe("workspace");
      expect(preview.provenance).toBe("snapshot");
      expect(preview.relativePath).toBe("Designs/diagram-preview.png");
      expect(await readFile(path.join(root, preview.relativePath!))).toEqual(png);
      expect(room.db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(preview.id))
        .toEqual({ original_bytes: null });
      expect(room.db.prepare("SELECT index_state FROM files WHERE id = ?").get(preview.id))
        .toEqual({ index_state: "unsupported" });

      await trashFileWithDerivedPreviews(room, original.id);
      expect(existsSync(path.join(root, "Designs/diagram.graffle"))).toBe(false);
      expect(existsSync(path.join(root, preview.relativePath!))).toBe(false);
      await restoreFileWithDerivedPreviews(room, original.id);
      expect(existsSync(path.join(root, "Designs/diagram.graffle"))).toBe(true);
      expect(existsSync(path.join(root, preview.relativePath!))).toBe(true);
      expect((await resolveDerivedPreview(room, original.id))?.bytes).toEqual(png);
    } finally {
      created.db.close();
    }
  });
});
