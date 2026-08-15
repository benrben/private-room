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

/** The panes that can be shown and hidden. The centre cannot: it is the one
 * pane the room is always for, and the Layout menu offers Focus instead —
 * see `togglePane`. */
export type SidePane = Exclude<PaneKey, "center">;

export const PANE_ORDER: PaneKey[] = ["library", "center", "ai"];

/** ⌘-number → the pane it shows or hides — the ONE key this file still claims.
 *
 * ⌘1 and ⌘2 are not here. They are declared by the native View menu
 * (src-tauri/src/menu.rs), which is the right owner for them: macOS hands a
 * key equivalent to the menu bar before the event reaches the key window, so a
 * listener here could only ever be a second owner for the same press — and a
 * pane toggled twice is a pane that never moves. The menu also prints them,
 * which is the whole reason a Mac user opens a menu they already know the
 * contents of.
 *
 * ⌘3 stays, because no menu row can express it: it is an ALIAS for ⌘2, and a
 * row carries one key equivalent. It is not a shim anyone has to maintain —
 * it is the binding this app has always had, left alone for at least one
 * release so nobody's hands have to relearn anything. When it goes, this
 * whole map goes with it. */
export const PANE_KEYS: Record<string, SidePane> = {
  "3": "ai",
};

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
 * pane at a time and the pane controls switch instead of toggle. */
const NARROW_QUERY = "(max-width: 1080px)";

/** Below this the sidebar drops its labels on its own.
 *
 * Deliberately NOT the same breakpoint as NARROW_QUERY. Firing both at one
 * width would take the labels and two of the three panes away in the same
 * frame, which reads as the window breaking rather than as the shell adapting;
 * 1180 gives the rail a step of its own on the way down. */
const RAIL_NARROW_QUERY = "(max-width: 1180px)";

/** The three shipped layout presets, and what each is FOR.
 *
 * A preset is not a fourth kind of state — it is a named set of the choices
 * the Layout menu already offers one at a time, applied together. That is the
 * whole reason they exist: "get out of the way so I can read this" is three
 * clicks (hide library, hide assistant, widen) that nobody performs, so the
 * layout stays wrong instead.
 *
 * Ratios are re-stated per preset rather than inherited, so applying one is
 * idempotent — running Review twice lands in exactly the same place, whatever
 * the panes had been dragged to in between. */
export type PresetName = "focus" | "research" | "review";

export const PRESETS: Record<
  PresetName,
  { label: string; hint: string; hidden: Record<PaneKey, boolean>; ratios: Record<PaneKey, number> }
> = {
  focus: {
    label: "Focus",
    hint: "The workspace alone",
    hidden: { library: true, center: false, ai: true },
    ratios: { library: 0.16, center: 0.61, ai: 0.23 },
  },
  research: {
    label: "Research",
    hint: "Library, workspace, and the assistant",
    hidden: { library: false, center: false, ai: false },
    ratios: { library: 0.16, center: 0.61, ai: 0.23 },
  },
  review: {
    label: "Review",
    hint: "Library and workspace, no assistant",
    hidden: { library: false, center: false, ai: true },
    // A wider library than the default (26% of the visible width once the
    // assistant is out, against 21%), because reviewing means moving between
    // files rather than staying in one.
    //
    // THE THREE MUST SUM TO 1, including the pane this preset hides. A hidden
    // pane's track is 0px, so its ratio looks free — but `applyResize` holds
    // the SUM of a splitter's two panes constant and compares a pointer
    // position (a fraction of the whole grid) against a pane's ratio directly.
    // Both stop being true if the ratios drift off 1, and the drift only shows
    // up later: apply Review, reopen the assistant, and every pane is the
    // wrong width with the centre floor silently breached.
    ratios: { library: 0.2, center: 0.57, ai: 0.23 },
  },
};

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
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        PANE_KEYS[e.key] !== undefined
      ) {
        e.preventDefault();
        e.stopPropagation();
        togglePane(PANE_KEYS[e.key]);
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

  /** What the status bar says the layout is.
   *
   * Narrow mode is called out separately because `focusPane` does double duty
   * there — it holds WHICH single pane is showing, not a mode the reader chose
   * — so the plain branch below announced "Editor focus" to someone who had
   * simply pressed Assistant and pressed it again. Nobody focused anything;
   * the window is only wide enough for one pane. */
  const paneName =
    focusPane === "ai" ? "Assistant" : focusPane === "library" ? "Library" : "Workspace";
  const layoutLabel = isNarrow
    ? paneName
    : focusPane
      ? `${paneName} focus`
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
