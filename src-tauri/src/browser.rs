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

/// What the content blocker actually did — as opposed to what the shield used
/// to claim it did.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Protection {
    /// The compile has not come back yet. NEVER shown as protected.
    #[default]
    Unknown,
    Active,
    /// WebKit refused to compile or attach the list.
    Failed { reason: String },
    /// This build/system has no content blocker at all.
    Unavailable { reason: String },
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
///
/// The blocker's verdict lives here too, PER PAGE: the rule list is attached to
/// one webview's user-content controller, so "is the browser protected" is only
/// ever the sum of one answer per page — see [`protection`].
///
/// `deferred_since` is the other half of the same story: while it is set, this
/// page is parked on [`START_BLANK`] waiting for its rule list, and everything
/// the page says about itself is about a document that is on its way out.
/// `title` is the document's own `<title>`, learned from the info poll and
/// empty until it is. The strip used to be labelled from the URL alone, on the
/// reasoning that reading a title costs a round trip per page per poll — true,
/// and beside the point: the poll for the SHOWING page already carries its
/// title and was throwing it away. So the page the user is reading is named
/// after itself, and the ones in the background keep the cheap host label.
#[derive(Debug, Clone)]
struct Page {
    id: String,
    url: String,
    title: String,
    protection: Protection,
    deferred_since: Option<Instant>,
}

/// The agent's page script, injected at document start into every frame.
pub const PAGE_JS: &str = include_str!("browser/page.js");

/// How long one `evaluateJavaScript` round trip may take. Generous because a
/// heavy page can block its own main thread for a while; the poll loop in
/// [`call_async`] has its own, larger budget.
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

/// What [`eval_json`] answers when a round trip runs out of time. Named because
/// [`readiness_from_probe_error`] has to tell it apart from "the document
/// answered nothing at all": `EVAL_TIMEOUT` is longer than the smallest
/// readiness budget, so one stuck probe outlasts the whole wait on its own.
const EVAL_TIMED_OUT: &str = "The page did not answer in time.";

/// What [`eval_json`] answers when its callback is DROPPED instead of fired.
///
/// It used to say "The browser closed while the page was answering", which is a
/// guess, and usually the wrong one: WebKit drops a pending
/// `evaluateJavaScript` completion handler when the document underneath it goes
/// away, and the ordinary way a document goes away is a NAVIGATION. Nothing
/// closed. The first page of a launch hit this every time — the blocker's first
/// compile is the uncached one, so the real navigation fires late, straight
/// through whatever `browser_info` poll happened to be in flight — and the
/// toolbar reported a dead browser for a page that was loading normally.
const EVAL_LOST: &str = "The page was replaced while it was answering.";

/// Did this round trip fail because A NAVIGATION TOOK THE DOCUMENT out from
/// under it?
///
/// Asked by `browser_info`, which polls the page every 1200 ms and therefore
/// lands inside a navigation sooner or later — and, for the FIRST navigation of
/// a page, very nearly always: the user types an address into a page parked on
/// `about:blank`, the document commits, and whichever poll was in flight loses
/// its callback.
///
/// [`readiness_from_probe_error`] already reads this as `Loading` for the
/// readiness probe. The poll one level up did not, so the same evidence — the
/// strongest there is that a navigation is happening — reached the toolbar as
/// "This page is not answering", over a page that had just finished loading
/// perfectly well. The only cure the user had was to press Reload.
pub fn eval_lost_to_navigation(err: &str) -> bool {
    err == EVAL_LOST
}

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
    /// The browsing SITTING this line belongs to — see [`BrowserState::session`].
    pub session: String,
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
    /// The browsing SITTING the journal is currently writing into: minted when
    /// the first page opens, cleared when the last one closes, empty in between.
    ///
    /// It exists nowhere else — not in settings, not in a file — because it is
    /// not a fact about the user, only a boundary in a record they already own.
    /// The journal rows carry it, so "this sitting" is a comparison the Journal
    /// view can make without the browser having to remember anything.
    session: Mutex<String>,
    /// How many sittings this process has opened; see [`mint_session_id`].
    next_session: AtomicU64,
    /// Downloads in flight: URL → where the file is being staged and the name
    /// it will carry into the room. Needed because on macOS the `Finished`
    /// download event never reports where the file went — only the `Requested`
    /// handler knows, since it chose the path.
    downloads: Mutex<HashMap<String, StagedDownload>>,
}

impl BrowserState {
    /// Take a freshly built page into the records, opening a browsing sitting if
    /// it is the first one. The check and the push share one lock: two pages
    /// opened at once must join one sitting, not mint two.
    fn add_page(&self, page: Page) {
        let mut tabs = self.tabs.lock().unwrap();
        if tabs.is_empty() {
            let nth = self.next_session.fetch_add(1, Ordering::SeqCst);
            *self.session.lock().unwrap() = mint_session_id(nth);
        }
        tabs.push(page);
    }

