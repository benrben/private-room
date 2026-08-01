import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  BrowseJournalRow,
  BrowserInfo,
  BrowserSearchResult,
  FileMeta,
} from "../apiTypes";
import { GlobeIcon, ShieldIcon, ChevronLeftIcon, ChevronRightIcon } from "../icons";
import { classifyAddress } from "./address";
import { BrowserSearch, BrowserSearchSkeleton } from "./BrowserSearch";

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

const POLL_MS = 1200;

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
  const [journalOpen, setJournalOpen] = useState(false);
  const [journal, setJournal] = useState<BrowseJournalRow[]>([]);
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

  // A brand-new tab sits on `about:blank`, which paints an OPAQUE rectangle.
  // Since the native view floats above the DOM, leaving it there hides the very
  // start screen that tells the user what to do — the whole pane just goes
  // blank (owner report 2026-07-31: "new tab appears, nothing on the
  // workspace"). Reported by Rust from its own record, not read back from the
  // page, because a blank page runs no page script to ask.
  const blank = info.blank === true;

  // --- bounds: keep the native view glued to the placeholder ---------------
  const pushBounds = useCallback(() => {
    // PARKED: a consent card (or any other modal) is open, the page has
    // nowhere to be yet, or the results page is up. The native page floats
    // above every DOM element in this window, so the only way anything
    // underneath can be seen is to shrink the page out of the way first.
    if (parked || blank || searchOpen) {
      void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
      return;
    }
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    void api.browserSetBounds(r.left, r.top, r.width, r.height).catch(() => {});
  }, [parked, blank, searchOpen]);

  useEffect(() => {
    pushBounds();
    const el = stageRef.current;
    if (!el) return;
    // A ResizeObserver alone misses the case that matters most here: the pane
    // moving without changing size (the rail collapsing, a splitter dragging,
    // the window moving). Watch both.
    const ro = new ResizeObserver(pushBounds);
    ro.observe(el);
    window.addEventListener("resize", pushBounds);
    const tick = window.setInterval(pushBounds, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBounds);
      window.clearInterval(tick);
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
      if (!editing && next.url) setAddress(next.url);
      if (next.open && ephemeral === null) {
        // Verified against the LIVE webview, not inferred from a flag: the
        // failure mode is silent, so the shield must report a real check.
        setEphemeral(await api.browserVerifyPrivate().catch(() => null));
      }
      if (!next.open) setEphemeral(null);
    } catch {
      /* the room may be closing */
    }
  }, [editing, ephemeral]);

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
      api.onBrowserNavigated(() => void refresh()),
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

  const openResultInNewTab = useCallback(async (url: string) => {
    try {
      await api.browserNewTab(url);
    } catch (e) {
      setError(String(e));
    }
  }, []);

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
  const saveLink = () =>
    runSave(async () => {
      if (!info.url) throw new Error("No page is open.");
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

  return (
    <div className="browser-area">
      <div className="browser-chrome">
        <div className="browser-nav">
          <button
            className="browser-btn"
            aria-label="Go back"
            disabled={!info.open}
            onClick={() => void nav("back")}
          >
            <ChevronLeftIcon size={16} />
          </button>
          <button
            className="browser-btn"
            aria-label="Go forward"
            disabled={!info.open}
            onClick={() => void nav("forward")}
          >
            <ChevronRightIcon size={16} />
          </button>
          <button
            className="browser-btn"
            aria-label={busy ? "Stop loading" : "Reload the page"}
            disabled={!info.open}
            onClick={() => void nav(busy ? "stop" : "reload")}
          >
            {busy ? "×" : "↻"}
          </button>
        </div>

        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <GlobeIcon size={14} />
          <input
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

        <button
          className={`browser-shield${ephemeral === false ? " warn" : ""}`}
          type="button"
          aria-label={shield}
          title={shield}
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

        <button
          className="browser-btn"
          type="button"
          disabled={!info.open || blank}
          aria-label="Save this page, a selection, the link, or its video into the room"
          aria-expanded={saveOpen}
          onClick={() => setSaveOpen((v) => !v)}
        >
          Save
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
        <div className="browser-banner browser-save-row" role="toolbar" aria-label="Save into the room">
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

      <div className="browser-body">
        {/* EMPTY BY DESIGN — the native page is parked over this rect. */}
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
          <div className="browser-start">
            <div className="viewer-empty-icon">
              <GlobeIcon size={40} />
            </div>
            <h1 className="viewer-empty-title">Private browser</h1>
            <p className="viewer-empty-sub">
              A browser that keeps nothing: no history, no cookies, no cache,
              trackers blocked. Search or type an address above, or just ask the
              assistant to look something up — it can drive this browser for
              you, and everything it does is recorded in the Journal.
            </p>
          </div>
        )}

        {journalOpen && (
          <aside className="browser-journal" aria-label="Browser journal">
            <header>
              <h2>What happened here</h2>
              <button
                className="browser-btn"
                onClick={() => {
                  void api.browserClearJournal().then(loadJournal);
                }}
              >
                Clear
              </button>
            </header>
            <p className="browser-journal-note">
              The web side of this browser saves nothing. This is the record of
              what the assistant did, kept inside your room.
            </p>
            {journal.length === 0 ? (
              <p className="browser-journal-empty">Nothing yet.</p>
            ) : (
              <ol>
                {journal.map((row) => (
                  <li key={row.id} data-kind={row.kind}>
                    <span className="jk">{row.kind}</span>
                    <span className="jd">{row.detail}</span>
                    {row.url && <span className="ju">{row.url}</span>}
                    <time>{row.at.replace("T", " ").replace("Z", "")}</time>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
