/**
 * Port of the chrome half of `src-tauri/src/commands/browse.rs`'s
 * `#[cfg(test)] mod tests`:
 *
 *  - a_page_waiting_on_its_blocker_is_loading_not_broken (the half that
 *    survives — `navigation_deferred` is deliberately not ported, so only the
 *    `navigating` argument applies; see browseCommands.ts)
 *  - a_lost_round_trip_is_a_navigation_wherever_it_happens (behaviourally,
 *    not through Rust's self-referential `include_str!` source grep, which has
 *    no honest counterpart across a TypeScript module)
 *  - only_the_chrome_actions_that_load_are_gated_on_the_internet_switch
 *
 * plus end-to-end coverage of every chrome command, mostly against a REAL
 * fixture room and the REAL `Browser` class over the page-factory seam
 * `browser.test.ts` established — and, where a specific `Browser` answer is
 * what a case is about, against a fake satisfying `ChromeBrowser` exactly.
 *
 * SOME OF THESE RESOLVE FOR REAL. `browseGuardUrl` does a genuine DNS lookup
 * (SEC-5's rebinding recheck), so the navigation cases use real, resolvable
 * domains — `.example`-suffixed names do not resolve at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type {
  BrowseJournalRow,
  BrowserProtection,
  BrowserTab,
  WebHit,
} from "../../shared/apiTypes.js";
import { createRoom } from "../db-host/open.js";
import { setSetting } from "../db-host/settings.js";
import { putWebSearch, saveWebImage, saveWebPage } from "../db-host/webCache.js";
import { Browser, type BrowserDeps } from "./browser.js";
import type { CreatePageDeps, LivePage, WindowContentView } from "./webviewManager.js";
import { evalLostToNavigation } from "./readiness.js";
import { insertBrowseJournal } from "./journal.js";
import {
  browserClearJournal,
  browserClearScope,
  browserClose,
  browserCloseTab,
  browserGo,
  browserGoJs,
  browserInfo,
  browserJournal,
  browserNavigate,
  browserNewTab,
  browserRetryProtection,
  browserSavePage,
  browserSelectTab,
  browserSetBounds,
  browserSetTakeover,
  browserTabs,
  browserVerifyPrivate,
  chromeActionScript,
  reportablePageState,
  type BrowseCommandsDeps,
  type ChromeBrowser,
} from "./browseCommands.js";

// --------------------------------------------------------------------- pure

describe("reportablePageState", () => {
  /** THE FIRST-NAVIGATION BANNER (audit P1). The poll runs on a 1200 ms beat
   * and a document commit takes far less than that, so landing inside one is a
   * matter of time — and on a page's FIRST navigation, where the user types
   * into a page parked on the idle document, it is very nearly certain. The
   * toolbar rendered that as "This page is not answering", on a page that was
   * loading normally, and Reload "fixed" it. */
  it("suppresses ready and error mid-navigation, and passes both through once it is over", () => {
    const lost = "The page was replaced while it was answering.";
    // While the navigation is in flight: no error reaches the toolbar, and the
    // page is NOT ready — the "complete" came from the document being
    // navigated away from, which is not the page anybody asked for.
    expect(reportablePageState(true, "complete", lost)).toEqual({ ready: false, error: undefined });
    // …and with no answer at all it is still just loading.
    expect(reportablePageState(true, null, lost)).toEqual({ ready: false, error: undefined });
    // Once the wait is over, a page that has stopped answering says so again —
    // the point is to delay the report, never to swallow it.
    expect(reportablePageState(false, null, lost)).toEqual({ ready: null, error: lost });
    // …and an ordinary healthy poll is passed through untouched.
    expect(reportablePageState(false, "complete", undefined)).toEqual({
      ready: "complete",
      error: undefined,
    });
  });

  it("reads a lost round trip the same way the readiness probe does", () => {
    expect(evalLostToNavigation("The page was replaced while it was answering.")).toBe(true);
    // Everything else still reaches the toolbar. A page that genuinely stopped
    // answering is this app's only report that it did.
    for (const other of [
      "The page did not answer in time.",
      "The browser could not run the page script: no view",
      "",
    ]) {
      expect(evalLostToNavigation(other)).toBe(false);
    }
  });
});

