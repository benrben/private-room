import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BrowserTab } from "../api";

/** THE PRIVATE BROWSER'S OPEN PAGES — their own typed state, and nowhere else.
 *
 * These used to be entries in the shell's one `openTabs` list, filed beside
 * room documents. That was one collection holding two categorically different
 * things: a room file is durable, encrypted, restorable and belongs to the
 * room; a private page is in-memory, never written down, and belongs to this
 * session and to the Browser destination alone. Mixing them produced a strip
 * above every surface in the app that showed a spreadsheet, a recording, a
 * sketch and three web pages side by side — and made the browser's pages
 * visible (and clickable) from destinations that have no browser on screen.
 *
 * Splitting them is the fix, and the type is the guarantee: there is no shape
 * here that a file could occupy, and `tabs.ts` has no `page` kind left to
 * abuse.
 *
 * THE PRIVACY CONTRACT IS UNCHANGED AND IS WHY THIS HOOK PERSISTS NOTHING.
 * Not to `localStorage`, not to a room setting, not through the tab list's own
 * `workspace_tabs`. A restored list of pages you were reading is a browsing
 * history whatever it is called (owner decision 2026-07-31). The list lives in
 * React state for as long as the app is running and dies with it. Leaving the
 * Browser destination does not close anything — Rust still holds the pages —
 * which is what lets returning restore the same page you left.
 */

export interface BrowserPage {
  id: string;
  /** The page's own `<title>`, as Rust last read it. Empty while a page is
   * still loading its first document — which is exactly what the row draws as
   * "Loading…", rather than inventing a spinner from a signal nobody sends. */
  title: string;
  url: string;
}

/** Where a page's row gets its second line, and what makes two pages with the
 * same title tellable apart. The host alone: a full URL in a narrow sidebar row
 * truncates to the scheme and tells you nothing. */
export function pageHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** What a page is called before it has been anywhere.
 *
 * The SAME words Rust uses for the same state (`browser::page_title`), so a row
 * does not rename itself the moment the first reconciliation lands. */
export const NEW_PAGE_TITLE = "New page";

/** The row's readable label: the page's title, else its host, else the name a
 * page with no address yet honestly has. */
export function pageLabel(p: BrowserPage): string {
  const title = p.title.trim();
  if (title) return title;
  return pageHost(p.url) || NEW_PAGE_TITLE;
}

/** The row's second line, or `""` when there is nothing true to put there.
 *
 * The host, when the label is not already the host — and nothing at all for a
 * blank page. This drew "Loading…" under a title that ALSO read "Loading…",
 * which is one fact stated twice and neither statement worth the row's second
 * line (caught in the installed build, 2026-08-15). */
export function pageSubtitle(p: BrowserPage): string {
  const host = pageHost(p.url);
  if (!host) return "";
  return pageLabel(p) === host ? "" : host;
}

/** The accessible name of one row: the title, plus the host whenever the host
 * is not already in the title. Two tabs called "Search results" are one list
 * item apiece to a screen reader unless the row says which site each is on. */
export function pageAccessibleName(p: BrowserPage): string {
  const label = pageLabel(p);
  const host = pageHost(p.url);
  return host && !label.toLowerCase().includes(host.toLowerCase())
    ? `${label} — ${host}`
    : label;
}

/** Which page is showing after `closed` is closed.
 *
 * The neighbour to the right, else the one to the left — what every browser
 * does, and what keeps close-close-close from jumping around the list. Closing
 * a page that is not the active one never moves the selection, and closing the
 * last one returns "" so the destination shows its own empty state rather than
 * a stale selection pointing at nothing. */
export function heirAfterClose(
  pages: BrowserPage[],
  closedId: string,
  activeId: string,
): string {
  if (activeId !== closedId) return activeId;
  const at = pages.findIndex((p) => p.id === closedId);
  if (at < 0) return activeId;
  const rest = pages.filter((p) => p.id !== closedId);
  return (rest[at] ?? rest[at - 1])?.id ?? "";
}

