import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ listFiles: vi.fn(), readRoomFile: vi.fn(), sharp: vi.fn() }));

vi.mock("sharp", () => ({ default: fakes.sharp }));
vi.mock("./cancel.js", () => ({ CancelFlag: class CancelFlag {} }));
vi.mock("./castparse.js", () => ({ MAX_FOUND: 20, parseCast: vi.fn() }));
vi.mock("./db-host/files.js", () => ({
  getFileBytes: vi.fn(),
  getFileFull: vi.fn(),
  getFileMeta: vi.fn(),
  listFiles: fakes.listFiles,
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
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: fakes.readRoomFile }));

import { registerStoryIpc, type RoomSource } from "./storyTools.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function storyPicturesHandler(room: RoomSource): Handler {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) };
  registerStoryIpc(ipcMain as never, room);
  const handler = handlers.get("story_pictures");
  if (handler === undefined) throw new Error("story_pictures handler was not registered");
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.listFiles.mockReturnValue([]);
});

describe("story_pictures room lookup", () => {
  it("passes the current fabricated room to the pictures handler", async () => {
    const db = { fake: "story-db" };
    const currentRoom = { db, path: "/fabricated/story.roomai" };
    const handler = storyPicturesHandler({ currentRoom: () => currentRoom } as RoomSource);

    await expect(handler({})).resolves.toEqual([]);

    expect(fakes.listFiles).toHaveBeenCalledWith(db);
  });

  it("refuses the pictures handler when no fabricated room is open", () => {
    const handler = storyPicturesHandler({ currentRoom: () => null });

    expect(() => handler({})).toThrow("No room is open.");

    expect(fakes.listFiles).not.toHaveBeenCalled();
  });
});
