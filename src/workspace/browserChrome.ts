import type { BrowserInfo } from "../apiTypes";

/* WHAT THE TOOLBAR IS ALLOWED TO CLAIM, AND WHEN IT MUST STOP CLAIMING IT.
 *
 * The private browser's chrome is derived from ONE input — the `browser_info`
 * poll — and everything else in `BrowserView` is view state that nothing
 * clears. That combination produced the defect this module exists for (product
 * audit, 2026-08-15): after closing the last page the sidebar correctly read
 * "Private pages 0" while the workspace still showed the closed page's address,
 * its HTTPS padlock, and a live Save strip. Leaving the destination and coming
 * back was the only way to get an honest toolbar.
 *
 * Two separate faults, so two separate functions:
 *
 *  1. Enablement was spelled out inline at each control, and one row of them
 *     was spelled out WRONG — the four buttons inside the Save strip are gated
 *     on `saving` alone, so with no browser open at all they stayed clickable
 *     and failed down in Rust with "The browser isn't open." One list of
 *     abilities, read by every control, is the fix; a control that forgets to
 *     ask is then a visible omission rather than an invisible one.
 *
 *  2. A page-scoped claim outlives the page. `address` is the clearest case:
 *     it is assigned under `if (!editing && next.url)`, so a report with no URL
 *     — which is exactly what "no page is open" looks like — can never clear
 *     it. The reset below names every piece of state that belongs to a page
 *     rather than to the room, so closing the last one drops all of it at once.
 *
 * Pure, because the component around it needs the whole Tauri bridge before it
 * renders a single button.
 */

/** What the area has put in front of the native page, if anything.
 *
 * These are the ONLY reasons the page gets parked at 1×1, and naming them once
 * is the point: the bounds pusher, the ability list and the signal the chat
 * scope reads used to hold three different opinions about what "parked" meant,
 * and the reading view — a parking cause added later — reached only the first
 * of them. The result was a Save button and a chat scope both offering to work
 * from a page Rust would refuse to read. */
export interface ChromeView {
  /** Something outside this area owns the pane — a consent card, or the
   *  destination is not the one on screen. */
  parked: boolean;
  /** A brand-new tab, still on `about:blank`. That document paints an OPAQUE
   *  rectangle, so leaving it on screen would hide the very start page that
   *  tells the user what to do. */
  blank: boolean;
  /** The results list is drawn where the page would be. */
  searchOpen: boolean;
  /** The reading view has REPLACED the page: open, not comparing, and not
   *  mid-extraction (an extraction is the one moment the page is handed its
   *  layout viewport back). */
  readerHasTheFloor: boolean;
}

/** Is the native view parked at 1×1 right now?
 *
 * Deliberately reads nothing but `view`: every field is a primitive, so the
 * caller can memoise the view on its parts and the bounds effect does not
 * rebuild its ResizeObserver on every 1.2s poll. */
export function pageIsParked(view: ChromeView): boolean {
  return view.parked || view.blank || view.searchOpen || view.readerHasTheFloor;
}

/** Which page-scoped controls the chrome may offer right now.
 *
 * `address` is deliberately absent: typing an address is how you get a page,
 * so it is the one control that must work when there is nothing open. */
export interface ChromeAbilities {
  /** Back, forward, reload, stop. */
  navigate: boolean;
  /** The Save button AND every row inside its strip — they are one ability,
   *  which is the bug: the strip used to hold its own opinion. */
  save: boolean;
  /** OPEN the reading view. Not the same as being allowed to close it — a
   *  toggle that goes disabled while `aria-pressed` is true is a control the
   *  user cannot un-press, which is what happened when the results list
   *  appeared under an open reader. */
  read: boolean;
  takeover: boolean;
}

/** A page you can act on: open, and not parked behind something else. */
export function chromeAbilities(
  info: BrowserInfo,
  view: ChromeView,
): ChromeAbilities {
  const open = info.open === true;
  const usable = open && !pageIsParked(view);
  return {
    navigate: open,
    save: usable,
    read: usable,
    takeover: open,
  };
}

/** The view state that belongs to a PAGE rather than to the room.
 *
 * Everything here is dropped the moment the browser reports nothing open. The
 * journal is pointedly not in the list: it is the room's record of what the
 * assistant did, it outlives every page by design, and blanking it on the last
 * close would destroy the one thing a user might open the panel to read. */
export interface PageScopedView {
  address: string;
  saveOpen: boolean;
  readerOpen: boolean;
  /** The reading view's side-by-side, and the extraction refcount that borrows
   *  the page's viewport. Both belong to a reading of a page that no longer
   *  exists. */
  comparing: boolean;
  extracting: 0;
  searchOpen: boolean;
  /** The results list itself, held in memory only. A browsing sitting is over
   *  when its last page closes, and a list of queries that survived it would be
   *  a search history — the one thing this browser promises not to keep. */
  search: null;
  error: null;
  failedInput: null;
  notice: null;
  busy: false;
  /** The storage-ephemerality verdict. It was checked against a specific page;
   *  carrying it past that page is the AUDIT 380 mistake in miniature. */
  ephemeral: null;
}

/** What the chrome must look like once there is no page to describe.
 *
 * Exhaustive on purpose, and typed so it stays that way: the next page-scoped
 * field somebody adds has one place to be registered, and the compiler asks. */
export const CLOSED_VIEW: PageScopedView = {
  address: "",
  saveOpen: false,
  readerOpen: false,
  comparing: false,
  extracting: 0,
  searchOpen: false,
  search: null,
  error: null,
  failedInput: null,
  notice: null,
  busy: false,
  ephemeral: null,
};

/** How many polls in a row may fail before the chrome stops claiming a page.
 *
 * One dropped round trip is a hiccup — the room can be mid-close, and flashing
 * the start screen for 1.2s on every hiccup is its own lie. Two in a row is a
 * browser that is not answering, and a toolbar frozen mid-claim (padlock still
 * green, Save still armed) is worse than one that admits it does not know. */
export const MISSES_BEFORE_CLOSED = 2;

/** What `info` becomes when the poll itself failed.
 *
 * The old code swallowed the rejection with a bare `catch {}`, which left the
 * previous report in place FOREVER — a browser that stopped answering kept a
 * fully armed toolbar describing a page nobody could see. */
export function infoAfterMissedPoll(
  prev: BrowserInfo,
  misses: number,
): BrowserInfo {
  return misses >= MISSES_BEFORE_CLOSED ? { open: false } : prev;
}
