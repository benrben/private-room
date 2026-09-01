import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const mocks = vi.hoisted(() => ({
  getFileBytes: vi.fn(),
  listFiles: vi.fn(),
  readRoomFile: vi.fn(),
  sharp: vi.fn(),
}));

vi.mock("sharp", () => ({ default: mocks.sharp }));
vi.mock("./cancel.js", () => ({ CancelFlag: class CancelFlag {} }));
vi.mock("./castparse.js", () => ({ MAX_FOUND: 20, parseCast: vi.fn() }));
vi.mock("./db-host/files.js", () => ({
  getFileBytes: mocks.getFileBytes,
  getFileFull: vi.fn(),
  getFileMeta: vi.fn(),
  listFiles: mocks.listFiles,
}));
vi.mock("./db-host/story.js", () => ({
  addCastMember: vi.fn(),
  addShot: vi.fn(),
  createStoryList: vi.fn(),
  deleteStoryList: vi.fn(),
  listCast: vi.fn(),
  listShots: vi.fn(),
  listStoryLists: vi.fn(),
  removeCastMember: vi.fn(),
  removeShot: vi.fn(),
  reorderShots: vi.fn(),
  setCastFace: vi.fn(),
  setStoryShape: vi.fn(),
  updateCastMember: vi.fn(),
  updateShot: vi.fn(),
  updateStoryList: vi.fn(),
}));
vi.mock("./db-host/util.js", () => ({ queryRows: vi.fn() }));
vi.mock("./engineRouting.js", () => ({ resolvedBaseUrl: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn() }));
vi.mock("./mediaLimits.js", () => ({ allowsSeconds: vi.fn(), limitsFor: vi.fn() }));
vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarJsonCancellable: vi.fn() }));
vi.mock("./shotsplitTools.js", () => ({
  MAX_PARTS: 16,
  partsFor: vi.fn(),
  scriptChunks: vi.fn(),
  splitScript: vi.fn(),
}));
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: mocks.readRoomFile }));

import { resetThumbCacheForTests, storyPictures, storyPicturesInRoom } from "./storyTools.js";

const fakeDb = {} as Database.Database;

function fakeSharpPipeline(bytes: Buffer) {
  const chain = {
    jpeg: vi.fn(() => chain),
    removeAlpha: vi.fn(() => chain),
    resize: vi.fn(() => chain),
    toBuffer: vi.fn(async () => {
      if (bytes.toString() === "corrupt") throw new Error("fabricated decode failure");
      return Buffer.from(`thumbnail:${bytes.toString()}`);
    }),
  };
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  resetThumbCacheForTests();
  mocks.listFiles.mockReturnValue([]);
  mocks.sharp.mockImplementation(fakeSharpPipeline);
});

describe("storyPictures with fabricated loaders and image pipeline", () => {
  it("keeps valid image previews while skipping non-images, absent bytes, loader failures, and decode failures", async () => {
    mocks.listFiles.mockReturnValue([
      { id: "portrait", name: "portrait.png", mimeType: "image/png" },
      { id: "document", name: "notes.md", mimeType: "text/markdown" },
      { id: "missing", name: "missing.jpg", mimeType: "image/jpeg" },
      { id: "unreadable", name: "unreadable.webp", mimeType: "image/webp" },
      { id: "corrupt", name: "corrupt.gif", mimeType: "image/gif" },
      { id: "scene", name: "scene.webp", mimeType: "image/webp" },
    ]);
    mocks.getFileBytes.mockImplementation(async (_db: Database.Database, fileId: string) => {
      if (fileId === "missing") return null;
      if (fileId === "unreadable") throw new Error("fabricated read failure");
      return Buffer.from(fileId);
    });

    const first = await storyPictures(fakeDb);

    expect(first).toEqual([
      { fileId: "portrait", name: "portrait.png", thumbB64: Buffer.from("thumbnail:portrait").toString("base64") },
      { fileId: "scene", name: "scene.webp", thumbB64: Buffer.from("thumbnail:scene").toString("base64") },
    ]);
    expect(mocks.getFileBytes).toHaveBeenCalledTimes(5);
    expect(mocks.getFileBytes).not.toHaveBeenCalledWith(fakeDb, "document");
    expect(mocks.sharp).toHaveBeenCalledTimes(3);

    mocks.getFileBytes.mockClear();
    mocks.sharp.mockClear();
    expect(await storyPictures(fakeDb)).toEqual(first);
    expect(mocks.getFileBytes).toHaveBeenCalledTimes(3);
    expect(mocks.getFileBytes).not.toHaveBeenCalledWith(fakeDb, "portrait");
    expect(mocks.getFileBytes).not.toHaveBeenCalledWith(fakeDb, "scene");
    expect(mocks.sharp).toHaveBeenCalledOnce();
  });

  it("uses the fabricated workspace loader for uncached pictures", async () => {
    mocks.listFiles.mockReturnValue([{ id: "workspace-image", name: "cast.jpg", mimeType: "image/jpeg" }]);
    mocks.readRoomFile.mockResolvedValue({ bytes: Buffer.from("workspace-image") });
    const room = { db: fakeDb, path: "/fabricated-room", workspace: { fake: true } };

    await expect(storyPicturesInRoom(room as Parameters<typeof storyPicturesInRoom>[0])).resolves.toEqual([
      {
        fileId: "workspace-image",
        name: "cast.jpg",
        thumbB64: Buffer.from("thumbnail:workspace-image").toString("base64"),
      },
    ]);
    expect(mocks.readRoomFile).toHaveBeenCalledWith(room, "workspace-image");
    expect(mocks.getFileBytes).not.toHaveBeenCalled();
  });
});
