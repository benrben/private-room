//! The app's native menu bar, and the View menu that drives the room's layout.
//!
//! Until this module existed the app shipped tauri's stock menu: an App
//! submenu, Edit, a View submenu holding only Full Screen, Window and Help.
//! Everything the shell can do to its own layout lived in a popover the
//! keyboard could not reach and the menu bar did not know about.
//!
//! ⚠️ THE ONE THING THAT MAKES THIS MODULE DANGEROUS. `set_menu` REPLACES the
//! stock menu wholesale — it does not merge. Every predefined row this file
//! forgets to declare stops existing, and the ones that matter are not the
//! visible ones: ⌘C, ⌘V, ⌘X and ⌘A are key equivalents OWNED BY THE EDIT MENU.
//! Drop the Edit submenu and copy/paste die in every text field in the app,
//! including the password gate — where a user pasting a passphrase out of a
//! password manager is the *expected* way in. `APP` below re-declares all of
//! them, and `spec_declares_the_clipboard_keys` fails if any goes missing.
//!
//! ⚠️ EMIT THROUGH [`crate::main_window`], NEVER `get_webview_window`. Once a
//! private-browser page is open the main window hosts two webviews and every
//! `get_webview_window("main")` in the process starts returning `None` — see
//! that function's doc comment for the whole story. A View menu wired the
//! other way would work perfectly until someone opened a web page and then go
//! silently dead. `emit_never_reaches_for_a_webview_window` guards it.
//!
//! WHY THE MENU IS DATA. The rows below are a `const` the builder walks rather
//! than a run of `MenuBuilder` calls. muda needs a real NSApplication, so a
//! menu built the ordinary way can only be checked by launching the app and
//! looking — which is exactly the kind of verification nobody repeats. As
//! data, every invariant worth having (the clipboard rows exist, ids are
//! unique, each id has a handler on the other side of the wire) is a plain
//! unit test, and the builder underneath is thirty lines with nothing to say.

use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Runtime};

/// The window event every custom row raises, carrying the row's id.
///
/// One event for the whole menu, not one per row: the frontend's map from id
/// to action is then a single object a reader can check for completeness, and
/// `menu_ids_all_have_a_frontend_handler` checks it mechanically.
pub const MENU_EVENT: &str = "menu-action";

/// The View submenu's own id, so `menu_sync` can find it again.
const VIEW_ID: &str = "view";

/// The File submenu's own id. Gated by `menu_sync` exactly like View: New acts
/// on the room's contents, so with no room open it is a row that cannot do what
/// it says. Close is the exception — see [`always_enabled`].
const FILE_ID: &str = "file";

/// The ⌘W row. Named because three places have to agree about it: it is born
/// enabled, `menu_sync` leaves it that way, and `dispatch` gives it a meaning
/// with no room open. The spec below still spells the id out, so the row reads
/// like its neighbour; `close_is_the_one_row_the_room_gate_leaves_alone` is
/// what keeps the two spellings the same string.
const CLOSE_ID: &str = "file.close-item";

/// The ⌘Q row — ours, not the platform's, and it has to be.
///
/// macOS's predefined Quit item sends `terminate:`. tao installs an app
/// delegate that implements `applicationWillTerminate:` — which fires when the
/// process is ALREADY going down — but not `applicationShouldTerminate:`, the
/// one hook that can still say no. So the predefined row raised no
/// `RunEvent::ExitRequested` whatever, the unsaved-edits door in
/// [`crate::commands::hold_quit_for_unsaved`] never ran, and Quit discarded an
/// edited note without asking. Live QA found it on the first try, through the
/// Apple menu rather than the shortcut: the safest-looking way out was the one
/// with no guard on it at all.
///
/// A row of ours raises [`MENU_EVENT`] like any other, but [`dispatch`] answers
/// this one in Rust rather than passing it on — "hold the exit, then ask" is
/// not a decision a window can make about itself.
///
/// What this does NOT cover: Quit from the Dock icon's menu, and a logout or
/// restart, which still go straight to `terminate:`. Those keep the old
/// behaviour, and `RunEvent::Exit` teardown still runs for them (that arrives
/// via `applicationWillTerminate:`), so a live recording is still flushed —
/// only the question about an unsaved buffer is lost.
const QUIT_ID: &str = "app.quit";

