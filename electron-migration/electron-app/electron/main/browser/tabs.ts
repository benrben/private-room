// BROWSE-1: the in-memory tab/sitting ledger.
//
// Port of the state half of src-tauri/src/browser.rs — `Page`, `BrowserState`'s
// tab bookkeeping (`add_page`/`drop_page`, the session minting), `heir_after`,
// `page_title`/`page_label`, `record_url`/`record_active_url`/
// `record_active_title`, `tab_list`, `is_blank`, `Bounds::sane`, `now_iso`.
//
// Deliberately Electron-free: everything here is plain data, so it is unit
// tested exactly the way the Rust `#[cfg(test)]` module tests
// `BrowserState::default()`. webviewManager.ts/browser.ts own the live views.
//
// ATOMICITY: Rust needs a `Mutex` so two pages opened at once join ONE sitting
// rather than minting two. Node's main process is single-threaded per
// event-loop turn, so that falls out for free as long as nothing here `await`s
// between reading and writing `tabs` — and nothing does.
//
// WHAT IS DELIBERATELY NOT PORTED: `deferred_since`, `ThenGo`,
// `should_go_after_rules`, `blocker_not_on_yet`/`awaits_blocker`,
// `deferral_is_live`/`DEFER_GRACE`, `navigation_deferred`. Every one of those
// exists to survive `WKContentRuleListStore`'s ASYNCHRONOUS compile: the rule
// list cannot be attached until after the webview exists, the compile can take
// an unbounded time, and WebKit can drop its completion handler entirely — so
// the page is parked on `about:blank` and the real navigation is deferred.
// Chromium has no compile step: `session.webRequest.onBeforeRequest` is
// registered synchronously on the session BEFORE the view is ever told to load
// anything (see webviewManager.ts's ordering and contentBlocking.ts's header),
// and a `WebContentsView` fetches nothing until `loadURL`. There is nothing to
// defer FOR, and carrying a wait for an event that already happened would be
// dead machinery pretending to be a safety net. `START_BLANK` itself IS kept:
// `classifyReady` still has to tell "the blank start document" apart from "the
// user really did ask for a blank tab".

import type { BrowserTab } from "../../shared/apiTypes.js";
import { isRecordableUrl, stripWww } from "./navGuard.js";
import type { Protection } from "./protection.js";
import { UNKNOWN_PROTECTION } from "./protection.js";

/**
 * How many pages may be open at once. Each is a real renderer holding a real
 * render tree. The cap REFUSES a ninth page rather than quietly closing one the
 * user was reading: a silently discarded page is exactly the kind of surprise
 * the rest of this app goes out of its way not to spring.
 */
export const MAX_TABS = 8;

/** A page that has not been anywhere yet, and the document every view starts
 *  on. It fetches nothing. */
export const START_BLANK = "about:blank";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a page that is not showing goes. PARKED, never closed — closing
 *  destroys the non-persistent session and races the agent. */
export const PARKED: Bounds = { x: 0, y: 0, width: 1, height: 1 };

/** A view with a zero (or negative) dimension is rejected by the platform;
 *  clamp to something small but legal. Port of `Bounds::sane`. */
export function saneBounds(b: Bounds): Bounds {
  return {
    x: Math.max(b.x, 0),
    y: Math.max(b.y, 0),
    width: Math.max(b.width, 1),
    height: Math.max(b.height, 1),
  };
}

/**
 * One open page, as this process tracks it.
 *
 * `url` is RECORDED here rather than read back from the live view. On the Tauri
 * side that was survival: wry's `url_from_webview` unwraps `WKWebView.URL`,
 * nil on a page with no committed document, and asking aborted the whole
 * process (SIGABRT, crash report 2026-07-31 22:58). Electron's
 * `webContents.getURL()` merely returns `""` there — but the invariant is kept
 * anyway, because it is what makes "an iframe's `about:blank` overwrote the
 * page's record" impossible by construction rather than by vigilance.
 */
export interface Page {
  id: string;
  url: string;
  title: string;
  protection: Protection;
}

