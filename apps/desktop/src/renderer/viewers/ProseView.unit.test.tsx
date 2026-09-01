import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const highlights = vi.hoisted(() => ({
  apply: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("./highlight", () => ({
  applyQuoteHighlight: highlights.apply,
  clearQuoteHighlight: highlights.clear,
}));

import ProseView, { useReadingProgress } from "./ProseView";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "ResizeObserver",
  "getComputedStyle",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type ResizeCallback = () => void;
const observers: Array<{ callback: ResizeCallback; observed: Element[]; disconnected: boolean }> = [];

class FakeResizeObserver {
  private record: { callback: ResizeCallback; observed: Element[]; disconnected: boolean };

  constructor(callback: ResizeCallback) {
    this.record = { callback, observed: [], disconnected: false };
    observers.push(this.record);
  }

  observe(element: Element) {
    this.record.observed.push(element);
  }

  disconnect() {
    this.record.disconnected = true;
  }
}

function dimensions(element: Element, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

async function render(text: string, quote?: string, scrollable = true) {
  const parsed = parseHTML("<html><body><div id='scroller'><div id='root'></div></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const scroller = document.getElementById("scroller");
  if (!scroller) throw new Error("scroller missing");
  dimensions(scroller, 1_000, 400, 150);
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, ResizeObserver: FakeResizeObserver,
    getComputedStyle: (element: Element) => ({ overflowY: element === scroller && scrollable ? "auto" : "visible" }),
    React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(ProseView, { text, quote })));
  return { host, root, scroller };
}

function progress(host: Element) {
  return host.querySelector<HTMLElement>(".rdr-progress");
}

function EmptyReadingProgressProbe() {
  const ref = React.useRef<HTMLElement | null>(null);
  const read = useReadingProgress(ref);
  return <output>{read === null ? "none" : String(read)}</output>;
}

async function renderEmptyReadingProgress() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, ResizeObserver: FakeResizeObserver,
    getComputedStyle: () => ({ overflowY: "visible" }), React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(EmptyReadingProgressProbe)));
  return { host, root };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

beforeEach(() => {
  observers.splice(0);
  highlights.apply.mockReset();
  highlights.clear.mockReset();
});

describe("ProseView with fabricated scroll and resize APIs", () => {
  it("measures real scroll progress, clamps overscroll, and keeps quote cleanup paired", async () => {
    const view = await render("First soft line\ncontinues\n\nSecond paragraph", "fake quote");
    const prose = view.host.querySelector(".prose-view");
    if (!prose) throw new Error("prose root missing");

    expect(view.host.querySelectorAll("p")).toHaveLength(2);
    expect(view.host.querySelector("p")?.textContent).toBe("First soft line\ncontinues");
    expect(view.host.querySelector("p")?.getAttribute("dir")).toBe("auto");
    expect(progress(view.host)?.getAttribute("style")).toContain("25%");
    expect(highlights.apply).toHaveBeenCalledWith(prose, "fake quote");
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toEqual([view.scroller, prose]);

    view.scroller.scrollTop = 900;
    await act(async () => view.scroller.dispatchEvent(new Event("scroll")));
    expect(progress(view.host)?.getAttribute("style")).toContain("100%");
    view.scroller.scrollTop = -50;
    await act(async () => view.scroller.dispatchEvent(new Event("scroll")));
    expect(progress(view.host)?.getAttribute("style")).toContain("0%");

    dimensions(view.scroller, 401, 400, 0);
    await act(async () => observers[0]!.callback());
    expect(progress(view.host)).toBeNull();
    await act(async () => view.root.unmount());
    expect(observers[0]!.disconnected).toBe(true);
    expect(highlights.clear).toHaveBeenCalledOnce();
  });

  it("does not manufacture a progress mark or highlight when there is no eligible scroller or quote", async () => {
    const view = await render("A short fake note", undefined, false);
    expect(progress(view.host)).toBeNull();
    expect(highlights.apply).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
    await act(async () => view.root.unmount());
    expect(highlights.clear).not.toHaveBeenCalled();

    const emptyRef = await renderEmptyReadingProgress();
    expect(emptyRef.host.textContent).toBe("none");
    await act(async () => emptyRef.root.unmount());
  });
});
