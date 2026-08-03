import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { BrowserSearchResult, FileMeta, ResultPreview, WebHit } from "../apiTypes";
import { GlobeIcon, PlusIcon, CheckIcon, EyeIcon, LinkIcon, SparklesIcon } from "../icons";

/* BROWSE-3: the results page.
 *
 * This renders in the HOST while the native webview is parked at 1x1 — the
 * same mechanism the start screen uses. That is why a results page can exist at
 * all: nothing can be drawn OVER the native page, so the only way to show one
 * is to shrink the page out of the way first (see BrowserView's pushBounds).
 *
 * Two deliberate departures from every other search page:
 *
 *  1. THE LAYOUT ENCODES THE RANKING. The fusion score picks each card's tier —
 *     a feature card, then a two-up row, then compact rows. A flat list renders
 *     the 8th result with the same authority as the 1st, which is a lie the
 *     ranking already disagrees with.
 *  2. CROSS-ENGINE AGREEMENT IS VISIBLE. The dial on each card gives all seven
 *     engines a FIXED slot, so "who agreed" is readable by position at a
 *     glance. It is the one ranking signal a single search engine cannot show.
 *
 * The page itself never fetches anything. Preview images arrive as data URLs
 * from the Rust guard (BROWSE-3b), so no result origin ever sees a browser.
 */

/** Fixed slot order for the consensus dial — must match the sidecar's engine
 *  priority (DEFAULT_ENGINES). Same engine, same angle, on every card. */
const ENGINE_SLOTS = [
  "duckduckgo",
  "brave",
  "mojeek",
  "marginalia",
  "wikipedia",
  "ddg-ia",
  "news",
] as const;

/** How many results the enrich pass is asked about. Rust caps this too; asking
 *  for exactly what it will read keeps the two honest with each other. */
const PREVIEW_COUNT = 8;

type AddState = "idle" | "adding" | "added" | "error";

export interface BrowserSearchProps {
  result: BrowserSearchResult;
  /** Open a result in this tab. The results stay in memory behind it. */
  onOpen: (url: string) => void;
  onOpenNewTab: (url: string) => void;
  /** Hand the query to the assistant (the results are already cached, so its
   *  own web_search costs nothing). */
  onAsk: (query: string) => void;
  /** A result became a room file — the caller pins it to the composer, which
   *  is what makes "available to the agent" literal for the next turn. */
  onAdded: (meta: FileMeta) => void;
}

