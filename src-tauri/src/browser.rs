//! BROWSE-1: the private browser — a child webview the agent can drive.
//!
//! # Why a child webview and not an engine
//!
//! Arcelle already links WKWebView (ADD-25 snapshots), so the browser area
//! costs zero added bytes and renders exactly what Safari renders. The
//! alternatives were measured and rejected in
//! `pm-request/browser-mode-research-2026-07-29.md`: Servo cannot render the
//! real web yet (62% WPT), CEF costs ~100 MB plus helper-bundle signing, and
//! Lightpanda has no rendering layer at all.
//!
//! # The three invariants
//!
//! 1. **Nothing about the web is persisted.** The webview is built with
//!    `incognito(true)`, which wry maps to
//!    `WKWebsiteDataStore::nonPersistentDataStore` — no history, cookies,
//!    cache or form data ever reaches the disk. [`verify_ephemeral`] asserts
//!    this against the live webview rather than trusting the flag, because the
//!    failure is silent: had we supplied our own `WKWebViewConfiguration`, wry
//!    would ignore `incognito` and quietly use the DEFAULT persistent store.
//!
//! 2. **Everything the AGENT does is journaled.** The web leaves no trace; the
//!    agent's conduct leaves a complete one, inside the encrypted room. See
//!    [`journal`].
//!
//! 3. **The browser is never a path to this Mac.** Every top-level navigation
//!    passes the same literal check `fetch_page` uses
//!    ([`crate::web::check_public_http_url`]), and sub-resources — which
//!    `on_navigation` never sees — are blocked at the network layer by the
//!    private-range rules in [`rules`]. Agent-initiated navigation
//!    additionally resolves the host (DNS) before loading, which the
//!    synchronous navigation hook cannot afford to do on the main thread.
//!
//! # Transport
//!
//! Tauri's IPC cannot reach an arbitrary remote origin (capabilities allowlist
//! specific domains, and "every site" is not a domain), so the agent transport
//! is: [`page.js`] injected at document start into every frame, plus
//! `evaluateJavaScript` from Rust. `WKWebView.evaluateJavaScript` neither
//! awaits promises nor reports exceptions — wry's completion handler cannot
//! distinguish `undefined` from `throw`, both arrive as an empty string — so
//! the page script is total (never throws) and async work crosses the boundary
//! as a ticket that [`call_async`] polls.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, Webview, Wry};

mod rules;

pub use rules::{rules_json, RULE_LIST_ID};

/// Label PREFIX for a page's child webview — the full label is
/// `arcelle-browser-<id>`. One webview per open page.
pub const BROWSER_LABEL: &str = "arcelle-browser";

fn label_of(id: &str) -> String {
    format!("{BROWSER_LABEL}-{id}")
}

/// How many pages may be open at once.
///
/// Each one is a real WKWebView holding a real render tree — 50-150 MB on a
/// heavy page. The cap REFUSES a ninth page rather than quietly closing one the
/// user was reading: a silently discarded page is exactly the kind of surprise
/// the rest of this app goes out of its way not to spring.
const MAX_TABS: usize = 8;

/// Where a page that is not showing goes. PARKED, never closed — closing
/// destroys the session (the data store is non-persistent) and races the agent;
/// see `BrowserView`'s unmount path for the live QA that settled this.
const PARKED: Bounds = Bounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };

/// One open page, as the frontend's tab strip sees it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
}

/// One open page, as Rust tracks it.
///
/// The URL is RECORDED here rather than read back from the webview, because
/// `Webview::url()` is not a question that is always safe to ask: wry's
/// `url_from_webview` unwraps `WKWebView.URL`, which is nil on a page that has
/// not committed a document yet — a brand-new `about:blank` tab. Asking
/// aborted the whole process (crash report 2026-07-31 22:58, SIGABRT through
/// `core::option::unwrap_failed`). We already know every URL a page is sent to,
/// so we keep it and never ask.
#[derive(Debug, Clone)]
struct Page {
    id: String,
    url: String,
}

/// The agent's page script, injected at document start into every frame.
pub const PAGE_JS: &str = include_str!("browser/page.js");

/// How long one `evaluateJavaScript` round trip may take. Generous because a
/// heavy page can block its own main thread for a while; the poll loop in
/// [`call_async`] has its own, larger budget.
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

/// Poll interval while waiting on an async page ticket.
const POLL_INTERVAL: Duration = Duration::from_millis(60);

/// Poll interval while waiting for a navigation's page script to come up.
const READY_POLL: Duration = Duration::from_millis(120);

/// How long to let a document that appeared MID-ACTION finish arriving before
/// deciding whether a lost ticket was a navigation or a real failure. Short:
/// this is the tail of an action the user is watching, not a fresh page load.
const READY_BUDGET_NAV: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// One journalled agent action. The web persists nothing; this persists
/// everything the agent did, in the room, for the user to read back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub at: String,
    pub kind: String,
    pub url: String,
    pub detail: String,
}

