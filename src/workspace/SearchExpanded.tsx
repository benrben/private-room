import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileKindLabel, formatSize } from "../api";
import type { FileMeta, SearchResults } from "../api";
import { ChatBubbleIcon, CloseIcon, FileTypeIcon, MemoryIcon } from "../icons";
import { fileLabel, formatWhen } from "./composer";
import type { FlatResult } from "./types";

/** The ⌘K launcher's EXPANDED results: everything the room's own "Find" area
 * used to be, lifted into the launcher rather than kept as a second surface.
 *
 * The app used to explain three search surfaces to the user in a paragraph on
 * the Find page: ⌘K, Find itself, and the Library's filter box. Find is gone
 * — this file is what survived the merge. It is deliberately still built as a
 * set of small, decoupled pieces (filters, rows, the idle recall panel)
 * rather than one page component, because its host is now a popover that also
 * has to show a Commands list neither of the two prior surfaces had: the
 * ⌘K launcher owns the keyboard selection (arrow keys move an index across
 * files/messages/memories AND commands together), and these pieces only
 * render what that index tells them to.
 *
 * What did NOT come along: the page's own debounced search request and its
 * own DOM-focus row-to-row arrow-key navigation. Both would have raced or
 * fought the launcher's existing ones — Overlays.tsx already runs one
 * `search_all` per query (effects.ts) and already moves a selection index
 * with the arrow keys across a flat list that also has to include commands.
 * So filtering here is a PURE function over that one result set, not a
 * second fetch, and the flattened, FILTERED list this file computes is the
 * same list the launcher's index walks — see `applyFindFilters` /
 * `flattenShown` and their call sites in Overlays.tsx. */

/* ==========================================================================
   Filters
   Every filter below narrows results the launcher ALREADY has. None of them
   is a second search: `search_all` is the one index this file reads, so a
   filtered view can never disagree with the plain one about what is in the
   room.
   ========================================================================== */

/** Which of the three things a room-wide search looks at. */
export type SourceKey = "files" | "messages" | "memories";
/** How recently a file was added. */
type WhenKey = "any" | "today" | "week" | "month" | "year";
/** WHERE the words were found. This is a real distinction in the backend and
 * not a guess: `search_all` returns a snippet for a content (FTS) hit and an
 * empty snippet for a file whose NAME matched, precisely so the two can be
 * told apart downstream. */
type MatchKey = "any" | "text" | "name";
/** Order of the file group. Only files carry a date, a size and a name, so
 * this control says "Sort files" on screen rather than implying it reorders
 * conversations and memories too. */
type SortKey = "best" | "newest" | "oldest" | "name";

export interface FindFilters {
  sources: SourceKey[];
  /** `fileKindLabel` words ("PDF", "note", "recording"). Empty = every type. */
  kinds: string[];
  when: WhenKey;
  match: MatchKey;
  sort: SortKey;
}

export const ALL_SOURCES: SourceKey[] = ["files", "messages", "memories"];

export const DEFAULT_FILTERS: FindFilters = {
  sources: ALL_SOURCES,
  kinds: [],
  when: "any",
  match: "any",
  sort: "best",
};

const SOURCE_LABELS: Record<SourceKey, string> = {
  files: "Files",
  messages: "Conversations",
  memories: "Memories",
};

const WHEN_LABELS: Record<WhenKey, string> = {
  any: "Any time",
  today: "Today",
  week: "Past 7 days",
  month: "Past 30 days",
  year: "Past year",
};

const MATCH_LABELS: Record<MatchKey, string> = {
  any: "Anywhere",
  text: "In the text",
  name: "In the file name",
};

const SORT_LABELS: Record<SortKey, string> = {
  best: "Best match",
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name (A–Z)",
};

/* ==========================================================================
   Saved and recent searches
   ========================================================================== */

/** Where the launcher's own two lists live.
 *
 * They are facts about THIS ROOM — "what have I looked for in here" — so they
 * go in the room's own encrypted settings table rather than in localStorage.
 * A device-wide key would carry one room's queries into another room's
 * launcher, which in a product whose whole promise is that a room is sealed
 * would be a leak.
 *
 * Both values are a JSON array. A malformed one is DROPPED rather than
 * repaired: a half-parsed list of past searches is worth nothing, and silently
 * showing someone a query they never ran is worse than showing them none.
 *
 * Keys are unchanged from the retired Find page on purpose: a room's history
 * of past searches is real data, and renaming the setting would have silently
 * emptied it for every room that already had some. */
