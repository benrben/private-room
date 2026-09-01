import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  createRoomCheckpoint: vi.fn(),
  deleteRoomCheckpoint: vi.fn(),
  listRoomCheckpoints: vi.fn(),
  rescanWorkspaceRoom: vi.fn(),
  rollbackRoomCheckpoint: vi.fn(),
  roomStorageUsage: vi.fn(),
  setWorkspaceWatcherPolling: vi.fn(),
  workspaceWatcherStatus: vi.fn(),
}));

vi.mock("../api", () => ({ api: bridge }));

import { useCheckpoints } from "./useCheckpoints";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

type Checkpoints = ReturnType<typeof useCheckpoints>;

function HookHost({ capture }: { capture: { current: Checkpoints | null } }) {
  capture.current = useCheckpoints();
  return null;
}

function usage(totalOnDiskBytes: number) {
  return {
    kind: "workspace" as const,
    liveFileBytes: 1,
    databaseBytes: 2,
    privateHistoryBytes: 3,
    totalOnDiskBytes,
  };
}

function watcher(state: "starting" | "healthy" | "error", polling = false) {
  return { state, polling, lastReconciledAt: null, lastError: state === "error" ? "fake watcher error" : null };
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperty(window, "setTimeout", { configurable: true, value: vi.fn(() => 1) });
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  const capture: { current: Checkpoints | null } = { current: null };
  await act(async () => {
    root.render(createElement(HookHost, { capture }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return capture;
}

function current(capture: { current: Checkpoints | null }): Checkpoints {
  if (capture.current === null) throw new Error("hook did not render");
  return capture.current;
}

beforeEach(() => {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.listRoomCheckpoints.mockResolvedValue({ entries: [], totalBytes: 0 });
  bridge.roomStorageUsage.mockResolvedValue(usage(6));
  bridge.workspaceWatcherStatus.mockResolvedValue(watcher("healthy"));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useCheckpoints watcher controls with fabricated API calls", () => {
  it("creates a fabricated named checkpoint, refreshes the list, and keeps a failed name for retry", async () => {
    const capture = await renderHook();
    const entry = { id: "checkpoint-1", name: "Before refactor", createdAt: "2026-09-01T08:00:00.000Z", sizeBytes: 42 };
    bridge.createRoomCheckpoint.mockResolvedValueOnce(entry);
    bridge.listRoomCheckpoints.mockResolvedValueOnce({ entries: [entry], totalBytes: 42 });

    await act(async () => current(capture).setCkName("  Before refactor  "));
    await act(async () => current(capture).createCheckpoint());

    expect(bridge.createRoomCheckpoint).toHaveBeenCalledWith("Before refactor");
    expect(current(capture).checkpoints).toEqual([entry]);
    expect(current(capture).totalBytes).toBe(42);
    expect(current(capture).ckName).toBe("");
    expect(current(capture).ckNotice).toBe("Saved checkpoint “Before refactor”.");
    expect(current(capture).creating).toBe(false);

    bridge.createRoomCheckpoint.mockRejectedValueOnce(new Error("fake checkpoint failure"));
    await act(async () => current(capture).setCkName("Retry checkpoint"));
    await act(async () => current(capture).createCheckpoint());
    expect(current(capture).ckError).toBe("Error: fake checkpoint failure");
    expect(current(capture).ckName).toBe("Retry checkpoint");
    expect(current(capture).creating).toBe(false);
  });

  it("rescans through fake IPC and refreshes watcher and storage status", async () => {
    const capture = await renderHook();
    bridge.rescanWorkspaceRoom.mockResolvedValueOnce(watcher("healthy", true));
    bridge.roomStorageUsage.mockResolvedValueOnce(usage(99));

    await act(async () => current(capture).rescanRoom());

    expect(bridge.rescanWorkspaceRoom).toHaveBeenCalledOnce();
    expect(current(capture).watcherStatus).toEqual(watcher("healthy", true));
    expect(current(capture).storageUsage).toEqual(usage(99));
    expect(current(capture).ckNotice).toBe("Room files were rescanned.");
    expect(current(capture).ckError).toBe("");
    expect(current(capture).rescanning).toBe(false);
  });

  it("reports fake rescan failures while preserving the latest watcher status when available", async () => {
    const capture = await renderHook();
    const fallback = watcher("error", true);
    bridge.rescanWorkspaceRoom.mockRejectedValueOnce(new Error("fake rescan failure"));
    bridge.workspaceWatcherStatus.mockResolvedValueOnce(fallback);

    await act(async () => current(capture).rescanRoom());

    expect(current(capture).ckError).toBe("Error: fake rescan failure");
    expect(current(capture).watcherStatus).toEqual(fallback);
    expect(current(capture).rescanning).toBe(false);

    bridge.rescanWorkspaceRoom.mockRejectedValueOnce(new Error("room closed"));
    bridge.workspaceWatcherStatus.mockRejectedValueOnce(new Error("no fake status"));
    await act(async () => current(capture).rescanRoom());
    expect(current(capture).ckError).toBe("Error: room closed");
    expect(current(capture).watcherStatus).toEqual(fallback);
  });

  it("sets fabricated polling on and off and keeps failures visible", async () => {
    const capture = await renderHook();
    bridge.setWorkspaceWatcherPolling
      .mockResolvedValueOnce(watcher("healthy", true))
      .mockResolvedValueOnce(watcher("starting", false))
      .mockRejectedValueOnce(new Error("fake polling failure"));

    await act(async () => current(capture).setWatcherPolling(true));
    expect(current(capture).watcherStatus).toEqual(watcher("healthy", true));
    expect(current(capture).ckNotice).toBe("Polling mode is on.");

    await act(async () => current(capture).setWatcherPolling(false));
    expect(current(capture).watcherStatus).toEqual(watcher("starting", false));
    expect(current(capture).ckNotice).toBe("Polling mode is off.");

    await act(async () => current(capture).setWatcherPolling(true));
    expect(current(capture).ckError).toBe("Error: fake polling failure");
    expect(current(capture).changingPolling).toBe(false);
    expect(bridge.setWorkspaceWatcherPolling.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
  });

  it("keeps the last snapshot when a fabricated refresh is incomplete", async () => {
    const capture = await renderHook();
    const entry = { id: "checkpoint-1", name: "Known", createdAt: "2026-09-01T08:00:00.000Z", sizeBytes: 42 };
    bridge.listRoomCheckpoints.mockResolvedValueOnce({ entries: [entry], totalBytes: 42 });
    await act(async () => current(capture).refresh());
    expect(current(capture).checkpoints).toEqual([entry]);

    bridge.listRoomCheckpoints.mockRejectedValueOnce(new Error("fake locked room"));
    await act(async () => current(capture).refresh());
    expect(current(capture).checkpoints).toEqual([entry]);
    expect(current(capture).totalBytes).toBe(42);
  });

  it("deletes a fabricated checkpoint, refreshes the list, and reports deletion failure", async () => {
    const capture = await renderHook();
    bridge.deleteRoomCheckpoint.mockResolvedValueOnce(undefined);
    bridge.listRoomCheckpoints.mockResolvedValueOnce({ entries: [], totalBytes: 0 });

    await act(async () => current(capture).deleteCheckpoint("checkpoint-1"));
    expect(bridge.deleteRoomCheckpoint).toHaveBeenCalledWith("checkpoint-1");
    expect(current(capture).checkpoints).toEqual([]);

    bridge.deleteRoomCheckpoint.mockRejectedValueOnce(new Error("fake delete failure"));
    await act(async () => current(capture).deleteCheckpoint("checkpoint-2"));
    expect(current(capture).ckError).toBe("Error: fake delete failure");
  });

  it("rolls back a fabricated checkpoint and resets the busy state only on failure", async () => {
    const capture = await renderHook();
    bridge.rollbackRoomCheckpoint.mockResolvedValueOnce(undefined);
    await act(async () => current(capture).setConfirmRollback("checkpoint-1"));
    await act(async () => current(capture).rollback("checkpoint-1"));
    expect(bridge.rollbackRoomCheckpoint).toHaveBeenCalledWith("checkpoint-1");
    expect(current(capture).confirmRollback).toBeNull();
    expect(current(capture).rollingBack).toBe(true);

    bridge.rollbackRoomCheckpoint.mockRejectedValueOnce(new Error("fake rollback failure"));
    await act(async () => current(capture).rollback("checkpoint-2"));
    expect(current(capture).ckError).toBe("Error: fake rollback failure");
    expect(current(capture).rollingBack).toBe(false);
  });
});
