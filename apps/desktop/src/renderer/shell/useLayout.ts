import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  bound,
  CLAMP,
  clampRatio,
  DEFAULT_RATIOS,
  layoutKey,
  layoutStatusLabel,
  LAYOUT_VERSION,
  leavesFocus,
  loadPersistedLayout,
  NARROW_QUERY,
  paneShortcut,
  PANE_ORDER,
  PRESETS,
  RAIL_NARROW_QUERY,
  splitterVisibility,
  type PaneKey,
  type PresetName,
  type SidePane,
} from "./layoutState";

export {
  forgetSavedLayout,
  forgetSavedLayouts,
  layoutKey,
  PANE_KEYS,
  PANE_ORDER,
  PRESETS,
} from "./layoutState";
export type { PaneKey, PresetName, SidePane } from "./layoutState";

export type LayoutApi = ReturnType<typeof useLayout>;

interface SkinLayoutDetail {
  enabled: boolean;
  layout: {
    railWidth: number;
    sidebarWidth: number;
    agentWidth: number;
    paneGap: number;
  };
}

function skinRatios(detail: SkinLayoutDetail["layout"], viewportWidth: number): Record<PaneKey, number> {
  const available = Math.max(760, viewportWidth - detail.railWidth - detail.paneGap * 2);
  let library = bound(detail.sidebarWidth / available, CLAMP.library.min, CLAMP.library.max);
  let ai = bound(detail.agentWidth / available, CLAMP.ai.min, CLAMP.ai.max);
  const center = 1 - library - ai;
  if (center < CLAMP.centerMin) {
    const reducibleLibrary = library - CLAMP.library.min;
    const reducibleAi = ai - CLAMP.ai.min;
    const reducible = reducibleLibrary + reducibleAi;
    const needed = CLAMP.centerMin - center;
    if (reducible > 0) {
      library -= needed * (reducibleLibrary / reducible);
      ai -= needed * (reducibleAi / reducible);
    }
  }
  return { library, center: 1 - library - ai, ai };
}

/** The pane layout state machine: ratios, true collapse, focus/maximize,
 * reset, per-room persistence, ⌘1/2/3, and the narrow single-pane fallback.
 * Collapse is real — hidden panes and their splitters get 0px tracks. */
