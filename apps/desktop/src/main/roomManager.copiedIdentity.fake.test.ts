import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  class FakeWorkspaceService {
    recoverIncompleteOperations = vi.fn();
    materializeLiveBlobFiles = vi.fn(async () => 0);
    reconcile = vi.fn(async () => ({ added: 0, changed: 0, missing: 0, renamed: 0 }));

    constructor(_db: unknown, _rootPath: string) {}
  }

  class FakeWorkspaceIndexService {
    close = vi.fn();
    indexPending = vi.fn(async () => undefined);

    constructor(_workspace: unknown) {}
  }

  class FakeWorkspaceWatcher {
    close = vi.fn(async () => undefined);
    start = vi.fn();

    constructor(_rootPath: string, _options: unknown) {}
  }

  return {
    FakeWorkspaceIndexService,
    FakeWorkspaceService,
    FakeWorkspaceWatcher,
    acquireWorkspaceLease: vi.fn(),
    contentStoreFor: vi.fn(() => ({})),
    describeRoom: vi.fn(),
    getSetting: vi.fn(),
    openWorkspaceRoom: vi.fn(),
    pushRecent: vi.fn(),
    quiesceStaleJobs: vi.fn(),
    readRecent: vi.fn(),
    registerWorkspaceCopyIdentity: vi.fn(),
    releaseWorkspaceLease: vi.fn(),
    recoverRecChunksHybrid: vi.fn(async () => 0),
    roomCounts: vi.fn(() => [0, 0] as const),
  };
});

vi.mock("./cancel.js", () => ({
  cancelAll: vi.fn(),
  createCancelState: () => ({ cancels: new Map(), jobCancels: new Map(), cancelTree: new Map() }),
}));
vi.mock("./db-host/messages.js", () => ({ roomCounts: fakes.roomCounts }));
vi.mock("./db-host/recordings.js", () => ({
  recoverRecChunks: vi.fn(),
  recoverRecChunksHybrid: fakes.recoverRecChunksHybrid,
}));
vi.mock("./db-host/settings.js", () => ({ getSetting: fakes.getSetting, setSetting: vi.fn() }));
vi.mock("./engineRouting.js", () => ({ setBaseUrlOverride: vi.fn() }));
vi.mock("./jobs.js", () => ({
  markJobsParking: vi.fn(),
  parkRunningJobs: vi.fn(),
  PARKED_BY_LOCK: "parked",
  quiesceStaleJobs: fakes.quiesceStaleJobs,
}));
vi.mock("./jobQueue.js", () => ({ pumpOnOpen: vi.fn() }));
vi.mock("./jobScheduler.js", () => ({ spawnWorkflowScheduler: vi.fn() }));
vi.mock("./mcpConfig.js", () => ({
  MCP_CONFIG_KEY: "mcp_config",
  mcpGate: vi.fn(),
  readMcpApprovals: vi.fn(),
  renderCommandLine: vi.fn(),
}));
vi.mock("./privacy.js", () => ({
  clearPolicy: vi.fn(),
  refreshPolicy: vi.fn(),
  schedulePrivacyScan: vi.fn(),
}));
vi.mock("./recentTools.js", () => ({
  pushRecent: fakes.pushRecent,
  readRecent: fakes.readRecent,
  renameRecent: vi.fn(),
  writeRecent: vi.fn(),
}));
vi.mock("./workspace/contentStore.js", () => ({ contentStoreFor: fakes.contentStoreFor }));
vi.mock("./workspace/indexing.js", () => ({ WorkspaceIndexService: fakes.FakeWorkspaceIndexService }));
vi.mock("./workspace/roomLayout.js", () => ({
  acquireWorkspaceLease: fakes.acquireWorkspaceLease,
  createWorkspaceRoom: vi.fn(),
  describeRoom: fakes.describeRoom,
  openWorkspaceRoom: fakes.openWorkspaceRoom,
  registerWorkspaceCopyIdentity: fakes.registerWorkspaceCopyIdentity,
  releaseWorkspaceLease: fakes.releaseWorkspaceLease,
  WorkspaceLeaseConflictError: class WorkspaceLeaseConflictError extends Error {},
}));
vi.mock("./workspace/watcher.js", () => ({ WorkspaceWatcher: fakes.FakeWorkspaceWatcher }));
vi.mock("./workspace/workspaceService.js", () => ({ WorkspaceService: fakes.FakeWorkspaceService }));

import { createRoomManagerState, openRoom, registerWorkspaceCopy, type RoomManagerDeps } from "./roomManager.js";

type WorkspaceDescriptor = {
  kind: "workspace-folder";
  path: string;
  rootPath: string;
  dbPath: string;
  roomId: string;
};

function workspace(path: string, roomId: string): WorkspaceDescriptor {
  return { kind: "workspace-folder", path, rootPath: path, dbPath: `${path}/room.sqlite`, roomId };
}