/** A short, honest label for a page before its `<title>` is known: the host.
 *  Port of `page_title`. */
export function pageTitle(url: string): string {
  try {
    const host = stripWww(new URL(url).hostname);
    if (host) return host;
  } catch {
    // unparseable — falls through to the placeholder, same as Rust's `.ok()`
  }
  return "New page";
}

/**
 * What one row in the strip is called: the document's own title while it is
 * known, else the host, else "New page". Port of `page_label`.
 *
 * Three fallbacks because all three states are real and the reader can tell
 * them apart. The row said "New page" over a loaded example.com because the
 * only one of the three ever consulted was the last resort.
 */
export function pageLabel(title: string, url: string): string {
  const named = title.trim();
  if (named) return named;
  return pageTitle(url);
}

/**
 * Which page shows after the one at `at` was removed from `remaining`: the
 * neighbour to the right, else the left, else nothing. Port of `heir_after`.
 *
 * The frontend tab strip picks its heir by the identical rule and the two MUST
 * agree — if they disagree the page on screen is not the tab highlighted in the
 * strip, which is the worst kind of UI bug because everything still looks like
 * it is working.
 *
 * Written out by hand rather than with `Array.prototype.at()`: a negative index
 * in JS wraps to count from the END of the array, which is NOT what Rust's
 * `index.wrapping_sub(1)` does (it wraps to `usize::MAX`, always out of
 * bounds). WHERE THAT ACTUALLY BITES, stated precisely because the obvious
 * guess is wrong: it is NOT the fall-left step. `at - 1` can only be negative
 * when `at` is 0, and `at === 0` only falls left when `remaining` is empty —
 * where `[].at(-1)` is `undefined` too. So for every NON-NEGATIVE `at` the two
 * spellings agree exactly. They diverge on a NEGATIVE `at`, where `.at()`
 * resurrects a tab counted from the END: `.at(-1)` of `["a","b","c"]` is `"c"`.
 * `dropPage` maps "not found" to `null` rather than to `-1` precisely so that
 * value never reaches here — and the frontend tab strip, which runs this same
 * rule against its own index, gets the same refusal rather than a wrong tab.
 * Pinned in tabs.test.ts against the `.at()` spelling, which is the only form
 * of the test that can fail.
 */
export function heirAfter(remaining: readonly string[], at: number | null): string {
  if (at === null) return "";
  if (at >= 0 && at < remaining.length) return remaining[at] as string;
  const left = at - 1;
  if (left >= 0 && left < remaining.length) return remaining[left] as string;
  return "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A browsing sitting's id: the wall clock it began at, plus a counter so two
 * sittings inside one second are still two. Port of `mint_session_id`.
 *
 * It must be unique against rows written by EARLIER RUNS of the app — journal
 * lines outlive the process, and a bare counter would restart at 0 and label
 * last week's browsing as part of this sitting.
 */
export function mintSessionId(nth: number, now: Date = new Date()): string {
  const stamp =
    String(now.getFullYear()) +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds());
  return `${stamp}-${nth}`;
}

/** Local timestamp in the shape browser.rs's `now_iso` produces
 *  (`%Y-%m-%dT%H:%M:%S`: no offset, no fractional seconds). */
export function nowIso(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  );
}

/**
 * The tab/sitting bookkeeping half of `BrowserState`. Anything that touches a
 * live view is a parameter or the caller's job, mirroring how `tab_list`
 * filters `tabs` against `webview_of(...)` rather than this module knowing what
 * a view is.
 */
export class TabRegistry {
  private tabs: Page[] = [];
  private activeTab = "";
  private nextIdCounter = 0;
  private sessionValue = "";
  private nextSessionCounter = 0;

  /** Page ids are never reused within a room, so a stale frontend reference
   *  resolves to "gone" instead of to somebody else's page. */
  nextId(): string {
    const id = String(this.nextIdCounter);
    this.nextIdCounter += 1;
    return id;
  }

  count(): number {
    return this.tabs.length;
  }

