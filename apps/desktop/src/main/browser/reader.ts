/**
 * Item #18: the private browser, for a keyboard and a screen reader. Port of
 * `src-tauri/src/commands/browse/reader.rs`.
 *
 * # Why this exists at all
 *
 * The page is a NATIVE child view — a sibling of the app's own window content,
 * with its own process, its own first responder and its own accessibility
 * tree. Nothing the renderer draws can be shown over it, nothing it contains
 * can be reached from the host DOM, and no key pressed inside it is delivered
 * to the app. So the two things a screen-reader user needs — the page's
 * content, and a way back out of it — cannot come from the host tree at all.
 * They have to be fetched from the page and handed back.
 *
 * Both readers here are thin wrappers over machinery `browser.ts` already
 * ports and tests: `Browser.call`'s `read`/`capture` ops (the same extractor
 * the agent's `browse_read`/`browse_save` use) and focusing the main window.
 *
 * # The doors, and why none of them apply
 *
 *  - No web-enabled gate — this reads a page that is ALREADY loaded and
 *    fetches nothing, exactly the reasoning written for `browser_save_page`.
 *  - No takeover gate — that guard refuses the AGENT's actions while the user
 *    has the wheel. The reader IS the user, and it only reads.
 *  - No journal row — the journal's contract is "everything the agent did",
 *    and a person reading the page they are looking at is not the agent. A
 *    sighted user's eyes are not journalled either.
 */

import { WAIT_READY_BUDGET_MS } from "./browser.js";
import type { Bounds } from "./tabs.js";
import type { Sleep } from "./evalBridge.js";
import type { BrowserPageSelection } from "../../shared/apiTypes.js";

/**
 * The exact slice of `Browser` (browser.ts) these readers need. Structural on
 * purpose: the real class satisfies it with no adapter, and a test only has to
 * supply the four members that are actually exercised.
 */
export interface ReaderBrowser {
  isOpen(): boolean;
  bounds(): Bounds;
  waitReady(budgetMs?: number): Promise<void>;
  call(op: string, args?: unknown): Promise<unknown>;
}

/**
 * Below this, in either dimension, the page's own layout is not the layout
 * anyone is looking at.
 *
 * The browser area parks the native view at 1×1 whenever a modal is up or the
 * results page is showing, and a web page's layout viewport IS its frame: at
 * one CSS pixel wide an article reflows to tens of thousands of pixels tall,
 * and the extractor's own visibility rule (which rejects anything far below
 * the viewport) then drops almost all of it. The `read` op still answers
 * `ok: true` with a fragment, which is precisely the shape of failure this
 * whole feature is built against — the text-channel twin of the parked
 * screenshot the agent's `browse_look` already refuses.
 */
export const MIN_READABLE_PX = 200;

/** Is the page too small on screen for what it reports about itself to be
 *  true? Pure so the refusal can be tested without a live view. */
export function tooSmallToRead(b: Bounds): boolean {
  return b.width < MIN_READABLE_PX || b.height < MIN_READABLE_PX;
}

/**
 * How long to let the stage's real rect arrive before refusing.
 *
 * Opening the reading view shrinks the stage and the view pushes the new rect
 * through `setBounds` WITHOUT waiting for it, so the reader's very first read
 * can land while this side still holds the parked rect from whatever was
 * covering the page a moment ago. Refusing then would fail the one case the
 * feature exists for, and the caller has no way to tell that refusal from a
 * real one.
 */
export const BOUNDS_SETTLE_MS = 1_500;
export const BOUNDS_POLL_MS = 60;

