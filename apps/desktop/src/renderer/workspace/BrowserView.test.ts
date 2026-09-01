import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowseClearScope,
  BrowseJournalRow,
  BrowserInfo,
  BrowserSearchResult,
} from "../apiTypes";
import { BrowserView } from "./BrowserView";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  browserSetBounds: vi.fn<(x: number, y: number, width: number, height: number) => Promise<void>>(),
  browserInfo: vi.fn<() => Promise<BrowserInfo>>(),
  browserVerifyPrivate: vi.fn<() => Promise<boolean>>(),
  browserFocusApp: vi.fn<() => Promise<void>>(),
  browserJournal: vi.fn<(limit?: number) => Promise<BrowseJournalRow[]>>(),
  browserClearScope: vi.fn<() => Promise<BrowseClearScope>>(),
  browserSearch: vi.fn<(query: string) => Promise<BrowserSearchResult>>(),
  browserNavigate: vi.fn<(url: string) => Promise<string>>(),
  browserGo: vi.fn<(action: "back" | "forward" | "reload" | "stop") => Promise<void>>(),
  browserRetryProtection: vi.fn<() => Promise<void>>(),
  browserSetTakeover: vi.fn<(on: boolean) => Promise<void>>(),
  browserSavePage: vi.fn<(kind: "page" | "selection") => Promise<string>>(),
  importLink: vi.fn<(url: string) => Promise<{ name: string }>>(),
  startDownloadJob: vi.fn<(url: string, kind: string) => Promise<void>>(),
  browserNewTab: vi.fn<(url: string) => Promise<string>>(),
  browserClearJournal: vi.fn<() => Promise<void>>(),
  onBrowserJournal: vi.fn<(callback: (row: BrowseJournalRow) => void) => Promise<() => void>>(),
  onBrowserNavigated: vi.fn<(callback: (url: string) => void) => Promise<() => void>>(),
  onBrowserSearched: vi.fn<(callback: (result: BrowserSearchResult) => void) => Promise<() => void>>(),
  onBrowserBlocked: vi.fn<(callback: (value: { url: string }) => void) => Promise<() => void>>(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({
  ShieldIcon: () => null,
  LockIcon: () => null,
  AlertIcon: () => null,
}));
vi.mock("./browserSignal", () => ({ publishBrowserPage: vi.fn() }));
vi.mock("./BrowserSearch", () => ({
  BrowserSearch: ({ result, onAsk, onOpen, onOpenNewTab, onAdded }: {
    result: { query: string };
    onAsk: (query: string) => void;
    onOpen: (url: string) => void;
    onOpenNewTab: (url: string) => void;
    onAdded: (file: { id: string; name: string }) => void;
  }) => createElement("div", { className: "search-stub" },
    createElement("span", null, result.query),
    createElement("button", { onClick: () => onOpen("https://result.test") }, "open result"),
    createElement("button", { onClick: () => onOpenNewTab("https://new.test") }, "new result"),
    createElement("button", { onClick: () => onAsk(result.query) }, "ask result"),
    createElement("button", { onClick: () => onAdded({ id: "file-1", name: "result.md" }) }, "attach result"),
  ),
  BrowserSearchSkeleton: ({ query }: { query: string }) => createElement("div", { className: "search-skeleton" }, query),
}));
vi.mock("./BrowserReader", () => ({
  BrowserReader: ({ onClose, onCompare, onExtracting, onNavigate }: {
    onClose: () => void;
    onCompare: (on: boolean) => void;
    onExtracting: (on: boolean) => void;
    onNavigate: (url: string) => void;
  }) => createElement("div", { className: "reader-stub" },
    createElement("button", { onClick: onClose }, "close reader"),
    createElement("button", { onClick: () => onCompare(true) }, "compare reader"),
    createElement("button", { onClick: () => onExtracting(true) }, "borrow reader"),
    createElement("button", { onClick: () => onExtracting(false) }, "release reader"),
    createElement("button", { onClick: () => onNavigate("https://reader.test") }, "reader link"),
  ),
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function searchResult(query: string): BrowserSearchResult {
  return {
    hits: [],
    merged: 0,
    tookMs: 1,
    cached: false,
    query,
    previewsEnabled: false,
    summaryAvailable: false,
  };
}

function browserInfo(overrides: Partial<BrowserInfo> = {}): BrowserInfo {
  return {
    open: true,
    blank: false,
    url: "https://example.test/article",
    title: "Example article",
    ready: "complete",
    session: "today",
    protection: { state: "active" },
    ...overrides,
  };
}

function resetBridge() {
  for (const value of Object.values(bridge)) value.mockClear();
  bridge.browserSetBounds.mockResolvedValue(undefined);
  bridge.browserInfo.mockResolvedValue({ open: false });
  bridge.browserVerifyPrivate.mockResolvedValue(true);
  bridge.browserFocusApp.mockResolvedValue(undefined);
  bridge.browserJournal.mockResolvedValue([]);
  bridge.browserClearScope.mockResolvedValue({ journal: 0, searches: 0, pages: 0, images: 0 });
  bridge.browserSearch.mockImplementation(async (query: string) => searchResult(query));
  bridge.browserNavigate.mockImplementation(async (url: string) => url);
  bridge.browserGo.mockResolvedValue(undefined);
  bridge.browserRetryProtection.mockResolvedValue(undefined);
  bridge.browserSetTakeover.mockResolvedValue(undefined);
  bridge.browserSavePage.mockResolvedValue("Saved page.");
  bridge.importLink.mockResolvedValue({ name: "saved-link" });
  bridge.startDownloadJob.mockResolvedValue(undefined);
  bridge.browserNewTab.mockResolvedValue("new-tab");
  bridge.browserClearJournal.mockResolvedValue(undefined);
  bridge.onBrowserJournal.mockResolvedValue(() => {});
  bridge.onBrowserNavigated.mockResolvedValue(() => {});
  bridge.onBrowserSearched.mockResolvedValue(() => {});
  bridge.onBrowserBlocked.mockResolvedValue(() => {});
}

async function renderBrowser(info = browserInfo()) {
  bridge.browserInfo.mockResolvedValue(info);
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  Object.assign(window, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    ResizeObserver: ResizeObserverStub,
  });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 4, top: 8, width: 640, height: 480 }),
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(globalThis, "requestAnimationFrame", window.requestAnimationFrame);
  Reflect.set(globalThis, "cancelAnimationFrame", window.cancelAnimationFrame);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const attached = vi.fn();
  const asked = vi.fn();
  await act(async () => {
    root.render(createElement(BrowserView, { parked: false, onAttach: attached, onAsk: asked }));
  });
  return { attached, asked, host, root, window };
}