/** Fold what Rust actually has open into the list on screen.
 *
 * Rust is the source of truth in both directions: a page the ASSISTANT opened
 * earns a row, a page that went away loses one, and titles follow navigation.
 * Order is preserved for pages already known (the user may have dragged them),
 * with newly discovered pages appended in Rust's order.
 *
 * Pure, so the reconciliation can be tested without a browser: the two ways it
 * used to go wrong — an assistant-opened page stealing the reader's selection,
 * and a selection surviving the page it named — are both decided here. */
export function reconcilePages(
  prev: BrowserPage[],
  live: BrowserTab[],
): BrowserPage[] {
  const byId = new Map(live.map((t) => [t.id, t]));
  const kept = prev
    .filter((p) => byId.has(p.id))
    .map((p) => {
      const t = byId.get(p.id)!;
      return p.title === t.title && p.url === t.url
        ? p
        : { ...p, title: t.title, url: t.url };
    });
  const known = new Set(kept.map((p) => p.id));
  const added = live
    .filter((t) => !known.has(t.id))
    .map((t) => ({ id: t.id, title: t.title, url: t.url }));
  // Identity is how the caller learns anything happened, so `prev` may only be
  // handed back when NOTHING did — a poll that found a navigation and no new
  // page still has to reach the screen. Testing the set alone (nothing added,
  // nothing dropped) called a retitled row "unchanged" and left every page
  // listed under the title and address it was opened with.
  const same =
    added.length === 0 &&
    kept.length === prev.length &&
    kept.every((p, i) => p === prev[i]);
  return same ? prev : [...kept, ...added];
}

/** Which page the selection should land on after a reconciliation.
 *
 * Three rules, in order. A selection whose page survived is never moved — a
 * page the assistant opened in the background must not yank the reader out of
 * what they are reading. A selection whose page is GONE has to move, or the
 * pane shows nothing with a row still highlighted. And an empty selection with
 * pages available takes the first, which is what makes returning to the Browser
 * show a page rather than the empty state. */
export function selectionAfterSync(
  pages: BrowserPage[],
  activeId: string,
): string {
  if (pages.some((p) => p.id === activeId)) return activeId;
  return pages[0]?.id ?? "";
}

/** The page Rust must be told to show again, or `""` when it already agrees.
 *
 * Rust reports which page is on SCREEN, and picks its own heir whenever the
 * visible page goes away on its own — so the sidebar can end up highlighting
 * one page while another is displayed. Clicking the highlighted row would then
 * do nothing, because `browser_select_tab` only fires on a real change and Rust
 * already believes its own page is active. Putting the user's choice back is
 * the correction; asking for a page Rust no longer has is not (the
 * reconciliation drops that row in the same tick).
 *
 * Lifted out of the effect so the disagreement can be pinned in a test — the
 * component around it needs the whole Tauri backend before it renders a row.
 * (Formerly `shell/tabsync.ts`, when the pages lived in the global tab strip.) */
export function pageToReassert(live: BrowserTab[], activeId: string): string {
  if (!activeId) return "";
  if (!live.some((p) => p.id === activeId)) return "";
  return live.some((p) => p.id === activeId && p.active) ? "" : activeId;
}

export interface BrowserPagesApi {
  pages: BrowserPage[];
  activeId: string;
  /** Open a page and show it. Empty `url` opens the browser's start page. */
  open: (url?: string) => Promise<void>;
  close: (id: string) => void;
  select: (id: string) => void;
  /** Drag-reorder, same contract as the old strip's `move`. */
  move: (from: number, to: number) => void;
}

/** The hook. `webOn` gates it entirely: with the room offline there is no
 * browser, so nothing polls and nothing is listed.
 *
 * `active` (the Browser destination being the current one) only changes the
 * POLL RATE — brisk while the pages are on screen, lazy in the background so a
 * page the assistant opens still earns its row. It deliberately does not gate
 * the reconciliation: stopping while another destination is showing would mean
 * returning to the Browser to a list that had been frozen since you left. */
