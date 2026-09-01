import type { SearchResults } from "../api";
import { ALL_SOURCES, DEFAULT_FILTERS, MATCH_LABELS, SORT_LABELS, SOURCE_LABELS, WHEN_LABELS, filterSummary, type FindFilters, type MatchKey, type SortKey, type SourceKey, type WhenKey } from "./SearchExpanded";

interface SearchFiltersBarProps {
  filters: FindFilters;
  onChange: (next: FindFilters) => void;
  results: SearchResults | null;
  kindsPresent: string[];
  /** Whether any message or memory row is currently showing. The "Added"
   * filter reads a file's `createdAt` and nothing else has one — this gates a
   * caveat explaining that messages/memories are listed regardless of it,
   * rather than letting a reader assume the date filter silently excludes
   * them the way the Type filter would. */
  messagesOrMemoriesShown: boolean;
  /** Whether there is a file row to order. Only files carry a date, a size
   * and a name to sort BY — Sort would otherwise offer a control that visibly
   * does nothing. */
  showSort: boolean;
}

type FilterPatch = (patch: Partial<FindFilters>) => void;

function sourceCount(results: SearchResults | null, source: SourceKey): number {
  if (source === "files") return results?.files.length ?? 0;
  if (source === "messages") return results?.messages.length ?? 0;
  return results?.memories.length ?? 0;
}