  /** Take a freshly built page into the records, opening a browsing sitting if
   *  it is the first one. Port of `BrowserState::add_page`. */
  addPage(page: Page): void {
    if (this.tabs.length === 0) {
      this.sessionValue = mintSessionId(this.nextSessionCounter);
      this.nextSessionCounter += 1;
    }
    this.tabs.push(page);
  }

  /**
   * Forget a page, ending the sitting with the last one. Answers where the page
   * was and what is left, which is what the heir rule reads. Port of
   * `BrowserState::drop_page`.
   */
  dropPage(id: string): { at: number | null; remaining: string[] } {
    const found = this.tabs.findIndex((p) => p.id === id);
    this.tabs = this.tabs.filter((p) => p.id !== id);
    // The sitting ends with the last page: whatever is browsed next started
    // after a gap the user can see in their own record.
    if (this.tabs.length === 0) this.sessionValue = "";
    return { at: found === -1 ? null : found, remaining: this.tabs.map((p) => p.id) };
  }

  get active(): string {
    return this.activeTab;
  }

  setActive(id: string): void {
    this.activeTab = id;
  }

  find(id: string): Page | undefined {
    return this.tabs.find((p) => p.id === id);
  }

  ids(): string[] {
    return this.tabs.map((p) => p.id);
  }

  all(): readonly Page[] {
    return this.tabs;
  }

  /** One page's own record of where it was last sent. `undefined` while the tab
   *  is still being built. Port of `recorded_url`. */
  recordedUrl(id: string): string | undefined {
    return this.find(id)?.url;
  }

  /**
   * Remember where a page went. A recorded title belongs to the URL it was read
   * from, so moving the page DROPS it — keeping it would leave the last site's
   * name over the next one for exactly as long as a reader is looking to see
   * where they have landed. Port of `record_url`.
   */
  recordUrl(id: string, url: string): void {
    const page = this.find(id);
    if (!page) return;
    if (page.url !== url) page.title = "";
    page.url = url;
  }

  /** Correct the ACTIVE page's record from the page script's own
   *  `location.href` — the main frame's authoritative answer. Port of
   *  `record_active_url`. */
  recordActiveUrl(url: string): void {
    const id = this.activeTab;
    if (!id) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!isRecordableUrl(parsed)) return;
    this.recordUrl(id, url);
  }

  /** The showing page's own `<title>`, as the info poll just read it. An empty
   *  answer is not written — a document that has not set a title yet must fall
   *  back to the host, not blank the row it already filled in. Port of
   *  `record_active_title`. */
  recordActiveTitle(title: string): void {
    const named = title.trim();
    if (!named) return;
    const page = this.find(this.activeTab);
    if (page) page.title = named;
  }

  setProtection(id: string, verdict: Protection): void {
    const page = this.find(id);
    if (page) page.protection = verdict;
  }

  /** The browsing sitting the journal is currently writing into, `""` between
   *  sittings. Port of `session_id`. */
  sessionId(): string {
    return this.sessionValue;
  }

  /** Does our own record say the showing tab has not been anywhere? Port of
   *  `is_blank`. */
  isBlank(): boolean {
    const url = this.recordedUrl(this.activeTab);
    return url === undefined || url === START_BLANK;
  }

  /** Every open page, in strip order. `isOpen` is the caller's "does a live
   *  view still back this id" predicate — mirrors `tab_list`'s
   *  `webview_of(app, id).is_some()` filter, so a ledger entry can never
   *  outlive the thing it describes. */
  tabList(isOpen: (id: string) => boolean): BrowserTab[] {
    return this.tabs
      .filter((p) => isOpen(p.id))
      .map((p) => ({
        id: p.id,
        title: pageLabel(p.title, p.url),
        url: p.url,
        active: p.id === this.activeTab,
      }));
  }

  /** Close every page — room close and app quit. Port of `close`'s state
   *  half. */
  closeAll(): void {
    this.tabs = [];
    this.activeTab = "";
    this.sessionValue = "";
  }
}

export { UNKNOWN_PROTECTION };
export type { Protection };