#[derive(Default)]
pub struct BrowserState {
    /// The user has taken the wheel: agent tools refuse until it is released.
    /// Truthfully refused, never silently queued.
    pub takeover: AtomicBool,
    /// Last bounds the frontend reported, so the webview can be (re)created at
    /// the right place without another round trip.
    pub bounds: Mutex<Option<Bounds>>,
    /// This session's journal. Flushed to the room DB on every append so a
    /// crash cannot lose the record, and read back by the Journal view.
    pub journal: Mutex<Vec<JournalEntry>>,
    /// Open pages, in strip order.
    tabs: Mutex<Vec<Page>>,
    /// The page that is SHOWING — positioned at `bounds` while every other one
    /// is parked. The agent drives this one too (owner decision 2026-07-31):
    /// `webview()` resolves here, so every existing `browse_*` caller follows
    /// the user's current page without knowing tabs exist.
    pub active: Mutex<String>,
    /// Page ids are never reused within a room, so a stale frontend reference
    /// resolves to "gone" instead of to somebody else's page.
    pub next_id: AtomicU64,
    /// Downloads in flight: URL → where the file is being staged and the name
    /// it will carry into the room. Needed because on macOS the `Finished`
    /// download event never reports where the file went — only the `Requested`
    /// handler knows, since it chose the path.
    downloads: Mutex<HashMap<String, StagedDownload>>,
}

/// One download being staged for import (see `download_allowed`).
#[derive(Debug, Clone)]
struct StagedDownload {
    path: PathBuf,
    name: String,
}

/// Where in-flight downloads are staged before import into the room. Swept on
/// room close — anything still here belongs to a crashed or abandoned download.
fn staging_dir() -> PathBuf {
    std::env::temp_dir().join("arcelle-browse-downloads")
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// A webview with a zero (or negative) dimension is rejected by the
    /// platform; clamp to something small but legal.
    fn sane(self) -> Self {
        Bounds {
            x: self.x.max(0.0),
            y: self.y.max(0.0),
            width: self.width.max(1.0),
            height: self.height.max(1.0),
        }
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// The page that is showing, if any.
pub fn active_id(app: &tauri::AppHandle) -> Option<String> {
    let id = app.state::<BrowserState>().active.lock().unwrap().clone();
    (!id.is_empty()).then_some(id)
}

/// The ACTIVE page's webview — what every `browse_*` tool operates on.
pub fn webview(app: &tauri::AppHandle) -> Option<Webview<Wry>> {
    webview_of(app, &active_id(app)?)
}

pub fn webview_of(app: &tauri::AppHandle, id: &str) -> Option<Webview<Wry>> {
    app.webviews().get(&label_of(id)).cloned()
}

pub fn is_open(app: &tauri::AppHandle) -> bool {
    webview(app).is_some()
}

/// Every open page, in strip order.
pub fn tab_list(app: &tauri::AppHandle) -> Vec<TabInfo> {
    let state = app.state::<BrowserState>();
    let active = state.active.lock().unwrap().clone();
    let ids = state.tabs.lock().unwrap().clone();
    ids.iter()
        .filter(|p| webview_of(app, &p.id).is_some())
        .map(|p| TabInfo {
            id: p.id.clone(),
            title: page_title(&p.url),
            url: p.url.clone(),
            active: p.id == active,
        })
        .collect()
}

/// A short, honest label for a page before its `<title>` is known: the host.
/// Reading the real title costs an `evaluateJavaScript` round trip per page per
/// poll, which is not worth it for strip text the user can also see in the
/// address bar.
fn page_title(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "New page".to_string())
}

/// Open a page in a NEW tab and show it.
pub fn new_tab(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    let live = app.state::<BrowserState>().tabs.lock().unwrap().len();
    if live >= MAX_TABS {
        return Err(format!(
            "The private browser is limited to {MAX_TABS} open pages — close one first."
        ));
    }
    let id = app
        .state::<BrowserState>()
        .next_id
        .fetch_add(1, Ordering::SeqCst)
        .to_string();
    create(app, &id, url)?;
    {
        let state = app.state::<BrowserState>();
        state.tabs.lock().unwrap().push(Page { id: id.clone(), url: url.to_string() });
    }
    select_tab(app, &id)?;
    Ok(id)
}

/// Show `id` and park every other page.
pub fn select_tab(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if webview_of(app, id).is_none() {
        return Err("That page is no longer open.".to_string());
    }
    *app.state::<BrowserState>().active.lock().unwrap() = id.to_string();
    reposition(app);
    Ok(())
}

pub fn close_tab(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if let Some(wv) = webview_of(app, id) {
        wv.close().map_err(|e| e.to_string())?;
    }
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    let at = tabs.iter().position(|p| p.id == id);
    tabs.retain(|p| p.id != id);
    let remaining: Vec<String> = tabs.iter().map(|p| p.id.clone()).collect();
    let heir = heir_after(&remaining, at);
    drop(tabs);
    *state.active.lock().unwrap() = heir;
    drop(state);
    reposition(app);
    Ok(())
}

/// Where the ACTIVE page currently is, from our own record.
pub fn active_url(app: &tauri::AppHandle) -> Option<String> {
    let id = active_id(app)?;
    let state = app.state::<BrowserState>();
    let tabs = state.tabs.lock().unwrap();
    tabs.iter().find(|p| p.id == id).map(|p| p.url.clone())
}

/// A page that has not been anywhere yet. A new tab starts here, and it matters
/// to the FRONTEND: `about:blank` paints an opaque rectangle, and the native
/// view floats above the DOM, so a blank page hides the very start screen that
/// tells the user what to do next. The browser area parks it instead.
pub fn is_blank(app: &tauri::AppHandle) -> bool {
    active_url(app).is_none_or(|u| u == "about:blank")
}

/// Correct the ACTIVE page's record from the page script's own
/// `location.href` — the main frame's authoritative answer.
///
/// The navigation hook cannot tell a main-frame navigation from a sub-frame
/// one, so an iframe that loads a real http(s) URL (an ad, an embed) still
/// lands in the record and would leave the tab titled after somebody else's
/// domain. The info poll already asks the page where it is; writing that back
/// makes the record self-heal on the next tick.
pub fn record_active_url(app: &tauri::AppHandle, url: &str) {
    let Some(id) = active_id(app) else { return };
    if reqwest::Url::parse(url).is_ok_and(|u| is_recordable_url(&u)) {
        record_url(app, &id, url);
    }
}

/// Remember where a page went. The strip's title comes from here, and so does
/// the answer to "what is this tab" — never from `Webview::url()`, which
/// aborts the process on a page with no committed document (see `Page`).
fn record_url(app: &tauri::AppHandle, id: &str, url: &str) {
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        page.url = url.to_string();
    }
}