const RECENT_KEY = "find_recent_searches";
const SAVED_KEY = "find_saved_searches";
const RECENT_MAX = 8;
const SAVED_MAX = 12;

/** A search worth keeping: the words AND the way they were narrowed, because
 * "invoices, PDFs only, this year" is the thing being saved — not "invoices". */
export interface SavedSearch {
  q: string;
  filters: FindFilters;
}

function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Reads back a stored filter set, keeping only values this build still
 * understands. A room written by a newer build must degrade to a search that
 * runs, never to a filter the launcher cannot render. */
function parseFilters(v: unknown): FindFilters {
  const o = (v ?? {}) as Partial<Record<keyof FindFilters, unknown>>;
  const sources = Array.isArray(o.sources)
    ? (o.sources.filter((s): s is SourceKey =>
        (ALL_SOURCES as string[]).includes(s as string),
      ) as SourceKey[])
    : DEFAULT_FILTERS.sources;
  return {
    // An empty source list would be a saved search that can never match
    // anything, so it falls back to "look everywhere".
    sources: sources.length > 0 ? sources : DEFAULT_FILTERS.sources,
    kinds: Array.isArray(o.kinds) ? o.kinds.filter((k): k is string => typeof k === "string") : [],
    when: typeof o.when === "string" && o.when in WHEN_LABELS ? (o.when as WhenKey) : "any",
    match: typeof o.match === "string" && o.match in MATCH_LABELS ? (o.match as MatchKey) : "any",
    sort: typeof o.sort === "string" && o.sort in SORT_LABELS ? (o.sort as SortKey) : "best",
  };
}

function parseSaved(raw: string | null): SavedSearch[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is { q: unknown; filters?: unknown } => typeof x === "object" && x !== null)
      .filter((x) => typeof x.q === "string" && (x.q as string).trim().length > 0)
      .map((x) => ({ q: (x.q as string).trim(), filters: parseFilters(x.filters) }))
      .slice(0, SAVED_MAX);
  } catch {
    return [];
  }
}

/** Loads, persists and mutates the room's recent/saved search lists.
 *
 * Ported from the retired Find page's own state almost unchanged — only the
 * host moved. `noteSearch` is meant to be called once per COMPLETED search
 * (a result set that actually landed), not once per keystroke: recording
 * every keystroke would fill the list with the prefixes of the word being
 * typed ("i", "in", "inv", "invo"). */
export function useRecentAndSaved() {
  const [recent, setRecent] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  /** False until the room's stored lists have actually been read. Every write
   * is gated on it, so a save that lands before the load can never overwrite
   * the room's real lists with this hook's empty starting state. */
  const loadedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSetting(RECENT_KEY), api.getSetting(SAVED_KEY)])
      .then(([r, s]) => {
        if (!alive) return;
        setRecent(parseRecent(r));
        setSaved(parseSaved(s));
        loadedRef.current = true;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    void api.setSetting(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
  }, [recent]);

  useEffect(() => {
    if (!loadedRef.current) return;
    void api.setSetting(SAVED_KEY, JSON.stringify(saved)).catch(() => {});
  }, [saved]);

  const noteSearch = useCallback((trimmed: string) => {
    if (!trimmed) return;
    setRecent((prev) => {
      if (prev[0] === trimmed) return prev;
      // Any stored entry that the new query STARTS WITH is dropped, so a
      // word typed a letter at a time collapses into the one query that was
      // actually meant.
      const lower = trimmed.toLowerCase();
      const kept = prev.filter((x) => !lower.startsWith(x.toLowerCase()));
      return [trimmed, ...kept].slice(0, RECENT_MAX);
    });
  }, []);

  const toggleSaved = useCallback((q: string, filters: FindFilters) => {
    if (!q) return;
    setSaved((prev) =>
      prev.some((s) => s.q === q)
        ? prev.filter((s) => s.q !== q)
        : [{ q, filters }, ...prev].slice(0, SAVED_MAX),
    );
  }, []);

  const removeSaved = useCallback((q: string) => {
    setSaved((prev) => prev.filter((s) => s.q !== q));
  }, []);

  const clearRecent = useCallback(() => setRecent([]), []);

  return { recent, saved, noteSearch, toggleSaved, removeSaved, clearRecent };
}