export const PARKED_REFUSAL =
  "The page is shrunk off screen right now, so what it reports about itself " +
  "would only be a fragment. Close whatever is covering the browser and try " +
  "again.";

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReaderOptions {
  /** Injected so a test can drive the settle-poll loop without real time. */
  sleep?: Sleep;
  /** Injected so a test can let the settle budget elapse without waiting out
   *  the real 1.5 seconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Everything both readers must be sure of before they believe a word the page
 * says: there is a page, it is on screen at a real size, and its script is up.
 *
 * ONE helper rather than two copies — the whole point of the size check is
 * that a page reporting on itself from a 1×1 layout viewport answers
 * `ok: true` with a fragment, and a second copy of that rule is a second
 * chance to get it subtly different.
 */
export async function readyToBeRead(
  browser: ReaderBrowser,
  opts: ReaderOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  if (!browser.isOpen()) {
    throw new Error("The browser isn't open — there is no page to read.");
  }
  const started = now();
  while (tooSmallToRead(browser.bounds())) {
    if (now() - started > BOUNDS_SETTLE_MS) {
      throw new Error(PARKED_REFUSAL);
    }
    await sleep(BOUNDS_POLL_MS);
  }
  await browser.waitReady(WAIT_READY_BUDGET_MS);
}

/**
 * The current page as text, for the reading view.
 *
 * Returned RAW rather than formatted: the view follows `nextOffset` and
 * `truncated` itself so it can say "showing the first N of M characters"
 * instead of quietly presenting a slice as the whole page.
 */
export async function browserPageText(
  browser: ReaderBrowser,
  mode: string,
  offset: number,
  opts: ReaderOptions = {},
): Promise<unknown> {
  await readyToBeRead(browser, opts);
  const safeMode = mode === "full" ? "full" : "main";
  return browser.call("read", { mode: safeMode, offset });
}

/**
 * What the page script answers `capture` with when the user has selected
 * nothing. Kept as a constant because it is the ONE page-script error this
 * command must not pass on as a failure — {@link browserPageSelection} turns it
 * into an empty answer, and a rename on either side would silently turn
 * "nothing is selected" back into "the page refused".
 */
export const NOTHING_SELECTED = "Nothing is selected on the page.";

/**
 * How much selected text comes back.
 *
 * The page script's own `capture` cap is sized for a room FILE. This is the
 * reading path, so it takes the reading cap: the same 40,000 characters one
 * `read` slice returns. Counted here in CODE POINTS where the page counts
 * UTF-16 units, so the two agree on ordinary text and differ only on how much
 * astral-plane text rides under one cap — which is a bound on a passage, not a
 * byte budget.
 */
export const SELECTION_MAX = 40_000;

/** Nothing selected: the shape is the same one, so the caller reads `text`
 *  either way instead of branching on which kind of answer it got. */
export function emptySelection(): BrowserPageSelection {
  return { text: "", url: "", title: "", truncated: false, total: 0 };
}

/**
 * The selection, cut to the reading cap, and whether anything was cut.
 *
 * `pageClipped` is the page script's own flag: it clips at its far larger save
 * cap first, and either cut means the caller is holding PART of a passage.
 * Presenting part of a passage as the passage is the failure this app keeps
 * writing tests about, so the flag travels with the text.
 */
export function clipSelection(
  text: string,
  pageClipped: boolean,
): { text: string; clipped: boolean } {
  const chars = Array.from(text);
  return {
    text: chars.slice(0, SELECTION_MAX).join(""),
    clipped: pageClipped || chars.length > SELECTION_MAX,
  };
}

function isNothingSelected(error: unknown): boolean {
  return error instanceof Error && error.message === NOTHING_SELECTED;
}

function selectionFromCapture(value: Record<string, unknown>): BrowserPageSelection {
  const { text, clipped } = clipSelection(
    typeof value.text === "string" ? value.text : "",
    value.truncated === true,
  );
  // The page script measures the WHOLE selection; both caps below it are ours
  // or its own. Carried through so a caller showing a clipped passage can say
  // how much it is leaving out rather than implying it has all of it.
  const total = typeof value.total === "number" ? value.total : Array.from(text).length;
  return {
    text,
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    truncated: clipped,
    total,
  };
}

/**
 * The user's current selection, as text. READ-ONLY: nothing is written, and
 * nothing is journalled.
 *
 * The selection has been capturable since BROWSE-2, but only through
 * `browser_save_page`, which writes a file into the room — so "what has the
 * user got selected" was a question the app could only answer by SAVING it.
 * This is the same `capture` op with neither the file nor the journal row.
 *
 * An empty `text` means nothing is selected — an honest empty answer, not an
 * error. A page that genuinely refused the read still fails, so the caller can
 * tell the two apart.
 */
export async function browserPageSelection(
  browser: ReaderBrowser,
  opts: ReaderOptions = {},
): Promise<BrowserPageSelection> {
  await readyToBeRead(browser, opts);
  let v: Record<string, unknown>;
  try {
    v = (await browser.call("capture", { what: "selection" })) as Record<string, unknown>;
  } catch (e) {
    if (isNothingSelected(e)) {
      return emptySelection();
    }
    throw e;
  }
  return selectionFromCapture(v);
}

/** The one thing this module needs from the app's own window: the ability to
 *  take the keyboard back. Structural so an Electron `BrowserWindow` satisfies
 *  it directly. */
export interface FocusableWindow {
  focus(): void;
}

/**
 * Hand the keyboard back to the app.
 *
 * The child view holds the window's first responder while it has focus, and
 * the app's own content cannot take it back by asking nicely from JavaScript —
 * they are different native views. Focusing the main window is the one call
 * that actually moves it. Without this, a keyboard user who tabs into the page
 * is stuck there.
 *
 * `null` mirrors Rust's `main_webview(&app)` answering `None`, and the refusal
 * is OWNED here rather than left to the caller: this is the function that
 * knows a missing window means the keyboard cannot be handed anywhere.
 */
export function browserFocusApp(mainWindow: FocusableWindow | null): void {
  if (!mainWindow) {
    throw new Error("The app window is gone.");
  }
  mainWindow.focus();
}
