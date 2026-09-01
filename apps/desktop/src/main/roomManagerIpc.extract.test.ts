import { beforeEach, describe, expect, it, vi } from "vitest";

const roomManager = vi.hoisted(() => ({
  closeRoom: vi.fn(),
  createRoom: vi.fn(),
  hasRecoveryKey: vi.fn(),
  openRoom: vi.fn(),
  openRoomWithRecovery: vi.fn(),
  registerWorkspaceCopy: vi.fn(),
  renameRoom: vi.fn(),
  rescanWorkspaceRoom: vi.fn(),
  roomInfo: vi.fn(),
  setWorkspaceWatcherPolling: vi.fn(),
  takePendingOpen: vi.fn(),
  takeRecRecoveryError: vi.fn(),
  touchIdDisable: vi.fn(),
  touchIdEnable: vi.fn(),
  touchIdHas: vi.fn(),
  touchIdOpen: vi.fn(),
  workspaceWatcherStatus: vi.fn(),
  writeRecoveryKey: vi.fn(),
}));
const sealedPackages = vi.hoisted(() => ({
  create: vi.fn(),
  extract: vi.fn(),
  import: vi.fn(),
  inspect: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  convert: vi.fn(),
  storageUsage: vi.fn(),
}));

vi.mock("./roomManager.js", () => roomManager);
vi.mock("./workspace/conversion.js", () => ({ convertLegacyRoomToWorkspace: workspace.convert }));
vi.mock("./workspace/sealedPackage.js", () => ({
  createSealedPackage: sealedPackages.create,
  extractSealedFiles: sealedPackages.extract,
  importSealedPackage: sealedPackages.import,
  inspectSealedPackage: sealedPackages.inspect,
}));
vi.mock("./workspace/storageUsage.js", () => ({ roomStorageUsage: workspace.storageUsage }));

import { registerRoomManagerIpc } from "./roomManagerIpc.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function register(state: { room: unknown }): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerRoomManagerIpc({
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler as Handler);
    },
  } as never, state as never, {} as never);
  return handlers;
}

describe("registerRoomManagerIpc sealed extraction with fake IPC and package seams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sealedPackages.extract.mockReturnValue({ extracted: ["source-a"] });
  });

  it("forwards a valid closed-room selection and refuses invalid or unlocked states", () => {
    const state = { room: null as unknown };
    const extract = register(state).get("extract_sealed_files")!;
    const request = {
      packagePath: "/fake/archive.arcelle",
      password: "unused-fake-secret",
      fileIds: ["source-a", "source-b"],
      destinationPath: "/fake/extracted",
    };

    expect(extract({}, request)).toEqual({ extracted: ["source-a"] });
    expect(sealedPackages.extract).toHaveBeenCalledWith(
      request.packagePath,
      request.password,
      request.fileIds,
      request.destinationPath,
    );

    state.room = { workspace: {} };
    expect(() => extract({}, request)).toThrow("Lock the open room before extracting a sealed package.");

    state.room = null;
    expect(() => extract({}, { ...request, fileIds: ["source-a", 4] })).toThrow(
      "The sealed extraction selection is invalid.",
    );
    expect(() => extract({}, { ...request, fileIds: "source-a" })).toThrow(
      "The sealed extraction selection is invalid.",
    );
    expect(sealedPackages.extract).toHaveBeenCalledTimes(1);
  });

  it("guards conversion and forwards progress for a closed room", () => {
    const state = { room: null as unknown };
    const convert = register(state).get("convert_legacy_room")!;
    workspace.convert.mockReturnValue({ converted: true });
    const send = vi.fn();
    const request = { sourcePath: "/fake/old", password: "secret", destinationPath: "/fake/new" };

    expect(convert({ sender: { send } }, request)).toEqual({ converted: true });
    const options = workspace.convert.mock.calls[0]?.[3] as { progress: (value: unknown) => void };
    options.progress({ phase: "copy" });
    expect(send).toHaveBeenCalledWith("workspace-operation-progress", { phase: "copy" });

    state.room = { workspace: {} };
    expect(() => convert({}, request)).toThrow("Lock the open room before converting a legacy room.");
  });

  it("guards sealed package creation and forwards default package arguments", () => {
    const state = { room: null as unknown };
    const create = register(state).get("create_sealed_package")!;
    expect(() => create({}, { destinationPath: "/fake/package", exportPassword: null }))
      .toThrow("Sealed package creation is available for workspace rooms.");

    const room = {
      workspace: { kind: "fake workspace" },
      descriptor: { kind: "workspace-folder", roomId: "room-id" },
      password: "room-password",
    };
    state.room = room;
    sealedPackages.create.mockReturnValue({ created: true });
    expect(create({}, { destinationPath: "/fake/package", exportPassword: null })).toEqual({ created: true });
    expect(sealedPackages.create).toHaveBeenCalledWith(
      room.workspace,
      "room-id",
      "room-password",
      "/fake/package",
      "room-password",
      "backup",
      { progress: expect.any(Function) },
    );
  });

  it("forwards package inspection and guards room storage usage", () => {
    const state = { room: null as unknown };
    const handlers = register(state);
    sealedPackages.inspect.mockReturnValue({ files: ["a"] });
    expect(handlers.get("inspect_sealed_package")!({}, {
      packagePath: "/fake/package",
      password: "secret",
    })).toEqual({ files: ["a"] });

    expect(() => handlers.get("room_storage_usage")!({})).toThrow("No room is open.");
    const room = { workspace: {} };
    state.room = room;
    workspace.storageUsage.mockReturnValue({ bytes: 42 });
    expect(handlers.get("room_storage_usage")!({})).toEqual({ bytes: 42 });
    expect(workspace.storageUsage).toHaveBeenCalledWith(room);
  });
});
