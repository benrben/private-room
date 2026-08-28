/**
 * The app's native menu bar, and the View menu that drives the room's layout.
 *
 * Ported from `src-tauri/src/menu.rs` — read that file's module doc comment
 * in full before touching this one. It names the two things that make this
 * module dangerous, and both invariants are guarded by tests in
 * `menu.test.ts`:
 *
 * 1. ⚠️ THE ONE THING THAT MAKES THIS MODULE DANGEROUS. Electron's
 *    `Menu.setApplicationMenu` REPLACES the whole menu wholesale, exactly
 *    like Tauri's `set_menu` — it does not merge with any platform default.
 *    Every predefined row this file forgets to declare stops existing, and
 *    the ones that matter are not the visible ones: ⌘C, ⌘V, ⌘X and ⌘A are
 *    key equivalents OWNED BY THE EDIT MENU. Drop the Edit section and
 *    copy/paste die in every text field in the app, including the password
 *    gate — where a user pasting a passphrase out of a password manager is
 *    the *expected* way in. `MENU_SPEC` below re-declares all of them, and
 *    `spec_declares_the_clipboard_keys` in the test file fails if any goes
 *    missing.
 *
 * 2. ⚠️ EMIT THROUGH THE CALLER'S OWN `getMainWindow`, never a webview- or
 *    label-scoped lookup. The Rust file's `crate::main_window` doc comment
 *    tells the whole story: once a private-browser page is open the main
 *    window hosts two webviews and a scoped lookup starts returning nothing,
 *    silently, only once someone has actually opened a web page. This module
 *    never reaches for a window itself — `getMainWindow` is always an
 *    injected dependency, supplied by whatever the real Electron equivalent
 *    of `crate::main_window` turns out to be.
 *
 * WHY THE MENU IS DATA. `MENU_SPEC` is a plain data structure a builder
 * walks, not a run of imperative `Menu`/`MenuItem` construction calls — so
 * every invariant worth having (the clipboard rows exist, ids are unique,
 * each id resolves to a row with a frontend handler) is a plain unit test
 * that runs in milliseconds with no Electron process required. Only
 * `build()` and the live `Electron.Menu` instance `menuSync()` mutates are
 * outside what these tests can exercise — see the comment on the `electron`
 * import below for why, and on `build()` for what little that leaves
 * untested.
 */

import type { Menu as ElectronMenu, MenuItemConstructorOptions } from "electron";
import { QUIT_REQUESTED } from "./quitDoor.js";

// LAZY `import()`, never a top-level value `import`, for the one place below
// (`build`) that needs the real `Menu` value rather than just its type.
// Electron intercepts the `"electron"` module specifier and hands back the
// real API object to anything that resolves it — dynamic `import()` calls
// included — while this code is actually running *inside* the Electron
// process. But a plain Node process (which is what vitest is) resolving that
// same specifier gets the ordinary meaning of requiring the "electron"
// package: the path to the Electron binary, a string, not an object.
//
// This is not a hypothetical: `import { Menu } from "electron"` at the top
// of this file fails at LOAD TIME under plain Node with
// `SyntaxError: Named export 'Menu' not found` (verified directly — Node's
// ESM loader validates named exports of a CJS module strictly, and a bare
// string module.exports has none). Vite's own module transform is more
// lenient about this than Node itself is — under vitest a top-level named
// import from "electron" merely resolves to `undefined` rather than
// throwing — which is exactly the kind of tooling-specific accident this
// module should not depend on. Deferring the lookup into `build()`'s own
// body means the import is never even attempted unless `build()` is
// actually called, which the tests below never do, and the file behaves
// identically regardless of which loader runs it.

/**
 * The window event every custom row raises, carrying the row's id.
 *
 * One event for the whole menu, not one per row: the frontend's map from id
 * to action is then a single object a reader can check for completeness.
 */
export const MENU_EVENT = "menu-action";

