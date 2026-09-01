import { useEffect, useState } from "react";
import type React from "react";
import type { BrowserSearchResult, ResultPreview, WebHit } from "../apiTypes";
import { SparklesIcon } from "../icons";
import { ENGINE_SLOTS, PREVIEW_COUNT, engineName, type AddState } from "./BrowserSearch";
import {
  CardBlurb,
  FeatureEyebrow,
  ReaderPeek,
  SearchCardImage,
  SearchCardCrumb,
  SearchCardMeta,
  cardDisplay,
  searchCardClassName,
  shouldOpenSearchCard,
} from "./BrowserSearchCards";

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
            <i
              key={e}
              className="pending"
              style={{ ["--i" as string]: String(i) }}
            />
          ))}
        </div>
        <p className="bsearch-meta">
          <span>
            Asking {ENGINE_SLOTS.length} engines and merging what they agree on…
          </span>
          <span className="sep">·</span>
          <span>{secs}s</span>
          <span className="sep">·</span>
          {/* Nothing but the query has gone out YET — the enrich pass only
              starts once results are on screen. Deliberately "so far": this is
              the one state where the finished sentence is not known. */}
          <span className="privacy">
            only your query has left this Mac so far
          </span>
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

/** The one sentence this page is entitled to say about what left the Mac.
 *
 * It used to be three sentences that could contradict each other: a fixed
 * "only your query left this Mac", a separate "previews fetched privately",
 * and a cache hit's "no network touched" printed beside the first. Previews
 * are ON by default and read the top result pages from their own origins — and
 * they run on a cache hit too, because only the SEARCH is cached. So the claim
 * has to be derived from all three facts, in one place, and nowhere else.
 *
 * Pure, so the wording can be tested: on this page the wording is the product.
 */
export function searchPrivacyLine(opts: {
  cached: boolean;
  previewsEnabled: boolean;
  /** How many result pages the enrich pass will actually be asked about. */
  previewCount: number;
}): { text: string; title: string } {
  const { cached, previewsEnabled, previewCount } = opts;
  if (previewsEnabled && previewCount > 0) {
    return previewPrivacyLine(cached, previewCount);
  }
  return noPreviewPrivacyLine(cached);
}

export function previewPrivacyLine(
  cached: boolean,
  previewCount: number,
): { text: string; title: string } {
  const pages = previewPageCount(previewCount);
  return {
    text: cached
      ? `no query left this Mac — the top ${pages} were asked for a preview`
      : `your query, and a request to the top ${pages}, left this Mac`,
    title:
      "Result pages are read by the app itself for their preview image and description — no cookies, no scripts, no browser fingerprint. Turn off in Settings → Online features.",
  };
}

export function previewPageCount(previewCount: number): string {
  return `${previewCount} result page${previewCount === 1 ? "" : "s"}`;
}

export function noPreviewPrivacyLine(cached: boolean): {
  text: string;
  title: string;
} {
  return {
    text: cached ? "nothing left this Mac" : "only your query left this Mac",
    title: cached
      ? "These results were already on this Mac and result previews are off, so no server was contacted."
      : "Result previews are off, so no result page is contacted until you open, peek or add one.",
  };
}

export function SearchHeader({
  result,
  headingId,
}: {
  result: BrowserSearchResult;
  headingId: string;
}) {
  const present = new Set(result.hits.flatMap((h) => h.engines));
  const privacy = searchPrivacyLine({
    cached: result.cached,
    previewsEnabled: result.previewsEnabled,
    previewCount: Math.min(result.hits.length, PREVIEW_COUNT),
  });
  return (
    <header className="bsearch-head">
      <h1 id={headingId} dir="auto">
        {result.query}
      </h1>
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
          // A cache hit skips the ENGINES. It does not skip the enrich pass,
          // so the blanket "no network touched" this used to say argued with
          // the privacy clause three spans along.
          <span>no engines asked</span>
        ) : (
          <span>{(result.tookMs / 1000).toFixed(1)}s</span>
        )}
        <span className="sep">·</span>
        <span className="privacy" title={privacy.title}>
          {privacy.text}
        </span>
        {/* Naming the engines that fell out is the difference between "the web
            is thin on this" and "two of our scrapers are being rate limited
            right now" — indistinguishable from the result count alone. */}
        {result.failed && result.failed.length > 0 && (
          <>
            <span className="sep">·</span>
            <span
              className="bsearch-blocked"
              title="These engines were blocked, rate limited or too slow, so these results are only part of the web."
            >
              {result.failed.map(engineName).join(", ")} unavailable
            </span>
          </>
        )}
        {/* The keys are live as soon as the results are (the page takes focus
            on arrival, unless someone is typing outside this browser): say so,
            because a single-key shortcut nobody is told about is not a
            feature. */}
        {result.hits.length > 0 && (
          <>
            <span className="sep">·</span>
            <span>↑↓ or j/k move · ↩ open · p peek · a add to the chat</span>
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
export function SummaryCard({
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
    return <SummaryPrompt onRun={onRun} />;
  }
  return (
    <SummaryOutput
      busy={busy}
      error={error}
      hits={hits}
      onCite={onCite}
      summary={summary}
    />
  );
}

export function SummaryPrompt({ onRun }: { onRun: () => void }) {
  return (
    <button className="bsearch-summary-ask" type="button" onClick={onRun}>
      <SparklesIcon size={14} />
      <span>
        <b>Summarize these results</b> — one grounded paragraph from the top
        three pages, with every claim cited.
      </span>
    </button>
  );
}

export function SummaryOutput({
  busy,
  error,
  hits,
  onCite,
  summary,
}: Omit<React.ComponentProps<typeof SummaryCard>, "onRun">) {
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
export function renderCitations(
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

export function SearchCard({
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
  const display = cardDisplay(hit, idx, preview, previewsPending);

  return (
    <article
      className={searchCardClassName(tier, selected, peek)}
      data-idx={idx}
      tabIndex={0}
      aria-label={hit.title}
      onFocus={onSelect}
      onClick={(event) => {
        if (!shouldOpenSearchCard(event)) return;
        onSelect();
        onOpen();
      }}
    >
      <SearchCardImage display={display} preview={preview} />

      <div className="bsearch-body">
        <FeatureEyebrow engines={hit.engines} tier={tier} />
        <h3 dir="auto">{hit.title}</h3>
        <SearchCardCrumb host={display.host} preview={preview} url={hit.url} />
        <CardBlurb blurb={display.blurb} />
        <SearchCardMeta
          addState={addState}
          hit={hit}
          onAdd={onAdd}
          onOpenNewTab={onOpenNewTab}
          onPeek={onPeek}
          peek={peek}
          relative={relative}
        />
        <ReaderPeek peek={peek} />
      </div>
    </article>
  );
}
