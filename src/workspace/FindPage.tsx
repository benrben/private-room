import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, fileKindLabel, formatSize } from "../api";
import type { FileMeta, SearchResults } from "../api";
import {
  ChatBubbleIcon,
  CloseIcon,
  FileTypeIcon,
  MemoryIcon,
  SearchIcon,
} from "../icons";
import { fileLabel, formatWhen } from "./composer";
import type { FlatResult } from "./types";

/** The Find area's contract with the shell.
 *
 * Deliberately a flat list of values and callbacks rather than the `s`/`a`
 * blobs the older area pages take: this page is written against a contract it
 * can be read, reasoned about and tested from, and the shell stays the only
 * thing that knows how a search is actually run.
 *
 * The query lives in the SHELL, not here, and it is the same slot the ⌘K
 * launcher writes to — so typing in one and then opening the other never
 * shows two different searches of the same room. */
export interface FindPageProps {
  /** Every file in the room, in the shell's order. Scoping, counting and the
   * "no files yet" case are all answered from this — the page never asks the
   * backend for a file list of its own. */
  files: FileMeta[];
  /** The words being searched for. */
  query: string;
  /** Write the query back to the shell (shared with the ⌘K launcher). */
  onQueryChange: (next: string) => void;
  /** Run ONE room-wide search and resolve with everything that matched.
   * Rejects with the backend's own message, which the page is expected to
   * show rather than swallow: a search that failed and a search that found
   * nothing are different answers, and a room must never confuse them. */
  onSearch: (query: string) => Promise<SearchResults>;
  /** Open one hit where it lives — a file (scrolled to the match), a chat
   * message (revealed in the transcript) or a memory. */
  onOpenResult: (hit: FlatResult) => void;
  /** Open a file in the workspace, with no match to scroll to. */
  onOpenFile: (fileId: string) => void;
  /** Hand the words to the composer instead, when the answer wants the room's
   * AI rather than a list of hits. */
  onAsk: (question: string) => void;
}

/* ==========================================================================
   Filters
   Every filter below narrows results the room ALREADY returned. None of them
   is a second search: `search_all` is the one index this page reads, so the
   page can never disagree with the ⌘K launcher about what is in the room.
   ========================================================================== */

/** Which of the three things a room-wide search looks at. */
type SourceKey = "files" | "messages" | "memories";
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

interface FindFilters {
  sources: SourceKey[];
  /** `fileKindLabel` words ("PDF", "note", "recording"). Empty = every type. */
  kinds: string[];
  when: WhenKey;
  match: MatchKey;
  sort: SortKey;
}

const ALL_SOURCES: SourceKey[] = ["files", "messages", "memories"];