/// Which page shows after the one at `at` was removed from `remaining`: the
/// neighbour to the right, else the left, else nothing.
///
/// `TabStrip` picks its heir by the identical rule. The two MUST agree — they
/// are two copies of one decision, and if they disagree the page on screen is
/// not the tab highlighted in the strip, which is the worst kind of UI bug
/// because everything still looks like it is working.
fn heir_after(remaining: &[String], at: Option<usize>) -> String {
    let Some(index) = at else { return String::new() };
    remaining
        .get(index)
        .or_else(|| remaining.get(index.wrapping_sub(1)))
        .cloned()
        .unwrap_or_default()
}

/// Put the active page at the reported rect and park the rest. This IS tab
/// switching — no webview is created or destroyed, so a background page keeps
/// its scroll position, its form state and its session.
fn reposition(app: &tauri::AppHandle) {
    let state = app.state::<BrowserState>();
    let bounds = state.bounds.lock().unwrap().unwrap_or(PARKED).sane();
    let active = state.active.lock().unwrap().clone();
    let ids: Vec<String> = state.tabs.lock().unwrap().iter().map(|p| p.id.clone()).collect();
    for id in ids {
        let Some(wv) = webview_of(app, &id) else { continue };
        let b = if id == active { bounds } else { PARKED };
        let _ = wv.set_position(tauri::LogicalPosition::new(b.x, b.y));
        let _ = wv.set_size(tauri::LogicalSize::new(b.width, b.height));
    }
}

/// Create the browser webview if it does not exist, then navigate it to `url`.
/// `url` has ALREADY been guard-checked by the caller.
/// Navigate the ACTIVE page to `url`, opening the first page if none is open.
/// `url` has ALREADY been guard-checked by the caller.
pub fn ensure(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    if let Some(wv) = webview(app) {
        // Stamp the outgoing document BEFORE navigating, so `wait_ready`
        // cannot mistake the page we are leaving for the page we asked for.
        mark_superseded(app);
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        if let Some(id) = active_id(app) {
            record_url(app, &id, url);
        }
        return Ok(());
    }
    new_tab(app, url).map(|_| ())
}

/// Build one page's child webview. Callers own the tab bookkeeping.
fn create(app: &tauri::AppHandle, id: &str, url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    let window = crate::main_window(app).ok_or_else(|| "The app window is gone.".to_string())?;
    let state = app.state::<BrowserState>();
    // The agent can open a page from any area, so there may be no cached rect
    // yet (the browser pane has never mounted). Falling back to a fixed
    // 800x600 would load the page at a viewport it will never actually have —
    // and a first snapshot taken at that width can report a MOBILE layout, with
    // different controls than the one the user ends up looking at. Default to
    // the window's own size instead; `BrowserView` corrects the rect as soon
    // as it mounts, but the page never lays out at a fictional width.
    let fallback = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(size, scale)| Bounds {
            x: 0.0,
            y: 0.0,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        })
        .unwrap_or(Bounds { x: 0.0, y: 0.0, width: 1200.0, height: 800.0 });
    let b = state.bounds.lock().unwrap().unwrap_or(fallback).sane();

    let app_for_nav = app.clone();
    let app_for_dl = app.clone();
    // Captured so the hook knows WHICH page moved: this closure is built per
    // webview, so the id is a constant for its lifetime.
    let nav_id = id.to_string();
    let rules_id = id.to_string();
    let builder = tauri::webview::WebviewBuilder::new(
        label_of(id),
        tauri::WebviewUrl::External(parsed),
    )
    // The whole privacy story in one flag — see the module doc for why this
    // must NOT be combined with a custom WKWebViewConfiguration.
    .incognito(true)
    // Document-start, all frames: the script is in place before page code runs
    // and works on every origin without an allowlist.
    .initialization_script_for_all_frames(PAGE_JS)
    .on_navigation(move |url| {
        if !navigation_allowed(&app_for_nav, url) {
            return false;
        }
        // Only a real destination updates what this page IS. The hook fires for
        // SUB-FRAMES as well as the main frame and cannot tell them apart, so
        // an `about:blank` iframe — which Google and YouTube both create — used
        // to overwrite the record and make `is_blank` true for a page that was
        // showing perfectly well. `BrowserView` then parked the live page at
        // 1×1 and put the start screen back: the page "vanished" a second after
        // every navigation (owner report 2026-08-01).
        if is_recordable_url(url) {
            record_url(&app_for_nav, &nav_id, url.as_str());
        }
        true
    })
    .on_download(move |_wv, event| download_allowed(&app_for_dl, event));

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(b.x, b.y),
            tauri::LogicalSize::new(b.width, b.height),
        )
        .map_err(|e| format!("The browser could not start: {e}"))?;

    // The content rule list can only be attached once the webview (and thus its
    // configuration's user-content controller) exists. Attached to THIS page by
    // id: `create` runs before the page is pushed and made active, so reaching
    // for "the active webview" here attached the blocker to the previous page
    // (which already had it) and left every new page — including the very first
    // one — with no tracker or private-range blocking at all, while the shield
    // chip still read "Private".
    attach_rules(app, &rules_id);
    Ok(())
}

