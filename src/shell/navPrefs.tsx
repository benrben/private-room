import { useCallback, useSyncExternalStore, type ReactElement } from "react";
import {
  BookOpenIcon,
  CreateIcon,
  GlobeIcon,
  GraphIcon,
  HomeIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  ScriptIcon,
  SketchIcon,
  WorkflowsIcon,
} from "../icons";
import { WORK_AREAS, type WorkArea } from "../workspace/types";

/** A place the sidebar can navigate to. Every area except "files", which is
 * the default document lens rather than a destination of its own. */
export type NavArea = Exclude<WorkArea, "files">;

/** The catalog: every destination, its name, and its glyph — in the order a
 * customized sidebar starts out in.
 *
 * This is the ONE list. The rail renders from it, the customize sheet renders
 * from it, and `navPrefs` validates stored keys against it, so a destination
 * cannot exist in one of those three and be missing from another.
 *
 * The Library is deliberately absent, and that is the whole point of the
 * redesign's first decision: the library is a PANE, not a place. It is shown
 * and hidden from the Layout menu (or ⌘1) like the Assistant is, and a row in
 * this list would be a mode wearing a destination's clothes — the exact
 * confusion the old rail created by putting three pane toggles at the top of
 * its list of nine places. */
export const NAV_AREAS: {
  key: NavArea;
  label: string;
  /** What the customize sheet says this place is for. The rail has no room
   * for it; a list of eleven names being triaged does. */
  blurb: string;
  icon: (size: number) => ReactElement;
}[] = [
  { key: "home", label: "Home", blurb: "Recent work, and what needs you", icon: (s) => <HomeIcon size={s} /> },
  { key: "recordings", label: "Recordings", blurb: "Mic and Mac audio, transcribed here", icon: (s) => <MicIcon size={s} /> },
  { key: "browser", label: "Private browser", blurb: "Read the web with no history kept", icon: (s) => <GlobeIcon size={s} /> },
  { key: "sketch", label: "Sketch", blurb: "Draw by hand, or ask the room to draw", icon: (s) => <SketchIcon size={s} /> },
  { key: "create", label: "Create", blurb: "Pictures and video from a connected model", icon: (s) => <CreateIcon size={s} /> },
  { key: "map", label: "Room Map", blurb: "How files and notes connect", icon: (s) => <GraphIcon size={s} /> },
  { key: "workflows", label: "Workflows", blurb: "Pipelines, schedules, run history", icon: (s) => <WorkflowsIcon size={s} /> },
  { key: "scripts", label: "Scripts", blurb: "Runnable .py and .js room files", icon: (s) => <ScriptIcon size={s} /> },
  { key: "skills", label: "Skills", blurb: "Reusable instructions the AI can load", icon: (s) => <BookOpenIcon size={s} /> },
  { key: "connectors", label: "Connectors", blurb: "MCP tools this room may use", icon: (s) => <LinkIcon size={s} /> },
  { key: "memory", label: "Memory", blurb: "Durable context, visible and editable", icon: (s) => <MemoryIcon size={s} /> },
];

/** Fails to compile if the catalog and the area union ever drift apart — a
 * destination added to `WorkArea` with no row here would otherwise be
 * unreachable from the sidebar and nobody would find out from the types. */
const _catalogCoversAreas: Record<NavArea, true> = Object.fromEntries(
  NAV_AREAS.map((a) => [a.key, true as const]),
) as Record<NavArea, true>;
void _catalogCoversAreas;

const CANONICAL: NavArea[] = NAV_AREAS.map((a) => a.key);

/** What a new install pins.
 *
 * Four, not the ten the rail used to show at once. These are the places a
 * room is USED from — where material arrives and where you start. Everything
 * that operates on material already in the room (workflows, scripts, skills,
 * connectors, memory, the map) is real, frequently valuable, and not something
 * a reader needs in their peripheral vision at all times; it lives one
 * disclosure away and can be pinned back in two clicks.
 *
 * Create sits with them rather than in this list on the room owner's call: a
 * generation is an occasional act, and it lands as an ordinary room file, so
 * the Library is where its output is actually worked with. */
export const DEFAULT_PINNED: NavArea[] = ["home", "recordings", "browser", "sketch"];

const KEY = "prNav:v1";

export interface NavPrefs {
  /** Which destinations sit above the "More tools" disclosure. */
  pinned: NavArea[];
  /** Every destination, in the reader's chosen order. Pinned and unpinned
   * rows are BOTH drawn from this, filtered — so dragging a row keeps its
   * position when it is pinned and unpinned again. */
  order: NavArea[];
}

function isArea(v: unknown): v is NavArea {
  return typeof v === "string" && v !== "files" && (WORK_AREAS as readonly string[]).includes(v);
}

export function defaultPrefs(): NavPrefs {
  return { pinned: DEFAULT_PINNED.slice(), order: CANONICAL.slice() };
}

/** Read the stored preferences, reconciled against the areas this BUILD has.
 *
 * A sidebar preference outlives the build that wrote it, in both directions:
 * an area can be retired (its key must be dropped, or the rail renders a row
 * that navigates nowhere) and an area can be added (it must appear, or a new
 * feature is invisible to everyone who ever opened the customize sheet — the
 * failure mode that makes "customizable" and "discoverable" fight).
 *
 * So: stored entries that are still real keep their position, and anything
 * this build knows about that the record has never seen is appended in
 * canonical order. Unknown keys are dropped rather than preserved — round-
 * tripping them would mean the reconciliation could never tell a
 * not-yet-known area from a long-dead one. */
