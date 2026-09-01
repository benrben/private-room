import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getFileBytesNamed: vi.fn(),
  readRoomFile: vi.fn(),
  setCellInBytes: vi.fn(),
  storeFileBytes: vi.fn(),
  writeRoomFile: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({ getFileBytesNamed: fakes.getFileBytesNamed }));
vi.mock("./editMatch.js", () => ({ storeFileBytes: fakes.storeFileBytes }));
vi.mock("./editMatchCells.js", () => ({ setCellInBytes: fakes.setCellInBytes }));
vi.mock("./workspace/roomContent.js", () => ({
  readRoomFile: fakes.readRoomFile,
  writeRoomFile: fakes.writeRoomFile,
}));

import {
  openDb,
  registerSpreadsheetIpc,
  setCell,
  setCellInRoom,
  type RoomSource,
} from "./spreadsheetTools.js";

const sourceBytes = Buffer.from("name,total\nalpha,5\n");
const editedBytes = Buffer.from("name,total\nalpha,7\n");

function fakeOpenRoom() {
  return { db: { prepare: vi.fn() }, path: "/fabricated-room" };
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.getFileBytesNamed.mockReturnValue(["budget.csv", sourceBytes]);
  fakes.readRoomFile.mockResolvedValue({ bytes: sourceBytes, name: "budget.csv" });
  fakes.setCellInBytes.mockReturnValue({ ok: true, bytes: editedBytes, text: "name,total\nalpha,7\n" });
  fakes.writeRoomFile.mockResolvedValue(undefined);
});

describe("spreadsheet tool room plumbing with fabricated dependencies", () => {
  it("returns a fabricated open database and refuses an absent room", () => {
    const db = { prepare: vi.fn() };
    const currentRoom = vi.fn(() => ({ db, path: "/fabricated-room" }));
    const room: RoomSource = { currentRoom: currentRoom as RoomSource["currentRoom"] };

    expect(openDb(room)).toBe(db);
    expect(currentRoom).toHaveBeenCalledOnce();
    expect(() => openDb({ currentRoom: () => null } as RoomSource)).toThrow("No room is open.");
  });

  it("persists one fabricated cell result and emits the exact completion sequence", () => {
    const db = { prepare: vi.fn() };
    const emit = vi.fn();

    setCell(db as never, "file-1", null, "B2", "7", emit);

    expect(fakes.getFileBytesNamed).toHaveBeenCalledWith(db, "file-1");
    expect(fakes.setCellInBytes).toHaveBeenCalledWith("budget.csv", sourceBytes, null, "B2", "7");
    expect(fakes.storeFileBytes).toHaveBeenCalledWith(
      db,
      "file-1",
      editedBytes,
      "name,total\nalpha,7\n",
      "You edited",
    );
    expect(emit.mock.calls).toEqual([
      ["room-files-changed", undefined],
      ["file-updated", "file-1"],
    ]);
  });

  it("refuses missing bytes or a fabricated cell-edit error before storing or emitting", () => {
    const db = { prepare: vi.fn() };
    const emit = vi.fn();
    fakes.getFileBytesNamed.mockReturnValueOnce(["budget.csv", null]);

    expect(() => setCell(db as never, "file-missing", null, "A1", "x", emit))
      .toThrow("File has no stored content.");

    fakes.setCellInBytes.mockReturnValueOnce({ ok: false, error: "A0 is not a cell." });
    expect(() => setCell(db as never, "file-bad-cell", null, "A0", "x", emit))
      .toThrow("A0 is not a cell.");
    expect(fakes.storeFileBytes).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps a successful fabricated edit durable even if renderer notification throws", () => {
    const db = { prepare: vi.fn() };
    const emit = vi.fn(() => { throw new Error("fabricated renderer closed"); });

    expect(() => setCell(db as never, "file-2", null, "B2", "7", emit)).not.toThrow();
    expect(fakes.storeFileBytes).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("uses fabricated workspace content for direct and registered IPC cell edits", async () => {
    const open = fakeOpenRoom();
    const emit = vi.fn();

    await setCellInRoom(open as never, "workspace-file", "Sheet 1", "B2", "7", emit);
    expect(fakes.readRoomFile).toHaveBeenCalledWith(open, "workspace-file");
    expect(fakes.writeRoomFile).toHaveBeenCalledWith(
      open,
      "workspace-file",
      editedBytes,
      "name,total\nalpha,7\n",
      "You edited",
    );

    const handlers = new Map<string, (event: unknown, args: unknown) => unknown>();
    registerSpreadsheetIpc(
      { handle: (channel: string, listener: (event: unknown, args: unknown) => unknown) => handlers.set(channel, listener) } as never,
      { currentRoom: () => open } as never,
      emit,
    );
    const handler = handlers.get("set_cell");
    if (!handler) throw new Error("Fabricated set_cell handler missing.");
    await expect(handler({}, { id: "ipc-file", sheet: null, cell: "C3", value: "9" })).resolves.toBeUndefined();
    expect(fakes.readRoomFile).toHaveBeenLastCalledWith(open, "ipc-file");

    const absent = new Map<string, (event: unknown, args: unknown) => unknown>();
    registerSpreadsheetIpc(
      { handle: (channel: string, listener: (event: unknown, args: unknown) => unknown) => absent.set(channel, listener) } as never,
      { currentRoom: () => null },
    );
    const missingHandler = absent.get("set_cell");
    if (!missingHandler) throw new Error("Fabricated missing-room handler missing.");
    expect(() => missingHandler({}, { id: "x", sheet: null, cell: "A1", value: "y" }))
      .toThrow("No room is open.");
  });
});