async function click(
  host: Element,
  window: Window & typeof globalThis,
  label: string,
) {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function clickAria(
  host: Element,
  window: Window & typeof globalThis,
  label: string,
) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function clickAlertDismiss(
  host: Element,
  window: Window & typeof globalThis,
) {
  const button = host.querySelector<HTMLButtonElement>('[role="alert"] button:last-child');
  if (!button) throw new Error("alert dismiss button missing");
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing from test node");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function submitAddress(
  host: Element,
  value: string,
) {
  const input = host.querySelector<HTMLInputElement>("input");
  const form = input?.closest("form");
  if (!input || !form) throw new Error("address controls missing");
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input)
      .onChange({ target: { value } });
  });
  await act(async () => {
    reactProps<{ onSubmit: (event: { preventDefault: () => void }) => void }>(form)
      .onSubmit({ preventDefault: () => {} });
  });
}

afterEach(() => {
  resetBridge();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

beforeEach(() => {
  resetBridge();
});

describe("BrowserView", () => {
  it("renders browser chrome, navigation, addressing, saves, and reader controls", async () => {
    const view = await renderBrowser(browserInfo({ url: "http://example.test", hasSelection: true }));
    expect(view.host.textContent).toContain("Not secure");
    let frames = 0;
    view.window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames += 1;
      if (frames === 1) callback(0);
      return frames;
    }) as typeof view.window.requestAnimationFrame;
    view.window.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 1 as never;
    }) as unknown as typeof view.window.setTimeout;
    await act(async () => {
      view.window.dispatchEvent(new view.window.Event("pointerdown", { bubbles: true }));
      view.window.dispatchEvent(new view.window.Event("pointerup", { bubbles: true }));
    });
    await click(view.host, view.window, "Take over");
    expect(bridge.browserSetTakeover).toHaveBeenCalledWith(true);
    await click(view.host, view.window, "Save");
    await click(view.host, view.window, "Save page");
    await click(view.host, view.window, "Save selection");
    await click(view.host, view.window, "Save link");
    await click(view.host, view.window, "Download video");
    expect(bridge.browserSavePage).toHaveBeenCalledWith("page");
    expect(bridge.startDownloadJob).toHaveBeenCalledWith("http://example.test", "media");
    await click(view.host, view.window, "Read as text");
    await click(view.host, view.window, "compare reader");
    await click(view.host, view.window, "borrow reader");
    await click(view.host, view.window, "release reader");
    await click(view.host, view.window, "close reader");
    await act(async () => view.root.unmount());
  });

  it("runs searches, result actions, error recovery, and event subscriptions", async () => {
    const view = await renderBrowser();
    await submitAddress(view.host, "search words");
    expect(view.host.textContent).toContain("search words");
    await click(view.host, view.window, "ask result");
    await click(view.host, view.window, "attach result");
    await click(view.host, view.window, "open result");
    expect(bridge.browserNavigate).toHaveBeenCalledWith("https://result.test");
    const searched = bridge.onBrowserSearched.mock.calls[0]?.[0] as (result: ReturnType<typeof searchResult>) => void;
    await act(async () => searched(searchResult("agent query")));
    await click(view.host, view.window, "new result");
    expect(bridge.browserNewTab).toHaveBeenCalledWith("https://new.test");
    const blocked = bridge.onBrowserBlocked.mock.calls[0]?.[0] as (value: { url: string }) => void;
    await act(async () => blocked({ url: "http://127.0.0.1" }));
    expect(view.host.textContent).toContain("private network");
    await click(view.host, view.window, "Dismiss");
    await act(async () => view.root.unmount());
  });

  it("shows, filters, and clears the journal without hiding read failures", async () => {
    bridge.browserJournal.mockResolvedValue([
      { id: 1, at: "not a date", kind: "search", url: "https://example.test", detail: "searched", session: "today" },
      { id: 2, at: "2026-08-30T12:00:00Z", kind: "read", url: "https://old.test", detail: "read", session: "older" },
    ]);
    bridge.browserClearScope.mockResolvedValue({ journal: 2, searches: 1, pages: 1, images: 1 });
    const view = await renderBrowser();
    const journal = [...view.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("activity journal"));
    if (!journal) throw new Error("journal button missing");
    await act(async () => journal.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    expect(view.host.textContent).toContain("What happened here");
    const journalChanged = bridge.onBrowserJournal.mock.calls.at(-1)?.[0] as () => void;
    await act(async () => journalChanged());
    await click(view.host, view.window, "Agent");
    await click(view.host, view.window, "Agent");
    await click(view.host, view.window, "Protection");
    expect(view.host.textContent).toContain("Nothing in this sitting matches those filters.");
    await click(view.host, view.window, "Protection");
    await click(view.host, view.window, "Show 1 earlier sitting");
    await click(view.host, view.window, "Clear");
    expect(view.host.textContent).toContain("Erase");
    await click(view.host, view.window, "Keep");
    await click(view.host, view.window, "Clear");
    await click(view.host, view.window, "Erase");
    expect(bridge.browserClearJournal).toHaveBeenCalledTimes(1);
    await click(view.host, view.window, "Save");
    const saveRow = view.host.querySelector(".browser-save-row");
    if (!saveRow) throw new Error("save row missing");
    await act(async () => {
      reactProps<{ onKeyDown: (event: { key: string }) => void }>(saveRow)
        .onKeyDown({ key: "Escape" });
    });
    await act(async () => view.root.unmount());
  });

  it("recovers from poll loss and bridge failures without retaining stale page claims", async () => {
    const view = await renderBrowser(browserInfo({ leaveRequested: true }));
    expect(bridge.browserFocusApp).toHaveBeenCalledTimes(1);
    const navigated = bridge.onBrowserNavigated.mock.calls[0]?.[0] as () => void;
    bridge.browserInfo.mockRejectedValue(new Error("browser stopped"));
    await act(async () => navigated());
    await act(async () => navigated());
    expect(view.host.textContent).toContain("Private browser");
    await act(async () => view.root.unmount());

    const failed = await renderBrowser({ open: false });
    expect(failed.host.textContent).toContain("Private browser");
    bridge.browserInfo.mockRejectedValue(new Error("first poll failed"));
    const failedNavigate = bridge.onBrowserNavigated.mock.calls.at(-1)?.[0] as () => void;
    await act(async () => failedNavigate());
    await act(async () => failed.root.unmount());
  });

  it("renders browser bridge error states and recovery controls", async () => {
    bridge.browserVerifyPrivate.mockRejectedValue(new Error("privacy check failed"));
    const view = await renderBrowser(browserInfo({ protection: { state: "failed", reason: "rules" } }));
    expect(view.host.textContent).toContain("Tracker blocking is OFF");
    await click(view.host, view.window, "Retry");
    expect(bridge.browserRetryProtection).toHaveBeenCalledTimes(1);
    bridge.browserRetryProtection.mockRejectedValueOnce(new Error("retry failed"));
    await click(view.host, view.window, "Retry");
    expect(view.host.textContent).toContain("retry failed");
    await clickAria(view.host, view.window, "Go back");
    bridge.browserGo.mockRejectedValueOnce(new Error("go failed"));
    await clickAria(view.host, view.window, "Go forward");
    expect(view.host.textContent).toContain("go failed");
    bridge.browserSetTakeover.mockRejectedValueOnce(new Error("takeover failed"));
    await click(view.host, view.window, "Take over");
    expect(view.host.textContent).toContain("takeover failed");
    await click(view.host, view.window, "Save");
    bridge.browserSavePage.mockRejectedValueOnce(new Error("save failed"));
    await click(view.host, view.window, "Save page");
    expect(view.host.textContent).toContain("save failed");
    bridge.browserSearch.mockRejectedValueOnce(new Error("search failed"));
    await submitAddress(view.host, "failing search");
    expect(view.host.textContent).toContain("search failed");
    await clickAlertDismiss(view.host, view.window);
    await act(async () => view.root.unmount());
  });

  it("keeps search and journal error states actionable", async () => {
    bridge.browserJournal.mockRejectedValue(new Error("journal failed"));
    const view = await renderBrowser(browserInfo({ url: "https://example.test/file.pdf" }));
    const journal = [...view.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("activity journal"));
    if (!journal) throw new Error("journal button missing");
    await act(async () => journal.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    expect(view.host.textContent).toContain("journal failed");
    await click(view.host, view.window, "Retry");
    await act(async () => journal.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    bridge.browserNavigate.mockRejectedValueOnce(new Error("result failed"));
    const searched = bridge.onBrowserSearched.mock.calls[0]?.[0] as (result: ReturnType<typeof searchResult>) => void;
    await act(async () => searched(searchResult("again")));
    await click(view.host, view.window, "open result");
    expect(view.host.textContent).toContain("result failed");
    bridge.browserNewTab.mockRejectedValueOnce(new Error("tab failed"));
    await click(view.host, view.window, "new result");
    expect(view.host.textContent).toContain("tab failed");
    await click(view.host, view.window, "Page ▸");
    await click(view.host, view.window, "Save");
    await click(view.host, view.window, "Save link");
    expect(bridge.importLink).toHaveBeenCalledWith("https://example.test/file.pdf");
    await act(async () => view.root.unmount());
  });

  it("handles address navigation, result return, stalled pages, and destructive errors", async () => {
    const view = await renderBrowser(browserInfo({ error: "timeout" }));
    expect(view.host.textContent).toContain("stopped answering");
    await submitAddress(view.host, "example.org/path");
    expect(bridge.browserNavigate).toHaveBeenCalledWith("https://example.org/path");
    bridge.browserNavigate.mockRejectedValueOnce(new Error("address failed"));
    await submitAddress(view.host, "private-host.local");
    expect(view.host.textContent).toContain("address failed");
    await click(view.host, view.window, "Search the web for “private-host.local” instead");
    const searched = bridge.onBrowserSearched.mock.calls.at(-1)?.[0] as (result: ReturnType<typeof searchResult>) => void;
    await act(async () => searched(searchResult("returnable")));
    await click(view.host, view.window, "open result");
    await click(view.host, view.window, "◂ Results");
    await clickAria(view.host, view.window, "Go back");
    await act(async () => view.root.unmount());

    bridge.browserClearJournal.mockRejectedValue(new Error("clear failed"));
    bridge.browserClearScope.mockResolvedValue({ journal: 1, searches: 0, pages: 0, images: 0 });
    const destructive = await renderBrowser(browserInfo({ takeover: true, url: "not a valid url" }));
    expect(destructive.host.textContent).toContain("Hand back to the agent");
    const journal = [...destructive.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("activity journal"));
    if (!journal) throw new Error("journal button missing");
    await act(async () => journal.dispatchEvent(new destructive.window.Event("click", { bubbles: true })));
    bridge.browserClearScope.mockRejectedValue(new Error("scope failed"));
    await click(destructive.host, destructive.window, "Clear");
    await click(destructive.host, destructive.window, "Erase");
    expect(destructive.host.textContent).toContain("clear failed");
    await act(async () => destructive.root.unmount());
  });
});
