/**
 * BROWSE-1: the browser area's chrome. Port of the Tauri-command half of
 * `src-tauri/src/commands/browse.rs` — the sixteen `browser_*` commands the
 * tab strip, toolbar, address bar, shield and Journal panel drive.
 *
 * NOT the six `browse_*` AGENT tools (`browse_open`, `browse_read`,
 * `browse_find`, `browse_snapshot`, `browse_do`, `browse_look`, `browse_save`)
 * and none of `exec_browse`/`classify_browse_open`/`format_snapshot`/
 * `format_read`/`format_act`/the outbound-consent door. That is the
 * model-facing tool-exec layer, a surface of its own, and `execTool.ts`
 * already stubs it `NOT_IMPLEMENTED` pending its own batch.
 *
 * Every command here is a THIN orchestration layer over the already-ported
 * `Browser` class (browser.ts) and the db layer behind it; nothing about
 * browser state is reimplemented. {@link ChromeBrowser} is the exact public
 * surface `Browser` already exposes, so a real instance satisfies it with no
 * adapter and a test can drive either.
 *
 * NO IPC WIRING. Per this migration's own rules the preload/ipcMain registry
 * (Phase 2) needs an explicit owner go-ahead before touching the shipping
 * app's renderer, so these are plain, directly-callable functions registered
 * on no channel. A later batch does that wiring.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type {
  BrowseClearScope,
  BrowseJournalRow,
  BrowserInfo,
  BrowserProtection,
  BrowserTab,
} from "../../shared/apiTypes.js";
import type { Bounds } from "./tabs.js";
import { EVAL_LOST, evalLostToNavigation } from "./readiness.js";
import { requireWebEnabled } from "./webAccess.js";
import { browseGuardUrl } from "./browseGuard.js";
import {
  browseClearScope as readClearScope,
  clearBrowseJournal as wipeBrowseJournal,
  listBrowseJournal,
} from "./browseJournal.js";
import { clearWebCache } from "../db-host/webCache.js";
import { captureAndSave } from "./saved.js";

/**
 * The exact public surface of `Browser` (browser.ts) this file needs —
 * structural, so a real `Browser` satisfies it with no adapter and a test fake
 * only has to implement what it actually exercises.
 */
export interface ChromeBrowser {
  takeover: boolean;
  isOpen(): boolean;
  isBlank(): boolean;
  ensure(url: string): void;
  newTab(url: string): string;
  selectTab(id: string): void;
  closeTab(id: string): void;
  close(): void;
  tabList(): BrowserTab[];
  setBounds(b: Bounds): void;
  protection(): BrowserProtection;
  retryProtection(): void;
  verifyEphemeral(): boolean;
  sessionId(): string;
  activeUrl(): string | undefined;
  recordActiveUrl(url: string): void;
  recordActiveTitle(title: string): void;
  journal(kind: string, url: string, detail: string): void;
  call(op: string, args?: unknown): Promise<unknown>;
  eval(js: string): Promise<unknown>;
}

/**
 * What the chrome commands work against.
 *
 * `db` is nullable because Rust reaches the room through
 * `state.room.lock()...ok_or("No room is open.")` — a browser can be open on
 * the start screen with no room behind it, and that refusal is a different
 * fact from "the internet switch is off".
 *
 * The three save hooks are threaded straight through to `captureAndSave`; see
 * `saved.ts` for why they are required rather than optional.
 */
export interface BrowseCommandsDeps {
  browser: ChromeBrowser;
  db: Database.Database | null;
  /** The open room's path on disk, for `scheduleAutoIndex`. */
  roomPath: string;
  scheduleAutoIndex(roomPath: string): void;
  schedulePrivacyScan(): void;
  emitFilesChanged(): void;
}

/** The room the command needs, or the refusal Rust gives when there is none. */
function requireRoom(db: Database.Database | null): Database.Database {
  if (!db) {
    throw new Error("No room is open.");
  }
  return db;
}

/** A bare host/domain typed with no scheme, exactly as the address bar and
 *  `browser_navigate`/`browser_new_tab` both fill one in. */
function withDefaultScheme(url: string): string {
  return url.includes("://") ? url : `https://${url}`;
}