/// Close EVERY page — room close and app quit, the two paths that are meant to
/// destroy the session.
pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let ids = std::mem::take(&mut *state.tabs.lock().unwrap());
    for page in ids {
        if let Some(wv) = webview_of(app, &page.id) {
            let _ = wv.close();
        }
    }
    state.active.lock().unwrap().clear();
    state.takeover.store(false, Ordering::SeqCst);
    state.downloads.lock().unwrap().clear();
    let _ = std::fs::remove_dir_all(staging_dir());
    Ok(())
}

pub fn set_bounds(app: &tauri::AppHandle, b: Bounds) -> Result<(), String> {
    *app.state::<BrowserState>().bounds.lock().unwrap() = Some(b.sane());
    // Every page moves: the active one to the reported rect, the rest to the
    // parking spot. Doing this for ALL of them (not just the active one) is
    // what stops a background page from floating over the workspace after a
    // resize — it is positioned absolutely on screen, not clipped by any pane.
    reposition(app);
    Ok(())
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/// The synchronous navigation gate. Runs on the main thread for EVERY
/// top-level navigation — typed, clicked, redirected or scripted — so it does
/// only literal checks and never DNS (a blocking resolve here would stall the
/// UI on every click). The DNS-resolving half of the guard runs in
/// [`crate::commands::browse_guard_url`] on the agent's path, and the
/// private-range content rules cover sub-resources.
/// Is this URL a real destination — something that defines what a page IS?
///
/// Only `http(s)`. `about:blank` (and any other scheme the webview navigates
/// internally) is a frame's idle state, never where the user went.
fn is_recordable_url(url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn navigation_allowed(app: &tauri::AppHandle, url: &reqwest::Url) -> bool {
    // `about:blank` is the webview's own idle state, never a destination.
    if url.scheme() == "about" {
        return true;
    }
    let ok = crate::web::check_public_http_url(url.as_str()).is_ok();
    if !ok {
        journal(
            app,
            "blocked",
            url.as_str(),
            "Navigation blocked: private or non-web address.",
        );
        let _ = tauri::Emitter::emit(
            app,
            "browser-blocked",
            serde_json::json!({ "url": url.as_str() }),
        );
    }
    ok
}

/// Downloads land in the ROOM, never in `~/Downloads` (D9). The file is staged
/// in the app's own temp area (a path we choose, because on macOS the
/// `Finished` event never reports where the file went) and imported into the
/// room on completion.
///
/// The URL guard runs HERE, not only in `navigation_allowed`: wry's
/// `shouldPerformDownload` branch decides `.Download` BEFORE the navigation
/// policy hook runs, so an `<a download>` click is the one navigation the
/// on_navigation gate never sees.
fn download_allowed(app: &tauri::AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            if crate::web::check_public_http_url(url.as_str()).is_err() {
                journal(
                    app,
                    "blocked",
                    url.as_str(),
                    "Download blocked: private or non-web address.",
                );
                let _ = tauri::Emitter::emit(
                    app,
                    "browser-blocked",
                    serde_json::json!({ "url": url.as_str() }),
                );
                return false;
            }
            let name = crate::web::safe_file_name(
                url.path_segments()
                    .and_then(|s| s.filter(|p| !p.is_empty()).next_back())
                    .unwrap_or("download"),
            );
            let dir = staging_dir();
            if std::fs::create_dir_all(&dir).is_err() {
                return false;
            }
            let staged = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), name));
            app.state::<BrowserState>().downloads.lock().unwrap().insert(
                url.to_string(),
                StagedDownload { path: staged.clone(), name: name.clone() },
            );
            journal(app, "download", url.as_str(), &format!("Downloading {name}"));
            *destination = staged;
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path: _, success } => {
            // tauri's `path` is documented to be None on macOS — the staged
            // path recorded at `Requested` is the real one.
            let staged = app
                .state::<BrowserState>()
                .downloads
                .lock()
                .unwrap()
                .remove(url.as_str());
            match (success, staged) {
                (true, Some(staged)) => import_finished_download(app, url.to_string(), staged),
                (true, None) => journal(
                    app,
                    "download",
                    url.as_str(),
                    "Download finished, but its staged file could not be found.",
                ),
                (false, staged) => {
                    if let Some(staged) = staged {
                        let _ = std::fs::remove_file(&staged.path);
                    }
                    journal(app, "download", url.as_str(), "Download failed");
                }
            }
            true
        }
        _ => true,
    }
}

/// Import a finished download into the room off the main thread (this is
/// reached from inside wry's delegate callback), then tell the user — and the
/// journal — exactly what arrived, or why it did not.
fn import_finished_download(app: &tauri::AppHandle, url: String, staged: StagedDownload) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::commands::import_download(&app, &staged.path, &staged.name, &url);
        let payload = match &result {
            Ok(meta) => {
                journal(&app, "download", &url, &format!("{} arrived in the room", meta.name));
                serde_json::json!({ "url": url, "name": meta.name, "ok": true })
            }
            Err(e) => {
                journal(&app, "download", &url, &format!("Import failed: {e}"));
                serde_json::json!({ "url": url, "name": staged.name, "ok": false, "error": e })
            }
        };
        let _ = tauri::Emitter::emit(&app, "browser-download", payload);
    });
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