/// Rows that mean something with NO room open, and so are never gated.
///
/// Close and Quit. ⌘W is the standard macOS "close this window" key, and
/// the start screen and the password gate are windows: greying the row there
/// left ⌘W doing nothing at all in the app — not closing the window, not
/// anything — because this menu replaced the predefined Close Window row that
/// used to own the key. What the row DOES with no room open is decided in
/// [`dispatch`], since the frontend's handler for it is mounted with the room.
/// ⌘Q is the same shape for the same reason — see [`QUIT_ID`].
fn always_enabled(id: &str) -> bool {
    id == CLOSE_ID || id == QUIT_ID
}

// ---------------------------------------------------------------- the spec

/// A row the PLATFORM owns. These carry macOS's own behaviour and its own key
/// equivalents; we only say where they go.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Platform {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    CloseWindow,
    Fullscreen,
}

/// The clipboard's four key equivalents, named once so the test that protects
/// them and the reader looking for them are reading the same list.
#[cfg(test)]
const CLIPBOARD: &[Platform] = &[
    Platform::Cut,
    Platform::Copy,
    Platform::Paste,
    Platform::SelectAll,
];

pub(crate) enum Row {
    Platform(Platform),
    Separator,
    /// A row that does something to the room. Raises [`MENU_EVENT`].
    Command {
        id: &'static str,
        label: &'static str,
        accel: Option<&'static str>,
    },
    /// A row whose tick is a fact about the window. Raises [`MENU_EVENT`] too;
    /// the tick itself is pushed back by `menu_sync`, never toggled here — the
    /// frontend owns the state, so letting the menu tick itself would let the
    /// two disagree the first time an action was refused.
    Check {
        id: &'static str,
        label: &'static str,
        accel: Option<&'static str>,
    },
    Nested {
        label: &'static str,
        rows: &'static [Row],
    },
}

pub(crate) struct Section {
    pub(crate) id: &'static str,
    /// `None` is the application menu, which macOS titles with the app's own
    /// name and draws in bold at the far left.
    pub(crate) label: Option<&'static str>,
    pub(crate) rows: &'static [Row],
}

