import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

/** What a tab points at.
 *
 * `page` is a private-browser page and is deliberately NEVER persisted: the
 * browser's whole claim is that it writes no history to disk, and a restored
 * list of visited URLs is a history file wearing a different hat (owner
 * decision 2026-07-31). */
export type TabKind = "file" | "area" | "page";

export interface Tab {
  /** `kind:ref`. Identity IS the pair, so opening the same thing twice focuses
   * the existing tab instead of stacking duplicates. */
  id: string;
  kind: TabKind;
  /** File id, `WorkArea` key, or private-browser page id. */
  ref: string;
  title: string;
}

export const tabId = (kind: TabKind, ref: string): string => `${kind}:${ref}`;

/** Room setting holding the durable tabs. Room-scoped, so it rides the room's
 * own encryption and never leaks between rooms. */
const TABS_SETTING = "workspace_tabs";

const isDurable = (tab: Tab): boolean => tab.kind !== "page";

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
  /** ⌘1–⌘8 pick by position; ⌘9 is last, as every browser does it. */
  activateIndex: (index: number) => void;
  /** Drop tabs whose target no longer exists (a deleted file, a closed page). */
  prune: (keep: (tab: Tab) => boolean) => void;
}

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

  const prune = useCallback((keep: (tab: Tab) => boolean) => {
    setTabs((prev) => {
      const next = prev.filter(keep);
      if (next.length === prev.length) return prev;
      setActiveId((current) => {
        if (next.some((t) => t.id === current)) return current;
        // Nothing was selected to begin with — the reader is on an area, not a
        // file. Pruning a tab they were not looking at must not yank them into
        // one. This is how the legacy `area:*` tabs used to hijack the restore:
        // dropping them fell through to the last file tab and the apply effect
        // navigated there, overwriting the restored area in the same tick.
        if (!current) return "";
        return next[next.length - 1]?.id ?? "";
      });
      return next;
    });
  }, []);

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
    (t.kind === "file" || t.kind === "area" || t.kind === "page")
  );
}