describe("browserGoJs / chromeActionScript", () => {
  /** The room's internet switch is a promise ("this room stays offline"), and
   * Back/Forward/Reload are real loads. Stop is the exception: cancelling a
   * load must never be refused for being offline. */
  it("gates only the chrome actions that actually load", () => {
    expect(browserGoJs("back")).toEqual(["history.back()", true]);
    expect(browserGoJs("forward")).toEqual(["history.forward()", true]);
    expect(browserGoJs("reload")).toEqual(["location.reload()", true]);
    expect(browserGoJs("stop")).toEqual(["window.stop()", false]);
    expect(() => browserGoJs("teleport")).toThrow("Unknown browser action: teleport");
  });

  it("wraps the action so the JSON wire carries a value, keeping the action itself verbatim", () => {
    expect(chromeActionScript("history.back()")).toBe("(history.back(), true)");
    // The wrapper only ADDS: the exact expression Rust evaluates is still in
    // there, so a change to `browserGoJs` cannot hide behind it.
    expect(JSON.stringify(chromeActionScript("window.stop()"))).toContain("window.stop()");
  });
});

// -------------------------------------------------------------- the harnesses

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRoom(online = true): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "browse-commands-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  if (online) setSetting(db, "web_provider", "duckduckgo");
  return db;
}