/** The App section's own id. `label: null` for this one — see `MENU_SPEC`. */
export const APP_ID = "app";
/**
 * The File submenu's own id. Gated by `menuSync` exactly like View: New acts
 * on the room's contents, so with no room open it is a row that cannot do
 * what it says. Close is the exception — see {@link alwaysEnabled}.
 */
export const FILE_ID = "file";
/** The Edit submenu's own id — see the module warning above. */
export const EDIT_ID = "edit";
/** The View submenu's own id, so `menuSync` can find it again. */
export const VIEW_ID = "view";
/** The Window submenu's own id. */
export const WINDOW_ID = "window";

/** The ⌘T row. */
export const NEW_ID = "file.new-item";
/**
 * The ⌘W row. Named because several places have to agree about it: it is
 * born enabled, `menuSync` leaves it that way, and `dispatch` gives it a
 * meaning with no room open.
 */
export const CLOSE_ID = "file.close-item";

/**
 * The ⌘Q row — ours, not the platform's, and it has to be.
 *
 * macOS's predefined Quit item calls `terminate:`-style behaviour directly.
 * The Rust app's tao shell implemented `applicationWillTerminate:` (fires
 * once the process is ALREADY going down) but not
 * `applicationShouldTerminate:` (the one hook that can still say no) — so
 * the predefined row raised no exit-requested event at all, the unsaved-
 * edits door never ran, and Quit discarded an edited note without asking.
 * Electron's `before-quit` is better-behaved (it fires for menu Quit, Dock
 * Quit, and logout alike), but this row stays a custom one regardless: the
 * decision to hold the exit and ask is not one a window can make about
 * itself, so `dispatch` answers it here rather than passing it on. See
 * `quitDoor.ts`.
 */
export const QUIT_ID = "app.quit";

export const VIEW_LIBRARY_ID = "view.library";
export const VIEW_ASSISTANT_ID = "view.assistant";
export const VIEW_FOCUS_ID = "view.focus";
export const VIEW_RAIL_LABELS_ID = "view.rail-labels";
export const VIEW_PRESET_FOCUS_ID = "view.preset.focus";
export const VIEW_PRESET_RESEARCH_ID = "view.preset.research";
export const VIEW_PRESET_REVIEW_ID = "view.preset.review";
export const VIEW_RESET_ID = "view.reset";

/**
 * Rows that mean something with NO room open, and so are never gated.
 *
 * Close and Quit. ⌘W is the standard macOS "close this window" key, and the
 * start screen and the password gate are windows: greying the row there
 * would leave ⌘W doing nothing at all — not closing the window, not
 * anything — because this menu replaces the predefined Close Window row that
 * would otherwise own the key. What the row DOES with no room open is
 * decided in `dispatch`, since the frontend's handler for it is mounted with
 * the room. ⌘Q is the same shape for the same reason — see {@link QUIT_ID}.
 */
export function alwaysEnabled(id: string): boolean {
  return id === CLOSE_ID || id === QUIT_ID;
}

// ---------------------------------------------------------------- the spec

/**
 * One row of the menu bar.
 *
 * `"platform"` rows carry macOS's own predefined behaviour and key
 * equivalents (the Rust source calls these out as a `Platform` enum plus a
 * conversion function; Electron's `role` string already names the same
 * concept directly, so there is nothing left to convert).
 */
export type Row =
  | { kind: "platform"; role: MenuItemConstructorOptions["role"] }
  | { kind: "separator" }
  /** A row that does something to the room. Raises {@link MENU_EVENT}. */
  | { kind: "command"; id: string; label: string; accelerator?: string }
  /**
   * A row whose tick is a fact about the window. Raises {@link MENU_EVENT}
   * too; the tick itself is pushed back by `menuSync`, never toggled here —
   * the frontend owns the state, so letting the menu tick itself would let
   * the two disagree the first time an action was refused.
   */
  | { kind: "check"; id: string; label: string; accelerator?: string }
  | { kind: "nested"; label: string; rows: Row[] };

