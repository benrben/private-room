import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  availableName: vi.fn(),
  createRoomFile: vi.fn(),
  getFileBytes: vi.fn(),
  getFileMeta: vi.fn(),
  getFileName: vi.fn(),
  inTransaction: vi.fn(),
  insertFile: vi.fn(),
  listFiles: vi.fn(),
  markSectionOnly: vi.fn(),
  readRoomFile: vi.fn(),
  renameFile: vi.fn(),
  setFileExtractedText: vi.fn(),
  snapshotFileVersion: vi.fn(),
  updateFileContent: vi.fn(),
  writeRoomFile: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: fakes.availableName,
  getFileBytes: fakes.getFileBytes,
  getFileMeta: fakes.getFileMeta,
  getFileName: fakes.getFileName,
  inTransaction: fakes.inTransaction,
  insertFile: fakes.insertFile,
  listFiles: fakes.listFiles,
  markSectionOnly: fakes.markSectionOnly,
  renameFile: fakes.renameFile,
  setFileExtractedText: fakes.setFileExtractedText,
  updateFileContent: fakes.updateFileContent,
}));

vi.mock("./db-host/versions.js", () => ({ snapshotFileVersion: fakes.snapshotFileVersion }));
vi.mock("./editMatchExtraction.js", () => ({
  extensionOf: (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "",
}));
vi.mock("./editMatch.js", () => ({ extractText: vi.fn() }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn() }));
vi.mock("./privacy.js", () => ({ activePolicy: vi.fn() }));
vi.mock("./sketchRaster.js", () => ({ toPng: vi.fn() }));
vi.mock("./workspace/roomContent.js", () => ({
  createRoomFile: fakes.createRoomFile,
  readRoomFile: fakes.readRoomFile,
  writeRoomFile: fakes.writeRoomFile,
}));

import type Database from "better-sqlite3-multiple-ciphers";
import { execDrawInRoom, type SketchRoom } from "./sketchCommands.js";
import { defaultSketch, sketchToJson } from "./sketchDoc.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

const BLANK_ID = "blank-sketch";

function fakeRoom(row: unknown, move = vi.fn().mockResolvedValue(undefined)): {
  room: SketchRoom;
  move: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn().mockReturnValue(row);
  const prepare = vi.fn(() => ({ get }));
  return {
    room: {
      db: { prepare } as unknown as Database.Database,
      path: "/fabricated/room",
      workspace: { move } as unknown as WorkspaceService,
    },
    move,
    prepare,
  };
}

function expectSketchWrite(room: SketchRoom, id: string): void {
  expect(fakes.writeRoomFile).toHaveBeenCalledTimes(1);
  const write = fakes.writeRoomFile.mock.calls[0]!;
  expect(write[0]).toBe(room);
  expect(write[1]).toBe(id);
  expect(Buffer.isBuffer(write[2])).toBe(true);
  expect(write[3]).toBe("Start\n");
  expect(write[4]).toBe("The assistant drew");
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.listFiles.mockReturnValue([{ id: BLANK_ID, name: "Blank.sketch" }]);
  fakes.availableName.mockImplementation((_db: unknown, name: string) => name);
  fakes.readRoomFile.mockResolvedValue({ bytes: Buffer.from(sketchToJson(defaultSketch()), "utf8") });
  fakes.writeRoomFile.mockResolvedValue(undefined);
  fakes.createRoomFile.mockResolvedValue({ id: "generated-sketch", name: "Team plan.sketch" });
});

describe("execDrawInRoom blank-sketch rename", () => {
  it.each([
    ["Blank.sketch", null, "Team plan.sketch"],
    ["drafts/Blank.sketch", "content-hash", "drafts/Team plan.sketch"],
  ])(
    "moves a fabricated blank sketch from %s without touching the filesystem",
    async (relativePath, contentHash, destination) => {
      const { room, move, prepare } = fakeRoom({
        relative_path: relativePath,
        content_sha256: contentHash,
      });
      const events: Array<[string, unknown]> = [];

      const result = await execDrawInRoom(
        room,
        { name: "Team plan", script: 'rect 10 20 100 60 blue "Start"' },
        (event, payload) => events.push([event, payload]),
      );

      expect(result.ok).toBe(true);
      expect(prepare).toHaveBeenCalledWith(
        "SELECT relative_path, content_sha256 FROM files WHERE id = ? AND trashed_at IS NULL",
      );
      expect(move).toHaveBeenCalledWith(BLANK_ID, destination, contentHash ?? undefined);
      expect(fakes.readRoomFile).toHaveBeenCalledTimes(2);
      expectSketchWrite(room, BLANK_ID);
      expect(events.map(([event]) => event)).toEqual([
        "agent-open-file",
        "sketch-drawn",
        "room-files-changed",
      ]);
    },
  );

  it.each([undefined, { relative_path: null, content_sha256: null }])(
    "does not claim a blank sketch whose fabricated room row is missing",
    async (row) => {
      const { room, move } = fakeRoom(row);

      const result = await execDrawInRoom(
        room,
        { name: "Team plan", script: 'rect 10 20 100 60 blue "Start"' },
      );

      expect(result.ok).toBe(true);
      expect(move).not.toHaveBeenCalled();
      expect(fakes.createRoomFile).toHaveBeenCalledWith(
        room,
        "Team plan.sketch",
        "application/json",
        expect.any(Buffer),
        "",
        "generated",
      );
      expectSketchWrite(room, "generated-sketch");
    },
  );
});
