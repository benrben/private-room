import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgeFilter } from "./edges";
import type { RoomGraph } from "./types";

const fakes = vi.hoisted(() => ({
  onMemoriesChanged: vi.fn(),
  onRoomFilesChanged: vi.fn(),
  memoriesChanged: null as unknown as ChangeListener,
  roomGraph: vi.fn(),
  roomFilesChanged: null as unknown as ChangeListener,
  unMemories: vi.fn(),
  unFiles: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: {
    onMemoriesChanged: fakes.onMemoriesChanged,
    onRoomFilesChanged: fakes.onRoomFilesChanged,
  },
  roomGraph: fakes.roomGraph,
}));

const { act, createElement, useState } = React;

const originalGlobals = {
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  ResizeObserver: globalThis.ResizeObserver,
  SVGElement: globalThis.SVGElement,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
  navigator: globalThis.navigator,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  window: globalThis.window,
};

type ChangeListener = () => void;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  emit(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as never);
  }
}

function graph(): RoomGraph {
  return {
    nodes: [
      { id: "file-a", name: "Alpha", kind: "file", folder: "notes" },
      { id: "file-b", name: "Beta", kind: "file" },
      { id: "mem-1", name: "Remember", kind: "memory" },
    ],
    edges: [
      { a: "file-a", b: "file-b", weight: 0.2, kind: "derived", directed: true, shared: ["source"] },
      { a: "file-a", b: "mem-1", weight: 0.7, kind: "similar", directed: false, shared: ["word"] },
      { a: "file-a", b: "missing", weight: 1, kind: "similar", directed: false, shared: [] },
    ],
  };
}

interface HookView {
  api: ReturnType<typeof import("./useRoomGraph").useRoomGraph> | null;
  focus: string | null;
  layoutRef: React.MutableRefObject<import("./types").SimNode[] extends never ? never : { nodes: import("./types").SimNode[]; edges: import("./types").SimEdge[] } | null>;
  render: (filter: EdgeFilter) => Promise<void>;
  setView: ReturnType<typeof vi.fn>;
  unmount: () => Promise<void>;
  emitResize: (width: number, height: number) => Promise<void>;
  runFrame: () => Promise<void>;
  fireDebounce: () => Promise<void>;
}