function opOf(js: string): string {
  return /\.call\("([a-zA-Z]+)"/.exec(js)?.[1] ?? "";
}

/** The REAL `Browser`, over a fake page factory whose page-script answers a
 *  test can change mid-run. `scripts` captures every expression that reached
 *  the page, which is how `browserGo` is checked without a live renderer. */
function harness(db: Database.Database | null) {
  let answer: (op: string) => unknown = () => ({ ok: true });
  let evaluate: ((js: string) => unknown) | null = null;
  const scripts: string[] = [];
  const windowContentView: WindowContentView = { addChildView() {}, removeChildView() {} };
  const createPage = (id: string, _pageDeps: CreatePageDeps): LivePage =>
    ({
      id,
      view: { setBounds() {} },
      contents: {
        isDestroyed: () => false,
        close() {},
        loadURL: async () => {},
        executeJavaScript: async (js: string) => {
          scripts.push(js);
          if (evaluate) return evaluate(js);
          return JSON.stringify(answer(opOf(js)));
        },
      },
      webSession: {
        isPersistent: () => false,
        getStoragePath: () => null,
        webRequest: { onBeforeRequest() {} },
      },
      protection: { state: "unknown" },
    }) as unknown as LivePage;
  const deps: BrowserDeps = {
    windowContentView: () => windowContentView,
    journalSink: { db, emit: (_row: BrowseJournalRow) => {} },
    emit: () => {},
    stagingDir: () => "/tmp/x",
    ensureStagingDir: () => {},
    removeStagedFile: async () => {},
    removeStagingDir: async () => {},
    importFinishedDownload: async (_p, name) => ({ name }),
    createPage,
  };
  return {
    browser: new Browser(deps),
    scripts,
    setAnswer: (fn: (op: string) => unknown) => {
      answer = fn;
    },
    setEvaluate: (fn: ((js: string) => unknown) | null) => {
      evaluate = fn;
    },
  };
}

function baseDeps(
  db: Database.Database | null,
  browser: ChromeBrowser,
  extra: Partial<BrowseCommandsDeps> = {},
): BrowseCommandsDeps {
  return {
    browser,
    db,
    roomPath: "/tmp/room.roomai",
    scheduleAutoIndex: () => {},
    schedulePrivacyScan: () => {},
    emitFilesChanged: () => {},
    ...extra,
  };
}

/** A fake satisfying `ChromeBrowser` exactly, for the cases that are ABOUT a
 *  particular answer from the browser rather than about the real one. */
function fakeBrowser(overrides: Partial<ChromeBrowser> = {}): ChromeBrowser & {
  journalCalls: Array<[string, string, string]>;
  evaluated: string[];
} {
  const journalCalls: Array<[string, string, string]> = [];
  const evaluated: string[] = [];
  return {
    takeover: false,
    journalCalls,
    evaluated,
    isOpen: () => true,
    isBlank: () => false,
    ensure: () => {},
    newTab: () => "tab-1",
    selectTab: () => {},
    closeTab: () => {},
    close: () => {},
    tabList: (): BrowserTab[] => [],
    setBounds: () => {},
    protection: (): BrowserProtection => ({ state: "active" }),
    blockedCount: () => 0,
    retryProtection: () => {},
    verifyEphemeral: () => true,
    sessionId: () => "s1",
    activeUrl: () => undefined,
    recordActiveUrl: () => {},
    recordActiveTitle: () => {},
    journal: (kind, url, detail) => void journalCalls.push([kind, url, detail]),
    call: async () => ({ ok: true }),
    eval: async (js) => {
      evaluated.push(js);
      return true;
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------- navigation

describe("browserNavigate / browserNewTab", () => {
  it("refuses a closed room and an offline room before touching anything", async () => {
    const { browser } = harness(null);
    await expect(browserNavigate(baseDeps(null, browser), "example.com")).rejects.toThrow(
      "No room is open.",
    );
    const db = freshRoom(false);
    await expect(browserNavigate(baseDeps(db, browser), "example.com")).rejects.toThrow(/offline/);
    await expect(browserNewTab(baseDeps(db, browser), "example.com")).rejects.toThrow(/offline/);
    // …including for the empty new tab, which never reaches the URL guard at
    // all: the internet switch runs FIRST regardless of the argument.
    await expect(browserNewTab(baseDeps(db, browser), "")).rejects.toThrow(/offline/);
    expect(browser.isOpen()).toBe(false);
    db.close();
  });

  it("fills in https://, guards the address, and journals it as user-opened", async () => {
    const db = freshRoom();
    const { browser } = harness(db);
    const checked = await browserNavigate(baseDeps(db, browser), "  example.com  ");
    expect(checked).toBe("https://example.com/");
    // A first navigation on an empty browser opens a tab under the hood
    // (`ensure` → `newTab`), which also journals its own blocker verdict — so
    // "open" is not the only row, but it must be there and it must be ours.
    const rows = db.prepare("SELECT kind, url, detail FROM browse_journal").all() as Array<{
      kind: string;
      url: string;
      detail: string;
    }>;
    expect(rows.find((r) => r.kind === "open")).toMatchObject({
      url: "https://example.com/",
      detail: "Opened by the user",
    });
    db.close();
  });

  it("keeps an explicit scheme verbatim", async () => {
    const db = freshRoom();
    const browser = fakeBrowser();
    expect(await browserNavigate(baseDeps(db, browser), "http://example.com/path")).toBe(
      "http://example.com/path",
    );
    db.close();
  });

  it("refuses a private address before ever navigating", async () => {
    const db = freshRoom();
    const { browser } = harness(db);
    await expect(browserNavigate(baseDeps(db, browser), "192.168.1.1")).rejects.toThrow();
    await expect(browserNavigate(baseDeps(db, browser), "localhost")).rejects.toThrow();
    expect(browser.isOpen()).toBe(false);
    db.close();
  });

  it("decides an empty new tab is the idle document, with no network guard", async () => {
    const db = freshRoom();
    const browser = fakeBrowser();
    const id = await browserNewTab(baseDeps(db, browser), "  ");
    expect(id).toBe("tab-1");
    expect(browser.journalCalls).toEqual([
      ["open", "about:blank", "Opened by the user in a new tab"],
    ]);
    db.close();
  });

  it("opens the idle document against the real core without treating it as a network URL", async () => {
    const db = freshRoom();
    const { browser } = harness(db);
    await expect(browserNewTab(baseDeps(db, browser), "")).resolves.toBe("0");
    expect(browser.activeUrl()).toBe("about:blank");
    db.close();
  });
});

describe("the tab strip", () => {
  it("opens, selects, resizes and closes real pages", async () => {
    const db = freshRoom();
    const { browser } = harness(db);
    const deps = baseDeps(db, browser);
    // This case is about local tab lifecycle only. URL guarding and its DNS
    // recheck are covered above, so keep this test deterministic and offline.
    const a = await browserNewTab(deps, "");
    const b = await browserNewTab(deps, "");
    expect(browserTabs(deps).map((t) => t.id)).toEqual([a, b]);
    expect(browserTabs(deps).find((t) => t.active)?.id).toBe(b);

    browserSelectTab(deps, a);
    expect(browserTabs(deps).find((t) => t.active)?.id).toBe(a);

    browserSetBounds(deps, { x: 0, y: 0, width: 800, height: 600 });
    expect(browser.bounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });

    browserCloseTab(deps, b);
    expect(browserTabs(deps).map((t) => t.id)).toEqual([a]);

    browserClose(deps);
    expect(browser.isOpen()).toBe(false);
    expect(browserTabs(deps)).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------- the poll

describe("browserInfo", () => {
  it("answers only { open: false } when nothing is open", async () => {
    const { browser } = harness(null);
    expect(await browserInfo(baseDeps(null, browser))).toEqual({ open: false });
  });

  it("assembles one poll's worth of state, and heals the record from the page's own answer", async () => {
    const db = freshRoom();
    const { browser, setAnswer } = harness(db);
    const deps = baseDeps(db, browser);
    await browserNavigate(deps, "example.com");
    setAnswer((op) =>
      op === "info"
        ? {
            ok: true,
            url: "https://example.com/moved",
            title: "Example Domain",
            ready: "complete",
            hasSelection: true,
            leaveRequested: true,
          }
        : { ok: true },
    );
    const info = await browserInfo(deps);
    expect(info.open).toBe(true);
    expect(info.url).toBe("https://example.com/moved");
    expect(info.title).toBe("Example Domain");
    expect(info.ready).toBe("complete");
    expect(info.hasSelection).toBe(true);
    expect(info.leaveRequested).toBe(true);
    expect(info.takeover).toBe(false);
    expect(info.blank).toBe(false);
    // The sitting id, carried VERBATIM from the browser — this is the only
    // channel it reaches the Journal on, and it is what draws the line between
    // what is happening now and everything that came before. `not.toBe("")`
    // alone would pass for a field that had been dropped entirely.
    expect(typeof info.session).toBe("string");
    expect(info.session).toBe(browser.sessionId());
    expect(info.session).not.toBe("");
    expect(info.protection).toEqual({ state: "unknown" });
    expect("error" in info).toBe(false);
    // The page script answers for the MAIN frame, so the record follows it.
    expect(browser.activeUrl()).toBe("https://example.com/moved");
    db.close();
  });

  it("suppresses the banner for a round trip lost to a navigation", async () => {
    const browser = fakeBrowser({
      call: async () => {
        throw new Error("The page was replaced while it was answering.");
      },
    });
    const info = await browserInfo(baseDeps(null, browser));
    expect(info.open).toBe(true);
    expect(info.ready).toBe(false);
    expect("error" in info).toBe(false);
  });

  it("still reports a page that genuinely stopped answering", async () => {
    const browser = fakeBrowser({
      call: async () => {
        throw new Error("The page did not answer in time.");
      },
    });
    expect((await browserInfo(baseDeps(null, browser))).error).toBe(
      "The page did not answer in time.",
    );
  });

  it("falls back to the recorded address when the page's answer has none", async () => {
    const browser = fakeBrowser({
      call: async () => ({ ok: true }),
      activeUrl: () => "https://recorded.example/",
    });
    const info = await browserInfo(baseDeps(null, browser));
    expect(info.url).toBe("https://recorded.example/");
    expect(info.title).toBeNull();
    expect(info.ready).toBeNull();
  });

  it("reports the takeover flag the toolbar switches", async () => {
    const browser = fakeBrowser();
    browser.takeover = true;
    expect((await browserInfo(baseDeps(null, browser))).takeover).toBe(true);
  });

  it("carries the funnel's real blocked count out to the shield, zero included", async () => {
    // This poll is the only channel the number has out of the native layer, so
    // a count kept accurately on the page and then dropped here would look
    // exactly like the mockup "12 blocked" it replaces. A distinct number, not
    // a truthy one: a hardcoded 0 must fail.
    expect((await browserInfo(baseDeps(null, fakeBrowser({ blockedCount: () => 7 })))).blockedCount)
      .toBe(7);
    expect((await browserInfo(baseDeps(null, fakeBrowser()))).blockedCount).toBe(0);
    // A browser with nothing open says only that, and a count would be a claim
    // about a page that is not there.
    expect(
      "blockedCount" in (await browserInfo(baseDeps(null, fakeBrowser({ isOpen: () => false })))),
    ).toBe(false);
  });
});

// ------------------------------------------------------------------- go

describe("browserGo", () => {
  it("refuses a real load while the room is offline, but never refuses stop", async () => {
    const db = freshRoom(false);
    const browser = fakeBrowser();
    const deps = baseDeps(db, browser);
    await expect(browserGo(deps, "reload")).rejects.toThrow(/offline/);
    await expect(browserGo(deps, "back")).rejects.toThrow(/offline/);
    expect(browser.evaluated).toEqual([]);
    await browserGo(deps, "stop");
    expect(browser.evaluated).toEqual(["(window.stop(), true)"]);
    db.close();
  });

  it("refuses in the chrome's own words when the browser isn't open", async () => {
    const { browser } = harness(freshRoom());
    await expect(browserGo(baseDeps(freshRoom(), browser), "back")).rejects.toThrow(
      "The browser isn't open.",
    );
  });

  /**
   * THE WHOLE REASON `chromeActionScript` EXISTS, proved through the REAL
   * `Browser` and the REAL eval bridge.
   *
   * The real host sends `JSON.stringify(<expr>)` and returns whatever string
   * comes back (`webviewManager.ts`'s `evalHostFor`). All four chrome actions
   * evaluate to `undefined`, and `JSON.stringify(undefined)` is not a string
   * at all — so the host answers `""`, which `evalJson` reads, correctly, as
   * "the page script isn't there". The fake below is that host, faithfully:
   * it EVALUATES the expression it is handed the way a renderer would.
   */
  it("completes through the real eval bridge, where the bare action would not", async () => {
    const db = freshRoom();
    const { browser, scripts, setEvaluate } = harness(db);
    const deps = baseDeps(db, browser);
    await browserNavigate(deps, "example.com");

    // A renderer's `JSON.stringify(<expr>)` where the navigation call itself
    // answers `undefined`, exactly as `history.back()` does.
    const asRenderer = (js: string): string => {
      const value = js.includes(", true)") ? true : undefined;
      const encoded = JSON.stringify(value);
      return typeof encoded === "string" ? encoded : "";
    };
    setEvaluate((js) => asRenderer(js));
    scripts.length = 0;
    await expect(browserGo(deps, "back")).resolves.toBeUndefined();
    expect(scripts).toEqual(["JSON.stringify((history.back(), true))"]);

    // …and the same bridge, handed the BARE expression Rust runs, is exactly
    // the failure this wrapper exists to avoid.
    await expect(browser.eval("history.back()")).rejects.toThrow(/will not run/);
    db.close();
  });

  /** Rust's `wv.eval` reports only that the script was DISPATCHED. Three of
   * these four actions exist to replace the document, so a round trip lost to
   * the navigation they just started is the action working. */
  it("treats a round trip lost to its own navigation as success", async () => {
    const browser = fakeBrowser({
      isOpen: () => true,
      eval: async () => {
        throw new Error("The page was replaced while it was answering.");
      },
    });
    await expect(browserGo(baseDeps(null, browser), "stop")).resolves.toBeUndefined();
  });

  it("still surfaces any other page failure", async () => {
    const browser = fakeBrowser({
      eval: async () => {
        throw new Error("The page did not answer in time.");
      },
    });
    await expect(browserGo(baseDeps(null, browser), "stop")).rejects.toThrow(
      "The page did not answer in time.",
    );
  });
});

// ----------------------------------------------------------- save / takeover

describe("browserSavePage", () => {
  it("runs the real capture-and-save path, defaulting an unknown 'what' to the page", async () => {
    const db = freshRoom();
    const { browser, setAnswer } = harness(db);
    let indexed = 0;
    let scanned = 0;
    let emitted = 0;
    const deps = baseDeps(db, browser, {
      scheduleAutoIndex: () => void (indexed += 1),
      schedulePrivacyScan: () => void (scanned += 1),
      emitFilesChanged: () => void (emitted += 1),
    });
    await browserNavigate(deps, "example.com");
    setAnswer((op) =>
      op === "capture"
        ? {
            ok: true,
            title: "Example",
            url: "https://example.com/",
            text: "just some text",
            html: "",
          }
        : { ok: true },
    );
    expect(await browserSavePage(deps, "bogus")).toContain("Example.md");
    expect([indexed, scanned, emitted]).toEqual([1, 1, 1]);
    db.close();
  });

  it("refuses when no room is open, rather than saving nowhere", async () => {
    const { browser } = harness(null);
    await expect(browserSavePage(baseDeps(null, browser), "page")).rejects.toThrow(
      "No room is open.",
    );
  });
});

describe("browserSetTakeover", () => {
  it("flips the flag and journals which way it went", () => {
    const db = freshRoom();
    const { browser } = harness(db);
    const deps = baseDeps(db, browser);
    browserSetTakeover(deps, true);
    expect(browser.takeover).toBe(true);
    browserSetTakeover(deps, false);
    expect(browser.takeover).toBe(false);
    const rows = db.prepare("SELECT kind, detail FROM browse_journal ORDER BY id").all() as Array<{
      kind: string;
      detail: string;
    }>;
    expect(rows).toEqual([
      { kind: "takeover", detail: "User took over the browser" },
      { kind: "takeover", detail: "User handed the browser back" },
    ]);
    db.close();
  });
});

// ------------------------------------------------------------ journal / clear

function hit(url: string): WebHit {
  return { title: "T", url, engines: ["brave"], date: null, snippet: null, score: 0.5 };
}

describe("browserJournal / browserClearScope / browserClearJournal", () => {
  it("lists, scopes, and clears the journal AND the web cache together", () => {
    const db = freshRoom();
    const { browser } = harness(db);
    const deps = baseDeps(db, browser);
    insertBrowseJournal(db, "s1", "open", "https://a/", "one");
    insertBrowseJournal(db, "s1", "open", "https://b/", "two");
    saveWebPage(db, "https://a/", "A", "text");
    saveWebImage(db, "https://a/i.png", "image/png", Buffer.from("xx"));
    putWebSearch(db, "pizza", [hit("https://a/")]);

    expect(browserJournal(deps).map((r) => r.detail)).toEqual(["two", "one"]);
    expect(browserJournal(deps, 1).map((r) => r.detail)).toEqual(["two"]);
    expect(browserClearScope(deps)).toEqual({ journal: 2, searches: 1, pages: 1, images: 1 });

    browserClearJournal(deps);

    expect(browserJournal(deps)).toEqual([]);
    expect(browserClearScope(deps)).toEqual({ journal: 0, searches: 0, pages: 0, images: 0 });
    db.close();
  });

  it("refuses all three when no room is open", () => {
    const { browser } = harness(null);
    const deps = baseDeps(null, browser);
    expect(() => browserJournal(deps)).toThrow("No room is open.");
    expect(() => browserClearScope(deps)).toThrow("No room is open.");
    expect(() => browserClearJournal(deps)).toThrow("No room is open.");
  });
});

describe("browserVerifyPrivate / browserRetryProtection", () => {
  it("ask the real Browser, and refuse when it is not open", async () => {
    const db = freshRoom();
    const { browser } = harness(db);
    const deps = baseDeps(db, browser);
    await expect(browserVerifyPrivate(deps)).rejects.toThrow("The browser isn't open.");
    await browserNavigate(deps, "example.com");
    expect(await browserVerifyPrivate(deps)).toBe(true);
    expect(() => browserRetryProtection(deps)).not.toThrow();
    db.close();
  });

  it("report a browser whose storage is not ephemeral rather than asserting privacy", async () => {
    const browser = fakeBrowser({ verifyEphemeral: () => false });
    expect(await browserVerifyPrivate(baseDeps(null, browser))).toBe(false);
  });
});
