import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastMember } from "./db-host/story.js";
import type { PlannedShot, RoomSource } from "./storyTools.js";

const fakes = vi.hoisted(() => ({
  addCastMember: vi.fn(),
  addShot: vi.fn(),
  allowsSeconds: vi.fn(),
  createStoryList: vi.fn(),
  deleteStoryList: vi.fn(),
  getFileBytes: vi.fn(),
  getFileFull: vi.fn(),
  getFileMeta: vi.fn(),
  limitsFor: vi.fn(),
  listCast: vi.fn(),
  listFiles: vi.fn(),
  listShots: vi.fn(),
  listStoryLists: vi.fn(),
  modelSetting: vi.fn(),
  parseCast: vi.fn(),
  partsFor: vi.fn(),
  queryRows: vi.fn(),
  readRoomFile: vi.fn(),
  removeCastMember: vi.fn(),
  removeShot: vi.fn(),
  reorderShots: vi.fn(),
  resolvedBaseUrl: vi.fn(),
  setCastFace: vi.fn(),
  setStoryShape: vi.fn(),
  sharp: vi.fn(),
  sidecarJsonCancellable: vi.fn(),
  scriptChunks: vi.fn(),
  splitScript: vi.fn(),
  updateCastMember: vi.fn(),
  updateShot: vi.fn(),
  updateStoryList: vi.fn(),
}));

vi.mock("sharp", () => ({ default: fakes.sharp }));
vi.mock("./cancel.js", () => ({ CancelFlag: class CancelFlag {} }));
vi.mock("./castparse.js", () => ({ MAX_FOUND: 20, parseCast: fakes.parseCast }));
vi.mock("./db-host/files.js", () => ({
  getFileBytes: fakes.getFileBytes,
  getFileFull: fakes.getFileFull,
  getFileMeta: fakes.getFileMeta,
  listFiles: fakes.listFiles,
}));
vi.mock("./db-host/story.js", () => ({
  addCastMember: fakes.addCastMember,
  addShot: fakes.addShot,
  createStoryList: fakes.createStoryList,
  deleteStoryList: fakes.deleteStoryList,
  listCast: fakes.listCast,
  listShots: fakes.listShots,
  listStoryLists: fakes.listStoryLists,
  removeCastMember: fakes.removeCastMember,
  removeShot: fakes.removeShot,
  reorderShots: fakes.reorderShots,
  setCastFace: fakes.setCastFace,
  setStoryShape: fakes.setStoryShape,
  updateCastMember: fakes.updateCastMember,
  updateShot: fakes.updateShot,
  updateStoryList: fakes.updateStoryList,
}));
vi.mock("./db-host/util.js", () => ({ queryRows: fakes.queryRows }));
vi.mock("./engineRouting.js", () => ({ resolvedBaseUrl: fakes.resolvedBaseUrl }));
vi.mock("./gatherContext.js", () => ({ modelSetting: fakes.modelSetting }));
vi.mock("./mediaLimits.js", () => ({
  allowsSeconds: fakes.allowsSeconds,
  limitsFor: fakes.limitsFor,
}));
vi.mock("./sidecarJsonCancellable.js", () => ({
  sidecarJsonCancellable: fakes.sidecarJsonCancellable,
}));
vi.mock("./shotsplitTools.js", () => ({
  MAX_PARTS: 16,
  partsFor: fakes.partsFor,
  scriptChunks: fakes.scriptChunks,
  splitScript: fakes.splitScript,
}));
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: fakes.readRoomFile }));

import {
  assignCast,
  namesAppear,
  parseParsedMembers,
  registerStoryIpc,
} from "./storyTools.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function handlersFor(room: RoomSource): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerStoryIpc(
    { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) } as never,
    room,
  );
  return handlers;
}