export interface Section {
  id: string;
  /** `null` is the application menu, which macOS titles with the app's own
   * name and draws in bold at the far left. */
  label: string | null;
  rows: Row[];
}

/**
 * The whole menu bar.
 *
 * The App, Edit, Window and Help(-less, macOS supplies it) sections
 * reproduce Electron's own default template item for item — this is the
 * re-declaration the module header warns about, not a place to be creative.
 * View is the new work.
 *
 * DEVIATION FROM RUST: the Rust `APP` section's label was computed at build
 * time from `app.package_info().name` when `None` — a live Tauri API call.
 * `MENU_SPEC` is a static data table with no such call available (and
 * `app.getName()`'s Electron equivalent would break the "pure data, no
 * Electron API calls" property this whole file is built around). This is
 * safe to hardcode rather than derive: on macOS the OS always titles the
 * first application menu with the running app's own name no matter what
 * label string is given, and this app is Mac-only (see the product-decisions
 * memory) — so `label: null` here is cosmetic in exactly the way the Rust
 * `None` was, and the literal "Arcelle" fallback below is never actually
 * shown by the one platform this ships on.
 */
export const MENU_SPEC: Section[] = [
  {
    id: APP_ID,
    label: null,
    rows: [
      { kind: "platform", role: "about" },
      { kind: "separator" },
      { kind: "platform", role: "services" },
      { kind: "separator" },
      { kind: "platform", role: "hide" },
      { kind: "platform", role: "hideOthers" },
      { kind: "platform", role: "unhide" },
      { kind: "separator" },
      // NOT role: "quit" — see QUIT_ID. The predefined row cannot be held
      // long enough to ask about an unsaved buffer.
      {
        kind: "command",
        id: QUIT_ID,
        label: "Quit Arcelle",
        accelerator: "CmdOrCtrl+Q",
      },
    ],
  },
  // ⌘T AND ⌘W ARE DECLARED HERE AND NOWHERE ELSE, for the same reason ⌘1 and
  // ⌘2 are (see the View section below): macOS hands a key equivalent to the
  // menu bar before the event reaches the key window — which is not a
  // nicety in the private browser, where the key window's focus is often
  // inside a native child webview the app's own keydown listeners never see.
  //
  // "Close" replaces the predefined Close Window row, and takes its place in
  // the Window menu's usual slot in the File menu instead. The predefined
  // row owns ⌘W unconditionally and closes the WINDOW, which in a single-
  // window app would make ⌘W-while-reading-a-page quit the app. The
  // frontend decides what ⌘W closes — the active browser page, else the
  // open document — and `dispatch` closes the window itself only when there
  // is nothing else open to close it for.
  {
    id: FILE_ID,
    label: "File",
    rows: [
      { kind: "command", id: NEW_ID, label: "New", accelerator: "CmdOrCtrl+T" },
      { kind: "separator" },
      { kind: "command", id: CLOSE_ID, label: "Close", accelerator: "CmdOrCtrl+W" },
    ],
  },
  {
    id: EDIT_ID,
    label: "Edit",
    rows: [
      { kind: "platform", role: "undo" },
      { kind: "platform", role: "redo" },
      { kind: "separator" },
      { kind: "platform", role: "cut" },
      { kind: "platform", role: "copy" },
      { kind: "platform", role: "paste" },
      { kind: "platform", role: "selectAll" },
    ],
  },
  {
    id: VIEW_ID,
    label: "View",
    rows: [
      // ⌘1 and ⌘2 are DECLARED HERE and nowhere else — see the comment on
      // FILE_ID's rows above for why a menu row, not a keydown listener, has
      // to be the one owner.
      //
      // Named "Sidebar" only until the first sync: the row toggles the
      // SECOND COLUMN, whose name and contents differ per destination
      // (Library at Home, Sketches in Sketch, Private pages in the
      // browser), so `menuSync` retitles it to whatever the reader is
      // actually looking at. The static label here is the honest word for
      // it with no room open, and it is never "Library" — that is one
      // destination's name for the column, not the row's.
      {
        kind: "check",
        id: VIEW_LIBRARY_ID,
        label: "Sidebar",
        accelerator: "CmdOrCtrl+1",
      },
      {
        kind: "check",
        id: VIEW_ASSISTANT_ID,
        label: "Assistant",
        accelerator: "CmdOrCtrl+2",
      },
      { kind: "check", id: VIEW_FOCUS_ID, label: "Focus the Workspace" },
      { kind: "separator" },
      // Nested rather than listed flat, because "Focus the Workspace" above
      // and the "Focus" preset below are different acts with the same word
      // in them; the in-app Layout menu separates them with group headings,
      // and a native menu's nesting is what keeps the two apart here.
      {
        kind: "nested",
        label: "Layout",
        rows: [
          { kind: "command", id: VIEW_PRESET_FOCUS_ID, label: "Focus" },
          { kind: "command", id: VIEW_PRESET_RESEARCH_ID, label: "Research" },
          { kind: "command", id: VIEW_PRESET_REVIEW_ID, label: "Review" },
          { kind: "separator" },
          { kind: "command", id: VIEW_RESET_ID, label: "Reset Layout" },
        ],
      },
      { kind: "separator" },
      // NOT "Show Sidebar Labels" — "Sidebar" is already the ⌘1 row above,
      // and that row is the SECOND column; this one is the rail, the first.
      // The rail's own accessible name has always been "Destinations", so
      // the menu uses the word the control already answers to.
      {
        kind: "check",
        id: VIEW_RAIL_LABELS_ID,
        label: "Show Destination Names",
      },
      { kind: "separator" },
      { kind: "platform", role: "togglefullscreen" },
    ],
  },
  {
    id: WINDOW_ID,
    label: "Window",
    rows: [
      { kind: "platform", role: "minimize" },
      { kind: "platform", role: "zoom" },
      // No Close Window row: ⌘W belongs to File → Close above, which
      // closes the active ITEM and falls back to closing the window when
      // there is none. Two rows both claiming ⌘W would give the key two
      // owners, and the predefined one always wins.
    ],
  },
];