    /// Forget a page, ending the sitting with the last one. Answers where the
    /// page was and what is left, which is what the heir rule reads.
    fn drop_page(&self, id: &str) -> (Option<usize>, Vec<String>) {
        let mut tabs = self.tabs.lock().unwrap();
        let at = tabs.iter().position(|p| p.id == id);
        tabs.retain(|p| p.id != id);
        // The sitting ends with the last page: whatever is browsed next started
        // after a gap the user can see in their own record.
        if tabs.is_empty() {
            self.session.lock().unwrap().clear();
        }
        (at, tabs.iter().map(|p| p.id.clone()).collect())
    }
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

/// Generic over the runtime purely so [`close`] can be — the app always calls
/// it with the real `Wry` handle, and `Webview<R>` follows whatever it is given.
pub fn webview_of<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Option<Webview<R>> {
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
            title: page_label(&p.title, &p.url),
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

/// What one row in the strip is called: the document's own title while it is
/// known, else the host, else `New page`.
///
/// Three fallbacks because all three states are real and the reader can tell
/// them apart: a page still opening has neither, a page whose script has not
/// answered yet has only the host, and a loaded page has both. The row said
/// "New page" over a loaded example.com because the only one of the three ever
/// consulted was the last resort.
fn page_label(title: &str, url: &str) -> String {
    let named = title.trim();
    if !named.is_empty() {
        return named.to_string();
    }
    page_title(url)
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
    // Closing a BACKGROUND tab must not move the user. The heir rule answers
    // "what shows now that the visible page is gone" — running it for a tab
    // that was not showing swapped the page in front of the user for its
    // neighbour, while the strip still highlighted the tab they were on, and
    // clicking that tab did nothing because Rust already believed it was
    // active.
    let closed_the_visible_page = *state.active.lock().unwrap() == id;
    let (at, remaining) = state.drop_page(id);
    let heir = heir_after(&remaining, at);
    if closed_the_visible_page {
        *state.active.lock().unwrap() = heir;
    }
    drop(state);
    reposition(app);
    Ok(())
}

/// Where the ACTIVE page currently is, from our own record.
pub fn active_url(app: &tauri::AppHandle) -> Option<String> {
    recorded_url(app, &active_id(app)?)
}

/// One page's own record of where it was last sent. `None` while the tab is
/// still being built — `new_tab` pushes the `Page` only after `create` returns.
fn recorded_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Option<String> {
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
///
/// A recorded title belongs to the URL it was read from, so moving the page
/// DROPS it. Keeping it would leave the last site's name over the next one for
/// as long as the new document takes to answer — which is exactly the window
/// where a reader is looking to see where they have landed.
fn record_url(app: &tauri::AppHandle, id: &str, url: &str) {
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        if page.url != url {
            page.title.clear();
        }
        page.url = url.to_string();
    }
}

/// The showing page's own `<title>`, as the info poll just read it.
///
/// Only ever the ACTIVE page: it is the one whose poll we already pay for. An
/// empty answer is not written — a document that has not set a title yet must
/// fall back to the host, not blank the row it already filled in.
pub fn record_active_title(app: &tauri::AppHandle, title: &str) {
    let named = title.trim();
    if named.is_empty() {
        return;
    }
    let Some(id) = active_id(app) else { return };
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        page.title = named.to_string();
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

/// Where every page starts before its blocker is on. Fetches nothing, so the
/// gap between "the webview exists" and "the content rules are attached" costs
/// no unblocked requests. See [`create`].
const START_BLANK: &str = "about:blank";

/// Build one page's child webview. Callers own the tab bookkeeping.
fn create(app: &tauri::AppHandle, id: &str, url: &str) -> Result<(), String> {
    // Validated up front so an unusable address fails before a webview exists.
    reqwest::Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    // THE BLOCKER RACE: a webview built pointing at its destination starts
    // loading the instant it exists, and the content rule list can only be
    // attached AFTER that (it needs the webview's user-content controller,
    // which the webview owns). Every new page and tab therefore had a window —
    // the opening requests of the load — with no tracker and no private-range
    // blocking, while the shield chip already read "Private". Start parked on
    // `about:blank`, which fetches nothing, and navigate once the rules are on.
    let parsed = reqwest::Url::parse(START_BLANK).map_err(|e| e.to_string())?;
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
        if !navigation_allowed(&app_for_nav, &nav_id, url) {
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

    // Recorded BEFORE the blocker is attached, not after `create` returns: the
    // attach reports its verdict onto this page, and three of its exits answer
    // synchronously — a page not yet in `tabs` has nowhere to keep them, so the
    // browser would report `Unknown` forever for exactly the failures the
    // shield exists to show.
    register_page(app, id, url);

    // The content rule list can only be attached once the webview (and thus its
    // configuration's user-content controller) exists. Attached to THIS page by
    // id: `create` runs before the page is made active, so reaching
    // for "the active webview" here attached the blocker to the previous page
    // (which already had it) and left every new page — including the very first
    // one — with no tracker or private-range blocking at all, while the shield
    // chip still read "Private". The real destination is loaded from inside the
    // attach, so the blocker is never a step behind the page.
    attach_rules_then_go(app, id, url);
    Ok(())
}

/// Send a page that is parked on [`START_BLANK`] to where it was actually
/// asked to go. A no-op for a genuinely blank new tab, and for the retry path,
/// which re-attaches the blocker to pages the user is already reading.
fn go_after_rules<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, then: &ThenGo) {
    let ThenGo::Navigate(url) = then else { return };
    if !should_go_after_rules(url, recorded_url(app, id).as_deref()) {
        return;
    }
    let Some(wv) = webview_of(app, id) else { return };
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let _ = wv.navigate(parsed);
    }
}

/// Is the DEFERRED navigation still the one to fire?
///
/// `url` is the destination captured when the page was built, and the blocker
/// compiles asynchronously. A second address entered during that window
/// navigates the page directly and returns, so firing unconditionally snapped
/// the page back to the first one. On the agent path that is worse than a
/// visual jump: `browse_open` journals the second page, waits for it, and then
/// describes the first — the fabrication this module exists to prevent.
///
/// `recorded` is the page's own record ([`recorded_url`]). `None` is a page
/// that is not in `tabs` — one closed while its rules compiled — and firing for
/// it is harmless: [`go_after_rules`] finds no webview to navigate.
fn should_go_after_rules(url: &str, recorded: Option<&str>) -> bool {
    url != START_BLANK && recorded.is_none_or(|current| current == url)
}

/// Take a freshly built page into the browser's own records, and open a
/// browsing sitting if it is the first one.
///
/// A page is in `tabs` from the moment its webview exists — `tab_list` filters
/// on the webview anyway, so an entry can never outlive the thing it describes.
fn register_page(app: &tauri::AppHandle, id: &str, url: &str) {
    app.state::<BrowserState>().add_page(Page {
        id: id.to_string(),
        url: url.to_string(),
        // Unknown until the page answers for itself; the host carries the row
        // until then.
        title: String::new(),
        protection: Protection::Unknown,
        deferred_since: None,
    });
}

/// A browsing sitting's id: the wall clock it began at, plus a counter so two
/// sittings inside one second are still two.
///
/// It must be unique against rows written by EARLIER RUNS of the app — journal
/// lines outlive the process, and a bare counter would restart at 0 and label
/// last week's browsing as part of this sitting — while being stored nowhere
/// but those rows.
fn mint_session_id(nth: u64) -> String {
    format!("{}-{nth}", chrono::Local::now().format("%Y%m%d%H%M%S"))
}

/// The sitting the journal is writing into, empty when nothing is being
/// browsed. Read through `try_state` because [`journal`] runs from paths (app
/// quit, download callbacks) that cannot promise the state is still managed.
pub fn session_id(app: &tauri::AppHandle) -> String {
    app.try_state::<BrowserState>()
        .map(|state| state.session.lock().unwrap().clone())
        .unwrap_or_default()
}

/// Close EVERY page — room close and app quit, the two paths that are meant to
/// destroy the session.
///
/// Runtime-generic so `teardown_open_room` can be: the teardown is the one
/// place the browser's death is sequenced against the room handle's, and that
/// order is only testable if the whole chain accepts a mock runtime.
pub fn close<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let ids = std::mem::take(&mut *state.tabs.lock().unwrap());
    for page in ids {
        if let Some(wv) = webview_of(app, &page.id) {
            let _ = wv.close();
        }
    }
    state.active.lock().unwrap().clear();
    state.session.lock().unwrap().clear();
    state.takeover.store(false, Ordering::SeqCst);
    state.downloads.lock().unwrap().clear();
    let _ = std::fs::remove_dir_all(staging_dir());
    Ok(())
}

/// The rect the ACTIVE page currently occupies, as last reported by the view.
///
/// [`PARKED`] until the browser area has mounted and measured once, which is
/// also what it reads while the page is deliberately shrunk out of the way —
/// the two are the same state and callers must treat them the same.
pub fn bounds(app: &tauri::AppHandle) -> Bounds {
    app.state::<BrowserState>()
        .bounds
        .lock()
        .unwrap()
        .unwrap_or(PARKED)
        .sane()
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

/// Schemes that hand a link to ANOTHER app rather than load a web page:
/// `mailto:`, `tel:` and friends. The private browser does not open them (it
/// has no other app to hand them to), but they are an ordinary thing to click
/// on an ordinary page — a "contact us" link is not an attempt to reach this
/// Mac, and reporting it as one made an everyday click look like a security
/// incident, in a red banner and in the permanent journal.
///
/// Deliberately a short, named list. `file:`, `data:` and `javascript:` at top
/// level are NOT ordinary and keep the loud path.
fn is_app_link_scheme(scheme: &str) -> bool {
    matches!(
        scheme,
        "mailto" | "tel" | "sms" | "facetime" | "facetime-audio" | "callto" | "webcal"
    )
}

/// `id` is the page whose hook this is — the closure is built per webview, so
/// it is a constant. It matters for the off-thread recheck: pulling a page back
/// has to pull back THAT page. Reaching for "the active webview" instead
/// stopped whatever happened to be showing, which for a navigation in a
/// background tab is the wrong page entirely — the same mistake `create` used
/// to make when it attached the content blocker.
fn navigation_allowed(app: &tauri::AppHandle, id: &str, url: &reqwest::Url) -> bool {
    // `about:blank` is the webview's own idle state, never a destination.
    if url.scheme() == "about" {
        return true;
    }
    if is_app_link_scheme(url.scheme()) {
        journal(
            app,
            "open",
            url.as_str(),
            "This link opens another app, which the private browser does not do — nothing was loaded.",
        );
        return false;
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
    if ok {
        recheck_host_off_thread(app, id, url);
    }
    ok
}

/// Does this ALLOWED navigation still need its host resolved?
///
/// The literal check above only reads the ADDRESS TEXT. A perfectly ordinary
/// name can point at this Mac — `check_public_http_url`'s own doc says so, and
/// the agent's path already answers it with `resolve_public_addr`. The
/// navigation hook runs on the main thread for every click, so it cannot
/// resolve inline; it can only decide whether a resolve is worth starting.
///
/// An IP LITERAL needs none: the literal check already classified it exactly,
/// in both directions. Only a NAME can say one thing and mean another.
fn needs_host_recheck(url: &reqwest::Url) -> bool {
    if !is_recordable_url(url) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    // `host_str()` keeps the brackets on an IPv6 literal, so strip them before
    // asking — otherwise every `[::1]` would be re-resolved as a name.
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .is_err()
}

/// Resolve an allowed navigation's host in the background and pull the page
/// back if the name turns out to point into this Mac or the local network.
///
/// This is a SECOND layer, not the first: the load has already begun by the
/// time an answer arrives, so it cannot promise the request was never sent.
/// What it does promise is that the page is not left sitting on a local
/// service's response, and that the attempt is journalled like every other
/// blocked address instead of passing silently because it was spelled as a
/// name. The content rules cannot cover this — they match address TEXT, so a
/// name that resolves privately looks public to them too.
fn recheck_host_off_thread(app: &tauri::AppHandle, id: &str, url: &reqwest::Url) {
    if !needs_host_recheck(url) {
        return;
    }
    let Some(host) = url.host_str().map(str::to_string) else {
        return;
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let app = app.clone();
    let id = id.to_string();
    let shown = url.to_string();
    tauri::async_runtime::spawn(async move {
        // Only a name that genuinely resolves PRIVATE is worth halting a page
        // for. A name that does not resolve at all fails to load on its own,
        // and reporting that as a private-address block would be the untrue red
        // banner `mailto:` links used to get.
        if crate::web::host_resolves_private(&host, port).await {
            halt_private_navigation(&app, &id, &shown);
        }
    });
}

/// Stop a page that turned out to be pointed at this Mac, and say so.
///
/// `window.stop()` rather than a navigation: the point is to abandon the load,
/// not to throw away whatever the user was reading before the click.
fn halt_private_navigation(app: &tauri::AppHandle, id: &str, url: &str) {
    if let Some(wv) = webview_of(app, id) {
        let _ = wv.eval("window.stop()");
    }
    journal(
        app,
        "blocked",
        url,
        "Navigation stopped: that name resolves to this Mac or a private network.",
    );
    let _ = tauri::Emitter::emit(app, "browser-blocked", serde_json::json!({ "url": url }));
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
            if let Err(e) = std::fs::create_dir_all(&dir) {
                // Refusing here cancels the download with no other trace, so
                // clicking the link simply appeared to do nothing. Say why.
                journal(
                    app,
                    "download",
                    url.as_str(),
                    &format!("Download could not be started: {e}"),
                );
                let _ = tauri::Emitter::emit(
                    app,
                    "browser-download",
                    serde_json::json!({
                        "url": url.as_str(), "name": name, "ok": false,
                        "error": format!("The download could not be prepared: {e}"),
                    }),
                );
                return false;
            }
            let staged = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), name));
            let claimed = stage_download(
                &mut app.state::<BrowserState>().downloads.lock().unwrap(),
                url.as_str(),
                StagedDownload { path: staged.clone(), name: name.clone() },
            );
            if !claimed {
                // The SAME address is already downloading. macOS's `Finished`
                // event carries only the URL, so a second staging slot under
                // the same key is indistinguishable from the first: the first
                // download to finish used to import the SECOND one's file
                // while it was still being written, and the second then
                // reported its file missing. Refuse the duplicate instead.
                journal(
                    app,
                    "download",
                    url.as_str(),
                    &format!("Already downloading {name} — the duplicate was ignored."),
                );
                return false;
            }
            journal(app, "download", url.as_str(), &format!("Downloading {name}"));
            watch_download_size(app, url.as_str(), &name, &staged);
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

/// How often the staged file is measured while a download runs. Slow enough to
/// cost nothing (one `stat` per file per tick), quick enough that a fast link
/// does not pass the ceiling unremarked.
const DOWNLOAD_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// Is this staged download already too big to ever become a room file?
///
/// The ceiling is `import_download`'s — the SAME number, deliberately, because
/// the point is to say early what that funnel will decide at the end.
fn download_over_limit(bytes: u64) -> bool {
    bytes > crate::web::MAX_DOWNLOAD_BYTES
}

/// Warn ONCE, while it is still downloading, that a file has already passed the
/// size a room can hold.
///
/// tauri 2.11's `DownloadEvent` has exactly two arms — `Requested` and
/// `Finished` — so there is no progress callback to hang this on and no way to
/// cancel a download already in flight. What there IS is the staged file on
/// disk, which grows. Measuring it turns "the whole file arrives, and only then
/// is the user told it was too big" into a warning they get while it is
/// happening. It does NOT stop the download: nothing in this API can, and
/// claiming otherwise would be the fabrication this module exists to prevent.
fn watch_download_size(
    app: &tauri::AppHandle,
    url: &str,
    name: &str,
    staged: &std::path::Path,
) {
    let app = app.clone();
    let url = url.to_string();
    let name = name.to_string();
    let staged = staged.to_path_buf();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DOWNLOAD_WATCH_INTERVAL).await;
            // The slot is released by `Finished`; its absence means this
            // download is over (imported, failed, or the room closed) and there
            // is nothing left to warn about.
            let still_running = app
                .state::<BrowserState>()
                .downloads
                .lock()
                .unwrap()
                .contains_key(&url);
            if !still_running {
                return;
            }
            let bytes = std::fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
            if !download_over_limit(bytes) {
                continue;
            }
            let limit_mb = crate::web::MAX_DOWNLOAD_BYTES / (1024 * 1024);
            let detail = format!(
                "{name} has already passed the {limit_mb} MB limit for a room file \
                 ({} MB so far) — it will be refused when it finishes. Nothing here \
                 can stop a download that has started.",
                bytes / (1024 * 1024)
            );
            journal(&app, "download", &url, &detail);
            // Its OWN event, not `browser-download`: that one means "this
            // download is over, here is what happened", and reusing it would
            // put a "failed" toast on a transfer that is still running.
            let _ = tauri::Emitter::emit(
                &app,
                "browser-download-oversize",
                serde_json::json!({ "url": url, "name": name, "bytes": bytes, "detail": detail }),
            );
            return;
        }
    });
}

