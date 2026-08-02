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

/** Default proportions (18 / 58 / 24): ONE dominant workspace, with the library
 * a navigable strip and the AI pane a slim contextual column you widen or
 * collapse to a drawer as needed. Ratios, not widths. New rooms (and Reset
 * layout) get this; rooms with a saved custom layout keep theirs. */
const DEFAULT_RATIOS: Record<PaneKey, number> = {
  library: 0.18,
  center: 0.58,
  ai: 0.24,
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
};

function loadPersisted(key: string): Persisted {
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
export function useLayout(roomName: string) {
  const storageKey = `prLayout:${roomName}`;
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
  /** GH #2: the rail widened to icon + full label. Persisted like the ratios —
   * it's a standing preference, not a transient mode. */
  const [railExpanded, setRailExpanded] = useState(
    () => persisted.railExpanded === true,
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

  // Persist ratios + hidden + rail width per room (focus is a transient mode).
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ratios, hidden, railExpanded }),
      );
    } catch {
      /* private-mode etc. — layout just won't persist */
    }
  }, [storageKey, ratios, hidden, railExpanded]);

  /** Panes that currently own width. Narrow mode: exactly one (the focused
   * pane, else the first non-hidden in priority center > ai > library). */
  const visible = useMemo<PaneKey[]>(() => {
    if (isNarrow) {
      if (focusPane) return [focusPane];
      const pick = (["center", "ai", "library"] as PaneKey[]).find(
        (k) => !hidden[k],
      );
      return [pick ?? "center"];
    }
    const list = PANE_ORDER.filter(
      (k) => !hidden[k] && (!focusPane || focusPane === k),
    );
    return list.length > 0 ? list : ["center"];
  }, [isNarrow, focusPane, hidden]);

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

  /** Rail pane button: toggle visibility (or, in focus/narrow mode, move the
   * single visible slot to that pane). Never leaves zero panes. */
  const togglePane = useCallback(
    (key: PaneKey) => {
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
    [isNarrow, focusPane],
  );

  /** Focus/maximize a pane; activating again restores the prior layout. */
  const toggleFocus = useCallback((key: PaneKey) => {
    setHidden((h) => ({ ...h, [key]: false }));
    setFocusPane((f) => (f === key ? null : key));
  }, []);

  /** Make sure a pane is on screen (used by citations, activity jumps…).
   * Unhides it; in narrow/focus modes it becomes the focused pane. */
  const showPane = useCallback(
    (key: PaneKey) => {
      setHidden((h) => ({ ...h, [key]: false }));
      if (isNarrow) setFocusPane(key);
      else setFocusPane((f) => (f !== null && f !== key ? null : f));
    },
    [isNarrow],
  );

  const collapsePane = useCallback((key: PaneKey) => {
    setFocusPane(null);
    setHidden((h) => {
      const next = { ...h, [key]: true };
      if (next.library && next.center && next.ai) next.center = false;
      return next;
    });
  }, []);

  const resetLayout = useCallback(() => {
    setRatios({ ...DEFAULT_RATIOS });
    setHidden({ library: false, center: false, ai: false });
    setFocusPane(null);
    setRailExpanded(false);
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
    hidden,
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
