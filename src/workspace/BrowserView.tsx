import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  BrowseClearScope,
  BrowseJournalRow,
  BrowserInfo,
  BrowserSearchResult,
  FileMeta,
} from "../apiTypes";
import { ShieldIcon, LockIcon, AlertIcon } from "../icons";
import { classifyAddress, needsFreshFetch } from "./address";
import { BrowserSearch, BrowserSearchSkeleton } from "./BrowserSearch";
import { BrowserReader } from "./BrowserReader";
import { announcement, stalledBanner } from "./browserAnnounce";
import {
  chromeAbilities,
  CLOSED_VIEW,
  infoAfterMissedPoll,
  MISSES_BEFORE_CLOSED,
  pageIsParked,
  type ChromeView,
} from "./browserChrome";
import {
  EPHEMERAL_VS_ROOM,
  privacyClaim,
  protectionAlert,
  startScreenCopy,
} from "./browserPrivacy";
import { publishBrowserPage } from "./browserSignal";
import {
  clearWarning,
  FACETS,
  groupSessions,
  type JournalFacet,
} from "./browserJournal";

/* BROWSE-1: the private browser area.
 *
 * THE ONE STRUCTURAL THING TO KNOW: the page is a NATIVE child webview, not a
 * DOM node. It is positioned by the platform on top of this window, so it
 * floats ABOVE every element React renders here. Two consequences drive the
 * whole layout:
 *
 *  1. `.browser-stage` is an EMPTY placeholder. Its measured rect is pushed to
 *     Rust (`browserSetBounds`) and the native view is parked exactly there.
 *     Anything rendered inside it would be invisible underneath the page.
 *  2. Nothing may float over the page — no popovers, no dropdowns, no consent
 *     sheets. The agent's consent prompt therefore lives in the AI pane, and
 *     the journal is a side panel that SHRINKS the stage rather than covering
 *     it. (This is the scheduler-popover portal lesson in reverse: last time
 *     the fix was to portal above a clipping container; here nothing CAN go
 *     above, so the layout has to be honest about it.)
 */

/** The poll for browser state.
 *
 *  NOT a slow safety net: `browser-navigated` has exactly one producer in the
 *  whole app — the agent's `browse_open` tool (commands/browse.rs). A person
 *  CLICKING A LINK inside the page goes through wry's `on_navigation` hook,
 *  which records the new URL in Rust state and emits nothing, and the explicit
 *  refreshes cover only typed addresses, opened search results and the
 *  back/forward/reload buttons. So the single most common browsing action is
 *  seen here or nowhere, and every tick of delay is a tick of the address bar
 *  naming the previous page — and of the padlock still promising HTTPS after a
 *  click or redirect has dropped the user onto http. That is the exact false
 *  assurance the padlock exists to prevent, so this stays fast. (It matches the
 *  tab strip's own reconcile timer in Workspace.tsx, which never slowed down.) */
const POLL_MS = 1200;
/** How long after a navigation event the title and readiness keep settling —
 *  one extra sample, rather than waiting out the slow tick. */
const SETTLE_MS = 700;

/** A journal row's time, in the reader's own zone.
 *
 * The rows are stored UTC (`...Z`). Printing that string with the `Z` filed off
 * dated 3pm work as noon — every other time in the app is local, and a record
 * you have to convert in your head is not a record you can check. */
function journalTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/** The scheme of the page actually on screen — `null` for a blank tab or an
 *  address that will not parse. */
function schemeOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