/* ==========================================================================
   Pure helpers
   ========================================================================== */

/** Splits `text` into runs, marking the ones that matched a search term, so a
 * hit can be highlighted WITHOUT ever going near innerHTML — the caller
 * renders each run as its own node and the room's own content can never
 * become markup.
 *
 * The scan is done on a lower-cased copy and the offsets are used against the
 * ORIGINAL, which is only sound while the two have the same length. A handful
 * of characters (Turkish dotted capital İ is the usual one) lower-case into
 * two code units and would shift every offset after them, so that case bails
 * out to "no highlighting" rather than marking the wrong letters. */
export function splitMatches(
  text: string,
  terms: string[],
): { text: string; hit: boolean }[] {
  if (!text || terms.length === 0) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  if (hay.length !== text.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let len = 0;
    for (const t of terms) {
      const p = hay.indexOf(t, i);
      if (p === -1) continue;
      // Earliest wins; on a tie the longer term wins, so searching "form" and
      // "formula" marks the whole word rather than four letters of it.
      if (at === -1 || p < at || (p === at && t.length > len)) {
        at = p;
        len = t.length;
      }
    }
    if (at === -1) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + len), hit: true });
    i = at + len;
  }
  return out;
}

/** The words to highlight. Single letters are dropped because marking every
 * "a" in a snippet is confetti, not information — unless the whole query IS a
 * single letter, in which case it is exactly what was asked for. */
export function highlightTerms(query: string): string[] {
  const all = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const long = all.filter((t) => t.length > 1);
  const use = long.length > 0 ? long : all;
  return Array.from(new Set(use)).slice(0, 8);
}

/** The oldest `createdAt` a file may have and still pass the date filter, in
 * epoch milliseconds. "Today" means since local midnight; the rest are rolling
 * windows, which is what a person means by "the past week". */