// ---------------------------------------------------------------------------
// Navigation / tabs
// ---------------------------------------------------------------------------

/** The address bar's Enter. Port of `browser_navigate`. */
export async function browserNavigate(deps: BrowseCommandsDeps, url: string): Promise<string> {
  requireWebEnabled(deps.db);
  const checked = await browseGuardUrl(withDefaultScheme(url.trim()));
  deps.browser.ensure(checked);
  deps.browser.journal("open", checked, "Opened by the user");
  return checked;
}

/** Port of `browser_close`. */
export function browserClose(deps: BrowseCommandsDeps): void {
  deps.browser.close();
}

/**
 * BROWSE-2: the toolbar's Save page / Save selection. The SAME
 * capture-and-save path as the agent's `browse_save` tool (D22, one code
 * path). No web gate: this reads the ALREADY-LOADED page — nothing is fetched,
 * and no page can exist in a room whose internet switch was off when it was
 * opened. Port of `browser_save_page`.
 */
export async function browserSavePage(deps: BrowseCommandsDeps, what: string): Promise<string> {
  return captureAndSave(
    { ...deps, db: requireRoom(deps.db) },
    what === "selection" ? "selection" : "page",
  );
}

/**
 * Open a page in a NEW tab. Same guard as {@link browserNavigate} — a new tab
 * is still a navigation, and the address it is given gets the identical check.
 * Port of `browser_new_tab`.
 */
export async function browserNewTab(deps: BrowseCommandsDeps, url: string): Promise<string> {
  requireWebEnabled(deps.db);
  const trimmed = url.trim();
  // An empty new tab is the view's own idle document, not a destination —
  // nothing is fetched, so there is nothing for the URL guard to check.
  const checked =
    trimmed === "" ? "about:blank" : await browseGuardUrl(withDefaultScheme(trimmed));
  const id = deps.browser.newTab(checked);
  deps.browser.journal("open", checked, "Opened by the user in a new tab");
  return id;
}

/** Port of `browser_select_tab`. */
export function browserSelectTab(deps: BrowseCommandsDeps, id: string): void {
  deps.browser.selectTab(id);
}

/** Port of `browser_close_tab`. */
export function browserCloseTab(deps: BrowseCommandsDeps, id: string): void {
  deps.browser.closeTab(id);
}

/** Port of `browser_tabs`. */
export function browserTabs(deps: BrowseCommandsDeps): BrowserTab[] {
  return deps.browser.tabList();
}

/** Port of `browser_set_bounds`. */
export function browserSetBounds(deps: BrowseCommandsDeps, bounds: Bounds): void {
  deps.browser.setBounds(bounds);
}

// ---------------------------------------------------------------------------
// browser_info — the toolbar's live poll
// ---------------------------------------------------------------------------

/**
 * What the toolbar may be told about a page with a navigation in flight: it is
 * LOADING, and nothing it just said about itself is news.
 *
 * Neither half of the page's answer describes the page the user asked for
 * while that is true. A SUCCESS describes the document being navigated away
 * from, so `ready` would be `"complete"` for a page that has not begun
 * loading. A FAILURE is the round trip the navigation itself interrupted,
 * which the toolbar rendered as "This page is not answering" over a page that
 * was loading perfectly well — with Reload as the only cure.
 *
 * ONE WAIT REACHES THIS, not Rust's two. Rust also defers a navigation behind
 * `WKContentRuleListStore`'s asynchronous rule compile (`navigation_deferred`);
 * Electron's content blocker attaches synchronously before the view is ever
 * told to load anything (see `tabs.ts`'s and `contentBlocking.ts`'s headers),
 * so there is no compile to wait on and that half is deliberately not ported.
 * The wait that remains is every ordinary navigation, which is the one the
 * user meets first and most often. Port of `reportable_page_state`.
 */
export function reportablePageState(
  midNavigation: boolean,
  ready: unknown,
  error: string | undefined,
): { ready: unknown; error: string | undefined } {
  if (midNavigation) {
    return { ready: false, error: undefined };
  }
  return { ready, error };
}

