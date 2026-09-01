import type { Dispatch, RefObject, SetStateAction } from "react";
import type { BrowseClearScope, BrowserInfo, BrowserSearchResult, FileMeta } from "../apiTypes";
import { BrowserSearch, BrowserSearchSkeleton } from "./BrowserSearch";
import { BrowserReader } from "./BrowserReader";
import { clearWarning, FACETS, groupSessions, type JournalFacet } from "./browserJournal";
import { EPHEMERAL_VS_ROOM, NOT_ANONYMOUS, startScreenCopy } from "./browserPrivacy";
import { ignoreAttachedFile, ignoreSearchQuestion, journalTime } from "./browserRuntime";

export type BrowserSessions = ReturnType<typeof groupSessions>;
export type BrowserSession = BrowserSessions[number];

export type BrowserJournalProps = {
  clearScope: BrowseClearScope | null;
  confirmClear: boolean;
  earlier: number;
  facets: JournalFacet[];
  journalError: string | null;
  nothingToErase: boolean;
  open: boolean;
  sessions: BrowserSessions;
  showEarlier: boolean;
  onClear: () => void;
  onConfirmClear: () => void;
  onKeepClear: () => void;
  onLoadJournal: () => void;
  onSetFacets: Dispatch<SetStateAction<JournalFacet[]>>;
  onToggleEarlier: () => void;
};

export function BrowserJournal({
  clearScope,
  confirmClear,
  earlier,
  facets,
  journalError,
  nothingToErase,
  open,
  sessions,
  showEarlier,
  onClear,
  onConfirmClear,
  onKeepClear,
  onLoadJournal,
  onSetFacets,
  onToggleEarlier,
}: BrowserJournalProps) {
  if (!open) return null;
  return (
    <aside className="browser-journal" aria-label="Browser journal">
      <BrowserJournalHeader
        clearScope={clearScope}
        confirmClear={confirmClear}
        nothingToErase={nothingToErase}
        onClear={onClear}
        onConfirmClear={onConfirmClear}
        onKeepClear={onKeepClear}
      />
      <p className="browser-journal-note">
        {`${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`}
      </p>
      <BrowserJournalFacets facets={facets} onSetFacets={onSetFacets} />
      <BrowserJournalStatus error={journalError} onRetry={onLoadJournal} />
      <BrowserJournalSessions error={journalError} sessions={sessions} />
      <BrowserEarlierSessions
        earlier={earlier}
        showEarlier={showEarlier}
        onToggle={onToggleEarlier}
      />
    </aside>
  );
}

export type BrowserJournalHeaderProps = {
  clearScope: BrowseClearScope | null;
  confirmClear: boolean;
  nothingToErase: boolean;
  onClear: () => void;
  onConfirmClear: () => void;
  onKeepClear: () => void;
};

export function BrowserJournalHeader({
  clearScope,
  confirmClear,
  nothingToErase,
  onClear,
  onConfirmClear,
  onKeepClear,
}: BrowserJournalHeaderProps) {
  return (
    <header>
      <h2>What happened here</h2>
      {confirmClear ? (
        <span className="browser-journal-confirm">
          <span>{clearWarning(clearScope)}</span>
          <button className="browser-btn browser-btn-danger" onClick={onConfirmClear}>
            Erase
          </button>
          <button className="browser-btn" onClick={onKeepClear}>
            Keep
          </button>
        </span>
      ) : (
        <button
          className="browser-btn"
          disabled={nothingToErase}
          title={
            nothingToErase
              ? "Nothing recorded yet"
              : "Erase this record and the room's web cache — it cannot be brought back"
          }
          onClick={onClear}
        >
          Clear
        </button>
      )}
    </header>
  );
}

export function BrowserJournalFacets({
  facets,
  onSetFacets,
}: {
  facets: JournalFacet[];
  onSetFacets: Dispatch<SetStateAction<JournalFacet[]>>;
}) {
  return (
    <div
      className="browser-journal-facets"
      role="group"
      aria-label="Filter the record"
    >
      {FACETS.map((facet) => {
        const selected = facets.includes(facet.id);
        return (
          <button
            key={facet.id}
            className="browser-btn"
            type="button"
            aria-pressed={selected}
            onClick={() =>
              onSetFacets((previous) =>
                selected
                  ? previous.filter((value) => value !== facet.id)
                  : [...previous, facet.id],
              )
            }
          >
            {facet.label}
          </button>
        );
      })}
    </div>
  );
}