pub fn journal(app: &tauri::AppHandle, kind: &str, url: &str, detail: &str) {
    let entry = JournalEntry {
        at: now_iso(),
        kind: kind.to_string(),
        url: url.to_string(),
        detail: detail.to_string(),
    };
    if let Some(state) = app.try_state::<BrowserState>() {
        let mut j = state.journal.lock().unwrap();
        j.push(entry.clone());
        // Bound the in-memory copy; the DB keeps the full record.
        if j.len() > 500 {
            let excess = j.len() - 500;
            j.drain(0..excess);
        }
    }
    // Persist into the room when one is open. A closed room is not an error:
    // the browser can be open on the start screen with nothing to write to.
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if let Ok(guard) = state.room.lock() {
            if let Some(room) = guard.as_ref() {
                let _ = crate::db::insert_browse_journal(
                    &room.conn,
                    &entry.kind,
                    &entry.url,
                    &entry.detail,
                );
            }
        }
    }
    let _ = tauri::Emitter::emit(app, "browser-journal", &entry);
}

fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// Eval bridge
// ---------------------------------------------------------------------------

/// One `evaluateJavaScript` round trip, JSON-decoded.
///
/// `js` must be an EXPRESSION: `evaluateJavaScript` hands back the value of
/// the last statement, and wry serializes it with `NSJSONSerialization`
/// (fragments allowed, so scalars are fine).
pub async fn eval_json(
    wv: &Webview<Wry>,
    js: &str,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    wv.eval_with_callback(js, move |raw| {
        if let Ok(mut slot) = tx.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(raw);
            }
        }
    })
    .map_err(|e| format!("The browser could not run the page script: {e}"))?;

    let raw = tokio::time::timeout(EVAL_TIMEOUT, rx)
        .await
        .map_err(|_| "The page did not answer in time.".to_string())?
        .map_err(|_| "The browser closed while the page was answering.".to_string())?;

    if raw.is_empty() {
        // wry cannot distinguish `undefined` from a thrown exception — both
        // arrive empty. The page script is written to never throw, so this
        // means the script is not present yet (still loading, or a document
        // that refused it).
        // Deliberately does NOT say "try again". The tools already wait for
        // readiness themselves (`wait_ready`), so if this is reached the page
        // is genuinely refusing to run the script — and an invitation to retry
        // is what turned one failure into a twenty-round loop in live QA.
        return Err(
            "This page will not run the assistant's page script, so it cannot be read or \
             operated. Nothing was done — tell the user this page can't be driven."
                .into(),
        );
    }
    serde_json::from_str(&raw).map_err(|e| format!("The page answered with something unreadable: {e}"))
}

/// Call a SYNCHRONOUS page op (`snapshot`, `read`, `find`, `info`, `ping`).
pub async fn call(
    app: &tauri::AppHandle,
    op: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let wv = webview(app).ok_or("The browser isn't open. Use browse_open first.")?;
    let js = format!(
        "(window.__arcelleBrowse ? window.__arcelleBrowse.call({}, {}) \
         : {{ok:false,error:\"The page script isn't loaded on this page yet.\"}})",
        serde_json::to_string(op).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&args).unwrap_or_else(|_| "{}".into()),
    );
    let v = eval_json(&wv, &js).await?;
    if v.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        return Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("The page refused that.")
            .to_string());
    }
    Ok(v)
}

/// Stamp the CURRENT document as superseded, immediately before navigating it.
///
/// Without this, `wait_ready` has a race it cannot see: navigating an already
/// open browser leaves the OLD page fully loaded and answering for a moment, so
/// the readiness probe succeeds instantly and the next snapshot describes the
/// page we just left. The mark cannot survive the navigation (a new document
/// gets a fresh global object), so "the mark is gone" is exactly "the new
/// document is up".
fn mark_superseded(app: &tauri::AppHandle) {
    if let Some(wv) = webview(app) {
        let _ = wv.eval("window.__arcelleSuperseded = 1");
    }
}

/// Is the page script live on the document we are actually waiting for?
///
/// Deliberately non-erroring: "not ready" is the normal state for the first few
/// hundred milliseconds after a navigation, not a failure to report.
async fn probe_ready(app: &tauri::AppHandle) -> bool {
    let Some(wv) = webview(app) else { return false };
    const READY_JS: &str = r#"((window.__arcelleBrowse && !window.__arcelleSuperseded)
        ? window.__arcelleBrowse.call("ping", {})
        : { ok: false })"#;
    match eval_json(&wv, READY_JS).await {
        Ok(v) => v.get("ok").and_then(|o| o.as_bool()) == Some(true),
        Err(_) => false,
    }
}

