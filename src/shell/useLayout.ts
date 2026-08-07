import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** The three workspace panes. "library" = left (files/sources/area nav),
 * "center" = the primary work surface, "ai" = chat/studio/activity. */
export type PaneKey = "library" | "center" | "ai";

export const PANE_ORDER: PaneKey[] = ["library", "center", "ai"];

/** Default proportions (16 / 61 / 23): ONE dominant workspace, with the library
 * a navigable strip and the AI pane a slim contextual column you widen or
 * collapse to a drawer as needed. Ratios, not widths. New rooms (and Reset
 * layout) get this; rooms with a saved custom layout keep theirs.
 *
 * The target is 65-75% of the WINDOW for the thing being worked on, and the
 * arithmetic only reaches it once a side column is out of the way — which is
 * the point of the AI pane being contextual. A hidden pane's track collapses
 * to 0px and its share is redistributed by the `fr` units, so on a 1440px
 * window with the rail expanded (192px) the grid is 1248px and:
 *
 *   all three open   0.61            × 1248 = 761px   53% of the window
 *   AI closed        0.61/0.77 = .79 × 1248 = 989px   69% of the window  ← target
 *   focus mode       1.0             × 1248          87% of the window
 *
 * There is no split that hits 65% with three panes open and still leaves the
 * library navigable and the composer usable: their floors alone (0.13 + 0.20)
 * spend a third of the grid. So the width is earned by CLOSING the column the
 * page does not need, per `setFocusedPage` below, rather than by squeezing two
 * panes down to a size neither works at. */
const DEFAULT_RATIOS: Record<PaneKey, number> = {
  library: 0.16,
  center: 0.61,
  ai: 0.23,
};

/** Drag/keyboard clamps: the library stays a navigable strip at the low end and
 * the AI pane stays wide enough for its composer, while `centerMin` is what
 * actually protects the readable center column. The library's max is deliberately
 * generous (GH #2 — it used to stop at 0.32, which read as "won't expand"); with
 * three panes open `centerMin` binds first anyway, so the extra headroom is only
 * reachable when a neighbour is collapsed — which is exactly when a wide file
 * list is what the user wanted. */
const CLAMP = {
  library: { min: 0.13, max: 0.5 },
  ai: { min: 0.2, max: 0.42 },
  centerMin: 0.4,
};

/** Below this the three-pane grid stops being readable; the shell shows ONE
 * pane at a time and the rail buttons switch instead of toggle. */
const NARROW_QUERY = "(max-width: 1080px)";

type Persisted = {
  ratios?: Partial<Record<PaneKey, number>>;
  hidden?: Partial<Record<PaneKey, boolean>>;
  /** GH #2: the activity rail widened to icon + full label. */
  railExpanded?: boolean;
  /** Schema version of this record. See `LAYOUT_VERSION`. */
  v?: number;
};

/** Bumped when a DEFAULT changes in a way a stored value would hide.
 *
 * v2 made the rail's readable labels the default. Every room saved before it
 * carries `railExpanded: false` — not because anyone chose the icon strip, but
 * because that was the old default and the flag is written on every layout
 * change. Reading those back would mean the labels never appeared for anyone
 * who had ever resized a pane. So a record older than this version keeps its
 * ratios and its collapsed panes (both are real choices) and takes the new
 * rail default once; the next write stamps v2 and the choice is the user's
 * again from then on. */
const LAYOUT_VERSION = 2;

const LAYOUT_PREFIX = "prLayout:";

/** The saved-layout key for one room.
 *
 * Keyed by a DIGEST OF THE ROOM'S PATH, for two reasons that were both bugs:
 *
 *   • the key used to be `prLayout:<room name>`, so every room you ever opened
 *     left its name in plain browser storage, outside the encrypted file, with
 *     nothing to clear it — not locking, not quitting, not "Clear recent
 *     rooms". A room name is room content;
 *   • it was the NAME, so two rooms called "Work" in different folders shared
 *     one layout and overwrote each other's.
 *
 * 64 bits of FNV-1a (two accumulators): enough that two rooms colliding is not
 * a thing that happens, one-way enough that the key names nothing. */
