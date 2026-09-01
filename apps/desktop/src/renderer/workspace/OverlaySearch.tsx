import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LayoutApi } from "../shell/useLayout";
import type { WSActions } from "./actions";
import { buildPaletteActions } from "./Overlays";
import {
  applyFindFilters,
  DEFAULT_FILTERS,
  flattenShown,
  highlightTerms,
  kindsPresentOf,
  SearchFiltersBar,
  SearchIdlePanel,
  SearchQueryActions,
  SearchResultRows,
  useRecentAndSaved,
  type FindFilters,
} from "./SearchExpanded";
import type { WSState } from "./state";

export function useSearchFilters(s: WSState) {
  const [filters, setFilters] = useState<FindFilters>(DEFAULT_FILTERS);
  useEffect(() => {
    if (s.showSearch) setFilters(DEFAULT_FILTERS);
  }, [s.showSearch]);
  return { filters, setFilters };
}

export function useSearchHistory(
  trimmedQuery: string,
  searchResults: WSState["searchResults"],
) {
  const { recent, saved, noteSearch, toggleSaved, removeSaved, clearRecent } = useRecentAndSaved();
  useEffect(() => {
    if (trimmedQuery && searchResults) noteSearch(trimmedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResults]);
  return { recent, saved, toggleSaved, removeSaved, clearRecent };
}

export function matchingPaletteActions(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
  query: string,
  openSealedExport: () => void,
) {
  return buildPaletteActions(s, a, layout, openSealedExport).filter(
    (action) => !query || action.label.toLowerCase().includes(query) || action.hint.toLowerCase().includes(query),
  );
}

export function rawResultTotal(results: WSState["searchResults"]) {
  if (!results) return 0;
  return results.files.length + results.messages.length + results.memories.length;
}

export function isSearchExpanded(query: string, results: WSState["searchResults"], error: string) {
  return query !== "" && results != null && !error;
}

export function usePaletteSearch(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
  openSealedExport: () => void,
) {
  const { filters, setFilters } = useSearchFilters(s);
  const searchResults = s.searchResults;
  const trimmedQuery = s.searchQuery.trim();
  const fileById = useMemo(() => new Map(s.files.map((file) => [file.id, file])), [s.files]);
  const shown = useMemo(() => applyFindFilters(searchResults, filters, fileById), [searchResults, filters, fileById]);
  const kindsPresent = useMemo(() => kindsPresentOf(searchResults, fileById), [searchResults, fileById]);
  const terms = useMemo(() => highlightTerms(trimmedQuery), [trimmedQuery]);
  useEffect(() => {
    s.setSearchSel(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  const history = useSearchHistory(trimmedQuery, searchResults);
  const isSavedSearch = history.saved.some((saved) => saved.q === trimmedQuery);
  const query = trimmedQuery.toLowerCase();
  const actions = matchingPaletteActions(s, a, layout, query, openSealedExport);
  const totalRaw = rawResultTotal(searchResults);
  const totalShown = shown.files.length + shown.messages.length + shown.memories.length;
  return {
    actions,
    expanded: isSearchExpanded(trimmedQuery, searchResults, s.searchError),
    fileById,
    filters,
    history,
    isSavedSearch,
    kindsPresent,
    narrowedToZero: totalRaw > 0 && totalShown === 0,
    searchResults,
    shown,
    terms,
    totalItemsRaw: totalRaw + actions.length,
    totalRaw,
    totalShown,
    trimmedQuery,
    setFilters,
  };
}

export type PaletteSearch = ReturnType<typeof usePaletteSearch>;

export function runPaletteSelection(
  index: number,
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
  data: PaletteSearch,
) {
  const results = flattenShown(data.shown);
  if (index < results.length) {
    a.activateResult(results[index], layout);
    return;
  }
  const action = data.actions[index - results.length];
  if (action && !action.disabled) {
    s.setShowSearch(false);
    action.run();
  }
}

export function usePaletteKeyboard(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
  data: PaletteSearch,
) {
  const totalItems = flattenShown(data.shown).length + data.actions.length;
  return (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      s.setSearchSel((selected) => Math.min(selected + 1, Math.max(totalItems - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      s.setSearchSel((selected) => Math.max(selected - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runPaletteSelection(s.searchSel, s, a, layout, data);
    }
  };
}

export function useSearchRowRef(s: WSState) {
  return (index: number) => (element: HTMLButtonElement | null) => {
    if (index === s.searchSel) element?.scrollIntoView({ block: "nearest" });
  };
}

export function SearchError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="find-error nb-frame nb-sem-urgent nb-edge" role="alert">
      <strong className="find-error-head">This room could not be searched</strong>
      <span className="find-error-body">{error}</span>
    </div>
  );
}

export function SearchNothing({ query, results, total }: { query: string; results: WSState["searchResults"]; total: number }) {
  if (!query || !results || total !== 0) return null;
  return <div className="search-empty">Nothing matches “{query}” — not in files, chats, memories, or commands.</div>;
}

export function resultCountLabel(query: string, shown: number, total: number) {
  if (shown === 0) return `No results for “${query}”`;
  if (shown !== total) return `${shown} of ${total} results for “${query}”`;
  return `${shown} result${shown === 1 ? "" : "s"} for “${query}”`;
}

export function SearchResultCount({ query, shown, total }: { query: string; shown: number; total: number }) {
  return <p className="find-count" role="status">{resultCountLabel(query, shown, total)}</p>;
}

export function plural(count: number) {
  return count === 1 ? "" : "s";
}

export function memorySuffix(count: number) {
  return count === 1 ? "y" : "ies";
}

export function SearchBreakdown({ data }: { data: PaletteSearch }) {
  if (data.totalShown === 0) return null;
  return (
    <p className="find-breakdown">
      {data.shown.files.length} file{plural(data.shown.files.length)} · {data.shown.messages.length} message{plural(data.shown.messages.length)} · {data.shown.memories.length} memor{memorySuffix(data.shown.memories.length)}
    </p>
  );
}

export function SearchNarrowedEmpty({ data }: { data: PaletteSearch }) {
  if (!data.narrowedToZero) return null;
  const hidden = data.totalRaw === 1 ? " is" : "s are";
  return (
    <div className="find-empty">
      <p className="find-empty-line">Nothing matches “{data.trimmedQuery}” with these filters — {data.totalRaw} result{hidden} hidden by them.</p>
      <div className="find-empty-actions">
        <button type="button" className="nb-btn" onClick={() => data.setFilters(DEFAULT_FILTERS)}>Clear filters</button>
      </div>
    </div>
  );
}

export function SearchResultList({ data, s, a, layout, registerRowRef }: { data: PaletteSearch; s: WSState; a: WSActions; layout: LayoutApi | undefined; registerRowRef: (index: number) => (element: HTMLButtonElement | null) => void }) {
  if (data.narrowedToZero) return null;
  return (
    <SearchResultRows
      shown={data.shown}
      files={s.files}
      fileById={data.fileById}
      terms={data.terms}
      selectedIndex={s.searchSel}
      registerRowRef={registerRowRef}
      onSelectIndex={(index) => s.setSearchSel(index)}
      onOpenResult={(result) => a.activateResult(result, layout)}
      onOpenFile={(id) => void a.viewFile(id)}
    />
  );
}

export function ExpandedSearch({ data, s, a, layout, registerRowRef }: { data: PaletteSearch; s: WSState; a: WSActions; layout: LayoutApi | undefined; registerRowRef: (index: number) => (element: HTMLButtonElement | null) => void }) {
  if (!data.expanded || !data.searchResults) return null;
  return (
    <>
      <SearchQueryActions
        query={data.trimmedQuery}
        isSaved={data.isSavedSearch}
        onToggleSaved={() => data.history.toggleSaved(data.trimmedQuery, data.filters)}
        onAsk={(question) => {
          s.setShowSearch(false);
          s.setQuestion(question);
          a.focusComposer(layout);
        }}
      />
      <SearchFiltersBar
        filters={data.filters}
        onChange={data.setFilters}
        results={data.searchResults}
        kindsPresent={data.kindsPresent}
        messagesOrMemoriesShown={data.shown.messages.length > 0 || data.shown.memories.length > 0}
        showSort={data.shown.files.length > 0}
      />
      <SearchResultCount query={data.trimmedQuery} shown={data.totalShown} total={data.totalRaw} />
      <SearchBreakdown data={data} />
      <SearchNarrowedEmpty data={data} />
      <SearchResultList data={data} s={s} a={a} layout={layout} registerRowRef={registerRowRef} />
    </>
  );
}

export function SearchIdle({ data, s }: { data: PaletteSearch; s: WSState }) {
  if (data.trimmedQuery) return null;
  return (
    <SearchIdlePanel
      recent={data.history.recent}
      saved={data.history.saved}
      onRunRecent={(query) => s.setSearchQuery(query)}
      onRunSaved={(saved) => {
        data.setFilters(saved.filters);
        s.setSearchQuery(saved.q);
      }}
      onRemoveSaved={data.history.removeSaved}
      onClearRecent={data.history.clearRecent}
    />
  );
}

export function SearchCommands({ data, s, a, layout, registerRowRef }: { data: PaletteSearch; s: WSState; a: WSActions; layout: LayoutApi | undefined; registerRowRef: (index: number) => (element: HTMLButtonElement | null) => void }) {
  if (data.actions.length === 0) return null;
  const offset = flattenShown(data.shown).length;
  return (
    <div className="search-group">
      <div className="search-group-head">Commands <span className="search-count">{data.actions.length}</span></div>
      {data.actions.map((action, index) => {
        const selection = offset + index;
        return (
          <button
            key={action.id}
            ref={registerRowRef(selection)}
            className={`search-result action ${s.searchSel === selection ? "sel" : ""}`}
            disabled={action.disabled}
            onMouseEnter={() => s.setSearchSel(selection)}
            onClick={() => runPaletteSelection(selection, s, a, layout, data)}
          >
            <span className="search-result-title">{action.label}</span>
            <span className="search-result-snippet">{action.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchPanel({ data, s, a, layout, onKeyDown, registerRowRef }: { data: PaletteSearch; s: WSState; a: WSActions; layout: LayoutApi | undefined; onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void; registerRowRef: (index: number) => (element: HTMLButtonElement | null) => void }) {
  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    s.setSearchQuery(event.target.value);
    s.setSearchSel(0);
  };
  return (
    <div className={`search-panel${data.expanded ? " is-expanded" : ""}`}>
      <input className="search-input" autoFocus dir="auto" placeholder="Search this room, or run a command…" aria-label="Search this room or run a command" value={s.searchQuery} onChange={onChange} onKeyDown={onKeyDown} />
      <div className="search-results">
        <SearchError error={s.searchError} />
        <SearchNothing query={data.trimmedQuery} results={data.searchResults} total={data.totalItemsRaw} />
        <ExpandedSearch data={data} s={s} a={a} layout={layout} registerRowRef={registerRowRef} />
        <SearchIdle data={data} s={s} />
        <SearchCommands data={data} s={s} a={a} layout={layout} registerRowRef={registerRowRef} />
      </div>
      <div className="search-hint">↑↓ to move · Enter to run · Esc to close</div>
    </div>
  );
}

export function SearchOverlay({ s, a, layout, openSealedExport }: { s: WSState; a: WSActions; layout: LayoutApi | undefined; openSealedExport: () => void }) {
  const data = usePaletteSearch(s, a, layout, openSealedExport);
  const onKeyDown = usePaletteKeyboard(s, a, layout, data);
  const registerRowRef = useSearchRowRef(s);
  if (!s.showSearch) return null;
  return (
    <div className="search-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) s.setShowSearch(false); }}>
      <SearchPanel data={data} s={s} a={a} layout={layout} onKeyDown={onKeyDown} registerRowRef={registerRowRef} />
    </div>
  );
}
