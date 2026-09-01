import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fs: {
    chmodSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  migrate: vi.fn(),
  openRoom: vi.fn(),
  randomUUID: vi.fn(),
  setMeta: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("node:fs", () => mocks.fs);
vi.mock("../db-host/open.js", () => ({
  createRoom: vi.fn(),
  openRoom: mocks.openRoom,
  openRoomReadonly: vi.fn(),
}));
vi.mock("../db-host/migrate.js", () => ({ migrate: mocks.migrate }));
vi.mock("../db-host/meta.js", () => ({ setMeta: mocks.setMeta }));
vi.mock("../db-host/recovery.js", () => ({ recoverySidecarPath: vi.fn() }));
vi.mock("./pathSafety.js", () => ({ PRIVATE_DIR: ".arcelle" }));

import { registerWorkspaceCopyIdentity } from "./roomLayout.js";

const ROOT = "/fake/Finder Copy";
const OLD_MARKER = { format: "arcelle-workspace", formatVersion: 2, roomId: "original-room-id" };
let markerText = "";
let tempMarkerText = "";

function fakeDb(closeFailure?: Error) {
  return {
    close: vi.fn(() => {
      if (closeFailure) throw closeFailure;
    }),
    transaction: vi.fn((work: () => void) => () => work()),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  markerText = JSON.stringify(OLD_MARKER);
  tempMarkerText = "";
  mocks.randomUUID.mockReturnValueOnce("new-room-identity").mockReturnValueOnce("temporary-marker-id");
  mocks.fs.existsSync.mockReturnValue(true);
  mocks.fs.statSync.mockReturnValue({ isDirectory: () => true });
  mocks.fs.readFileSync.mockImplementation(() => markerText);
  mocks.fs.writeFileSync.mockImplementation((_path: string, content: string) => {
    tempMarkerText = content;
  });
  mocks.fs.renameSync.mockImplementation(() => {
    markerText = tempMarkerText;
  });
});

describe("registerWorkspaceCopyIdentity with fabricated workspace boundaries", () => {
  it("publishes a fresh copy identity only after fake database metadata is prepared", () => {
    const db = fakeDb();
    mocks.openRoom.mockReturnValue(db);

    const registered = registerWorkspaceCopyIdentity(ROOT, "fake-password");

    expect(mocks.openRoom).toHaveBeenCalledWith("/fake/Finder Copy/.arcelle/room.db", "fake-password");
    expect(mocks.migrate).toHaveBeenCalledWith(db);
    expect(mocks.setMeta.mock.calls).toEqual([
      [db, "workspace_room_id", "new-room-identity"],
      [db, "workspace_format_version", "2"],
    ]);
    expect(JSON.parse(tempMarkerText)).toEqual({
      format: "arcelle-workspace",
      formatVersion: 2,
      roomId: "new-room-identity",
    });
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      "/fake/Finder Copy/.arcelle/room.json.temporary-marker-id.tmp",
      "/fake/Finder Copy/.arcelle/room.json",
    );
    expect(registered.descriptor.roomId).toBe("new-room-identity");
    expect(registered.db).toBe(db);
    expect(db.close).not.toHaveBeenCalled();
  });

  it("does nothing when the target is not a fabricated workspace folder", () => {
    mocks.fs.existsSync.mockReturnValue(false);

    expect(() => registerWorkspaceCopyIdentity("/fake/plain.roomai", "fake-password"))
      .toThrow("This path is not an Arcelle workspace folder.");
    expect(mocks.openRoom).not.toHaveBeenCalled();
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("restores the old identity and cleans up after a fake marker collision", () => {
    const collision = new Error("EEXIST: fabricated marker collision");
    const db = fakeDb(new Error("fabricated close failure"));
    mocks.openRoom.mockReturnValue(db);
    mocks.fs.renameSync.mockImplementation(() => { throw collision; });

    expect(() => registerWorkspaceCopyIdentity(ROOT, "fake-password")).toThrow(collision);

    expect(mocks.setMeta.mock.calls).toEqual([
      [db, "workspace_room_id", "new-room-identity"],
      [db, "workspace_format_version", "2"],
      [db, "workspace_room_id", "original-room-id"],
    ]);
    expect(mocks.fs.rmSync).toHaveBeenCalledWith(
      "/fake/Finder Copy/.arcelle/room.json.temporary-marker-id.tmp",
      { force: true },
    );
    expect(db.close).toHaveBeenCalledOnce();
  });
});
