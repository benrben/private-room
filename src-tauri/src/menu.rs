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
    Quit,
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
            Row::Platform(Platform::Quit),
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
            Row::Check {
                id: "view.library",
                label: "Library",
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
            Row::Check {
                id: "view.rail-labels",
                label: "Show Sidebar Labels",
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
            Row::Separator,
            Row::Platform(Platform::CloseWindow),
        ],
    },
];

/// Every id the View menu can raise, in menu order.
pub(crate) fn ids() -> Vec<&'static str> {
    fn walk(rows: &'static [Row], out: &mut Vec<&'static str>) {
        for row in rows {
            match row {
                Row::Command { id, .. } | Row::Check { id, .. } => out.push(id),
                Row::Nested { rows, .. } => walk(rows, out),
                Row::Platform(_) | Row::Separator => {}
            }
        }
    }
    let mut out = Vec::new();
    for section in APP {
        walk(section.rows, &mut out);
    }
    out
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
        Platform::Quit => PredefinedMenuItem::quit(app, None),
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

/// Build one row. Every custom row is born DISABLED: the menu bar exists
/// before any room is open, and a View menu that toggles panes in a window
/// showing the password gate is a row that cannot do what it says. `menu_sync`
/// enables the section when a room mounts and disables it again on the way
/// out.
fn row_item<R: Runtime>(app: &AppHandle<R>, row: &'static Row) -> tauri::Result<MenuItemKind<R>> {
    Ok(match row {
        Row::Platform(which) => MenuItemKind::Predefined(platform_item(app, *which)?),
        Row::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        Row::Command { id, label, accel } => {
            MenuItemKind::MenuItem(MenuItem::with_id(app, *id, label, false, *accel)?)
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
    // main_window, never get_webview_window — see the module header.
    if let Some(window) = crate::main_window(app) {
        let _ = window.emit(MENU_EVENT, id.to_string());
    }
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

/// Push the window's layout state onto the native View menu.
///
/// FAILURE BEHAVIOUR, decided: a tick is decoration on a control that already
/// worked. Nothing here may fail a caller — a platform with no menu bar, or a
/// menu that has not been installed, is a silent no-op — but an id in the
/// payload that the menu does not have is a wiring bug on our side, so that
/// one is logged. The frontend never sees an error either way.
#[tauri::command]
pub fn menu_sync<R: Runtime>(app: AppHandle<R>, view: ViewMenuState) {
    let Some(section) = app.menu().and_then(|m| m.get(VIEW_ID)) else {
        return;
    };
    let Some(section) = section.as_submenu().cloned() else {
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
    for id in ids() {
        let Some(item) = find(&section, id) else {
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
                    }
                    None => crate::obs::warn("menu_check_unmapped", &[("id", crate::obs::id(id))]),
                }
            }
            // The rows that only act — presets and Reset — follow the section.
            MenuItemKind::MenuItem(item) => {
                let _ = item.set_enabled(view.enabled);
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
            Platform::Quit,
        ] {
            assert!(app.contains(&item), "{item:?} is missing from the app menu");
        }
    }

    #[test]
    fn ids_are_unique_and_namespaced() {
        let ids = ids();
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(seen.insert(*id), "duplicate menu id {id}");
            assert!(id.starts_with("view."), "{id} is not in the view namespace");
        }
        assert_eq!(ids.len(), 8, "a row was added or removed — check the frontend map too");
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
        }
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
