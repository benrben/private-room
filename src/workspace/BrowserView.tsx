import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
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
  const [busy, setBusy] = useState(false);
  // BROWSE-2: the Save strip. A DROPDOWN cannot exist here (the native page
  // floats above all DOM), so Save opens a second chrome ROW in normal flow.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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
    if (parked || blank || searchOpen) {
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
  }, [parked, blank, searchOpen]);

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
  const refresh = useCallback(async () => {
    try {
      const next = await api.browserInfo();
      setInfo(next);
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
    } catch {
      /* the room may be closing */
    }
    // `ephemeral` is no longer a dependency: which page the shield has been
    // verified for lives in a ref, so the poll does not have to be rebuilt
    // every time the answer changes.
  }, [editing]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

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

  const shield =
    ephemeral === true
      ? "Nothing is saved — no history, cookies or cache. Trackers blocked."
      : ephemeral === false
        ? "WARNING: this page's storage is NOT ephemeral."
        : "Private browsing: nothing is saved to disk.";
  // The button is a JOURNAL toggle that happens to state a privacy fact. Name
  // the action first: a control whose only label is a claim gives no hint that
  // pressing it does anything.
  const shieldLabel = `${journalOpen ? "Hide" : "Show"} the activity journal. ${shield}`;

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
        <button
          className="browser-skip"
          type="button"
          disabled={!info.open || blank}
          onClick={openReader}
        >
          Read this page as text
        </button>
        {/* The drawn marks. Every one of them is an aria-hidden pseudo-icon
            with pointer-events:none (styles/browser.css, .bico) — the button
            around it carries the whole accessible name, exactly as it did
            when these were <svg> components. */}
        <div className="browser-nav">
          <button
            className="browser-btn browser-btn-ico"
            aria-label="Go back"
            disabled={!info.open}
            onClick={() => void nav("back")}
          >
            <span className="bico bico-back" aria-hidden />
          </button>
          <button
            className="browser-btn browser-btn-ico"
            aria-label="Go forward"
            disabled={!info.open}
            onClick={() => void nav("forward")}
          >
            <span className="bico bico-forward" aria-hidden />
          </button>
          <button
            className="browser-btn browser-btn-ico"
            aria-label={busy ? "Stop loading" : "Reload the page"}
            disabled={!info.open}
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
          className={`browser-shield${
            ephemeral === false ? " warn" : ephemeral === null ? " pending" : ""
          }`}
          type="button"
          aria-label={shieldLabel}
          title={shieldLabel}
          aria-pressed={journalOpen}
          onClick={() => setJournalOpen((v) => !v)}
        >
          <ShieldIcon size={14} />
          <span>{ephemeral === false ? "Not private" : "Private"}</span>
        </button>

        <button
          className={`browser-takeover${info.takeover ? " on" : ""}`}
          type="button"
          disabled={!info.open}
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
          disabled={!info.open || blank}
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
          disabled={!info.open || blank}
          aria-pressed={readerOpen}
          title="The page is a separate native layer this app cannot put into the reading order. This shows its text here, where a screen reader and the keyboard can reach it."
          onClick={() => (readerOpen ? setReaderOpen(false) : openReader())}
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
          <button className="browser-btn" disabled={saving} onClick={() => void savePage()}>
            Save page
          </button>
          <button className="browser-btn" disabled={saving} onClick={() => void saveSelection()}>
            Save selection
          </button>
          <button className="browser-btn" disabled={saving} onClick={() => void saveLink()}>
            Save link
          </button>
          <button className="browser-btn" disabled={saving} onClick={() => void downloadVideo()}>
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
      {search && !searchOpen && (
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

      <div className={`browser-body${readerOpen ? " reading" : ""}`}>
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
              <p className="bstart-copy">
                A browser that keeps nothing: no history, no cookies, no cache,
                trackers blocked. Search or type an address above, or just ask
                the assistant to look something up — it can drive this browser
                for you, and everything it does is recorded in the Journal.
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
                  <span>Erase this record?</span>
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
                      : "Erase this record — it cannot be brought back"
                  }
                  onClick={() => setConfirmClear(true)}
                >
                  Clear
                </button>
              )}
            </header>
            <p className="browser-journal-note">
              The web side of this browser saves nothing. This is the record of
              what the assistant did, kept inside your room.
            </p>
            {journal.length === 0 ? (
              <p className="browser-journal-empty">Nothing yet.</p>
            ) : (
              /* An annotated journal: a pencil thread down the margin
                 (paper.css .nb-connect) with a node per entry, the kind on a
                 strip of tape, what was done in the hand, and the address and
                 the instant in mono — the two facts a user has to be able to
                 check character by character.
                 `dir` is set on both, and differently on purpose: a
                 description can quote a page title or a query in Hebrew or
                 Arabic and must read in its own direction, while an address
                 is always shown left to right — that is how an address bar
                 renders one, and a reordered URL is a misread URL. */
              <ol className="nb-connect browser-journal-list">
                {journal.map((row) => (
                  <li key={row.id} data-kind={row.kind}>
                    <span className="jk">{row.kind}</span>
                    <span className="jd" dir="auto">
                      {row.detail}
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
          </aside>
        )}

        {/* Item #18. A PANEL that shrinks the stage, never an overlay: the
            native page must keep a real layout viewport beside it or the text
            it reports is a 1px-wide reflow of itself. */}
        {readerOpen && (
          <BrowserReader
            info={info}
            onNavigate={(url) => void openResult(url)}
            onClose={() => {
              setReaderOpen(false);
              // Focus must land somewhere the user chose, not nowhere.
              addressRef.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}
