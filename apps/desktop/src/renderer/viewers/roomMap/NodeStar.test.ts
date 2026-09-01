import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimNode, View } from "./types";

const layout = vi.hoisted(() => ({
  nodeRadius: vi.fn((degree: number) => 10 + degree),
  handCircle: vi.fn((radius: number) => `circle:${radius}`),
}));

vi.mock("./layout", () => layout);

import NodeStar from "./NodeStar";

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Mutable = Record<string, any>;

function node(overrides: Partial<SimNode> = {}): SimNode {
  return {
    id: "file-1",
    name: "Agenda.md",
    folder: "Work",
    kind: "file",
    x: 12,
    y: 34,
    ...overrides,
  };
}

function props(overrides: Mutable = {}): Mutable {
  return {
    n: node(),
    degree: new Map([["file-1", 1]]),
    hovered: null,
    focusId: null,
    focusNeighbors: null,
    view: { k: 2, x: 0, y: 0 } satisfies View,
    onOpenFile: vi.fn(),
    setHovered: vi.fn(),
    setFocus: vi.fn(),
    showTip: vi.fn(),
    setTip: vi.fn(),
    ...overrides,
  };
}

async function render(next: Mutable) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        "svg",
        null,
        createElement(NodeStar, next as React.ComponentProps<typeof NodeStar>),
      ),
    );
  });
  const star = host.querySelector("g");
  if (!star) throw new Error("node star missing");
  return { host, root, star, next };
}

function reactProps<T>(element: Element): T {
  const key = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, unknown>)[key] as T;
}

function event(x = 0, y = 0) {
  return { clientX: x, clientY: y };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("NodeStar", () => {
  it("renders an active file node and preserves hover, focus, keyboard, and click callbacks", async () => {
    const next = props({
      hovered: "file-1",
      focusNeighbors: new Set(["file-1"]),
    });
    const view = await render(next);
    expect(view.star.getAttribute("class")).toContain("is-file is-active");
    expect(view.star.getAttribute("transform")).toBe("translate(12 34)");
    expect(view.star.getAttribute("aria-label")).toBe(
      "Agenda.md, Work, 1 connection, press Enter to open",
    );
    expect(view.star.getAttribute("style")).toContain("cursor:pointer");
    expect(view.host.querySelector(".rm-node-hit")?.getAttribute("r")).toBe(
      "17.6",
    );
    expect(view.host.querySelector(".rm-node-circled")?.getAttribute("d")).toBe(
      "circle:20.35",
    );
    expect(view.host.querySelector(".rm-node-disc")).not.toBeNull();

    const handlers = reactProps<{
      onMouseEnter: (e: { clientX: number; clientY: number }) => void;
      onMouseMove: (e: { clientX: number; clientY: number }) => void;
      onMouseLeave: () => void;
      onFocus: () => void;
      onBlur: () => void;
      onKeyDown: (e: { key: string; preventDefault: () => void }) => void;
      onPointerDown: (e: { clientX: number; clientY: number }) => void;
      onClick: (e: { clientX: number; clientY: number }) => void;
    }>(view.star);
    handlers.onMouseEnter(event(2, 3));
    handlers.onMouseMove(event(4, 5));
    expect(next.showTip).toHaveBeenLastCalledWith(event(4, 5), "Agenda.md", [
      "Work",
    ]);
    handlers.onMouseLeave();
    handlers.onFocus();
    handlers.onBlur();
    expect(next.setHovered).toHaveBeenCalledWith("file-1");
    expect(next.setHovered).toHaveBeenLastCalledWith(null);
    expect(next.setTip).toHaveBeenCalledWith(null);

    const prevented = vi.fn();
    handlers.onKeyDown({ key: "Enter", preventDefault: prevented });
    handlers.onKeyDown({ key: " ", preventDefault: prevented });
    handlers.onKeyDown({ key: "ArrowDown", preventDefault: prevented });
    expect(prevented).toHaveBeenCalledTimes(2);
    expect(next.onOpenFile).toHaveBeenCalledTimes(2);

    const focused = next.setFocus.mock.calls.length;
    handlers.onPointerDown(event(1, 1));
    handlers.onClick(event(7, 1));
    expect(next.setFocus).toHaveBeenCalledTimes(focused);
    handlers.onClick(event());
    expect(next.setFocus).toHaveBeenCalledTimes(focused + 1);
    await act(async () => view.root.unmount());
  });

  it("renders a non-openable memory node and keeps its keyboard activation local", async () => {
    const next = props({
      n: node({
        id: "memory-1",
        name: "Project fact",
        folder: null,
        kind: "memory",
      }),
      degree: new Map(),
      focusNeighbors: new Set(["memory-1"]),
      onOpenFile: undefined,
      view: { k: 1, x: 0, y: 0 },
    });
    const view = await render(next);
    expect(view.star.getAttribute("class")).toContain("is-memory is-neighbour");
    expect(view.star.getAttribute("aria-label")).toBe(
      "Memory: Project fact, 0 connections",
    );
    expect(view.star.getAttribute("style")).toContain("cursor:default");
    expect(view.host.querySelector(".rm-node-ring")).not.toBeNull();
    expect(view.host.querySelector(".rm-node-core")).not.toBeNull();
    expect(view.host.querySelector(".rm-node-disc")).toBeNull();
    expect(view.host.querySelector(".rm-node-circled")).toBeNull();
    const handlers = reactProps<{
      onKeyDown: (e: { key: string; preventDefault: () => void }) => void;
      onClick: (e: { clientX: number; clientY: number }) => void;
    }>(view.star);
    handlers.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    handlers.onClick(event());
    expect(next.setFocus).toHaveBeenCalledWith("memory-1");
    await act(async () => view.root.unmount());
  });

  it("keeps an unfocused node free of a state class", async () => {
    const view = await render(props());
    expect(view.star.getAttribute("class")).toBe("room-map-node is-file");
    await act(async () => view.root.unmount());
  });
});