/// The whole menu bar.
///
/// The App, Edit, Window and Help sections reproduce tauri's `Menu::default`
/// item for item — this is the re-declaration the module header warns about,
/// not a place to be creative. View is the new work.
pub(crate) const APP: &[Section] = &[
    Section {
        id: "app",
        label: None,
        rows: &[
            Row::Platform(Platform::About),
            Row::Separator,
            Row::Platform(Platform::Services),
            Row::Separator,
            Row::Platform(Platform::Hide),
            Row::Platform(Platform::HideOthers),
            Row::Platform(Platform::ShowAll),
            Row::Separator,
            // NOT `Platform::Quit` — see QUIT_ID. The predefined row cannot be
            // held long enough to ask about an unsaved buffer.
            Row::Command {
                id: QUIT_ID,
                label: "Quit Arcelle",
                accel: Some("CmdOrCtrl+Q"),
            },
        ],
    },
    // ⌘T AND ⌘W ARE DECLARED HERE AND NOWHERE ELSE, for the same reason ⌘1 and
    // ⌘2 are (see the View section below): macOS hands a key equivalent to the
    // menu bar before the event reaches the key window.
    //
    // That is not a nicety here, it is the only thing that WORKS. The private
    // browser's page is a native child webview, so while you are browsing the
    // key window's focus is inside a view that the app's React `keydown`
    // listener never hears from — ⌘T in the browser simply did nothing, which
    // is precisely the destination it most needs to work in.
    //
    // "Close" replaces the predefined Close Window row, and takes its place in
    // the Window menu's usual slot in the File menu instead. The predefined row
    // owns ⌘W unconditionally and closes the WINDOW, which in a single-window
    // app means ⌘W-while-reading-a-page quit Arcelle. The frontend decides what
    // ⌘W closes — the active browser page, else the open document — and closes
    // the window itself when there is nothing else to close, so the macOS
    // behaviour survives as the last case rather than as the only one.
    Section {
        id: "file",
        label: Some("File"),
        rows: &[
            Row::Command {
                id: "file.new-item",
                label: "New",
                accel: Some("CmdOrCtrl+T"),
            },
            Row::Separator,
            Row::Command {
                id: "file.close-item",
                label: "Close",
                accel: Some("CmdOrCtrl+W"),
            },
        ],
    },
    Section {
        id: "edit",
        label: Some("Edit"),
        rows: &[
            Row::Platform(Platform::Undo),
            Row::Platform(Platform::Redo),
            Row::Separator,
            Row::Platform(Platform::Cut),
            Row::Platform(Platform::Copy),
            Row::Platform(Platform::Paste),
            Row::Platform(Platform::SelectAll),
        ],
    },
    Section {
        id: VIEW_ID,
        label: Some("View"),
        rows: &[
            // ⌘1 and ⌘2 are DECLARED HERE and nowhere else. They used to be
            // claimed by a capture-phase keydown listener in useLayout, which
            // was the only owner available before this menu existed. macOS
            // hands a key equivalent to the menu bar before the event reaches
            // the key window, so leaving that listener in place would have
            // given the two keys two owners — and a pane toggled twice is a
            // pane that never moves. useLayout keeps ⌘3 alone, the alias no
            // menu row can express.
            // Named "Sidebar" only until the first sync: the row toggles the
            // SECOND COLUMN, which is the Library at Home, Sketches in Sketch
            // and Private pages in the browser, so `menu_sync` retitles it to
            // whatever the reader is actually looking at. The static label is
            // the honest word for it with no room open, and it is never
            // "Library" — that is one destination's name for the column, and
            // the menu bar spent the whole redesign using it over the others.
            Row::Check {
                id: "view.library",
                label: "Sidebar",
                accel: Some("CmdOrCtrl+1"),
            },
            Row::Check {
                id: "view.assistant",
                label: "Assistant",
                accel: Some("CmdOrCtrl+2"),
            },
            Row::Check {
                id: "view.focus",
                label: "Focus the Workspace",
                accel: None,
            },
            Row::Separator,
            // Nested rather than listed flat, because "Focus the Workspace"
            // above and the "Focus" preset are different acts with the same
            // word in them. The in-app Layout menu separates them with group
            // headings; a native menu has no such thing, so the nesting is
            // what keeps the two apart.
            Row::Nested {
                label: "Layout",
                rows: &[
                    Row::Command {
                        id: "view.preset.focus",
                        label: "Focus",
                        accel: None,
                    },
                    Row::Command {
                        id: "view.preset.research",
                        label: "Research",
                        accel: None,
                    },
                    Row::Command {
                        id: "view.preset.review",
                        label: "Review",
                        accel: None,
                    },
                    Row::Separator,
                    Row::Command {
                        id: "view.reset",
                        label: "Reset Layout",
                        accel: None,
                    },
                ],
            },
            Row::Separator,
            // NOT "Show Sidebar Labels", which is what it read for a while.
            // "Sidebar" is already the ⌘1 row four lines up, and that row is
            // the SECOND column; this one is the rail, the first. One word
            // covering two columns inside one menu means a reader presses one
            // and changes the other. The rail's own accessible name has always
            // been "Destinations", so the menu uses the word the control
            // already answers to.
            Row::Check {
                id: "view.rail-labels",
                label: "Show Destination Names",
                accel: None,
            },
            Row::Separator,
            Row::Platform(Platform::Fullscreen),
        ],
    },
    Section {
        id: "window",
        label: Some("Window"),
        rows: &[
            Row::Platform(Platform::Minimize),
            Row::Platform(Platform::Zoom),
            // No Close Window row: ⌘W belongs to File → Close above, which
            // closes the active ITEM and falls back to closing the window when
            // there is none. Two rows both claiming ⌘W would give the key two
            // owners, and the predefined one always wins.
        ],
    },
];

/// Every id the app's own menus can raise, paired with the SECTION that
/// declares it, in menu order.
///
/// The pairing is what `menu_sync` needs and what it did without: it used to
/// look every id up inside the View submenu, which was correct only while View
/// was the one section with rows of ours. The File menu's ⌘T and ⌘W would have
/// been "missing" on every sync — and, being born disabled, would have stayed
/// grey for the life of the app.
pub(crate) fn gated_rows() -> Vec<(&'static str, &'static str)> {
    fn walk(section: &'static str, rows: &'static [Row], out: &mut Vec<(&'static str, &'static str)>) {
        for row in rows {
            match row {
                Row::Command { id, .. } | Row::Check { id, .. } => out.push((section, id)),
                Row::Nested { rows, .. } => walk(section, rows, out),
                Row::Platform(_) | Row::Separator => {}
            }
        }
    }
    let mut out = Vec::new();
    for section in APP {
        if section.id != VIEW_ID && section.id != FILE_ID {
            continue;
        }
        walk(section.id, section.rows, &mut out);
    }
    out
}

/// Every id the menus can raise, in menu order.
pub(crate) fn ids() -> Vec<&'static str> {
    gated_rows().into_iter().map(|(_, id)| id).collect()
}

