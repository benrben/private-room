import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  type WatcherOptions = {
    onChange: (change: { kind: string; error?: string }) => void;
    reconcile: () => Promise<void>;
    polling: boolean;
  };
  const watchers: Array<{ rootPath: string; options: WatcherOptions; start: ReturnType<typeof vi.fn> }> = [];
  class FakeWorkspaceWatcher {
    rootPath: string;
    options: WatcherOptions;
    start = vi.fn();

    constructor(rootPath: string, options: WatcherOptions) {
      this.rootPath = rootPath;
      this.options = options;
      watchers.push(this);
    }

    close = vi.fn(async () => undefined);
  }
  class FakeWorkspaceIndexService {
    constructor(_workspace: unknown) {}

    close = vi.fn();
    indexPending = indexPending;
  }
  const indexPending = vi.fn(async () => undefined);
  return {
    FakeWorkspaceIndexService,
    FakeWorkspaceWatcher,
    getSetting: vi.fn(),
    indexPending,
    schedulePrivacyScan: vi.fn(),
    setSetting: vi.fn(),
    watchers,
  };
});

vi.mock("./db-host/settings.js", () => ({
  getSetting: fakes.getSetting,
  setSetting: fakes.setSetting,
}));
vi.mock("./privacy.js", () => ({
  clearPolicy: vi.fn(),
  refreshPolicy: vi.fn(),
  schedulePrivacyScan: fakes.schedulePrivacyScan,
}));
vi.mock("./workspace/indexing.js", () => ({ WorkspaceIndexService: fakes.FakeWorkspaceIndexService }));
vi.mock("./workspace/watcher.js", () => ({ WorkspaceWatcher: fakes.FakeWorkspaceWatcher }));
vi.mock("./workspace/workspaceService.js", () => ({ WorkspaceService: class WorkspaceService {} }));

import { setWorkspaceWatcherPolling } from "./roomManager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

describe("setWorkspaceWatcherPolling with fabricated watcher dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.watchers.length = 0;
    fakes.getSetting.mockReturnValue("true");
  });

  it("records watcher errors, reconciles the current fake room, and ignores ordinary changes", async () => {
    const reconciliation = deferred<{ added: number; changed: number; missing: number; renamed: number }>();
    const workspace = {
      materializeLiveBlobFiles: vi.fn(async () => 0),
      recoverIncompleteOperations: vi.fn(),
      reconcile: vi.fn(() => reconciliation.promise),
    };
    const previousWatcher = { close: vi.fn(async () => undefined) };
    const room = {
      conn: { fake: true },
      path: "/fake/workspace",
      name: "Fake workspace",
      password: "unused",
      descriptor: { rootPath: "/fake/workspace" },
      workspace,
      workspaceWatcher: previousWatcher,
      workspaceWatcherHealth: {
        state: "healthy" as const,
        lastReconciledAt: "before-fake-change",
        lastError: null,
        polling: false,
      },
    };
    const state = { room };
    const emit = vi.fn();

    const health = await setWorkspaceWatcherPolling(state as never, true, { emit } as never);
    const watcher = fakes.watchers[0]!;
    expect(health).toEqual({ state: "starting", lastReconciledAt: null, lastError: null, polling: true });
    expect(previousWatcher.close).toHaveBeenCalledOnce();
    expect(fakes.setSetting).toHaveBeenCalledWith(room.conn, "workspace_watcher_polling", "true");
    expect(workspace.recoverIncompleteOperations).toHaveBeenCalledOnce();
    expect(watcher.rootPath).toBe("/fake/workspace");
    expect(watcher.options.polling).toBe(true);

    watcher.options.onChange({ kind: "error" });
    expect(room.workspaceWatcherHealth).toEqual({
      state: "error",
      lastReconciledAt: null,
      lastError: "The workspace watcher reported an error.",
      polling: true,
    });
    watcher.options.onChange({ kind: "change" });
    expect(room.workspaceWatcherHealth.state).toBe("error");

    reconciliation.resolve({ added: 1, changed: 0, missing: 0, renamed: 0 });
    await settle();

    expect(workspace.reconcile).toHaveBeenCalledTimes(3);
    expect(fakes.indexPending).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
    expect(room.workspaceWatcherHealth.state).toBe("healthy");
    expect(room.workspaceWatcherHealth.lastError).toBeNull();
    expect(watcher.start).toHaveBeenCalledOnce();
  });

  it("does not fail repaired-file startup when the renderer closes during its notification", async () => {
    const workspace = {
      materializeLiveBlobFiles: vi.fn(async () => 2),
      recoverIncompleteOperations: vi.fn(),
      reconcile: vi.fn(async () => ({ added: 0, changed: 0, missing: 0, renamed: 0 })),
    };
    const room = {
      conn: { fake: true },
      path: "/fake/repaired-workspace",
      name: "Repaired workspace",
      password: "unused",
      descriptor: { rootPath: "/fake/repaired-workspace" },
      workspace,
    };
    const state = { room };
    const emit = vi.fn(() => { throw new Error("renderer closed"); });

    await setWorkspaceWatcherPolling(state as never, true, { emit } as never);
    await settle();

    expect(workspace.materializeLiveBlobFiles).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
    expect(fakes.watchers[0]!.start).toHaveBeenCalledOnce();
  });

  it("records and reports a startup reconciliation failure without starting the watcher", async () => {
    const failure = new Error("workspace index unavailable");
    const workspace = {
      materializeLiveBlobFiles: vi.fn(async () => 0),
      recoverIncompleteOperations: vi.fn(),
      reconcile: vi.fn(async () => { throw failure; }),
    };
    const room = {
      conn: { fake: true },
      path: "/fake/failing-workspace",
      name: "Failing workspace",
      password: "unused",
      descriptor: { rootPath: "/fake/failing-workspace" },
      workspace,
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await setWorkspaceWatcherPolling({ room } as never, true, {} as never);
    await settle();

    expect(room.workspaceWatcherHealth).toEqual({
      state: "error",
      lastReconciledAt: null,
      lastError: "workspace index unavailable",
      polling: true,
    });
    expect(fakes.watchers[0]!.start).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("workspace watcher could not start: workspace index unavailable");
    error.mockRestore();
  });
});