function SourceFilterChip({
  source,
  filters,
  results,
  onToggle,
}: Pick<SearchFiltersBarProps, "filters" | "results"> & { source: SourceKey; onToggle: (source: SourceKey) => void }) {
  const on = filters.sources.includes(source);
  return (
    <button
      type="button"
      className={`nb-chip nb-chip-btn find-chip${on ? " is-on" : ""}`}
      aria-pressed={on}
      title={on ? `Leave ${SOURCE_LABELS[source]} out` : `Include ${SOURCE_LABELS[source]}`}
      onClick={() => onToggle(source)}
    >
      {on && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
      <span>{SOURCE_LABELS[source]}</span>
      <span className="find-chip-n">{sourceCount(results, source)}</span>
    </button>
  );
}

function SourceFilters({
  filters,
  results,
  onToggle,
}: Pick<SearchFiltersBarProps, "filters" | "results"> & { onToggle: (source: SourceKey) => void }) {
  return (
    <div className="find-filter-group" role="group" aria-label="Where to look">
      <span className="find-filter-label">Where</span>
      <div className="find-chips">
        {ALL_SOURCES.map((source) => (
          <SourceFilterChip key={source} source={source} filters={filters} results={results} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

function KindFilterChip({ kind, filters, onToggle }: { kind: string; filters: FindFilters; onToggle: (kind: string) => void }) {
  const on = filters.kinds.includes(kind);
  return (
    <button
      type="button"
      className={`nb-chip nb-chip-btn find-chip${on ? " is-on" : ""}`}
      aria-pressed={on}
      onClick={() => onToggle(kind)}
    >
      {on && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
      <span>{kind}</span>
    </button>
  );
}

function KindFilters({
  filters,
  kindsPresent,
  patch,
  onToggle,
}: Pick<SearchFiltersBarProps, "filters" | "kindsPresent"> & { patch: FilterPatch; onToggle: (kind: string) => void }) {
  if (!filters.sources.includes("files")) return null;
  if (kindsPresent.length <= 1) return null;
  const allKinds = filters.kinds.length === 0;
  return (
    <div className="find-filter-group" role="group" aria-label="File type">
      <span className="find-filter-label">Type</span>
      <div className="find-chips">
        <button
          type="button"
          className={`nb-chip nb-chip-btn find-chip${allKinds ? " is-on" : ""}`}
          aria-pressed={allKinds}
          title="Every kind of file"
          onClick={() => patch({ kinds: [] })}
        >
          {allKinds && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
          <span>All</span>
        </button>
        {kindsPresent.map((kind) => (
          <KindFilterChip key={kind} kind={kind} filters={filters} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

function FilterSelects({
  filters,
  active,
  patch,
  showSort,
  onClear,
}: Pick<SearchFiltersBarProps, "filters" | "showSort"> & { active: string[]; patch: FilterPatch; onClear: () => void }) {
  return (
    <div className="find-filter-selects">
      <label className="find-filter-select">
        <span className="find-filter-label">Added</span>
        <select
          value={filters.when}
          title="Narrow by when a file was added to this room"
          onChange={(event) => patch({ when: event.target.value as WhenKey })}
        >
          {(Object.keys(WHEN_LABELS) as WhenKey[]).map((key) => (
            <option key={key} value={key}>
              {WHEN_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <label className="find-filter-select">
        <span className="find-filter-label">Match</span>
        <select
          value={filters.match}
          title="Where the words were found"
          onChange={(event) => patch({ match: event.target.value as MatchKey })}
        >
          {(Object.keys(MATCH_LABELS) as MatchKey[]).map((key) => (
            <option key={key} value={key}>
              {MATCH_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      {showSort && (
        <label className="find-filter-select">
          <span className="find-filter-label">Sort files</span>
          <select
            value={filters.sort}
            title="Order the file results — conversations and memories keep the room's own ranking"
            onChange={(event) => patch({ sort: event.target.value as SortKey })}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      )}
      {active.length > 0 && (
        <button type="button" className="nb-btn nb-btn-quiet find-clear" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function SearchDateCaveat({ filters, messagesOrMemoriesShown }: Pick<SearchFiltersBarProps, "filters" | "messagesOrMemoriesShown">) {
  if (filters.when === "any") return null;
  if (!messagesOrMemoriesShown) return null;
  return (
    <p className="find-caveat">
      Dates come from when a file was added. Conversations and memories are
      not dated in this room's index, so they are listed whatever this is
      set to.
    </p>
  );
}

function toggledSource(filters: FindFilters, source: SourceKey): SourceKey[] | null {
  const next = filters.sources.includes(source)
    ? filters.sources.filter((candidate) => candidate !== source)
    : [...filters.sources, source];
  // Turning the last one off would leave a search that cannot match anything
  // and no way back, so the last remaining source stays on.
  return next.length === 0 ? null : ALL_SOURCES.filter((candidate) => next.includes(candidate));
}

function toggledKind(filters: FindFilters, kind: string): string[] {
  return filters.kinds.includes(kind)
    ? filters.kinds.filter((candidate) => candidate !== kind)
    : [...filters.kinds, kind];
}

/** The "Where / Type / Added / Match" strip, plus the sources' own counts and
 * a "Clear filters" escape. Shown only once there is a real query and a real
 * result set to narrow — see the call site in Overlays.tsx. */
export function SearchFiltersBar({
  filters,
  onChange,
  results,
  kindsPresent,
  messagesOrMemoriesShown,
  showSort,
}: SearchFiltersBarProps) {
  const patch: FilterPatch = (partial) => onChange({ ...filters, ...partial });
  const toggleSource = (source: SourceKey) => {
    const sources = toggledSource(filters, source);
    if (sources !== null) onChange({ ...filters, sources });
  };
  const toggleKind = (kind: string) => onChange({ ...filters, kinds: toggledKind(filters, kind) });
  return (
    <div className="find-filters">
      <SourceFilters filters={filters} results={results} onToggle={toggleSource} />
      <KindFilters filters={filters} kindsPresent={kindsPresent} patch={patch} onToggle={toggleKind} />
      <FilterSelects
        filters={filters}
        active={filterSummary(filters)}
        patch={patch}
        showSort={showSort}
        onClear={() => onChange(DEFAULT_FILTERS)}
      />
      <SearchDateCaveat filters={filters} messagesOrMemoriesShown={messagesOrMemoriesShown} />
    </div>
  );
}