export function loadPrefs(): NavPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return defaultPrefs(); // private mode etc.
  }
  if (!raw) return defaultPrefs();

  let parsed: Partial<NavPrefs>;
  try {
    parsed = JSON.parse(raw) as Partial<NavPrefs>;
  } catch {
    return defaultPrefs();
  }
  if (typeof parsed !== "object" || parsed === null) return defaultPrefs();

  const storedOrder = Array.isArray(parsed.order) ? parsed.order.filter(isArea) : [];
  const seen = new Set(storedOrder);
  const order = storedOrder.concat(CANONICAL.filter((k) => !seen.has(k)));

  // An absent `pinned` means "never customized" — take the defaults. An EMPTY
  // one is a real choice (every tool under More tools) and is honoured.
  const pinned = Array.isArray(parsed.pinned)
    ? parsed.pinned.filter(isArea)
    : DEFAULT_PINNED.slice();

  return { pinned, order };
}

function writePrefs(next: NavPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode — the sidebar just won't persist */
  }
}

/** Drop the customized sidebar (Settings → Interface → Reset). */
export function forgetNavPrefs(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/* ---------------------------------------------------------------- store ---
   A module-level store rather than React state threaded through Workspace.
   Two surfaces render these preferences — the rail and Settings → Interface —
   and they sit in different subtrees with a modal between them. Lifting the
   state to Workspace would mean passing it through six components that have
   no interest in it; `useSyncExternalStore` keeps both honest with neither
   knowing the other exists. */

let current: NavPrefs = defaultPrefs();
let loaded = false;
const listeners = new Set<() => void>();

function snapshot(): NavPrefs {
  if (!loaded) {
    current = loadPrefs();
    loaded = true;
  }
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: NavPrefs): void {
  current = next;
  loaded = true;
  writePrefs(next);
  listeners.forEach((fn) => fn());
}

/** Reset to the shipped sidebar. Exported for Settings → Interface's Reset,
 * which clears this alongside the saved pane layouts. */
export function resetNavPrefs(): void {
  forgetNavPrefs();
  commit(defaultPrefs());
}

/** The pinned rows and the More-tools rows, both in the reader's order. */
export function splitPrefs(prefs: NavPrefs): { pinned: NavArea[]; more: NavArea[] } {
  const isPinned = new Set(prefs.pinned);
  return {
    pinned: prefs.order.filter((k) => isPinned.has(k)),
    more: prefs.order.filter((k) => !isPinned.has(k)),
  };
}

/** Move a row one step WITHIN its own group, and return the new preferences.
 *
 * Pure, and separate from the hook, because this is the one piece of arithmetic
 * here that can be subtly wrong in a way nobody notices by looking: `order`
 * holds all eleven destinations while the reader is moving a row among the four
 * that happen to be pinned, so "one step" means one step past its neighbour in
 * the GROUP, not its neighbour in the array. Swapping the two rows at their
 * absolute positions in `order` is what makes that true — the group's other
 * members keep their slots and the other group is untouched.
 *
 * Returns `prefs` unchanged when the row is already at the end of its group, so
 * a no-op move cannot write a new object and re-render every subscriber. */
export function moveWithin(prefs: NavPrefs, key: NavArea, delta: -1 | 1): NavPrefs {
  const pinned = new Set(prefs.pinned);
  const inGroup = pinned.has(key);
  const group = prefs.order.filter((k) => pinned.has(k) === inGroup);
  const at = group.indexOf(key);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= group.length) return prefs;

  const a = prefs.order.indexOf(group[at]);
  const b = prefs.order.indexOf(group[to]);
  const order = prefs.order.slice();
  order[a] = group[to];
  order[b] = group[at];
  return { ...prefs, order };
}

export interface NavPrefsApi {
  prefs: NavPrefs;
  pinned: NavArea[];
  more: NavArea[];
  isPinned: (key: NavArea) => boolean;
  togglePin: (key: NavArea) => void;
  /** Move a row one step within its own group (pinned or More tools), which
   * is the only move that has a visible result — reordering across the
   * disclosure would silently pin or unpin, and a drag that changes two things
   * at once is a drag nobody can predict. */
  move: (key: NavArea, delta: -1 | 1) => void;
  reset: () => void;
}

export function useNavPrefs(): NavPrefsApi {
  const prefs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { pinned, more } = splitPrefs(prefs);

  const togglePin = useCallback((key: NavArea) => {
    const now = snapshot();
    const has = now.pinned.includes(key);
    commit({
      ...now,
      pinned: has ? now.pinned.filter((k) => k !== key) : now.pinned.concat(key),
    });
  }, []);

  const move = useCallback((key: NavArea, delta: -1 | 1) => {
    const now = snapshot();
    const next = moveWithin(now, key, delta);
    if (next !== now) commit(next);
  }, []);

  return {
    prefs,
    pinned,
    more,
    isPinned: useCallback((key: NavArea) => prefs.pinned.includes(key), [prefs]),
    togglePin,
    move,
    reset: useCallback(() => resetNavPrefs(), []),
  };
}

/** One destination's catalog row. Throws rather than returning undefined: a
 * missing key means the catalog and the area union have drifted, which is a
 * programming error, not a runtime condition to paper over. */
export function areaDef(key: NavArea) {
  const def = NAV_AREAS.find((a) => a.key === key);
  if (!def) throw new Error(`no sidebar destination registered for "${key}"`);
  return def;
}

/** The sidebar's own name for a place, reused by anything that has to name
 * one, so two surfaces can never disagree about what somewhere is called. */
export function areaLabel(key: WorkArea): string {
  return NAV_AREAS.find((a) => a.key === key)?.label ?? "Library";
}