// ------------------------------------------------------------- the builder

fn platform_item<R: Runtime>(
    app: &AppHandle<R>,
    which: Platform,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match which {
        Platform::About => {
            let pkg = app.package_info();
            let config = app.config();
            PredefinedMenuItem::about(
                app,
                None,
                Some(AboutMetadata {
                    name: Some(pkg.name.clone()),
                    version: Some(pkg.version.to_string()),
                    copyright: config.bundle.copyright.clone(),
                    authors: config.bundle.publisher.clone().map(|p| vec![p]),
                    ..Default::default()
                }),
            )
        }
        Platform::Services => PredefinedMenuItem::services(app, None),
        Platform::Hide => PredefinedMenuItem::hide(app, None),
        Platform::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Platform::ShowAll => PredefinedMenuItem::show_all(app, None),
        Platform::Undo => PredefinedMenuItem::undo(app, None),
        Platform::Redo => PredefinedMenuItem::redo(app, None),
        Platform::Cut => PredefinedMenuItem::cut(app, None),
        Platform::Copy => PredefinedMenuItem::copy(app, None),
        Platform::Paste => PredefinedMenuItem::paste(app, None),
        Platform::SelectAll => PredefinedMenuItem::select_all(app, None),
        Platform::Minimize => PredefinedMenuItem::minimize(app, None),
        Platform::Zoom => PredefinedMenuItem::maximize(app, None),
        Platform::CloseWindow => PredefinedMenuItem::close_window(app, None),
        Platform::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
    }
}

/// Build one row. Every custom row is born DISABLED — except the ones
/// [`always_enabled`] names: the menu bar exists before any room is open, and a
/// View menu that toggles panes in a window showing the password gate is a row
/// that cannot do what it says. `menu_sync` enables the section when a room
/// mounts and disables it again on the way out.
fn row_item<R: Runtime>(app: &AppHandle<R>, row: &'static Row) -> tauri::Result<MenuItemKind<R>> {
    Ok(match row {
        Row::Platform(which) => MenuItemKind::Predefined(platform_item(app, *which)?),
        Row::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        Row::Command { id, label, accel } => {
            MenuItemKind::MenuItem(MenuItem::with_id(app, *id, label, always_enabled(id), *accel)?)
        }
        Row::Check { id, label, accel } => {
            MenuItemKind::Check(CheckMenuItem::with_id(app, *id, label, false, false, *accel)?)
        }
        Row::Nested { label, rows } => {
            let sub = Submenu::new(app, *label, true)?;
            for row in *rows {
                sub.append(&row_item(app, row)?)?;
            }
            MenuItemKind::Submenu(sub)
        }
    })
}

/// The whole menu bar, ready for `set_menu`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for section in APP {
        let title = section.label.map(str::to_owned).unwrap_or_else(|| {
            // macOS draws the application menu with the app's name whatever
            // string is passed, but the string is what every other platform
            // shows — so pass the real one rather than a placeholder.
            app.package_info().name.clone()
        });
        let sub = Submenu::with_id(app, section.id, title, true)?;
        for row in section.rows {
            sub.append(&row_item(app, row)?)?;
        }
        menu.append(&sub)?;
    }
    Ok(menu)
}

/// Hand a menu row's id to the frontend.
///
/// Best-effort by construction: a menu press with no window to tell is a
/// no-op, not an error path. There is nothing useful to do about it and
/// nowhere to say it — the window IS the user interface.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, id: &str) {
    // Answered here, not by the window: the question is whether to exit at all,
    // and the window is the thing being exited. See [`QUIT_ID`] and [`quit`].
    // BEFORE the window lookup, so ⌘Q works at the start screen too.
    if id == QUIT_ID {
        quit(app);
        return;
    }
    // main_window, never get_webview_window — see the module header.
    let Some(window) = crate::main_window(app) else {
        return;
    };
    // ⌘W with no room open has no listener to reach: `useNativeMenu` — which
    // owns every row id on the other side — mounts with the workspace, so at
    // the start screen and the password gate the event would go nowhere and the
    // key would do nothing. Do here what the shell does as its own last case,
    // and what the predefined Close Window row this menu replaced always did.
    if id == CLOSE_ID && no_room_is_open(app) {
        let _ = window.close();
        return;
    }
    let _ = window.emit(MENU_EVENT, id.to_string());
}