function fakeDeps(): RoomManagerDeps {
  return {
    userDataDir: "/fabricated/user-data",
    spawnRoomServerIfEnabled: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getSetting.mockReturnValue(null);
  fakes.roomCounts.mockReturnValue([0, 0]);
  fakes.recoverRecChunksHybrid.mockResolvedValue(0);
  fakes.openWorkspaceRoom.mockImplementation((rootPath: string) => ({
    db: { rootPath },
    descriptor: workspace(rootPath, "not-used-by-open"),
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace-copy identity detection", () => {
  it("opens a matching fabricated recent workspace read-only while ignoring self and stale entries", () => {
    const copied = workspace("/fabricated/Finder Copy", "shared-room-id");
    const original = workspace("/fabricated/Original", "shared-room-id");
    const stalePath = "/fabricated/removed-workspace";
    fakes.readRecent.mockReturnValue([
      { path: copied.rootPath },
      { path: stalePath },
      { path: original.rootPath },
    ]);
    fakes.describeRoom.mockImplementation((roomPath: string) => {
      if (roomPath === copied.rootPath) return copied;
      if (roomPath === stalePath) throw new Error("fabricated stale recent workspace");
      if (roomPath === original.rootPath) return original;
      throw new Error(`unexpected fabricated path: ${roomPath}`);
    });

    const state = createRoomManagerState();
    const info = openRoom(state, fakeDeps(), copied.path, "fabricated-password");

    expect(info).toMatchObject({
      path: copied.path,
      readOnly: true,
      duplicateRoomIdentity: true,
    });
    expect(fakes.openWorkspaceRoom).toHaveBeenCalledWith(copied.rootPath, "fabricated-password", true);
    expect(fakes.acquireWorkspaceLease).not.toHaveBeenCalled();
    expect(fakes.quiesceStaleJobs).not.toHaveBeenCalled();
  });

  it("keeps a unique fabricated workspace writable when its other recents have no matching identity", async () => {
    const current = workspace("/fabricated/Current", "current-id");
    const sealedPath = "/fabricated/sealed-backup";
    const unrelated = workspace("/fabricated/Unrelated", "other-id");
    const lease = { rootPath: current.rootPath };
    fakes.readRecent.mockReturnValue([
      { path: current.rootPath },
      { path: sealedPath },
      { path: unrelated.rootPath },
    ]);
    fakes.describeRoom.mockImplementation((roomPath: string) => {
      if (roomPath === current.rootPath) return current;
      if (roomPath === sealedPath) {
        return { kind: "sealed-db", path: sealedPath, rootPath: null, dbPath: sealedPath, roomId: "sealed" };
      }
      if (roomPath === unrelated.rootPath) return unrelated;
      throw new Error(`unexpected fabricated path: ${roomPath}`);
    });
    fakes.acquireWorkspaceLease.mockReturnValue(lease);

    const state = createRoomManagerState();
    const info = openRoom(state, fakeDeps(), current.path, "fabricated-password");
    await Promise.resolve();

    expect(info).not.toHaveProperty("readOnly");
    expect(info).not.toHaveProperty("duplicateRoomIdentity");
    expect(fakes.acquireWorkspaceLease).toHaveBeenCalledWith(current.rootPath);
    expect(fakes.openWorkspaceRoom).toHaveBeenCalledWith(current.rootPath, "fabricated-password", false);
    expect(fakes.quiesceStaleJobs).toHaveBeenCalledOnce();
  });
});

describe("registerWorkspaceCopy recovery", () => {
  it("reopens a fabricated unregistered copy read-only after registration fails", () => {
    const copied = workspace("/fabricated/Finder Copy", "shared-room-id");
    const priorDb = { close: vi.fn() };
    const reopenedDb = { fake: "reopened-db" };
    const lease = { rootPath: copied.rootPath };
    const registrationFailure = new Error("fabricated identity registration failure");
    const state = createRoomManagerState();
    state.room = {
      conn: priorDb as never,
      descriptor: copied as never,
      duplicateRoomIdentity: true,
      name: "Finder Copy",
      password: "fabricated-password",
      path: copied.path,
      readOnly: true,
    };
    fakes.acquireWorkspaceLease.mockReturnValue(lease);
    fakes.registerWorkspaceCopyIdentity.mockImplementation(() => { throw registrationFailure; });
    fakes.openWorkspaceRoom.mockReturnValue({ db: reopenedDb, descriptor: copied });

    expect(() => registerWorkspaceCopy(state, fakeDeps())).toThrow(registrationFailure);

    expect(priorDb.close).toHaveBeenCalledOnce();
    expect(fakes.releaseWorkspaceLease).toHaveBeenCalledWith(lease);
    expect(fakes.openWorkspaceRoom).toHaveBeenCalledWith(copied.rootPath, "fabricated-password", true);
    expect(state.room).toMatchObject({
      conn: reopenedDb,
      duplicateRoomIdentity: true,
      path: copied.path,
      readOnly: true,
    });
  });

  it("clears the fabricated room when registration recovery cannot reopen the copy", () => {
    const copied = workspace("/fabricated/Finder Copy", "shared-room-id");
    const registrationFailure = new Error("fabricated identity registration failure");
    const reopenFailure = new Error("fabricated reopen failure");
    const state = createRoomManagerState();
    state.room = {
      conn: { close: vi.fn() } as never,
      descriptor: copied as never,
      duplicateRoomIdentity: true,
      name: "Finder Copy",
      password: "fabricated-password",
      path: copied.path,
      readOnly: true,
    };
    fakes.acquireWorkspaceLease.mockReturnValue({ rootPath: copied.rootPath });
    fakes.registerWorkspaceCopyIdentity.mockImplementation(() => { throw registrationFailure; });
    fakes.openWorkspaceRoom.mockImplementation(() => { throw reopenFailure; });

    expect(() => registerWorkspaceCopy(state, fakeDeps())).toThrow(registrationFailure);

    expect(state.room).toBeNull();
  });
});
