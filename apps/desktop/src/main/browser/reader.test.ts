/**
 * Port of `src-tauri/src/commands/browse/reader.rs`'s `#[cfg(test)] mod
 * tests`:
 *
 *  - a_parked_page_is_refused_rather_than_read
 *  - a_narrow_but_real_stage_is_readable
 *  - a_full_width_but_flattened_stage_is_still_refused
 *  - nothing_selected_is_an_empty_answer_not_a_refusal
 *  - a_long_selection_is_cut_at_the_reading_cap_and_admits_it
 *
 * plus coverage of the two readers against the REAL, already-ported `Browser`
 * class over the page-factory seam `browser.test.ts` established — so the
 * settle loop, the readiness wait and the page-script round trip are the real
 * ones, not a hand-rolled stand-in for the whole browser core.
 *
 * INCLUDING both of Rust's `browser::PAGE_JS` assertions, which read the page
 * script for a literal this module depends on by VALUE. `pageScript.test.ts`
 * pins the bridge's own names, not these two — and neither constant is safe to
 * leave unpinned: one is a message this file recognises by exact text, the
 * other is a cap that has to stay equal to the page's own. Both are read off
 * the same `page.js` the real browser loads (`PAGE_SCRIPT_PATH`).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { BrowseJournalRow } from "../../shared/apiTypes.js";
import { Browser, WAIT_READY_BUDGET_MS, type BrowserDeps } from "./browser.js";
import { PAGE_SCRIPT_PATH } from "./pageScript.js";
import type { Bounds } from "./tabs.js";
import type { CreatePageDeps, LivePage, WindowContentView } from "./webviewManager.js";
import {
  BOUNDS_SETTLE_MS,
  MIN_READABLE_PX,
  NOTHING_SELECTED,
  PARKED_REFUSAL,
  SELECTION_MAX,
  browserFocusApp,
  browserPageSelection,
  browserPageText,
  clipSelection,
  emptySelection,
  readyToBeRead,
  tooSmallToRead,
} from "./reader.js";

function opOf(js: string): string {
  return /\.call\("([a-zA-Z]+)"/.exec(js)?.[1] ?? "";
}

/** The real `Browser`, over a fake page factory that only answers page-script
 *  ops — `browser.test.ts`'s own seam. */