/// Claim the staging slot for `url`. `false` when one is already in flight for
/// that exact address — see the `Requested` arm for why a second slot cannot
/// safely share the key.
fn stage_download(
    downloads: &mut HashMap<String, StagedDownload>,
    url: &str,
    staged: StagedDownload,
) -> bool {
    if downloads.contains_key(url) {
        return false;
    }
    downloads.insert(url.to_string(), staged);
    true
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

/// Record one agent action.
///
/// The room DB is the ONLY copy. A parallel in-memory `Vec` used to be kept
/// here and carefully trimmed to 500 entries, but nothing ever read it — the
/// Journal view reads `browser_journal`, which queries the room — and it was
/// not emptied on room close, so the last 500 lines of browsing outlived the
/// locked room in memory.
pub fn journal(app: &tauri::AppHandle, kind: &str, url: &str, detail: &str) {
    let entry = JournalEntry {
        at: now_iso(),
        session: session_id(app),
        kind: kind.to_string(),
        url: url.to_string(),
        detail: detail.to_string(),
    };
    // Persist into the room when one is open. A closed room is not an error:
    // the browser can be open on the start screen with nothing to write to.
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if let Ok(guard) = state.room.lock() {
            if let Some(room) = guard.as_ref() {
                let _ = crate::db::insert_browse_journal(
                    &room.conn,
                    &entry.session,
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
        .map_err(|_| EVAL_TIMED_OUT.to_string())?
        .map_err(|_| EVAL_LOST.to_string())?;

    if raw.is_empty() {
        // wry cannot distinguish `undefined` from a thrown exception — both
        // arrive empty. The page script is written to never throw, so this
        // means the script is not present yet (still loading, or a document
        // that refused it).
        return Err(SCRIPT_REFUSED.into());
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

/// What a page that will not run the assistant's script is told, wherever we
/// find out.
///
/// Deliberately does NOT say "try again". The tools already wait for readiness
/// themselves ([`wait_ready`]), so by the time this is reached the page is
/// genuinely refusing — and an invitation to retry is what turned one failure
/// into a twenty-round loop in live QA.
const SCRIPT_REFUSED: &str =
    "This page will not run the assistant's page script, so it cannot be read or \
     operated. Nothing was done — tell the user this page can't be driven.";

/// What the readiness probe learned about the page we are waiting for.
#[derive(Debug, PartialEq, Eq)]
enum Readiness {
    /// The page script is up on the document we asked for.
    Ready,
    /// Not yet — the normal state for the first few hundred milliseconds after
    /// a navigation, and while the document being left is still answering.
    Loading,
    /// The document has FINISHED loading and the script is not there. A PDF,
    /// or a site whose policy strips injected scripts. Waiting out the rest of
    /// the budget cannot change this, and reporting it as "the page did not
    /// finish loading" is simply untrue.
    Refused,
}

/// `record_is_blank` is [`is_blank`]: does our own record say this tab has not
/// been anywhere? It is the only way to tell the two meanings of a blank page
/// apart — see the `Ready` arm.
fn classify_ready(v: &serde_json::Value, record_is_blank: bool) -> Readiness {
    if v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
        // A page still parked on the blank START document answers exactly like
        // a real one, so "the script is up" is not the same question as "the
        // page we asked for is up". It only counts when the tab is genuinely
        // meant to be blank; otherwise the real document is still on its way
        // and returning here would snapshot `about:blank`.
        let on_blank = v.get("url").and_then(|u| u.as_str()) == Some(START_BLANK);
        return if on_blank && !record_is_blank {
            Readiness::Loading
        } else {
            Readiness::Ready
        };
    }
    if v.get("refused").and_then(|r| r.as_bool()) == Some(true) {
        return Readiness::Refused;
    }
    Readiness::Loading
}

/// Is the page script live on the document we are actually waiting for?
///
/// Deliberately non-erroring: "not ready" is the normal state for the first few
/// hundred milliseconds after a navigation, not a failure to report. `None`
/// means the document answered NOTHING at all — a page running no JavaScript
/// (a PDF), or one whose document has not committed yet.
async fn probe_ready(app: &tauri::AppHandle) -> Option<Readiness> {
    let wv = webview(app)?;
    // `refused` is asked of the DOCUMENT, not of our script, so it still
    // answers on a page that refused the script. The superseded arm keeps its
    // own guard: the page being navigated AWAY from is complete and DOES have
    // the script, so it can never look refused.
    const READY_JS: &str = r#"((window.__arcelleBrowse && !window.__arcelleSuperseded)
        ? window.__arcelleBrowse.call("ping", {})
        : { ok: false, refused: !window.__arcelleBrowse && document.readyState === "complete" })"#;
    match eval_json(&wv, READY_JS).await {
        Ok(v) => Some(classify_ready(&v, is_blank(app))),
        Err(e) => readiness_from_probe_error(&e),
    }
}

/// How a FAILED readiness probe should be read.
///
/// `None` is "the document answered nothing, and never will" — the PDF case,
/// which [`wait_ready`] is right to report as refused. Two probe failures are
/// not that page at all:
///
/// * [`EVAL_TIMED_OUT`] — the JavaScript thread is blocked (a very long task,
///   or a blocking dialog wry never dismisses), which is exactly `Loading`.
///   Reading it as `None` reported a merely busy page with [`SCRIPT_REFUSED`] —
///   worded to stop the model retrying — instead of "the page did not finish
///   loading", and one stuck probe was enough to do it because `EVAL_TIMEOUT`
///   outlasts the smallest readiness budget.
/// * [`EVAL_LOST`] — the document under the probe was replaced. A probe that
///   was interrupted BY a navigation is the strongest evidence there is that a
///   navigation is in progress, which is the definition of `Loading`.
fn readiness_from_probe_error(err: &str) -> Option<Readiness> {
    (err == EVAL_TIMED_OUT || err == EVAL_LOST).then_some(Readiness::Loading)
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
/// A page that refuses the script does NOT get the full budget. It used to:
/// every tool waited the whole 12 seconds (25 for `browse_open`) on a PDF or a
/// strict site and then reported "the page did not finish loading", which was
/// both slow and the wrong reason. The truthful message already existed in
/// `eval_json` — this is the path that reaches it again.
pub async fn wait_ready(app: &tauri::AppHandle, budget: Duration) -> Result<(), String> {
    let started = Instant::now();
    // Has the page given ANY sign it might yet become ready — an answer of
    // "still loading", or a probe that never came back because its JavaScript
    // thread is busy? If every probe came back with nothing at all, the
    // document has no script for us and never will, and saying "still loading"
    // after the budget would be a guess.
    let mut could_still_load = false;
    loop {
        match probe_ready(app).await {
            Some(Readiness::Ready) => return Ok(()),
            Some(Readiness::Refused) => return Err(SCRIPT_REFUSED.to_string()),
            Some(Readiness::Loading) => could_still_load = true,
            None => {}
        }
        if started.elapsed() > budget {
            if !could_still_load {
                return Err(SCRIPT_REFUSED.to_string());
            }
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

/// What to do once the rule list has been dealt with.
///
/// The destination used to be an assumption baked into the attach: every call
/// came from `create`, so "afterwards" always meant "navigate". Retrying the
/// blocker on pages the user is ALREADY reading has to re-attach without moving
/// them, so where to go afterwards is data now.
#[derive(Debug, Clone)]
enum ThenGo {
    /// Send the page to the destination it was parked for.
    Navigate(String),
    /// Leave the page exactly where it is.
    Stay,
}

/// One exit from [`attach_rules`]: record what the blocker did to this page,
/// let the page go where it was told, and stop claiming it is waiting on the
/// blocker.
///
/// Every exit goes through here, including the ones that used to answer
/// nothing at all. A verdict that is never recorded reads as `Unknown` forever,
/// and `Unknown` is precisely the state the shield must not present as safe.
/// The deferral is cleared HERE, in the one funnel, rather than at each exit:
/// a wait that outlives the thing being waited for is a toolbar stuck on
/// "loading" for the rest of the room's life.
///
/// Runtime-generic for the same reason [`close`] is — the clear-on-every-exit
/// invariant is only testable if the chain accepts a mock runtime.
fn settle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    verdict: Protection,
    then: &ThenGo,
) {
    set_protection(app, id, verdict);
    go_after_rules(app, id, then);
    navigation_arrived(app, id);
}

/// Record what the blocker did to ONE page. A verdict for a page that has since
/// closed is dropped: the compile is asynchronous, so losing the race with a
/// closing tab is ordinary, not a failure.
fn set_protection<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, verdict: Protection) {
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        page.protection = verdict;
    }
}

/// This page is parked on [`START_BLANK`] with a real destination waiting
/// behind the rule list's compile.
fn defer_navigation<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        page.deferred_since = Some(Instant::now());
    }
}

/// The wait is over — issued, superseded or abandoned, all three end it.
fn navigation_arrived<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let state = app.state::<BrowserState>();
    let mut tabs = state.tabs.lock().unwrap();
    if let Some(page) = tabs.iter_mut().find(|p| p.id == id) {
        page.deferred_since = None;
    }
}

/// How long a page may claim to be waiting on its content blocker.
///
/// [`settle`] clears the wait on every exit, so this ceiling is only ever
/// reached when WebKit drops the compile's completion block without calling it
/// — the one ending no exit of ours can see. It is a backstop, not the
/// mechanism: without it that page would report "still loading" forever, and
/// `browser_info` would go on hiding real page errors behind a wait that ended
/// long ago.
const DEFER_GRACE: Duration = Duration::from_secs(20);

/// Is a recorded deferral still worth believing?
fn deferral_is_live(since: Option<Instant>) -> bool {
    since.is_some_and(|at| at.elapsed() < DEFER_GRACE)
}

/// Is the SHOWING page still parked behind its blocker's compile?
///
/// `browser_info` reports for the active page, so this asks about the same one.
/// While it holds, what the page says about itself describes the blank start
/// document, and an eval that fails describes a document already replaced —
/// neither is news about the page the user asked for.
pub fn navigation_deferred(app: &tauri::AppHandle) -> bool {
    let Some(id) = active_id(app) else { return false };
    let state = app.state::<BrowserState>();
    let tabs = state.tabs.lock().unwrap();
    tabs.iter()
        .find(|p| p.id == id)
        .is_some_and(|p| deferral_is_live(p.deferred_since))
}

/// What the whole browser's blocker is doing — worst page wins.
///
/// The same doctrine as [`verify_ephemeral`]: the shield speaks for the browser,
/// so one page whose rule list never attached makes the browser unprotected, no
/// matter how many of its neighbours are fine. `Unknown` with nothing open,
/// because a browser with no pages has not protected anything.
pub fn protection(app: &tauri::AppHandle) -> Protection {
    let state = app.state::<BrowserState>();
    let pages: Vec<(String, Protection)> = state
        .tabs
        .lock()
        .unwrap()
        .iter()
        .map(|p| (p.id.clone(), p.protection.clone()))
        .collect();
    let open: Vec<Protection> = pages
        .into_iter()
        .filter(|(id, _)| webview_of(app, id).is_some())
        .map(|(_, verdict)| verdict)
        .collect();
    worst_protection(&open)
}

/// How bad a verdict is. `Unknown` outranks `Active` because a page nobody has
/// heard back about is not a protected page.
fn protection_severity(verdict: &Protection) -> u8 {
    match verdict {
        Protection::Failed { .. } => 3,
        Protection::Unavailable { .. } => 2,
        Protection::Unknown => 1,
        Protection::Active => 0,
    }
}

/// The worst of the lot, first one wins a tie so the reason belongs to the page
/// that hit the trouble earliest. Empty is `Unknown`, never `Active`.
fn worst_protection(verdicts: &[Protection]) -> Protection {
    let mut worst: Option<&Protection> = None;
    for verdict in verdicts {
        if worst.is_none_or(|w| protection_severity(verdict) > protection_severity(w)) {
            worst = Some(verdict);
        }
    }
    worst.cloned().unwrap_or_default()
}

/// Re-compile and re-attach the rule list to EVERY open page, without moving
/// any of them. What the shield's "Try again" runs.
///
/// Pages that are already `Active` are re-attached too: the list is one
/// identifier compiled from one `rules_json`, so a page that gets it twice
/// blocks exactly what it blocked before, and skipping them would leave the
/// shield's verdict depending on which pages happened to be fine when the user
/// pressed the button.
pub fn retry_protection(app: &tauri::AppHandle) -> Result<(), String> {
    let ids: Vec<String> = app
        .state::<BrowserState>()
        .tabs
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.id.clone())
        .collect();
    if ids.is_empty() {
        return Err("The browser isn't open.".to_string());
    }
    for id in ids {
        attach_rules(app, &id, ThenGo::Stay);
    }
    Ok(())
}

/// Compile the content rule list, attach it to the live webview, and only THEN
/// do whatever `then` says.
///
/// WebKit compiles asynchronously and caches by identifier, so this is cheap
/// after the first call in a process. Failure is non-fatal but IS journalled —
/// a browser whose blocker silently failed to load must not look identical to
/// one where it is working — and the page is still loaded: a blocker that
/// could not compile must not turn into a browser that cannot open a page.
#[cfg(target_os = "macos")]
fn attach_rules(app: &tauri::AppHandle, id: &str, then: ThenGo) {
    use objc2_foundation::{MainThreadMarker, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};

    // Back to "nobody has heard yet" for the whole of the compile: a `Failed`
    // left over from the last attempt would otherwise survive a retry that is
    // about to succeed, and the shield would keep reporting the old verdict.
    set_protection(app, id, Protection::Unknown);
    // …and while the compile runs, this page is not where it is going. A blank
    // new tab is excluded: it is not on its way anywhere, so nothing about it
    // is loading. Every exit clears this again through `settle`.
    if matches!(&then, ThenGo::Navigate(url) if url != START_BLANK) {
        defer_navigation(app, id);
    }
    let Some(wv) = webview_of(app, id) else {
        settle(app, id, Protection::Failed { reason: "The page is no longer open.".into() }, &then);
        return;
    };
    let owned = app.clone();
    let go_id = id.to_string();
    let inner = then.clone();
    let attached = wv.with_webview(move |platform| unsafe {
        let Some(mtm) = MainThreadMarker::new() else {
            let reason = "The content blocker can only be attached on the main thread.".into();
            settle(&owned, &go_id, Protection::Failed { reason }, &inner);
            return;
        };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else {
            journal(&owned, "blocker", "", "Content blocker unavailable on this system.");
            let reason = "This system has no content-blocker store.".into();
            settle(&owned, &go_id, Protection::Unavailable { reason }, &inner);
            return;
        };
        let ptr = platform.inner() as *mut WKWebView;
        if ptr.is_null() {
            let reason = "The page has no native view to attach the blocker to.".into();
            settle(&owned, &go_id, Protection::Failed { reason }, &inner);
            return;
        }
        let webview: &WKWebView = &*ptr;
        let controller = webview.configuration().userContentController();

        let app2 = owned.clone();
        let handler = block2::RcBlock::new(
            move |list: *mut WKContentRuleList, err: *mut objc2_foundation::NSError| {
                let verdict = if !list.is_null() {
                    controller.addContentRuleList(&*list);
                    journal(&app2, "blocker", "", "Content blocking active.");
                    Protection::Active
                } else {
                    // WebKit rejects the WHOLE list for one unsupported
                    // pattern and says only "WKErrorDomain error 6" — which is
                    // what the journal carried, and it names nothing. The
                    // domain and code are added because they are the only
                    // things that distinguish a compile rejection (code 6)
                    // from a store that could not be written to, and a failure
                    // reason is included when WebKit troubles to give one.
                    let msg = if err.is_null() {
                        "unknown error".to_string()
                    } else {
                        let e = &*err;
                        let mut msg = e.localizedDescription().to_string();
                        if let Some(why) = e.localizedFailureReason() {
                            msg.push_str(&format!(" — {why}"));
                        }
                        msg.push_str(&format!(
                            " [{} code {}]",
                            e.domain(),
                            e.code()
                        ));
                        msg
                    };
                    journal(
                        &app2,
                        "blocker",
                        "",
                        &format!("Content blocking FAILED to load: {msg}"),
                    );
                    Protection::Failed { reason: msg }
                };
                // Whether the blocker loaded or not, the page must go
                // somewhere — but never BEFORE this point.
                settle(&app2, &go_id, verdict, &inner);
            },
        );
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(RULE_LIST_ID)),
            Some(&NSString::from_str(&rules_json())),
            Some(&handler),
        );
    });
    // `with_webview` never ran, so nothing above will navigate for us.
    if let Err(e) = attached {
        settle(app, id, Protection::Failed { reason: e.to_string() }, &then);
    }
}

