import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_SCALE, MIN_SCALE } from "./constants";
import { computeFit } from "./layout";
import { usePanZoom } from "./usePanZoom";
import type { PanZoomApi } from "./usePanZoom";
import type { SimEdge, SimNode, Tip } from "./types";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Params = Parameters<typeof usePanZoom>[0];
type FakePointer = {
  clientX: number;
  clientY: number;
  currentTarget: object;
  pointerId: number;
  target: object;
};

function node(overrides: Partial<SimNode> = {}): SimNode {
  return { id: "node", name: "note", kind: "file", x: 30, y: -10, ...overrides };
}

function params(): {
  input: Params;
  layoutRef: React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>;
  setFocus: ReturnType<typeof vi.fn>;
  setTip: ReturnType<typeof vi.fn>;
  userAdjustedRef: React.MutableRefObject<boolean>;
} {
  const layoutRef = { current: null } as React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>;
  const userAdjustedRef = { current: false } as React.MutableRefObject<boolean>;
  const setFocus = vi.fn();
  const setTip = vi.fn();
  return {
    input: {
      sizeRef: { current: { w: 400, h: 300 } },
      userAdjustedRef,
      layoutRef,
      setFocus,
      setTip: setTip as (tip: Tip | null) => void,
    },
    layoutRef,
    setFocus,
    setTip,
    userAdjustedRef,
  };
}

async function render(input: Params) {
  let current: PanZoomApi | null = null;
  function Probe() {
    current = usePanZoom(input);
    return createElement("svg", { ref: current.svgRef });
  }
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("probe SVG missing");
  Object.defineProperty(svg, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 10, top: 20 }),
  });
  return {
    root,
    current: () => {
      if (!current) throw new Error("pan/zoom probe has not rendered");
      return current;
    },
  };
}

function pointer(
  target: object,
  currentTarget: object,
  clientX: number,
  clientY: number,
  pointerId = 7,
): FakePointer {
  return { target, currentTarget, clientX, clientY, pointerId };
}

function asPointer(event: FakePointer): React.PointerEvent {
  return event as unknown as React.PointerEvent;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("usePanZoom with fabricated SVG and pointer APIs", () => {
  it("uses client coordinates when no SVG bounds are available and zooms out", async () => {
    const setup = params();
    const view = await render(setup.input);
    (view.current().svgRef as React.MutableRefObject<SVGSVGElement | null>).current = null;

    await act(async () => view.current().onWheel({
      clientX: 100,
      clientY: 200,
      deltaY: 1,
      preventDefault: vi.fn(),
    } as unknown as React.WheelEvent));

    expect(view.current().view).toEqual({
      k: 1 / 1.12,
      x: 100 - 100 / 1.12,
      y: 200 - 200 / 1.12,
    });
    await act(async () => view.root.unmount());
  });

  it("zooms around the pointer and viewport center while respecting both scale limits", async () => {
    const setup = params();
    const view = await render(setup.input);
    const preventDefault = vi.fn();

    await act(async () => view.current().onWheel({
      clientX: 110,
      clientY: 220,
      deltaY: -1,
      preventDefault,
    } as unknown as React.WheelEvent));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setup.userAdjustedRef.current).toBe(true);
    expect(view.current().view).toEqual({ k: 1.12, x: -12.000000000000014, y: -24.00000000000003 });

    await act(async () => view.current().zoomBy(1_000));
    expect(view.current().view.k).toBe(MAX_SCALE);
    await act(async () => view.current().zoomBy(0));
    expect(view.current().view.k).toBe(MIN_SCALE);
    await act(async () => view.root.unmount());
  });

  it("resets to a fabricated layout and cleanly ignores an absent layout", async () => {
    const setup = params();
    const view = await render(setup.input);

    await act(async () => view.current().zoomBy(2));
    await act(async () => view.current().resetView());
    expect(setup.userAdjustedRef.current).toBe(false);
    expect(setup.setFocus).toHaveBeenCalledWith(null);
    expect(view.current().view).toEqual({ k: 2, x: -200, y: -150 });

    setup.layoutRef.current = { nodes: [node(), node({ id: "second", x: 90, y: 50 })], edges: [] };
    await act(async () => view.current().resetView());
    expect(view.current().view).toEqual(computeFit(setup.layoutRef.current.nodes, 400, 300));
    expect(setup.setFocus).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("pans only the backdrop, preserves a click deselect, and tolerates released capture", async () => {
    const setup = params();
    const view = await render(setup.input);
    const backdrop = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    const child = {};

    await act(async () => view.current().onBgDown(asPointer(pointer(child, backdrop, 5, 8))));
    expect(backdrop.setPointerCapture).not.toHaveBeenCalled();
    expect(setup.setTip).not.toHaveBeenCalled();
    await act(async () => view.current().onBgMove(asPointer(pointer(backdrop, backdrop, 20, 20))));
    expect(view.current().view).toEqual({ k: 1, x: 0, y: 0 });

    await act(async () => view.current().onBgDown(asPointer(pointer(backdrop, backdrop, 10, 10))));
    expect(backdrop.setPointerCapture).toHaveBeenCalledWith(7);
    expect(setup.setTip).toHaveBeenCalledWith(null);
    await act(async () => view.current().onBgMove(asPointer(pointer(backdrop, backdrop, 12, 12))));
    expect(view.current().view).toEqual({ k: 1, x: 2, y: 2 });
    await act(async () => view.current().onBgUp(asPointer(pointer(backdrop, backdrop, 12, 12))));
    expect(backdrop.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(setup.setFocus).toHaveBeenCalledWith(null);

    backdrop.releasePointerCapture.mockImplementationOnce(() => { throw new Error("already released"); });
    await act(async () => view.current().onBgDown(asPointer(pointer(backdrop, backdrop, 12, 12))));
    await act(async () => view.current().onBgMove(asPointer(pointer(backdrop, backdrop, 18, 12))));
    await act(async () => view.current().onBgUp(asPointer(pointer(backdrop, backdrop, 18, 12))));
    expect(view.current().view).toEqual({ k: 1, x: 8, y: 2 });
    expect(setup.setFocus).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount());
  });
});