const DEFAULT_FILTERS: FindFilters = {
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

/** Where this page's own two lists live.
 *
 * They are facts about THIS ROOM — "what have I looked for in here" — so they
 * go in the room's own encrypted settings table rather than in localStorage.
 * A device-wide key would carry one room's queries into another room's Find
 * page, which in a product whose whole promise is that a room is sealed would
 * be a leak; the app already made and fixed exactly that mistake once (see
 * MEMORY_INTRO_SEEN in workspace/effects.ts, which moved out of a localStorage
 * key built from the room's file name for the same reason).
 *
 * Both values are a JSON array. A malformed one is DROPPED rather than
 * repaired: a half-parsed list of past searches is worth nothing, and silently
 * showing someone a query they never ran is worse than showing them none. */
const RECENT_KEY = "find_recent_searches";
const SAVED_KEY = "find_saved_searches";
const RECENT_MAX = 8;
const SAVED_MAX = 12;

/** A search worth keeping: the words AND the way they were narrowed, because
 * "invoices, PDFs only, this year" is the thing being saved — not "invoices". */
interface SavedSearch {
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
 * runs, never to a filter the page cannot render. */
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

/* ==========================================================================
   The page
   ========================================================================== */

/** Full-page search.
 *
 * The ⌘K launcher and this are deliberately different things and share one
 * query slot: the launcher is a COMMAND — type, jump, gone — and this is a
 * PLACE, where a search is narrowed, re-read, and worked through. Both read
 * `search_all`, the room's one index, so neither can show an answer the other
 * would contradict. */
export default function FindPage(props: FindPageProps) {
  const { files, query, onQueryChange, onSearch, onOpenResult, onOpenFile, onAsk } = props;
  const ids = useId();
  const trimmed = query.trim();

  const [results, setResults] = useState<SearchResults | null>(null);
  /** The query `results` are FOR. Kept separately from `query` so a slow
   * search cannot make the page label one query's hits with another's — and
   * so the highlighting marks the words that were actually searched. */
  const [ranFor, setRanFor] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<FindFilters>(DEFAULT_FILTERS);
  const [recent, setRecent] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const rowsRef = useRef<HTMLDivElement>(null);
  /** False until the room's stored lists have actually been read. Every write
   * is gated on it, so a save that lands before the load can never overwrite
   * the room's real lists with this page's empty starting state. A load that
   * FAILS leaves it false on purpose: nothing is persisted for the rest of the
   * session, which loses this session's history but keeps what was already
   * there. */
  const loadedRef = useRef(false);

  /* ----- persistence ----- */

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

  /* ----- the search ----- */

  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      setError("");
      setRanFor("");
      setBusy(false);
      return;
    }
    let stale = false;
    setBusy(true);
    // Debounced, like the launcher's: the room is searched as you type, and
    // every keystroke firing an FTS query over a large room would make the
    // page fight itself.
    const t = window.setTimeout(() => {
      onSearch(trimmed)
        .then((r) => {
          if (stale) return;
          setResults(r);
          setError("");
          setRanFor(trimmed);
          setBusy(false);
          // Recording every search that ran would fill the list with the
          // prefixes of the word being typed — "i", "in", "inv", "invo". Any
          // stored entry that the new query STARTS WITH is dropped, so a word
          // typed a letter at a time collapses into the one query that was
          // actually meant.
          setRecent((prev) => {
            if (prev[0] === trimmed) return prev;
            const lower = trimmed.toLowerCase();
            const kept = prev.filter((x) => !lower.startsWith(x.toLowerCase()));
            return [trimmed, ...kept].slice(0, RECENT_MAX);
          });
        })
        .catch((e) => {
          if (stale) return;
          // The previous query's hits must not stay on screen under a query
          // that never ran — you would act on results for something else.
          setResults(null);
          setError(String(e));
          setRanFor(trimmed);
          setBusy(false);
        });
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [trimmed, onSearch]);

  /* ----- derived ----- */

  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const terms = useMemo(() => highlightTerms(ranFor), [ranFor]);

  /** Every file type present in this search's file hits, in the room's own
   * order. The Type chips are drawn from the RESULTS rather than from the
   * whole room, so the row never offers a filter that would empty the list. */
  const kindsPresent = useMemo(() => {
    const out: string[] = [];
    for (const h of results?.files ?? []) {
      const meta = fileById.get(h.id);
      if (!meta) continue;
      const k = fileKindLabel(meta);
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }, [results, fileById]);

  const shown = useMemo(() => {
    const empty = { files: [] as SearchResults["files"], messages: [] as SearchResults["messages"], memories: [] as SearchResults["memories"] };
    if (!results) return empty;
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
  }, [results, filters, fileById]);

  const total = results
    ? results.files.length + results.messages.length + results.memories.length
    : 0;
  const totalShown = shown.files.length + shown.messages.length + shown.memories.length;
  const narrowed = totalShown !== total;
  const active = filterSummary(filters);
  const isSaved = saved.some((s) => s.q === trimmed);

  /* ----- actions ----- */

  const patch = useCallback((p: Partial<FindFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
  }, []);

  const toggleSource = useCallback((s: SourceKey) => {
    setFilters((f) => {
      const on = f.sources.includes(s);
      const next = on ? f.sources.filter((x) => x !== s) : [...f.sources, s];
      // Turning the last one off would leave a search that cannot match
      // anything and no way back except reading this comment, so the last
      // remaining source stays on.
      if (next.length === 0) return f;
      return { ...f, sources: ALL_SOURCES.filter((x) => next.includes(x)) };
    });
  }, []);

  const toggleKind = useCallback((k: string) => {
    setFilters((f) => ({
      ...f,
      kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k],
    }));
  }, []);

  const runSaved = useCallback(
    (s: SavedSearch) => {
      setFilters(s.filters);
      onQueryChange(s.q);
    },
    [onQueryChange],
  );

  function toggleSaveCurrent() {
    if (!trimmed) return;
    setSaved((prev) =>
      prev.some((s) => s.q === trimmed)
        ? prev.filter((s) => s.q !== trimmed)
        : [{ q: trimmed, filters }, ...prev].slice(0, SAVED_MAX),
    );
  }

  /** Focus moves between rows with the arrow keys, which is what a list of
   * results should do; every row is also an ordinary button, so Tab still
   * reaches them and Enter still opens them. */
  function onRowsKey(e: React.KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const rows = Array.from(rowsRef.current?.querySelectorAll<HTMLElement>("[data-find-row]") ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (at === -1) next = e.key === "ArrowDown" ? 0 : rows.length - 1;
    else next = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
  }

  function focusFirstRow() {
    rowsRef.current?.querySelector<HTMLElement>("[data-find-row]")?.focus();
  }

  /* ----- the count sentence, which is also the live region -----
     Short on purpose: a screen reader hears it every time the results change,
     so it says how many and for what, and the per-source breakdown sits in a
     separate line that is not announced. */
  const countLine = busy
    ? "Searching…"
    : error
      ? "The search did not run."
      : !ranFor
        ? ""
        : totalShown === 0
          ? `No results for “${ranFor}”`
          : narrowed
            ? `${totalShown} of ${total} results for “${ranFor}”`
            : `${totalShown} result${totalShown === 1 ? "" : "s"} for “${ranFor}”`;

  const hintId = `${ids}-hint`;

  return (
    <div className="find-view">
      <div className="find-inner">
        <h1 className="find-title">Find</h1>
        {/* Short, conversational, and about the room rather than an
            instruction — which is what the hand is reserved for. */}
        <p className="nb-subtitle">
          {files.length > 0
            ? `${files.length} file${files.length === 1 ? "" : "s"} to look through`
            : "Nothing in this room to search yet"}
        </p>
        <p className="find-lead">
          Search every file, conversation and memory in this room at once. A
          result opens where it lives.
        </p>

        {/* The field is the page. It is large, it is always here, and it is
            wired to the same query slot as ⌘K. `role="search"` makes it a
            landmark a screen-reader user can jump straight to. */}
        <form
          className="nb-field find-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            // Results are live, so there is nothing to submit — Enter moves
            // on to the list, which is what the key is for here.
            focusFirstRow();
          }}
        >
          <span className="find-search-ico" aria-hidden>
            <SearchIcon size={18} />
          </span>
          <input
            className="find-search-input"
            /* Not type="search": WebKit draws its OWN cancel button inside
               such a field, which would sit next to the one this row already
               has and give the same job two different-looking controls. */
            type="text"
            dir="auto"
            /* A search PAGE that does not put the caret in its search field
               makes you click the one thing you came here for. */
            autoFocus
            placeholder="Search this room"
            aria-label="Search this room"
            aria-describedby={hintId}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusFirstRow();
              }
            }}
          />
          {query !== "" && (
            <button
              type="button"
              className="find-search-clear"
              title="Clear the search"
              aria-label="Clear the search"
              onClick={() => onQueryChange("")}
            >
              <CloseIcon size={13} />
            </button>
          )}
        </form>
        <p className="find-hint" id={hintId}>
          Looks inside the text of your files, not only at their names. Nothing
          leaves this room.
        </p>

        {ranFor !== "" && !error && (
          <div className="find-query-actions">
            <button
              type="button"
              className={`nb-chip nb-chip-btn find-chip${isSaved ? " is-on" : ""}`}
              aria-pressed={isSaved}
              title={
                isSaved
                  ? "Stop keeping this search"
                  : "Keep this search — words and filters — in this room"
              }
              onClick={toggleSaveCurrent}
            >
              {isSaved && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
              <span>{isSaved ? "Saved" : "Save this search"}</span>
            </button>
            <button
              type="button"
              className="nb-btn find-ask"
              title="Hand these words to the room's AI instead of listing hits"
              onClick={() => onAsk(ranFor)}
            >
              Ask the room instead
            </button>
          </div>
        )}

        {/* ----- filters ----- */}
        {ranFor !== "" && !error && (
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
                  {/* "All" is a real chip rather than an implied empty state, so
                      exactly one thing in this row is always circled and the
                      row never looks like nothing is chosen. */}
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
              {active.length > 0 && (
                <button
                  type="button"
                  className="nb-btn nb-btn-quiet find-clear"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* The date filter reads a file's `createdAt`. Conversations and
                memories come back from the index with no date at all, so the
                honest thing is to say that rather than to quietly drop them or
                quietly keep them. Sans, not the hand: this explains how a
                control behaves. */}
            {filters.when !== "any" &&
              (shown.messages.length > 0 || shown.memories.length > 0) && (
                <p className="find-caveat">
                  Dates come from when a file was added. Conversations and
                  memories are not dated in this room's index, so they are
                  listed whatever this is set to.
                </p>
              )}
          </div>
        )}

        {/* ----- results ----- */}
        {/* .nb-frame rather than .nb-card: a card's border brightens on hover,
            and a failure notice must not change appearance just because the
            pointer crossed it. */}
        {error !== "" && (
          <div className="find-error nb-frame nb-sem-urgent nb-edge" role="alert">
            <strong className="find-error-head">This room could not be searched</strong>
            <span className="find-error-body">{error}</span>
          </div>
        )}

        {/* The count is a live region and it is mounted ALWAYS, empty and
            collapsed while the page is idle. A live region that appears at the
            same moment as its first message is the classic way to have that
            message go unannounced; one that is already there when the number
            lands is announced every time, including the first. */}
        <div className={`find-results-head${countLine === "" ? " is-idle" : ""}`}>
          <p className="find-count" role="status">
            {countLine}
          </p>
          {error === "" && shown.files.length > 0 && (
            <label className="find-sort">
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
        </div>

        {ranFor !== "" && error === "" && totalShown > 0 && (
          <p className="find-breakdown">
            {shown.files.length} file{shown.files.length === 1 ? "" : "s"} ·{" "}
            {shown.messages.length} message{shown.messages.length === 1 ? "" : "s"} ·{" "}
            {shown.memories.length} memor{shown.memories.length === 1 ? "y" : "ies"}
          </p>
        )}

        <div className="find-groups" ref={rowsRef} onKeyDown={onRowsKey} aria-busy={busy}>
          {shown.files.length > 0 && (
            <section className="find-group">
              {/* Identity, not status: the wash says WHICH of the three things
                  a row came from, the way the token-budget bar's five hues name
                  categories. The word carries the meaning either way. */}
              <h2 className="find-group-head">
                <span className="nb-cat nb-mark-blue">Files</span>
                <span className="find-group-n">{shown.files.length}</span>
              </h2>
              <div className="find-rows nb-list">
                {shown.files.map((h) => {
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
                      type="button"
                      className="find-row"
                      data-find-row
                      title={meta ? `Open ${h.name}` : h.name}
                      onClick={() =>
                        // A name-only hit has no passage to scroll to, so it
                        // opens the file plainly rather than sending the viewer
                        // hunting for words the document does not contain.
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
                {shown.messages.map((m) => (
                  <button
                    key={m.messageId}
                    type="button"
                    className="find-row"
                    data-find-row
                    title="Show this message in the conversation"
                    onClick={() =>
                      onOpenResult({
                        kind: "message",
                        chatId: m.chatId,
                        messageId: m.messageId,
                        snippet: m.snippet,
                      })
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
                ))}
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
                {shown.memories.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="find-row"
                    data-find-row
                    title="Show this in Memory"
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
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Nothing matched. The two ways out are the two real ones: widen the
            filters, or stop listing and ask. */}
        {ranFor !== "" && error === "" && !busy && totalShown === 0 && (
          <div className="find-empty">
            <p className="find-empty-line">
              {narrowed
                ? `Nothing matches “${ranFor}” with these filters — ${total === 1 ? "1 result is" : `${total} results are`} hidden by them.`
                : `Nothing in this room matches “${ranFor}” — not in files, conversations or memories.`}
            </p>
            <div className="find-empty-actions">
              {narrowed && (
                <button type="button" className="nb-btn" onClick={() => setFilters(DEFAULT_FILTERS)}>
                  Clear filters
                </button>
              )}
              <button
                type="button"
                className="nb-btn nb-btn-primary nb-btn-go"
                onClick={() => onAsk(ranFor)}
              >
                Ask the room instead
              </button>
            </div>
          </div>
        )}

        {/* ----- idle: saved and recent -----
            Only while nothing is being searched. A search page's saved list is
            a way IN; once there are results on screen it would be a second
            list competing with the one you asked for. Clearing the field
            brings it back. */}
        {trimmed === "" && (
          <div className="find-idle">
            <p className="nb-note find-idle-note">
              Start typing — every word of every file is already indexed.
            </p>
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
                          onClick={() => runSaved(s)}
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
                          onClick={() => setSaved((prev) => prev.filter((x) => x.q !== s.q))}
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
                      onClick={() => onQueryChange(r)}
                    >
                      <span dir="auto">{r}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="nb-btn nb-btn-quiet find-clear"
                    onClick={() => setRecent([])}
                  >
                    Clear recent
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders `text` with the searched words marked, one node per run.
 *
 * `<mark>` is the element the browser and the screen reader already understand
 * for "this is why you are looking at this"; paper.css's `.nb-mark` clears the
 * UA's own yellow and paints the highlighter over it. No marker class is set,
 * so it draws in the default highlighter yellow — a match is notable, and the
 * page's other colours stay free to mean something. */
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