function whenCutoff(k: WhenKey): number | null {
  const DAY = 86400000;
  if (k === "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  if (k === "week") return Date.now() - 7 * DAY;
  if (k === "month") return Date.now() - 30 * DAY;
  if (k === "year") return Date.now() - 365 * DAY;
  return null;
}

/** A compact date for the margin of a row. The year is only written when it
 * is not this one — a notebook margin says "Mar 4", not "Mar 4, 2026". */
function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** The non-default parts of a filter set, as short words. Drives both the
 * "narrowed to" chips and the one-line summary under a saved search, so the
 * two can never describe the same filters differently. */
export function filterSummary(f: FindFilters): string[] {
  const out: string[] = [];
  if (f.sources.length !== ALL_SOURCES.length) {
    out.push(f.sources.map((s) => SOURCE_LABELS[s]).join(" + "));
  }
  if (f.kinds.length > 0) out.push(f.kinds.join(" + "));
  if (f.when !== "any") out.push(WHEN_LABELS[f.when]);
  if (f.match !== "any") out.push(MATCH_LABELS[f.match]);
  if (f.sort !== "best") out.push(SORT_LABELS[f.sort]);
  return out;
}

/** A FileMeta shape for a hit whose file is no longer in the room's list — it
 * was deleted, or trashed, between the search and this render. The NAME is
 * still known, and `fileKind` reads the extension, so the row still gets the
 * right glyph instead of falling back to a generic one. Everything derived
 * from real metadata (size, date, type word) is suppressed at the call site. */
function placeholderMeta(id: string, name: string): FileMeta {
  return {
    id,
    name,
    mimeType: "",
    sizeBytes: 0,
    source: "",
    hasText: false,
    createdAt: "",
    folderId: null,
    partiallyIndexed: false,
  };
}

/** The three result groups after every filter has been applied. Shape-wise
 * identical to `SearchResults`, but it is never confused for the raw,
 * unfiltered set: nothing here rejects a hit `search_all` didn't return, it
 * only ever removes hits the reader asked to stop seeing. */
export interface ShownResults {
  files: SearchResults["files"];
  messages: SearchResults["messages"];
  memories: SearchResults["memories"];
}

const EMPTY_SHOWN: ShownResults = { files: [], messages: [], memories: [] };

/** Narrows one room-wide result set down to what the current filters allow.
 * Pure and side-effect free on purpose: the launcher's keyboard selection and
 * this file's own rendering both have to agree on exactly which rows are
 * showing, so both read this same function rather than two copies of the
 * same narrowing logic drifting apart. */
export function applyFindFilters(
  results: SearchResults | null,
  filters: FindFilters,
  fileById: Map<string, FileMeta>,
): ShownResults {
  if (!results) return EMPTY_SHOWN;
  const cutoff = whenCutoff(filters.when);
  const kindSet = new Set(filters.kinds);
  const wantKind = kindSet.size > 0;

  let fileHits = filters.sources.includes("files") ? results.files : [];
  if (filters.match === "name") fileHits = fileHits.filter((h) => h.snippet === "");
  if (filters.match === "text") fileHits = fileHits.filter((h) => h.snippet !== "");
  if (wantKind || cutoff !== null) {
    fileHits = fileHits.filter((h) => {
      const meta = fileById.get(h.id);
      // A hit whose file has left the room cannot answer a question about
      // its type or its date, so a filter that asks one excludes it.
      if (!meta) return false;
      if (wantKind && !kindSet.has(fileKindLabel(meta))) return false;
      if (cutoff !== null) {
        const at = Date.parse(meta.createdAt);
        if (Number.isNaN(at) || at < cutoff) return false;
      }
      return true;
    });
  }
  if (filters.sort !== "best") {
    const key = (id: string) => fileById.get(id);
    const byName = (a: string, b: string) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    fileHits = [...fileHits].sort((a, b) => {
      const ma = key(a.id);
      const mb = key(b.id);
      // A hit with no metadata has nothing to sort ON; it sinks rather than
      // landing in an arbitrary place and looking like a ranking.
      if (!ma || !mb) return (ma ? 0 : 1) - (mb ? 0 : 1);
      if (filters.sort === "name") return byName(ma.name, mb.name);
      const cmp = ma.createdAt.localeCompare(mb.createdAt);
      return filters.sort === "newest" ? -cmp || byName(ma.name, mb.name) : cmp || byName(ma.name, mb.name);
    });
  }

  // A message and a memory are text and nothing else: they have no name to
  // match in, so "In the file name" excludes them by definition rather than
  // by accident.
  const textOnly = filters.match !== "name";
  return {
    files: fileHits,
    messages: filters.sources.includes("messages") && textOnly ? results.messages : [],
    memories: filters.sources.includes("memories") && textOnly ? results.memories : [],
  };
}

/** Every file type present in this search's file hits, in the room's own
 * order. Read from the RAW results rather than the filtered ones, so the Type
 * chips never disappear just because the Type filter itself narrowed the file
 * group down to one kind. */
export function kindsPresentOf(
  results: SearchResults | null,
  fileById: Map<string, FileMeta>,
): string[] {
  const out: string[] = [];
  for (const h of results?.files ?? []) {
    const meta = fileById.get(h.id);
    if (!meta) continue;
    const k = fileKindLabel(meta);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Flattens the three filtered groups into the launcher's one arrow-key
 * navigable list, files first, then messages, then memories — the same order
 * the groups render in, so index N in this array is always row N on screen. */
export function flattenShown(shown: ShownResults): FlatResult[] {
  const flat: FlatResult[] = [];
  shown.files.forEach((f) => flat.push({ kind: "file", id: f.id, name: f.name, snippet: f.snippet }));
  shown.messages.forEach((m) =>
    flat.push({ kind: "message", chatId: m.chatId, messageId: m.messageId, snippet: m.snippet }),
  );
  shown.memories.forEach((m) => flat.push({ kind: "memory", id: m.id, snippet: m.snippet }));
  return flat;
}

/* ==========================================================================
   Rendering
   ========================================================================== */

/** Renders `text` with the searched words marked, one node per run.
 *
 * `<mark>` is the element the browser and the screen reader already understand
 * for "this is why you are looking at this"; find.css's `.nb-mark` clears the
 * UA's own yellow and paints the highlighter over it. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const parts = splitMatches(text, terms);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="nb-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
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
}: {
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
}) {
  const patch = (p: Partial<FindFilters>) => onChange({ ...filters, ...p });
  const toggleSource = (s: SourceKey) => {
    const on = filters.sources.includes(s);
    const next = on ? filters.sources.filter((x) => x !== s) : [...filters.sources, s];
    // Turning the last one off would leave a search that cannot match
    // anything and no way back, so the last remaining source stays on.
    if (next.length === 0) return;
    onChange({ ...filters, sources: ALL_SOURCES.filter((x) => next.includes(x)) });
  };
  const toggleKind = (k: string) => {
    onChange({
      ...filters,
      kinds: filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k],
    });
  };
  const active = filterSummary(filters);
  return (
    <div className="find-filters">
      <div className="find-filter-group" role="group" aria-label="Where to look">
        <span className="find-filter-label">Where</span>
        <div className="find-chips">
          {ALL_SOURCES.map((s) => {
            const on = filters.sources.includes(s);
            const n =
              s === "files"
                ? (results?.files.length ?? 0)
                : s === "messages"
                  ? (results?.messages.length ?? 0)
                  : (results?.memories.length ?? 0);
            return (
              <button
                key={s}
                type="button"
                className={`nb-chip nb-chip-btn find-chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                title={on ? `Leave ${SOURCE_LABELS[s]} out` : `Include ${SOURCE_LABELS[s]}`}
                onClick={() => toggleSource(s)}
              >
                {on && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
                <span>{SOURCE_LABELS[s]}</span>
                <span className="find-chip-n">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {filters.sources.includes("files") && kindsPresent.length > 1 && (
        <div className="find-filter-group" role="group" aria-label="File type">
          <span className="find-filter-label">Type</span>
          <div className="find-chips">
            <button
              type="button"
              className={`nb-chip nb-chip-btn find-chip${filters.kinds.length === 0 ? " is-on" : ""}`}
              aria-pressed={filters.kinds.length === 0}
              title="Every kind of file"
              onClick={() => patch({ kinds: [] })}
            >
              {filters.kinds.length === 0 && (
                <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />
              )}
              <span>All</span>
            </button>
            {kindsPresent.map((k) => {
              const on = filters.kinds.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`nb-chip nb-chip-btn find-chip${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => toggleKind(k)}
                >
                  {on && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
                  <span>{k}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="find-filter-selects">
        <label className="find-filter-select">
          <span className="find-filter-label">Added</span>
          <select
            value={filters.when}
            title="Narrow by when a file was added to this room"
            onChange={(e) => patch({ when: e.target.value as WhenKey })}
          >
            {(Object.keys(WHEN_LABELS) as WhenKey[]).map((k) => (
              <option key={k} value={k}>
                {WHEN_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="find-filter-select">
          <span className="find-filter-label">Match</span>
          <select
            value={filters.match}
            title="Where the words were found"
            onChange={(e) => patch({ match: e.target.value as MatchKey })}
          >
            {(Object.keys(MATCH_LABELS) as MatchKey[]).map((k) => (
              <option key={k} value={k}>
                {MATCH_LABELS[k]}
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
              onChange={(e) => patch({ sort: e.target.value as SortKey })}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {active.length > 0 && (
          <button type="button" className="nb-btn nb-btn-quiet find-clear" onClick={() => onChange(DEFAULT_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>

      {filters.when !== "any" && messagesOrMemoriesShown && (
        <p className="find-caveat">
          Dates come from when a file was added. Conversations and memories are
          not dated in this room's index, so they are listed whatever this is
          set to.
        </p>
      )}
    </div>
  );
}

/** The Files / Conversations / Memories groups, in the launcher's row style —
 * icon, highlighted title or snippet, a meta line, the date pencilled in the
 * margin. `selectedIndex` is the launcher's own arrow-key position; a row
 * knows it is "sel" the same way the launcher's Commands rows do. */
export function SearchResultRows({
  shown,
  files,
  fileById,
  terms,
  selectedIndex,
  registerRowRef,
  onSelectIndex,
  onOpenResult,
  onOpenFile,
}: {
  shown: ShownResults;
  /** Every file in the room, for `fileLabel`'s duplicate-name disambiguation —
   * the same list the retired Find page read it from. */
  files: FileMeta[];
  fileById: Map<string, FileMeta>;
  terms: string[];
  selectedIndex: number;
  registerRowRef: (idx: number) => (el: HTMLButtonElement | null) => void;
  onSelectIndex: (idx: number) => void;
  onOpenResult: (hit: FlatResult) => void;
  onOpenFile: (id: string) => void;
}) {
  const msgOffset = shown.files.length;
  const memOffset = shown.files.length + shown.messages.length;
  return (
    <div className="find-groups">
      {shown.files.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-blue">Files</span>
            <span className="find-group-n">{shown.files.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.files.map((h, i) => {
              const meta = fileById.get(h.id);
              const shape = meta ?? placeholderMeta(h.id, h.name);
              const nameOnly = h.snippet === "";
              const note = meta
                ? nameOnly
                  ? "the name matched, not the text"
                  : meta.partiallyIndexed
                    ? "only the first part of this file is indexed"
                    : meta.source === "generated"
                      ? "written by the AI in this room"
                      : ""
                : "no longer in this room";
              return (
                <button
                  key={h.id}
                  ref={registerRowRef(i)}
                  type="button"
                  className={`find-row${selectedIndex === i ? " is-sel" : ""}`}
                  title={meta ? `Open ${h.name}` : h.name}
                  onMouseEnter={() => onSelectIndex(i)}
                  onClick={() =>
                    // A name-only hit has no passage to scroll to, so it opens
                    // the file plainly rather than sending the viewer hunting
                    // for words the document does not contain.
                    nameOnly
                      ? onOpenFile(h.id)
                      : onOpenResult({ kind: "file", id: h.id, name: h.name, snippet: h.snippet })
                  }
                >
                  <span className="find-row-ico" aria-hidden>
                    <FileTypeIcon file={shape} size={17} />
                  </span>
                  <span className="find-row-main">
                    <span className="find-row-title" dir="auto">
                      <Highlight text={fileLabel(h.name, files)} terms={terms} />
                    </span>
                    {!nameOnly && (
                      <span className="find-row-snippet" dir="auto">
                        <Highlight text={h.snippet} terms={terms} />
                      </span>
                    )}
                    <span className="find-row-meta">
                      {meta ? (
                        <>
                          <span className="find-row-kind">{fileKindLabel(meta)}</span>
                          <span className="find-row-dot" aria-hidden>
                            ·
                          </span>
                          <span>{formatSize(meta.sizeBytes)}</span>
                        </>
                      ) : (
                        <span className="find-row-kind">file</span>
                      )}
                      {note !== "" && <span className="find-row-note">{note}</span>}
                    </span>
                  </span>
                  {meta && (
                    <span className="find-row-date" title={formatWhen(meta.createdAt)}>
                      {shortWhen(meta.createdAt)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {shown.messages.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-green">Conversations</span>
            <span className="find-group-n">{shown.messages.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.messages.map((m, i) => {
              const idx = msgOffset + i;
              return (
                <button
                  key={m.messageId}
                  ref={registerRowRef(idx)}
                  type="button"
                  className={`find-row${selectedIndex === idx ? " is-sel" : ""}`}
                  title="Show this message in the conversation"
                  onMouseEnter={() => onSelectIndex(idx)}
                  onClick={() =>
                    onOpenResult({ kind: "message", chatId: m.chatId, messageId: m.messageId, snippet: m.snippet })
                  }
                >
                  <span className="find-row-ico" aria-hidden>
                    <ChatBubbleIcon size={17} />
                  </span>
                  <span className="find-row-main">
                    <span className="find-row-snippet find-row-lead" dir="auto">
                      <Highlight text={m.snippet} terms={terms} />
                    </span>
                    <span className="find-row-meta">
                      <span className="find-row-kind">message</span>
                      <span className="find-row-note">opens in the transcript</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {shown.memories.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-pink">Memories</span>
            <span className="find-group-n">{shown.memories.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.memories.map((m, i) => {
              const idx = memOffset + i;
              return (
                <button
                  key={m.id}
                  ref={registerRowRef(idx)}
                  type="button"
                  className={`find-row${selectedIndex === idx ? " is-sel" : ""}`}
                  title="Show this in Memory"
                  onMouseEnter={() => onSelectIndex(idx)}
                  onClick={() => onOpenResult({ kind: "memory", id: m.id, snippet: m.snippet })}
                >
                  <span className="find-row-ico" aria-hidden>
                    <MemoryIcon size={17} />
                  </span>
                  <span className="find-row-main">
                    <span className="find-row-snippet find-row-lead" dir="auto">
                      <Highlight text={m.snippet} terms={terms} />
                    </span>
                    <span className="find-row-meta">
                      <span className="find-row-kind">memory</span>
                      <span className="find-row-note">the AI may use this when relevant</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** "Save this search" / "Ask the room instead" — the two things worth doing
 * with a query besides opening a hit. Shown once a query has actually run. */
export function SearchQueryActions({
  query,
  isSaved,
  onToggleSaved,
  onAsk,
}: {
  query: string;
  isSaved: boolean;
  onToggleSaved: () => void;
  onAsk: (q: string) => void;
}) {
  return (
    <div className="find-query-actions">
      <button
        type="button"
        className={`nb-chip nb-chip-btn find-chip${isSaved ? " is-on" : ""}`}
        aria-pressed={isSaved}
        title={isSaved ? "Stop keeping this search" : "Keep this search — words and filters — in this room"}
        onClick={onToggleSaved}
      >
        {isSaved && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
        <span>{isSaved ? "Saved" : "Save this search"}</span>
      </button>
      <button
        type="button"
        className="nb-btn find-ask"
        title="Hand these words to the room's AI instead of listing hits"
        onClick={() => onAsk(query)}
      >
        Ask the room instead
      </button>
    </div>
  );
}

/** Idle recall — shown while the query field is empty, above the Commands
 * list. Recent searches are automatic; saved ones are a deliberate keep. */
export function SearchIdlePanel({
  recent,
  saved,
  onRunRecent,
  onRunSaved,
  onRemoveSaved,
  onClearRecent,
}: {
  recent: string[];
  saved: SavedSearch[];
  onRunRecent: (q: string) => void;
  onRunSaved: (s: SavedSearch) => void;
  onRemoveSaved: (q: string) => void;
  onClearRecent: () => void;
}) {
  if (recent.length === 0 && saved.length === 0) return null;
  return (
    <div className="find-idle">
      {saved.length > 0 && (
        <section>
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-yellow">Saved searches</span>
            <span className="find-group-n">{saved.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {saved.map((s) => {
              const summary = filterSummary(s.filters);
              return (
                <div key={s.q} className="find-saved-row">
                  <button
                    type="button"
                    className="find-row find-saved-run"
                    title={`Search this room for “${s.q}” again`}
                    onClick={() => onRunSaved(s)}
                  >
                    <span className="find-row-ico" aria-hidden>
                      <span className="nb-bookmark" />
                    </span>
                    <span className="find-row-main">
                      <span className="find-row-title" dir="auto">
                        {s.q}
                      </span>
                      <span className="find-row-meta">
                        {summary.length > 0 ? (
                          summary.map((w) => (
                            <span key={w} className="find-row-kind">
                              {w}
                            </span>
                          ))
                        ) : (
                          <span className="find-row-kind">the whole room</span>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="find-saved-del"
                    title={`Stop keeping “${s.q}”`}
                    aria-label={`Stop keeping the saved search “${s.q}”`}
                    onClick={() => onRemoveSaved(s.q)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-yellow">Recent</span>
            <span className="find-group-n">{recent.length}</span>
          </h2>
          <div className="find-chips find-recent">
            {recent.map((r) => (
              <button
                key={r}
                type="button"
                className="nb-chip nb-chip-btn find-chip"
                title={`Search for “${r}” again`}
                onClick={() => onRunRecent(r)}
              >
                <span dir="auto">{r}</span>
              </button>
            ))}
            <button type="button" className="nb-btn nb-btn-quiet find-clear" onClick={onClearRecent}>
              Clear recent
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