/** The browser area's live poll, assembling protection / sitting / address /
 *  readiness into one answer. Port of `browser_info`. */
export async function browserInfo(deps: BrowseCommandsDeps): Promise<BrowserInfo> {
  const { browser } = deps;
  if (!browser.isOpen()) {
    return { open: false };
  }

  let info: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    const answered = await browser.call("info", {});
    if (answered !== null && typeof answered === "object") {
      info = answered as Record<string, unknown>;
    }
  } catch (e) {
    // The reason the page did not answer used to be written into a local and
    // then dropped, so the poll returned nulls, the address bar kept showing
    // the last URL it knew, and a page that had stopped answering looked
    // exactly like one that was fine. Hand the reason back.
    error = e instanceof Error ? e.message : String(e);
  }

  // A lost round trip IS a navigation — the same evidence the readiness probe
  // already reads that way, applied to the poll that reports it.
  const navigating = error !== undefined && evalLostToNavigation(error);
  const reported = reportablePageState(navigating, info.ready ?? null, error);

  // The page script answers for the MAIN frame, so this is the authoritative
  // "where is this page" — write it back so a record corrupted by a sub-frame
  // navigation heals on the next poll instead of persisting as a wrong tab
  // title (or, before `isRecordableUrl`, a vanished page).
  if (typeof info.url === "string") {
    browser.recordActiveUrl(info.url);
  }
  // …and what the page calls itself, from the same answer. The strip was
  // labelled from the URL alone, so a page the toolbar was already calling
  // "Example Domain" sat in the sidebar as "New page" — one poll carrying both
  // facts, one of them thrown away. Written AFTER the URL: a move clears the
  // old title, and this is the new one.
  if (typeof info.title === "string") {
    browser.recordActiveTitle(info.title);
  }

  // With no answer from the page, our own RECORD of where this page was sent
  // is the only honest address there is. Better than a null the view falls
  // back to its last known value for, and better than flashing the idle
  // document in the bar the user just typed a destination into.
  const url = typeof info.url === "string" ? info.url : (browser.activeUrl() ?? null);

  const out: BrowserInfo = {
    open: true,
    // Recorded, not read from the page script — a blank page runs no script.
    blank: browser.isBlank(),
    // What the content blocker DID, worst page first. The shield used to read
    // "Trackers blocked." off the STORAGE check, which knows nothing about the
    // rule list.
    protection: browser.protection(),
    // The browsing sitting the journal is writing into — empty when none is
    // live — so the Journal can tell this sitting from the earlier ones.
    session: browser.sessionId(),
    url,
    title: typeof info.title === "string" ? info.title : null,
    ready: reported.ready as string | boolean | null,
    takeover: browser.takeover,
    // Item #18: the page latches a double Escape and reports it here, once.
    // This poll is the ONLY channel out of the native layer, so the flag has
    // to ride the state the chrome already asks for.
    leaveRequested: info.leaveRequested === true,
    // Whether a passage is selected on the page, so the assistant's scope
    // strip can OFFER a "selected passage" scope only when there is one.
    hasSelection: info.hasSelection === true,
  };
  // Present ONLY when there is a reason, so the field means what `apiTypes.ts`
  // declares it to mean (`error?: string`). A `null` on every poll is not an
  // optional field, it is a null one — and the view would have to know the
  // difference for no gain.
  if (reported.error !== undefined) {
    out.error = reported.error;
  }
  return out;
}

// ---------------------------------------------------------------------------
// browser_go — back / forward / reload / stop
// ---------------------------------------------------------------------------

/**
 * What one chrome action runs, and whether it puts the browser back on the
 * network.
 *
 * Back, forward and reload all issue a real load, so a room whose internet
 * switch reads "Off — room stays offline" must refuse them exactly like the
 * address bar does. `stop` only CANCELS a load, which is always allowed —
 * refusing it would mean the one control that takes a room offline faster than
 * anything else stopped working the moment you turned the room offline. Port
 * of `browser_go_js`.
 */