export function BrowserView({
  parked,
  onAttach,
  onAsk,
}: {
  parked: boolean;
  /** BROWSE-3: a search result became a room file — pin it to the composer so
   *  its text is in the very next turn, not just findable later. */
  onAttach?: (file: FileMeta) => void;
  /** BROWSE-3: hand a search query to the assistant. */
  onAsk?: (query: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<BrowserInfo>({ open: false });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ephemeral, setEphemeral] = useState<boolean | null>(null);
  // AUDIT 380: what the shield's answer was actually ABOUT. The check is
  // deliberately asked of the live webview rather than read off a flag, but the
  // answer used to be latched for the whole session — so it described whichever
  // page happened to be showing when the browser opened, and every page after
  // that inherited a verdict nobody had checked. Re-asked whenever the page
  // changes; `verify_ephemeral` covers every OPEN tab, so one pass per
  // navigation is the whole browser, not just the one in front.
  const verifiedForRef = useRef<string | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journal, setJournal] = useState<BrowseJournalRow[]>([]);
  // The journal is the ONLY record of what the assistant did in this browser
  // and Clear erases it with no undo. It used to fire on the first click.
  const [confirmClear, setConfirmClear] = useState(false);
  // What that Clear would ACTUALLY delete. The command empties the web cache
  // as well as the journal, which the button's own words never admitted —
  // asked for at the moment of confirming rather than kept fresh, because it
  // is only ever read by the sentence that is about to be shown.
  const [clearScope, setClearScope] = useState<BrowseClearScope | null>(null);
  // The record is a HISTORY, and a panel that opens on all of it is the raw
  // dump the audit found. Default: this sitting only, no facet filtered out.
  const [showEarlier, setShowEarlier] = useState(false);
  const [facets, setFacets] = useState<JournalFacet[]>([]);
  const [busy, setBusy] = useState(false);
  // BROWSE-2: the Save strip. A DROPDOWN cannot exist here (the native page
  // floats above all DOM), so Save opens a second chrome ROW in normal flow.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // A block list being re-compiled at the user's request (`retryProtection`).
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // BROWSE-3: the results page. Held in memory only — a stored list of
  // queries is a search history, which is the one thing this browser promises
  // not to keep (same doctrine as tabs.ts `isDurable`).
  const [search, setSearch] = useState<BrowserSearchResult | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // The query in flight, echoed by the skeleton so the wait is legible.
  const [pending, setPending] = useState("");
  // The query that produced the current error, so the banner can offer to
  // search for it instead of silently doing so.
  const [failedInput, setFailedInput] = useState<string | null>(null);
  // Item #18: the reading view, and the one live region that tells a screen
  // reader what the native page just did. `lastInfo` is what the announcement
  // is diffed against — a poll that changed nothing must say nothing.
  const [readerOpen, setReaderOpen] = useState(false);
  // THE READING VIEW IS A REPLACEMENT, NOT A SPLIT — with one exception it has
  // to keep making.
  //
  // The audit's P2: the reader halved the workspace into a squeezed live page
  // and a second copy of it, permanently. The obvious fix — hide the page — is
  // the one thing this view cannot simply do: the text it shows is extracted
  // from the LIVE webview, and a page parked at 1×1 reflows into a fragment
  // (Rust refuses to read one at all, `reader.rs` MIN_READABLE_PX). The page
  // needs a real layout viewport to be READ, not to be LOOKED AT.
  //
  // So the viewport is given back only for the instant an extraction needs it,
  // and `comparing` is the deliberate side-by-side the audit asked for as an
  // option rather than the default.
  const [comparing, setComparing] = useState(false);
  // A REFCOUNT, not a flag. Two callers can have an extraction in flight at
  // once — the mode toggle and the poll's `info.url` effect both restart one —
  // and with a boolean the first to finish handed the page's viewport back
  // while the second was still reading it. Rust then either stalled 1500ms into
  // its parked refusal, or measured the page at one CSS pixel and returned the
  // fragment that reflow produces, reported as the whole page.
  const [extracting, setExtracting] = useState(0);
  const borrowStage = useCallback((on: boolean) => {
    setExtracting((n) => Math.max(0, n + (on ? 1 : -1)));
  }, []);
  const [announce, setAnnounce] = useState("");
  const lastInfoRef = useRef<BrowserInfo | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);

  // A brand-new tab sits on `about:blank`, which paints an OPAQUE rectangle.
  // Since the native view floats above the DOM, leaving it there hides the very
  // start screen that tells the user what to do — the whole pane just goes
  // blank (owner report 2026-07-31: "new tab appears, nothing on the
  // workspace"). Reported by Rust from its own record, not read back from the
  // page, because a blank page runs no page script to ask.
  const blank = info.blank === true;

  // WHAT IS IN FRONT OF THE PAGE, decided once and read by everything that
  // needs to know. The bounds pusher, the ability list and the signal the chat
  // scope reads used to answer this separately, and the reading view — a
  // parking cause added later — reached only the first of them.
  const chromeView: ChromeView = useMemo(
    () => ({
      parked,
      blank,
      searchOpen,
      // An extraction is the one moment the page is handed its viewport back,
      // so it is not parked then even though the reader is showing.
      readerHasTheFloor: readerOpen && !comparing && extracting === 0,
    }),
    [parked, blank, searchOpen, readerOpen, comparing, extracting],
  );

  // --- bounds: keep the native view glued to the placeholder ---------------
  // The rect Rust was last told about. Rust remembers it (`BrowserState.bounds`)
  // and re-applies it itself whenever a page is created or switched, so
  // re-sending an unchanged rect achieves nothing — this makes a measurement
  // that finds nothing moved cost no IPC at all.
  const sentRef = useRef("");
  const pushBounds = useCallback(() => {
    // PARKED: a consent card (or any other modal) is open, the page has
    // nowhere to be yet, or the results page is up. The native page floats
    // above every DOM element in this window, so the only way anything
    // underneath can be seen is to shrink the page out of the way first.
    if (pageIsParked(chromeView)) {
      if (sentRef.current === "parked") return;
      sentRef.current = "parked";
      void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
      return;
    }
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (key === sentRef.current) return;
    sentRef.current = key;
    void api.browserSetBounds(r.left, r.top, r.width, r.height).catch(() => {});
  }, [chromeView]);

  useEffect(() => {
    pushBounds();
    const el = stageRef.current;
    if (!el) return;
    // A ResizeObserver alone misses the case that matters most here: the pane
    // moving without changing size (the rail collapsing, a splitter dragging).
    // So: the observer and the window resize for size changes, a rAF loop for
    // as long as a pointer is down (that is every drag, followed at 60fps
    // instead of the old four-times-a-second tick), and a slow measurement
    // afterwards for anything that animated to a stop on its own. Only a rect
    // that actually changed reaches Rust.
    const ro = new ResizeObserver(pushBounds);
    ro.observe(el);
    window.addEventListener("resize", pushBounds);
    let raf = 0;
    const follow = () => {
      pushBounds();
      raf = window.requestAnimationFrame(follow);
    };
    const onDown = () => {
      if (!raf) raf = window.requestAnimationFrame(follow);
    };
    const onUp = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      // One last measurement after the layout has settled from the drag.
      window.setTimeout(pushBounds, 60);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    const settle = window.setInterval(pushBounds, 1000);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBounds);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (raf) window.cancelAnimationFrame(raf);
      window.clearInterval(settle);
    };
  }, [pushBounds]);

  // Leaving the area must take the page off the screen — the native view floats
  // over the window, so it would otherwise hover above whatever the user
  // switched to.
  //
  // PARK, do not CLOSE. Closing here destroys the session (the data store is
  // non-persistent) and, worse, races the agent: any remount of this component
  // during a turn would tear down the browser `browse_open` had just created,
  // and every later tool call would fail on a webview that no longer exists.
  // Live QA 2026-07-29 showed exactly that shape — the first open succeeded and
  // everything after it failed. The room-close and app-quit paths in Rust are
  // what actually destroy the webview, and those are the ones that must.
  useEffect(() => {
    return () => {
      void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
    };
  }, []);

  // --- live state ----------------------------------------------------------
  // How many polls in a row have failed. A bare `catch {}` used to leave the
  // last report standing forever, so a browser that stopped answering kept a
  // padlock, an address and an armed Save strip describing a page nobody could
  // see. See `browserChrome.infoAfterMissedPoll` for why two, not one.
  const missesRef = useRef(0);
  // Which browsing sitting the chrome last saw open, so the end of one can be
  // detected exactly once rather than re-applied on every tick.
  const wasOpenRef = useRef(false);

  /** Everything the chrome may no longer claim once the last page has closed.
   *
   * THE DEFECT (audit P0): the sidebar dropped to "Private pages 0" while the
   * workspace still showed the closed page's address, its HTTPS state, the
   * reading view, the results list and a Save strip whose four buttons were
   * gated on `saving` alone — so they stayed clickable with no browser open at
   * all and failed down in Rust. Leaving the destination and returning was the
   * only way back to an honest toolbar.
   *
   * One place, applied atomically, listing exactly the state that belongs to a
   * page. The journal is not in it: it is the ROOM's record and outlives every
   * page by design. */
  const forgetThePage = useCallback((typing: boolean) => {
    // The address box is the ONE control that must keep working with nothing
    // open — it is how you get a page — so the reset that clears every other
    // page-scoped claim must not reach into it while the user is mid-word.
    // The close is learned up to a poll late, and starting to type a new
    // address is the natural next thing to do after closing the last page.
    if (!typing) {
      setAddress(CLOSED_VIEW.address);
      setEditing(false);
    }
    setSaveOpen(CLOSED_VIEW.saveOpen);
    setReaderOpen(CLOSED_VIEW.readerOpen);
    setComparing(CLOSED_VIEW.comparing);
    setExtracting(CLOSED_VIEW.extracting);
    setSearchOpen(CLOSED_VIEW.searchOpen);
    setSearch(CLOSED_VIEW.search);
    setError(CLOSED_VIEW.error);
    setFailedInput(CLOSED_VIEW.failedInput);
    setNotice(CLOSED_VIEW.notice);
    setBusy(CLOSED_VIEW.busy);
    setEphemeral(CLOSED_VIEW.ephemeral);
    verifiedForRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    let next: BrowserInfo;
    try {
      next = await api.browserInfo();
      missesRef.current = 0;
    } catch {
      // The room may be closing, or the browser may have stopped answering —
      // from here those look the same, and both mean the toolbar's claims are
      // now unproven. Silence is a decision, not a shrug: it lasts one poll.
      missesRef.current += 1;
      setInfo((prev) => infoAfterMissedPoll(prev, missesRef.current));
      if (missesRef.current >= MISSES_BEFORE_CLOSED && wasOpenRef.current) {
        wasOpenRef.current = false;
        forgetThePage(editing);
      }
      return;
    }
    setInfo(next);
    // The sitting ended. Do this BEFORE anything below reads `next.url`:
    // a report with no page has no URL, which is exactly why the address bar
    // could never clear itself.
    if (wasOpenRef.current && !next.open) forgetThePage(editing);
    wasOpenRef.current = next.open === true;
    // Item #18: this poll IS the accessibility event stream. The native page
    // repaints without changing a single DOM node, so nothing else in this
    // window can tell assistive tech that the user moved.
    const said = announcement(lastInfoRef.current, next);
    lastInfoRef.current = next;
    if (said) setAnnounce(said);
    // The page latched a double Escape. Nothing in JavaScript can pull the
    // first responder back from a sibling native view, so Rust does it and
    // the DOM focus follows — otherwise the keyboard lands in the app with
    // nothing focused, which is its own kind of trap.
    if (next.leaveRequested) {
      await api.browserFocusApp().catch(() => {});
      addressRef.current?.focus();
      setAnnounce(
        "Keyboard returned to the browser toolbar. The address box has focus.",
      );
    }
    if (!editing && next.url) setAddress(next.url);
    // Verified against the LIVE webview, not inferred from a flag: the
    // failure mode is silent, so the shield must report a real check — and
    // it must be a check of the page it is sitting next to. Re-asked on every
    // change of page (AUDIT 380), not once per browser session.
    const shieldFor = next.url ?? "";
    if (next.open && verifiedForRef.current !== shieldFor) {
      verifiedForRef.current = shieldFor;
      setEphemeral(await api.browserVerifyPrivate().catch(() => null));
    }
    if (!next.open) {
      setEphemeral(null);
      verifiedForRef.current = null;
    }
    // `ephemeral` is no longer a dependency: which page the shield has been
    // verified for lives in a ref, so the poll does not have to be rebuilt
    // every time the answer changes.
  }, [editing, forgetThePage]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // TELL THE REST OF THE APP WHAT IS HERE, AND WHETHER IT CAN BE READ.
  //
  // The assistant's scope strip needs both facts and can derive neither: it can
  // poll `browser_info` (and did, at the cost of a second `evaluateJavaScript`
  // round trip per beat into the same page this component is already polling),
  // but `searchOpen` and the reading view live in React state here, and they
  // are exactly what decide whether the page's text can be extracted at all.
  // Publishing is cheap and idempotent — `publishBrowserPage` drops an equal
  // snapshot, so the 1.2s poll does not re-render every subscriber.
  useEffect(() => {
    publishBrowserPage(
      info.open === true && info.url
        ? {
            url: info.url,
            title: info.title ?? "",
            readable: !pageIsParked(chromeView),
            // A selection you cannot read from is not one worth offering.
            hasSelection:
              info.hasSelection === true && !pageIsParked(chromeView),
          }
        : null,
    );
  }, [info, chromeView]);

  // Leaving the destination unmounts this component, and a stale page left in
  // the signal would offer the chat a scope pointing at a page nobody can see.
  useEffect(() => () => publishBrowserPage(null), []);

  const loadJournal = useCallback(async () => {
    setJournal(await api.browserJournal(300).catch(() => []));
  }, []);

  useEffect(() => {
    if (journalOpen) void loadJournal();
  }, [journalOpen, loadJournal]);

  // Live journal + navigation events, so the record updates as the agent works.
  useEffect(() => {
    const offs = [
      api.onBrowserJournal(() => {
        if (journalOpen) void loadJournal();
      }),
      api.onBrowserNavigated(() => {
        // This event has exactly one producer — the AGENT's browse_open (see
        // the note on POLL_MS) — so it means "the agent moved the page", and a
        // results page must not stay parked over it. Without this, the agent
        // searching and then opening a result left its own page invisible
        // behind the results it had just been handed. A person clicking a link
        // emits nothing, and cannot anyway: the page is 1x1 while these show.
        setSearchOpen(false);
        void refresh();
        // The title and readiness arrive a beat after the navigation itself.
        window.setTimeout(() => void refresh(), SETTLE_MS);
      }),
      // BROWSE-3c: the agent searched. Show its results on the same page the
      // address bar uses — the whole point of a browser you can watch.
      api.onBrowserSearched((result) => {
        setSearch(result);
        setSearchOpen(true);
        setAddress(result.query);
        setEditing(false);
        setSearching(false);
        setError(null);
        setFailedInput(null);
      }),
      api.onBrowserBlocked((p) =>
        setError(
          `Blocked ${p.url} — that address points at this Mac or a private network.`,
        ),
      ),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
    };
  }, [journalOpen, loadJournal, refresh]);

  // --- actions -------------------------------------------------------------
  /** BROWSE-3: run a search and show the results page. */
  const runSearch = useCallback(async (query: string) => {
    setPending(query);
    setSearching(true);
    setError(null);
    setFailedInput(null);
    try {
      const page = await api.browserSearch(query);
      setSearch(page);
      setSearchOpen(true);
      setAddress(query);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  /** What the address bar does with what you typed.
   *
   * The decision is made from the TEXT ALONE, before anything is sent
   * anywhere. A failed navigation must never silently become a search — an
   * internal hostname that doesn't resolve would be broadcast to seven
   * engines. The error banner offers the search instead, so that costs a
   * deliberate click. */
  async function go(target?: string) {
    const raw = (target ?? address).trim();
    const intent = classifyAddress(raw);
    if (!intent) return;
    if (intent.kind === "search") {
      await runSearch(intent.query);
      return;
    }
    setBusy(true);
    setError(null);
    setFailedInput(null);
    try {
      const settled = await api.browserNavigate(intent.url);
      setAddress(settled);
      setEditing(false);
      setSearchOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
      // Remember what they typed so the banner can offer a search for it.
      setFailedInput(raw);
    } finally {
      setBusy(false);
    }
  }

  /** Item #18: show the page as text.
   *
   * Closing the results page is part of opening the reader, not a courtesy:
   * the results are drawn over a webview PARKED AT 1×1, and a page at one CSS
   * pixel wide reflows to something whose extracted text is a fragment. Rust
   * refuses to read a parked page for that reason, so leaving the results up
   * would turn the reader into an error message. */
  const openReader = useCallback(() => {
    setSearchOpen(false);
    setReaderOpen(true);
    // Every opening starts as a replacement. `comparing` is a choice the user
    // makes per reading, not a preference that follows them into the next one.
    setComparing(false);
    // The page keeps its viewport for the first extraction, which begins on
    // the reader's very first effect. Starting at `false` would park the page
    // for one frame and then hand it straight back — a visible flinch, and a
    // window in which Rust could measure a stage that is about to grow. The
    // reader's first extraction returns this borrow.
    borrowStage(true);
  }, []);

  /** Leave the reading view. Focus must land somewhere the user chose, not
   *  nowhere — the page underneath is a native layer the DOM cannot focus. */
  const closeReader = useCallback(() => {
    setReaderOpen(false);
    setComparing(false);
    addressRef.current?.focus();
  }, []);

  /** Open a result. The results page stays in memory behind the page, so
   *  coming back is free and costs no navigation. */
  const openResult = useCallback(
    async (url: string) => {
      setSearchOpen(false);
      setBusy(true);
      setError(null);
      try {
        const settled = await api.browserNavigate(url);
        setAddress(settled);
        await refresh();
      } catch (e) {
        setError(String(e));
        setSearchOpen(true);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /** Open a result in a NEW tab.
   *
   * Two things this owes the user, neither of which it used to do. Rust creates
   * the page, SELECTS it (`browser::new_tab`) and the tab strip adopts it on
   * its own reconcile tick — up to a second of a click that looks ignored. So:
   * say so immediately, and then get out of the way, because the results page
   * is drawn OVER a webview parked at 1×1 and leaving it up hid the very page
   * that was just opened until the user left the area and came back. The
   * "◂ Results" row brings the list straight back with no re-search. */
  const openResultInNewTab = useCallback(
    async (url: string) => {
      setBusy(true);
      setError(null);
      setNotice("Opening in a new tab…");
      try {
        await api.browserNewTab(url);
        setSearchOpen(false);
        setNotice("Opened in a new tab.");
        window.setTimeout(() => setNotice(null), 4000);
        await refresh();
      } catch (e) {
        setNotice(null);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  async function nav(action: "back" | "forward" | "reload" | "stop") {
    try {
      await api.browserGo(action);
      window.setTimeout(() => void refresh(), 400);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Ask WebKit for the block list again.
   *
   * The old behaviour was to compile once per page created and never look
   * again — a transient failure meant an unprotected browser for the rest of
   * the room's life, with nothing on screen to act on. Never silently degrade:
   * say it failed, say what it costs, and offer the one move that can fix it. */
  async function retryProtection() {
    setRetrying(true);
    try {
      await api.browserRetryProtection();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRetrying(false);
    }
  }

  async function toggleTakeover() {
    const on = !info.takeover;
    await api.browserSetTakeover(on).catch((e) => setError(String(e)));
    await refresh();
  }

  // BROWSE-2: every Save action reports through the same transient notice —
  // success names the files that landed, failure says why, nothing is silent.
  async function runSave(action: () => Promise<string>) {
    setSaving(true);
    setError(null);
    try {
      const message = await action();
      setNotice(message);
      window.setTimeout(() => setNotice(null), 6000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const savePage = () => runSave(() => api.browserSavePage("page"));
  const saveSelection = () => runSave(() => api.browserSavePage("selection"));
  /** Save the destination this toolbar is pointing at.
   *
   * With a page ON SCREEN this saves what you are looking at, through the same
   * capture Save page uses. It used to re-fetch the address as a stranger even
   * then — no session, no cookies — so a signed-in or paywalled article saved
   * its sign-in wall under the real page's title and said "Saved".
   *
   * The fetch is still right for the two things a rendered page cannot give:
   * a video's CAPTIONS and a binary (PDF, image, archive), which is what
   * `needsFreshFetch` names. */
  const saveLink = () =>
    runSave(async () => {
      if (!info.url) throw new Error("No page is open.");
      if (info.open && !blank && !needsFreshFetch(info.url)) {
        return api.browserSavePage("page");
      }
      const meta = await api.importLink(info.url);
      return `Saved "${meta.name}" into the room.`;
    });
  const downloadVideo = () =>
    runSave(async () => {
      if (!info.url) throw new Error("No page is open.");
      await api.startDownloadJob(info.url, "media");
      return "Downloading the video in the background — watch its card in the Activity view.";
    });

  // TWO CHECKS, NOT ONE. The chip used to assert "Trackers blocked." off the
  // storage-ephemerality probe, which knows nothing about blocking — so a
  // browser whose block list had failed to compile looked exactly like one
  // where it had worked. `privacyClaim` takes the weaker of the two facts.
  const claim = privacyClaim(ephemeral, info.protection);
  // The button is a JOURNAL toggle that happens to state a privacy fact. Name
  // the action first: a control whose only label is a claim gives no hint that
  // pressing it does anything.
  const shieldLabel = `${journalOpen ? "Hide" : "Show"} the activity journal. ${claim.detail}`;

  // Which page-scoped controls may be offered at all. One list, read by every
  // control — the Save strip used to hold its own opinion and stayed clickable
  // with no browser open.
  const can = chromeAbilities(info, chromeView);

  // THE RECORD, AS SITTINGS. Rows arrive newest-first, so the first group is
  // the sitting that is live (or, with the browser closed, the one that just
  // ended) and every other group is history the user has to ask for.
  const allSessions = groupSessions(journal, info.session ?? "", facets);
  const sessions = showEarlier ? allSessions : allSessions.slice(0, 1);
  const earlier = Math.max(0, allSessions.length - 1);

  // Is the page on screen actually ENCRYPTED? The shield next to it only ever
  // meant "nothing is written to disk" — it says nothing about the wire, and
  // sites here can be signed into and typed into by the agent. Read from the
  // settled URL Rust reports, so a redirect down to http is visible. Silent
  // while the results page or the start screen is up: the address bar is
  // showing a query then, and a padlock over a query would be a claim about a
  // page nobody is looking at.
  // The page stopped answering the poll. Silent while the results page is up:
  // the native view is parked then, and nobody is looking at the page.
  const stalled = searchOpen ? null : stalledBanner(info);
  const scheme = schemeOf(searchOpen || blank ? null : info.url);
  const secure = scheme === "https:";
  const insecure = scheme === "http:";
  const schemeLabel = secure
    ? "Encrypted connection — this page was served over HTTPS."
    : "Not encrypted — this page was served over plain HTTP. Anything you type into it, including passwords, travels in the clear.";

  return (
    <div className="browser-area">
      {/* Item #18: the ONE live region for this area. The page is a native
          layer — it changes without changing the DOM — so this is the only
          thing that can tell a screen-reader user where they now are. */}
      <p className="browser-sr" role="status">
        {announce}
      </p>
      <div className="browser-chrome">
        {/* Item #18: the first tab stop in the area, visually hidden until it
            has focus — which is what makes the reading view discoverable
            without pretending to detect a screen reader.

            IT LIVES IN THE CHROME, NOT IN THE BODY. Anything positioned inside
            `.browser-body` is drawn UNDER the native page, which covers that
            rect exactly; a skip control there is enabled precisely when it is
            invisible, so its focus ring — the whole point of it — could never
            be seen. The chrome row is the nearest place the app can actually
            paint. */}
        {/* One control, one name. There used to be two differently-worded
            buttons for the same view — this skip link said "Read this page as
            text" and only ever OPENED, so pressing it while the reader was
            already up was a silent no-op. It is a skip link, so it keeps its
            own placement and its own wording about where it takes you, and it
            toggles like its twin in the toolbar. */}
        <button
          className="browser-skip"
          type="button"
          disabled={!can.read && !readerOpen}
          aria-pressed={readerOpen}
          onClick={() => (readerOpen ? closeReader() : openReader())}
        >
          {readerOpen ? "Back to the page" : "Skip to this page as text"}
        </button>
        {/* The drawn marks. Every one of them is an aria-hidden pseudo-icon
            with pointer-events:none (styles/browser.css, .bico) — the button
            around it carries the whole accessible name, exactly as it did
            when these were <svg> components. */}
        <div className="browser-nav">
          <button
            className="browser-btn browser-btn-ico"
            aria-label="Go back"
            disabled={!can.navigate}
            onClick={() => void nav("back")}
          >
            <span className="bico bico-back" aria-hidden />
          </button>
          <button
            className="browser-btn browser-btn-ico"
            aria-label="Go forward"
            disabled={!can.navigate}
            onClick={() => void nav("forward")}
          >
            <span className="bico bico-forward" aria-hidden />
          </button>
          <button
            className="browser-btn browser-btn-ico"
            aria-label={busy ? "Stop loading" : "Reload the page"}
            disabled={!can.navigate}
            onClick={() => void nav(busy ? "stop" : "reload")}
          >
            <span className={`bico ${busy ? "bico-stop" : "bico-reload"}`} aria-hidden />
          </button>
        </div>

        <form
          className="browser-address"
          role="search"
          aria-label="Address and web search"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          {secure || insecure ? (
            <span
              className={`browser-scheme${insecure ? " insecure" : ""}`}
              role="img"
              aria-label={schemeLabel}
              title={schemeLabel}
            >
              {secure ? <LockIcon size={14} /> : <AlertIcon size={14} />}
            </span>
          ) : (
            /* No page, or a results page: the label is a search box right
               now, and the drawn magnifier says so. Decoration — the input's
               own label already tells a screen reader what this box takes. */
            <span className="bico bico-search browser-scheme" aria-hidden />
          )}
          {insecure && <span className="browser-insecure">Not secure</span>}
          <input
            ref={addressRef}
            aria-label="Address — search the web, or type an address and press Enter"
            placeholder="Search or enter a web address"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setEditing(true);
            }}
            onBlur={() => setEditing(false)}
            spellCheck={false}
          />
        </form>

        {/* The badge is a PRIVACY CLAIM, so its ink states how well founded
            the claim is. `ephemeral === true` is a fact the live webview
            answered for and takes the verified ink; `null` means the check
            has not come back (or no page is open) and takes the neutral ink,
            because a claim nobody has checked must not look like one that has
            been. The word and the title already say which is which — the
            colour only stops agreeing with them. */}
        <button
          className={`browser-shield ${claim.tone}`}
          type="button"
          aria-label={shieldLabel}
          title={shieldLabel}
          aria-pressed={journalOpen}
          onClick={() => setJournalOpen((v) => !v)}
        >
          <ShieldIcon size={14} />
          <span>{claim.chip}</span>
        </button>

        <button
          className={`browser-takeover${info.takeover ? " on" : ""}`}
          type="button"
          disabled={!can.takeover}
          aria-pressed={info.takeover === true}
          onClick={() => void toggleTakeover()}
        >
          {info.takeover ? "Hand back to the agent" : "Take over"}
        </button>

        {/* The drawn mark is a stroke coming DOWN into an open tray, because
            "into the room" is the whole meaning of this button — and it opens
            a STRIP, never a menu: a dropdown here would be drawn under the
            native page. */}
        <button
          className="browser-btn browser-save-btn"
          type="button"
          ref={saveRef}
          disabled={!can.save}
          aria-label="Save this page, a selection, the link, or its video into the room"
          aria-expanded={saveOpen}
          onClick={() => setSaveOpen((v) => !v)}
        >
          <span className="bico bico-save" aria-hidden />
          Save
        </button>

        {/* Item #18: the one control that gives a screen reader the page's
            actual content. Named for what it DOES first — the reason it has to
            exist is in the title, not in the accessible name. */}
        <button
          className="browser-btn"
          type="button"
          disabled={!can.read && !readerOpen}
          aria-pressed={readerOpen}
          title="The page is a separate native layer this app cannot put into the reading order. This shows its text here, where a screen reader and the keyboard can reach it."
          onClick={() => (readerOpen ? closeReader() : openReader())}
        >
          Read as text
        </button>

        <button
          className="browser-btn"
          type="button"
          aria-label="Show what the agent did in this browser"
          aria-pressed={journalOpen}
          onClick={() => setJournalOpen((v) => !v)}
        >
          Journal
        </button>
      </div>

      {saveOpen && (
        // A GROUP, not a `toolbar`: `role="toolbar"` promises arrow-key
        // navigation between its controls, and these are plain tab stops.
        // Claiming the role without the behaviour is a lie to assistive tech.
        <div
          className="browser-banner browser-save-row"
          role="group"
          aria-label="Save into the room"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setSaveOpen(false);
            saveRef.current?.focus();
          }}
        >
          {/* `!can.save`, not `saving`: gated on `saving` alone these four
              stayed clickable with no browser open at all — the parent button
              greyed out while its own strip stayed live, and each one failed
              down in Rust with "The browser isn't open." */}
          <button
            className="browser-btn"
            disabled={saving || !can.save}
            onClick={() => void savePage()}
          >
            Save page
          </button>
          <button
            className="browser-btn"
            disabled={saving || !can.save}
            onClick={() => void saveSelection()}
          >
            Save selection
          </button>
          <button
            className="browser-btn"
            disabled={saving || !can.save}
            onClick={() => void saveLink()}
          >
            Save link
          </button>
          <button
            className="browser-btn"
            disabled={saving || !can.save}
            onClick={() => void downloadVideo()}
          >
            Download video
          </button>
          <span className="browser-save-hint">
            Everything lands in this room's files — nothing touches your Downloads folder.
          </span>
        </div>
      )}
      {notice && (
        <div className="browser-banner" role="status">
          {notice}
          <button className="browser-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* BROWSE-3: results are still in memory behind this page. Coming back
          is a state flip, not a navigation — no re-search, no history entry,
          and the scroll position survives. Normal flow, like the Save strip. */}
      {/* Not while the reading view is up: pressing it would put the results
          list back over a page the reader is still transcribing, and the
          reader's own toggle would go disabled with `aria-pressed` still
          true — a control the user cannot un-press. */}
      {search && !searchOpen && !readerOpen && (
        <div className="browser-banner browser-results-row" role="status">
          <button className="browser-btn" onClick={() => setSearchOpen(true)}>
            ◂ Results
          </button>
          <span>
            for <b>{search.query}</b>
          </span>
        </div>
      )}

      {info.takeover && (
        <div className="browser-banner" role="status">
          You have the wheel — the agent's browsing tools are paused until you
          hand it back.
        </div>
      )}
      {/* THE PROTECTION ENGINE FAILED AND THE CHIP USED TO SAY NOTHING.
          The block list is compiled by WebKit per page and the verdict went
          only into the journal, where it sat behind a panel nobody had open —
          while the shield went on claiming "Trackers blocked." An engine that
          did not start is a fact about the page in front of the user, so it is
          stated in front of the user, with the one action that can fix it. */}
      {claim.alert && (
        <div className="browser-banner error" role="status">
          {claim.alert}
          {/* Only when the sentence above it is the one Retry can act on. A
              non-ephemeral STORE and a failed block list can be true at once,
              and the storage warning outranks — a Retry beside it would
              recompile the tracker list and change nothing the banner says. */}
          {claim.alert === protectionAlert(info.protection) && (
            info.protection?.state === "failed") && (
            <button
              className="browser-btn"
              disabled={retrying}
              onClick={() => void retryProtection()}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {/* A page that stopped answering looks EXACTLY like one that is fine —
          the address bar falls back to Rust's own record, so the chrome stays
          confident about a page it can no longer see. Say it on screen, not
          only in the live region. */}
      {stalled && (
        <div className="browser-banner error" role="status">
          {stalled}
        </div>
      )}
      {error && (
        <div className="browser-banner error" role="alert">
          {error}
          {/* The recovery for "that wasn't an address" is a BUTTON, never an
              automatic search: typing an internal hostname must not broadcast
              it to seven engines without the user choosing to. */}
          {failedInput && (
            <button
              className="browser-btn"
              onClick={() => {
                const input = failedInput;
                setError(null);
                setFailedInput(null);
                void runSearch(input);
              }}
            >
              Search the web for “{failedInput}” instead
            </button>
          )}
          <button
            className="browser-btn"
            onClick={() => {
              setError(null);
              setFailedInput(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* `split` is what keeps the live page beside the transcript — either
          because the user asked to compare, or because an extraction is under
          way and the page needs a real layout viewport to be read at all. */}
      <div
        className={`browser-body${readerOpen ? " reading" : ""}${
          readerOpen && (comparing || extracting > 0) ? " split" : ""
        }`}
      >
        {/* EMPTY BY DESIGN — the native page is parked over this rect, and it
            stays OUT of the accessibility tree. Naming it (`role="region"`,
            `aria-label="the web page"`) would put a region in the rotor that
            contains nothing at all: a promise that this app can show a screen
            reader the page, which from the host DOM it cannot. The honest
            route is the reading view above. */}
        <div className="browser-stage" ref={stageRef} aria-hidden />
        {/* BROWSE-3: the results page. Shown over the parked webview, so it
            takes precedence over the start screen. */}
        {searchOpen && search && (
          <BrowserSearch
            result={search}
            onOpen={(url) => void openResult(url)}
            onOpenNewTab={(url) => void openResultInNewTab(url)}
            onAsk={(q) => onAsk?.(q)}
            onAdded={(file) => onAttach?.(file)}
          />
        )}

        {searching && !searchOpen && <BrowserSearchSkeleton query={pending} />}

        {!searchOpen && !searching && (!info.open || blank) && (
          /* A ruled start page, not a centred globe. It is a real React
             surface rather than something drawn over the page: the native
             view is parked at 1×1 for as long as `blank` is true, which is
             the only reason anything here can be seen at all. */
          <div className="browser-start">
            <div className="bstart-sheet">
              <h1 className="bstart-title">Private browser</h1>
              {/* The copy is DERIVED, not written here: it used to promise
                  "trackers blocked" unconditionally, on a screen that is shown
                  precisely when the block list may have failed to compile. */}
              <p className="bstart-copy">{startScreenCopy(info.protection)}</p>
              <p className="bstart-copy">
                Search or type an address above, or ask the assistant to look
                something up — it can drive this browser for you, and everything
                it does is recorded in the Journal.
              </p>
            </div>
            {/* Marginalia: fixed content, inert, aria-hidden, and drawn
                outside the sheet, pointing up at the address box. The
                stylesheet removes it entirely as soon as the centre pane is
                too narrow to have a margin to draw it in. */}
            <aside className="bstart-aside" aria-hidden="true">
              <span className="bstart-aside-note">start here</span>
              <span className="nb-arrow-curve nb-arrow-curve--ne bstart-aside-arrow" />
            </aside>
          </div>
        )}

        {journalOpen && (
          <aside className="browser-journal" aria-label="Browser journal">
            <header>
              <h2>What happened here</h2>
              {confirmClear ? (
                <span className="browser-journal-confirm">
                  {/* THE CONFIRMATION NAMES THE WHOLE DELETION. "Erase this
                      record?" understated it: the command behind this button
                      also empties the web cache — the searches, page text and
                      preview images the room had kept. */}
                  <span>{clearWarning(clearScope)}</span>
                  <button
                    className="browser-btn browser-btn-danger"
                    onClick={() => {
                      setConfirmClear(false);
                      void api.browserClearJournal().then(loadJournal);
                    }}
                  >
                    Erase
                  </button>
                  <button className="browser-btn" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  className="browser-btn"
                  disabled={journal.length === 0}
                  title={
                    journal.length === 0
                      ? "Nothing recorded yet"
                      : "Erase this record and the room's web cache — it cannot be brought back"
                  }
                  onClick={() => {
                    setConfirmClear(true);
                    // Dropped first. Keeping the last answer would render the
                    // PREVIOUS deletion's counts for the length of the round
                    // trip, and a confirmation that exists to state the true
                    // magnitude of a deletion must not state a stale one.
                    setClearScope(null);
                    void api
                      .browserClearScope()
                      .then(setClearScope)
                      .catch(() => setClearScope(null));
                  }}
                >
                  Clear
                </button>
              )}
            </header>
            <p className="browser-journal-note">{EPHEMERAL_VS_ROOM}</p>
            {/* SIX FILTERS OVER TWELVE KINDS. None pressed is "everything" —
                the state you reach by turning them all off has to be the state
                you started in, or the panel goes blank for no reason the user
                can see. */}
            <div
              className="browser-journal-facets"
              role="group"
              aria-label="Filter the record"
            >
              {FACETS.map((f) => {
                const on = facets.includes(f.id);
                return (
                  <button
                    key={f.id}
                    className="browser-btn"
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setFacets((prev) =>
                        on ? prev.filter((x) => x !== f.id) : [...prev, f.id],
                      )
                    }
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            {sessions.length === 0 ? (
              <p className="browser-journal-empty">Nothing yet.</p>
            ) : (
              sessions.map((session, at) => (
                <section
                  key={session.id || `earlier-${at}`}
                  className="browser-journal-session"
                >
                  <h3>
                    {session.current ? "This sitting" : "Earlier"}
                    <span className="browser-journal-when" dir="ltr">
                      {journalTime(session.from)}
                    </span>
                  </h3>
                  {/* Counted over the WHOLE sitting, never over the filtered
                      view: a headline that moves when you tick a filter is
                      describing the filter. */}
                  <p className="browser-journal-summary">{session.summary}</p>
                  {session.lines.length === 0 ? (
                    <p className="browser-journal-empty">
                      Nothing in this sitting matches those filters.
                    </p>
                  ) : (
                    /* An annotated journal: a pencil thread down the margin
                       (paper.css .nb-connect) with a node per entry, the kind
                       on a strip of tape, what was done in the hand, and the
                       address and the instant in mono — the two facts a user
                       has to be able to check character by character.
                       `dir` is set on both, and differently on purpose: a
                       description can quote a page title or a query in Hebrew
                       or Arabic and must read in its own direction, while an
                       address is always shown left to right — that is how an
                       address bar renders one, and a reordered URL is a
                       misread URL. */
                    <ol className="nb-connect browser-journal-list">
                      {session.lines.map(({ row, runs }) => (
                        <li key={row.id} data-kind={row.kind}>
                          <span className="jk">{row.kind}</span>
                          <span className="jd" dir="auto">
                            {row.detail}
                            {/* The blocker journals once per page created, so
                                one broken block list wrote the same sentence
                                dozens of times and buried the sitting. */}
                            {runs > 1 && (
                              <span className="jn"> ×{runs}</span>
                            )}
                          </span>
                          {row.url && (
                            <span className="ju" dir="ltr">
                              {row.url}
                            </span>
                          )}
                          <time dateTime={row.at}>{journalTime(row.at)}</time>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              ))
            )}
            {earlier > 0 && (
              <button
                className="browser-btn browser-journal-more"
                type="button"
                aria-expanded={showEarlier}
                onClick={() => setShowEarlier((v) => !v)}
              >
                {showEarlier
                  ? "Hide earlier sittings"
                  : `Show ${earlier} earlier sitting${earlier === 1 ? "" : "s"}`}
              </button>
            )}
          </aside>
        )}

        {/* Item #18. A PANEL, never an overlay — nothing may draw over the
            native page. It REPLACES the page rather than splitting the pane
            with it (see `comparing`), and hands the page a real layout
            viewport back for exactly as long as an extraction needs one. */}
        {readerOpen && (
          <BrowserReader
            info={info}
            comparing={comparing}
            onCompare={setComparing}
            onExtracting={borrowStage}
            onNavigate={(url) => void openResult(url)}
            onClose={closeReader}
          />
        )}
      </div>
    </div>
  );
}
