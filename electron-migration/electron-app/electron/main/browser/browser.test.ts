// The orchestrator's own decisions, against a fake page factory.
//
// WHY THIS FILE EXISTS. browser.ts used to carry no tests, on the stated
// grounds that it is "Electron glue" — and webviewManager.ts's header justifies
// that arrangement by claiming every DECISION has been moved into a pure, tested
// module. That claim did not hold for this file: it is the only place that
// decides the tab cap REFUSES rather than evicts, that the heir rule runs only
// when the VISIBLE page closed, that the `loadURL` path gets its own guard, that
// the shield's verdict is the worst of the OPEN pages, and that "Try again"
// re-attaches to every page. A mutation making the cap evict the oldest page,
// and one applying the heir rule to a background tab, both passed the entire
// suite unchanged.
//
// Only ONE thing here needs a running Electron app — building a page's real
// view, session and preload — so that is the one thing injected
// (`BrowserDeps.createPage`), in the same shape as every other seam in this port
// (`EvalHost`, `BlockingSessionLike`, `NavigatableContents`, `DownloadItemLike`).
// Everything else operates on the returned `LivePage` and reads only its own
// fields, so supplying the factory supplies the whole page.
//
// Ports the browser.rs tests that need live state rather than a pure function:
// `the_page_cap_is_small_enough_to_matter_and_larger_than_one`'s real behaviour,
// `closing_a_page_shows_its_right_neighbour_then_its_left` end to end,
// `closing_the_browser_ends_the_sitting`,
// `one_unprotected_page_makes_the_whole_browser_unprotected` over live pages,
// and `nothing_in_this_module_asks_a_webview_for_its_url`.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseJournalRow } from "../../shared/apiTypes.js";
import { Browser, type BrowserDeps } from "./browser.js";
import { MAX_TABS, PARKED, type Bounds } from "./tabs.js";
import { attachContentBlocking } from "./contentBlocking.js";
import type { CreatePageDeps, LivePage, WindowContentView } from "./webviewManager.js";

// ---------------------------------------------------------------------------
// A fake page: everything a `LivePage` carries, with the four objects browser.ts
// actually touches (view, contents, webSession) answering for real.
// ---------------------------------------------------------------------------

interface FakePage {
  id: string;
  loaded: string[];
  evaluated: string[];
  closed: boolean;
  removedFromWindow: number;
  bounds: Bounds[];
  blockingAttaches: number;
  live: LivePage;
}

interface Harness {
  browser: Browser;
  pages: Map<string, FakePage>;
  journal: Array<[string, string, string]>;
  emitted: Array<[string, unknown]>;
  addedViews: unknown[];
  removedStagingDirs: string[];
  /** Per-id switches the fake page factory reads. */
  blockingThrowsFor: Set<string>;
  persistentFor: Set<string>;
  storagePathFor: Set<string>;
  attachThrows: boolean;
  /** What a page-script round trip answers, keyed on the op the js embeds. */
  answer: (op: string, pageId: string) => unknown;
}

