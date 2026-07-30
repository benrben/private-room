import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BrowseJournalRow, BrowserInfo } from "../apiTypes";
import { GlobeIcon, ShieldIcon, ChevronLeftIcon, ChevronRightIcon } from "../icons";

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

export function BrowserView({ parked }: { parked: boolean }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<BrowserInfo>({ open: false });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ephemeral, setEphemeral] = useState<boolean | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journal, setJournal] = useState<BrowseJournalRow[]>([]);
  const [busy, setBusy] = useState(false);

  // --- bounds: keep the native view glued to the placeholder ---------------
  const pushBounds = useCallback(() => {
    // PARKED: a consent card (or any other modal) is open. The native page
    // floats above every DOM element in this window, so the only way a dialog
    // can actually be seen is to shrink the page out of the way first.
    if (parked) {
      void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
      return;
    }
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    void api.browserSetBounds(r.left, r.top, r.width, r.height).catch(() => {});
  }, [parked]);

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
  async function go(target?: string) {
    const url = (target ?? address).trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      const settled = await api.browserNavigate(url);
      setAddress(settled);
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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
            aria-label="Address — type a web address and press Enter"
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
          aria-label="Show what the agent did in this browser"
          aria-pressed={journalOpen}
          onClick={() => setJournalOpen((v) => !v)}
        >
          Journal
        </button>
      </div>

      {info.takeover && (
        <div className="browser-banner" role="status">
          You have the wheel — the agent's browsing tools are paused until you
          hand it back.
        </div>
      )}
      {error && (
        <div className="browser-banner error" role="alert">
          {error}
          <button className="browser-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="browser-body">
        {/* EMPTY BY DESIGN — the native page is parked over this rect. */}
        <div className="browser-stage" ref={stageRef} aria-hidden />
        {!info.open && (
          <div className="browser-start">
            <div className="viewer-empty-icon">
              <GlobeIcon size={40} />
            </div>
            <h1 className="viewer-empty-title">Private browser</h1>
            <p className="viewer-empty-sub">
              A browser that keeps nothing: no history, no cookies, no cache,
              trackers blocked. Type an address above, or just ask the assistant
              to look something up — it can drive this browser for you, and
              everything it does is recorded in the Journal.
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
