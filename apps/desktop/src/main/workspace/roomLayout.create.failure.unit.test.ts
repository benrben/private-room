import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  createRoom: vi.fn(),
  fs: {
    chmodSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  randomUUID: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => fakes.fs);
vi.mock("../db-host/open.js", () => ({
  createRoom: fakes.createRoom,
  openRoom: vi.fn(),
  openRoomReadonly: vi.fn(),
}));
vi.mock("../db-host/migrate.js", () => ({ migrate: vi.fn() }));
vi.mock("../db-host/meta.js", () => ({ setMeta: vi.fn() }));
vi.mock("../db-host/recovery.js", () => ({ recoverySidecarPath: vi.fn() }));
vi.mock("./pathSafety.js", () => ({ PRIVATE_DIR: ".arcelle" }));

describe("createWorkspaceRoom cleanup", () => {
  it("removes its unpublished temporary workspace without masking the creation failure", async () => {
    const close = vi.fn(() => {
      throw new Error("fabricated cleanup close failure");
    });
    fakes.createRoom.mockReturnValue({ close });
    fakes.randomUUID.mockReturnValueOnce("temporary-root-id").mockReturnValueOnce("room-id");
    fakes.fs.writeFileSync.mockImplementation(() => {
      throw new Error("fabricated marker write failure");
    });
    const { createWorkspaceRoom } = await import("./roomLayout.js");

    expect(() => createWorkspaceRoom("/fake/New Room", "password", "New Room"))
      .toThrow("fabricated marker write failure");
    expect(close).toHaveBeenCalledOnce();
    expect(fakes.fs.rmSync).toHaveBeenCalledWith(
      "/fake/.New Room.arcelle-temporary-root-id.tmp",
      { recursive: true, force: true },
    );
  });
});
