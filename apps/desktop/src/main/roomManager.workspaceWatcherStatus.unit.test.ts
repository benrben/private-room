import { describe, expect, it, vi } from "vitest";

vi.mock("./workspace/watcher.js", () => ({ WorkspaceWatcher: class WorkspaceWatcher {} }));
vi.mock("./workspace/workspaceService.js", () => ({ WorkspaceService: class WorkspaceService {} }));
vi.mock("./workspace/indexing.js", () => ({ WorkspaceIndexService: class WorkspaceIndexService {} }));

import { rescanWorkspaceRoom, workspaceWatcherStatus } from "./roomManager.js";

function roomWithWorkspace(overrides: Record<string, unknown> = {}): object {
  return {
    conn: {},
    name: "Fabricated workspace",
    password: "unused",
    path: "/fabricated-workspace",
    workspace: {},
    ...overrides,
  };
}

describe("workspaceWatcherStatus with fabricated room state", () => {
  it("returns null when no workspace room is open", () => {
    expect(workspaceWatcherStatus({ room: null } as never)).toBeNull();
    expect(workspaceWatcherStatus({ room: roomWithWorkspace({ workspace: undefined }) } as never)).toBeNull();
  });

  it("does not expose watcher health for a read-only fabricated workspace", () => {
    const state = {
      room: roomWithWorkspace({
        readOnly: true,
        workspaceWatcherHealth: {
          state: "error",
          lastError: "a different process owns the lease",
          lastReconciledAt: "2026-09-01T00:00:00.000Z",
          polling: true,
        },
      }),
    };

    expect(workspaceWatcherStatus(state as never)).toBeNull();
  });

  it("supplies the safe starting status until a writable fabricated watcher reports health", () => {
    const state = { room: roomWithWorkspace() };

    expect(workspaceWatcherStatus(state as never)).toEqual({
      state: "starting",
      lastReconciledAt: null,
      lastError: null,
      polling: false,
    });
  });

  it("returns the latest fabricated watcher status without reshaping its error details", () => {
    const health = {
      state: "error" as const,
      lastError: "watcher bridge disconnected",
      lastReconciledAt: "2026-09-01T12:34:56.000Z",
      polling: true,
    };
    const state = { room: roomWithWorkspace({ workspaceWatcherHealth: health }) };

    expect(workspaceWatcherStatus(state as never)).toBe(health);
  });
});

describe("rescanWorkspaceRoom with fabricated workspace boundaries", () => {
  it("refuses a read-only workspace before touching its files", async () => {
    const reconcile = vi.fn();
    const state = {
      room: roomWithWorkspace({ readOnly: true, workspace: { reconcile } }),
    };

    await expect(rescanWorkspaceRoom(state as never)).rejects.toThrow(/read-only/i);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("records a reconciliation error and preserves it for watcher diagnostics", async () => {
    const state = {
      room: roomWithWorkspace({
        workspace: { reconcile: vi.fn(async () => { throw new Error("disk disappeared"); }) },
      }),
    };

    await expect(rescanWorkspaceRoom(state as never)).rejects.toThrow("disk disappeared");
    expect((state.room as { workspaceWatcherHealth?: unknown }).workspaceWatcherHealth).toEqual({
      state: "error",
      lastReconciledAt: null,
      lastError: "disk disappeared",
      polling: false,
    });
  });

  it("keeps a successful rescan successful when the renderer closes during emit", async () => {
    const indexPending = vi.fn(async () => undefined);
    const emit = vi.fn(() => { throw new Error("renderer closed"); });
    const state = {
      room: roomWithWorkspace({
        workspace: { reconcile: vi.fn(async () => undefined) },
        workspaceIndexer: { indexPending },
      }),
    };

    const health = await rescanWorkspaceRoom(state as never, { emit } as never);

    expect(indexPending).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
    expect(health.state).toBe("healthy");
    expect(health.lastError).toBeNull();
  });
});
