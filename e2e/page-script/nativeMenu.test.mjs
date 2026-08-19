/* The native menu bar's invariants — the ones that span the two languages.
 *
 * menu.rs can test its own spec, and it does (the Edit submenu still declares
 * the clipboard rows; ids are unique; ⌘1/⌘2 are declared once each). What it
 * cannot see is the TypeScript on the other end of the wire, and that is where
 * this menu's two silent failures live:
 *
 *   • A ROW WITH NO HANDLER. The menu is one event carrying a row id. Add a
 *     row in Rust, forget the entry in useNativeMenu's ACTIONS, and the row
 *     ships looking exactly like the ones that work — it just does nothing
 *     when pressed. Nothing type-checks across that boundary.
 *   • BOTH SIDES CLAIMING ⌘1. macOS gives a key equivalent to the menu bar
 *     before the key window sees it, so a surviving keydown listener would not
 *     produce two toggles on every press — it would produce them only if that
 *     assumption were ever wrong, which is the worst kind of latent bug. The
 *     rule is one owner, stated in both files and checked here.
 *
 * Read from source rather than imported: useNativeMenu pulls in React and the
 * Tauri IPC bridge, neither of which resolves under a bare node test. Same
 * technique as navRedesign.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const MENU_RS = read("src-tauri/src/menu.rs");
const HOOK = read("src/shell/useNativeMenu.ts");
const LAYOUT = read("src/shell/useLayout.ts");

/** Every `id: "view.…"` the Rust spec declares, in menu order. */
function rustIds() {
  const spec = MENU_RS.split("// ------------------------------------------------------------- the builder")[0];
  return [...spec.matchAll(/id:\s*"(view\.[a-z.-]+)"/g)].map((m) => m[1]);
}

/** Every key of useNativeMenu's ACTIONS map. */
function tsIds() {
  const body = /const ACTIONS: Record<string, \(layout: LayoutApi\) => void> = \{([\s\S]*?)\n\};/.exec(
    HOOK,
  )?.[1];
  assert.ok(body, "ACTIONS map not found in useNativeMenu.ts");
  return [...body.matchAll(/"(view\.[a-z.-]+)":/g)].map((m) => m[1]);
}

test("every native menu row has a handler, and every handler a row", () => {
  const rust = rustIds();
  assert.ok(rust.length >= 8, `only found ${rust.length} rows in menu.rs — parser drifted?`);
  assert.deepEqual(
    [...tsIds()].sort(),
    [...rust].sort(),
    "menu.rs and useNativeMenu disagree about which rows exist: a row with no " +
      "handler ships looking exactly like one that works, and does nothing",
  );
});

test("⌘1 and ⌘2 have exactly one owner, and it is the menu", () => {
  assert.match(
    MENU_RS,
    /id: "view\.library",\s*label: "(\w| )+",\s*accel: Some\("CmdOrCtrl\+1"\)/,
    "the View menu must declare ⌘1",
  );
  // …and it must not be born calling the column by Home's name for it. The row
  // shows and hides the SECOND COLUMN, which is Sketches in Sketch and Private
  // pages in the browser; `menu_sync` retitles it per destination, and the
  // static label is what stands there with no room open.
  assert.doesNotMatch(
    MENU_RS,
    /id: "view\.library",\s*label: "Library"/,
    "the ⌘1 row named Home's contents wherever it stood — see sidebar_label",
  );
  assert.match(MENU_RS, /item\.set_text\(sidebar_label\(&view\.sidebar\)\)/);
  assert.match(
    MENU_RS,
    /id: "view\.assistant",\s*label: "Assistant",\s*accel: Some\("CmdOrCtrl\+2"\)/,
    "the View menu must declare ⌘2",
  );
  const map = /export const PANE_KEYS[^=]*=\s*\{([^}]*)\}/.exec(LAYOUT)?.[1];
  assert.ok(map, "PANE_KEYS not found");
  assert.ok(
    !/"1":/.test(map) && !/"2":/.test(map),
    "useLayout still claims a key the View menu declares — one press, two " +
      "handlers, and a pane that toggles back to where it started",
  );
});

