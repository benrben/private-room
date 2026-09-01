import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomContentHandle } from "./workspace/roomContent.js";

const mocks = vi.hoisted(() => ({
  availableName: vi.fn(),
  createRoomFile: vi.fn(),
  deleteFile: vi.fn(),
  derivedPreviews: vi.fn(),
  getDerivedPreview: vi.fn(),
  markDerivedPreview: vi.fn(),
  pathKey: vi.fn((value: string) => `key:${value}`),
  restoreFile: vi.fn(),
  trashFile: vi.fn(),
  workspaceRestore: vi.fn(),
  workspaceTrash: vi.fn(),
}));

vi.mock("./previewTools.js", () => ({ renderQuickLook: vi.fn() }));
vi.mock("./db-host/files.js", () => ({
  availableName: mocks.availableName,
  deleteFile: mocks.deleteFile,
  derivedPreviews: mocks.derivedPreviews,
  getDerivedPreview: mocks.getDerivedPreview,
  markDerivedPreview: mocks.markDerivedPreview,
  restoreFile: mocks.restoreFile,
  trashFile: mocks.trashFile,
}));
vi.mock("./workspace/roomContent.js", () => ({
  createRoomFile: mocks.createRoomFile,
  readRoomFile: vi.fn(),
}));
vi.mock("./workspace/pathSafety.js", () => ({ pathKey: mocks.pathKey }));
vi.mock("./workspace/workspaceService.js", () => ({
  WorkspaceService: class WorkspaceService {
    restore = mocks.workspaceRestore;
    trash = mocks.workspaceTrash;
  },
}));

import {
  invalidateDerivedPreviews,
  MAX_DERIVED_PREVIEW_BYTES,
  restoreFileWithDerivedPreviews,
  storeDerivedPreview,
  trashFileWithDerivedPreviews,
} from "./derivedPreview.js";

function fakeRoom({
  source,
  missing = false,
  workspace = false,
  takenPaths = 0,
}: {
  source?: { name: string; relative_path: string | null };
  missing?: boolean;
  workspace?: boolean;
  takenPaths?: number;
} = {}): RoomContentHandle {
  let remainingTakenPaths = takenPaths;
  const sourceRow = missing ? undefined : source ?? { name: "photo.raw", relative_path: "Images/photo.raw" };
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes("FROM meta")) return workspace ? { found: 1 } : undefined;
        if (sql.includes("SELECT name, relative_path")) return sourceRow;
        if (sql.includes("WHERE path_key")) {
          if (remainingTakenPaths > 0) {
            remainingTakenPaths -= 1;
            return { found: 1 };
          }
          return undefined;
        }
        return undefined;
      }),
    })),
  };
  return { db: db as unknown as RoomContentHandle["db"], path: "/fake/room" };
}