#[cfg(not(target_os = "macos"))]
fn attach_rules(app: &tauri::AppHandle, id: &str, then: ThenGo) {
    let reason = "This build has no content blocker.".into();
    settle(app, id, Protection::Unavailable { reason }, &then);
}

/// The name every caller that opens a page already uses: attach the blocker,
/// then send the page to `url`.
fn attach_rules_then_go(app: &tauri::AppHandle, id: &str, url: &str) {
    attach_rules(app, id, ThenGo::Navigate(url.to_string()));
}

/// Assert, against EVERY live webview, that its website data store is
/// non-persistent. This is a real check rather than a restatement of
/// `incognito(true)` because the failure mode is silent: supplying a custom
/// `WKWebViewConfiguration` makes wry ignore `incognito` and fall back to the
/// default, persistent store — a browser that looks private and is not.
///
/// Every OPEN page is asked, not only the one showing: the shield chip speaks
/// for the whole browser, and a background tab that had somehow acquired a
/// persistent store would be exactly as bad as the visible one.
#[cfg(target_os = "macos")]
pub async fn verify_ephemeral(app: &tauri::AppHandle) -> Result<bool, String> {
    let ids: Vec<String> = app
        .state::<BrowserState>()
        .tabs
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.id.clone())
        .collect();
    if ids.is_empty() {
        return Err("The browser isn't open.".to_string());
    }
    for id in ids {
        if !verify_one_ephemeral(app, &id).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
async fn verify_one_ephemeral(app: &tauri::AppHandle, id: &str) -> Result<bool, String> {
    use objc2_web_kit::WKWebView;
    let wv = webview_of(app, id).ok_or("The browser isn't open.")?;
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

    /// …AND BY ITS OWN NAME ONCE IT HAS ONE (regression QA, 2026-08-15). The
    /// strip read "New page" over a loaded example.com while the toolbar, from
    /// the very same poll, was already calling it "Example Domain": one answer
    /// carrying both facts, with the title thrown away and only the last-resort
    /// label ever consulted.
    #[test]
    fn a_page_that_has_told_us_its_name_is_called_by_it() {
        assert_eq!(
            page_label("Example Domain", "https://example.com/"),
            "Example Domain"
        );
        // Falling back in order: host while the title is unknown, then the
        // honest placeholder. All three states are real and distinguishable.
        assert_eq!(page_label("", "https://example.com/"), "example.com");
        assert_eq!(page_label("   ", "https://example.com/"), "example.com");
        assert_eq!(page_label("", "about:blank"), "New page");
    }

    /// A title belongs to the URL it was read from. Carrying it across a move
    /// would leave the last site's name over the next one for exactly as long
    /// as a reader is looking to see where they have landed.
    #[test]
    fn moving_a_page_drops_the_name_the_old_document_gave_it() {
        let mut page = Page {
            id: "0".into(),
            url: "https://example.com/".into(),
            title: "Example Domain".into(),
            protection: Protection::Unknown,
            deferred_since: None,
        };
        // Re-reporting the SAME url is what every poll does; it must not blank
        // the row on a page that is sitting still.
        if page.url != "https://example.com/" {
            page.title.clear();
        }
        assert_eq!(page.title, "Example Domain");
        // A real move drops it, and the label falls back to the new host.
        if page.url != "https://other.test/" {
            page.title.clear();
        }
        page.url = "https://other.test/".into();
        assert_eq!(page_label(&page.title, &page.url), "other.test");
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

    /// A page that has FINISHED loading and still has no page script will
    /// never get one, so the wait must end there with the truthful reason
    /// rather than burning the whole budget and then blaming the load.
    #[test]
    fn a_finished_document_with_no_script_is_refused_not_still_loading() {
        assert_eq!(
            classify_ready(&serde_json::json!({ "ok": true, "url": "https://example.com/" }), false),
            Readiness::Ready
        );
        assert_eq!(
            classify_ready(&serde_json::json!({ "ok": false, "refused": true }), false),
            Readiness::Refused
        );
        // Mid-navigation: no script yet, document not complete.
        assert_eq!(
            classify_ready(&serde_json::json!({ "ok": false, "refused": false }), false),
            Readiness::Loading
        );
        // The page we are navigating AWAY from answers the superseded arm with
        // a bare `{ok:false}` — it must never be read as a refusal.
        assert_eq!(
            classify_ready(&serde_json::json!({ "ok": false }), false),
            Readiness::Loading
        );
    }

    /// Every page now starts parked on `about:blank` so its blocker is on
    /// before a single request leaves. That start document runs the page
    /// script and answers `ping` perfectly, so readiness has to distinguish
    /// "still on the way to the page you asked for" from "this tab really is
    /// a blank new tab" — otherwise `browse_open` would snapshot about:blank.
    #[test]
    fn the_blank_start_page_is_not_mistaken_for_the_page_that_was_asked_for() {
        let blank = serde_json::json!({ "ok": true, "url": START_BLANK });
        assert_eq!(classify_ready(&blank, false), Readiness::Loading);
        // …and an empty new tab, which our record agrees is blank, IS ready —
        // otherwise every tool on a fresh tab would spin out its whole budget.
        assert_eq!(classify_ready(&blank, true), Readiness::Ready);
    }

    /// Clicking "email us" is an ordinary click, not an attempt to reach this
    /// Mac. It used to raise the private-address warning and write the same
    /// into the permanent journal.
    #[test]
    fn app_links_are_not_treated_as_private_address_attempts() {
        for scheme in ["mailto", "tel", "sms", "facetime", "webcal"] {
            assert!(is_app_link_scheme(scheme), "{scheme} is an ordinary link");
        }
        // …and the schemes that ARE worth a warning keep it.
        for scheme in ["file", "data", "javascript", "http", "https"] {
            assert!(!is_app_link_scheme(scheme), "{scheme} must keep the loud path");
        }
    }

    /// AUDIT 169. The size of a clicked download used to be checked only once
    /// the WHOLE file had arrived, so a 20 GB file filled the disk and was then
    /// thrown away with an error. The staged file is measured while it grows,
    /// against the SAME ceiling `import_download` will apply — a second number
    /// here would warn about the wrong thing, or not warn at all.
    #[test]
    fn an_oversize_download_is_noticed_while_it_is_still_arriving() {
        assert!(!download_over_limit(0));
        assert!(!download_over_limit(crate::web::MAX_DOWNLOAD_BYTES));
        assert!(download_over_limit(crate::web::MAX_DOWNLOAD_BYTES + 1));
        // The watcher must be started from the arm that stages the file, or it
        // measures nothing. Pinned as a source scan: both halves compile alone.
        let src = include_str!("browser.rs");
        let requested = src
            .split("DownloadEvent::Requested")
            .nth(1)
            .expect("Requested arm exists");
        let body = requested
            .split("DownloadEvent::Finished")
            .next()
            .expect("Finished follows Requested");
        assert!(
            body.contains("watch_download_size"),
            "a staged download must be measured while it runs — the ceiling was \
             only ever applied after the whole file had landed"
        );
    }

    /// AUDIT 154. The synchronous navigation gate only reads the address TEXT,
    /// so a perfectly ordinary NAME pointing at 127.0.0.1 walked straight
    /// through it — and the content rules cannot help, because they match the
    /// same text. The hook cannot resolve on the main thread, so it decides
    /// which navigations are worth resolving off it.
    #[test]
    fn a_named_host_is_re_resolved_after_the_literal_check_lets_it_through() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        // Names: the whole point — one of these may answer 127.0.0.1.
        assert!(needs_host_recheck(&u("https://example.com/page")));
        assert!(needs_host_recheck(&u("http://internal.example/")));
        // IP literals were already decided EXACTLY by the literal check, in
        // both directions; re-resolving them is pure cost.
        assert!(!needs_host_recheck(&u("http://8.8.8.8/")));
        assert!(!needs_host_recheck(&u("http://127.0.0.1/")));
        assert!(!needs_host_recheck(&u("http://[::1]/")));
        assert!(!needs_host_recheck(&u("http://[2606:4700::1111]/")));
        // Not a web destination at all.
        assert!(!needs_host_recheck(&u("about:blank")));
        // …and the hook must actually start the recheck, or the helper is
        // decoration. Pinned as a source scan: both halves compile alone.
        let src = include_str!("browser.rs");
        let hook = src
            .split("fn navigation_allowed")
            .nth(1)
            .expect("navigation_allowed exists");
        let body: String = hook.chars().take(1400).collect();
        assert!(
            body.contains("recheck_host_off_thread"),
            "an allowed navigation must still have its host resolved off the \
             main thread — the literal check cannot see where a name points"
        );
        // …and it must pull back the page that NAVIGATED. `webview(app)` is the
        // page that is SHOWING: a background tab that resolved privately would
        // have had `window.stop()` run on whatever the user was reading instead,
        // leaving the offending page loading and interrupting an innocent one.
        let halt = src
            .split("fn halt_private_navigation")
            .nth(1)
            .expect("halt_private_navigation exists");
        let halt: String = halt.chars().take(400).collect();
        assert!(
            halt.contains("webview_of(app, id)"),
            "the halt must target the navigating page by id, not the active one"
        );
    }

    /// macOS's `Finished` download event carries only the URL, so two staged
    /// downloads under one key are indistinguishable: the first to finish
    /// imported the second's still-being-written file, and the second reported
    /// its own file missing.
    #[test]
    fn a_second_download_of_the_same_address_cannot_displace_the_first() {
        let mut downloads: HashMap<String, StagedDownload> = HashMap::new();
        let staged = |p: &str| StagedDownload {
            path: PathBuf::from(p),
            name: "report.pdf".to_string(),
        };
        assert!(stage_download(&mut downloads, "https://x/report.pdf", staged("/tmp/a")));
        assert!(
            !stage_download(&mut downloads, "https://x/report.pdf", staged("/tmp/b")),
            "the duplicate must be refused, not overwrite the in-flight one"
        );
        assert_eq!(downloads["https://x/report.pdf"].path, PathBuf::from("/tmp/a"));
        // A different address is unaffected, and the SAME one is downloadable
        // again once the first finished and released its slot.
        assert!(stage_download(&mut downloads, "https://x/other.pdf", staged("/tmp/c")));
        downloads.remove("https://x/report.pdf");
        assert!(stage_download(&mut downloads, "https://x/report.pdf", staged("/tmp/d")));
    }

    /// The blocker cannot be attached before the webview exists, so the page
    /// must not be pointed at its destination until it has been. Pinned as a
    /// source scan: both halves compile fine independently, and getting them
    /// the wrong way round silently reopens the unblocked window.
    #[test]
    fn a_page_is_parked_on_blank_until_its_blocker_is_attached() {
        let src = include_str!("browser.rs");
        let create = src
            .split("fn create(app: &tauri::AppHandle")
            .nth(1)
            .expect("create exists");
        // Just the function body, up to the one after it.
        let body = create
            .split("\nfn go_after_rules")
            .next()
            .expect("go_after_rules follows create");
        assert!(
            body.contains("WebviewUrl::External(parsed)")
                && body.contains("reqwest::Url::parse(START_BLANK)"),
            "create must build the webview on the blank start page"
        );
        assert!(
            body.contains("attach_rules_then_go"),
            "create must route the real navigation through the blocker attach"
        );
        assert_eq!(START_BLANK, "about:blank");
    }

    /// The shield speaks for the WHOLE browser, so one page whose rule list
    /// never attached makes the browser unprotected — the same doctrine
    /// `verify_ephemeral` applies to the storage check. Before this, the chip
    /// read "Trackers blocked." off an unrelated storage assertion, so a failed
    /// compile and a working one looked identical.
    #[test]
    fn one_unprotected_page_makes_the_whole_browser_unprotected() {
        let failed = Protection::Failed { reason: "compile refused".into() };
        let unavailable = Protection::Unavailable { reason: "no store".into() };

        // Nothing open has protected nothing — never Active.
        assert_eq!(worst_protection(&[]), Protection::Unknown);
        // The only state that may be reported as protected: every page said so.
        assert_eq!(
            worst_protection(&[Protection::Active, Protection::Active]),
            Protection::Active
        );
        // …and one of anything else outranks any number of Active pages.
        for bad in [failed.clone(), unavailable.clone(), Protection::Unknown] {
            let mixed = [Protection::Active, bad.clone(), Protection::Active];
            assert_eq!(worst_protection(&mixed), bad, "one {bad:?} page must win");
            assert_ne!(worst_protection(&mixed), Protection::Active);
        }
        // Severity order in full: Failed > Unavailable > Unknown > Active.
        assert_eq!(
            worst_protection(&[unavailable.clone(), failed.clone(), Protection::Unknown]),
            failed
        );
        assert_eq!(
            worst_protection(&[Protection::Unknown, unavailable.clone()]),
            unavailable
        );
        // A tie keeps the FIRST page's reason rather than the last one's.
        assert_eq!(
            worst_protection(&[
                failed.clone(),
                Protection::Failed { reason: "second".into() },
            ]),
            failed
        );
    }

    /// The shield reads this off `browser_info`, so the JSON shape is the
    /// contract — a renamed tag or variant silently turns the chip's checks
    /// into "none of the above".
    #[test]
    fn the_verdict_reaches_the_frontend_as_a_tagged_state() {
        let json = |p: &Protection| serde_json::to_value(p).unwrap();
        assert_eq!(json(&Protection::Unknown), serde_json::json!({ "state": "unknown" }));
        assert_eq!(json(&Protection::Active), serde_json::json!({ "state": "active" }));
        assert_eq!(
            json(&Protection::Failed { reason: "boom".into() }),
            serde_json::json!({ "state": "failed", "reason": "boom" })
        );
        assert_eq!(
            json(&Protection::Unavailable { reason: "none here".into() }),
            serde_json::json!({ "state": "unavailable", "reason": "none here" })
        );
        // The default is the one that is never presented as safe.
        assert_eq!(Protection::default(), Protection::Unknown);
    }

    /// Three of the six exits used to answer NOTHING — no journal line, no
    /// verdict — so a browser whose blocker never attached was indistinguishable
    /// from one where it did. Pinned as a source scan: every one of these paths
    /// needs a live WKWebView (or a machine without one) to reach, and each
    /// compiles perfectly while saying nothing.
    #[test]
    fn every_exit_from_the_blocker_attach_records_a_verdict() {
        let src = include_str!("browser.rs");
        let body = src
            .split("fn attach_rules(app: &tauri::AppHandle, id: &str, then: ThenGo)")
            .nth(1)
            .expect("the macOS attach exists")
            .split("\n#[cfg(not(target_os = \"macos\"))]")
            .next()
            .expect("the stub follows the macOS attach");

        // Every early return is preceded by the line that records the verdict.
        let lines: Vec<&str> = body.lines().collect();
        let mut exits = 0;
        for (n, line) in lines.iter().enumerate() {
            if line.trim() != "return;" {
                continue;
            }
            exits += 1;
            let before = lines[..n].iter().rev().find(|l| !l.trim().is_empty());
            assert!(
                before.is_some_and(|l| l.contains("settle(")),
                "an exit from the blocker attach says nothing about protection: \
                 line {n} of the body",
            );
        }
        // …and the scan must have found them, or a renamed signature would make
        // this test pass by reading nothing at all.
        assert!(
            exits >= 4,
            "expected the page-gone, main-thread, store and null-view exits; saw {exits}"
        );
        // The compile's own two outcomes, and the case where `with_webview`
        // never ran at all.
        assert!(body.contains("Protection::Active"), "a successful attach must be recorded");
        assert!(
            body.contains("if let Err(e) = attached"),
            "a `with_webview` that never ran leaves the page unprotected and must say so"
        );
        // A retry must not inherit the last attempt's verdict.
        assert!(
            body.contains("set_protection(app, id, Protection::Unknown)"),
            "a stale Failed would survive a re-attach that is about to succeed"
        );
        // …and a build with no content blocker at all is Unavailable, not silence.
        let stub = src
            .split("#[cfg(not(target_os = \"macos\"))]\nfn attach_rules")
            .nth(1)
            .expect("the non-macOS stub exists");
        let stub: String = stub.chars().take(300).collect();
        assert!(stub.contains("Protection::Unavailable"));
    }

    /// The journal is one stream across every sitting ever; the boundary is
    /// what lets the view separate now from before. It lives ONLY in memory and
    /// in the rows already written, so it has to open with the first page and
    /// close with the last one.
    #[test]
    fn a_browsing_sitting_opens_with_the_first_page_and_closes_with_the_last() {
        let page = |id: &str| Page {
            id: id.to_string(),
            url: "https://example.com/".to_string(),
            title: String::new(),
            protection: Protection::Unknown,
            deferred_since: None,
        };
        let state = BrowserState::default();
        assert!(state.session.lock().unwrap().is_empty(), "nothing browsed yet");

        state.add_page(page("0"));
        let first = state.session.lock().unwrap().clone();
        assert!(!first.is_empty());
        // A second page joins the sitting the first one opened.
        state.add_page(page("1"));
        assert_eq!(*state.session.lock().unwrap(), first);
        // Closing one page does not end it…
        state.drop_page("0");
        assert_eq!(*state.session.lock().unwrap(), first);
        // …closing the LAST one does.
        state.drop_page("1");
        assert!(
            state.session.lock().unwrap().is_empty(),
            "the sitting must end with the browser, or the next one is labelled \
             as this one"
        );
        // …and the next sitting is a different sitting.
        state.add_page(page("2"));
        assert_ne!(*state.session.lock().unwrap(), first);
    }

    /// A sitting id is compared against rows written by EARLIER RUNS of the
    /// app, which is why it is not a bare counter: a counter restarts at 0 and
    /// labels last week's browsing as this sitting.
    #[test]
    fn two_sittings_in_the_same_second_are_still_two() {
        assert_ne!(mint_session_id(0), mint_session_id(1));
        assert!(mint_session_id(0).len() > 8, "a bare counter would collide across runs");
    }

    /// Room close and app quit destroy the session; the sitting must not
    /// outlive it, or the first line of the next one joins the last one.
    #[test]
    fn closing_the_browser_ends_the_sitting() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(BrowserState::default());
        let state = app.state::<BrowserState>();
        state.add_page(Page {
            id: "0".into(),
            url: "https://example.com/".into(),
            title: String::new(),
            protection: Protection::Active,
            deferred_since: None,
        });
        assert!(!state.session.lock().unwrap().is_empty());

        close(app.handle()).unwrap();
        assert!(state.session.lock().unwrap().is_empty());
        assert!(state.tabs.lock().unwrap().is_empty());
    }

    /// Parking every page on `about:blank` moved the real navigation into the
    /// blocker's async compile handler, which fires with the URL captured when
    /// the page was BUILT. A second address entered during the compile window
    /// navigates the page directly and returns, so firing regardless snapped it
    /// back — and `browse_open` would journal the second page, wait for it, and
    /// then describe the first.
    #[test]
    fn a_navigation_issued_while_the_blocker_compiles_is_not_overwritten() {
        // Nothing moved: the deferred navigation is still the right one.
        assert!(should_go_after_rules("https://a.example/", Some("https://a.example/")));
        // No record yet — still inside `create`, which pushes the tab after it
        // returns. Refusing here would leave every new page on `about:blank`.
        assert!(should_go_after_rules("https://a.example/", None));
        // The page was sent somewhere else while the rules compiled: that
        // navigation wins, and this one must not undo it.
        assert!(!should_go_after_rules("https://a.example/", Some("https://b.example/")));
        // A genuinely blank new tab stays blank either way.
        assert!(!should_go_after_rules(START_BLANK, None));
        assert!(!should_go_after_rules(START_BLANK, Some(START_BLANK)));
    }

    /// A probe that never came back found a page whose JS thread is busy, or a
    /// document that was replaced under it — neither is a document without a
    /// script. Telling them apart matters because one stuck probe outlasts the
    /// whole readiness budget on its own, and the refused message is
    /// deliberately worded to stop the model retrying.
    #[test]
    fn a_readiness_probe_that_timed_out_is_a_busy_page_not_an_undriveable_one() {
        assert!(
            EVAL_TIMEOUT > READY_BUDGET_NAV,
            "if a probe could no longer outlast a budget this distinction would be moot"
        );
        assert_eq!(readiness_from_probe_error(EVAL_TIMED_OUT), Some(Readiness::Loading));
        // THE FIRST-NAVIGATION BUG. This used to map to `None`, and the old
        // assertion pinned it there under the old wording ("the browser closed
        // while the page was answering") — an intent that was simply wrong. A
        // dropped callback means the document under the probe went away, and
        // the ordinary way a document goes away is a navigation. Read as `None`
        // it never set `could_still_load`, so a window of these expired the
        // budget into SCRIPT_REFUSED — the message written to stop the model
        // retrying — for a page that was merely loading.
        assert_eq!(readiness_from_probe_error(EVAL_LOST), Some(Readiness::Loading));
        // A document that answered NOTHING really has no script for us.
        assert_eq!(readiness_from_probe_error(SCRIPT_REFUSED), None);
        assert_eq!(readiness_from_probe_error("The page answered with something unreadable: x"), None);
        // …and the messages must stay the ones `eval_json` actually produces.
        let src = include_str!("browser.rs");
        assert!(
            src.contains("map_err(|_| EVAL_TIMED_OUT.to_string())")
                && src.contains("map_err(|_| EVAL_LOST.to_string())"),
            "eval_json must report both failures through the constants probe_ready matches on"
        );
        // "closed" was a guess, and the wrong one: nothing closed.
        assert!(
            !EVAL_LOST.contains("closed"),
            "the lost-callback message must not diagnose a closed browser"
        );
    }

    /// While a page waits for its blocker to compile it is parked on
    /// `about:blank`, so BOTH halves of what it says are about the wrong
    /// document — and the wait must end on every path out of the attach, not
    /// just the successful one. A wait that outlives the thing waited for is a
    /// toolbar stuck on "loading" for the rest of the room's life.
    #[test]
    fn a_deferred_navigation_is_cleared_however_the_attach_ends() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(BrowserState::default());
        let state = app.state::<BrowserState>();
        let deferred = || {
            state
                .tabs
                .lock()
                .unwrap()
                .iter()
                .any(|p| deferral_is_live(p.deferred_since))
        };

        state.add_page(Page {
            id: "0".into(),
            url: "https://example.com/".into(),
            title: String::new(),
            protection: Protection::Unknown,
            deferred_since: None,
        });
        // Every exit of `attach_rules` funnels through `settle` (pinned by
        // `every_exit_from_the_blocker_attach_records_a_verdict`), so each of
        // these stands for one of them — including the ones where the
        // navigation is ABANDONED and never fires at all.
        for (verdict, then) in [
            (Protection::Active, ThenGo::Navigate("https://example.com/".into())),
            (
                Protection::Failed { reason: "compile refused".into() },
                ThenGo::Navigate("https://example.com/".into()),
            ),
            (
                Protection::Unavailable { reason: "no store".into() },
                // Superseded: the page was sent somewhere else while the rules
                // compiled, so this navigation is dropped on the floor — and
                // dropping it must still end the wait.
                ThenGo::Navigate("https://elsewhere.example/".into()),
            ),
        ] {
            defer_navigation(app.handle(), "0");
            assert!(deferred(), "the page should be waiting on its blocker");
            settle(app.handle(), "0", verdict, &then);
            assert!(
                !deferred(),
                "the wait outlived the attach — the toolbar would report loading forever"
            );
        }
    }

    /// The backstop, for the one ending no exit of ours can see: WebKit drops
    /// the compile's completion block without ever calling it. The page has to
    /// go back to telling the ordinary truth rather than claiming to be loading
    /// for as long as the room is open.
    #[test]
    fn a_wait_nobody_ever_ended_stops_being_believed() {
        assert!(!deferral_is_live(None), "a page that never deferred is not loading");
        assert!(deferral_is_live(Some(Instant::now())), "a fresh wait counts");
        let ancient = Instant::now()
            .checked_sub(DEFER_GRACE + Duration::from_secs(1))
            .expect("the clock has been up longer than the grace");
        assert!(!deferral_is_live(Some(ancient)));
        // The ceiling has to outlast a real cold compile, or it would hide the
        // very state it exists to report.
        assert!(DEFER_GRACE >= Duration::from_secs(10));
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

    /// Three page-script contracts the Rust side reads by name. Each compiles
    /// fine on both sides independently and only breaks at runtime, on a live
    /// page, as wrong output rather than an error.
    #[test]
    fn the_page_script_reports_what_the_rust_side_reads_off_it() {
        // `format_read` continues from the page's own count. Recounting in
        // Rust `char`s disagreed with JavaScript's UTF-16 code units by one per
        // emoji, and the next chunk repeated text already read.
        assert!(
            PAGE_JS.contains("nextOffset:"),
            "read() must report where to carry on from, in its own units"
        );
        // …and it must not cut a surrogate pair in half.
        assert!(PAGE_JS.contains("isHighSurrogate") && PAGE_JS.contains("isLowSurrogate"));
        // `browse_look` warns about layers a screenshot cannot composite.
        assert!(
            PAGE_JS.contains("mediaAreas: mediaAreas()"),
            "info() must count the video/3D areas a screenshot returns blank"
        );
        // `find` must reuse the CURRENT numbering: a snapshot clears every mark
        // and bumps the generation, so re-scanning inside the cheap lookup
        // silently invalidated every ref the model was just handed.
        assert!(
            PAGE_JS.contains("currentElements"),
            "find() must search the live registry, not re-snapshot the page"
        );
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