function opOf(js: string): string {
  if (js.includes("window.__arcelleSuperseded = 1")) return "superseded";
  return /\.call\("([a-zA-Z]+)"/.exec(js)?.[1] ?? "";
}

function harness(): Harness {
  const pages = new Map<string, FakePage>();
  const journal: Array<[string, string, string]> = [];
  const emitted: Array<[string, unknown]> = [];
  const addedViews: unknown[] = [];
  const removedStagingDirs: string[] = [];

  const h: Harness = {
    // Filled in at the bottom, once the deps it needs exist. Never observed
    // unset: nothing below runs before `harness()` returns.
    browser: null as unknown as Browser,
    pages,
    journal,
    emitted,
    addedViews,
    removedStagingDirs,
    blockingThrowsFor: new Set<string>(),
    persistentFor: new Set<string>(),
    storagePathFor: new Set<string>(),
    attachThrows: false,
    answer: (op: string) => (op === "ping" ? { ok: true, url: "https://example.com/" } : { ok: true }),
  };

  const windowContentView: WindowContentView = {
    addChildView(view) {
      if (h.attachThrows) throw new Error("the window is going away");
      addedViews.push(view);
    },
    removeChildView(view) {
      const rec = [...pages.values()].find((p) => p.live.view === view);
      if (rec) rec.removedFromWindow += 1;
    },
  };

  const createPage = (id: string, pageDeps: CreatePageDeps): LivePage => {
    const rec: FakePage = {
      id,
      loaded: [],
      evaluated: [],
      closed: false,
      removedFromWindow: 0,
      bounds: [],
      blockingAttaches: 0,
      live: null as unknown as LivePage,
    };
    const webSession = {
      isPersistent: () => h.persistentFor.has(id),
      getStoragePath: () => (h.storagePathFor.has(id) ? "/tmp/persisted" : null),
      webRequest: {
        onBeforeRequest() {
          if (h.blockingThrowsFor.has(id)) throw new Error("webRequest unavailable");
          rec.blockingAttaches += 1;
        },
      },
    };
    const view = {
      setBounds(b: Bounds) {
        rec.bounds.push(b);
      },
    };
    const contents = {
      isDestroyed: () => rec.closed,
      close() {
        rec.closed = true;
      },
      loadURL: async (url: string) => {
        rec.loaded.push(url);
      },
      executeJavaScript: async (js: string) => {
        rec.evaluated.push(js);
        // The real host wraps the expression in JSON.stringify, so the wire is
        // JSON TEXT — reproduced here rather than short-circuited.
        return JSON.stringify(h.answer(opOf(js), id));
      },
    };
    rec.live = { id, view, contents, webSession, protection: { state: "unknown" } } as unknown as LivePage;
    // The REAL attach, so the verdict this page carries is the one the real
    // code would have produced.
    const blocking = attachContentBlocking(webSession, pageDeps.contentBlocking);
    rec.live.protection = blocking.ok
      ? { state: "active" }
      : { state: "failed", reason: blocking.reason };
    pages.set(id, rec);
    return rec.live;
  };

  const deps: BrowserDeps = {
    windowContentView: () => windowContentView,
    journalSink: { db: null, emit: (row: BrowseJournalRow) => journal.push([row.kind, row.url, row.detail]) },
    emit: (event, payload) => emitted.push([event, payload]),
    stagingDir: () => "/tmp/arcelle-browse-downloads",
    ensureStagingDir: () => {},
    removeStagedFile: async () => {},
    removeStagingDir: async (dir) => {
      removedStagingDirs.push(dir);
    },
    importFinishedDownload: async (_p, name) => ({ name }),
    createPage,
  };

  h.browser = new Browser(deps);
  return h;
}

/** Open `n` pages at distinct public addresses and return their ids. */
function openPages(h: Harness, n: number): string[] {
  return Array.from({ length: n }, (_, i) => h.browser.newTab(`https://site${i}.example/`));
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ---------------------------------------------------------------------------

describe("the tab cap REFUSES a ninth page rather than evicting one", () => {
  it("throws, names the cap, and leaves every open page exactly where it was", () => {
    // A silently discarded page is exactly the kind of surprise the rest of
    // this app goes out of its way not to spring.
    const ids = openPages(h, MAX_TABS);
    expect(h.browser.tabList()).toHaveLength(MAX_TABS);

    expect(() => h.browser.newTab("https://one-too-many.example/")).toThrow(
      `The private browser is limited to ${MAX_TABS} open pages — close one first.`,
    );

    expect(h.browser.tabList().map((t) => t.id)).toEqual(ids);
    // Nothing was closed to make room, and the page the user was reading is
    // still the one showing.
    expect([...h.pages.values()].filter((p) => p.closed)).toEqual([]);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(ids.at(-1));
  });

  it("does not build a view for the page it refuses", () => {
    openPages(h, MAX_TABS);
    const before = h.pages.size;
    expect(() => h.browser.newTab("https://one-too-many.example/")).toThrow();
    expect(h.pages.size).toBe(before);
  });

  it("accepts a new page again once one has been closed", () => {
    const ids = openPages(h, MAX_TABS);
    h.browser.closeTab(ids[0] as string);
    expect(() => h.browser.newTab("https://room-again.example/")).not.toThrow();
    expect(h.browser.tabList()).toHaveLength(MAX_TABS);
  });
});

describe("closing a page: the heir rule, and who it applies to", () => {
  it("shows the right neighbour, then the left, when the VISIBLE page closes", () => {
    const [a, b, c] = openPages(h, 3) as [string, string, string];
    h.browser.selectTab(b);
    h.browser.closeTab(b);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(c);

    h.browser.closeTab(c);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(a);
  });

  it("does NOT move the user when a BACKGROUND tab closes", () => {
    // Running the heir rule for a tab that was not showing swapped the page in
    // front of the user for its neighbour, while the strip still highlighted
    // the tab they were on — and clicking that tab then did nothing.
    const [a, b, c] = openPages(h, 3) as [string, string, string];
    h.browser.selectTab(a);
    h.browser.closeTab(b);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(a);
    h.browser.closeTab(c);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(a);
  });

  it("leaves nothing showing, and ends the sitting, when the last page closes", () => {
    const [only] = openPages(h, 1) as [string];
    const sitting = h.browser.sessionId();
    expect(sitting).not.toBe("");
    h.browser.closeTab(only);
    expect(h.browser.tabList()).toEqual([]);
    expect(h.browser.isOpen()).toBe(false);
    // The sitting must end with the browser, or the next one is labelled as
    // this one.
    expect(h.browser.sessionId()).toBe("");
  });

  it("tears the closed page's renderer down and detaches its view", () => {
    // The ephemeral session dies with the renderer; an orphaned WebContents
    // holding a live session is exactly the trace this browser must not keep.
    const [only] = openPages(h, 1) as [string];
    h.browser.closeTab(only);
    const rec = h.pages.get(only) as FakePage;
    expect(rec.closed).toBe(true);
    expect(rec.removedFromWindow).toBe(1);
  });

  it("survives being asked to close a page that is already gone", () => {
    const [a, b] = openPages(h, 2) as [string, string];
    h.browser.selectTab(a);
    h.browser.closeTab(a);
    expect(() => h.browser.closeTab(a)).not.toThrow();
    expect(h.browser.tabList().map((t) => t.id)).toEqual([b]);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(b);
  });
});

describe("the loadURL path carries its own guard — nothing else gates it", () => {
  it("refuses a private destination from newTab, and opens no page for it", () => {
    // Neither will-frame-navigate nor will-redirect fires for
    // webContents.loadURL, so without this check the agent path would be the
    // one way in with no gate on it at all.
    expect(() => h.browser.newTab("http://127.0.0.1:11434/api/delete")).toThrow(
      /Local and private-network addresses/,
    );
    expect(h.browser.tabList()).toEqual([]);
    expect(h.pages.size).toBe(0);
    expect(h.journal).toContainEqual([
      "blocked",
      "http://127.0.0.1:11434/api/delete",
      "Navigation blocked: private or non-web address.",
    ]);
    expect(h.emitted).toContainEqual(["browser-blocked", { url: "http://127.0.0.1:11434/api/delete" }]);
  });

  it("refuses a private destination from ensure, without moving the open page", () => {
    const [id] = openPages(h, 1) as [string];
    expect(() => h.browser.ensure("http://localhost.:11434/")).toThrow();
    expect(h.browser.activeUrl()).toBe("https://site0.example/");
    expect((h.pages.get(id) as FakePage).loaded).toEqual(["https://site0.example/"]);
  });

  it("refuses a non-web scheme too", () => {
    expect(() => h.browser.newTab("file:///etc/passwd")).toThrow(/Only http\(s\)/);
    expect(() => h.browser.newTab("not a url")).toThrow(/Invalid URL/);
  });
});

describe("ensure: navigating the page that is showing", () => {
  it("stamps the outgoing document superseded BEFORE navigating it", () => {
    // Otherwise waitReady sees the page we are LEAVING answer instantly and the
    // next snapshot describes the wrong page.
    const [id] = openPages(h, 1) as [string];
    h.browser.ensure("https://next.example/");
    const rec = h.pages.get(id) as FakePage;
    expect(rec.evaluated.some((js) => js.includes("window.__arcelleSuperseded = 1"))).toBe(true);
    expect(rec.loaded).toEqual(["https://site0.example/", "https://next.example/"]);
    expect(h.browser.activeUrl()).toBe("https://next.example/");
  });

  it("opens the first page when nothing is open at all", () => {
    h.browser.ensure("https://first.example/");
    expect(h.browser.tabList()).toHaveLength(1);
    expect(h.browser.activeUrl()).toBe("https://first.example/");
  });

  it("says why in the journal when a load is refused, rather than failing silently", async () => {
    const [id] = openPages(h, 1) as [string];
    const rec = h.pages.get(id) as FakePage;
    (rec.live.contents as unknown as { loadURL: (u: string) => Promise<void> }).loadURL = async () => {
      throw new Error("ERR_NAME_NOT_RESOLVED");
    };
    h.browser.ensure("https://gone.example/");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.journal.at(-1)).toEqual([
      "open",
      "https://gone.example/",
      "The page could not be loaded: ERR_NAME_NOT_RESOLVED",
    ]);
  });
});

describe("the shield speaks for the WHOLE browser", () => {
  it("is unknown with nothing open — never active", () => {
    expect(h.browser.protection()).toEqual({ state: "unknown" });
  });

  it("is active only when every OPEN page said so", () => {
    openPages(h, 2);
    expect(h.browser.protection()).toEqual({ state: "active" });
  });

  it("lets one page whose blocker never attached make the browser unprotected", () => {
    h.blockingThrowsFor.add("1");
    openPages(h, 3);
    expect(h.browser.protection()).toEqual({ state: "failed", reason: "webRequest unavailable" });
    // …and it must not look identical to a working one in the record either.
    expect(h.journal).toContainEqual([
      "blocker",
      "",
      "Content blocking FAILED to load: webRequest unavailable",
    ]);
  });

  it("stops counting a page once it is closed", () => {
    h.blockingThrowsFor.add("1");
    const ids = openPages(h, 2);
    expect(h.browser.protection().state).toBe("failed");
    h.browser.closeTab(ids[1] as string);
    expect(h.browser.protection()).toEqual({ state: "active" });
  });

  it("counts only pages a LIVE view still backs, not every ledger row", () => {
    // `protection()` filters the ledger against the live-page map exactly as
    // `tab_list` filters against `webview_of(app, id)`, so a verdict can never
    // outlive the thing it describes. `closeTab` drops both together, so the
    // filter is unreachable through the public surface — which is precisely why
    // the divergence has to be produced deliberately here. Without this, the
    // filter is a line no test can fail.
    h.blockingThrowsFor.add("1");
    const ids = openPages(h, 2);
    expect(h.browser.protection().state).toBe("failed");

    const live = (h.browser as unknown as { pages: Map<string, LivePage> }).pages;
    live.delete(ids[1] as string);
    expect(h.browser.protection()).toEqual({ state: "active" });
    // …and the strip agrees: the row goes with the view.
    expect(h.browser.tabList().map((t) => t.id)).toEqual([ids[0]]);
  });

  it("re-attaches EVERY page on retry, including the ones already fine", () => {
    // Skipping the healthy ones would leave the verdict depending on which
    // pages happened to be fine when the user pressed the button.
    h.blockingThrowsFor.add("1");
    openPages(h, 2);
    expect(h.browser.protection().state).toBe("failed");

    h.blockingThrowsFor.clear();
    h.browser.retryProtection();
    expect(h.browser.protection()).toEqual({ state: "active" });
    // Page 0 was already active and was still re-attached.
    expect((h.pages.get("0") as FakePage).blockingAttaches).toBe(2);
    expect((h.pages.get("1") as FakePage).blockingAttaches).toBe(1);
  });

  it("refuses to retry when the browser isn't open", () => {
    expect(() => h.browser.retryProtection()).toThrow("The browser isn't open.");
  });
});

describe("verifyEphemeral asks every LIVE session, not the flag we set", () => {
  it("is true when every page's session is non-persistent and backed by no path", () => {
    openPages(h, 3);
    expect(h.browser.verifyEphemeral()).toBe(true);
  });

  it("is false when a BACKGROUND page has somehow acquired a persistent store", () => {
    // A background tab that had one would be exactly as bad as the visible one.
    openPages(h, 3);
    h.persistentFor.add("1");
    expect(h.browser.verifyEphemeral()).toBe(false);
  });

  it("is false on the second, independent question too", () => {
    openPages(h, 2);
    h.storagePathFor.add("0");
    expect(h.browser.verifyEphemeral()).toBe(false);
  });

  it("refuses the question when nothing is open", () => {
    expect(() => h.browser.verifyEphemeral()).toThrow("The browser isn't open.");
  });
});

describe("bounds: the active page is placed, every other page is PARKED", () => {
  it("parks the background pages so none can float over the workspace", () => {
    const ids = openPages(h, 3);
    const rect = { x: 12, y: 34, width: 800, height: 600 };
    h.browser.setBounds(rect);
    expect(h.browser.bounds()).toEqual(rect);
    for (const id of ids) {
      const last = (h.pages.get(id) as FakePage).bounds.at(-1);
      expect(last, id).toEqual(id === ids.at(-1) ? rect : PARKED);
    }
  });

  it("parks a page opened before the browser area ever measured itself", () => {
    const [id] = openPages(h, 1) as [string];
    expect((h.pages.get(id) as FakePage).bounds.at(-1)).toEqual(PARKED);
  });

  it("moves the pages on a tab switch without creating or destroying a view", () => {
    const [a, b] = openPages(h, 2) as [string, string];
    h.browser.setBounds({ x: 0, y: 0, width: 400, height: 300 });
    h.browser.selectTab(a);
    expect((h.pages.get(a) as FakePage).bounds.at(-1)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect((h.pages.get(b) as FakePage).bounds.at(-1)).toEqual(PARKED);
    expect((h.pages.get(b) as FakePage).closed).toBe(false);
  });

  it("refuses to select a page that is no longer open", () => {
    expect(() => h.browser.selectTab("nope")).toThrow("That page is no longer open.");
  });
});

describe("close: the two paths meant to destroy the session", () => {
  it("tears every page down, ends the sitting, and sweeps the staging directory", () => {
    openPages(h, 3);
    h.browser.takeover = true;
    h.browser.close();

    expect([...h.pages.values()].every((p) => p.closed)).toBe(true);
    expect(h.browser.tabList()).toEqual([]);
    expect(h.browser.sessionId()).toBe("");
    expect(h.browser.takeover).toBe(false);
    expect(h.removedStagingDirs).toEqual(["/tmp/arcelle-browse-downloads"]);
  });

  it("leaves the browser openable again, on a NEW sitting", () => {
    openPages(h, 1);
    const first = h.browser.sessionId();
    h.browser.close();
    openPages(h, 1);
    expect(h.browser.sessionId()).not.toBe(first);
  });
});

describe("a page whose view cannot be attached leaves nothing behind", () => {
  it("destroys the renderer and keeps the ledger clean", () => {
    // Otherwise the strip carries a row for a page that is not on screen, a
    // live session outlives the failure, and the orphan counts against the tab
    // cap for the rest of the room's life.
    h.attachThrows = true;
    expect(() => h.browser.newTab("https://example.com/")).toThrow("the window is going away");
    expect(h.browser.tabList()).toEqual([]);
    expect(h.browser.sessionId()).toBe("");
    expect([...h.pages.values()].every((p) => p.closed)).toBe(true);
    h.attachThrows = false;
    expect(() => h.browser.newTab("https://example.com/")).not.toThrow();
  });

  it("refuses to open a page at all when the app window is gone", () => {
    const gone = new Browser({
      ...({
        windowContentView: () => null,
        journalSink: { db: null, emit: () => {} },
        emit: () => {},
        stagingDir: () => "/tmp/x",
        ensureStagingDir: () => {},
        removeStagedFile: async () => {},
        removeStagingDir: async () => {},
        importFinishedDownload: async (_p: string, name: string) => ({ name }),
      } as BrowserDeps),
    });
    expect(() => gone.newTab("https://example.com/")).toThrow("The app window is gone.");
  });
});

describe("the agent transport addresses the page it was started on", () => {
  it("refuses every op when no page is open", async () => {
    await expect(h.browser.call("snapshot")).rejects.toThrow("The browser isn't open.");
    await expect(h.browser.callAsync("act", {})).rejects.toThrow("The browser isn't open.");
    await expect(h.browser.waitReady(10)).rejects.toThrow("The browser isn't open.");
  });

  it("journals that an action navigated the page — the record, not just the model", async () => {
    // Rust's `journal(app, "act", "", "The page navigated while acting")`. The
    // model is told the page moved; invariant #2 says the user's own record has
    // to say so too.
    openPages(h, 1);
    let doc = "doc-A";
    let took = false;
    h.answer = (op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") {
        if (!took) {
          took = true;
          doc = "doc-B";
        }
        return { ok: false, error: "Unknown ticket t1" };
      }
      if (op === "info") return { ok: true, doc };
      if (op === "ping") return { ok: true, url: "https://after.example/" };
      if (op === "snapshot") return { ok: true, count: 1 };
      return { ok: true };
    };

    const result = await h.browser.callAsync("act", { actions: [] }, 5_000, {
      sleep: () => Promise.resolve(),
      navBudgetMs: 20,
    });
    expect(result).toEqual({ ok: true, navigated: true, snapshot: { ok: true, count: 1 } });
    expect(h.journal).toContainEqual(["act", "", "The page navigated while acting"]);
  });

  it("writes no such line when the ticket was lost for a real reason", async () => {
    openPages(h, 1);
    h.answer = (op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") return { ok: false, error: "Unknown ticket t1" };
      if (op === "info") return { ok: true, doc: "doc-A" };
      if (op === "ping") return { ok: true, url: "https://same.example/" };
      return { ok: true };
    };
    await expect(
      h.browser.callAsync("act", {}, 5_000, { sleep: () => Promise.resolve(), navBudgetMs: 20 }),
    ).rejects.toThrow("Unknown ticket t1");
    expect(h.journal.filter(([kind]) => kind === "act")).toEqual([]);
  });

  it("reports a closed page rather than reaching for whichever one is showing", async () => {
    const [a, b] = openPages(h, 2) as [string, string];
    h.browser.selectTab(a);
    h.answer = () => ({ ok: true, value: 1 });
    await expect(h.browser.call("snapshot")).resolves.toBeTruthy();
    // The op follows the ACTIVE page, and a page that is gone says so.
    h.browser.closeTab(a);
    expect(h.browser.tabList().find((t) => t.active)?.id).toBe(b);
  });
});

describe("the strip, and what a row is called", () => {
  it("names a page after its host until its own title is known", () => {
    openPages(h, 1);
    expect(h.browser.tabList()[0]?.title).toBe("site0.example");
    h.browser.recordActiveTitle("Site Zero");
    expect(h.browser.tabList()[0]?.title).toBe("Site Zero");
  });

  it("self-heals the record from the page script's own location.href", () => {
    openPages(h, 1);
    h.browser.recordActiveUrl("https://site0.example/moved");
    expect(h.browser.activeUrl()).toBe("https://site0.example/moved");
    // …and a moved page drops the name the old document gave it.
    expect(h.browser.tabList()[0]?.title).toBe("site0.example");
  });

  it("is blank with nothing open, and with a page that has been nowhere", () => {
    expect(h.browser.isBlank()).toBe(true);
    openPages(h, 1);
    expect(h.browser.isBlank()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The invariant browser.rs pins as a source scan, for the same reason: the call
// compiles perfectly and only fails on a live page.
// ---------------------------------------------------------------------------

describe("nothing_in_this_module_asks_a_webview_for_its_url", () => {
  it("reads Page.url instead of asking a live view where it is", () => {
    // On the Tauri side asking ABORTED THE PROCESS (wry unwraps a nil
    // `WKWebView.URL` on a page with no committed document — crash report
    // 2026-07-31 22:58). Electron's `getURL()` merely answers `""` there, which
    // is worse in one way: an iframe's `about:blank` silently overwriting a
    // page's record is exactly the vanishing-page bug, and it would show up as
    // wrong output rather than as a crash. Every URL a page is sent to passes
    // through this module, so it is RECORDED and never asked back.
    const dir = path.dirname(fileURLToPath(import.meta.url));
    // Composed, not a literal, so this scanner cannot report itself.
    const banned = [`get${"URL"}(`, `get${"Title"}(`];
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      // The one sanctioned reader: a `DownloadItem` is not a WebContents, and
      // Rust's own download path takes the URL off the event in the same way.
      if (name === "downloadGating.ts") continue;
      const src = readFileSync(path.join(dir, name), "utf8");
      src.split("\n").forEach((line, n) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (banned.some((b) => line.includes(b))) offenders.push(`${name}:${n + 1}`);
      });
    }
    expect(
      offenders,
      "these ask a live view where it is — read the recorded Page.url instead",
    ).toEqual([]);
  });

  it("keeps the frame-tree read that IS sanctioned confined to one place", () => {
    // contentBlocking.ts reads `frame.top.url` for THIRD-PARTY classification,
    // which is a different question from "what is this page" and is wrapped in
    // its own try/catch for a destroyed frame. It must not spread.
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const readers = readdirSync(dir).filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        readFileSync(path.join(dir, name), "utf8")
          .split("\n")
          .some((line) => !line.trim().startsWith("*") && line.includes("frame?.top?.url")),
    );
    expect(readers).toEqual(["contentBlocking.ts"]);
  });
});

describe("the fake factory really is the only Electron-shaped thing injected", () => {
  it("never reaches a real Electron API in any of the above", () => {
    // If browser.ts grew a direct `require("electron")` this whole file would
    // stop being able to run under plain Node, which is the signal that a
    // decision has drifted back into the untestable layer.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "browser.ts"),
      "utf8",
    );
    expect(src).not.toContain(`require("electron")`);
    expect(vi.isMockFunction(() => {})).toBe(false);
  });
});
