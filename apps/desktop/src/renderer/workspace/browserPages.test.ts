import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTab } from "../api";
import { api } from "../api";
import {
  NEW_PAGE_TITLE,
  activePageToReassert,
  heirAfterClose,
  pageAccessibleName,
  pageHost,
  pageLabel,
  pageSubtitle,
  pageToReassert,
  reconcilePages,
  selectionAfterSync,
  syncedBrowserPages,
  type BrowserPage,
  useBrowserPages,
} from "./browserPages";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let hook: ReturnType<typeof useBrowserPages> | null = null;
const hookError = vi.fn();

function BrowserPagesProbe({ webOn = true, active = true }: { webOn?: boolean; active?: boolean }) {
  hook = useBrowserPages(webOn, active, hookError);
  return null;
}

function installDom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", window.document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  return window.document;
}

async function flush() {
  await act(async () => {
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
}

afterEach(() => {
  hook = null;
  hookError.mockReset();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function page(id: string, overrides: Partial<BrowserPage> = {}): BrowserPage {
  return { id, title: "", url: "", ...overrides };
}

function live(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return { id, title: "", url: "", active: false, ...overrides };
}

describe("browser page state", () => {
  it("derives truthful host, title, subtitle, and accessible labels", () => {
    expect(pageHost("https://www.example.test/path")).toBe("example.test");
    expect(pageHost("not a URL")).toBe("");
    expect(pageLabel(page("a", { title: "  Report  ", url: "https://example.test" }))).toBe("Report");
    expect(pageLabel(page("a", { url: "https://www.example.test" }))).toBe("example.test");
    expect(pageLabel(page("a"))).toBe(NEW_PAGE_TITLE);
    expect(pageSubtitle(page("a", { title: "example.test", url: "https://example.test" }))).toBe("");
    expect(pageSubtitle(page("a", { title: "Report", url: "https://example.test" }))).toBe("example.test");
    expect(pageAccessibleName(page("a", { title: "Report", url: "https://example.test" }))).toBe("Report — example.test");
    expect(pageAccessibleName(page("a", { title: "EXAMPLE.TEST", url: "https://example.test" }))).toBe("EXAMPLE.TEST");
  });

  it("selects the browser-standard successor when closing the active page", () => {
    const pages = [page("a"), page("b"), page("c")];
    expect(heirAfterClose(pages, "b", "b")).toBe("c");
    expect(heirAfterClose(pages, "c", "c")).toBe("b");
    expect(heirAfterClose(pages, "a", "b")).toBe("b");
    expect(heirAfterClose([page("a")], "a", "a")).toBe("");
    expect(heirAfterClose(pages, "gone", "gone")).toBe("gone");
  });

  it("reconciles host tabs without losing ordering, identity, or title changes", () => {
    const unchanged = [page("a", { title: "One", url: "https://one.test" })];
    expect(reconcilePages(unchanged, [live("a", { title: "One", url: "https://one.test" })])).toBe(unchanged);

    const previous = [page("a", { title: "Old", url: "https://one.test" }), page("b")];
    expect(reconcilePages(previous, [live("a", { title: "New", url: "https://new.test" }), live("c", { title: "Three", url: "https://three.test" })])).toEqual([
      page("a", { title: "New", url: "https://new.test" }),
      page("c", { title: "Three", url: "https://three.test" }),
    ]);
  });

  it("keeps a surviving selection and chooses a truthful replacement when it is gone", () => {
    const pages = [page("a"), page("b")];
    expect(selectionAfterSync(pages, "b")).toBe("b");
    expect(selectionAfterSync(pages, "gone")).toBe("a");
    expect(selectionAfterSync([], "gone")).toBe("");

    expect(syncedBrowserPages(pages, "b", [live("a")])).toEqual({ pages: [page("a")], activeId: "a" });
    expect(syncedBrowserPages(pages, "a", [live("a"), live("b")])).toEqual({ pages, activeId: "a" });
  });

  it("only reasserts an existing selected page when the host shows another one", () => {
    expect(pageToReassert([live("a", { active: true }), live("b")], "a")).toBe("");
    expect(pageToReassert([live("a", { active: true }), live("b")], "b")).toBe("b");
    expect(pageToReassert([live("a", { active: true })], "gone")).toBe("");
    expect(pageToReassert([live("a", { active: true })], "")).toBe("");
    expect(activePageToReassert(false, [live("a")], "a")).toBe("");
    expect(activePageToReassert(true, [live("a")], "a")).toBe("a");
  });

  it("reconciles an active browser hook and reasserts the selected page without a browser runtime", async () => {
    const document = installDom();
    const browserTabs = vi.spyOn(api, "browserTabs").mockResolvedValue([
      live("a", { title: "Alpha", url: "https://alpha.test" }),
      live("b", { title: "Beta", url: "https://beta.test", active: true }),
    ]);
    const select = vi.spyOn(api, "browserSelectTab").mockResolvedValue();
    const create = vi.spyOn(api, "browserNewTab").mockResolvedValue("c");
    const close = vi.spyOn(api, "browserCloseTab").mockResolvedValue();
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);

    await act(async () => root.render(createElement(BrowserPagesProbe)));
    await flush();

    expect(browserTabs).toHaveBeenCalledTimes(1);
    expect(hook?.pages).toEqual([
      page("a", { title: "Alpha", url: "https://alpha.test" }),
      page("b", { title: "Beta", url: "https://beta.test" }),
    ]);
    expect(hook?.activeId).toBe("a");
    expect(select).toHaveBeenCalledWith("a");

    create.mockRejectedValueOnce(new Error("fabricated tab creation failure"));
    await act(async () => hook?.open("https://failed.test"));
    expect(hookError).toHaveBeenCalledWith("Error: fabricated tab creation failure");

    await act(async () => hook?.open("https://created.test"));
    expect(create).toHaveBeenCalledWith("https://created.test");
    expect(hook?.pages.at(-1)).toEqual(page("c", { title: NEW_PAGE_TITLE, url: "https://created.test" }));
    expect(hook?.activeId).toBe("c");

    await act(async () => hook?.select("b"));
    expect(select).toHaveBeenCalledWith("b");
    expect(hook?.activeId).toBe("b");

    await act(async () => hook?.move(0, 2));
    expect(hook?.pages.map(({ id }) => id)).toEqual(["b", "c", "a"]);
    await act(async () => hook?.move(-1, 1));
    await act(async () => hook?.move(0, 9));
    expect(hook?.pages.map(({ id }) => id)).toEqual(["b", "c", "a"]);

    await act(async () => hook?.close("b"));
    expect(close).toHaveBeenCalledWith("b");
    expect(hook?.activeId).toBe("c");
    expect(select).toHaveBeenCalledWith("c");

    await act(async () => root.render(createElement(BrowserPagesProbe, { webOn: false })));
    await flush();
    expect(hook?.pages).toEqual([]);
    expect(hook?.activeId).toBe("");

    await act(async () => root.unmount());
  });
});
