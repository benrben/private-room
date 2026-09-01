import type React from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type {
  BrowserSearchResult,
  FileMeta,
  ResultPreview,
  WebHit,
} from "../apiTypes";
import { EmptySearch, SearchResults } from "./BrowserSearchResults";
export { BrowserSearchSkeleton, searchPrivacyLine } from "./BrowserSearchSummary";

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
export const ENGINE_SLOTS = [
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
export const PREVIEW_COUNT = 8;

/** The sidecar reports a failed engine by its FUNCTION name (`duckduckgo_ia`),
 *  while every hit reports the same engine by its `source` — which is what the
 *  dial, the footer and ENGINE_SLOTS above are written in. Left untranslated,
 *  one page called one engine two things. Only the two that differ are listed;
 *  every other failure name already IS a slot name. */
const ENGINE_ALIASES: Record<string, string> = {
  duckduckgo_ia: "ddg-ia",
  google_news: "news",
};

/** The name for an engine in the page's own vocabulary. */
export function engineName(name: string): string {
  return ENGINE_ALIASES[name] ?? name;
}

export type AddState = "idle" | "adding" | "added" | "error";

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

type SearchKeyAction =
  | { type: "move"; delta: number }
  | { type: "open"; newTab: boolean }
  | { type: "peek" }
  | { type: "add" };

type SearchActions = {
  add: (hit: WebHit) => Promise<void>;
  peek: (hit: WebHit) => Promise<void>;
};

function isSearchControl(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, a, input, textarea, [contenteditable]") !== null
  );
}

function selectionMovement(key: string): number | null {
  if (key === "ArrowDown" || key === "j") return 1;
  if (key === "ArrowUp" || key === "k") return -1;
  return null;
}

function isAddShortcut(key: string): boolean {
  return key === "a" || key === "+";
}

function resultKeyAction(
  key: string,
  newTab: boolean,
): Exclude<SearchKeyAction, { type: "move" }> | null {
  if (key === "Enter") return { type: "open", newTab };
  if (key === "p") return { type: "peek" };
  if (isAddShortcut(key)) return { type: "add" };
  return null;
}

function searchKeyAction(
  key: string,
  newTab: boolean,
  hasHit: boolean,
): SearchKeyAction | null {
  const delta = selectionMovement(key);
  if (delta !== null) return { type: "move", delta };
  return hasHit ? resultKeyAction(key, newTab) : null;
}

function performSearchKeyAction(
  action: SearchKeyAction,
  hit: WebHit | undefined,
  hitCount: number,
  setSelected: React.Dispatch<React.SetStateAction<number>>,
  onOpen: (url: string) => void,
  onOpenNewTab: (url: string) => void,
  actions: SearchActions,
): void {
  if (action.type === "move") {
    setSelected((selected) =>
      Math.max(0, Math.min(hitCount - 1, selected + action.delta)),
    );
    return;
  }
  if (hit === undefined) return;
  if (action.type === "open") {
    if (action.newTab) onOpenNewTab(hit.url);
    else onOpen(hit.url);
    return;
  }
  if (action.type === "peek") void actions.peek(hit);
  else void actions.add(hit);
}

function isOutsideEditableFocus(
  active: Element | null,
  list: HTMLElement,
): boolean {
  if (!isEditableElement(active)) return false;
  return !isActiveInSearchArea(active, list);
}

function isEditableElement(active: Element | null): boolean {
  if (active instanceof HTMLInputElement) return true;
  if (active instanceof HTMLTextAreaElement) return true;
  return active instanceof HTMLElement && active.isContentEditable;
}

function isActiveInSearchArea(
  active: Element | null,
  list: HTMLElement,
): boolean {
  const area = list.closest(".browser-area");
  if (!(active instanceof Node) || area === null) return false;
  return area.contains(active);
}

