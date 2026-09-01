import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableName: vi.fn(),
  createRoomFile: vi.fn(),
  listFiles: vi.fn(),
  modelSetting: vi.fn(),
  markSectionOnly: vi.fn(),
  readRoomFile: vi.fn(),
  writeRoomFile: vi.fn(),
  toPng: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: mocks.availableName,
  getFileBytes: vi.fn(),
  getFileMeta: vi.fn(),
  getFileName: vi.fn(),
  inTransaction: vi.fn(),
  insertFile: vi.fn(),
  listFiles: mocks.listFiles,
  markSectionOnly: mocks.markSectionOnly,
  renameFile: vi.fn(),
  setFileExtractedText: vi.fn(),
  updateFileContent: vi.fn(),
}));
vi.mock("./db-host/versions.js", () => ({ snapshotFileVersion: vi.fn() }));
vi.mock("./editMatchExtraction.js", () => ({
  extensionOf: (name: string) => {
    const index = name.lastIndexOf(".");
    return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
  },
}));
vi.mock("./editMatch.js", () => ({ extractText: vi.fn() }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./privacy.js", () => ({ activePolicy: vi.fn() }));
vi.mock("./sketchRaster.js", () => ({ toPng: mocks.toPng }));
vi.mock("./workspace/roomContent.js", () => ({
  createRoomFile: mocks.createRoomFile,
  readRoomFile: mocks.readRoomFile,
  writeRoomFile: mocks.writeRoomFile,
}));

import { execDrawInRoom, execReadDrawingInRoom, type SketchRoom } from "./sketchCommands.js";
import { applyScript, defaultSketch, sketchToJson } from "./sketchDoc.js";

function workspaceRoom(): SketchRoom {
  return { db: {} as never, path: "/fabricated-room", workspace: {} as never };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.availableName.mockImplementation((_db: unknown, name: string) => name);
  mocks.createRoomFile.mockResolvedValue({ id: "created-sketch", name: "Created.sketch" });
  mocks.listFiles.mockReturnValue([{ id: "existing-sketch", name: "Existing.sketch" }]);
  mocks.readRoomFile.mockResolvedValue({ bytes: Buffer.from(sketchToJson(defaultSketch()), "utf8") });
  mocks.writeRoomFile.mockResolvedValue(undefined);
  mocks.modelSetting.mockReturnValue(null);
});

describe("execDrawInRoom with fabricated workspace boundaries", () => {
  it("delegates a non-workspace blank-name request without touching a room file", async () => {
    const room = { db: {} as never, path: "/fabricated-room" } as SketchRoom;

    await expect(execDrawInRoom(room, { name: "", script: "rect 0 0 10 10 blue \"A\"" })).resolves.toEqual({
      ok: false,
      error: "Say which sketch to draw on — a new name starts a new drawing.",
    });
    expect(mocks.readRoomFile).not.toHaveBeenCalled();
  });

  it("refuses a blank workspace drawing name before loading or creating a sketch", async () => {
    await expect(execDrawInRoom(workspaceRoom(), { name: "   ", script: "" })).resolves.toEqual({
      ok: false,
      error: "Say which sketch to draw on — a new name starts a new drawing.",
    });
    expect(mocks.readRoomFile).not.toHaveBeenCalled();
    expect(mocks.createRoomFile).not.toHaveBeenCalled();
  });

  it("writes an existing workspace drawing and emits its complete fake update payload", async () => {
    const room = workspaceRoom();
    const events: Array<[string, unknown]> = [];

    const result = await execDrawInRoom(
      room,
      { name: "Existing", script: 'rect 10 20 100 60 blue "Start"' },
      (event, payload) => events.push([event, payload]),
    );

    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('on "Existing.sketch"') });
    expect(mocks.writeRoomFile).toHaveBeenCalledWith(
      room,
      "existing-sketch",
      expect.any(Buffer),
      "Start\n",
      "The assistant drew",
    );
    expect(events.map(([event]) => event)).toEqual(["agent-open-file", "sketch-drawn", "room-files-changed"]);
  });

  it("does not write or emit when a fabricated script is invalid", async () => {
    const room = workspaceRoom();

    await expect(execDrawInRoom(room, { name: "Existing", script: "not-a-drawing-command" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not-a-drawing-command"),
    });
    expect(mocks.writeRoomFile).not.toHaveBeenCalled();
  });

  it("keeps an empty successful script read-only but still announces the existing drawing", async () => {
    const room = workspaceRoom();
    const events: string[] = [];

    await expect(
      execDrawInRoom(room, { name: "Existing", script: "canvas 1600 1000" }, (event) => events.push(event)),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.writeRoomFile).not.toHaveBeenCalled();
    expect(events).toEqual(["agent-open-file", "sketch-drawn", "room-files-changed"]);
  });

  it("creates a fabricated workspace sketch when none exists and reports it as started", async () => {
    mocks.listFiles.mockReturnValue([]);
    mocks.createRoomFile.mockResolvedValue({ id: "created-sketch", name: "Created.sketch" });
    const room = workspaceRoom();

    const result = await execDrawInRoom(room, { name: "Created", script: 'rect 1 2 30 40 red "New"' });

    expect(mocks.createRoomFile).toHaveBeenCalledWith(
      room,
      "Created.sketch",
      "application/json",
      expect.any(Buffer),
      "",
      "generated",
    );
    expect(mocks.markSectionOnly).toHaveBeenCalledWith(room.db, "created-sketch", "sketch");
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('Started "Created.sketch"') });
  });

  it("returns a fabricated room-read failure without writing or emitting", async () => {
    mocks.readRoomFile.mockRejectedValue(new Error("fabricated workspace read failure"));
    const events = vi.fn();

    await expect(execDrawInRoom(workspaceRoom(), { name: "Existing", script: "" }, events)).resolves.toEqual({
      ok: false,
      error: "fabricated workspace read failure",
    });
    expect(mocks.writeRoomFile).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it("returns a failed read when listing workspace drawings fails", async () => {
    mocks.listFiles.mockImplementation(() => { throw new Error("fabricated drawing list failure"); });

    await expect(execReadDrawingInRoom(workspaceRoom(), { name: "Existing" }, {
      pendingImages: [],
      visionChat: false,
    })).resolves.toEqual({ ok: false, error: "fabricated drawing list failure" });
  });

  it("keeps the measured report when picture rendering fails", async () => {
    const doc = defaultSketch();
    expect(applyScript(doc, 'rect 1 2 30 40 red "New"').ok).toBe(true);
    mocks.readRoomFile.mockResolvedValue({ bytes: Buffer.from(sketchToJson(doc), "utf8") });
    mocks.toPng.mockRejectedValue(new Error("fabricated raster failure"));
    const effects = { pendingImages: [] as string[], visionChat: true };

    const result = await execReadDrawingInRoom(workspaceRoom(), { name: "Existing" }, effects);

    expect(result).toMatchObject({
      ok: true,
      text: expect.stringContaining("The picture could not be drawn: fabricated raster failure"),
    });
    expect(effects.pendingImages).toEqual([]);
  });
});
