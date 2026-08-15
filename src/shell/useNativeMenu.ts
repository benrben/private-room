import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LayoutApi } from "./useLayout";

/** The native View menu, wired to this room's layout.
 *
 * Two directions, and they are deliberately different shapes:
 *
 *   • ACTIONS come in as one event carrying a row id (src-tauri/src/menu.rs
 *     raises `menu-action` for every row), and this map is the only place that
 *     knows what each id means. One object, so "is every row handled?" is a
 *     question a reader — and nativeMenu.test.mjs — can answer by looking.
 *   • STATE goes out whole, on every change. The menu bar is not part of this
 *     window, so nothing else can keep it honest; if the ticks drifted there
 *     would be no render to correct them.
 *
 * The listener is registered ONCE and reaches the current layout through a
 * ref. Re-registering per render costs two IPC round-trips each time, and
 * because `unlisten` resolves asynchronously the outgoing listener is still
 * live while the incoming one is added — which for a toggle means one ⌘1
 * hiding the library and showing it again. Same reasoning, and the same
 * shape, as the quit guard in Workspace.tsx. */
export function useNativeMenu(
  layout: LayoutApi,
  sidebarTitle: string,
  room: RoomMenuActions,
): void {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // The room's two verbs reach the handler the same way the layout does. They
  // are separated from `layout` because they are a different KIND of thing: one
  // arranges the window, the other acts on what is in it, and folding them into
  // one object would invite a layout row to close a document.
  const roomRef = useRef(room);
  roomRef.current = room;
  // Bumped by every press, and a dependency of the sync below.
  //
  // WHY A COUNTER AND NOT JUST THE STATE: muda ticks a check row ITSELF on
  // click, before we hear about it (platform_impl/macos: `set_checked(!…)`
  // then send the event). So a press whose handler happens to leave every
  // synced value where it was would flip a tick, re-render nothing, and leave
  // the menu describing a window that never changed. Today no action can do
  // that — but "today no action can do that" is an invariant nobody would
  // notice breaking, and re-asserting the truth after every press costs one
  // IPC on a press a human made.
  const [pressed, setPressed] = useState(0);

  useEffect(() => {
    const unlisten = api.onMenuAction((id) => {
      const l = layoutRef.current;
      setPressed((n) => n + 1);
      // The File rows act on the ROOM, not on the layout, so they are their own
      // small map rather than another entry in a table of `(layout) => void`.
      const roomAction = ROOM_ACTIONS[id];
      if (roomAction) {
        roomAction(roomRef.current);
        return;
      }
      const run = ACTIONS[id];
      // An unknown id is a menu row shipped without a handler. It cannot be
      // recovered from here and the user cannot act on it, so it goes to the
      // console rather than to a toast — and the test below is what actually
      // prevents it.
      if (!run) {
        console.warn("[menu] no handler for", id);
        return;
      }
      run(l);
    });
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const library = layout.visible.includes("library");
  const assistant = layout.visible.includes("ai");
  const focus = layout.focusPane === "center";
  const railLabels = layout.railExpandedPref;
  const railLabelsSettable = !layout.railAutoCollapsed;

  useEffect(() => {
    void api
      .syncViewMenu({
        enabled: true,
        library,
        assistant,
        focus,
        railLabels,
        railLabelsSettable,
        // The ⌘1 row's LABEL, not only its tick. It toggles the second column,
        // and that column is a different thing in each destination — a row
        // reading "Library" while it shows and hides Memory's list is the menu
        // describing somewhere the reader is not.
        sidebar: sidebarTitle,
      })
      .catch(() => {});
  }, [
    library,
    assistant,
    focus,
    railLabels,
    railLabelsSettable,
    sidebarTitle,
    pressed,
  ]);

  // Closing the room is what greys the menu out — NOT a layout change. Putting
  // this in the effect above would send `enabled: false` and then `true` again
  // on every toggle, and the menu bar would flicker its own rows on the way
  // past. Every tick goes off with it: with no room open, "Library ✓" is a
  // statement about a window that isn't there.
  useEffect(
    () => () => {
      void api
        .syncViewMenu({
          enabled: false,
          library: false,
          assistant: false,
          focus: false,
          railLabels: false,
          railLabelsSettable: false,
          // No room, no destination, so no destination's word for the column.
          sidebar: "Sidebar",
        })
        .catch(() => {});
    },
    [],
  );
}

/** Every row id the native menu can raise, and what it does here.
 *
 * `railLabels` writes the PREFERENCE (`toggleRail`), which is why the row
 * ticks from `railExpandedPref` rather than from the effective value above —
 * the tick has to describe the thing the row changes, or pressing it appears
 * to do nothing on a narrow window. */
/** The two File rows, and what the shell does about them.
 *
 * ⌘T and ⌘W are declared in the native menu (src-tauri/src/menu.rs) because
 * macOS hands a key equivalent to the menu bar before the key window sees it —
 * and, decisively, because the private browser's page is a NATIVE child webview
 * whose key focus a `window.keydown` listener in this webview never hears from.
 * A React-only ⌘T therefore did nothing in the one destination that most needs
 * it. Both rows are context-aware; the shell decides what they mean. */
export interface RoomMenuActions {
  /** Make the current destination's new item. No-op where it has none. */
  newItem: () => void;
  /** Close the current destination's active item — the browser page, else the
   * open document. Falls back to closing the window when there is nothing,
   * which is what a Mac user expects ⌘W to do with nothing open. */
  closeItem: () => void;
}

const ROOM_ACTIONS: Record<string, (room: RoomMenuActions) => void> = {
  "file.new-item": (r) => r.newItem(),
  "file.close-item": (r) => r.closeItem(),
};

const ACTIONS: Record<string, (layout: LayoutApi) => void> = {
  "view.library": (l) => l.togglePane("library"),
  "view.assistant": (l) => l.togglePane("ai"),
  "view.focus": (l) => l.toggleFocus("center"),
  "view.rail-labels": (l) => l.toggleRail(),
  "view.preset.focus": (l) => l.applyPreset("focus"),
  "view.preset.research": (l) => l.applyPreset("research"),
  "view.preset.review": (l) => l.applyPreset("review"),
  "view.reset": (l) => l.resetLayout(),
};
