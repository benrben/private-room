import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimEdge, SimNode, View } from "./types";

const mocks = vi.hoisted(() => ({
  styleFor: vi.fn((kind: string) => ({ color: "purple", widthMul: 2, dash: kind === "solid" ? null : "2 4" })),
  edgeLines: vi.fn(() => ["evidence"]),
  edgeInk: vi.fn(() => 0.8),
  nodeRadius: vi.fn(() => 10),
}));
vi.mock("./edges", () => ({ styleFor: mocks.styleFor, edgeLines: mocks.edgeLines, edgeInk: mocks.edgeInk }));
vi.mock("./layout", () => ({ nodeRadius: mocks.nodeRadius }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function node(id: string, x: number, y: number): SimNode {
  return { id, name: id, kind: "file", x, y };
}

function edge(overrides: Partial<SimEdge["edge"]> = {}): SimEdge {
  return { ai: 0, bi: 1, edge: { a: "a", b: "b", kind: "derived", weight: 1, directed: true, shared: [], ...overrides } };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    se: edge(), a: node("a", 0, 0), b: node("b", 100, 0), view: { k: 2, x: 0, y: 0 } satisfies View,
    hovered: null, focusId: null, degree: new Map([["b", 1]]), showTip: vi.fn(), setTip: vi.fn(), ...overrides,
  };
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: Edge }] = await Promise.all([import("react-dom/client"), import("./Edge")]);
  const host = document.getElementById("root"); if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => { root.render(createElement("svg", null, createElement(Edge, input as React.ComponentProps<typeof Edge>))); await Promise.resolve(); });
  return { host, input, close: async () => act(async () => root.unmount()) };
}

function handler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps")); if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

afterEach(() => { vi.clearAllMocks(); for (const [key, value] of Object.entries(originalGlobals)) { if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("Edge", () => {
  it("shortens a directed link, scales its dash, and clears its owned tip on unmount", async () => {
    const view = await render();
    const [hit, painted] = [...view.host.querySelectorAll("line")];
    expect(painted.getAttribute("x2")).not.toBe("100");
    expect(painted.getAttribute("stroke-dasharray")).toBe("1 2");
    handler(hit, "onMouseEnter")({});
    expect(view.input.showTip).toHaveBeenCalledWith({}, "a → b", ["evidence"]);
    await view.close();
    expect(view.input.setTip).toHaveBeenCalledWith(null);
  });

  it("keeps a short directed edge and a solid undirected edge at its node", async () => {
    const view = await render(props({ se: edge({ kind: "solid", directed: false }), b: node("b", 1, 0), hovered: "a" }));
    const [hit, painted] = [...view.host.querySelectorAll("line")];
    expect(painted.getAttribute("x2")).toBe("1");
    expect(painted.getAttribute("stroke-dasharray")).toBeNull();
    handler(hit, "onMouseMove")({});
    handler(hit, "onMouseLeave")();
    expect(view.input.setTip).toHaveBeenCalledWith(null);
    await view.close();
  });
});