/// ⌘Q, asked properly.
///
/// The hold is [`crate::commands::hold_quit_for_unsaved`]'s to decide and its
/// latch to keep, exactly as it was for `RunEvent::ExitRequested`: it answers
/// true at most once per dirty buffer, so a window that never replies still
/// quits on the second press. `None` for the code, because this IS the quit the
/// user asked for.
///
/// Every path that does not hold — nothing unsaved, already asked, or no window
/// left to ask — exits. `app.exit` carries a code, so the `ExitRequested` arm in
/// `lib.rs` passes it straight through to the teardown that saves the geometry
/// and flushes a live recording.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if crate::commands::hold_quit_for_unsaved(None) {
        if let Some(window) = crate::main_window(app) {
            let _ = window.emit(crate::commands::QUIT_REQUESTED, ());
            return;
        }
    }
    app.exit(0);
}

/// True only when we LOOKED and there was no room.
///
/// `try_lock`, never `lock`: this runs on the thread delivering the menu event,
/// and a room busy enough to hold its own mutex is a room that is open — so a
/// contended (or poisoned) lock answers false and the press goes to the
/// frontend exactly as it did before, which is the safe way round. Blocking
/// here would stall the menu behind whatever command holds the room.
fn no_room_is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return false;
    };
    let Ok(room) = state.room.try_lock() else {
        return false;
    };
    room.is_none()
}

// ------------------------------------------------------------ the frontend

/// What the View menu should be showing right now.
///
/// One payload rather than a `set_check(id, bool)` per row: the four ticks and
/// the enabled flag are one fact about one window, and sending them together
/// means the menu can never be caught halfway through a layout change. The
/// frontend sends it whenever any part changes, and once more with
/// `enabled: false` as the room unmounts.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewMenuState {
    /// False whenever no room is open — see `row_item`.
    pub enabled: bool,
    pub library: bool,
    pub assistant: bool,
    pub focus: bool,
    pub rail_labels: bool,
    /// False while the WINDOW, not the reader, is what took the sidebar's
    /// labels away. Below 1180px the rail drops them on its own and the
    /// preference cannot put them back, so the row would tick itself off and
    /// then refuse to tick back on. The rail's own expander hides for the same
    /// reason; a menu row cannot hide, so it greys out instead.
    pub rail_labels_settable: bool,
    /// What the ⌘1 row is called right now — the active destination's name for
    /// its second column. Empty falls back to the generic word rather than to
    /// any destination's, so a payload from an older frontend cannot leave the
    /// row claiming to toggle something it is not standing over.
    #[serde(default)]
    pub sidebar: String,
}