/**
 * Every id the app's own menus can raise, paired with the SECTION that
 * declares it, in menu order.
 *
 * The pairing is what `menuSync` needs: it used to look every id up inside
 * the View submenu alone, which was correct only while View was the one
 * section with rows of ours. The File menu's ⌘T and ⌘W would have been
 * "missing" on every sync — and, being born disabled, would have stayed
 * grey for the life of the app.
 *
 * Only walks the "view" and "file" sections (recursing into nested rows,
 * e.g. the Layout submenu) — App, Edit and Window hold no rows of ours.
 */
export function gatedRows(): Array<[section: string, id: string]> {
  function walk(section: string, rows: Row[], out: Array<[string, string]>): void {
    for (const row of rows) {
      if (row.kind === "command" || row.kind === "check") {
        out.push([section, row.id]);
      } else if (row.kind === "nested") {
        walk(section, row.rows, out);
      }
    }
  }
  const out: Array<[string, string]> = [];
  for (const section of MENU_SPEC) {
    if (section.id !== VIEW_ID && section.id !== FILE_ID) {
      continue;
    }
    walk(section.id, section.rows, out);
  }
  return out;
}

/** Every id the menus can raise, in menu order. */
export function ids(): string[] {
  return gatedRows().map(([, id]) => id);
}

// ------------------------------------------------------------ the frontend

