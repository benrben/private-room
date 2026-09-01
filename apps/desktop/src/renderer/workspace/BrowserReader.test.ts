import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserInfo, BrowserPageText } from "../apiTypes";
import { BrowserReader } from "./BrowserReader";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({ browserPageText: vi.fn() }));
const readerState = vi.hoisted(() => ({ progress: 27 as number | null }));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../viewers/ProseView", () => ({
  useReadingProgress: () => readerState.progress,
}));

const info: BrowserInfo = {
  open: true,
  url: "https://reader.example.test/story",
  title: "Browser title",
};

const initialPage: BrowserPageText = {
  text: "[private link](https://private.example.test/next) and [empty]()",
  title: " Reader title ",
  url: "https://reader.example.test/story",
  nextOffset: 5,
  total: 30,
  truncated: true,
};

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLAnchorElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function resetBridge() {
  bridge.browserPageText.mockReset();
  bridge.browserPageText.mockResolvedValue(initialPage);
  readerState.progress = 27;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

type ReaderProps = {
  info: BrowserInfo;
  comparing: boolean;
  onCompare: ReturnType<typeof vi.fn>;
  onExtracting: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
};

function defaultProps(): ReaderProps {
  return {
    info,
    comparing: false,
    onCompare: vi.fn(),
    onExtracting: vi.fn(),
    onNavigate: vi.fn(),
    onClose: vi.fn(),
  };
}

async function renderReader(overrides: Partial<ReaderProps> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLAnchorElement", window.HTMLAnchorElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let props = { ...defaultProps(), ...overrides };
  const update = async (next: Partial<ReaderProps>) => {
    props = { ...props, ...next };
    await act(async () => {
      root.render(createElement(BrowserReader, props));
    });
    await flush();
  };
  await update({});
  return { host, root, window, props, update };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

function button(host: Element, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDown(node: Element, key: string, stopPropagation = vi.fn()) {
  await act(async () => {
    reactProps<{ onKeyDown: (event: { key: string; stopPropagation: () => void }) => void }>(node)
      .onKeyDown({ key, stopPropagation });
  });
  return stopPropagation;
}

beforeEach(() => {
  resetBridge();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("BrowserReader", () => {
  it("reads, expands, and controls a secure page without leaving the private browser", async () => {
    bridge.browserPageText
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce({ ...initialPage, text: "full page", truncated: true, nextOffset: 7 })
      .mockResolvedValueOnce({ ...initialPage, text: "re-read page", truncated: true, nextOffset: 8 })
      .mockResolvedValueOnce({ ...initialPage, text: "continued", truncated: false, nextOffset: 30 });
    const view = await renderReader();
    expect(view.host.textContent).toContain("Reader title");
    expect(view.host.textContent).toContain("reader.example.test");
    expect(view.host.textContent).toContain("Encrypted connection");
    expect(view.host.querySelector(".rdr-progress")).not.toBeNull();
    expect(view.host.textContent).toContain("Showing the first");
    expect(view.props.onExtracting).toHaveBeenCalledWith(true);
    expect(view.props.onExtracting).toHaveBeenCalledWith(false);

    const reader = view.host.querySelector<HTMLElement>("section.browser-reader");
    if (!reader) throw new Error("reader section missing");
    const unstopped = await keyDown(reader, "ArrowDown");
    expect(unstopped).not.toHaveBeenCalled();
    const stopped = await keyDown(reader, "Escape");
    expect(stopped).toHaveBeenCalledOnce();
    expect(view.props.onClose).toHaveBeenCalledOnce();

    const link = view.host.querySelector<HTMLAnchorElement>('a[href="https://private.example.test/next"]');
    if (!link) throw new Error("reader link missing");
    await click(link, view.window);
    expect(view.props.onNavigate).toHaveBeenCalledWith("https://private.example.test/next");
    expect(view.host.textContent).toContain("empty");

    await click(button(view.host, "Navigation, headers and footers"), view.window);
    expect(bridge.browserPageText).toHaveBeenNthCalledWith(2, "full", 0);
    expect(button(view.host, "Navigation, headers and footers").getAttribute("aria-pressed")).toBe("true");
    await click(button(view.host, "Re-read the page"), view.window);
    expect(bridge.browserPageText).toHaveBeenNthCalledWith(3, "full", 0);
    await click(button(view.host, "Read the next part"), view.window);
    expect(bridge.browserPageText).toHaveBeenNthCalledWith(4, "full", 8);
    expect(view.host.textContent).toContain("continued");
    expect(view.host.textContent).not.toContain("Read the next part");

    await click(button(view.host, "Compare with page"), view.window);
    expect(view.props.onCompare).toHaveBeenCalledWith(true);
    await click(button(view.host, "Close the reading view"), view.window);
    expect(view.props.onClose).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("describes loading, empty and failed page reads truthfully", async () => {
    let resolveInitial: ((page: BrowserPageText) => void) | undefined;
    bridge.browserPageText.mockImplementationOnce(() => new Promise<BrowserPageText>((resolve) => {
      resolveInitial = resolve;
    }));
    readerState.progress = null;
    const view = await renderReader({
      info: { ...info, url: "http://plain.example.test/page", title: "Fallback title" },
      comparing: true,
    });
    expect(view.host.textContent).toContain("Reading the page…");
    expect(view.host.textContent).toContain("Not encrypted");
    expect(view.host.textContent).toContain("The live page is beside it");
    expect(view.host.querySelector(".rdr-progress")).toBeNull();
    expect(button(view.host, "Re-read the page").hasAttribute("disabled")).toBe(true);
    resolveInitial?.({ text: "", title: "", url: "not a URL", truncated: false });
    await flush();
    expect(view.host.textContent).toContain("Fallback title");
    expect(view.host.textContent).toContain("This page returned no text");
    expect(view.host.querySelector(".sep")).toBeNull();

    bridge.browserPageText.mockRejectedValueOnce(new Error("reader refused"));
    await click(button(view.host, "Re-read the page"), view.window);
    expect(view.host.textContent).toContain("Error: reader refused");
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => view.root.unmount());
  });

  it("keeps only the newest extraction when the page changes and reports a current more failure", async () => {
    let resolveMore: ((page: BrowserPageText) => void) | undefined;
    let resolveNew: ((page: BrowserPageText) => void) | undefined;
    bridge.browserPageText
      .mockResolvedValueOnce({ ...initialPage, text: "old text", url: "https://old.example.test" })
      .mockImplementationOnce(() => new Promise<BrowserPageText>((resolve) => {
        resolveMore = resolve;
      }))
      .mockImplementationOnce(() => new Promise<BrowserPageText>((resolve) => {
        resolveNew = resolve;
      }))
      .mockRejectedValueOnce(new Error("next part refused"));
    const view = await renderReader();
    await click(button(view.host, "Read the next part"), view.window);
    await view.update({ info: { ...info, url: "https://new.example.test", title: "New browser title" } });
    expect(view.host.textContent).toContain("This text was taken from https://old.example.test");
    resolveNew?.({
      ...initialPage,
      text: "new text",
      url: "https://new.example.test",
      title: "New title",
      truncated: true,
      nextOffset: 12,
    });
    await flush();
    expect(view.host.textContent).toContain("new text");
    resolveMore?.({ ...initialPage, text: "incorrect old continuation", truncated: false });
    await flush();
    expect(view.host.textContent).not.toContain("incorrect old continuation");

    await click(button(view.host, "Read the next part"), view.window);
    expect(view.host.textContent).toContain("Error: next part refused");
    expect(view.host.textContent).toContain("Read the next part");
    await act(async () => view.root.unmount());
  });
});
