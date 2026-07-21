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

/** Drag/keyboard clamps, matching the reference feel: the library stays a
 * navigable strip, the AI pane stays wide enough for its composer, and the
 * center stays the dominant, readable column while others are visible. */
const CLAMP = {
  library: { min: 0.13, max: 0.32 },
  ai: { min: 0.2, max: 0.42 },
  centerMin: 0.4,
};

/** Below this the three-pane grid stops being readable; the shell shows ONE
 * pane at a time and the rail buttons switch instead of toggle. */
const NARROW_QUERY = "(max-width: 1080px)";

type Persisted = {
  ratios?: Partial<Record<PaneKey, number>>;
  hidden?: Partial<Record<PaneKey, boolean>>;
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

  // Persist ratios + hidden per room (focus is a transient mode).
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ratios, hidden }));
    } catch {
      /* private-mode etc. — layout just won't persist */
    }
  }, [storageKey, ratios, hidden]);

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
  }, []);

  /** Shared resize math (pointer + keyboard). Side "a" sizes the library
   * against whichever neighbour is visible; side "b" sizes the AI pane
   * against the center. */
  const applyResize = useCallback(
    (side: "a" | "b", nextEdge: number, centerHidden: boolean) => {
      setRatios((r) => {
        const next = { ...r };
        if (side === "a") {
          const lib = Math.min(
            CLAMP.library.max,
            Math.max(CLAMP.library.min, nextEdge),
          );
          const delta = lib - next.library;
          next.library = lib;
          if (!centerHidden) {
            next.center = Math.max(CLAMP.centerMin, next.center - delta);
          } else {
            next.ai = Math.max(CLAMP.ai.min, next.ai - delta);
          }
        } else {
          const ai = Math.min(CLAMP.ai.max, Math.max(CLAMP.ai.min, nextEdge));
          const delta = ai - next.ai;
          next.ai = ai;
          next.center = Math.max(CLAMP.centerMin, next.center - delta);
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

  const keyResize = useCallback(
    (side: "a" | "b", direction: 1 | -1, big: boolean) => {
      const amount = (big ? 0.04 : 0.015) * direction;
      setRatios((r) => {
        const next = { ...r };
        if (side === "a") {
          const lib = Math.min(
            CLAMP.library.max,
            Math.max(CLAMP.library.min, next.library + amount),
          );
          next.center = Math.max(
            CLAMP.centerMin,
            next.center - (lib - next.library),
          );
          next.library = lib;
        } else {
          // ArrowRight on the right splitter shrinks the AI pane.
          const ai = Math.min(
            CLAMP.ai.max,
            Math.max(CLAMP.ai.min, next.ai - amount),
          );
          next.center = Math.max(CLAMP.centerMin, next.center - (ai - next.ai));
          next.ai = ai;
        }
        return next;
      });
    },
    [],
  );

  // ⌘/Ctrl+1/2/3 toggle panes; Escape leaves focus mode. Capture phase so
  // the focus-Escape wins over the workspace's close-file Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
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
