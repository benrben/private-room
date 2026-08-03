//! Item #18: the private browser, for a keyboard and a screen reader.
//!
//! # Why this exists at all
//!
//! The page is a NATIVE child `WKWebView` — a sibling view of the app's own
//! webview, with its own process, its own first responder and its own
//! accessibility tree. Nothing the React side renders can be drawn over it,
//! nothing it contains can be reached from the host DOM, and no key pressed
//! inside it is ever delivered to the app. So the two things a screen-reader
//! user needs — the page's content, and a way back out of it — cannot come
//! from the host tree at all. They have to be fetched from the page and handed
//! back.
//!
//! Both commands here are thin wrappers over machinery that already exists and
//! is already tested: [`browser::call`]'s `read` op (the same extractor
//! `browse_read` and `browse_save` use) and `Webview::set_focus`.
//!
//! # The doors, and why none of them apply
//!
//! * No `require_web_enabled` — this reads a page that is ALREADY loaded and
//!   fetches nothing, exactly the reasoning written for `browser_save_page`.
//! * No `check_takeover` — that guard refuses the AGENT's actions while the
//!   user has the wheel. The reader IS the user, and it only reads.
//! * No journal row — the journal's contract is "everything the agent did"
//!   (`browser.rs`), and a person reading the page they are looking at is not
//!   the agent. A sighted user's eyes are not journalled either.

use super::*;
use crate::browser;

/// Below this, in either dimension, the page's own layout is not the layout
/// anyone is looking at.
///
/// `BrowserView` parks the native view at 1×1 whenever a modal is up or the
/// results page is showing, and a `WKWebView`'s layout viewport IS its frame:
/// at one CSS pixel wide an article reflows to tens of thousands of pixels
/// tall, and the extractor's own visibility rule (`isVisible`, which rejects
/// anything more than 4000px below the viewport) then drops almost all of it.
/// The `read` op still answers `ok: true` with a fragment, which is precisely
/// the shape of failure this whole feature is built against — the text-channel
/// twin of the parked screenshot `png_too_small_to_see` already refuses.
const MIN_READABLE_PX: f64 = 200.0;

/// Is the page too small on screen for what it reports about itself to be
/// true? Pure so the refusal can be tested without a webview.
fn too_small_to_read(b: browser::Bounds) -> bool {
    b.width < MIN_READABLE_PX || b.height < MIN_READABLE_PX
}

/// How long to let the stage's real rect arrive before refusing.
///
/// Opening the reading view shrinks the stage and the view pushes the new rect
/// through `browser_set_bounds` WITHOUT waiting for it, so the reader's very
/// first read can land while Rust still holds the parked rect from whatever
/// was covering the page a moment ago. Refusing then would fail the one case
/// the feature exists for, and the caller has no way to tell that refusal from
/// a real one.
const BOUNDS_SETTLE: Duration = Duration::from_millis(1500);
const BOUNDS_POLL: Duration = Duration::from_millis(60);

const PARKED_REFUSAL: &str =
    "The page is shrunk off screen right now, so what it reports about itself \
     would only be a fragment. Close whatever is covering the browser and try \
     again.";

/// The current page as text, for the reading view.
///
/// Returned RAW rather than formatted: the view follows `nextOffset` and
/// `truncated` itself so it can say "showing the first N of M characters"
/// instead of quietly presenting a slice as the whole page.
#[tauri::command]
pub async fn browser_page_text(
    app: tauri::AppHandle,
    mode: String,
    offset: u64,
) -> Result<serde_json::Value, String> {
    if !browser::is_open(&app) {
        return Err("The browser isn't open — there is no page to read.".into());
    }
    let settle = std::time::Instant::now();
    while too_small_to_read(browser::bounds(&app)) {
        if settle.elapsed() > BOUNDS_SETTLE {
            return Err(PARKED_REFUSAL.into());
        }
        tokio::time::sleep(BOUNDS_POLL).await;
    }
    browser::wait_ready(&app, READY_BUDGET_OPEN).await?;
    let mode = if mode == "full" { "full" } else { "main" };
    browser::call(
        &app,
        "read",
        serde_json::json!({ "mode": mode, "offset": offset }),
    )
    .await
}

/// Hand the keyboard back to the app.
///
/// The child webview holds the window's first responder while it has focus,
/// and the app's own webview cannot take it back by asking nicely from
/// JavaScript — they are different native views. `set_focus` on the main
/// webview is `makeFirstResponder`, which is the one call that actually moves
/// it. Without this, a keyboard user who tabs into the page is stuck there.
#[tauri::command]
pub fn browser_focus_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::main_webview(&app)
        .ok_or_else(|| "The app window is gone.".to_string())?
        .set_focus()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parked_page_is_refused_rather_than_read() {
        // What `BrowserView` sends while a modal is up, and what Rust falls
        // back to before the area has ever measured itself.
        assert!(too_small_to_read(browser::Bounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0
        }));
    }

    #[test]
    fn a_narrow_but_real_stage_is_readable() {
        // The reading view shrinks the stage instead of parking it, exactly as
        // the journal panel does, so the page keeps a real layout viewport.
        // That has to stay on the readable side of the line or the reader
        // would refuse to read the very page it just made room for.
        assert!(!too_small_to_read(browser::Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 600.0
        }));
    }

    #[test]
    fn a_full_width_but_flattened_stage_is_still_refused() {
        // Height matters as much as width: a stage collapsed to a sliver
        // reflows the page just as badly, and `sane()` only clamps to 1px.
        assert!(too_small_to_read(browser::Bounds {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 4.0
        }));
    }
}
