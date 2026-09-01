import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab, TabsApi } from "../workspace/tabs";

const adaptiveText = vi.hoisted(() => ({ useAdaptiveText: vi.fn() }));

vi.mock("../workspace/adaptiveText", () => adaptiveText);
vi.mock("../icons", () => ({ CloseIcon: () => null }));

import TabStrip, { type TabTitleFacts } from "./TabStrip";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "ResizeObserver",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

const tabRows: Tab[] = [
  { id: "file:one", kind: "file", ref: "one", title: "First plan" },
  { id: "file:two", kind: "file", ref: "two", title: "Second plan" },
  { id: "file:three", kind: "file", ref: "three", title: "Third plan" },
];

function tabs(overrides: Partial<TabsApi> = {}): TabsApi {
  const tabList = overrides.tabs ?? tabRows;
  return {
    tabs: tabList,
    activeId: "file:two",
    active: tabList[1] ?? null,
    restored: true,
    open: vi.fn(),
    close: vi.fn(),
    activate: vi.fn(),
    retitle: vi.fn(),
    move: vi.fn(),
    step: vi.fn(),
    activateIndex: vi.fn(),
    prune: vi.fn(),
    unlist: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(tabApi = tabs()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  class ResizeObserverStub {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(_callback: ResizeObserverCallback) {}
  }
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const facts = (tab: Tab): TabTitleFacts | null => (
    tab.id === "file:one" ? { name: tab.title, kind: "document" } : null
  );
  await act(async () => {
    root.render(createElement(TabStrip, {
      tabs: tabApi,
      icons: (tab) => tab.id === "file:three" ? createElement("i", { "data-icon": "three" }) : null,
      roomId: "room-1",
      titleFacts: facts,
    }));
  });
  await flush();
  return { host, root, tabApi, window };
}

function handler<T>(node: Element, name: string): T {
  const key = Object.getOwnPropertyNames(node).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React ${name} handler missing`);
  return (node as unknown as Record<string, Record<string, T>>)[key]![name]!;
}

function tab(host: Element, id: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[role="tab"][title="${id}"]`);
  if (!found) throw new Error(`tab missing: ${id}`);
  return found;
}

async function keyDown(node: Element, key: string) {
  const preventDefault = vi.fn();
  await act(async () => {
    handler<(event: { key: string; preventDefault: () => void }) => void>(node, "onKeyDown")({
      key,
      preventDefault,
    });
  });
  await flush();
  return preventDefault;
}

beforeEach(() => {
  adaptiveText.useAdaptiveText.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("TabStrip", () => {
  it("renders supplied icons and fallback titles while scoping generated-title facts to the room", async () => {
    const view = await render();
    expect(view.host.textContent).toContain("First plan");
    expect(view.host.querySelector('[data-icon="three"]')).not.toBeNull();
    expect(adaptiveText.useAdaptiveText).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1",
      enabled: true,
      facts: { name: "First plan", kind: "document" },
    }));
    expect(adaptiveText.useAdaptiveText).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      facts: null,
    }));
    await act(async () => view.root.unmount());
  });

  it("activates, roves, and closes tabs through keyboard and pointer controls", async () => {
    const view = await render();
    const first = tab(view.host, "First plan");
    const second = tab(view.host, "Second plan");
    const third = tab(view.host, "Third plan");
    expect(second.getAttribute("aria-selected")).toBe("true");

    const enter = await keyDown(first, "Enter");
    const space = await keyDown(second, " ");
    const left = await keyDown(first, "ArrowLeft");
    const right = await keyDown(third, "ArrowRight");
    const home = await keyDown(third, "Home");
    const end = await keyDown(first, "End");
    const ignored = await keyDown(first, "Escape");
    expect(enter).toHaveBeenCalledOnce();
    expect(space).toHaveBeenCalledOnce();
    expect(left).toHaveBeenCalledOnce();
    expect(right).toHaveBeenCalledOnce();
    expect(home).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(1, "file:one");
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(2, "file:two");
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(3, "file:three");
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(4, "file:one");
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(5, "file:one");
    expect(view.tabApi.activate).toHaveBeenNthCalledWith(6, "file:three");

    await act(async () => {
      handler<() => void>(third, "onClick")();
    });
    expect(view.tabApi.activate).toHaveBeenLastCalledWith("file:three");

    const close = first.querySelector<HTMLButtonElement>("button");
    if (!close) throw new Error("close button missing");
    const stopPropagation = vi.fn();
    await act(async () => {
      handler<(event: { stopPropagation: () => void }) => void>(close, "onClick")({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(view.tabApi.close).toHaveBeenCalledWith("file:one");
    await act(async () => view.root.unmount());
  });

  it("reorders a dragged tab, closes on middle click, and marks scrollable ends", async () => {
    const view = await render();
    const first = tab(view.host, "First plan");
    const second = tab(view.host, "Second plan");
    const strip = view.host.querySelector<HTMLElement>(".tab-strip");
    if (!strip) throw new Error("tab strip missing");
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, writable: true, value: 20 },
    });
    await act(async () => {
      handler<() => void>(first, "onDragStart")();
    });
    await flush();
    await act(async () => {
      handler<(event: { preventDefault: () => void }) => void>(second, "onDragOver")({ preventDefault: vi.fn() });
      handler<() => void>(first, "onDragEnd")();
      handler<(event: { button: number; preventDefault: () => void }) => void>(second, "onAuxClick")({
        button: 1,
        preventDefault: vi.fn(),
      });
      handler<() => void>(strip, "onScroll")();
    });
    await flush();
    expect(view.tabApi.move).toHaveBeenCalledWith(0, 1);
    expect(view.tabApi.close).toHaveBeenCalledWith("file:two");
    expect(view.host.querySelector(".tab-strip-wrap")?.hasAttribute("data-more-start")).toBe(true);
    expect(view.host.querySelector(".tab-strip-wrap")?.hasAttribute("data-more-end")).toBe(true);
    await act(async () => view.root.unmount());
  });

  it("does not render a tablist when there are no open documents", async () => {
    const view = await render(tabs({ tabs: [], activeId: "", active: null }));
    expect(view.host.innerHTML).toBe("");
    await act(async () => view.root.unmount());
  });
});