/**
 * What the View menu should be showing right now.
 *
 * One payload rather than a `setCheck(id, bool)` per row: the four ticks and
 * the enabled flag are one fact about one window, and sending them together
 * means the menu can never be caught halfway through a layout change. The
 * frontend sends it whenever any part changes, and once more with
 * `enabled: false` as the room unmounts.
 *
 * DEVIATION FROM RUST: Rust's `sidebar` field carried `#[serde(default)]` so
 * a payload missing the field parsed to `""`. This interface is a plain TS
 * type, not a deserializer boundary, so `sidebar` is required here; a caller
 * relaying an IPC payload that might omit it should default the field to
 * `""` itself before calling in — `sidebarLabel("")` already produces the
 * same "Sidebar" fallback either way, so the two behave identically once the
 * IPC boundary has been crossed.
 */
export interface ViewMenuState {
  /** False whenever no room is open — see the row-building comments above. */
  enabled: boolean;
  library: boolean;
  assistant: boolean;
  focus: boolean;
  railLabels: boolean;
  /**
   * False while the WINDOW, not the reader, is what took the sidebar's
   * labels away. Below 1180px the rail drops them on its own and the
   * preference cannot put them back, so the row would tick itself off and
   * then refuse to tick back on. The rail's own expander hides for the same
   * reason; a menu row cannot hide, so it greys out instead.
   */
  railLabelsSettable: boolean;
  /**
   * What the ⌘1 row is called right now — the active destination's name for
   * its second column. Empty falls back to the generic word rather than to
   * any destination's, so a stale payload cannot leave the row claiming to
   * toggle something it is not standing over.
   */
  sidebar: string;
}

/**
 * What to write on the ⌘1 row.
 *
 * The generic word, never a destination's, when the frontend has nothing to
 * say — with no room open there is no second column to name, and picking
 * one destination's word for it is how the row came to read "Library" while
 * standing over Memory in the first place.
 */
export function sidebarLabel(sent: string): string {
  const trimmed = sent.trim();
  return trimmed.length === 0 ? "Sidebar" : trimmed;
}

/**
 * Each tick row as [id, checked, enabled].
 *
 * `view.rail-labels` is enabled only when BOTH the room is open and the
 * window says the preference is settable right now — see
 * `ViewMenuState.railLabelsSettable`.
 */
export function viewMenuChecks(view: ViewMenuState): Array<[id: string, checked: boolean, enabled: boolean]> {
  return [
    [VIEW_LIBRARY_ID, view.library, view.enabled],
    [VIEW_ASSISTANT_ID, view.assistant, view.enabled],
    [VIEW_FOCUS_ID, view.focus, view.enabled],
    [VIEW_RAIL_LABELS_ID, view.railLabels, view.enabled && view.railLabelsSettable],
  ];
}

// ------------------------------------------------------------- the builder

function rowToTemplate(row: Row, onCommand: (id: string) => void): MenuItemConstructorOptions {
  switch (row.kind) {
    case "platform":
      return { role: row.role };
    case "separator":
      return { type: "separator" };
    case "command":
      return {
        id: row.id,
        label: row.label,
        accelerator: row.accelerator,
        // Every custom row is born DISABLED except the ones `alwaysEnabled`
        // names: the menu bar exists before any room is open, and a row
        // that toggles panes in a window showing the password gate is a row
        // that cannot do what it says. `menuSync` enables the section when
        // a room mounts and disables it again on the way out.
        enabled: alwaysEnabled(row.id),
        click: () => onCommand(row.id),
      };
    case "check":
      return {
        id: row.id,
        label: row.label,
        accelerator: row.accelerator,
        // Always born false in the Rust source too (`CheckMenuItem::with_id`
        // is called with a literal `false`, not `always_enabled(id)`) — but
        // no check row is ever CLOSE_ID/QUIT_ID, so reusing the same helper
        // here is behaviourally identical and keeps one fewer rule to know.
        enabled: alwaysEnabled(row.id),
        type: "checkbox",
        checked: false,
        click: () => onCommand(row.id),
      };
    case "nested":
      return {
        label: row.label,
        submenu: row.rows.map((nested) => rowToTemplate(nested, onCommand)),
      };
  }
}

