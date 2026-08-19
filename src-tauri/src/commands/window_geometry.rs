//! Where the window was, and how big — remembered between launches.
//!
//! Every launch reopened at the configured 1180×780 in the default position, no
//! matter how the user had it arranged. For a workspace app people keep open
//! all day on a large display that is a chore repeated every single time.
//!
//! Kept per-Mac, beside the connector preference files and outside every room:
//! a window rectangle is a fact about this machine's screens, not about the
//! room, and nothing about it may travel inside a `.roomai`.
//!
//! WHY NOT `tauri-plugin-window-state`: it would be a new dependency on the
//! supply chain for ~60 lines of arithmetic, and it restores state the app has
//! no way to sanity-check. The one thing that MUST be checked is the case that
//! makes this feature worse than not having it: a window remembered on a
//! monitor that is no longer attached opens off-screen, where it cannot be
//! moved, resized or closed.

use super::*;

/// The remembered rectangle, in physical pixels (what tao reports and takes).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub(crate) struct Geometry {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// The last geometry seen from a window event. Written to disk on the way out
/// rather than on every event: dragging a window emits hundreds of them, and a
/// file write per frame is not worth the fidelity.
fn last_seen() -> &'static Mutex<Option<Geometry>> {
    static CELL: OnceLock<Mutex<Option<Geometry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn geometry_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("window.json"))
}

/// A monitor's own rectangle, in the same coordinate space.
pub(crate) type Screen = (i32, i32, u32, u32);

/// The minimums from `tauri.conf.json` (`minWidth`/`minHeight`). A remembered
/// size below them is a corrupt or hand-edited file, not a user preference.
const MIN_W: u32 = 900;
const MIN_H: u32 = 600;
/// How much of the title bar has to land on a real screen for the window to be
/// reachable. Enough to grab and drag, not so much that a deliberately
/// half-off-screen window is refused.
const GRABBABLE: i32 = 80;

/// Can this remembered rectangle actually be USED on the screens attached now?
///
/// This is the whole reason for hand-rolling the feature. Restoring a window
/// onto a monitor that has since been unplugged — or onto a docked display the
/// laptop is no longer docked to — puts it somewhere the user cannot see, drag
/// or close, and the app looks like it failed to launch. Refusing to restore is
/// always recoverable; restoring off-screen is not.
pub(crate) fn geometry_is_usable(g: &Geometry, screens: &[Screen]) -> bool {
    if g.width < MIN_W || g.height < MIN_H {
        return false;
    }
    // A degenerate saved width would wrap when added; treat any rectangle we
    // cannot reason about as unusable rather than reasoning about it anyway.
    let Ok(w) = i32::try_from(g.width) else {
        return false;
    };
    // Only the TITLE BAR matters. A window can hang off the bottom or the right
    // of a screen and still be perfectly usable; what makes it unrecoverable is
    // having nothing left to grab.
    screens.iter().any(|&(sx, sy, sw, sh)| {
        let (Ok(sw), Ok(sh)) = (i32::try_from(sw), i32::try_from(sh)) else {
            return false;
        };
        let overlap_x = (g.x + w).min(sx + sw) - g.x.max(sx);
        g.y >= sy - 1 && g.y < sy + sh && overlap_x >= GRABBABLE
    })
}

/// Remember the rectangle a window event just reported. Cheap by design: this
/// runs on every move and resize.
///
/// Full screen is NOT a rectangle worth remembering: entering it emits a
/// `Resized` for the whole display, and quitting from there would relaunch the
/// app as a display-sized window parked in the corner, with the arrangement the
/// user actually chose overwritten and gone. Skipping the note leaves the last
/// NORMAL-state rectangle as the one written on the way out.
pub(crate) fn note_geometry(window: &tauri::Window) {
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    *last_seen().lock().unwrap() = Some(Geometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    });
}

/// Write what was last seen. Best-effort: failing to remember a window position
/// must never be able to fail a quit.
pub(crate) fn save_geometry(app: &tauri::AppHandle) {
    let Some(g) = *last_seen().lock().unwrap() else {
        return;
    };
    let (Ok(path), Ok(json)) = (geometry_file(app), serde_json::to_string(&g)) else {
        return;
    };
    let _ = std::fs::write(path, json);
}

/// Put the window back where it was, if that is still somewhere it can be used.
/// Silent on every failure — a missing, unreadable or unusable file means "open
/// at the configured default", which is exactly the old behaviour.
pub(crate) fn restore_geometry(app: &tauri::AppHandle) {
    let Some(window) = crate::main_window(app) else {
        return;
    };
    let Some(g) = geometry_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Geometry>(&raw).ok())
    else {
        return;
    };
    let screens: Vec<Screen> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    if screens.is_empty() || !geometry_is_usable(&g, &screens) {
        return;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(g.width, g.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(g.x, g.y));
    // Seed the cache so quitting without ever moving the window still rewrites
    // the same rectangle rather than dropping it.
    *last_seen().lock().unwrap() = Some(g);
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Screen = (0, 0, 1728, 1117);
    const EXTERNAL: Screen = (1728, -400, 2560, 1440);

    #[test]
    fn a_window_remembered_on_an_unplugged_monitor_is_not_restored() {
        // THE failure this guard exists for: restore the rectangle from a
        // docked session onto an undocked laptop and the window opens where it
        // cannot be seen, dragged or closed — and the app reads as broken.
        let docked = Geometry { x: 2000, y: -200, width: 1400, height: 900 };
        assert!(geometry_is_usable(&docked, &[LAPTOP, EXTERNAL]));
        assert!(
            !geometry_is_usable(&docked, &[LAPTOP]),
            "the external monitor is gone — opening there is unrecoverable"
        );
    }

    #[test]
    fn only_a_grabbable_window_is_restored() {
        // Mostly off the right edge, but the title bar is still catchable.
        let edge = Geometry { x: 1600, y: 40, width: 1000, height: 700 };
        assert!(geometry_is_usable(&edge, &[LAPTOP]));
        // Past it: nothing left to grab.
        let gone = Geometry { x: 1700, y: 40, width: 1000, height: 700 };
        assert!(!geometry_is_usable(&gone, &[LAPTOP]));
        // Title bar above every screen — the classic "dragged under the menu
        // bar and saved" rectangle.
        let above = Geometry { x: 100, y: -500, width: 1000, height: 700 };
        assert!(!geometry_is_usable(&above, &[LAPTOP]));
    }

    #[test]
    fn a_size_below_the_windows_own_minimum_is_refused() {
        // tauri.conf.json declares minWidth 900 / minHeight 600. A smaller
        // saved size is a corrupt file, and restoring it would produce a window
        // the layout was never built for.
        let tiny = Geometry { x: 10, y: 10, width: 200, height: 150 };
        assert!(!geometry_is_usable(&tiny, &[LAPTOP]));
        let ok = Geometry { x: 10, y: 10, width: 900, height: 600 };
        assert!(geometry_is_usable(&ok, &[LAPTOP]));
        // No screens at all (a headless or mid-wake state) can never be usable.
        assert!(!geometry_is_usable(&ok, &[]));
    }
}
