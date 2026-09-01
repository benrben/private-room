import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: any[]) => void;

const fakes = vi.hoisted(() => ({
  events: new Map<string, Listener>(),
  watcher: null as { close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> } | null,
  watch: vi.fn(),
}));

vi.mock("chokidar", () => ({ default: { watch: fakes.watch } }));

import { WorkspaceWatcher } from "./watcher.js";

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function fakeWatcher() {
  const watcher = {
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
  };
  watcher.on.mockImplementation((name: string, listener: Listener) => {
    fakes.events.set(name, listener);
    return watcher;
  });
  watcher.once.mockImplementation((name: string, listener: Listener) => {
    if (name === "ready") queueMicrotask(listener);
    return watcher;
  });
  fakes.watcher = watcher;
  return watcher;
}

function errorListener(): Listener {
  const listener = fakes.events.get("error");
  if (!listener) throw new Error("Fabricated watcher error listener missing.");
  return listener;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let intervals: Array<() => void>;
let intervalHandle: { unref: ReturnType<typeof vi.fn> };
let clearInterval: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakes.events.clear();
  fakes.watcher = null;
  fakes.watch.mockReset().mockImplementation(() => fakeWatcher());
  intervals = [];
  intervalHandle = { unref: vi.fn() };
  clearInterval = vi.fn();
  vi.stubGlobal("setInterval", vi.fn((callback: () => void) => {
    intervals.push(callback);
    return intervalHandle;
  }));
  vi.stubGlobal("clearInterval", clearInterval);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.set(globalThis, "setInterval", originalSetInterval);
  Reflect.set(globalThis, "clearInterval", originalClearInterval);
  vi.restoreAllMocks();
});

describe("WorkspaceWatcher reconciliation with a fabricated watcher", () => {
  it("emits a portable relative path for a normal filesystem change", async () => {
    const onChange = vi.fn();
    const watcher = new WorkspaceWatcher("/fake/workspace", { onChange, reconcile: vi.fn() });
    await watcher.start();
    const add = fakes.events.get("add");
    if (!add) throw new Error("Fabricated add listener missing.");
    add("/fake/workspace/notes/today.txt");
    expect(onChange).toHaveBeenCalledWith({ kind: "add", relativePath: "notes/today.txt" });
    await watcher.close();
  });

  it("reports the watcher error and the rejected reconciliation without letting either escape", async () => {
    const onChange = vi.fn();
    const reconcile = vi.fn().mockRejectedValue(new Error("fake reconcile unavailable"));
    const watcher = new WorkspaceWatcher("/fake/workspace", { onChange, reconcile });

    await watcher.start();
    errorListener()(new Error("fake watcher failure"));
    await flush();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenNthCalledWith(1, {
      kind: "error",
      relativePath: null,
      error: "Error: fake watcher failure",
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      kind: "error",
      relativePath: null,
      error: "fake reconcile unavailable",
    });
    expect(intervalHandle.unref).toHaveBeenCalledTimes(1);

    await watcher.close();
    expect(clearInterval).toHaveBeenCalledWith(intervalHandle);
    expect(fakes.watcher?.close).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping fake reconciliations and stringifies a later timer failure", async () => {
    let finishFirst: () => void = () => undefined;
    const onChange = vi.fn();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockRejectedValueOnce("fake non-error failure");
    const watcher = new WorkspaceWatcher("/fake/workspace", { onChange, reconcile });

    await watcher.start();
    const tick = intervals[0];
    if (!tick) throw new Error("Fabricated reconciliation interval missing.");
    tick();
    tick();
    expect(reconcile).toHaveBeenCalledTimes(1);
    finishFirst();
    await flush();

    tick();
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith({
      kind: "error",
      relativePath: null,
      error: "fake non-error failure",
    });
    await watcher.close();
  });
});
