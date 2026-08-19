import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

/** What a tab points at.
 *
 * ROOM DOCUMENTS, and only room documents. This list used to hold three kinds
 * at once — files, places and private-browser pages — which is what made one
 * strip show a spreadsheet, a sketch, a recording and three web pages side by
 * side above every surface in the app. Places became the rail's business; pages
 * became the Browser destination's own typed state (workspace/browserPages.ts),
 * where they can be listed vertically, in one destination, and never written
 * down.
 *
 * `area` survives as a LEGACY value only: rooms saved before places stopped
 * being tabs still have `area:*` rows in their settings, and they are pruned on
 * the tick after they are read back. Nothing mints one. */
export type TabKind = "file" | "area";

export interface Tab {
  /** `kind:ref`. Identity IS the pair, so opening the same thing twice focuses
   * the existing tab instead of stacking duplicates. */
  id: string;
  kind: TabKind;
  /** File id, or (legacy) a `WorkArea` key. */
  ref: string;
  title: string;
}

export const tabId = (kind: TabKind, ref: string): string => `${kind}:${ref}`;

/** Room setting holding the durable tabs. Room-scoped, so it rides the room's
 * own encryption and never leaks between rooms. */
const TABS_SETTING = "workspace_tabs";

/** What is worth writing into the room's settings. Every remaining kind is —
 * the one kind that never was (a private page) is not in this list any more.
 * Kept as a named predicate because it is the persistence boundary, and a
 * boundary with a name is one a reader can check. */
const isDurable = (tab: Tab): boolean => tab.kind === "file" || tab.kind === "area";

export interface TabsApi {
  tabs: Tab[];
  activeId: string;
  active: Tab | null;
  /** Whether the saved tabs have been read back for the current room.
   *
   * The shell waits on this before restoring the area the room was left in:
   * that restore closes the open file, so racing it against a file tab still
   * being restored would silently undo the restore. */
  restored: boolean;
  /** Focus the tab for `kind:ref`, creating it if this is the first time. */
  open: (kind: TabKind, ref: string, title: string) => void;
  close: (id: string) => void;
  activate: (id: string) => void;
  /** Retitle in place — a page's `<title>` and a renamed file both land here. */
  retitle: (id: string, title: string) => void;
  move: (from: number, to: number) => void;
  /** Relative move through the strip, wrapping at both ends. */
  step: (delta: number) => void;
  /** ⌥⌘1–⌥⌘8 pick by position; ⌥⌘9 is last, as every browser does it. Option
   * is part of it because plain ⌘1/⌘2 belong to the native View menu's pane
   * toggles (src-tauri/src/menu.rs). */
  activateIndex: (index: number) => void;
  /** Drop tabs whose target no longer EXISTS — a trashed file. What the reader
   * was looking at is gone, so the neighbour takes the empty pane. */
  prune: (keep: (tab: Tab) => boolean) => void;
  /** Drop tabs the strip should no longer LIST, without touching what is on
   * screen. Different act, different name: a file removed from the Library is
   * still open, still fine, and still the thing the reader is working on —
   * only Home has stopped listing it. Electing a neighbour here navigated the
   * workspace to an unrelated document at the exact moment the user said "stop
   * showing this one in Home", which reads as the demotion having closed it. */
  unlist: (keep: (tab: Tab) => boolean) => void;
}

/** Where the selection lands when tabs are dropped.
 *
 * `heirOf` is the whole difference between the two drops above, so it is a
 * named rule passed in rather than a flag read inside — the caller states which
 * act it is performing and the consequence follows from that. */
export function selectionAfterDrop(
  remaining: Tab[],
  current: string,
  heirOf: (remaining: Tab[]) => string,
): string {
  if (remaining.some((t) => t.id === current)) return current;
  // Nothing was selected to begin with — the reader is on an area, not a file.
  // Dropping a tab they were not looking at must not yank them into one. This
  // is how the legacy `area:*` tabs used to hijack the restore: dropping them
  // fell through to the last file tab and the apply effect navigated there,
  // overwriting the restored area in the same tick.
  if (!current) return "";
  return heirOf(remaining);
}

/** The last surviving tab — what a trashed document hands the pane to. */
export const heirOfLast = (remaining: Tab[]): string =>
  remaining[remaining.length - 1]?.id ?? "";

/** Nothing at all. The strip stops pointing anywhere and the workspace keeps
 * showing whatever it was showing. */
export const heirOfNothing = (): string => "";

/** The workspace's open tabs: an ordered list and which one is showing.
 *
 * Deliberately knows nothing about files, areas or the browser — it owns a
 * list. Whether a switch is *allowed* (unsaved edits) is the shell's call, not
 * this hook's, so the two concerns can be read and tested apart. */