export function layoutKey(roomPath: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < roomPath.length; i++) {
    const c = roomPath.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `${LAYOUT_PREFIX}${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** Drop every saved layout — used by "Clear recent rooms", which promises to
 * forget the rooms you have opened and used to leave this behind. */
export function forgetSavedLayouts(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LAYOUT_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* private mode etc. — nothing was stored to forget */
  }
}

/** Drop one room's saved layout (removing its shortcut from the start screen). */
export function forgetSavedLayout(roomPath: string): void {
  try {
    localStorage.removeItem(layoutKey(roomPath));
  } catch {
    /* nothing stored */
  }
}

/** Remove the pre-digest entries, which ARE room names sitting in plain
 * storage. Run on every load rather than once behind a flag: the point is that
 * the names go, and there is no honest way to keep them until a flag is set.
 * The old layout itself is not migrated — the ratios are two drags to redo,
 * and reading a legacy key would mean matching on the name again. */
function sweepLegacyLayoutKeys(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LAYOUT_PREFIX) && !/^prLayout:[0-9a-f]{16}$/.test(k)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* private mode etc. */
  }
}

function loadPersisted(key: string): Persisted {
  sweepLegacyLayoutKeys();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Persisted;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export type LayoutApi = ReturnType<typeof useLayout>;

/** The pane layout state machine: ratios, true collapse, focus/maximize,
 * reset, per-room persistence, ⌘1/2/3, and the narrow single-pane fallback.
 * Collapse is real — hidden panes and their splitters get 0px tracks. */
export function useLayout(roomPath: string) {
  const storageKey = layoutKey(roomPath);
  const persisted = useRef(loadPersisted(storageKey)).current;

  const [ratios, setRatios] = useState<Record<PaneKey, number>>(() => ({
    library: clamp01(persisted.ratios?.library, DEFAULT_RATIOS.library),
    center: clamp01(persisted.ratios?.center, DEFAULT_RATIOS.center),
    ai: clamp01(persisted.ratios?.ai, DEFAULT_RATIOS.ai),
  }));
  const [hidden, setHidden] = useState<Record<PaneKey, boolean>>(() => ({
    library: persisted.hidden?.library === true,
    center: persisted.hidden?.center === true,
    ai: persisted.hidden?.ai === true,
  }));
  const [focusPane, setFocusPane] = useState<PaneKey | null>(null);
  const [dragging, setDragging] = useState<"a" | "b" | null>(null);
  /** The rail showing icon + full label. Persisted like the ratios — it's a
   * standing preference, not a transient mode — and ON by default: navigation
   * a first-time reader has to hover to identify is not navigation. See
   * LAYOUT_VERSION for why a pre-v2 record's stored value is ignored. */
  const [railExpanded, setRailExpanded] = useState(() =>
    persisted.v === LAYOUT_VERSION ? persisted.railExpanded !== false : true,
  );
  const [isNarrow, setIsNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /** The one-time "step aside for a document" collapse of the AI column.
   *
   * Kept OUT of `hidden`, and therefore out of localStorage, on purpose. When
   * this lived in `hidden` it was serialised by the effect below, so opening a
   * single PDF hid the AI pane FOREVER: the flag came back from storage on the
   * next launch while `aiChoiceRef` reset to false with the mount, and the user
   * arrived at Home with a column missing and nothing on screen explaining why.
   * A suggestion the software makes on the user's behalf must not outlive the
   * session; only a choice the user actually made gets written down. */
  const [aiSteppedAside, setAiSteppedAside] = useState(false);

  // Persist ratios + hidden + rail width per room (focus is a transient mode).
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ratios, hidden, railExpanded, v: LAYOUT_VERSION }),
      );
    } catch {
      /* private-mode etc. — layout just won't persist */
    }
  }, [storageKey, ratios, railExpanded, hidden]);

  /** What is actually collapsed right now: the persisted choice, plus the
   * transient step-aside. Everything downstream reads this, never `hidden`. */
  const effHidden = useMemo<Record<PaneKey, boolean>>(
    () => ({ ...hidden, ai: hidden.ai || aiSteppedAside }),
    [hidden, aiSteppedAside],
  );

  /** Panes that currently own width. Narrow mode: exactly one (the focused
   * pane, else the first non-hidden in priority center > ai > library). */
  const visible = useMemo<PaneKey[]>(() => {
    if (isNarrow) {
      if (focusPane) return [focusPane];
      const pick = (["center", "ai", "library"] as PaneKey[]).find(
        (k) => !effHidden[k],
      );
      return [pick ?? "center"];
    }
    const list = PANE_ORDER.filter(
      (k) => !effHidden[k] && (!focusPane || focusPane === k),
    );
    return list.length > 0 ? list : ["center"];
  }, [isNarrow, focusPane, effHidden]);

  const showSplitA =
    visible.includes("library") &&
    (visible.includes("center") || visible.includes("ai"));
  const showSplitB = visible.includes("center") && visible.includes("ai");

  const gridStyle = useMemo<CSSProperties>(() => {
    const track = (k: PaneKey) =>
      !visible.includes(k)
        ? "0px"
        : visible.length === 1
          ? "1fr"
          : `${Math.round(ratios[k] * 1000)}fr`;
    return {
      "--left-track": track("library"),
      "--center-track": track("center"),
      "--right-track": track("ai"),
      "--split-a": showSplitA ? "5px" : "0px",
      "--split-b": showSplitB ? "5px" : "0px",
    } as CSSProperties;
  }, [visible, ratios, showSplitA, showSplitB]);

  /** Has the reader said anything about the AI column this session? Set by
   * every path a PERSON can take to it — the rail button, ⌘3, a collapse
   * arrow, a jump to Activity. Once it is true the automatic collapse below
   * never fires again: a pane the user has opened stays open, and software
   * that quietly undoes a click is worse than software that never helped. */
  const aiChoiceRef = useRef(false);
  /** Whether the workspace is currently on a focused page (see below). */
  const focusedRef = useRef(false);

  /** Tell the layout that the workspace pane is (or is no longer) showing a
   * page whose whole job is reading or recording — a book, a PDF, a Word
   * document, a deck, a recording, the Recordings area.
   *
   * On the way IN, the AI column steps aside once, which is what gets the
   * document to ~70% of the window (see DEFAULT_RATIOS). It is a suggestion,
   * not a mode: reopening the pane is one click, and doing so settles the
   * question for the rest of the session. Nothing happens on the way out —
   * re-opening a column the user did not ask for would be the same
   * interruption in the other direction.
   *
   * It writes to `aiSteppedAside`, never to `hidden`, so it dies with the
   * session rather than being persisted as though the user had chosen it. */
  const setFocusedPage = useCallback((focused: boolean) => {
    if (focusedRef.current === focused) return;
    focusedRef.current = focused;
    if (!focused || aiChoiceRef.current) return;
    setAiSteppedAside(true);
  }, []);

  /** Every path a PERSON can take to the AI column settles the question: the
   * automatic collapse never fires again, and any step-aside already in effect
   * is released so their click is not immediately fighting it. */
  const noteAiChoice = useCallback(() => {
    aiChoiceRef.current = true;
    setAiSteppedAside(false);
  }, []);

  /** Rail pane button: toggle visibility (or, in focus/narrow mode, move the
   * single visible slot to that pane). Never leaves zero panes. */
  const togglePane = useCallback(
    (key: PaneKey) => {
      if (key === "ai") noteAiChoice();
      if (isNarrow) {
        setFocusPane((f) => (f === key ? f : key));
        setHidden((h) => ({ ...h, [key]: false }));
        return;
      }
      if (focusPane) {
        setFocusPane(focusPane === key ? null : key);
        setHidden((h) => ({ ...h, [key]: false }));
        return;
      }
      setHidden((h) => {
        const next = { ...h, [key]: !h[key] };
        if (next.library && next.center && next.ai) next.center = false;
        return next;
      });
    },
    [isNarrow, focusPane, noteAiChoice],
  );

  /** Focus/maximize a pane; activating again restores the prior layout.
   * Maximising the AI column is as deliberate a choice as opening it, so it
   * settles the step-aside question too — otherwise focusing it and then
   * opening a PDF would collapse the pane the user had just maximised. */
  const toggleFocus = useCallback(
    (key: PaneKey) => {
      if (key === "ai") noteAiChoice();
      setHidden((h) => ({ ...h, [key]: false }));
      setFocusPane((f) => (f === key ? null : key));
    },
    [noteAiChoice],
  );

  /** Make sure a pane is on screen (used by citations, activity jumps…).
   * Unhides it; in narrow/focus modes it becomes the focused pane. */
  const showPane = useCallback(
    (key: PaneKey) => {
      if (key === "ai") noteAiChoice();
      setHidden((h) => ({ ...h, [key]: false }));
      if (isNarrow) setFocusPane(key);
      else setFocusPane((f) => (f !== null && f !== key ? null : f));
    },
    [isNarrow, noteAiChoice],
  );

  const collapsePane = useCallback((key: PaneKey) => {
    if (key === "ai") noteAiChoice();
    setFocusPane(null);
    setHidden((h) => {
      const next = { ...h, [key]: true };
      if (next.library && next.center && next.ai) next.center = false;
      return next;
    });
  }, [noteAiChoice]);

  const resetLayout = useCallback(() => {
    setRatios({ ...DEFAULT_RATIOS });
    setHidden({ library: false, center: false, ai: false });
    setFocusPane(null);
    setRailExpanded(true);
    // Reset means "start again from the defaults", and the focused-page
    // suggestion is one of them — so it is re-armed rather than left disabled
    // by whatever the user happened to click before pressing Reset.
    aiChoiceRef.current = false;
    focusedRef.current = false;
    setAiSteppedAside(false);
  }, []);

  const toggleRail = useCallback(() => setRailExpanded((v) => !v), []);

  /** Shared resize math (pointer + keyboard). Side "a" sizes the library
   * against whichever neighbour is visible; side "b" sizes the AI pane
   * against the center.
   *
   * The two panes on either side of the splitter TRADE: their combined share is
   * held constant, so the ratios keep summing to 1 and `nextEdge` (a fraction of
   * the whole grid, straight off the pointer) stays directly comparable to the
   * pane's own ratio. That is also what makes the floors real — growing one pane
   * is bounded by `pair - <neighbour's min>`, so the neighbour can never be
   * squeezed past its minimum. (Clamping each side independently, as this did
   * before, let the sum drift above 1 and quietly pushed the center under
   * `centerMin`.) */
  const applyResize = useCallback(
    (side: "a" | "b", nextEdge: number, centerHidden: boolean) => {
      setRatios((r) => {
        const next = { ...r };
        if (side === "a") {
          // The library trades with the center, or with the AI pane when the
          // center is collapsed.
          const withAi = centerHidden;
          const pair = next.library + (withAi ? next.ai : next.center);
          const floor = withAi ? CLAMP.ai.min : CLAMP.centerMin;
          const lib = bound(
            nextEdge,
            CLAMP.library.min,
            Math.min(CLAMP.library.max, pair - floor),
          );
          next.library = lib;
          if (withAi) next.ai = pair - lib;
          else next.center = pair - lib;
        } else {
          const pair = next.center + next.ai;
          const ai = bound(
            nextEdge,
            CLAMP.ai.min,
            Math.min(CLAMP.ai.max, pair - CLAMP.centerMin),
          );
          next.ai = ai;
          next.center = pair - ai;
        }
        return next;
      });
    },
    [],
  );

  const startDrag = useCallback(
    (side: "a" | "b", e: ReactPointerEvent<HTMLElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      setDragging(side);
      document.body.classList.add("resizing-col");
      const centerHidden = !grid.querySelector(
        ".pane-center:not(.is-hidden)",
      );
      const move = (ev: globalThis.PointerEvent) => {
        const rect = grid.getBoundingClientRect();
        if (rect.width <= 0) return;
        const edge =
          side === "a"
            ? (ev.clientX - rect.left) / rect.width
            : (rect.right - ev.clientX) / rect.width;
        applyResize(side, edge, centerHidden);
      };
      const up = (ev: globalThis.PointerEvent) => {
        setDragging(null);
        document.body.classList.remove("resizing-col");
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch {
          /* already released */
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [applyResize],
  );

  /** Arrow keys on a splitter. Goes through the same trade as the pointer so
   * keyboard and mouse can never disagree about the floors; ArrowRight on the
   * right splitter shrinks the AI pane (the edge moves right). */
  const keyResize = useCallback(
    (side: "a" | "b", direction: 1 | -1, big: boolean) => {
      const amount = (big ? 0.04 : 0.015) * direction;
      applyResize(
        side,
        side === "a" ? ratios.library + amount : ratios.ai - amount,
        !visible.includes("center"),
      );
    },
    [applyResize, ratios, visible],
  );

  // ⌘/Ctrl+1/2/3 toggle panes; Escape leaves focus mode. Capture phase so
  // the focus-Escape wins over the workspace's close-file Escape.
  //
  // These three keys have exactly ONE meaning in this app — the one the rail's
  // own labels promise. The claim is settled here (capture + stopPropagation)
  // so a second handler can never also act on the same press; tab-by-position
  // lives on ⌥⌘1–⌥⌘9, which is why Option is excluded below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        ["1", "2", "3"].includes(e.key)
      ) {
        e.preventDefault();
        e.stopPropagation();
        togglePane(PANE_ORDER[Number(e.key) - 1]);
        return;
      }
      if (e.key === "Escape" && focusPane) {
        const t = e.target as HTMLElement | null;
        const typing =
          t != null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        setFocusPane(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePane, focusPane]);

  const layoutLabel = focusPane
    ? `${focusPane === "ai" ? "AI" : focusPane === "library" ? "Library" : "Editor"} focus`
    : `${visible.length} pane${visible.length === 1 ? "" : "s"}`;

  return {
    ratios,
    // The EFFECTIVE map, so a consumer asking "is the AI pane hidden?" gets
    // the same answer the layout is rendering. `hidden` alone is only the
    // persisted half and would lie while the step-aside is in effect.
    hidden: effHidden,
    focusPane,
    visible,
    isNarrow,
    dragging,
    railExpanded,
    toggleRail,
    gridRef,
    gridStyle,
    showSplitA,
    showSplitB,
    layoutLabel,
    togglePane,
    toggleFocus,
    showPane,
    collapsePane,
    setFocusedPage,
    resetLayout,
    startDrag,
    keyResize,
  };
}

function clamp01(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0.05 && v < 0.95
    ? v
    : fallback;
}

/** Clamp into [lo, hi]. When the window is too narrow for both neighbours'
 * floors, `hi` can fall below `lo` — the minimum wins, so a pane never
 * collapses to nothing mid-drag. */
function bound(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