test("the menu is greyed out while no room is open", () => {
  // A menu bar outlives every room: it is there over the password gate. Rows
  // are BORN disabled in Rust and the room turns them on, so the failure mode
  // is a menu that does nothing rather than one that acts on a room that
  // isn't there.
  //
  // With TWO exceptions, and they are the reason this asks `always_enabled`
  // rather than pinning the literal `false`. Both are rows that REPLACED a
  // predefined one whose key equivalent works everywhere in macOS, so greying
  // them leaves a standard key doing nothing at all:
  //
  //   ⌘W closes the WINDOW when there is no room, and the start screen and the
  //   password gate are windows.
  //
  //   ⌘Q quits, and it must quit from the password gate as much as from a room.
  //   This row exists at all because the predefined Quit sends `terminate:`,
  //   which tao never gets the chance to refuse — so the unsaved-edits question
  //   could not be asked on the one exit that most needed it.
  assert.match(
    MENU_RS,
    /MenuItem::with_id\(app, \*id, label, always_enabled\(id\), \*accel\)/,
    "command rows must be built from the gate, not born enabled",
  );
  assert.match(
    MENU_RS,
    /fn always_enabled\(id: &str\) -> bool \{\s*id == CLOSE_ID \|\| id == QUIT_ID,?\s*\}/,
    "Close and Quit are the rows that mean something with no room open",
  );
  // Quit is answered in Rust and never reaches the frontend, so it has to be
  // handled BEFORE the window lookup that every other row goes through — or
  // ⌘Q at the start screen would be enabled and dead.
  assert.match(
    MENU_RS,
    /if id == QUIT_ID \{\s*quit\(app\);\s*return;\s*\}\s*\/\/[^\n]*\n\s*let Some\(window\)/,
    "Quit must be answered before the window lookup, or ⌘Q dies at the gate",
  );
  // …and the row it names has to reach something with no frontend listening,
  // or it is enabled and dead, which is worse than grey.
  assert.match(
    MENU_RS,
    /if id == CLOSE_ID && no_room_is_open\(app\) \{\s*let _ = window\.close\(\);/,
    "an ungated Close must close the window itself when no room is open",
  );
  assert.match(
    MENU_RS,
    /CheckMenuItem::with_id\(app, \*id, label, false, false, \*accel\)/,
    "check rows must be built disabled and unticked",
  );
  assert.match(
    HOOK,
    /syncViewMenu\(\{\s*enabled: false/,
    "useNativeMenu must grey the menu out when the room unmounts",
  );
});

test("the room's state reaches the menu bar on every change", () => {
  // The menu bar is not part of this window, so no render can correct a drifted
  // tick. The dependency list is the whole guarantee.
  // Read the payload and the dependency list out of the hook rather than
  // pinning one formatting of them: what matters is that every value the menu
  // is told about is a value the effect re-runs for, and a new field is exactly
  // the case a pinned string would let through with a reformat.
  const sync = HOOK.slice(HOOK.indexOf("syncViewMenu({\n        enabled: true"));
  const payload = sync.slice(0, sync.indexOf("})"));
  const deps = sync.slice(sync.indexOf("}, ["), sync.indexOf("]);"));
  // The VALUE each field is built from — `library,` is its own value, and
  // `sidebar: sidebarTitle,` is watched under the name on the right.
  const sent = [...payload.matchAll(/^\s{8}(\w+)(?::\s*(\w+))?,$/gm)]
    .filter(([, key]) => key !== "enabled")
    .map((m) => m[2] ?? m[1]);
  assert.ok(sent.length >= 6, `only found ${sent.length} synced values`);
  for (const name of sent) {
    assert.match(
      deps,
      new RegExp(`\\b${name}\\b`),
      `the menu is told about \`${name}\` but the effect does not re-run for it`,
    );
  }
  assert.match(
    deps,
    /\bpressed\b/,
    "muda ticks a check row itself on click, so a press that changed nothing " +
      "would otherwise leave that tick lying",
  );
  // …and the labels row ticks from the PREFERENCE, not from what the sidebar
  // currently shows: the row writes the preference, and a tick that describes
  // something else makes a narrow window look like a broken control.
  assert.match(HOOK, /const railLabels = layout\.railExpandedPref;/);
  assert.match(HOOK, /const railLabelsSettable = !layout\.railAutoCollapsed;/);
});