impl ViewMenuState {
    /// Each tick row as (id, checked, enabled).
    fn checks(&self) -> [(&'static str, bool, bool); 4] {
        [
            ("view.library", self.library, self.enabled),
            ("view.assistant", self.assistant, self.enabled),
            ("view.focus", self.focus, self.enabled),
            (
                "view.rail-labels",
                self.rail_labels,
                self.enabled && self.rail_labels_settable,
            ),
        ]
    }
}

/// What to write on the ⌘1 row.
///
/// The generic word, never a destination's, when the frontend has nothing to
/// say — with no room open there is no second column to name, and picking one
/// destination's word for it is how the row came to read "Library" while
/// standing over Memory in the first place.
fn sidebar_label(sent: &str) -> &str {
    let trimmed = sent.trim();
    if trimmed.is_empty() {
        "Sidebar"
    } else {
        trimmed
    }
}

/// Push the window's layout state onto the native View menu.
///
/// FAILURE BEHAVIOUR, decided: a tick is decoration on a control that already
/// worked. Nothing here may fail a caller — a platform with no menu bar, or a
/// menu that has not been installed, is a silent no-op — but an id in the
/// payload that the menu does not have is a wiring bug on our side, so that
/// one is logged. The frontend never sees an error either way.
#[tauri::command]
pub fn menu_sync<R: Runtime>(app: AppHandle<R>, view: ViewMenuState) {
    let Some(menu) = app.menu() else {
        return;
    };
    let submenu = |id: &str| {
        menu.get(id)
            .and_then(|section| section.as_submenu().cloned())
    };
    let (Some(view_menu), Some(file_menu)) = (submenu(VIEW_ID), submenu(FILE_ID)) else {
        return;
    };
    // Row by row, never the section. View holds two different lifetimes: the
    // rows below belong to the open room, but Toggle Full Screen belongs to the
    // WINDOW and is meaningful with no room at all. Disabling the submenu as a
    // unit greys the menu bar item itself, and macOS will not open a disabled
    // submenu — so gating the section took full screen away at the Start screen
    // and the password gate, which is exactly where someone sizing the window
    // reaches for it.
    let checks = view.checks();
    for (section_id, id) in gated_rows() {
        let section = if section_id == FILE_ID { &file_menu } else { &view_menu };
        let Some(item) = find(section, id) else {
            crate::obs::warn("menu_row_missing", &[("id", crate::obs::id(id))]);
            continue;
        };
        match item {
            MenuItemKind::Check(item) => {
                // Unreachable by `every_check_row_has_a_payload_field`, and a
                // warn rather than a default if it ever is: a tick left at
                // whatever it happened to be is a menu quietly lying about the
                // window.
                match checks.iter().find(|(row, _, _)| *row == id) {
                    Some((_, checked, enabled)) => {
                        let _ = item.set_checked(*checked);
                        let _ = item.set_enabled(*enabled);
                        if id == "view.library" {
                            let _ = item.set_text(sidebar_label(&view.sidebar));
                        }
                    }
                    None => crate::obs::warn("menu_check_unmapped", &[("id", crate::obs::id(id))]),
                }
            }
            // The rows that only act — presets, Reset, New — follow the
            // section; Close does not, because it can always close the window.
            MenuItemKind::MenuItem(item) => {
                let _ = item.set_enabled(view.enabled || always_enabled(id));
            }
            _ => {}
        }
    }
}

/// Find a row by id anywhere under `sub`, nested submenus included.
///
/// `Submenu::get` looks at its own direct children only, and the presets
/// deliberately live one level down inside Layout — so the obvious call
/// returns `None` for half the menu.
fn find<R: Runtime>(sub: &Submenu<R>, id: &str) -> Option<MenuItemKind<R>> {
    for item in sub.items().ok()? {
        if item.id().as_ref() == id {
            return Some(item);
        }
        if let MenuItemKind::Submenu(nested) = &item {
            if let Some(found) = find(nested, id) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows_of(id: &str) -> &'static [Row] {
        APP.iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| panic!("no {id} section"))
            .rows
    }

    fn platforms(rows: &'static [Row]) -> Vec<Platform> {
        rows.iter()
            .filter_map(|r| match r {
                Row::Platform(p) => Some(*p),
                _ => None,
            })
            .collect()
    }

    /// THE test this module exists for. `set_menu` replaces the stock menu, so
    /// an Edit submenu that loses a row takes that row's key equivalent with
    /// it — app-wide, including the password gate's passphrase field.
    #[test]
    fn spec_declares_the_clipboard_keys() {
        let edit = platforms(rows_of("edit"));
        for key in CLIPBOARD {
            assert!(
                edit.contains(key),
                "{key:?} is missing from the Edit submenu — its key equivalent \
                 would stop working in every text field in the app",
            );
        }
        assert!(edit.contains(&Platform::Undo) && edit.contains(&Platform::Redo));
    }

    /// The application menu is the other half of the same trap: without these
    /// there is no About, no Services, no Hide — and no ⌘Q.
    #[test]
    fn spec_declares_the_application_menu() {
        let app = platforms(rows_of("app"));
        for item in [
            Platform::About,
            Platform::Services,
            Platform::Hide,
            Platform::HideOthers,
        ] {
            assert!(app.contains(&item), "{item:?} is missing from the app menu");
        }
    }

    /// ⌘Q IS OURS, and it has to be — see [`QUIT_ID`].
    ///
    /// The row this replaced was `PredefinedMenuItem::quit`, which muda wires
    /// to `terminate:`. tao implements `applicationWillTerminate:` and NOT
    /// `applicationShouldTerminate:`, so that row raised no
    /// `RunEvent::ExitRequested` at all: the unsaved-edits door in `shell_exit`
    /// could not fire on the one exit it was written for, and Quit threw an
    /// edited note away without a word. This test is the only thing standing
    /// between that row and a well-meaning "use the platform item" cleanup.
    #[test]
    fn quit_is_a_row_of_ours_because_the_platform_row_cannot_be_asked_a_question() {
        let quit = rows_of("app")
            .iter()
            .find_map(|r| match r {
                Row::Command { id, accel, .. } if *id == QUIT_ID => Some(*accel),
                _ => None,
            })
            .expect("the Quit row is not ours — unsaved edits go out with the process");
        assert_eq!(quit, Some("CmdOrCtrl+Q"));
        // Born enabled, like Close: the start screen and the password gate are
        // windows too, and a ⌘Q that does nothing there would be worse than the
        // bug this row fixes.
        assert!(always_enabled(QUIT_ID));
        // ...and it is NOT a gated row, so `menu_sync` never greys it and the
        // frontend is never asked to handle it — `dispatch` answers it in Rust,
        // because the answer is "hold the exit", which no window can decide.
        assert!(!ids().contains(&QUIT_ID));
    }

    /// The label is a literal where the platform row read the app's own name,
    /// so a rename would leave the Apple menu saying Quit <the old product>.
    /// The app has been renamed once already (Private Room → Arcelle).
    #[test]
    fn the_quit_row_is_named_after_the_app_it_quits() {
        let conf = include_str!("../tauri.conf.json");
        let product = conf
            .split("\"productName\"")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .expect("tauri.conf.json has no productName");
        let label = rows_of("app")
            .iter()
            .find_map(|r| match r {
                Row::Command { id, label, .. } if *id == QUIT_ID => Some(*label),
                _ => None,
            })
            .expect("no Quit row");
        assert_eq!(label, format!("Quit {product}"));
    }

    #[test]
    fn ids_are_unique_and_namespaced() {
        let mut seen = std::collections::HashSet::new();
        for (section, id) in gated_rows() {
            assert!(seen.insert(id), "duplicate menu id {id}");
            // An id names the menu it lives in, so a stray row cannot be
            // synced (or handled) as though it belonged to the other one.
            assert!(
                id.starts_with(&format!("{section}.")),
                "{id} is not in the {section} namespace"
            );
        }
        assert_eq!(
            gated_rows().len(),
            10,
            "a row was added or removed — check the frontend maps too"
        );
    }

    /// ⌘W is macOS's "close this window", and the start screen and the
    /// password gate are windows. This menu REPLACED the predefined Close
    /// Window row that owned the key unconditionally, so gating our Close row
    /// with the room left ⌘W doing nothing whatever with no room open — not
    /// closing the window, not anything. It is the one row that survives the
    /// gate, in `row_item` and in `menu_sync` alike, and `dispatch` gives it
    /// its meaning there because the frontend's handler mounts with the room.
    #[test]
    fn close_is_the_one_row_the_room_gate_leaves_alone() {
        assert!(always_enabled(CLOSE_ID));
        for id in ids() {
            assert_eq!(
                always_enabled(id),
                id == CLOSE_ID,
                "{id} disagrees with the gate about whether it needs a room",
            );
        }
        let close = rows_of(FILE_ID)
            .iter()
            .find_map(|r| match r {
                Row::Command { id, accel, .. } if *id == CLOSE_ID => Some(*accel),
                _ => None,
            })
            .expect("the Close row is gone — ⌘W has no owner at all now");
        assert_eq!(close, Some("CmdOrCtrl+W"));
    }

    /// ⌘1 and ⌘2 have exactly one owner, and it is this file. The matching
    /// half of this invariant — that useLayout no longer claims them — is
    /// asserted in e2e/page-script/nativeMenu.test.mjs, which can read the
    /// TypeScript this test cannot.
    #[test]
    fn the_pane_keys_are_declared_once_each() {
        let accels: Vec<_> = rows_of(VIEW_ID)
            .iter()
            .filter_map(|r| match r {
                Row::Check { id, accel, .. } | Row::Command { id, accel, .. } => {
                    accel.map(|a| (*id, a))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            accels,
            vec![
                ("view.library", "CmdOrCtrl+1"),
                ("view.assistant", "CmdOrCtrl+2"),
            ],
        );
    }

    fn a_state() -> ViewMenuState {
        ViewMenuState {
            enabled: true,
            library: true,
            assistant: false,
            focus: false,
            rail_labels: true,
            rail_labels_settable: true,
            sidebar: "Sketches".into(),
        }
    }

    /// The ⌘1 row is named after the column it toggles, and that column is a
    /// different thing in each destination. With nothing to go on it must fall
    /// back to the generic word — never to one destination's name for it, which
    /// is how the row came to read "Library" while standing over Memory.
    #[test]
    fn the_sidebar_row_never_borrows_one_destinations_name() {
        assert_eq!(sidebar_label("Sketches"), "Sketches");
        assert_eq!(sidebar_label(""), "Sidebar");
        assert_eq!(sidebar_label("   "), "Sidebar");
        assert_eq!(sidebar_label("  Private pages "), "Private pages");
        let static_label = rows_of(VIEW_ID)
            .iter()
            .find_map(|r| match r {
                Row::Check { id, label, .. } if *id == "view.library" => Some(*label),
                _ => None,
            })
            .expect("the ⌘1 row");
        assert_ne!(static_label, "Library");
    }

    /// Add a tick row to the spec and forget its field in the payload and the
    /// row goes stale silently — it keeps whatever it was last set to while
    /// the window says otherwise. This is the test that makes that impossible.
    #[test]
    fn every_check_row_has_a_payload_field() {
        let mapped: std::collections::HashSet<_> =
            a_state().checks().iter().map(|(id, _, _)| *id).collect();
        let declared: std::collections::HashSet<_> = rows_of(VIEW_ID)
            .iter()
            .filter_map(|r| match r {
                Row::Check { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(declared, mapped);
    }

    /// The sidebar-labels row greys out when the WINDOW is what took the
    /// labels away, because the preference cannot put them back at that width
    /// — the same reason the rail's own expander hides.
    #[test]
    fn the_labels_row_greys_out_when_the_window_owns_it() {
        let stuck = ViewMenuState {
            rail_labels_settable: false,
            ..a_state()
        };
        let enabled = |s: &ViewMenuState| {
            s.checks()
                .iter()
                .find(|(id, _, _)| *id == "view.rail-labels")
                .map(|(_, _, on)| *on)
                .unwrap()
        };
        assert!(enabled(&a_state()));
        assert!(!enabled(&stuck));
        // …and a closed room greys out every row, that one included.
        let no_room = ViewMenuState {
            enabled: false,
            ..a_state()
        };
        assert!(no_room.checks().iter().all(|(_, _, on)| !on));
    }

    /// View is the one section holding rows with two different lifetimes, and
    /// that is the whole reason `menu_sync` gates it row by row rather than as
    /// a unit. It did gate the section once: every row went dim with no room
    /// open, which reads correct until you notice Toggle Full Screen went with
    /// them — and a disabled submenu will not even open, so the menu bar item
    /// itself died at the Start screen and the gate.
    ///
    /// What is provable here is the shape underneath: the rows `menu_sync`
    /// reaches are exactly the room's, and no window command is among them.
    /// That the section itself is left alone is a one-line fact at the call
    /// site, and the behaviour is a manual row in the UA checklist §7c —
    /// AppKit is the only thing that can answer whether a menu opens.
    #[test]
    fn the_view_section_mixes_window_commands_with_room_ones() {
        let view = APP
            .iter()
            .find(|s| s.id == VIEW_ID)
            .expect("the View section is gone");
        let mut window_commands = 0;
        let mut room_rows = 0;
        for row in view.rows {
            match row {
                Row::Platform(_) => window_commands += 1,
                Row::Command { .. } | Row::Check { .. } | Row::Nested { .. } => room_rows += 1,
                Row::Separator => {}
            }
        }
        assert!(
            window_commands >= 1 && room_rows >= 1,
            "if View ever holds only one kind of row this test has stopped \
             saying anything, and gating the section becomes safe again"
        );
        // Nothing the sync touches is a window command: every id it walks is
        // declared by a Command or a Check, which are the room's rows.
        let governed: Vec<&str> = ids().to_vec();
        let mut declared: Vec<&str> = Vec::new();
        fn walk<'a>(rows: &'a [Row], out: &mut Vec<&'a str>) {
            for row in rows {
                match row {
                    Row::Command { id, .. } | Row::Check { id, .. } => out.push(id),
                    Row::Nested { rows, .. } => walk(rows, out),
                    Row::Platform(_) | Row::Separator => {}
                }
            }
        }
        walk(view.rows, &mut declared);
        // The File menu's two rows are governed by the same sync and declared
        // the same way; the point of this test is that the sync never reaches a
        // PLATFORM row, not that View is the only gated section.
        let file = APP.iter().find(|s| s.id == FILE_ID).expect("a File section");
        walk(file.rows, &mut declared);
        declared.sort();
        let mut governed = governed;
        governed.sort();
        assert_eq!(governed, declared);
    }

    // THE TRAP FROM BROWSE-1 IS ALREADY GUARDED, and not from here. This
    // module first grew its own scanner for the banned webview-scoped lookup
    // before `browser.rs`'s
    // `the_browser_is_a_second_webview_so_the_window_lookup_must_not_be_scoped`
    // turned out to do the same job over the WHOLE crate — every file, not
    // just this one — and to have solved the two problems a second copy hits:
    // it skips comment lines, so the prose in this module's header does not
    // report itself, and it composes the needle rather than writing it, so the
    // scanner does not report its own source. One scanner, whole crate.
}
