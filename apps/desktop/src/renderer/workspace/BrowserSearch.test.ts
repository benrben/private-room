import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSearchResult,
  FileMeta,
  ResultPreview,
  WebHit,
} from "../apiTypes";

const bridge = vi.hoisted(() => ({
  browserPreview: vi.fn<(urls: string[]) => Promise<ResultPreview[]>>(),
  importSearchResult:
    vi.fn<(url: string, title: string) => Promise<FileMeta>>(),
  browserPeek: vi.fn<(url: string) => Promise<string>>(),
  browserSearchSummary: vi.fn<(query: string) => Promise<string>>(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({
  GlobeIcon: () => null,
  PlusIcon: () => null,
  CheckIcon: () => null,
  EyeIcon: () => null,
  LinkIcon: () => null,
  SparklesIcon: () => null,
}));

import {
  BrowserSearch,
  BrowserSearchSkeleton,
  searchPrivacyLine,
} from "./BrowserSearch";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function hit(overrides: Partial<WebHit> = {}): WebHit {
  return {
    title: "Example result",
    url: "https://example.test/guide/getting-started",
    engines: ["brave", "mojeek"],
    date: "2026-08-31",
    snippet: "Search engine description",
    score: 0.8,
    ...overrides,
  };
}

function result(
  overrides: Partial<BrowserSearchResult> = {},
): BrowserSearchResult {
  return {
    hits: [
      hit(),
      hit({
        title: "Second result",
        url: "https://second.test/article",
        engines: ["duckduckgo"],
        score: 0.6,
      }),
      hit({
        title: "Third result",
        url: "https://third.test/news/today",
        engines: ["news"],
        score: 0.4,
      }),
      hit({
        title: "Fourth result",
        url: "https://fourth.test/row",
        engines: ["wikipedia"],
        score: 0.2,
      }),
    ],
    merged: 8,
    tookMs: 1200,
    cached: false,
    failed: ["duckduckgo_ia"],
    query: "private web search",
    previewsEnabled: true,
    summaryAvailable: true,
    ...overrides,
  };
}

function resetBridge() {
  bridge.browserPreview.mockReset().mockResolvedValue([]);
  bridge.importSearchResult.mockReset().mockResolvedValue({
    id: "file-1",
    name: "example.md",
    mimeType: "text/markdown",
    sizeBytes: 1,
    source: "web",
    hasText: true,
    createdAt: "2026-08-31T00:00:00Z",
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
  });
  bridge.browserPeek.mockReset().mockResolvedValue("Reader text");
  bridge.browserSearchSummary.mockReset().mockResolvedValue("Summary [2]");
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

type SearchProps = React.ComponentProps<typeof BrowserSearch>;

async function renderSearch(overrides: Partial<SearchProps> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const scrollIntoView = vi.fn();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => null,
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const props: SearchProps = {
    result: result(),
    onOpen: vi.fn(),
    onOpenNewTab: vi.fn(),
    onAsk: vi.fn(),
    onAdded: vi.fn(),
    ...overrides,
  };
  const update = async (next: Partial<SearchProps>) => {
    Object.assign(props, next);
    await act(async () => {
      root.render(createElement(BrowserSearch, props));
    });
    await flush();
  };
  await update({});
  return { host, props, root, scrollIntoView, update, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(
      new window.Event("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

function button(host: Element, label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function ariaButton(host: Element, label: string) {
  const found = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function key(
  node: Element,
  event: Partial<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    target: EventTarget;
  }>,
) {
  const preventDefault = vi.fn();
  await act(async () => {
    reactProps<{
      onKeyDown: (value: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        target: EventTarget;
        preventDefault: () => void;
      }) => void;
    }>(node).onKeyDown({
      key: event.key ?? "",
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      target: event.target ?? node,
      preventDefault,
    });
  });
  await flush();
  return preventDefault;
}

beforeEach(() => {
  resetBridge();
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("BrowserSearch", () => {
  it("keeps all privacy claims accurate", () => {
    expect(
      searchPrivacyLine({
        cached: false,
        previewsEnabled: true,
        previewCount: 1,
      }),
    ).toMatchObject({
      text: "your query, and a request to the top 1 result page, left this Mac",
    });
    expect(
      searchPrivacyLine({
        cached: true,
        previewsEnabled: true,
        previewCount: 3,
      }),
    ).toMatchObject({
      text: "no query left this Mac — the top 3 result pages were asked for a preview",
    });
    expect(
      searchPrivacyLine({
        cached: true,
        previewsEnabled: false,
        previewCount: 8,
      }),
    ).toMatchObject({ text: "nothing left this Mac" });
    expect(
      searchPrivacyLine({
        cached: false,
        previewsEnabled: true,
        previewCount: 0,
      }),
    ).toMatchObject({ text: "only your query left this Mac" });
  });

  it("shows progress while search results are still loading", async () => {
    vi.useFakeTimers();
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    const document = parsed.document as unknown as Document;
    const window = parsed.window as unknown as Window & typeof globalThis;
    Reflect.set(globalThis, "window", window);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const { createRoot } = await import("react-dom/client");
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(BrowserSearchSkeleton, { query: "loading" }));
    });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(host.textContent).toContain("1s");
    await act(async () => root.unmount());
  });

  it("preserves result actions, keyboard shortcuts, previews, summaries, and citation selection", async () => {
    bridge.browserPreview.mockResolvedValue([
      {
        url: "https://example.test/guide/getting-started",
        image: "data:image/png;base64,AAAA",
        icon: "data:image/png;base64,BBBB",
        description: "First-party description",
        done: true,
      },
    ]);
    bridge.browserSearchSummary.mockResolvedValue(
      "Grounded [2] but [99] is plain text.",
    );
    const view = await renderSearch();
    expect(bridge.browserPreview).toHaveBeenCalledWith([
      "https://example.test/guide/getting-started",
      "https://second.test/article",
      "https://third.test/news/today",
      "https://fourth.test/row",
    ]);
    expect(view.host.querySelectorAll(".bsearch-card")).toHaveLength(4);
    expect(view.host.textContent).toContain("First-party description");
    expect(
      view.host.querySelector(".bsearch-img img")?.getAttribute("src"),
    ).toContain("AAAA");

    await click(button(view.host, "Ask the assistant"), view.window);
    expect(view.props.onAsk).toHaveBeenCalledWith("private web search");
    const firstCard = view.host.querySelector<HTMLElement>("[data-idx='0']");
    if (!firstCard) throw new Error("first card missing");
    await click(firstCard, view.window);
    expect(view.props.onOpen).toHaveBeenCalledWith(
      "https://example.test/guide/getting-started",
    );
    await click(ariaButton(view.host, "Open in a new tab"), view.window);
    expect(view.props.onOpenNewTab).toHaveBeenCalledWith(
      "https://example.test/guide/getting-started",
    );

    await click(
      ariaButton(view.host, "Peek — read a preview without opening"),
      view.window,
    );
    expect(bridge.browserPeek).toHaveBeenCalledWith(
      "https://example.test/guide/getting-started",
    );
    expect(view.host.textContent).toContain("Reader text");
    await click(
      ariaButton(view.host, "Peek — read a preview without opening"),
      view.window,
    );
    expect(view.host.textContent).not.toContain("Reader text");
    await click(
      ariaButton(view.host, "Add to the chat as a source"),
      view.window,
    );
    expect(bridge.importSearchResult).toHaveBeenCalledWith(
      "https://example.test/guide/getting-started",
      "Example result",
    );
    expect(view.props.onAdded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "file-1" }),
    );
    await click(
      ariaButton(view.host, "Add to the chat as a source"),
      view.window,
    );
    expect(bridge.importSearchResult).toHaveBeenCalledOnce();

    const list = view.host.querySelector<HTMLElement>(".bsearch[tabindex='0']");
    if (!list) throw new Error("search list missing");
    expect(await key(list, { key: "ArrowDown" })).toHaveBeenCalledOnce();
    expect(
      await key(list, { key: "Enter", ctrlKey: true }),
    ).toHaveBeenCalledOnce();
    expect(view.props.onOpenNewTab).toHaveBeenCalledWith(
      "https://second.test/article",
    );
    expect(await key(list, { key: "Enter" })).toHaveBeenCalledOnce();
    expect(view.props.onOpen).toHaveBeenCalledWith(
      "https://second.test/article",
    );
    expect(await key(list, { key: "p" })).toHaveBeenCalledOnce();
    expect(bridge.browserPeek).toHaveBeenCalledWith(
      "https://second.test/article",
    );
    expect(await key(list, { key: "a" })).toHaveBeenCalledOnce();
    expect(bridge.importSearchResult).toHaveBeenCalledWith(
      "https://second.test/article",
      "Second result",
    );
    expect(await key(list, { key: "x" })).not.toHaveBeenCalled();
    const protectedButton = ariaButton(
      view.host,
      "Peek — read a preview without opening",
    );
    await key(list, { key: "Enter", target: protectedButton });
    expect(view.props.onOpen).toHaveBeenCalledTimes(2);

    Object.defineProperty(view.window, "getSelection", {
      configurable: true,
      value: () => ({
        isCollapsed: false,
        toString: () => "selected text",
        anchorNode: firstCard,
      }),
    });
    await click(firstCard, view.window);
    expect(view.props.onOpen).toHaveBeenCalledTimes(2);
    Object.defineProperty(view.window, "getSelection", {
      configurable: true,
      value: () => null,
    });

    await click(button(view.host, "Summarize these results"), view.window);
    expect(view.host.textContent).toContain("Grounded");
    const citation =
      view.host.querySelector<HTMLButtonElement>(".bsearch-cite");
    if (!citation) throw new Error("citation missing");
    await click(citation, view.window);
    expect(view.host.querySelector("[data-idx='1']")?.className).toContain(
      "sel",
    );
    expect(view.scrollIntoView).toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("keeps decorations soft while named action failures stay visible", async () => {
    bridge.browserPreview.mockRejectedValue(new Error("preview unavailable"));
    bridge.browserPeek.mockRejectedValue(new Error("reader unavailable"));
    bridge.importSearchResult.mockRejectedValue(new Error("room is read-only"));
    bridge.browserSearchSummary.mockRejectedValue(
      new Error("summary unavailable"),
    );
    const view = await renderSearch({
      result: result({ hits: [hit({ url: "not a url", snippet: null })] }),
    });
    expect(view.host.querySelector(".bsearch-mono")?.textContent).toBe("N");
    await click(
      ariaButton(view.host, "Peek — read a preview without opening"),
      view.window,
    );
    expect(view.host.textContent).toContain("Could not read that page");
    await click(
      ariaButton(view.host, "Add to the chat as a source"),
      view.window,
    );
    expect(view.host.querySelector("[role='alert']")?.textContent).toContain(
      "room is read-only",
    );
    await click(button(view.host, "Dismiss"), view.window);
    expect(view.host.querySelector("[role='alert']")).toBeNull();
    await click(button(view.host, "Summarize these results"), view.window);
    expect(view.host.textContent).toContain("summary unavailable");
    await act(async () => view.root.unmount());
  });

  it("separates no matches from a failed search", async () => {
    const allFailed = await renderSearch({
      result: result({ hits: [], failed: ["a", "b", "c", "d", "e", "f", "g"] }),
    });
    expect(allFailed.host.textContent).toContain("The search couldn't run");
    await act(async () => allFailed.root.unmount());

    const partial = await renderSearch({
      result: result({ hits: [], failed: ["google_news"], cached: true }),
    });
    expect(partial.host.textContent).toContain(
      "No results across seven engines",
    );
    expect(partial.host.textContent).toContain("news");
    expect(partial.host.textContent).toContain("Recent results from this Mac");
    await act(async () => partial.root.unmount());
  });

  it("leaves external typing alone while returning focus inside the browser area", async () => {
    const view = await renderSearch();
    const editor = view.window.document.createElement("input");
    view.window.document.body.append(editor);
    let active: Element = editor;
    Object.defineProperty(view.window.document, "activeElement", {
      configurable: true,
      get: () => active,
    });
    const list = view.host.querySelector<HTMLElement>(".bsearch[tabindex='0']");
    if (!list) throw new Error("search list missing");
    const focus = vi.fn();
    Object.defineProperty(list, "focus", { configurable: true, value: focus });
    await view.update({ result: result({ hits: [...result().hits] }) });
    expect(focus).not.toHaveBeenCalled();

    const area = view.window.document.createElement("div");
    area.className = "browser-area";
    view.window.document.body.append(area);
    area.append(view.host);
    const insideEditor = view.window.document.createElement("textarea");
    area.append(insideEditor);
    active = insideEditor;
    await view.update({ result: result({ hits: [...result().hits] }) });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await act(async () => view.root.unmount());
  });
});