export function useTabs(roomName: string): TabsApi {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  //: Nothing is written until the saved tabs have been read back, or the first
  //: render would persist an empty list over the user's real one.
  const loaded = useRef(false);
  //: The same fact as `loaded`, but as state, so the shell can WAIT for the
  //: restore instead of racing it. Restoring the area the room was left in has
  //: to happen after this: showArea() closes the open file, so running it
  //: while a file tab was still being restored would undo the restore.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    setRestored(false);
    void (async () => {
      const raw = (await api.getSetting(TABS_SETTING).catch(() => "")) ?? "";
      if (cancelled) return;
      const saved = parseTabs(raw);
      if (saved.tabs.length) {
        setTabs(saved.tabs);
        // `?? `, not `|| ` — see parseTabs. A recorded empty string means the
        // reader deliberately left the room on an area rather than a file, and
        // must NOT be overridden with tabs[0].
        setActiveId(saved.activeId ?? saved.tabs[0].id);
      }
      loaded.current = true;
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
    // Re-reads when the room changes: tabs belong to a room, not to the window.
  }, [roomName]);

  useEffect(() => {
    if (!loaded.current) return;
    const durable = tabs.filter(isDurable);
    const active = durable.some((t) => t.id === activeId) ? activeId : "";
    void api
      .setSetting(TABS_SETTING, JSON.stringify({ tabs: durable, activeId: active }))
      .catch(() => {
        /* losing the tab list is a cosmetic failure; never disturb the room */
      });
  }, [tabs, activeId]);

  const open = useCallback((kind: TabKind, ref: string, title: string) => {
    const id = tabId(kind, ref);
    setTabs((prev) => {
      const at = prev.findIndex((t) => t.id === id);
      if (at < 0) return [...prev, { id, kind, ref, title }];
      // Re-opening carries the CURRENT title. Titles used to be fixed at
      // creation, so a renamed file kept its old name on its tab for the rest
      // of the session.
      if (prev[at].title === title) return prev;
      const next = [...prev];
      next[at] = { ...next[at], title };
      return next;
    });
    setActiveId(id);
  }, []);

  const close = useCallback((id: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      if (index < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveId((current) => {
        if (current !== id) return current;
        // The neighbour to the right, else the left — what every editor does,
        // and it keeps a rapid close-close-close from jumping around.
        const heir = next[index] ?? next[index - 1];
        return heir ? heir.id : "";
      });
      return next;
    });
  }, []);

  const retitle = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.title !== title ? { ...t, title } : t)),
    );
  }, []);

  const move = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from === to || from < 0 || to < 0) return prev;
      if (from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const step = useCallback((delta: number) => {
    setTabs((prev) => {
      if (prev.length < 2) return prev;
      setActiveId((current) => {
        const at = prev.findIndex((t) => t.id === current);
        const next = (at + delta + prev.length) % prev.length;
        return prev[next].id;
      });
      return prev;
    });
  }, []);

  const activateIndex = useCallback((index: number) => {
    setTabs((prev) => {
      const pick = index >= 8 ? prev[prev.length - 1] : prev[index];
      if (pick) setActiveId(pick.id);
      return prev;
    });
  }, []);

  const drop = useCallback(
    (keep: (tab: Tab) => boolean, heirOf: (remaining: Tab[]) => string) => {
      setTabs((prev) => {
        const next = prev.filter(keep);
        if (next.length === prev.length) return prev;
        setActiveId((current) => selectionAfterDrop(next, current, heirOf));
        return next;
      });
    },
    [],
  );

  const prune = useCallback(
    (keep: (tab: Tab) => boolean) => drop(keep, heirOfLast),
    [drop],
  );
  const unlist = useCallback(
    (keep: (tab: Tab) => boolean) => drop(keep, heirOfNothing),
    [drop],
  );

  return {
    tabs,
    activeId,
    restored,
    active: tabs.find((t) => t.id === activeId) ?? null,
    open,
    close,
    activate: setActiveId,
    retitle,
    move,
    step,
    activateIndex,
    prune,
    unlist,
  };
}

/** Saved tabs, or nothing. A malformed or half-written setting must open the
 * room with no tabs rather than throw on the way in.
 *
 * `activeId` is `undefined` when the payload carried no record at all, and the
 * empty STRING when it recorded that nothing was selected. The two are not the
 * same and collapsing them was a real bug: since areas stopped being tabs, the
 * persist effect writes `activeId: ""` every time the reader is on Home, Find,
 * the Room Map or Memory. Treating that as "no record" and falling back to
 * `tabs[0]` reopened the room on the OLDEST surviving file tab — a file the
 * reader might not have touched in weeks. */
function parseTabs(raw: string): { tabs: Tab[]; activeId: string | undefined } {
  const empty = { tabs: [] as Tab[], activeId: undefined };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs)) return empty;
    return {
      tabs: tabs.filter(isTab).filter(isDurable),
      activeId: typeof activeId === "string" ? activeId : undefined,
    };
  } catch {
    return empty;
  }
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.ref === "string" &&
    typeof t.title === "string" &&
    (t.kind === "file" || t.kind === "area")
  );
}
