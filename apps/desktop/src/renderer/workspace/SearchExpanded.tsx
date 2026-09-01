import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileKindLabel } from "../api";
import type { FileMeta, SearchResults } from "../api";
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
export type WhenKey = "any" | "today" | "week" | "month" | "year";
/** WHERE the words were found. This is a real distinction in the backend and
 * not a guess: `search_all` returns a snippet for a content (FTS) hit and an
 * empty snippet for a file whose NAME matched, precisely so the two can be
 * told apart downstream. */
export type MatchKey = "any" | "text" | "name";
/** Order of the file group. Only files carry a date, a size and a name, so
 * this control says "Sort files" on screen rather than implying it reorders
 * conversations and memories too. */
export type SortKey = "best" | "newest" | "oldest" | "name";

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

export const SOURCE_LABELS: Record<SourceKey, string> = {
  files: "Files",
  messages: "Conversations",
  memories: "Memories",
};

export const WHEN_LABELS: Record<WhenKey, string> = {
  any: "Any time",
  today: "Today",
  week: "Past 7 days",
  month: "Past 30 days",
  year: "Past year",
};

export const MATCH_LABELS: Record<MatchKey, string> = {
  any: "Anywhere",
  text: "In the text",
  name: "In the file name",
};

export const SORT_LABELS: Record<SortKey, string> = {
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
function savedSources(value: unknown): SourceKey[] {
  if (!Array.isArray(value)) return DEFAULT_FILTERS.sources;
  const sources = value.filter((source): source is SourceKey =>
    (ALL_SOURCES as string[]).includes(source as string),
  );
  return sources.length > 0 ? sources : DEFAULT_FILTERS.sources;
}

function savedKinds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((kind): kind is string => typeof kind === "string") : [];
}

function savedChoice<Key extends string>(value: unknown, choices: Record<Key, string>, fallback: Key): Key {
  return typeof value === "string" && value in choices ? (value as Key) : fallback;
}

function parseFilters(v: unknown): FindFilters {
  const o = (v ?? {}) as Partial<Record<keyof FindFilters, unknown>>;
  return {
    // An empty source list would be a saved search that can never match
    // anything, so it falls back to "look everywhere".
    sources: savedSources(o.sources),
    kinds: savedKinds(o.kinds),
    when: savedChoice(o.when, WHEN_LABELS, "any"),
    match: savedChoice(o.match, MATCH_LABELS, "any"),
    sort: savedChoice(o.sort, SORT_LABELS, "best"),
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
interface MatchLocation {
  at: number;
  length: number;
}

function isBetterMatch(current: MatchLocation | null, at: number, length: number): boolean {
  if (current === null) return true;
  if (at < current.at) return true;
  return at === current.at && length > current.length;
}

function nextMatch(hay: string, terms: string[], start: number): MatchLocation | null {
  let next: MatchLocation | null = null;
  for (const term of terms) {
    const at = hay.indexOf(term, start);
    if (at !== -1 && isBetterMatch(next, at, term.length)) next = { at, length: term.length };
  }
  return next;
}

function appendMatch(
  runs: { text: string; hit: boolean }[],
  text: string,
  start: number,
  match: MatchLocation,
): void {
  if (match.at > start) runs.push({ text: text.slice(start, match.at), hit: false });
  runs.push({ text: text.slice(match.at, match.at + match.length), hit: true });
}

export function splitMatches(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!text) return [{ text, hit: false }];
  if (terms.length === 0) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  if (hay.length !== text.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const match = nextMatch(hay, terms, i);
    if (match === null) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    appendMatch(out, text, i, match);
    i = match.at + match.length;
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
export function shortWhen(iso: string): string {
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
export function placeholderMeta(id: string, name: string): FileMeta {
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
    aiSummary: null,
  // A search hit stands in for a real row only long enough to be attached;
  // "linked" is the honest default because the hit came out of the room's own
  // index, and nothing downstream of an attachment reads placement anyway.
  originDestination: "library",
  libraryVisibility: "linked",
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
function fileHitsForMatch(results: SearchResults, filters: FindFilters): SearchResults["files"] {
  if (!filters.sources.includes("files")) return [];
  if (filters.match === "name") return results.files.filter((hit) => hit.snippet === "");
  if (filters.match === "text") return results.files.filter((hit) => hit.snippet !== "");
  return results.files;
}

function matchesFileMetadataFilter(
  hit: SearchResults["files"][number],
  fileById: Map<string, FileMeta>,
  kinds: Set<string>,
  cutoff: number | null,
): boolean {
  const meta = fileById.get(hit.id);
  // A hit whose file has left the room cannot answer a question about its type
  // or its date, so a filter that asks one excludes it.
  if (!meta) return false;
  if (kinds.size > 0 && !kinds.has(fileKindLabel(meta))) return false;
  if (cutoff === null) return true;
  const at = Date.parse(meta.createdAt);
  return !Number.isNaN(at) && at >= cutoff;
}

function filterFileMetadata(
  hits: SearchResults["files"],
  fileById: Map<string, FileMeta>,
  kinds: Set<string>,
  cutoff: number | null,
): SearchResults["files"] {
  if (kinds.size === 0 && cutoff === null) return hits;
  return hits.filter((hit) => matchesFileMetadataFilter(hit, fileById, kinds, cutoff));
}

function compareFileNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareFileDates(a: FileMeta, b: FileMeta, sort: SortKey): number {
  const comparison = a.createdAt.localeCompare(b.createdAt);
  if (comparison === 0) return compareFileNames(a.name, b.name);
  return sort === "newest" ? -comparison : comparison;
}

function compareFileHits(
  a: SearchResults["files"][number],
  b: SearchResults["files"][number],
  sort: SortKey,
  fileById: Map<string, FileMeta>,
): number {
  const aMeta = fileById.get(a.id);
  const bMeta = fileById.get(b.id);
  // A hit with no metadata has nothing to sort ON; it sinks rather than
  // landing in an arbitrary place and looking like a ranking.
  if (!aMeta) return bMeta ? 1 : 0;
  if (!bMeta) return -1;
  return sort === "name" ? compareFileNames(aMeta.name, bMeta.name) : compareFileDates(aMeta, bMeta, sort);
}

function sortFileHits(
  hits: SearchResults["files"],
  sort: SortKey,
  fileById: Map<string, FileMeta>,
): SearchResults["files"] {
  if (sort === "best") return hits;
  return [...hits].sort((a, b) => compareFileHits(a, b, sort, fileById));
}

function textHitsForSource<Type extends "messages" | "memories">(
  results: SearchResults,
  filters: FindFilters,
  source: Type,
): SearchResults[Type] {
  return filters.match !== "name" && filters.sources.includes(source) ? results[source] : [];
}

export function applyFindFilters(
  results: SearchResults | null,
  filters: FindFilters,
  fileById: Map<string, FileMeta>,
): ShownResults {
  if (!results) return EMPTY_SHOWN;
  const kinds = new Set(filters.kinds);
  const cutoff = whenCutoff(filters.when);
  return {
    files: sortFileHits(filterFileMetadata(fileHitsForMatch(results, filters), fileById, kinds, cutoff), filters.sort, fileById),
    messages: textHitsForSource(results, filters, "messages"),
    memories: textHitsForSource(results, filters, "memories"),
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


export { SearchFiltersBar } from "./SearchFiltersBar";
export { SearchIdlePanel, SearchQueryActions, SearchResultRows } from "./SearchResultRows";