function invoke(handlers: Map<string, Handler>, channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was not registered`);
  return args === undefined ? handler({}) : handler({}, args);
}

function castMember(id: string, name: string): CastMember {
  return { id, name, description: "", story: "", faceFileId: null, ord: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.addCastMember.mockImplementation((_db, name, description, story) =>
    castMember("cast-created", name as string, description as string, story as string),
  );
  fakes.addShot.mockReturnValue({ id: "shot-created" });
  fakes.createStoryList.mockReturnValue("list-created");
  fakes.getFileFull.mockReturnValue(["script.md", null, null, "Mira enters the harbour."]);
  fakes.getFileMeta.mockReturnValue({ mimeType: "image/png", name: "mira.png" });
  fakes.limitsFor.mockReturnValue(undefined);
  fakes.listCast.mockReturnValue([castMember("mira", "Mira")]);
  fakes.listFiles.mockReturnValue([]);
  fakes.listShots.mockReturnValue([]);
  fakes.listStoryLists.mockReturnValue([{ id: "list-1", title: "Harbour" }]);
  fakes.modelSetting.mockReturnValue(null);
  fakes.parseCast.mockReturnValue([{ name: "Mira", description: "grey coat", story: "sailor" }]);
  fakes.partsFor.mockReturnValue(1);
  fakes.queryRows.mockImplementation((_db, _sql, _params, row) => [
    row(["file-1", "script.md", "one\n two", 18]),
  ]);
  fakes.scriptChunks.mockReturnValue(undefined);
  fakes.splitScript.mockReturnValue(["Mira enters the harbour."]);
});

describe("story IPC handlers with fabricated room dependencies", () => {
  const db = { tag: "fabricated-story-db" };
  const room: RoomSource = { currentRoom: () => ({ db, path: "/fake/story.roomai" }) as never };

  it("forwards board, picture, cast, and list handlers to the current fake room", async () => {
    const handlers = handlersFor(room);

    expect(invoke(handlers, "story_board", { listId: "missing" })).toMatchObject({
      selected: "list-1",
      lists: [{ id: "list-1" }],
    });
    await expect(invoke(handlers, "story_pictures")).resolves.toEqual([]);

    expect(invoke(handlers, "story_add_cast", { name: "Mira", description: "grey coat", story: "sailor" }))
      .toMatchObject({ id: "cast-created", name: "Mira" });
    invoke(handlers, "story_update_cast", { id: "mira", name: "Mira", description: "coat", story: "sailor" });
    invoke(handlers, "story_set_face", { id: "mira", fileId: "portrait" });
    invoke(handlers, "story_remove_cast", { id: "mira" });
    expect(fakes.updateCastMember).toHaveBeenCalledWith(db, "mira", "Mira", "coat", "sailor");
    expect(fakes.setCastFace).toHaveBeenCalledWith(db, "mira", "portrait");
    expect(fakes.removeCastMember).toHaveBeenCalledWith(db, "mira");

    expect(invoke(handlers, "story_create_list", { title: "Harbour", logline: "A return" })).toBe(
      "list-created",
    );
    invoke(handlers, "story_update_list", { id: "list-1", title: "Harbour", logline: "A return" });
    invoke(handlers, "story_set_shape", {
      id: "list-1",
      aspectRatio: "16:9",
      stillResolution: "1024x576",
      clipResolution: "1280x720",
    });
    invoke(handlers, "story_delete_list", { id: "list-1" });
    expect(fakes.updateStoryList).toHaveBeenCalledWith(db, "list-1", "Harbour", "A return");
    expect(fakes.setStoryShape).toHaveBeenCalledWith(
      db,
      "list-1",
      "16:9",
      "1024x576",
      "1280x720",
    );
    expect(fakes.deleteStoryList).toHaveBeenCalledWith(db, "list-1");
  });

  it("forwards shot, document, cast-file, and planning handlers through fakes", async () => {
    const handlers = handlersFor(room);

    expect(invoke(handlers, "story_add_shot", { listId: "list-1", action: "Mira arrives." })).toEqual({
      id: "shot-created",
    });
    invoke(handlers, "story_update_shot", {
      id: "shot-1",
      action: "Mira arrives.",
      castIds: ["mira"],
      seconds: 8,
      imageModel: "image",
      videoModel: "video",
    });
    invoke(handlers, "story_remove_shot", { id: "shot-1" });
    invoke(handlers, "story_reorder_shots", { listId: "list-1", ids: ["shot-2", "shot-1"] });
    expect(fakes.updateShot).toHaveBeenCalledWith(
      db,
      "shot-1",
      "Mira arrives.",
      ["mira"],
      8,
      "image",
      "video",
    );
    expect(fakes.removeShot).toHaveBeenCalledWith(db, "shot-1");
    expect(fakes.reorderShots).toHaveBeenCalledWith(db, "list-1", ["shot-2", "shot-1"]);

    expect(invoke(handlers, "story_documents")).toEqual([
      { fileId: "file-1", name: "script.md", words: 3, snippet: "one two" },
    ]);
    expect(invoke(handlers, "story_text_from_file", { fileId: "file-1" })).toBe(
      "Mira enters the harbour.",
    );
    await expect(invoke(handlers, "story_read_cast_file", { fileId: "file-1" })).resolves.toMatchObject({
      name: "script.md",
      readBy: "pattern matching",
    });
    expect(invoke(handlers, "story_add_cast_many", {
      members: [{ name: "Doran", description: "broad", story: "dock worker" }],
    })).toBe(1);

    expect(invoke(handlers, "story_plan_split", { script: "Mira arrives.", minutes: 0, secondsEach: 8 }))
      .toMatchObject({ parts: 1, totalSeconds: 8, fromScript: false });
    const shots: PlannedShot[] = [{ action: "Mira waves.", seconds: 8 }];
    expect(invoke(handlers, "story_apply_split", {
      listId: "list-1",
      shots,
      imageModel: " image ",
      videoModel: " video ",
    })).toBe(1);
    expect(fakes.updateShot).toHaveBeenLastCalledWith(
      db,
      "shot-created",
      "Mira waves.",
      ["mira"],
      8,
      "image",
      "video",
    );
  });

  it("preserves the no-room refusal before touching fake dependencies", () => {
    const closed: RoomSource = { currentRoom: () => null };
    const handlers = handlersFor(closed);

    expect(() => invoke(handlers, "story_board", {})).toThrow("No room is open.");
    expect(() => invoke(handlers, "story_pictures")).toThrow("No room is open.");
    expect(fakes.listStoryLists).not.toHaveBeenCalled();
    expect(fakes.listFiles).not.toHaveBeenCalled();
  });
});

describe("story cast-name and response parsing boundaries", () => {
  it("keeps malformed model cast arrays all-or-nothing", () => {
    expect(parseParsedMembers([{ name: "Mira", description: "grey coat", story: "sailor" }])).toEqual([
      { name: "Mira", description: "grey coat", story: "sailor" },
    ]);
    expect(parseParsedMembers([{ name: "Mira", description: "grey coat", story: 2 }])).toEqual([]);
    expect(parseParsedMembers([null])).toEqual([]);
    expect(parseParsedMembers({ cast: [] })).toEqual([]);
  });

  it("recognizes only whole cast names and carries the last named cast forward", () => {
    expect(namesAppear("Noah waits; then Noa speaks.", "Noa")).toBe(true);
    expect(namesAppear("Noah waits.", "Noa")).toBe(false);
    expect(namesAppear("Mira waits.", "")).toBe(false);

    expect(
      assignCast(
        [
          { action: "Noah waits.", seconds: 8 },
          { action: "Mira Halloran arrives.", seconds: 8 },
          { action: "She looks to sea.", seconds: 8 },
        ],
        [castMember("noa", "Noa"), castMember("mira", "Mira Halloran"), castMember("empty", "  ")],
      ),
    ).toEqual([[], ["mira"], ["mira"]]);
  });
});