/**
 * The whole menu bar, as a plain Electron template — PURE data
 * transformation, no Electron API calls. This is the function the tests
 * exercise directly: it walks {@link MENU_SPEC} and returns objects, so
 * every invariant about row shape, ids, accelerators and born-enabled state
 * is checkable without `Menu.buildFromTemplate` or a running app.
 */
export function buildTemplate(onCommand: (id: string) => void): MenuItemConstructorOptions[] {
  return MENU_SPEC.map((section) => ({
    // macOS draws the application menu with the app's own name whatever
    // string is passed — see MENU_SPEC's doc comment for why this is safe
    // to hardcode rather than derive from a live Electron API call.
    label: section.label ?? "Arcelle",
    submenu: section.rows.map((row) => rowToTemplate(row, onCommand)),
  }));
}

/**
 * The real menu, ready for `Menu.setApplicationMenu`. Not itself unit
 * tested — see the comment on the lazy `import("electron")` near the top of
 * this file for why constructing a live `Electron.Menu` is not possible from
 * this test environment. Everything it depends on (`buildTemplate`,
 * `MENU_SPEC`) is. Async only because of that lazy import — the actual
 * `Menu.buildFromTemplate` call itself is synchronous.
 */
export async function build(onCommand: (id: string) => void): Promise<ElectronMenu> {
  const { Menu } = await import("electron");
  return Menu.buildFromTemplate(buildTemplate(onCommand));
}

// -------------------------------------------------------------- dispatch

/**
 * The minimal shape `dispatch`/`quit` need from a main window — deliberately
 * not `Electron.BrowserWindow` itself, so the pure decision logic below can
 * be unit tested with a plain object instead of a real window.
 */
export interface MainWindowLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void };
  close: () => void;
}

/**
 * The minimal shape `quit` needs from the quit door — see `quitDoor.ts`'s
 * `QuitDoor` class, which satisfies this.
 */
export interface QuitDoorLike {
  holdForUnsaved(code: number | null): boolean;
}

/**
 * ⌘Q, asked properly.
 *
 * The hold is the quit door's to decide and its latch to keep: it answers
 * true at most once per dirty buffer, so a window that never replies still
 * quits on the second press. `null` for the code, because this IS the quit
 * the user asked for — a programmatic exit (the window's own close guard,
 * once it has already asked) carries a code and must never be re-asked.
 *
 * Every path that does not hold — nothing unsaved, already asked, or no
 * window left to ask — calls `appExit`. Taking that as an injected callback
 * (rather than calling `app.exit(0)` directly) is what keeps this function
 * testable without a live Electron `app`.
 */
export function quit(
  quitDoor: QuitDoorLike,
  getMainWindow: () => MainWindowLike | null | undefined,
  appExit: () => void,
): void {
  if (quitDoor.holdForUnsaved(null)) {
    const window = getMainWindow();
    if (window) {
      window.webContents.send(QUIT_REQUESTED);
      return;
    }
    // No window left to ask — falls through to appExit below, exactly like
    // every other non-held path. This is the branch the Rust source's
    // `if let Some(window) = ... else` falls through for.
  }
  appExit();
}

/**
 * Dependencies `dispatch` needs, injected rather than reached for — see the
 * module header's warning about scoped window lookups.
 */
export interface DispatchDeps {
  quitDoor: QuitDoorLike;
  getMainWindow: () => MainWindowLike | null | undefined;
  /**
   * True only when we LOOKED and there was no room — see the Rust source's
   * `no_room_is_open`, whose `try_lock`-over-`lock` reasoning does not
   * translate to single-threaded Node and is therefore the caller's concern,
   * not this function's.
   */
  isRoomOpen: () => boolean;
  appExit: () => void;
}

