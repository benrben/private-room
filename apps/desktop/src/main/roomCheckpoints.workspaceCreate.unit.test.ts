import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkpointFilePath: vi.fn(),
  checkpointsDir: vi.fn(),
  createSealedPackage: vi.fn(),
  existsSync: vi.fn(),
  humanizeStorageError: vi.fn(),
  mkdirSync: vi.fn(),
  nowDate: vi.fn(),
  nowTimestamp: vi.fn(),
  randomUUID: vi.fn(),
  reconcile: vi.fn(),
  statSync: vi.fn(),
  writeManifest: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: mocks.statSync,
  unlinkSync: vi.fn(),
}));
vi.mock("./db-host/checkpoints.js", () => ({
  checkpointFilePath: mocks.checkpointFilePath,
  checkpointIdOk: vi.fn(),
  checkpointsDir: mocks.checkpointsDir,
  NOT_A_CHECKPOINT_ID: "not a checkpoint id",
  nowDate: mocks.nowDate,
  nowTimestamp: mocks.nowTimestamp,
  performSwap: vi.fn(),
  pruneAutoCheckpoints: vi.fn(),
  readManifest: vi.fn(),
  reconcile: mocks.reconcile,
  writeCheckpoint: vi.fn(),
  writeManifest: mocks.writeManifest,
}));
vi.mock("./db-host/rekey.js", () => ({ verifyPassword: vi.fn() }));
vi.mock("./roomManager.js", () => ({
  drainInflight: vi.fn(),
  humanizeStorageError: mocks.humanizeStorageError,
  NO_ROOM_OPEN: "No room is open.",
  openRoomImpl: vi.fn(),
  teardownOpenRoom: vi.fn(),
}));
vi.mock("./turnContext.js", () => ({ ROLLBACK_BUSY: "Room rollback in progress." }));
vi.mock("./workspace/sealedPackage.js", () => ({
  createSealedPackage: mocks.createSealedPackage,
  importSealedPackage: vi.fn(),
  inspectSealedPackage: vi.fn(),
}));

import { createCheckpointCore, createRoomCheckpoint, strandedCheckpointNames } from "./roomCheckpoints.js";

function workspaceState(descriptor = { kind: "workspace-folder", roomId: "workspace-room-id" }) {
  return {
    rollingBack: false,
    room: {
      conn: { fake: true },
      descriptor,
      password: "fake-room-password",
      path: "/fake-room",
      workspace: { fake: true },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkpointFilePath.mockImplementation((dir: string, id: string) => `${dir}/${id}.roomck`);
  mocks.checkpointsDir.mockReturnValue("/fake-room/checkpoints");
  mocks.createSealedPackage.mockResolvedValue(undefined);
  mocks.existsSync.mockReturnValue(true);
  mocks.humanizeStorageError.mockImplementation((error: unknown) => new Error(`humanized: ${String(error)}`));
  mocks.mkdirSync.mockReturnValue(undefined);
  mocks.nowDate.mockReturnValue("2026-09-01");
  mocks.nowTimestamp.mockReturnValue("2026-09-01T00:00:00.000Z");
  mocks.randomUUID.mockReturnValue("checkpoint-id");
  mocks.reconcile.mockReturnValue({ entries: [] });
  mocks.statSync.mockReturnValue({ size: 321 });
});

describe("createRoomCheckpoint through fabricated workspace checkpoint dependencies", () => {
  it("packages a workspace checkpoint, records its manifest entry, and supplies a default name", async () => {
    const state = workspaceState();
    const progress = { report: vi.fn() };

    await expect(
      createRoomCheckpoint(
        state as Parameters<typeof createRoomCheckpoint>[0],
        "  ",
        progress as Parameters<typeof createRoomCheckpoint>[2],
      ),
    ).resolves.toEqual({
      id: "checkpoint-id",
      name: "Checkpoint — 2026-09-01",
      createdAt: "2026-09-01T00:00:00.000Z",
      sizeBytes: 321,
      auto: false,
    });
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/fake-room/checkpoints", { recursive: true, mode: 0o700 });
    expect(mocks.createSealedPackage).toHaveBeenCalledWith(
      state.room.workspace,
      "workspace-room-id",
      "fake-room-password",
      "/fake-room/checkpoints/checkpoint-id.roomck",
      "fake-room-password",
      "checkpoint",
      { operation: "workspace-checkpoint", operationId: "checkpoint-id", progress },
    );
    expect(mocks.writeManifest).toHaveBeenCalledWith("/fake-room/checkpoints", {
      entries: [
        {
          id: "checkpoint-id",
          name: "Checkpoint — 2026-09-01",
          createdAt: "2026-09-01T00:00:00.000Z",
          sizeBytes: 321,
          auto: false,
        },
      ],
    });
  });

  it("preserves a supplied checkpoint name instead of using the default", async () => {
    const state = workspaceState();

    await expect(createRoomCheckpoint(state as Parameters<typeof createRoomCheckpoint>[0], "Before restructure")).resolves.toMatchObject({
      name: "Before restructure",
      auto: false,
    });
  });

  it("refuses a non-workspace descriptor before creating a folder or package", async () => {
    const state = workspaceState({ kind: "encrypted-room", roomId: "not-a-workspace" });

    await expect(createRoomCheckpoint(state as Parameters<typeof createRoomCheckpoint>[0], "Nope")).rejects.toThrow(
      "This room is not a workspace folder.",
    );
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.createSealedPackage).not.toHaveBeenCalled();
  });

  it("wraps a fabricated checkpoint-folder failure before reconciling or packaging", async () => {
    mocks.mkdirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await expect(createRoomCheckpoint(workspaceState() as Parameters<typeof createRoomCheckpoint>[0], "Save")).rejects.toThrow(
      "Could not create the checkpoints folder: permission denied",
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.createSealedPackage).not.toHaveBeenCalled();
  });

  it("humanizes a fabricated package failure without writing a manifest entry", async () => {
    mocks.createSealedPackage.mockRejectedValue(new Error("disk full"));

    await expect(createRoomCheckpoint(workspaceState() as Parameters<typeof createRoomCheckpoint>[0], "Save")).rejects.toThrow(
      "humanized: Error: disk full",
    );
    expect(mocks.writeManifest).not.toHaveBeenCalled();
    expect(mocks.humanizeStorageError).toHaveBeenCalledWith(expect.any(Error), "/fake-room");
  });

  it("refuses the synchronous checkpoint core for a workspace room", () => {
    expect(() => createCheckpointCore(
      workspaceState() as Parameters<typeof createCheckpointCore>[0],
      "sync checkpoint",
      false,
    )).toThrow("Workspace checkpoints must be created through the asynchronous checkpoint command.");
  });

  it("ignores a checkpoint payload removed after reconciliation", () => {
    mocks.reconcile.mockReturnValue({ entries: [{ id: "gone", name: "Gone" }] });
    mocks.checkpointFilePath.mockReturnValue("/fake-room/checkpoints/gone.roomck");
    mocks.existsSync.mockImplementation((candidate: string) => candidate.endsWith("/checkpoints"));

    expect(strandedCheckpointNames("/fake-room", "password")).toEqual([]);
  });
});