export function useBrowserPages(
  webOn: boolean,
  active: boolean,
  onError: (message: string) => void,
): BrowserPagesApi {
  const [pages, setPages] = useState<BrowserPage[]>([]);
  const [activeId, setActiveId] = useState("");
  // THE CURRENT LIST AND SELECTION, readable synchronously.
  //
  // The reconciliation below needs both, and needs to write both, from inside
  // an async callback. Reading them through `setPages(prev => …)` and nesting a
  // `setActiveId` inside that updater is what it did first, and it was wrong in
  // the way that costs a whole feature: an updater that changes nothing makes
  // React bail out of the update, taking the nested call with it — so a poll
  // that found only a TITLE change left the row saying what it had said before.
  // In the installed build every page row read "Loading…" forever.
  //
  // A state updater answers a question about the previous state. It must not
  // also act. These refs let the sync compute the next state as ordinary code
  // and then state it, once, per fact.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  useEffect(() => {
    if (!webOn) {
      // The room went offline: Rust has closed the browser, so a list left on
      // screen would be describing pages that no longer exist.
      pagesRef.current = [];
      activeRef.current = "";
      setPages([]);
      setActiveId("");
      return;
    }
    let stop = false;
    const sync = async () => {
      const live = await api.browserTabs().catch(() => null);
      if (stop || !live) return;
      const next = reconcilePages(pagesRef.current, live);
      if (next !== pagesRef.current) {
        pagesRef.current = next;
        setPages(next);
      }
      const chosen = selectionAfterSync(next, activeRef.current);
      if (chosen !== activeRef.current) {
        activeRef.current = chosen;
        setActiveId(chosen);
      }
      // Rust also says which page it is SHOWING, and the two can drift — see
      // `pageToReassert`. Only ever while this destination is on screen:
      // forcing a page switch in the background would change what the reader
      // finds when they come back.
      if (active) {
        const put = pageToReassert(live, chosen);
        if (put) void api.browserSelectTab(put).catch(() => {});
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), active ? 1200 : 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [webOn, active]);

  /** Tell Rust which page to show. The Browser destination renders whichever
   * page Rust has active, so selecting a row and showing it are one move. */
  const select = useCallback((id: string) => {
    activeRef.current = id;
    setActiveId(id);
    if (id) void api.browserSelectTab(id).catch(() => {});
  }, []);

  const open = useCallback(
    async (url = "") => {
      try {
        const id = await api.browserNewTab(url);
        // Placed optimistically so the row appears on the keystroke rather than
        // on the next poll — the reconciliation above confirms it, and
        // `reconcilePages` keeps whatever is already known. The title is the
        // one Rust gives a page with no address yet, so the row does not rename
        // itself a second later.
        if (!pagesRef.current.some((p) => p.id === id)) {
          pagesRef.current = [...pagesRef.current, { id, title: NEW_PAGE_TITLE, url }];
          setPages(pagesRef.current);
        }
        activeRef.current = id;
        setActiveId(id);
      } catch (e) {
        onError(String(e));
      }
    },
    [onError],
  );

  const close = useCallback((id: string) => {
    const heir = heirAfterClose(pagesRef.current, id, activeRef.current);
    pagesRef.current = pagesRef.current.filter((p) => p.id !== id);
    setPages(pagesRef.current);
    if (heir !== activeRef.current) {
      activeRef.current = heir;
      setActiveId(heir);
      // The heir has to be SHOWN, not merely highlighted: Rust picks its own
      // successor when a page closes, and it is not always the neighbour the
      // list just selected.
      if (heir) void api.browserSelectTab(heir).catch(() => {});
    }
    void api.browserCloseTab(id).catch(() => {});
  }, []);

  const move = useCallback((from: number, to: number) => {
    const prev = pagesRef.current;
    if (from === to || from < 0 || to < 0) return;
    if (from >= prev.length || to >= prev.length) return;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    pagesRef.current = next;
    setPages(next);
  }, []);

  // Returning to the Browser has to put Rust back on the page the reader left.
  // Rust picks its own heir whenever a page closes on its own, so the two can
  // disagree while another destination is showing — and clicking the row that
  // is already highlighted would do nothing, because `browser_select_tab` only
  // fires on a real change.
  useEffect(() => {
    if (!active || !activeId) return;
    void api.browserSelectTab(activeId).catch(() => {});
  }, [active, activeId]);

  return { pages, activeId, open, close, select, move };
}