describe("storeDerivedPreview with fabricated storage dependencies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.availableName.mockImplementation((_db: unknown, name: string) => `available-${name}`);
    mocks.createRoomFile.mockResolvedValue({ id: "preview-file" });
    mocks.getDerivedPreview.mockReturnValue(null);
  });

  it("creates and links a generated preview using the available fake destination", async () => {
    const room = fakeRoom();
    const bytes = new Uint8Array([1, 2, 3]);
    const preview = { id: "preview-file", name: "photo-preview.webp" };
    mocks.getDerivedPreview.mockReturnValueOnce(null).mockReturnValueOnce(preview);

    await expect(storeDerivedPreview(room, "original-file", bytes, "image/webp", ".webp"))
      .resolves.toEqual({ kind: "stored", preview });

    expect(mocks.availableName).toHaveBeenCalledWith(room.db, "photo-preview.webp");
    expect(mocks.createRoomFile).toHaveBeenCalledWith(
      room,
      "available-photo-preview.webp",
      "image/webp",
      bytes,
      null,
      "derived-preview",
    );
    expect(mocks.markDerivedPreview).toHaveBeenCalledWith(room.db, "preview-file", "original-file");
  });

  it("labels an explicitly requested snapshot with its distinct durable source", async () => {
    const room = fakeRoom();
    const preview = { id: "snapshot-file", name: "photo-preview.png" };
    mocks.createRoomFile.mockResolvedValue({ id: "snapshot-file" });
    mocks.getDerivedPreview.mockReturnValueOnce(null).mockReturnValueOnce(preview);

    await expect(storeDerivedPreview(
      room,
      "original-file",
      new Uint8Array([1]),
      "image/png",
      "png",
      "snapshot",
    )).resolves.toEqual({ kind: "stored", preview });

    expect(mocks.createRoomFile).toHaveBeenCalledWith(
      room,
      "available-photo-preview.png",
      "image/png",
      expect.any(Uint8Array),
      null,
      "derived-preview-snapshot",
    );
  });

  it("reuses an existing preview and rejects an oversized byte-like value before storage", async () => {
    const room = fakeRoom();
    const existing = { id: "already-linked" };
    mocks.getDerivedPreview.mockReturnValue(existing);

    await expect(storeDerivedPreview(room, "original-file", new Uint8Array([1]), "image/png", "png"))
      .resolves.toEqual({ kind: "reused", preview: existing });
    expect(mocks.createRoomFile).not.toHaveBeenCalled();

    mocks.getDerivedPreview.mockReturnValue(null);
    const oversized = { byteLength: MAX_DERIVED_PREVIEW_BYTES + 1 } as Uint8Array;
    await expect(storeDerivedPreview(room, "original-file", oversized, "image/png", "png"))
      .resolves.toEqual({ kind: "too_large", sizeBytes: MAX_DERIVED_PREVIEW_BYTES + 1 });
    expect(mocks.createRoomFile).not.toHaveBeenCalled();
  });

  it("fails before creating a preview when the fabricated original is missing", async () => {
    const room = fakeRoom({ missing: true });

    await expect(storeDerivedPreview(room, "missing-file", new Uint8Array([1]), "image/png", "png"))
      .rejects.toThrow("The original file is not in this room.");

    expect(mocks.createRoomFile).not.toHaveBeenCalled();
    expect(mocks.markDerivedPreview).not.toHaveBeenCalled();
  });

  it("deletes a blob preview and preserves the marking error when fake linking fails", async () => {
    const room = fakeRoom();
    mocks.markDerivedPreview.mockImplementation(() => { throw new Error("fabricated link failure"); });

    await expect(storeDerivedPreview(room, "original-file", new Uint8Array([1]), "image/png", "png"))
      .rejects.toThrow("fabricated link failure");

    expect(mocks.deleteFile).toHaveBeenCalledWith(room.db, "preview-file");
  });

  it("retains workspace metadata when fake filesystem cleanup fails", async () => {
    const room = fakeRoom({ workspace: true });
    mocks.markDerivedPreview.mockImplementation(() => { throw new Error("fabricated link failure"); });
    mocks.workspaceTrash.mockRejectedValue(new Error("fabricated cleanup failure"));

    await expect(storeDerivedPreview(room, "original-file", new Uint8Array([1]), "image/png", "png"))
      .rejects.toThrow("fabricated link failure");

    expect(mocks.workspaceTrash).toHaveBeenCalledWith("preview-file");
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("removes the fabricated workspace row after successful workspace cleanup", async () => {
    const room = fakeRoom({ workspace: true });
    mocks.markDerivedPreview.mockImplementation(() => { throw new Error("fabricated link failure"); });
    mocks.workspaceTrash.mockResolvedValue(undefined);

    await expect(storeDerivedPreview(room, "original-file", new Uint8Array([1]), "image/png", "png"))
      .rejects.toThrow("fabricated link failure");

    expect(mocks.workspaceTrash).toHaveBeenCalledWith("preview-file");
    expect(mocks.deleteFile).toHaveBeenCalledWith(room.db, "preview-file");
  });

  it("numbers a colliding workspace preview in the source directory", async () => {
    const room = fakeRoom({ workspace: true, takenPaths: 1 });
    const preview = { id: "preview-file", name: "photo-preview (2).webp" };
    mocks.getDerivedPreview.mockReturnValueOnce(null).mockReturnValueOnce(preview);

    await expect(storeDerivedPreview(
      room,
      "original-file",
      new Uint8Array([1]),
      "image/webp",
      "webp",
    )).resolves.toEqual({ kind: "stored", preview });

    expect(mocks.createRoomFile).toHaveBeenCalledWith(
      room,
      "Images/photo-preview (2).webp",
      "image/webp",
      expect.any(Uint8Array),
      null,
      "derived-preview",
    );
  });

  it("invalidates every workspace preview and removes its metadata row", async () => {
    const room = fakeRoom({ workspace: true });
    const stale = [{ id: "preview-a" }, { id: "preview-b" }];
    mocks.derivedPreviews.mockReturnValue(stale);

    await expect(invalidateDerivedPreviews(room, "original-file")).resolves.toEqual(stale);

    expect(mocks.workspaceTrash.mock.calls.map(([id]) => id)).toEqual(["preview-a", "preview-b"]);
    expect(mocks.deleteFile.mock.calls.map(([, id]) => id)).toEqual(["preview-a", "preview-b"]);
  });

  it("trashes and restores a workspace original together with its previews", async () => {
    const room = fakeRoom({ workspace: true });
    mocks.derivedPreviews.mockReturnValue([{ id: "preview-a" }, { id: "preview-b" }]);

    await trashFileWithDerivedPreviews(room, "original-file");
    await restoreFileWithDerivedPreviews(room, "original-file");

    expect(mocks.workspaceTrash.mock.calls.map(([id]) => id)).toEqual([
      "preview-a",
      "preview-b",
      "original-file",
    ]);
    expect(mocks.workspaceRestore.mock.calls.map(([id]) => id)).toEqual([
      "original-file",
      "preview-a",
      "preview-b",
    ]);
    expect(mocks.derivedPreviews).toHaveBeenLastCalledWith(room.db, "original-file", true);
  });

  it("routes blob-room trash and restore through the encrypted database", async () => {
    const room = fakeRoom();

    await trashFileWithDerivedPreviews(room, "original-file");
    await restoreFileWithDerivedPreviews(room, "original-file");

    expect(mocks.trashFile).toHaveBeenCalledWith(room.db, "original-file", { kind: "user" });
    expect(mocks.restoreFile).toHaveBeenCalledWith(room.db, "original-file");
    expect(mocks.workspaceTrash).not.toHaveBeenCalled();
    expect(mocks.workspaceRestore).not.toHaveBeenCalled();
  });
});