function harness(answer: (op: string) => unknown = () => ({ ok: true })) {
  const windowContentView: WindowContentView = { addChildView() {}, removeChildView() {} };
  const createPage = (id: string, _pageDeps: CreatePageDeps): LivePage =>
    ({
      id,
      view: { setBounds() {} },
      contents: {
        isDestroyed: () => false,
        close() {},
        loadURL: async () => {},
        executeJavaScript: async (js: string) => JSON.stringify(answer(opOf(js))),
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
    journalSink: { db: null, emit: (_row: BrowseJournalRow) => {} },
    emit: () => {},
    stagingDir: () => "/tmp/arcelle-browse-downloads",
    ensureStagingDir: () => {},
    removeStagedFile: async () => {},
    removeStagingDir: async () => {},
    importFinishedDownload: async (_p, name) => ({ name }),
    createPage,
  };
  return new Browser(deps);
}

const REAL_BOUNDS: Bounds = { x: 0, y: 0, width: 1200, height: 800 };

/** The page script the real browser actually loads — the same file both Rust
 *  assertions below read. */
const PAGE_JS = readFileSync(PAGE_SCRIPT_PATH, "utf8");

describe("the two constants this module shares with the page script", () => {
  /**
   * Port of the `PAGE_JS.contains(NOTHING_SELECTED)` assertion in
   * `reader.rs::nothing_selected_is_an_empty_answer_not_a_refusal`.
   *
   * "Nothing is selected" reaches this side as the page script's `ok: false`,
   * which `Browser.call` turns into a rejection — so the ONE error that means
   * "the user has not selected anything" has to be recognised by its exact
   * text and converted. A reword on either side turns an empty selection back
   * into a page failure, silently, with nothing else to notice it.
   */
  it("the page script still says the words browserPageSelection listens for", () => {
    expect(
      PAGE_JS.includes(NOTHING_SELECTED),
      "the page script no longer says what browserPageSelection listens for — an " +
        "empty selection would surface as a page failure",
    ).toBe(true);
  });

  /**
   * Port of the `PAGE_JS.contains("var READ_MAX = …")` assertion in
   * `reader.rs::a_long_selection_is_cut_at_the_reading_cap_and_admits_it`.
   *
   * The selection cap is the READER's cap, borrowed rather than invented: this
   * feeds a chat scope, not a room file, so it takes the same slice size one
   * `read` returns. Nothing else holds the two numbers together.
   */
  it("SELECTION_MAX is still the page script's own READ_MAX, not a second number", () => {
    expect(
      PAGE_JS.includes(`var READ_MAX = ${SELECTION_MAX}`),
      "the selection cap has drifted from the page script's read cap",
    ).toBe(true);
  });
});

describe("tooSmallToRead", () => {
  it("refuses a parked 1×1 page and a flattened one, but not a narrow real stage", () => {
    // What the browser area sends while a modal is up, and what this process
    // falls back to before the area has ever measured itself.
    expect(tooSmallToRead({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    // Height matters as much as width: a stage collapsed to a sliver reflows
    // the page just as badly.
    expect(tooSmallToRead({ x: 0, y: 0, width: 1200, height: 4 })).toBe(true);
    // The reading view SHRINKS the stage instead of parking it, so the page
    // keeps a real layout viewport — that has to stay on the readable side of
    // the line, or the reader would refuse to read the very page it just made
    // room for.
    expect(tooSmallToRead({ x: 0, y: 0, width: 300, height: 600 })).toBe(false);
  });

  it("puts the floor exactly at MIN_READABLE_PX on both axes", () => {
    expect(tooSmallToRead({ x: 0, y: 0, width: MIN_READABLE_PX, height: MIN_READABLE_PX })).toBe(
      false,
    );
    expect(tooSmallToRead({ x: 0, y: 0, width: MIN_READABLE_PX - 1, height: 999 })).toBe(true);
    expect(tooSmallToRead({ x: 0, y: 0, width: 999, height: MIN_READABLE_PX - 1 })).toBe(true);
  });
});

describe("readyToBeRead / browserPageText", () => {
  it("refuses when the browser isn't open at all", async () => {
    await expect(readyToBeRead(harness())).rejects.toThrow(
      "The browser isn't open — there is no page to read.",
    );
  });

  it("waits out a settling rect and then reads, once it arrives", async () => {
    const browser = harness((op) => (op === "read" ? { ok: true, text: "hello" } : { ok: true }));
    browser.newTab("https://example.com/");
    // Parked (1×1) at first — the reader's very first read can land here while
    // the frontend's real rect is still in flight, and refusing then would
    // fail the one case this feature exists for.
    let polls = 0;
    const result = await browserPageText(browser, "main", 0, {
      sleep: async () => {
        polls += 1;
        if (polls === 2) browser.setBounds(REAL_BOUNDS);
      },
      now: () => 0,
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({ ok: true, text: "hello" });
  });

  /**
   * The helper promises THREE things — there is a page, it is on screen at a
   * real size, and its script is up — and only the first two were pinned. The
   * third is the whole reason `read` can be believed: a page whose script has
   * not come up answers nothing, and the reading view would render that as a
   * page with no text rather than as a page that is not ready yet.
   */
  it("waits for the page script, not just for the rect", async () => {
    let waited: number | undefined = -1;
    const browser = {
      isOpen: () => true,
      bounds: () => REAL_BOUNDS,
      waitReady: async (budgetMs?: number) => {
        waited = budgetMs;
      },
      call: async () => ({ ok: true }),
    };
    await readyToBeRead(browser);
    // …on the budget for a page that is ALREADY open, not the longer
    // freshly-opened one.
    expect(waited).toBe(WAIT_READY_BUDGET_MS);

    // …and a script that never comes up fails the read rather than letting it
    // report on a page it could not reach.
    await expect(
      readyToBeRead({
        ...browser,
        waitReady: async () => {
          throw new Error("The page did not answer in time.");
        },
      }),
    ).rejects.toThrow("The page did not answer in time.");
  });

  it("refuses with PARKED_REFUSAL once the settle budget elapses with no real rect", async () => {
    const browser = harness();
    browser.newTab("https://example.com/");
    let t = 0;
    await expect(
      browserPageText(browser, "main", 0, { sleep: async () => void (t += 100), now: () => t }),
    ).rejects.toThrow(PARKED_REFUSAL);
    expect(t).toBeGreaterThan(BOUNDS_SETTLE_MS);
  });

  it("passes mode and offset to the page's read op, defaulting an unknown mode to main", async () => {
    const scripts: string[] = [];
    const browser = harness(() => ({ ok: true }));
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    const page = browser as unknown as {
      pages: Map<string, { contents: { executeJavaScript(js: string): Promise<string> } }>;
    };
    for (const p of page.pages.values()) {
      const original = p.contents.executeJavaScript.bind(p.contents);
      p.contents.executeJavaScript = async (js: string) => {
        scripts.push(js);
        return original(js);
      };
    }
    await browserPageText(browser, "bogus", 40);
    const read = scripts.find((js) => js.includes('"read"'));
    expect(read).toContain('{"mode":"main","offset":40}');

    await browserPageText(browser, "full", 0);
    expect(scripts.some((js) => js.includes('{"mode":"full","offset":0}'))).toBe(true);
  });
});

describe("browserPageSelection", () => {
  /** Nothing selected is an ANSWER, not a failure. It reaches this side as the
   * page script's `ok:false`, which `Browser.call` turns into a throw — so the
   * one error that means "the user has not selected anything" has to be
   * recognised and converted, and the two sides must keep saying the same
   * words. Everything else the page refuses still fails, which is how the
   * caller tells "nothing selected" from "this page cannot be read". */
  it("turns the page's own 'nothing selected' answer into an empty result", async () => {
    const browser = harness((op) =>
      op === "capture" ? { ok: false, error: NOTHING_SELECTED } : { ok: true },
    );
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    expect(await browserPageSelection(browser)).toEqual(emptySelection());
  });

  it("still fails for a page that genuinely refuses the read", async () => {
    const browser = harness((op) =>
      op === "capture"
        ? { ok: false, error: "This page will not run the assistant's page script." }
        : { ok: true },
    );
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    await expect(browserPageSelection(browser)).rejects.toThrow(/will not run/);
  });

  it("carries a real selection through with the page's own total", async () => {
    const browser = harness((op) =>
      op === "capture"
        ? {
            ok: true,
            text: "a short passage",
            url: "https://example.com/",
            title: "Example",
            truncated: false,
            total: 16,
          }
        : { ok: true },
    );
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    expect(await browserPageSelection(browser)).toEqual({
      text: "a short passage",
      url: "https://example.com/",
      title: "Example",
      truncated: false,
      total: 16,
    });
  });

  it("carries the page's own truncation flag even when what arrived is short", async () => {
    const browser = harness((op) =>
      op === "capture"
        ? { ok: true, text: "tiny", url: "https://e/", title: "T", truncated: true, total: 900_000 }
        : { ok: true },
    );
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    const sel = await browserPageSelection(browser);
    expect(sel.truncated).toBe(true);
    expect(sel.total).toBe(900_000);
  });

  it("falls back to counting what it has when the page reports no total", async () => {
    const browser = harness((op) =>
      op === "capture" ? { ok: true, text: "abc" } : { ok: true },
    );
    browser.newTab("https://example.com/");
    browser.setBounds(REAL_BOUNDS);
    expect(await browserPageSelection(browser)).toEqual({
      text: "abc",
      url: "",
      title: "",
      truncated: false,
      total: 3,
    });
  });
});

describe("emptySelection", () => {
  it("has the same shape a real answer does, so no caller branches on which it got", () => {
    const empty = emptySelection();
    expect(empty).toEqual({ text: "", url: "", title: "", truncated: false, total: 0 });
    for (const key of ["text", "url", "title", "truncated", "total"]) {
      expect(key in empty).toBe(true);
    }
  });
});

describe("clipSelection", () => {
  it("cuts at the reading cap and admits it, on code point boundaries", () => {
    expect(clipSelection("a short passage", false)).toEqual({
      text: "a short passage",
      clipped: false,
    });
    // Exactly at the cap is NOT truncated — the boundary case that would
    // otherwise warn about a passage that came back whole.
    const exact = clipSelection("x".repeat(SELECTION_MAX), false);
    expect([...exact.text]).toHaveLength(SELECTION_MAX);
    expect(exact.clipped).toBe(false);
    // One character past it is.
    const over = clipSelection("x".repeat(SELECTION_MAX + 1), false);
    expect([...over.text]).toHaveLength(SELECTION_MAX);
    expect(over.clipped).toBe(true);
    // The page's own clip counts too, even when what arrived is short.
    expect(clipSelection("tiny", true).clipped).toBe(true);
    // Multi-byte text is cut on CODE POINT boundaries — slicing UTF-16 units
    // would split the first emoji anyone selects.
    const wide = clipSelection("é🙂".repeat(SELECTION_MAX), false);
    expect([...wide.text]).toHaveLength(SELECTION_MAX);
    expect(wide.clipped).toBe(true);
    expect(wide.text.endsWith("\ud83d")).toBe(false);
  });
});

describe("browserFocusApp", () => {
  it("focuses the app's own window", () => {
    const focus = vi.fn();
    browserFocusApp({ focus });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("refuses when the app window is gone, rather than silently doing nothing", () => {
    expect(() => browserFocusApp(null)).toThrow("The app window is gone.");
  });
});