async function mountHook(initialFilter: EdgeFilter): Promise<HookView> {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Element", window.Element);
  Reflect.set(globalThis, "SVGElement", window.SVGElement);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

  const timers = new Map<number, () => void>();
  let timerId = 0;
  window.setTimeout = ((callback: () => void) => {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => timers.delete(id)) as typeof window.clearTimeout;

  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  Reflect.set(globalThis, "requestAnimationFrame", requestFrame);
  Reflect.set(globalThis, "cancelAnimationFrame", cancelFrame);
  FakeResizeObserver.instances = [];
  Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);

  const stageRef = { current: document.createElement("div") } as React.RefObject<HTMLDivElement | null>;
  const sizeRef = { current: { w: 200, h: 120 } };
  const userAdjustedRef = { current: false };
  const layoutRef = { current: null } as HookView["layoutRef"];
  const setView = vi.fn();
  let latest: HookView["api"] = null;

  const { useRoomGraph } = await import("./useRoomGraph");
  function Probe({ filter }: { filter: EdgeFilter }) {
    const [focus, setFocus] = useState<string | null>("file-a");
    latest = useRoomGraph({ filter, stageRef, sizeRef, userAdjustedRef, layoutRef, setView, setFocus });
    return createElement("output", { "data-focus": focus ?? "" });
  }

  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("missing fake React root");
  const root = createRoot(host);
  const render = async (filter: EdgeFilter) => {
    await act(async () => {
      root.render(createElement(Probe, { filter }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  };
  await render(initialFilter);

  return {
    get api() { return latest; },
    get focus() { return host.querySelector("output")?.getAttribute("data-focus") || null; },
    layoutRef,
    render,
    setView,
    unmount: async () => { await act(async () => root.unmount()); },
    emitResize: async (width, height) => {
      await act(async () => FakeResizeObserver.instances[0]?.emit(width, height));
    },
    runFrame: async () => {
      const frame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!frame) return;
      frames.delete(frame[0]);
      await act(async () => frame[1](0));
    },
    fireDebounce: async () => {
      const callback = timers.values().next().value as (() => void) | undefined;
      timers.clear();
      if (!callback) return;
      await act(async () => {
        callback();
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.onRoomFilesChanged.mockImplementation((listener: ChangeListener) => {
    fakes.roomFilesChanged = listener;
    return Promise.resolve(fakes.unFiles);
  });
  fakes.onMemoriesChanged.mockImplementation((listener: ChangeListener) => {
    fakes.memoriesChanged = listener;
    return Promise.resolve(fakes.unMemories);
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRoomGraph", () => {
  it("fetches, lays out, re-fits, filters, and debounces a fabricated graph", async () => {
    const loaded = graph();
    fakes.roomGraph.mockResolvedValue(loaded);
    const view = await mountHook({ hidden: ["similar"], minWeight: 0.9 });
    await vi.waitFor(() => expect(view.api?.graph).toBe(loaded));

    expect(view.api?.cappedEdges).toHaveLength(2);
    expect(view.api?.visibleEdges.map((edge) => edge.kind)).toEqual(["derived"]);
    expect(view.api?.edgeCounts).toEqual({ derived: 1, similar: 1 });
    expect(view.api?.fileNodeCount).toBe(2);
    expect(view.api?.degree).toEqual(new Map([["file-a", 1], ["file-b", 1]]));
    expect(view.api?.adjacency).toEqual(new Map([["file-a", new Set(["file-b"])], ["file-b", new Set(["file-a"])]]));
    expect(view.api?.topNode).toBe("file-a");
    expect(view.focus).toBe("file-a");

    const firstLayout = view.layoutRef.current;
    expect(firstLayout?.edges.map((edge) => edge.hidden)).toEqual([false, true]);
    await view.emitResize(320, 180);
    expect(view.api?.size).toEqual({ w: 320, h: 180 });
    expect(view.setView).toHaveBeenCalled();
    await view.runFrame();
    expect(view.api?.nonce).toBeGreaterThan(0);

    await view.render({ hidden: ["derived"], minWeight: 0 });
    expect(view.layoutRef.current).toBe(firstLayout);
    expect(view.layoutRef.current?.edges.map((edge) => edge.hidden)).toEqual([true, false]);

    (fakes.roomFilesChanged as ChangeListener)();
    (fakes.memoriesChanged as ChangeListener)();
    await view.fireDebounce();
    expect(fakes.roomGraph).toHaveBeenCalledTimes(2);
    expect(view.layoutRef.current).toBe(firstLayout);

    await view.unmount();
    await Promise.resolve();
    expect(fakes.unFiles).toHaveBeenCalledOnce();
    expect(fakes.unMemories).toHaveBeenCalledOnce();
  });

  it("surfaces a fabricated fetch failure, retries, and clears an empty layout", async () => {
    let resolveRetry: (value: RoomGraph) => void = () => {};
    const retry = new Promise<RoomGraph>((resolve) => { resolveRetry = resolve; });
    fakes.roomGraph
      .mockRejectedValueOnce(new Error("fabricated graph failure"))
      .mockReturnValueOnce(retry);
    const view = await mountHook({ hidden: [], minWeight: 0 });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(view.api?.error).toBe("Error: fabricated graph failure");

    await act(async () => {
      view.api?.reload();
      await Promise.resolve();
    });
    expect(view.api?.status).toBe("Mapping the room…");
    resolveRetry({ nodes: [], edges: [] });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(view.api?.graph).toEqual({ nodes: [], edges: [] });
    expect(view.layoutRef.current).toBeNull();
    expect(view.api?.topNode).toBeNull();
    expect(view.api?.atFileLimit).toBe(false);

    await view.unmount();
  });
});