export function browserGoJs(action: string): [js: string, goesOnline: boolean] {
  switch (action) {
    case "back":
      return ["history.back()", true];
    case "forward":
      return ["history.forward()", true];
    case "reload":
      return ["location.reload()", true];
    case "stop":
      return ["window.stop()", false];
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

/**
 * The expression actually evaluated on the page, and the one place this port
 * has to differ from Rust's plain `wv.eval(js)`.
 *
 * The Electron wire is JSON TEXT: the real eval host sends
 * `JSON.stringify(<expr>)` and `evalJson` parses what comes back (see
 * evalBridge.ts's header for why that reproduces wry's contract rather than
 * structured-cloning). All four actions above evaluate to `undefined`, and
 * `JSON.stringify(undefined)` is not a string at all — which `evalJson` reads,
 * correctly, as "the page script is not present on this document". Routed
 * through the bridge unchanged, every Back, Forward, Reload and Stop would
 * come back as the page refusing the script.
 *
 * The comma expression makes the round trip carry a value. The ACTION is still
 * character-for-character the JS Rust runs — {@link browserGoJs} is what says
 * so, and is pinned on its own.
 */
export function chromeActionScript(js: string): string {
  return `(${js}, true)`;
}

/** back / forward / reload / stop, driven from the chrome. Port of
 *  `browser_go`. */
export async function browserGo(deps: BrowseCommandsDeps, action: string): Promise<void> {
  const [js, goesOnline] = browserGoJs(action);
  if (goesOnline) {
    requireWebEnabled(deps.db);
  }
  // Rust's `browser::webview(&app).ok_or("The browser isn't open.")?` — its own
  // words, not the agent-facing "…Use browse_open first." the eval bridge
  // would raise a moment later.
  if (!deps.browser.isOpen()) {
    throw new Error("The browser isn't open.");
  }
  try {
    await deps.browser.eval(chromeActionScript(js));
  } catch (e) {
    // Rust's `wv.eval` only reports whether the script was DISPATCHED; it never
    // waits for the document. Three of these four actions exist to replace the
    // document, so a round trip lost to the navigation they just started is
    // the action working, not failing. Anything else still surfaces.
    if (!(e instanceof Error) || e.message !== EVAL_LOST) {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Takeover, journal, clear, verify, retry
// ---------------------------------------------------------------------------

/** Port of `browser_set_takeover`. */
export function browserSetTakeover(deps: BrowseCommandsDeps, on: boolean): void {
  deps.browser.takeover = on;
  deps.browser.journal(
    "takeover",
    "",
    on ? "User took over the browser" : "User handed the browser back",
  );
}

/** Port of `browser_journal`. */
export function browserJournal(deps: BrowseCommandsDeps, limit?: number): BrowseJournalRow[] {
  return listBrowseJournal(requireRoom(deps.db), limit ?? 300);
}

/**
 * Clear the browser's whole record: the journal AND the web cache behind it.
 *
 * The cache is not an implementation detail from the user's side — it holds
 * the words they searched for and the full text and thumbnails of the result
 * pages, inside a browser that promises to keep nothing. Clearing the journal
 * while leaving that behind was a Clear button that did not clear. Port of
 * `browser_clear_journal`.
 */
export function browserClearJournal(deps: BrowseCommandsDeps): void {
  const db = requireRoom(deps.db);
  wipeBrowseJournal(db);
  clearWebCache(db);
}

/** What a Clear would actually erase. The button's own words cover the journal
 *  only, so the counts are offered to whatever asks before running it. Port of
 *  `browser_clear_scope`. */
export function browserClearScope(deps: BrowseCommandsDeps): BrowseClearScope {
  return readClearScope(requireRoom(deps.db));
}

/** Ask the LIVE session whether its storage is really ephemeral. Surfaced in
 *  the shield chip so the privacy claim is something the app CHECKS, not
 *  something it asserts. Port of `browser_verify_private`. */
export async function browserVerifyPrivate(deps: BrowseCommandsDeps): Promise<boolean> {
  return deps.browser.verifyEphemeral();
}

/** Re-attach the content blocker to every open page, without moving any of
 *  them — what the shield's "Try again" runs. Port of
 *  `browser_retry_protection`. */
export function browserRetryProtection(deps: BrowseCommandsDeps): void {
  deps.browser.retryProtection();
}