export function BrowserJournalStatus({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <p className="browser-banner error" role="alert">
      The record could not be read — {error}
      <button className="browser-btn" type="button" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

export function BrowserJournalSessions({
  error,
  sessions,
}: {
  error: string | null;
  sessions: BrowserSessions;
}) {
  if (sessions.length === 0) {
    return error ? null : <p className="browser-journal-empty">Nothing yet.</p>;
  }
  return <>{sessions.map((session, index) => <BrowserJournalSession key={session.id || `earlier-${index}`} session={session} />)}</>;
}

export function BrowserJournalSession({ session }: { session: BrowserSession }) {
  return (
    <section className="browser-journal-session">
      <h3>
        {session.current ? "This sitting" : "Earlier"}
        <span className="browser-journal-when" dir="ltr">
          {journalTime(session.from)}
        </span>
      </h3>
      <p className="browser-journal-summary">{session.summary}</p>
      {session.lines.length === 0 ? (
        <p className="browser-journal-empty">
          Nothing in this sitting matches those filters.
        </p>
      ) : (
        <BrowserJournalLines lines={session.lines} />
      )}
    </section>
  );
}

export function BrowserJournalLines({ lines }: { lines: BrowserSession["lines"] }) {
  return (
    <ol className="nb-connect browser-journal-list">
      {lines.map(({ row, runs }) => (
        <li key={row.id} data-kind={row.kind}>
          <span className="jk">{row.kind}</span>
          <span className="jd" dir="auto">
            {row.detail}
            {runs > 1 && <span className="jn"> ×{runs}</span>}
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
  );
}

export function BrowserEarlierSessions({
  earlier,
  showEarlier,
  onToggle,
}: {
  earlier: number;
  showEarlier: boolean;
  onToggle: () => void;
}) {
  if (earlier === 0) return null;
  const label = showEarlier
    ? "Hide earlier sittings"
    : `Show ${earlier} earlier sitting${earlier === 1 ? "" : "s"}`;
  return (
    <button
      className="browser-btn browser-journal-more"
      type="button"
      aria-expanded={showEarlier}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

export function BrowserSearchSurface({
  search,
  searchOpen,
  searching,
  pending,
  onAdded,
  onAsk,
  onOpen,
  onOpenNewTab,
}: {
  search: BrowserSearchResult | null;
  searchOpen: boolean;
  searching: boolean;
  pending: string;
  onAdded: (file: FileMeta) => void;
  onAsk: (query: string) => void;
  onOpen: (url: string) => void;
  onOpenNewTab: (url: string) => void;
}) {
  if (searching) return <BrowserSearchSkeleton query={pending} />;
  if (!searchOpen || !search) return null;
  return (
    <BrowserSearch
      result={search}
      onOpen={onOpen}
      onOpenNewTab={onOpenNewTab}
      onAsk={onAsk}
      onAdded={onAdded}
    />
  );
}

export function BrowserStartScreen({
  blank,
  info,
  searchOpen,
  searching,
}: {
  blank: boolean;
  info: BrowserInfo;
  searchOpen: boolean;
  searching: boolean;
}) {
  if (searchOpen || searching || (info.open && !blank)) return null;
  return (
    <div className="browser-start">
      <div className="bstart-sheet">
        <h1 className="bstart-title">Private browser</h1>
        <p className="bstart-copy">{startScreenCopy(info.protection)}</p>
        <p className="bstart-copy">
          Search or type an address above, or ask the assistant to look something up — it can drive this browser for you, and everything it does is recorded in the Journal.
        </p>
      </div>
      <aside className="bstart-aside" aria-hidden="true">
        <span className="bstart-aside-note">start here</span>
        <span className="nb-arrow-curve nb-arrow-curve--ne bstart-aside-arrow" />
      </aside>
    </div>
  );
}

export function browserBodyClass(
  readerOpen: boolean,
  comparing: boolean,
  extracting: number,
): string {
  const reading = readerOpen ? " reading" : "";
  const split = readerOpen && (comparing || extracting > 0) ? " split" : "";
  return `browser-body${reading}${split}`;
}

export type BrowserBodyProps = {
  blank: boolean;
  borrowStage: (on: boolean) => void;
  comparing: boolean;
  confirmClear: boolean;
  clearScope: BrowseClearScope | null;
  earlier: number;
  extracting: number;
  facets: JournalFacet[];
  info: BrowserInfo;
  journalError: string | null;
  journalOpen: boolean;
  nothingToErase: boolean;
  onAttach?: (file: FileMeta) => void;
  onAsk?: (query: string) => void;
  pending: string;
  readerOpen: boolean;
  search: BrowserSearchResult | null;
  searchOpen: boolean;
  searching: boolean;
  sessions: BrowserSessions;
  showEarlier: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  onClear: () => void;
  onConfirmClear: () => void;
  onKeepClear: () => void;
  onLoadJournal: () => void;
  onNavigate: (url: string) => void;
  onOpenNewTab: (url: string) => void;
  onSetComparing: Dispatch<SetStateAction<boolean>>;
  onSetFacets: Dispatch<SetStateAction<JournalFacet[]>>;
  onToggleEarlier: () => void;
  onCloseReader: () => void;
};

export function BrowserBody({
  blank,
  borrowStage,
  comparing,
  confirmClear,
  clearScope,
  earlier,
  extracting,
  facets,
  info,
  journalError,
  journalOpen,
  nothingToErase,
  onAttach,
  onAsk,
  pending,
  readerOpen,
  search,
  searchOpen,
  searching,
  sessions,
  showEarlier,
  stageRef,
  onClear,
  onConfirmClear,
  onKeepClear,
  onLoadJournal,
  onNavigate,
  onOpenNewTab,
  onSetComparing,
  onSetFacets,
  onToggleEarlier,
  onCloseReader,
}: BrowserBodyProps) {
  return (
    <div className={browserBodyClass(readerOpen, comparing, extracting)}>
      <div className="browser-stage" ref={stageRef} aria-hidden />
      <BrowserSearchSurface
        pending={pending}
        search={search}
        searchOpen={searchOpen}
        searching={searching}
        onAdded={onAttach ?? ignoreAttachedFile}
        onAsk={onAsk ?? ignoreSearchQuestion}
        onOpen={onNavigate}
        onOpenNewTab={onOpenNewTab}
      />
      <BrowserStartScreen
        blank={blank}
        info={info}
        searchOpen={searchOpen}
        searching={searching}
      />
      <BrowserJournal
        clearScope={clearScope}
        confirmClear={confirmClear}
        earlier={earlier}
        facets={facets}
        journalError={journalError}
        nothingToErase={nothingToErase}
        open={journalOpen}
        sessions={sessions}
        showEarlier={showEarlier}
        onClear={onClear}
        onConfirmClear={onConfirmClear}
        onKeepClear={onKeepClear}
        onLoadJournal={onLoadJournal}
        onSetFacets={onSetFacets}
        onToggleEarlier={onToggleEarlier}
      />
      <BrowserReaderSurface
        comparing={comparing}
        info={info}
        open={readerOpen}
        onClose={onCloseReader}
        onCompare={onSetComparing}
        onExtracting={borrowStage}
        onNavigate={onNavigate}
      />
    </div>
  );
}

export function BrowserReaderSurface({
  comparing,
  info,
  open,
  onClose,
  onCompare,
  onExtracting,
  onNavigate,
}: {
  comparing: boolean;
  info: BrowserInfo;
  open: boolean;
  onClose: () => void;
  onCompare: Dispatch<SetStateAction<boolean>>;
  onExtracting: (on: boolean) => void;
  onNavigate: (url: string) => void;
}) {
  if (!open) return null;
  return (
    <BrowserReader
      info={info}
      comparing={comparing}
      onCompare={onCompare}
      onExtracting={onExtracting}
      onNavigate={onNavigate}
      onClose={onClose}
    />
  );
}