function useSearchKeyboard(
  hits: WebHit[],
  selected: number,
  setSelected: React.Dispatch<React.SetStateAction<number>>,
  onOpen: (url: string) => void,
  onOpenNewTab: (url: string) => void,
  actions: SearchActions,
) {
  return useCallback(
    (event: React.KeyboardEvent) => {
      if (isSearchControl(event.target)) return;
      const hit = hits[selected];
      const action = searchKeyAction(
        event.key,
        event.metaKey || event.ctrlKey,
        hit !== undefined,
      );
      if (action === null) return;
      event.preventDefault();
      performSearchKeyAction(
        action,
        hit,
        hits.length,
        setSelected,
        onOpen,
        onOpenNewTab,
        actions,
      );
    },
    [actions, hits, onOpen, onOpenNewTab, selected, setSelected],
  );
}

function useSearchFocus(
  listRef: React.RefObject<HTMLDivElement | null>,
  hits: WebHit[],
) {
  useEffect(() => {
    const list = listRef.current;
    if (list === null || isOutsideEditableFocus(document.activeElement, list))
      return;
    list.focus({ preventScroll: true });
  }, [hits, listRef]);
}

function useSelectedCardScroll(
  listRef: React.RefObject<HTMLDivElement | null>,
  selected: number,
) {
  useEffect(() => {
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    card?.scrollIntoView({ block: "nearest" });
  }, [listRef, selected]);
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
  // The container takes the keyboard on arrival, so it has to name itself. The
  // query heading is already on screen: point at it rather than inventing a
  // second copy of the words.
  const headingId = useId();

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
        // Named on the page, not in a toast that can be missed — the size-cap
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
      // The read outlives the peek that started it: pressing 'p' again (or
      // running another search) closes the preview, and a plain write here
      // re-opened it when the page finally answered. Only fill a slot that is
      // still open — the key's absence IS the cancellation.
      const settle = (value: string) =>
        setPeeks((m) => (hit.url in m ? { ...m, [hit.url]: value } : m));
      try {
        settle(await api.browserPeek(hit.url));
      } catch (e) {
        settle(`Could not read that page — ${e}`);
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
  const actions = useMemo<SearchActions>(() => ({ add, peek }), [add, peek]);
  const onKeyDown = useSearchKeyboard(
    hits,
    sel,
    setSel,
    onOpen,
    onOpenNewTab,
    actions,
  );

  // Hand the keyboard to the results the moment they arrive. Every single-key
  // action above is dead until this container holds focus, and a page that
  // ignores ArrowDown right after a search reads as broken rather than as
  // "press Tab first".
  //
  // But the search is not always the user's: the ASSISTANT searches too
  // (browse_open → browser-searched), and that page mounts while the user is
  // mid-sentence in the composer. Taking focus there turned the rest of the
  // sentence into single-key actions — 'a' imports the selected result into
  // the room.
  //
  // So: never reach OUT of this browser for the keyboard. Yielding to every
  // editable instead would have broken the ordinary case it exists for — the
  // address bar is an <input> and submitting it does not blur it, so the
  // user's own search would have left the caret in the box with ArrowDown,
  // 'p' and Enter all dead on the results they just asked for.
  useSearchFocus(listRef, hits);
  useSelectedCardScroll(listRef, sel);

  if (hits.length === 0) {
    return (
      <EmptySearch
        headingId={headingId}
        onKeyDown={onKeyDown}
        result={result}
      />
    );
  }
  return (
    <SearchResults
      addError={addError}
      adds={adds}
      headingId={headingId}
      hits={hits}
      listRef={listRef}
      maxScore={maxScore}
      onAsk={onAsk}
      onKeyDown={onKeyDown}
      onOpen={onOpen}
      onOpenNewTab={onOpenNewTab}
      peek={peek}
      peeks={peeks}
      previews={previews}
      previewsPending={result.previewsEnabled && !previewsSettled}
      result={result}
      selected={sel}
      setAddError={setAddError}
      setSelected={setSel}
      summarize={summarize}
      summary={summary}
      summaryBusy={summaryBusy}
      summaryError={summaryError}
      add={add}
    />
  );
}