export function useLayout(roomPath: string) {
  const storageKey = layoutKey(roomPath);
  const persisted = useRef(loadPersistedLayout(storageKey)).current;

  const [ratios, setRatios] = useState<Record<PaneKey, number>>(() => ({
    library: clampRatio(persisted.ratios?.library, DEFAULT_RATIOS.library),
    center: clampRatio(persisted.ratios?.center, DEFAULT_RATIOS.center),
    ai: clampRatio(persisted.ratios?.ai, DEFAULT_RATIOS.ai),
  }));
  const [hidden, setHidden] = useState<Record<PaneKey, boolean>>(() => ({
    library: persisted.hidden?.library === true,
    // ALWAYS false, and it is a migration rather than a simplification.
    //
    // The workspace used to be hideable — the rail carried a toggle for it —
    // so `hidden.center: true` is a value real rooms have on disk right now.
    // It is not hideable any more (it is the one pane the room is always FOR;
    // see `togglePane`), which means a record saved that way would reopen with
    // an empty middle column and no control anywhere that could bring it back.
    // Reading it as false retires those records on the next write.
    //
    // This needs no LAYOUT_VERSION bump, and deliberately does not get one: a
    // bump would also discard the library and assistant flags, and those are
    // real choices the reader made and expects to find where they left them.
    center: false,
    ai: persisted.hidden?.ai === true,
  }));
  const [focusPane, setFocusPane] = useState<PaneKey | null>(null);
  const [dragging, setDragging] = useState<"a" | "b" | null>(null);
  const [skinPaneGap, setSkinPaneGap] = useState(5);
  const preSkinRatios = useRef<Record<PaneKey, number> | null>(null);
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
  /** The window is too narrow to carry the sidebar's words, so it is drawing
   * icons whatever the reader prefers.
   *
   * SEPARATE STATE, AND NEVER PERSISTED — this is the whole trap. The effect
   * below writes `railExpanded` on every layout change, so an auto-collapse
   * that set `railExpanded` directly would be indistinguishable from the user
   * choosing the icon strip: one narrow window, one write, and the labels
   * never come back on any window at any width. Whoever widens the window
   * again must find their labels where they left them.
   *
   * This is the same shape as `aiSteppedAside` below, and for the same reason:
   * a suggestion the SOFTWARE makes must not outlive the condition that
   * prompted it, and only a choice the USER actually made gets written down. */
  const [railAutoCollapsed, setRailAutoCollapsed] = useState(
    () => window.matchMedia(RAIL_NARROW_QUERY).matches,
  );
  /** Whether the sidebar's "More tools" disclosure is open right now.
   *
   * Deliberately NOT persisted, and not in `Persisted` above. Which tools a
   * reader wants at hand is a real preference and lives in shell/navPrefs; a
   * drawer that reopened itself on every launch would make pinning pointless,
   * because the pinned list would only ever be the top of a list that is
   * always fully expanded anyway. */
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onSkinLayout = (event: Event) => {
      const detail = (event as CustomEvent<SkinLayoutDetail>).detail;
      if (!detail?.layout) return;
      if (!detail.enabled) {
        const previous = preSkinRatios.current;
        preSkinRatios.current = null;
        setSkinPaneGap(5);
        if (previous) setRatios(previous);
        return;
      }
      setRatios((current) => {
        if (!preSkinRatios.current) preSkinRatios.current = { ...current };
        return skinRatios(detail.layout, window.innerWidth);
      });
      setSkinPaneGap(bound(detail.layout.paneGap, 0, 24));
    };
    window.addEventListener("arcelle-skin-layout", onSkinLayout);
    return () => window.removeEventListener("arcelle-skin-layout", onSkinLayout);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(RAIL_NARROW_QUERY);
    const onChange = () => setRailAutoCollapsed(mq.matches);
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

  const { showSplitA, showSplitB } = splitterVisibility(visible);

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
      "--split-a": showSplitA ? `${skinPaneGap}px` : "0px",
      "--split-b": showSplitB ? `${skinPaneGap}px` : "0px",
    } as CSSProperties;
  }, [visible, ratios, showSplitA, showSplitB, skinPaneGap]);

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

  /** Show or hide one of the two SIDE panes.
   *
   * The centre is not in this signature, and that is the redesign's second
   * decision expressed as a type. The workspace is what the room is for; it
   * used to sit in a row of three identical toggles as though hiding it were
   * an equivalent move to hiding a sidebar, and hiding it left a window with
   * nothing in it. Focus mode (below) still gets the workspace the full width
   * — by taking the SIDES away, which is the outcome anyone reaching for
   * "hide the workspace" actually wanted.
   *
   * In narrow mode there is only ever one pane on screen, so this MOVES the
   * single slot: asking for the assistant shows it, asking again hands the
   * window back to the workspace. Without that second half a narrow window
   * could reach the assistant and never leave it, now that no control exists
   * to ask for the centre by name. */
  const togglePane = useCallback(
    (key: SidePane) => {
      if (key === "ai") noteAiChoice();
      if (isNarrow) {
        setHidden((h) => ({ ...h, [key]: false }));
        setFocusPane((f) => (f === key ? "center" : key));
        return;
      }
      if (focusPane) {
        // Asking for a side pane while focused means "come out of focus and
        // give me this" — not "focus this instead", which would swap one
        // single-pane view for another and read as the click doing nothing.
        setFocusPane(null);
        setHidden((h) => ({ ...h, [key]: false }));
        return;
      }
      setHidden((h) => ({ ...h, [key]: !h[key] }));
    },
    [isNarrow, focusPane, noteAiChoice],
  );

  /** Apply a named preset — the Layout menu's three one-click layouts and the
   * default new rooms open in. Idempotent: ratios are restated, not nudged,
   * so applying the same preset twice lands in exactly the same place however
   * the splitters had been dragged in between. */
  const applyPreset = useCallback(
    (name: PresetName) => {
      const p = PRESETS[name];
      setRatios({ ...p.ratios });
      setHidden({ ...p.hidden });
      setFocusPane(null);
      // A preset is the user stating what they want on screen, so it settles
      // the step-aside question the same way clicking the pane would — else
      // choosing Research and then opening a PDF would immediately undo the
      // assistant column the preset had just asked for.
      noteAiChoice();
      if (p.hidden.ai) setAiSteppedAside(false);
    },
    [noteAiChoice],
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
    // The PREFERENCE goes back to labels. Whether they actually appear is
    // still the window's business (`railAutoCollapsed`) — Reset must not be
    // able to force words into a rail too narrow to hold them.
    setRailExpanded(true);
    // Reset means "start again from the defaults", and the focused-page
    // suggestion is one of them — so it is re-armed rather than left disabled
    // by whatever the user happened to click before pressing Reset.
    aiChoiceRef.current = false;
    focusedRef.current = false;
    setAiSteppedAside(false);
  }, []);

  const toggleRail = useCallback(() => setRailExpanded((v) => !v), []);
  const toggleMoreTools = useCallback(() => setMoreToolsOpen((v) => !v), []);

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
    (side: "a" | "b", nextEdge: number) => {
      setRatios((r) => {
        const next = { ...r };
        if (side === "a") {
          // The library always trades with the centre. It used to have a
          // second branch for trading with the AI pane instead, for when the
          // centre was collapsed — a state that can no longer exist, and that
          // a splitter could never have been dragged in anyway: a splitter is
          // only drawn between two VISIBLE panes.
          const pair = next.library + next.center;
          const lib = bound(
            nextEdge,
            CLAMP.library.min,
            Math.min(CLAMP.library.max, pair - CLAMP.centerMin),
          );
          next.library = lib;
          next.center = pair - lib;
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
      const move = (ev: globalThis.PointerEvent) => {
        const rect = grid.getBoundingClientRect();
        if (rect.width <= 0) return;
        const edge =
          side === "a"
            ? (ev.clientX - rect.left) / rect.width
            : (rect.right - ev.clientX) / rect.width;
        applyResize(side, edge);
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
      applyResize(side, side === "a" ? ratios.library + amount : ratios.ai - amount);
    },
    [applyResize, ratios],
  );

  // ⌘/Ctrl+3 shows and hides the assistant; Escape leaves focus mode. Capture
  // phase so the focus-Escape wins over the workspace's close-file Escape.
  //
  // ⌘1 and ⌘2 used to be handled here too and are now the native View menu's
  // (see PANE_KEYS). What is left is the alias no menu row can carry. The
  // claim is still settled here (capture + stopPropagation) so a second
  // handler can never also act on the same press; tab-by-position lives on
  // ⌥⌘1–⌥⌘9, which is why Option is excluded below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const pane = paneShortcut(e);
      if (pane) {
        e.preventDefault();
        e.stopPropagation();
        togglePane(pane);
        return;
      }
      if (leavesFocus(e, focusPane)) {
        e.preventDefault();
        e.stopPropagation();
        setFocusPane(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePane, focusPane]);

  /** What the status bar says the layout is.
   *
   * Narrow mode is called out separately because `focusPane` does double duty
   * there — it holds WHICH single pane is showing, not a mode the reader chose
   * — so the plain branch below announced "Editor focus" to someone who had
   * simply pressed Assistant and pressed it again. Nobody focused anything;
   * the window is only wide enough for one pane. */
  // "Sidebar", not "Library": this names the PANE, and what is in that pane
  // depends on the destination. The status bar cannot know which one, and
  // guessing Home's answer is what it used to do.
  const layoutLabel = layoutStatusLabel(isNarrow, focusPane, visible.length);

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
    /** What the sidebar SHOWS. The stored preference, less any collapse the
     * window width is imposing — every consumer reads this and no consumer
     * reads the preference, so the two can never be confused. */
    railExpanded: railExpanded && !railAutoCollapsed,
    /** What the reader CHOSE, which is what storage holds. Only the two
     * surfaces that describe the preference itself (the rail's own expander,
     * and Settings → Interface) have any business with this. */
    railExpandedPref: railExpanded,
    /** Whether the window — not the reader — is what took the labels away.
     * The expander hides while this is true: a control that cannot change
     * anything is worse than no control. */
    railAutoCollapsed,
    toggleRail,
    moreToolsOpen,
    toggleMoreTools,
    gridRef,
    gridStyle,
    showSplitA,
    showSplitB,
    layoutLabel,
    togglePane,
    applyPreset,
    toggleFocus,
    showPane,
    collapsePane,
    setFocusedPage,
    resetLayout,
    startDrag,
    keyResize,
  };
}
