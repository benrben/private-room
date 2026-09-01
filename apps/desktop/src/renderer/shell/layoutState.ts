/** The three workspace panes. "library" = left (files/sources/area nav),
 * "center" = the primary work surface, "ai" = chat/studio/activity. */
export type PaneKey = "library" | "center" | "ai";

/** The panes that can be shown and hidden. The centre cannot: it is the one
 * pane the room is always for, and the Layout menu offers Focus instead. */
export type SidePane = Exclude<PaneKey, "center">;

export const PANE_ORDER: PaneKey[] = ["library", "center", "ai"];

/** ⌘-number → the pane it shows or hides. ⌘1 and ⌘2 belong to the
 * native View menu; ⌘3 remains the alias that no menu row can carry. */
export const PANE_KEYS: Record<string, SidePane> = {
  "3": "ai",
};

/** Default proportions (16 / 61 / 23): one dominant workspace, with the
 * library a navigable strip and the AI pane a contextual column. */
export const DEFAULT_RATIOS: Record<PaneKey, number> = {
  library: 0.16,
  center: 0.61,
  ai: 0.23,
};

/** Drag/keyboard clamps keep side panes usable and protect the centre. */
export const CLAMP = {
  library: { min: 0.13, max: 0.5 },
  ai: { min: 0.2, max: 0.42 },
  centerMin: 0.4,
};

/** Below this the shell shows one pane at a time. */
export const NARROW_QUERY = "(max-width: 1080px)";

/** The sidebar drops its labels before the shell becomes single-pane. */
export const RAIL_NARROW_QUERY = "(max-width: 1180px)";

export type PresetName = "focus" | "research" | "review";

/** Named combinations of the same pane choices exposed by the Layout menu. */
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
    hint: "Sidebar, workspace, and the assistant",
    hidden: { library: false, center: false, ai: false },
    ratios: { library: 0.16, center: 0.61, ai: 0.23 },
  },
  review: {
    label: "Review",
    hint: "Sidebar and workspace, no assistant",
    // The three ratios still sum to one while the assistant is hidden because
    // resize math holds each splitter pair's combined share constant.
    hidden: { library: false, center: false, ai: true },
    ratios: { library: 0.2, center: 0.57, ai: 0.23 },
  },
};

export type PersistedLayout = {
  ratios?: Partial<Record<PaneKey, number>>;
  hidden?: Partial<Record<PaneKey, boolean>>;
  railExpanded?: boolean;
  v?: number;
};

/** v2 made the rail's readable labels the default. */
export const LAYOUT_VERSION = 2;

const LAYOUT_PREFIX = "prLayout:";

/** Hash the room path so browser storage reveals neither names nor collisions
 * between rooms with the same display name. */
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

/** Drop every saved room layout. */
export function forgetSavedLayouts(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LAYOUT_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* private mode etc. — nothing was stored to forget */
  }
}

/** Drop one room's saved layout. */
export function forgetSavedLayout(roomPath: string): void {
  try {
    localStorage.removeItem(layoutKey(roomPath));
  } catch {
    /* nothing stored */
  }
}

/** Remove pre-digest entries, which contain room names in plain storage. */
function sweepLegacyLayoutKeys(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LAYOUT_PREFIX) && !/^prLayout:[0-9a-f]{16}$/.test(key)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode etc. */
  }
}

export function loadPersistedLayout(key: string): PersistedLayout {
  sweepLegacyLayoutKeys();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedLayout;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function splitterVisibility(visible: PaneKey[]) {
  return {
    showSplitA:
      visible.includes("library") &&
      (visible.includes("center") || visible.includes("ai")),
    showSplitB: visible.includes("center") && visible.includes("ai"),
  };
}

export function paneShortcut(event: KeyboardEvent): SidePane | null {
  if (!hasPrimaryModifier(event)) return null;
  if (hasOtherModifier(event)) return null;
  return PANE_KEYS[event.key] ?? null;
}

function hasPrimaryModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function hasOtherModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.shiftKey;
}

export function leavesFocus(event: KeyboardEvent, focusPane: PaneKey | null): boolean {
  if (event.key !== "Escape" || !focusPane) return false;
  const target = event.target as HTMLElement | null;
  return target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA";
}

export function layoutStatusLabel(
  isNarrow: boolean,
  focusPane: PaneKey | null,
  visibleCount: number,
): string {
  const paneName = focusedPaneName(focusPane);
  if (isNarrow) return paneName;
  if (focusPane) return `${paneName} focus`;
  return `${visibleCount} pane${visibleCount === 1 ? "" : "s"}`;
}

function focusedPaneName(focusPane: PaneKey | null): string {
  if (focusPane === "ai") return "Assistant";
  if (focusPane === "library") return "Sidebar";
  return "Workspace";
}

export function clampRatio(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0.05 && v < 0.95
    ? v
    : fallback;
}

/** Clamp into [lo, hi]. If hi falls below lo, the minimum wins. */
export function bound(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
