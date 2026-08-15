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
export function useNativeMenu(layout: LayoutApi): void {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
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
      const run = ACTIONS[id];
      setPressed((n) => n + 1);
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
      })
      .catch(() => {});
  }, [library, assistant, focus, railLabels, railLabelsSettable, pressed]);

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