/// Wait until the injected page script answers.
///
/// THE BUG THIS EXISTS FOR (live QA 2026-07-29): `browse_open` used to create
/// the webview, start the navigation, and evaluate immediately. The script is
/// a document-START user script, so on a fresh navigation it does not exist for
/// a few hundred milliseconds — every first call came back "the page isn't
/// ready yet", the model retried, and the agent burned twenty rounds of
/// `browse_open`/`browse_snapshot` without ever reaching a page.
///
/// Readiness is deterministic code, exactly like `settle`: a model must never
/// be asked to decide whether a page has loaded, and must never be handed a
/// transient not-ready as if it were a real failure.
pub async fn wait_ready(app: &tauri::AppHandle, budget: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if probe_ready(app).await {
            return Ok(());
        }
        if started.elapsed() > budget {
            return Err(format!(
                "The page did not finish loading within {}s. It may be very slow, or it may have refused to load.",
                budget.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// Which document is answering right now, or `None` if the script cannot be
/// reached at all. Used to tell a NAVIGATION from a genuine page-script failure.
async fn doc_id(app: &tauri::AppHandle) -> Option<String> {
    let wv = webview(app)?;
    const JS: &str = r#"(window.__arcelleBrowse
        ? window.__arcelleBrowse.call("info", {})
        : { ok: false })"#;
    eval_json(&wv, JS)
        .await
        .ok()?
        .get("doc")
        .and_then(|d| d.as_str())
        .map(str::to_string)
}

/// Call an ASYNCHRONOUS page op (`act`, `settle`, `annotate`) by ticket.
///
/// Promises cannot cross `evaluateJavaScript`, so the page starts the work and
/// hands back a ticket; this polls until it completes or `budget` expires.
///
/// THE BUG THIS GREW FOR (owner report 2026-07-30): the ticket lives in the page
/// script's closure, and the script is re-injected per DOCUMENT. So the moment an
/// action NAVIGATES — clicking a link, submitting a form, accepting a consent
/// wall, pressing Enter in a search box — the new document's `tickets` map is
/// empty, `take` answers `Unknown ticket t3`, and the poll turned that into a
/// hard failure. The click had SUCCEEDED; the model was told it failed, gave up
/// mid-task, and the hub reported it could not browse the page. On a real site
/// (Yahoo Finance's consent wall, then every link) that is most actions.
///
/// A lost ticket is therefore only an error if the SAME document is still up.
/// Against a new one it means "the op ran and took the page with it", which is
/// reported as exactly that — never as completion, because a batch interrupted
/// by a navigation genuinely did not finish its later steps.
pub async fn call_async(
    app: &tauri::AppHandle,
    op: &str,
    args: serde_json::Value,
    budget: Duration,
) -> Result<serde_json::Value, String> {
    let doc_before = doc_id(app).await;
    let begun = call(app, "begin", serde_json::json!({ "op": op, "args": args })).await?;
    let ticket = begun
        .get("ticket")
        .and_then(|t| t.as_str())
        .ok_or("The page did not start that action.")?
        .to_string();

    let started = Instant::now();
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        match call(app, "take", serde_json::json!({ "ticket": ticket })).await {
            Ok(taken) => {
                if taken.get("done").and_then(|d| d.as_bool()) == Some(true) {
                    return Ok(taken.get("value").cloned().unwrap_or(serde_json::Value::Null));
                }
            }
            // Either `Unknown ticket …` or the empty-eval "will not run the page
            // script" — both are what a document swap looks like from here.
            Err(e) => {
                // Let the replacement document finish arriving before judging.
                wait_ready(app, READY_BUDGET_NAV).await.ok();
                let doc_after = doc_id(app).await;
                let navigated = doc_after.is_some() && doc_after != doc_before;
                if !navigated {
                    return Err(e);
                }
                journal(app, "act", "", "The page navigated while acting");
                return Ok(serde_json::json!({
                    "ok": true,
                    "navigated": true,
                    "snapshot": call(app, "snapshot", serde_json::json!({}))
                        .await
                        .unwrap_or(serde_json::Value::Null),
                }));
            }
        }
        if started.elapsed() > budget {
            return Err(format!(
                "The page was still working after {}s — it may be stuck loading.",
                budget.as_secs()
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// macOS specifics: rule list + the ephemerality assertion
// ---------------------------------------------------------------------------

/// Compile the content rule list and attach it to the live webview.
///
/// WebKit compiles asynchronously and caches by identifier, so this is cheap
/// after the first call in a process. Failure is non-fatal but IS journalled —
/// a browser whose blocker silently failed to load must not look identical to
/// one where it is working.
#[cfg(target_os = "macos")]
pub fn attach_rules(app: &tauri::AppHandle, id: &str) {
    use objc2_foundation::{MainThreadMarker, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};

    let Some(wv) = webview_of(app, id) else { return };
    let app = app.clone();
    let _ = wv.with_webview(move |platform| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else {
            journal(&app, "blocker", "", "Content blocker unavailable on this system.");
            return;
        };
        let ptr = platform.inner() as *mut WKWebView;
        if ptr.is_null() {
            return;
        }
        let webview: &WKWebView = &*ptr;
        let controller = webview.configuration().userContentController();

        let app2 = app.clone();
        let handler = block2::RcBlock::new(
            move |list: *mut WKContentRuleList, err: *mut objc2_foundation::NSError| {
                if !list.is_null() {
                    controller.addContentRuleList(&*list);
                    journal(&app2, "blocker", "", "Content blocking active.");
                } else {
                    let msg = if err.is_null() {
                        "unknown error".to_string()
                    } else {
                        (*err).localizedDescription().to_string()
                    };
                    journal(
                        &app2,
                        "blocker",
                        "",
                        &format!("Content blocking FAILED to load: {msg}"),
                    );
                }
            },
        );
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(RULE_LIST_ID)),
            Some(&NSString::from_str(&rules_json())),
            Some(&handler),
        );
    });
}

#[cfg(not(target_os = "macos"))]
pub fn attach_rules(_app: &tauri::AppHandle, _id: &str) {}

/// Assert, against the LIVE webview, that its website data store is
/// non-persistent. This is a real check rather than a restatement of
/// `incognito(true)` because the failure mode is silent: supplying a custom
/// `WKWebViewConfiguration` makes wry ignore `incognito` and fall back to the
/// default, persistent store — a browser that looks private and is not.
#[cfg(target_os = "macos")]
pub async fn verify_ephemeral(app: &tauri::AppHandle) -> Result<bool, String> {
    use objc2_web_kit::WKWebView;
    let wv = webview(app).ok_or("The browser isn't open.")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = Mutex::new(Some(tx));
    wv.with_webview(move |platform| unsafe {
        let ptr = platform.inner() as *mut WKWebView;
        let persistent = if ptr.is_null() {
            true
        } else {
            (*ptr).configuration().websiteDataStore().isPersistent()
        };
        if let Ok(mut slot) = tx.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(!persistent);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "The browser did not report its storage mode.".to_string())?
        .map_err(|_| "The browser closed before reporting its storage mode.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn verify_ephemeral(_app: &tauri::AppHandle) -> Result<bool, String> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BROWSE-1 regression (2026-07-30). The browser is a CHILD webview of the
    /// `main` WINDOW, and tauri's `get_webview_window(label)` only answers while
    /// `Window::is_webview_window()` holds — which is literally
    /// `self.webviews().iter().all(|w| w.label() == self.label())`.
    ///
    /// So the instant this child exists, `get_webview_window("main")` returns
    /// None everywhere. That took out the room MCP bridge's tool dispatch
    /// ("main window is gone" for EVERY tool the agent called), the job and
    /// workflow progress events, and the scheduler — all silently, and all
    /// sticky until the browser closed.
    ///
    /// The label differing from the window's is the whole trigger, so pin it
    /// and pin the rule that nothing may reach for the banned lookup again.
    /// `Webview::url()` is a LANDMINE, not an accessor.
    ///
    /// wry's `url_from_webview` unwraps `WKWebView.URL`, which is nil until a
    /// page commits a document — so asking a brand-new blank tab aborts the
    /// whole process. Clicking "+" in the tab strip did exactly that on the
    /// first build that shipped tabs (crash report 2026-07-31 22:58: SIGABRT,
    /// `core::option::unwrap_failed` under `browser::tab_list`).
    ///
    /// Every URL a page is sent to passes through this module, so `Page.url`
    /// records it and nothing here ever asks. Pinned as a source scan because
    /// the call compiles fine and only fails at runtime, on the one path a
    /// unit test cannot reach without a live webview.
    #[test]
    fn nothing_in_this_module_asks_a_webview_for_its_url() {
        let source = include_str!("browser.rs");
        // Composed so this scanner does not report itself.
        let banned = format!(".{}()", "url");
        let offenders: Vec<&str> = source
            .lines()
            .filter(|line| line.contains(&banned))
            .filter(|line| !line.trim_start().starts_with("//"))
            .filter(|line| !line.contains("banned"))
            .collect();
        assert!(
            offenders.is_empty(),
            "these ask the webview for its URL, which aborts on a blank page — \
             read `Page.url` instead: {offenders:#?}",
        );
    }

    /// Pages are separate webviews, so their labels must be separate too — a
    /// shared label would have every page resolve to whichever one wry
    /// registered last.
    #[test]
    fn every_page_gets_its_own_webview_label() {
        assert_ne!(label_of("0"), label_of("1"));
        assert!(label_of("3").starts_with(BROWSER_LABEL));
    }

    /// Rust's heir and the strip's heir are two copies of one decision.
    #[test]
    fn closing_a_page_shows_its_right_neighbour_then_its_left() {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Closed the middle of a,b,c -> remaining a,c at index 1 -> c.
        assert_eq!(heir_after(&ids(&["a", "c"]), Some(1)), "c");
        // Closed the last of a,b,c -> remaining a,b at index 2 -> fall left to b.
        assert_eq!(heir_after(&ids(&["a", "b"]), Some(2)), "b");
        // Closed the first of a,b -> remaining b at index 0 -> b.
        assert_eq!(heir_after(&ids(&["b"]), Some(0)), "b");
        // Closed the only page: nothing shows, and index-0 minus one must not
        // wrap into a panic or resurrect a page that is gone.
        assert_eq!(heir_after(&[], Some(0)), "");
        assert_eq!(heir_after(&ids(&["a"]), None), "");
    }

    #[test]
    fn a_page_is_labelled_by_its_host_until_its_title_is_known() {
        assert_eq!(page_title("https://www.example.com/a/b?c=d"), "example.com");
        assert_eq!(page_title("https://news.ycombinator.com/"), "news.ycombinator.com");
        // A blank tab and any unparseable address stay honest rather than
        // rendering an empty strip entry the user cannot click meaningfully.
        assert_eq!(page_title("about:blank"), "New page");
        assert_eq!(page_title(""), "New page");
    }

    /// The cap refuses; it does not silently close a page the user was reading.
    #[test]
    fn the_page_cap_is_small_enough_to_matter_and_larger_than_one() {
        assert!(MAX_TABS > 1 && MAX_TABS <= 16);
    }

    #[test]
    fn the_browser_is_a_second_webview_so_the_window_lookup_must_not_be_scoped() {
        assert_ne!(
            BROWSER_LABEL,
            crate::MAIN_WINDOW,
            "a child webview whose label differs from the window's is what flips \
             is_webview_window() to false",
        );

        // Every Rust source in this crate, checked against the banned lookup.
        // `crate::main_window` / `crate::main_webview` are the only sanctioned
        // ways to reach the app window (see their doc comments).
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // Composed, not a literal — otherwise this scanner reports itself.
        let banned = format!("get_{}_window", "webview");
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("source is utf-8");
                for (n, line) in text.lines().enumerate() {
                    // Skip this test's own prose and the doc comments that
                    // explain the trap.
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    if line.contains(&banned) {
                        offenders.push(format!(
                            "{}:{}",
                            path.strip_prefix(&root).unwrap_or(&path).display(),
                            n + 1
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "the webview-scoped window lookup returns None while the private browser \
             is open — use crate::main_window()/main_webview() instead. \
             Offenders: {offenders:?}",
        );
    }

    #[test]
    fn bounds_are_clamped_to_something_the_platform_accepts() {
        let b = Bounds { x: -5.0, y: -1.0, width: 0.0, height: -20.0 }.sane();
        assert_eq!((b.x, b.y), (0.0, 0.0));
        assert!(b.width >= 1.0 && b.height >= 1.0);
    }

    /// THE VANISHING-PAGE BUG (owner report 2026-08-01, live QA on the first
    /// build that shipped tabs).
    ///
    /// `on_navigation` fires for SUB-FRAMES as well as the main frame, and the
    /// callback gets only a URL — there is no way to tell them apart. Google
    /// and YouTube both create `about:blank` iframes, so a second after either
    /// page loaded, the hook recorded `about:blank` as that PAGE's url.
    /// `is_blank` then said the page was blank, `BrowserView` parked the live
    /// webview at 1×1 and put the start screen back, and the tab retitled
    /// itself "New page" — a page that had loaded perfectly looked like a
    /// crash. Only a real destination may define what a page IS.
    #[test]
    fn an_iframe_going_to_about_blank_cannot_blank_the_page() {
        let real = reqwest::Url::parse("https://www.youtube.com/").unwrap();
        assert!(is_recordable_url(&real));
        for idle in ["about:blank", "about:srcdoc"] {
            let url = reqwest::Url::parse(idle).unwrap();
            assert!(
                !is_recordable_url(&url),
                "{idle} must never be recorded as where a page went"
            );
        }
        // …and the navigation itself is still ALLOWED — blocking a frame's own
        // idle state would break the page for real.
        assert_eq!(reqwest::Url::parse("about:blank").unwrap().scheme(), "about");
    }

    /// The download branch is the one navigation `navigation_allowed` never
    /// sees (wry decides `.Download` before the policy hook runs), so the
    /// public-URL guard must be applied inside `download_allowed` itself.
    #[test]
    fn the_download_path_runs_its_own_url_guard() {
        let src = include_str!("browser.rs");
        let requested = src
            .split("DownloadEvent::Requested")
            .nth(1)
            .expect("Requested arm exists");
        let head: String = requested.chars().take(400).collect();
        assert!(
            head.contains("check_public_http_url"),
            "the Requested arm no longer guards the download URL — an \
             <a download> click would reach private addresses"
        );
    }

    /// The readiness probe is the fix for the live-QA loop, and it is pure
    /// string JS that no compiler checks. Both guards must be in it: without
    /// `__arcelleBrowse` it would call into nothing; without
    /// `__arcelleSuperseded` it would happily answer from the page being
    /// navigated AWAY from, and the snapshot would describe the wrong page.
    #[test]
    fn readiness_probe_checks_both_the_script_and_the_superseded_mark() {
        let src = include_str!("browser.rs");
        let probe = src
            .split("const READY_JS: &str =")
            .nth(1)
            .expect("READY_JS constant exists");
        let probe: String = probe.chars().take(240).collect();
        assert!(probe.contains("window.__arcelleBrowse"));
        assert!(probe.contains("!window.__arcelleSuperseded"));
        assert!(probe.contains("\"ping\""));
        // …and the mark must actually be set somewhere, or the guard is dead.
        assert!(src.contains("window.__arcelleSuperseded = 1"));
    }

    /// The page script must be present and expose the entry point the Rust
    /// bridge calls — a rename on either side breaks the whole browser, and
    /// the failure would only show at runtime as "page isn't ready".
    #[test]
    fn page_script_exposes_the_bridge_contract() {
        assert!(PAGE_JS.contains("window.__arcelleBrowse"));
        assert!(PAGE_JS.contains("call: call"));
        for op in ["\"snapshot\"", "\"read\"", "\"find\"", "\"begin\"", "\"take\"", "\"info\""] {
            assert!(PAGE_JS.contains(op), "page script is missing op {op}");
        }
    }

    /// The async-ticket contract's document half (owner report 2026-07-30).
    ///
    /// A ticket lives in the page script's closure and the script is re-injected
    /// per document, so ANY action that navigates leaves `take` answering
    /// "Unknown ticket". Without a document identity, `call_async` cannot tell
    /// that from a real failure, and it turned successful clicks into
    /// mid-task aborts — the reported symptom. `doc_id` reads this, so both the
    /// nonce and its exposure on `info` are load-bearing.
    #[test]
    fn the_page_script_identifies_its_document_so_a_navigation_is_not_a_failure() {
        assert!(
            PAGE_JS.contains("var DOC_ID"),
            "the per-document nonce is gone; call_async can no longer tell a \
             navigation from an unknown-ticket bug"
        );
        assert!(
            PAGE_JS.contains("doc: DOC_ID"),
            "DOC_ID exists but is not reported — `doc_id()` reads it off `info`"
        );
        // It must be per-DOCUMENT, not a module constant a new document reuses.
        assert!(
            PAGE_JS.contains("Math.random()"),
            "DOC_ID must differ between documents or every navigation looks like \
             the same document"
        );
        // And the guard the whole thing protects: `take` still reports a missing
        // ticket as an error, which is what `call_async` now interprets.
        assert!(PAGE_JS.contains("Unknown ticket"));
    }
}