export function BrowserSearch({
  result,
  onOpen,
  onOpenNewTab,
  onAsk,
  onAdded,
}: BrowserSearchProps) {
  const { hits, query } = result;
  const [previews, setPreviews] = useState<Record<string, ResultPreview>>({});
  const [peeks, setPeeks] = useState<Record<string, string | null>>({});
  const [adds, setAdds] = useState<Record<string, AddState>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  // True once the enrich pass has SETTLED — including when it failed, or came
  // back short. Without it a rejected call left every top card shimmering
  // forever, because the shimmer only ever cleared when a row arrived, so the
  // monogram fallback below could never be reached.
  const [previewsSettled, setPreviewsSettled] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // --- the enrich pass -----------------------------------------------------
  // Runs AFTER the results are on screen, never before: the page is complete
  // without it, and a slow stranger's server must not be able to delay a
  // search. Results fade into fixed slots, so nothing shifts when they land.
  useEffect(() => {
    setPreviews({});
    setPeeks({});
    setAdds({});
    setSummary(null);
    setSummaryError(null);
    setSel(0);
    setPreviewsSettled(false);
    if (!result.previewsEnabled || hits.length === 0) {
      setPreviewsSettled(true);
      return;
    }
    let live = true;
    void api
      .browserPreview(hits.slice(0, PREVIEW_COUNT).map((h) => h.url))
      .then((rows) => {
        if (!live) return;
        const next: Record<string, ResultPreview> = {};
        rows.forEach((row) => {
          next[row.url] = row;
        });
        setPreviews(next);
      })
      .catch(() => {
        /* previews are decoration: a failure leaves monogram tiles */
      })
      .finally(() => {
        // Settled either way. A card that never got a row must fall back to its
        // monogram tile, not shimmer for the life of the page.
        if (live) setPreviewsSettled(true);
      });
    return () => {
      live = false;
    };
  }, [hits, query, result.previewsEnabled]);

  const maxScore = useMemo(
    () => hits.reduce((m, h) => Math.max(m, h.score), 0) || 1,
    [hits],
  );

  // --- actions -------------------------------------------------------------
  const add = useCallback(
    async (hit: WebHit) => {
      if (adds[hit.url] === "adding" || adds[hit.url] === "added") return;
      setAdds((m) => ({ ...m, [hit.url]: "adding" }));
      setAddError(null);
      try {
        const meta = await api.importSearchResult(hit.url, hit.title);
        setAdds((m) => ({ ...m, [hit.url]: "added" }));
        onAdded(meta);
      } catch (e) {
        setAdds((m) => ({ ...m, [hit.url]: "error" }));
        // Named on the page, not in a toast that can be missed — the 800 MB
        // refusal and "web access is off" both have to be readable here.
        setAddError(String(e));
      }
    },
    [adds, onAdded],
  );

  const peek = useCallback(
    async (hit: WebHit) => {
      if (hit.url in peeks) {
        setPeeks((m) => {
          const next = { ...m };
          delete next[hit.url];
          return next;
        });
        return;
      }
      setPeeks((m) => ({ ...m, [hit.url]: null }));
      try {
        const text = await api.browserPeek(hit.url);
        setPeeks((m) => ({ ...m, [hit.url]: text }));
      } catch (e) {
        setPeeks((m) => ({ ...m, [hit.url]: `Could not read that page — ${e}` }));
      }
    },
    [peeks],
  );

  const summarize = useCallback(async () => {
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      setSummary(await api.browserSearchSummary(query));
    } catch (e) {
      setSummaryError(String(e));
    } finally {
      setSummaryBusy(false);
    }
  }, [query]);

  // --- keyboard ------------------------------------------------------------
  // The page is fully drivable without the mouse; the selected card is the
  // subject of every single-key action.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const hit = hits[sel];
      const step = (delta: number) => {
        e.preventDefault();
        setSel((s) => Math.max(0, Math.min(hits.length - 1, s + delta)));
      };
      if (e.key === "ArrowDown" || e.key === "j") step(1);
      else if (e.key === "ArrowUp" || e.key === "k") step(-1);
      else if (e.key === "Enter" && hit) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) onOpenNewTab(hit.url);
        else onOpen(hit.url);
      } else if (e.key === "p" && hit) {
        e.preventDefault();
        void peek(hit);
      } else if ((e.key === "a" || e.key === "+") && hit) {
        e.preventDefault();
        void add(hit);
      }
    },
    [hits, sel, onOpen, onOpenNewTab, peek, add],
  );

  // Hand the keyboard to the results the moment they arrive. Every single-key
  // action above is dead until this container holds focus, and a page that
  // ignores ArrowDown right after a search reads as broken rather than as
  // "press Tab first". The search was started from the address bar, so nothing
  // is being typed into when this runs.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [hits]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // --- pieces --------------------------------------------------------------
  const card = (hit: WebHit, idx: number, tier: "feature" | "duo" | "row") => (
    <SearchCard
      key={hit.url}
      hit={hit}
      idx={idx}
      tier={tier}
      selected={idx === sel}
      preview={previews[hit.url]}
      previewsPending={result.previewsEnabled && !previewsSettled}
      peek={hit.url in peeks ? peeks[hit.url] : undefined}
      addState={adds[hit.url] ?? "idle"}
      relative={hit.score / maxScore}
      onSelect={() => setSel(idx)}
      onOpen={() => onOpen(hit.url)}
      onOpenNewTab={() => onOpenNewTab(hit.url)}
      onPeek={() => void peek(hit)}
      onAdd={() => void add(hit)}
    />
  );

  if (hits.length === 0) {
    // An engine that FAILED is not an engine that found nothing. With no
    // internet every one of them fails, and blaming the user's wording ("try
    // fewer words") for what is a dead connection sends them rewriting a query
    // that was never the problem. Only say "nothing matched" when engines
    // actually answered.
    const failed = result.failed ?? [];
    const allFailed = failed.length >= ENGINE_SLOTS.length;
    return (
      <div className="bsearch" onKeyDown={onKeyDown} tabIndex={-1}>
        <SearchHeader result={result} />
        <div className="bsearch-empty">
          <GlobeIcon size={30} />
          {allFailed ? (
            <>
              <h2>The search couldn't run</h2>
              <p>
                None of the {ENGINE_SLOTS.length} engines answered, so nothing
                was searched for “{query}”. Check your internet connection and
                try again — this is not about your wording.
              </p>
            </>
          ) : (
            <>
              <h2>No results across seven engines</h2>
              <p>
                Nothing came back for “{query}”. Try fewer words, or open it as
                an address if it was one.
                {failed.length > 0 &&
                  ` ${failed.length} of ${ENGINE_SLOTS.length} engines (${failed.join(", ")}) didn't answer, so this may be only part of the web.`}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="bsearch" onKeyDown={onKeyDown} tabIndex={0} ref={listRef}>
      <SearchHeader result={result} />

      {result.summaryAvailable && (
        <SummaryCard
          summary={summary}
          busy={summaryBusy}
          error={summaryError}
          hits={hits}
          onRun={() => void summarize()}
          onCite={(n) => {
            const hit = hits[n - 1];
            if (hit) {
              setSel(n - 1);
              listRef.current
                ?.querySelector<HTMLElement>(`[data-idx="${n - 1}"]`)
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
            }
          }}
        />
      )}

      <button className="bsearch-ask" type="button" onClick={() => onAsk(query)}>
        <SparklesIcon size={15} />
        <span>
          <b>Ask the assistant about this</b> — it can read these pages and work
          from them; the results are already cached, so its search is free.
        </span>
      </button>

      {addError && (
        <div className="bsearch-error" role="alert">
          {addError}
          <button className="browser-btn" onClick={() => setAddError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {card(hits[0], 0, "feature")}

      {hits.length > 1 && (
        <div className="bsearch-duo">
          {hits.slice(1, 3).map((h, i) => card(h, i + 1, "duo"))}
        </div>
      )}

      {hits.length > 3 && (
        <div className="bsearch-rows">
          {hits.slice(3).map((h, i) => card(h, i + 3, "row"))}
        </div>
      )}

      <footer className="bsearch-foot">
        <span>Searched privately — no account, no profile, no click tracking.</span>
        <span>Engines: {ENGINE_SLOTS.join(" · ")}</span>
      </footer>
    </div>
  );
}

/** What the page looks like while the engines are still answering.
 *
 * NOT a spinner on an empty screen: the query is echoed immediately and the
 * result tiers are drawn as skeletons, so the shape of the answer is on screen
 * before the answer is. The elapsed counter is there because a wait you can
 * see the length of reads as progress, and a wait you cannot reads as a hang
 * (owner report 2026-08-01: "it's stuck on Searching…"). */
export function BrowserSearchSkeleton({ query }: { query: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="bsearch" aria-busy="true">
      <header className="bsearch-head">
        <h1 dir="auto">{query}</h1>
        <div className="bsearch-fuse" aria-hidden>
          {ENGINE_SLOTS.map((e, i) => (
            <i key={e} className="pending" style={{ ["--i" as string]: String(i) }} />
          ))}
        </div>
        <p className="bsearch-meta">
          <span>Asking {ENGINE_SLOTS.length} engines and merging what they agree on…</span>
          <span className="sep">·</span>
          <span>{secs}s</span>
          <span className="sep">·</span>
          <span className="privacy">only your query left this Mac</span>
        </p>
      </header>
      <div className="bsearch-skel feature" />
      <div className="bsearch-duo">
        <div className="bsearch-skel duo" />
        <div className="bsearch-skel duo" />
      </div>
      <div className="bsearch-rows">
        <div className="bsearch-skel row" />
        <div className="bsearch-skel row" />
        <div className="bsearch-skel row" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- header -- */

function SearchHeader({ result }: { result: BrowserSearchResult }) {
  const present = new Set(result.hits.flatMap((h) => h.engines));
  return (
    <header className="bsearch-head">
      <h1 dir="auto">{result.query}</h1>
      <div className="bsearch-fuse" aria-hidden>
        {ENGINE_SLOTS.map((e, i) => (
          <i
            key={e}
            className={present.has(e) ? "on" : ""}
            style={{ ["--i" as string]: String(i) }}
            data-engine={e}
          />
        ))}
      </div>
      <p className="bsearch-meta">
        {result.cached ? (
          <span>Recent results from this Mac</span>
        ) : (
          <span>
            {result.merged} hits merged into {result.hits.length}
          </span>
        )}
        <span className="sep">·</span>
        {result.cached ? (
          <span>no network touched</span>
        ) : (
          <span>{(result.tookMs / 1000).toFixed(1)}s</span>
        )}
        <span className="sep">·</span>
        <span className="privacy">only your query left this Mac</span>
        {/* Naming the engines that fell out is the difference between "the web
            is thin on this" and "two of our scrapers are being rate limited
            right now" — indistinguishable from the result count alone. */}
        {result.failed && result.failed.length > 0 && (
          <>
            <span className="sep">·</span>
            <span className="bsearch-blocked" title="These engines were blocked, rate limited or too slow, so these results are only part of the web.">
              {result.failed.join(", ")} unavailable
            </span>
          </>
        )}
        {/* The keys are live as soon as the results are (the page takes focus
            on arrival): say so, because a single-key shortcut nobody is told
            about is not a feature. */}
        {result.hits.length > 0 && (
          <>
            <span className="sep">·</span>
            <span>↑↓ or j/k move · ↩ open · p peek · a add to the chat</span>
          </>
        )}
        {result.previewsEnabled && (
          <>
            <span className="sep">·</span>
            <span
              className="hint"
              title="Result pages are read by the app itself to get their preview image and description — no cookies, no scripts, no browser fingerprint. Turn off in Settings → Online features."
            >
              previews fetched privately
            </span>
          </>
        )}
      </p>
    </header>
  );
}

/* --------------------------------------------------------------- summary -- */

/** The AI summary (owner request 2026-08-01).
 *
 * On demand, not automatic: it costs a model call and three page reads, and a
 * summary nobody asked for above results they can already read is noise. Every
 * claim carries a [n] citation that jumps to the result it came from — a
 * summary that cannot be checked against its sources has no business sitting
 * above them. */
function SummaryCard({
  summary,
  busy,
  error,
  hits,
  onRun,
  onCite,
}: {
  summary: string | null;
  busy: boolean;
  error: string | null;
  hits: WebHit[];
  onRun: () => void;
  onCite: (n: number) => void;
}) {
  if (!summary && !busy && !error) {
    return (
      <button className="bsearch-summary-ask" type="button" onClick={onRun}>
        <SparklesIcon size={15} />
        <span>
          <b>Summarize these results</b> — one grounded paragraph from the top
          three pages, with every claim cited.
        </span>
      </button>
    );
  }
  return (
    <section className="bsearch-summary" aria-live="polite">
      <div className="bsearch-summary-head">
        <SparklesIcon size={14} />
        <b>Summary of the top results</b>
        <span className="bsearch-summary-note">
          written on this Mac from the sources below
        </span>
      </div>
      {busy && <p className="bsearch-summary-busy">Reading the top results…</p>}
      {error && <p className="bsearch-summary-error">{error}</p>}
      {summary && (
        <p className="bsearch-summary-text" dir="auto">
          {renderCitations(summary, hits, onCite)}
        </p>
      )}
    </section>
  );
}

/** Turn `[2]` into a button that jumps to result 2. Anything that isn't a real
 *  result number stays plain text — a citation that leads nowhere would be
 *  worse than no citation. */
function renderCitations(
  text: string,
  hits: WebHit[],
  onCite: (n: number) => void,
) {
  const parts: (string | React.ReactElement)[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= hits.length) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push(
        <button
          key={`${m.index}-${n}`}
          className="bsearch-cite"
          type="button"
          title={hits[n - 1].title}
          onClick={() => onCite(n)}
        >
          {n}
        </button>,
      );
      last = m.index + m[0].length;
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/* ------------------------------------------------------------------ card -- */

function SearchCard({
  hit,
  idx,
  tier,
  selected,
  preview,
  previewsPending,
  peek,
  addState,
  relative,
  onSelect,
  onOpen,
  onOpenNewTab,
  onPeek,
  onAdd,
}: {
  hit: WebHit;
  idx: number;
  tier: "feature" | "duo" | "row";
  selected: boolean;
  preview?: ResultPreview;
  /** The enrich pass is still out. Once it settles every card without a
   *  preview shows its monogram tile — nothing waits forever. */
  previewsPending: boolean;
  peek?: string | null;
  addState: AddState;
  relative: number;
  onSelect: () => void;
  onOpen: () => void;
  onOpenNewTab: () => void;
  onPeek: () => void;
  onAdd: () => void;
}) {
  const host = hostOf(hit.url);
  // The page's own description beats the engine's blurb — it is first-party and
  // usually better written. Only once the enrich pass has actually read it.
  const blurb = preview?.description || hit.snippet || null;
  const waiting = previewsPending && !preview && idx < PREVIEW_COUNT;

  return (
    <article
      className={`bsearch-card ${tier}${selected ? " sel" : ""}${peek !== undefined ? " peeked" : ""}`}
      data-idx={idx}
      tabIndex={0}
      aria-label={hit.title}
      onFocus={onSelect}
      onClick={(e) => {
        // Buttons act for themselves, and the reader preview exists to be
        // READ — neither is a request to leave the page.
        if ((e.target as HTMLElement).closest("button, .bsearch-peek")) return;
        // A drag that selected text is not a click on the card: navigating
        // would throw the selection away the moment it was made. Only a
        // selection inside THIS card counts, so a stale one elsewhere on the
        // page can never swallow a real click.
        const picked = window.getSelection();
        if (
          picked &&
          !picked.isCollapsed &&
          picked.toString().trim() &&
          e.currentTarget.contains(picked.anchorNode)
        ) {
          return;
        }
        onSelect();
        onOpen();
      }}
    >
      <div
        className={`bsearch-img${waiting ? " waiting" : ""}${preview?.image ? " has" : ""}`}
        aria-hidden
      >
        {preview?.image ? (
          <img src={preview.image} alt="" loading="lazy" />
        ) : !waiting ? (
          <span className="bsearch-mono" style={monoStyle(host)}>
            {host.replace(/^(www|en|blog|news|groups)\./, "").charAt(0).toUpperCase()}
          </span>
        ) : null}
      </div>

      <div className="bsearch-body">
        {tier === "feature" && (
          <div className="bsearch-eyebrow">
            Top result · {hit.engines.length} of {ENGINE_SLOTS.length} engines agree
          </div>
        )}
        <h3 dir="auto">{hit.title}</h3>
        <div className="bsearch-crumb">
          {preview?.icon && <img className="bsearch-favicon" src={preview.icon} alt="" />}
          <b>{host}</b>
          {pathBits(hit.url).map((p, i) => (
            <span key={i}>
              <i>›</i>
              {p}
            </span>
          ))}
        </div>
        {blurb && (
          <p className="bsearch-snippet" dir="auto">
            {blurb}
          </p>
        )}

        <div className="bsearch-metarow">
          <span
            className="bsearch-dial"
            style={{ background: dialGradient(hit.engines) }}
            title={`Found by ${hit.engines.join(" · ")} — each engine keeps the same slot on every card`}
          />
          <span className="bsearch-engn">
            {hit.engines.length} of {ENGINE_SLOTS.length} engines
          </span>
          {hit.date && <span className="bsearch-date">{hit.date}</span>}
          <span className="bsearch-rel" title={`Relevance ${hit.score.toFixed(2)}`}>
            <i style={{ width: `${Math.round(relative * 100)}%` }} />
          </span>
          {addState === "added" && (
            <span className="bsearch-inroom">
              <CheckIcon size={12} /> In room · attached
            </span>
          )}
          <span className="bsearch-acts">
            <button
              className="browser-btn"
              type="button"
              aria-label="Open in a new tab"
              title="Open in a new tab"
              onClick={onOpenNewTab}
            >
              <LinkIcon size={13} />
            </button>
            <button
              className="browser-btn"
              type="button"
              aria-label="Peek — read a preview without opening"
              title="Peek — read a preview without opening"
              aria-pressed={peek !== undefined}
              onClick={onPeek}
            >
              <EyeIcon size={13} />
            </button>
            <button
              className={`browser-btn bsearch-add${addState === "added" ? " done" : ""}`}
              type="button"
              disabled={addState === "adding"}
              aria-label="Add to the chat as a source"
              title="Add to the chat as a source"
              onClick={onAdd}
            >
              {addState === "added" ? (
                <CheckIcon size={13} />
              ) : addState === "adding" ? (
                <span className="bsearch-spin" />
              ) : (
                <PlusIcon size={13} />
              )}
            </button>
          </span>
        </div>

        {peek !== undefined && (
          <div className="bsearch-peek">
            <div className="bsearch-peek-head">
              Reader preview{peek === null ? " — reading…" : ""}
            </div>
            {peek && <p dir="auto">{peek}</p>}
          </div>
        )}
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------- bits --- */

/** The dial: every engine owns a fixed wedge, lit when it returned this URL.
 *  Same engine, same angle, every card — so agreement is readable by shape. */
function dialGradient(engines: string[]): string {
  const slot = 360 / ENGINE_SLOTS.length;
  const gap = 5;
  const stops = ENGINE_SLOTS.map((engine, i) => {
    const lit = engines.includes(engine);
    const color = lit
      ? `var(--eng-${engine.replace("-", "")})`
      : "color-mix(in srgb, var(--line) 60%, transparent)";
    const a = (i * slot + gap / 2).toFixed(1);
    const b = ((i + 1) * slot - gap / 2).toFixed(1);
    return `transparent ${a}deg, ${color} ${a}deg ${b}deg, transparent ${b}deg`;
  });
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

/** A stable hue per host, so the same site keeps the same tile between
 *  searches. No favicon is fetched for this — that would contact the origin. */
function monoStyle(host: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360;
  return {
    background: `color-mix(in srgb, hsl(${h} 55% 60%) 22%, var(--panel-2))`,
    color: `hsl(${h} 55% 68%)`,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function pathBits(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}
