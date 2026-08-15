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

/// Everything both readers must be sure of before they believe a word the page
/// says: there is a page, it is on screen at a real size, and its script is up.
///
/// One helper rather than two copies — the whole point of the size check is
/// that a page reporting on itself from a 1×1 layout viewport answers `ok:true`
/// with a fragment, and a second copy of that rule is a second chance to get it
/// subtly different.
async fn ready_to_be_read(app: &tauri::AppHandle) -> Result<(), String> {
    if !browser::is_open(app) {
        return Err("The browser isn't open — there is no page to read.".into());
    }
    let settle = std::time::Instant::now();
    while too_small_to_read(browser::bounds(app)) {
        if settle.elapsed() > BOUNDS_SETTLE {
            return Err(PARKED_REFUSAL.into());
        }
        tokio::time::sleep(BOUNDS_POLL).await;
    }
    browser::wait_ready(app, READY_BUDGET_OPEN).await
}

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
    ready_to_be_read(&app).await?;
    let mode = if mode == "full" { "full" } else { "main" };
    browser::call(
        &app,
        "read",
        serde_json::json!({ "mode": mode, "offset": offset }),
    )
    .await
}

/// What the page script answers `capture` with when the user has selected
/// nothing. Kept as a constant here because it is the ONE page-script error
/// this command must not pass on as a failure — `browser_page_selection` turns
/// it into an empty answer, and a rename on either side would silently turn
/// "nothing is selected" back into "the page refused".
const NOTHING_SELECTED: &str = "Nothing is selected on the page.";

/// How much selected text comes back.
///
/// The page script's own `capture` cap is 800 KB, which is sized for a room
/// FILE. This is the reading path, so it takes the reading cap: `READ_MAX`,
/// the same 40,000 characters one `read` slice returns. Counted here in Rust
/// `char`s where the page counts UTF-16 units, so the two agree on ordinary
/// text and differ only on how much astral-plane text rides under one cap —
/// which is a bound on a passage, not a byte budget.
const SELECTION_MAX: usize = 40_000;

/// The user's current selection, as text. READ-ONLY: nothing is written, and
/// nothing is journalled.
///
/// The selection has been capturable since BROWSE-2, but only through
/// `browser_save_page`, which writes a file into the room and answers with a
/// sentence about it — so "what has the user got selected" was a question the
/// app could only answer by SAVING it. This is the same `capture` op with
/// neither the file nor the journal row: the module's rule is that a person
/// reading the page they are looking at is not the agent, and `capture_and_save`
/// journals because SAVING is an act, not because reading is.
///
/// An empty `text` means nothing is selected — an honest empty answer, not an
/// error. A page that genuinely refused the read still fails, so the caller can
/// tell the two apart.
#[tauri::command]
pub async fn browser_page_selection(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    ready_to_be_read(&app).await?;
    let captured = browser::call(&app, "capture", serde_json::json!({ "what": "selection" })).await;
    let v = match captured {
        Ok(v) => v,
        Err(e) if e == NOTHING_SELECTED => return Ok(empty_selection()),
        Err(e) => return Err(e),
    };
    let (text, clipped) = clip_selection(
        v.get("text").and_then(|t| t.as_str()).unwrap_or_default(),
        v.get("truncated").and_then(|t| t.as_bool()) == Some(true),
    );
    // The page script measures the WHOLE selection; both caps below it are ours
    // or its own. Carried through so a caller showing a clipped passage can say
    // how much it is leaving out rather than implying it has all of it.
    let total = v
        .get("total")
        .and_then(|t| t.as_u64())
        .unwrap_or(text.chars().count() as u64);
    Ok(serde_json::json!({
        "text": text,
        "url": v.get("url").and_then(|u| u.as_str()).unwrap_or_default(),
        "title": v.get("title").and_then(|t| t.as_str()).unwrap_or_default(),
        "truncated": clipped,
        "total": total,
    }))
}

/// Nothing selected: the shape is the same one, so the caller reads `text`
/// either way instead of branching on which kind of answer it got.
fn empty_selection() -> serde_json::Value {
    serde_json::json!({ "text": "", "url": "", "title": "", "truncated": false, "total": 0 })
}

/// The selection, cut to the reading cap, and whether anything was cut.
///
/// `page_clipped` is the page script's own flag: it clips at its far larger
/// save cap first, and either cut means the caller is holding PART of a
/// passage. Presenting part of a passage as the passage is the failure this app
/// keeps writing tests about, so the flag travels with the text.
fn clip_selection(text: &str, page_clipped: bool) -> (String, bool) {
    let kept: String = text.chars().take(SELECTION_MAX).collect();
    let clipped = page_clipped || kept.chars().count() < text.chars().count();
    (kept, clipped)
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

    /// Nothing selected is an ANSWER, not a failure. It reaches Rust as the
    /// page script's `ok:false`, which `browser::call` turns into an `Err` —
    /// so the one error that means "the user has not selected anything" has to
    /// be recognised and converted, and the two sides must keep saying the same
    /// words. Everything else the page refuses still fails, which is how the
    /// caller tells "nothing selected" from "this page cannot be read".
    #[test]
    fn nothing_selected_is_an_empty_answer_not_a_refusal() {
        assert!(
            browser::PAGE_JS.contains(NOTHING_SELECTED),
            "the page script no longer says what this command listens for — an \
             empty selection would surface as a page failure"
        );
        let empty = empty_selection();
        assert_eq!(empty["text"], "");
        assert_eq!(empty["truncated"], false);
        // The shape is the same either way, so the caller never branches on
        // which KIND of answer it got — only on whether there is any text.
        for key in ["text", "url", "title", "truncated"] {
            assert!(empty.get(key).is_some(), "the empty answer is missing {key}");
        }
    }

    /// The selection takes the READING cap, not the 800 KB save cap — this
    /// feeds a chat scope, not a room file — and a passage that was cut says so
    /// rather than passing a slice off as the whole passage.
    #[test]
    fn a_long_selection_is_cut_at_the_reading_cap_and_admits_it() {
        let (text, clipped) = clip_selection("a short passage", false);
        assert_eq!(text, "a short passage");
        assert!(!clipped);
        // Exactly at the cap is NOT truncated — the boundary case that would
        // otherwise warn about a passage that came back whole.
        let exact = "x".repeat(SELECTION_MAX);
        let (text, clipped) = clip_selection(&exact, false);
        assert_eq!(text.chars().count(), SELECTION_MAX);
        assert!(!clipped);
        // One character past it is.
        let (text, clipped) = clip_selection(&"x".repeat(SELECTION_MAX + 1), false);
        assert_eq!(text.chars().count(), SELECTION_MAX);
        assert!(clipped);
        // The page's own clip counts too, even when what arrived is short.
        assert!(clip_selection("tiny", true).1);
        // Multi-byte text is cut on CHARACTER boundaries — slicing bytes would
        // panic on the first emoji anyone selects.
        let wide = "é🙂".repeat(SELECTION_MAX);
        let (text, clipped) = clip_selection(&wide, false);
        assert_eq!(text.chars().count(), SELECTION_MAX);
        assert!(clipped);
        // …and the cap is the reader's own, borrowed rather than invented.
        assert!(
            browser::PAGE_JS.contains(&format!("var READ_MAX = {SELECTION_MAX}")),
            "the selection cap has drifted from the page script's read cap"
        );
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
