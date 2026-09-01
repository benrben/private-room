import type React from "react";
import type { BrowserSearchResult, ResultPreview, WebHit } from "../apiTypes";
import { GlobeIcon, SparklesIcon } from "../icons";
import { ENGINE_SLOTS, engineName, type AddState } from "./BrowserSearch";
import { SearchCard, SearchHeader, SummaryCard } from "./BrowserSearchSummary";

export type SearchResultsProps = {
  add: (hit: WebHit) => Promise<void>;
  addError: string | null;
  adds: Record<string, AddState>;
  headingId: string;
  hits: WebHit[];
  listRef: React.RefObject<HTMLDivElement | null>;
  maxScore: number;
  onAsk: (query: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onOpen: (url: string) => void;
  onOpenNewTab: (url: string) => void;
  peek: (hit: WebHit) => Promise<void>;
  peeks: Record<string, string | null>;
  previews: Record<string, ResultPreview>;
  previewsPending: boolean;
  result: BrowserSearchResult;
  selected: number;
  setAddError: React.Dispatch<React.SetStateAction<string | null>>;
  setSelected: React.Dispatch<React.SetStateAction<number>>;
  summarize: () => Promise<void>;
  summary: string | null;
  summaryBusy: boolean;
  summaryError: string | null;
};

export function EmptySearch({
  headingId,
  onKeyDown,
  result,
}: Pick<SearchResultsProps, "headingId" | "onKeyDown" | "result">) {
  return (
    <div
      className="bsearch"
      role="group"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <SearchHeader result={result} headingId={headingId} />
      <EmptySearchMessage query={result.query} failed={result.failed ?? []} />
    </div>
  );
}

export function EmptySearchMessage({
  query,
  failed,
}: {
  query: string;
  failed: string[];
}) {
  if (failed.length >= ENGINE_SLOTS.length) {
    return (
      <div className="bsearch-empty">
        <GlobeIcon size={30} />
        <h2>The search couldn't run</h2>
        <p>
          None of the {ENGINE_SLOTS.length} engines answered, so nothing was
          searched for “{query}”. Check your internet connection and try again —
          this is not about your wording.
        </p>
      </div>
    );
  }
  return <NoSearchMatches query={query} failed={failed} />;
}

export function NoSearchMatches({
  query,
  failed,
}: {
  query: string;
  failed: string[];
}) {
  const failureNote = failed.length > 0 ? searchFailureNote(failed) : null;
  return (
    <div className="bsearch-empty">
      <GlobeIcon size={30} />
      <h2>No results across seven engines</h2>
      <p>
        Nothing came back for “{query}”. Try fewer words, or open it as an
        address if it was one.
        {failureNote}
      </p>
    </div>
  );
}

export function searchFailureNote(failed: string[]): string {
  return ` ${failed.length} of ${ENGINE_SLOTS.length} engines (${failed
    .map(engineName)
    .join(", ")}) didn't answer, so this may be only part of the web.`;
}

export function SearchResults(props: SearchResultsProps) {
  return (
    <div
      className="bsearch"
      role="group"
      aria-labelledby={props.headingId}
      onKeyDown={props.onKeyDown}
      tabIndex={0}
      ref={props.listRef}
    >
      <SearchHeader result={props.result} headingId={props.headingId} />
      <OptionalSummary {...props} />
      <AskSearch onAsk={props.onAsk} query={props.result.query} />
      <AddError
        error={props.addError}
        onDismiss={() => props.setAddError(null)}
      />
      <SearchCardSections {...props} />
      <SearchFooter />
    </div>
  );
}

export function OptionalSummary({
  result,
  summary,
  summaryBusy,
  summaryError,
  hits,
  summarize,
  setSelected,
  listRef,
}: Pick<
  SearchResultsProps,
  | "result"
  | "summary"
  | "summaryBusy"
  | "summaryError"
  | "hits"
  | "summarize"
  | "setSelected"
  | "listRef"
>) {
  if (!result.summaryAvailable) return null;
  const onCite = (number: number) => {
    const hit = hits[number - 1];
    if (hit === undefined) return;
    setSelected(number - 1);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${number - 1}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <SummaryCard
      summary={summary}
      busy={summaryBusy}
      error={summaryError}
      hits={hits}
      onRun={() => void summarize()}
      onCite={onCite}
    />
  );
}

export function AskSearch({
  onAsk,
  query,
}: {
  onAsk: (query: string) => void;
  query: string;
}) {
  return (
    <button className="bsearch-ask" type="button" onClick={() => onAsk(query)}>
      <SparklesIcon size={14} />
      <span>
        <b>Ask the assistant about this</b> — it can read these pages and work
        from them; the results are already cached, so its search is free.
      </span>
    </button>
  );
}

export function AddError({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss: () => void;
}) {
  if (error === null) return null;
  return (
    <div className="bsearch-error" role="alert">
      {error}
      <button className="browser-btn" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function SearchCardSections(props: SearchResultsProps) {
  return (
    <>
      <ConnectedSearchCard
        {...props}
        hit={props.hits[0]!}
        idx={0}
        tier="feature"
      />
      <SearchCardCollection
        {...props}
        className="bsearch-duo"
        hits={props.hits.slice(1, 3)}
        start={1}
        tier="duo"
      />
      <SearchCardCollection
        {...props}
        className="bsearch-rows"
        hits={props.hits.slice(3)}
        start={3}
        tier="row"
      />
    </>
  );
}

export function SearchCardCollection({
  className,
  hits,
  start,
  tier,
  ...props
}: SearchResultsProps & {
  className: string;
  hits: WebHit[];
  start: number;
  tier: "duo" | "row";
}) {
  if (hits.length === 0) return null;
  return (
    <div className={className}>
      {hits.map((hit, offset) => (
        <ConnectedSearchCard
          {...props}
          key={hit.url}
          hit={hit}
          idx={start + offset}
          tier={tier}
        />
      ))}
    </div>
  );
}

export function ConnectedSearchCard({
  hit,
  idx,
  tier,
  selected,
  previews,
  previewsPending,
  peeks,
  adds,
  maxScore,
  setSelected,
  onOpen,
  onOpenNewTab,
  peek,
  add,
}: Pick<
  SearchResultsProps,
  | "selected"
  | "previews"
  | "previewsPending"
  | "peeks"
  | "adds"
  | "maxScore"
  | "setSelected"
  | "onOpen"
  | "onOpenNewTab"
  | "peek"
  | "add"
> & {
  hit: WebHit;
  idx: number;
  tier: "feature" | "duo" | "row";
}) {
  return (
    <SearchCard
      hit={hit}
      idx={idx}
      tier={tier}
      selected={idx === selected}
      preview={previews[hit.url]}
      previewsPending={previewsPending}
      peek={peekValue(peeks, hit.url)}
      addState={adds[hit.url] ?? "idle"}
      relative={hit.score / maxScore}
      onSelect={() => setSelected(idx)}
      onOpen={() => onOpen(hit.url)}
      onOpenNewTab={() => onOpenNewTab(hit.url)}
      onPeek={() => void peek(hit)}
      onAdd={() => void add(hit)}
    />
  );
}

export function peekValue(
  peeks: Record<string, string | null>,
  url: string,
): string | null | undefined {
  return url in peeks ? peeks[url] : undefined;
}

export function SearchFooter() {
  return (
    <footer className="bsearch-foot">
      <span>
        Searched privately — no account, no profile, no click tracking.
      </span>
      <span>Engines: {ENGINE_SLOTS.join(" · ")}</span>
    </footer>
  );
}

/** What the page looks like while the engines are still answering.
 *
 * NOT a spinner on an empty screen: the query is echoed immediately and the
 * result tiers are drawn as skeletons, so the shape of the answer is on screen
 * before the answer is. The elapsed counter is there because a wait you can
 * see the length of reads as progress, and a wait you cannot reads as a hang
 * (owner report 2026-08-01: "it's stuck on Searching…"). */