/**
 * Hand a menu row's id to the frontend.
 *
 * Best-effort by construction: a menu press with no window to tell is a
 * no-op, not an error path — there is nothing useful to do about it and
 * nowhere to say it, since the window IS the user interface.
 */
export function dispatch(id: string, deps: DispatchDeps): void {
  // Answered here, not by the window: the question is whether to exit at
  // all, and the window is the thing being exited. BEFORE the window
  // lookup, so ⌘Q works at the start screen too.
  if (id === QUIT_ID) {
    quit(deps.quitDoor, deps.getMainWindow, deps.appExit);
    return;
  }
  const window = deps.getMainWindow();
  if (!window) {
    return;
  }
  // ⌘W with no room open has no listener to reach: the frontend's menu
  // handler — which owns every row id on the other side — mounts with the
  // room, so at the start screen and the password gate the event would go
  // nowhere and the key would do nothing. Do here what the shell does as
  // its own last case, and what the predefined Close Window row this menu
  // replaces always did.
  if (id === CLOSE_ID && !deps.isRoomOpen()) {
    window.close();
    return;
  }
  window.webContents.send(MENU_EVENT, id);
}

/**
 * Push the window's layout state onto the native View menu.
 *
 * FAILURE BEHAVIOUR, decided: a tick is decoration on a control that already
 * worked. Nothing here may fail a caller — a platform with no menu bar, or a
 * menu that has not been installed, is a silent no-op — but an id in the
 * payload the menu does not have, or a check row with no matching payload
 * field, is a wiring bug on our side, so those get logged once obs.ts lands
 * in this repo (tracked as TODOs below rather than a real call, since that
 * module does not exist yet in this workspace).
 */
export function menuSync(menu: ElectronMenu, view: ViewMenuState): void {
  // Electron's `Menu.getMenuItemById` searches the WHOLE tree, nested
  // submenus included — unlike Tauri's `Submenu::get`, which only sees its
  // own direct children and needed a hand-written recursive `find` helper
  // (the Rust source's `find`) to reach the presets living one level down
  // inside Layout. That helper has no equivalent here; this is a deliberate
  // simplification, not a gap — `ids_are_unique_and_namespaced` guarantees
  // there is only ever one row per id for `getMenuItemById` to find.
  const checks = viewMenuChecks(view);
  for (const [, id] of gatedRows()) {
    const item = menu.getMenuItemById(id);
    if (!item) {
      // TODO: obs.warn("menu_row_missing", [["id", id]]) once obs.ts lands.
      continue;
    }
    if (item.type === "checkbox") {
      // Row by row, never the section — View holds two different
      // lifetimes: these rows belong to the open room, but Toggle Full
      // Screen belongs to the WINDOW and is meaningful with no room at all.
      // See the module header for why disabling the submenu as a unit is
      // not an option.
      const match = checks.find(([rowId]) => rowId === id);
      if (!match) {
        // Unreachable by construction (every check row above has a payload
        // field), and a warn rather than a silent default if it ever isn't:
        // a tick left at whatever it happened to be is a menu quietly
        // lying about the window.
        // TODO: obs.warn("menu_check_unmapped", [["id", id]]) once obs.ts lands.
        continue;
      }
      const [, checked, enabled] = match;
      item.checked = checked;
      item.enabled = enabled;
      if (id === VIEW_LIBRARY_ID) {
        item.label = sidebarLabel(view.sidebar);
      }
    } else if (item.type === "normal") {
      // The rows that only act — presets, Reset, New — follow the section;
      // Close does not, because it can always close the window. The
      // Rust source's `match` on `MenuItemKind` falls through anything that
      // is neither a Check nor a MenuItem with `_ => {}`; mirroring that
      // with an explicit `"normal"` check (rather than a catch-all `else`)
      // keeps this branch from silently reinterpreting some future row kind
      // that ought to be ignored instead.
      item.enabled = view.enabled || alwaysEnabled(id);
    }
  }
}
