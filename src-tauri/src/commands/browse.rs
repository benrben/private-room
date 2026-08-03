//! BROWSE-1: the six `browse_*` agent tools, plus the Tauri commands the
//! browser area's chrome drives.
//!
//! # Why six, and why these six
//!
//! Tool specs are re-sent on every model turn — the `LocalEngine` scope
//! already spends ~9.7k tokens on them — so the surface is deliberately small.
//! The shape is set by what the 2026 measurements say actually costs money:
//! a raw-DOM control surface runs 3–5k tokens per step, a ref'd snapshot runs
//! 200–400. On this app's floor engine (a local 4B) that is not a saving, it
//! is the difference between working and context-shifting into fabrication.
//!
//! * [`browse_read`] is the most important tool: "look this up" must cost ONE
//!   turn, not a navigate/snapshot/click/snapshot loop.
//! * [`browse_do`] takes an ARRAY. One action per turn is the dominant cost in
//!   every agent loop.
//! * [`browse_look`] is first-class, not a fallback — every engine this app
//!   ships with is vision-capable. It shares its numbering with the text
//!   snapshot (the page script paints the same marks it reports), so the two
//!   channels are one coordinate system rather than two disconnected views.
//!
//! # The doors
//!
//! Two privacy seams meet here and they point in opposite directions:
//!
//! * INBOUND — page text reaching the model. Already covered: tool results
//!   ride the existing redaction door like every other tool result.
//! * OUTBOUND — the agent typing ROOM content into a web form. This is new,
//!   and nothing in `privacy.py` sees it, because no model is involved. It is
//!   handled the way the MCP outbound-arg lesson says to handle it: CONSENT,
//!   shown with the real values, never silent masking. See [`consent_for_typing`].

use super::*;
use crate::browser;

/// BROWSE-3: the address bar's search half — results page, enrich pass, and the
/// ＋ that turns a result into a room source.
mod search;
pub use search::*;
/// BROWSE-3c: URL-or-question, decided from the text alone. Shared by the
/// address bar (its TypeScript twin) and by `browse_open`.
mod address;
/// Item #18: the page as text, and the keyboard's way back out of the native
/// layer — the two things the host DOM cannot provide for a native webview.
mod reader;
pub use reader::*;
/// BROWSE-2: what "save this page" saves — the readable article, its declared
/// metadata, and the two files they land in.
mod saved;
use saved::capture_and_save;
use std::time::Duration;
use tauri::Manager;

/// How long a batch of page actions may take before the tool gives up. Longer
/// than a snapshot because a batch settles after every step.
const ACT_BUDGET: Duration = Duration::from_secs(45);
/// How long a freshly-opened page has to bring its script up. Generous: a slow
/// site on a slow link is normal, and timing out here means the tool fails.
const READY_BUDGET: Duration = Duration::from_secs(25);
/// Shorter, for a tool acting on a page that is ALREADY open — it only has to
/// cover an in-page navigation the previous action kicked off.
const READY_BUDGET_OPEN: Duration = Duration::from_secs(12);
const SETTLE_BUDGET: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/// The tool specs. Advertised only while the browser area is actually open
/// (see `room_mcp::scoped_specs`) — a room that is not browsing must not pay
/// these tokens on every turn.
pub(crate) fn browse_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "browse_open",
            "description": "Open a web page in the room's private browser and return the page's interactive elements — or, when you pass plain words instead of an address, search the room's own seven engines and return the ranked results to open. The browser keeps nothing — no history, cookies or cache. Never navigate to google.com or another search engine to search: this tool IS the search. Examples: {\"url\": \"https://example.com\"} · {\"url\": \"tallest building in europe\"}",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string", "description": "A full http(s) URL or bare domain to open, OR plain words to search for when no site is named"}},
                "required": ["url"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_read",
            "description": "Read the CURRENT page as text. This is the cheapest way to answer a question about a page — prefer it over snapshot/click loops whenever you only need to KNOW something rather than operate the page. Returns readable content with links; call again with a larger offset to continue a long page.",
            "parameters": {"type": "object", "properties": {
                "mode": {"type": "string", "enum": ["main", "full"], "description": "main = just the article/body (default); full = the whole page including navigation"},
                "offset": {"type": "integer", "description": "Character offset to continue from when the previous read was truncated"}}}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_find",
            "description": "Find controls on the current page whose label contains some text, without paying for a full snapshot. Returns the matching refs. Example: {\"text\": \"sign in\"}",
            "parameters": {"type": "object", "properties": {
                "text": {"type": "string", "description": "Text to look for in element labels"}},
                "required": ["text"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_snapshot",
            "description": "List the current page's interactive elements as refs (e1, e2, …) with role, label and region. Take a fresh one before acting — refs go stale when the page changes. Password fields are never listed: they are fenced and the user must type those.",
            "parameters": {"type": "object", "properties": {}}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_do",
            "description": "Perform one or more actions on the current page, in order, stopping at the first failure. Batch related steps into ONE call rather than calling repeatedly. Returns what happened plus a fresh snapshot. Example: {\"actions\": [{\"type\": {\"ref\": \"e3\", \"text\": \"hello\", \"clear\": true}}, {\"click\": \"e7\"}]}",
            "parameters": {"type": "object", "properties": {
                "actions": {"type": "array", "description": "Actions in order. Each is ONE of: {\"click\": \"e4\"} | {\"type\": {\"ref\": \"e3\", \"text\": \"...\", \"clear\": true, \"submit\": true}} | {\"select\": {\"ref\": \"e5\", \"value\": \"...\"}} | {\"scroll\": \"down\"|\"up\"|\"top\"|\"bottom\"} | {\"scroll\": {\"to\": \"e9\"}} | {\"key\": \"Enter\"} | {\"click_at\": {\"x\": 120, \"y\": 340}} | {\"back\": true} | {\"wait_for\": {\"text\": \"...\"}}",
                    "items": {"type": "object"}}},
                "required": ["actions"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_look",
            "description": "Look at the current page as an image, with each interactive element's number drawn on it — the SAME numbers browse_snapshot returns, so you can read the list and see the layout together. Use it for layout questions, canvases, maps, or to check what actually happened after an action.",
            "parameters": {"type": "object", "properties": {}}}}),
        serde_json::json!({"type": "function", "function": {"name": "browse_save",
            "description": "Save the CURRENT page into the room as files: the readable article as Markdown (searchable) plus a formatted HTML copy, both under the metadata the page declares — site, author, publication date. Captures the live page as rendered, logins and scripts included — works where fetch_page can't. what=selection saves only the text the user has selected on the page.",
            "parameters": {"type": "object", "properties": {
                "what": {"type": "string", "enum": ["page", "selection"], "description": "Default page"}}}}}),
    ]
}

/// Tool names this module owns — reserved so a connector cannot shadow them.
pub(crate) const BROWSE_TOOL_NAMES: &[&str] = &[
    "browse_open",
    "browse_read",
    "browse_find",
    "browse_snapshot",
    "browse_do",
    "browse_look",
    // BROWSE-2: capture the live page (or the user's selection) into the room.
    "browse_save",
];

pub(crate) fn is_browse_tool(name: &str) -> bool {
    BROWSE_TOOL_NAMES.contains(&name)
}

// ---------------------------------------------------------------------------
// Formatting: page JSON -> the terse text the model reads
// ---------------------------------------------------------------------------

/// Render a snapshot as ref lines. This is the token-critical function in the
/// whole feature: everything it omits is a token the 4B does not have to read,
/// and everything it hides is a thing the model cannot act on.
pub(crate) fn format_snapshot(v: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
        if title.is_empty() {
            out.push_str(&format!("{url}\n"));
        } else {
            out.push_str(&format!("{title} — {url}\n"));
        }
    }
    if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
        out.push_str(s);
        out.push('\n');
    }
    for e in v
        .get("elements")
        .and_then(|e| e.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        let r = e.get("ref").and_then(|r| r.as_str()).unwrap_or("?");
        let role = e.get("role").and_then(|r| r.as_str()).unwrap_or("control");
        let label = e.get("label").and_then(|l| l.as_str()).unwrap_or("");
        let region = e.get("region").and_then(|r| r.as_str()).unwrap_or("body");
        match e.get("state").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
            Some(st) => out.push_str(&format!("{r} {role} \"{label}\" [{region}] ({st})\n")),
            None => out.push_str(&format!("{r} {role} \"{label}\" [{region}]\n")),
        }
    }
    // Auto-escalation, in the tool result itself rather than left to the
    // model's judgement: a page the text channel cannot describe SAYS so.
    if let Some(reason) = v.get("lowSignal").and_then(|l| l.as_str()) {
        out.push_str(&format!(
            "\nThis page is hard to read as text ({reason}) — call browse_look to see it.\n"
        ));
    }
    // A snapshot that renders to NOTHING is not a page with no controls — it is a
    // page we failed to describe (a null/`{}` value from a settle ticket lost to a
    // redirect). An empty tool result reads to the model as "there is nothing here"
    // and to the user as a green step chip. `ui_snapshot` has had this floor for
    // ages; this one did not.
    if out.trim().is_empty() {
        return "The page could not be described — no page state came back. Call \
                browse_snapshot again, or browse_look to see it."
            .to_string();
    }
    out
}

fn format_read(v: &serde_json::Value) -> String {
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
    let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
    // Read at document-start returns all three blank, which formatted to the bare
    // decoration " — \n\n" — technically non-empty, semantically nothing. Say it.
    if title.is_empty() && url.is_empty() && text.trim().is_empty() {
        return "The page returned no text yet — it may still be loading. Call \
                browse_read again, or browse_look to see it."
            .to_string();
    }
    let mut out = format!("{title} — {url}\n\n{text}");
    if v.get("truncated").and_then(|t| t.as_bool()) == Some(true) {
        // The page reports where to carry on from, in the units it sliced
        // with. Recounting here in Rust `char`s was a different count from
        // JavaScript's UTF-16 code units the moment the page held an emoji, so
        // the offset came back short and the next chunk repeated text the
        // model had already read. The recount stays only as a fallback for a
        // page script older than this field.
        let next = v
            .get("nextOffset")
            .and_then(|o| o.as_u64())
            .unwrap_or_else(|| {
                v.get("offset").and_then(|o| o.as_u64()).unwrap_or(0)
                    + text.chars().count() as u64
            });
        let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
        out.push_str(&format!(
            "\n\n… {next} of {total} characters shown — call browse_read again with offset {next} for the rest."
        ));
    }
    out
}

fn format_act(v: &serde_json::Value) -> String {
    let mut out = String::new();
    for (i, r) in v
        .get("results")
        .and_then(|r| r.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        let ok = r.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
        let text = if ok {
            r.get("did").and_then(|d| d.as_str()).unwrap_or("done").to_string()
        } else {
            format!(
                "FAILED — {}",
                r.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error")
            )
        };
        out.push_str(&format!("{}. {text}\n", i + 1));
    }
    if v.get("urlChanged").and_then(|u| u.as_bool()) == Some(true) {
        out.push_str("The page navigated.\n");
    }
    if let Some(snap) = v.get("snapshot") {
        out.push_str("\nThe page now:\n");
        out.push_str(&format_snapshot(snap));
    }
    out
}

// ---------------------------------------------------------------------------
// The outbound door
// ---------------------------------------------------------------------------

/// Room entities found in text the agent is about to type into a web page.
///
/// The gatekeeper's existing doors all point at MODELS. This one points at the
/// open web, and no model is involved, so `privacy.py` never sees it. Rather
/// than silently masking — which the connector-argument wave proved reads as a
/// broken feature — the user is shown exactly what would be typed, where, and
/// decides. Returns the entities that matched, empty when there is nothing to
/// ask about.
pub(crate) fn entities_in(text: &str) -> Vec<String> {
    let Some(policy) = remote_seam_redactor() else {
        return Vec::new();
    };
    // ONE matcher decides both halves. It used to be two: the `redact()` gate
    // said whether to ask at all, and this list said what to show — and the
    // gate was the STRICTER of the pair. `Redactor` folds case with
    // `ascii_case_insensitive`, which by definition leaves every non-ASCII
    // letter case-sensitive, while `to_lowercase()` here folds the whole of
    // Unicode. So a protected name differing only in an accented letter's case
    // ("JOSÉ" against a stored "José") failed the gate, passed the list, and
    // was typed into the page with no prompt and nothing in the journal.
    //
    // `is_protectable` is the redactor's own floor and has to be shared, not
    // re-guessed: a one-character entity matches nearly every string, and a
    // consent card on every keystroke is a door people learn to click through.
    let haystack = text.to_lowercase();
    // Report the REAL strings that matched, in the order the map lists them —
    // the user is being asked about their own data, so showing placeholders
    // here would defeat the point of asking.
    policy
        .rules
        .iter()
        .filter(|(real, _)| {
            is_protectable(real) && haystack.contains(real.trim().to_lowercase().as_str())
        })
        .map(|(real, _)| real.clone())
        .collect()
}

/// Does the outbound door have to ask about this text, and about what?
///
/// `None` — nothing to ask. `Some(hits)` — ask, naming `hits`; an EMPTY `hits`
/// means the room has no entity map at all, so the door cannot name what it
/// recognised and must not pretend to.
///
/// That empty case is the point. The match list only ever holds what the local
/// scanner has already found, so in a brand-new room, a room where privacy is
/// off and nothing was ever scanned, or one where the scan came back empty, the
/// door matched nothing and therefore asked nothing — and the agent could type
/// anything the room had told it into any web form, silently. "I have nothing
/// to check this against" is not the same fact as "this is safe", and only one
/// of them is true here. Consent is the floor, exactly as it is for a remote
/// connector's arguments (SEC-1b).
pub(crate) fn outbound_hits(text: &str) -> Option<Vec<String>> {
    if remote_seam_redactor().is_none() {
        return Some(Vec::new());
    }
    let hits = entities_in(text);
    (!hits.is_empty()).then_some(hits)
}

/// Ask the user before typing room content into a page. Approval is per call
/// and shows the exact text and destination; a refusal fails the action with a
/// truthful message rather than typing a placeholder the site would reject.
async fn consent_for_typing(
    window: &tauri::Window,
    ui: &AgentUi,
    url: &str,
    field: &str,
    text: &str,
    hits: &[String],
) -> Result<(), String> {
    let v = request_ui(
        window,
        ui,
        "browse_consent",
        serde_json::json!({
            "url": url,
            "field": field,
            "text": text,
            "entities": hits,
        }),
    )
    .await?;
    if v.get("approved").and_then(|a| a.as_bool()) == Some(true) {
        Ok(())
    } else if hits.is_empty() {
        // Nothing was RECOGNISED — the room has no entity map — so the refusal
        // must not claim it did. Saying "it contains room information ()" would
        // be a fabricated reason for a real refusal.
        Err(format!(
            "The user did not approve typing that into {field}. Nothing was typed."
        ))
    } else {
        Err(format!(
            "The user did not approve typing that into {field} — it contains room information ({}). Nothing was typed.",
            hits.join(", ")
        ))
    }
}

/// Every `type` action's text in a batch, paired with its ref. Used to run the
/// outbound door BEFORE any action in the batch executes — a batch must not be
/// half-applied while the user is being asked about step three.
fn typed_texts(actions: &[serde_json::Value]) -> Vec<(String, String)> {
    actions
        .iter()
        .filter_map(|a| {
            let t = a.get("type")?;
            let text = t.get("text")?.as_str()?.to_string();
            let field = t
                .get("ref")
                .and_then(|r| r.as_str())
                .unwrap_or("a field")
                .to_string();
            (!text.trim().is_empty()).then_some((field, text))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Refuse every agent action while the user has taken the wheel. Truthful, not
/// queued: an agent told "done" for something that never happened is the exact
/// failure class the graph-hardening wave closed.
fn check_takeover(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .state::<browser::BrowserState>()
        .takeover
        .load(Ordering::SeqCst)
    {
        return Err(
            "The user has taken over the browser — your browsing tools are paused until they hand it back. Nothing was done."
                .into(),
        );
    }
    Ok(())
}

/// The room's single internet switch (`Settings → Online features`), which the
/// private browser must obey exactly like `web_search`/`fetch_page` do.
///
/// The agent path is already gated at the catalog (`room_mcp::scoped_specs`
/// only advertises `browse_*` when web is on), but the ADDRESS BAR is not a
/// model — and without this check a room whose settings read "Off — room stays
/// offline" would still reach the internet the moment the user typed a URL.
/// That is a false privacy claim, not a missing nicety, so the check lives at
/// the one function BOTH paths go through.
pub(crate) fn require_web_enabled(state: &AppState) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    if web_access_enabled(&room.conn) {
        Ok(())
    } else {
        Err("This room is offline. Turn on Settings → Online features to use the browser.".into())
    }
}

/// Full guard for an agent-supplied URL: the literal check AND a DNS resolve,
/// which the synchronous navigation hook cannot afford on the main thread.
pub(crate) async fn browse_guard_url(url: &str) -> Result<String, String> {
    let parsed = crate::web::check_public_http_url(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    crate::web::resolve_public_addr(&host, port).await?;
    Ok(parsed.to_string())
}

pub(crate) async fn exec_browse(
    window: &tauri::Window,
    name: &str,
    args: &serde_json::Value,
    effects: &mut ToolEffects,
    // Owner replacement #4: the turn that called this tool, so the step chips
    // below land in the conversation that asked rather than the one on screen.
    turn: Option<&crate::turn::TurnId>,
) -> Result<String, String> {
    let app = window.app_handle().clone();
    require_web_enabled(&app.state::<AppState>())?;
    check_takeover(&app)?;

    // Tools other than `browse_open` act on a page that already exists — but it
    // may be mid-navigation because the PREVIOUS action clicked a link. Same
    // reasoning as above: wait, do not hand the model a transient not-ready.
    if name != "browse_open" && browser::is_open(&app) {
        browser::wait_ready(&app, READY_BUDGET_OPEN).await?;
    }

    let outcome = exec_browse_inner(window, &app, name, args, effects, turn).await;
    if let Err(e) = &outcome {
        // A failing browser tool must leave a trace the USER can read; the
        // model's own transcript is not something they can inspect after the
        // fact, and a silent loop is exactly what this feature must not do.
        browser::journal(&app, "error", "", &format!("{name} failed: {e}"));
    }
    outcome
}

/// What `browse_open` should actually do with the string the model handed it,
/// AFTER the privacy door has had its say. Split out from the tool body so the
/// decision is testable without a live webview: the seam is the whole point.
#[derive(Debug, PartialEq)]
pub(crate) enum BrowseOpen {
    /// Nothing usable in the argument.
    Nothing,
    /// Search the room's engines with this (possibly masked) query. `mask_note`
    /// is empty when nothing was masked, and otherwise says so in the tool
    /// result — a masked search must never read as a search for the real name.
    Search { query: String, mask_note: String },
    /// Open this address.
    Url(String),
    /// Refuse, and tell the model why in a way it can relay to the user.
    Refuse(String),
}

/// PRIV-4, the browser half. Mirrors `web_search` (mask + disclose) and
/// `fetch_page` (refuse) in `agent.rs`: a query is still a useful search once
/// the name is a placeholder, but a URL with a masked path or query string only
/// 404s, so the honest move there is to refuse rather than to fetch.
pub(crate) fn classify_browse_open(raw: &str) -> BrowseOpen {
    match address::classify(raw) {
        None => BrowseOpen::Nothing,
        Some(address::Address::Search(query)) => {
            match crate::commands::privacy::mask_outbound_web(&query) {
                Some((masked, hidden)) => BrowseOpen::Search {
                    query: masked,
                    mask_note: crate::commands::privacy::web_mask_note(hidden),
                },
                None => BrowseOpen::Search { query, mask_note: String::new() },
            }
        }
        Some(address::Address::Url(url)) => {
            match crate::commands::privacy::outbound_url_hides(&url) {
                Some(hidden) => BrowseOpen::Refuse(format!(
                    "Not opened: this address carries {hidden} protected name(s) from this \
                     room's block list, and Cloud privacy is on, so it must not leave this Mac \
                     (Settings → Cloud privacy). Search for it instead, or tell the user — do \
                     not retry."
                )),
                None => BrowseOpen::Url(url),
            }
        }
    }
}

async fn exec_browse_inner(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    name: &str,
    args: &serde_json::Value,
    effects: &mut ToolEffects,
    turn: Option<&crate::turn::TurnId>,
) -> Result<String, String> {
    let app = app.clone();
    match name {
        "browse_open" => {
            let raw = args["url"].as_str().unwrap_or_default().trim().to_string();
            // BROWSE-3c: the agent gets the address bar's rule, not a hostname
            // guess. Before this, "best pizza nyc" became
            // `https://best pizza nyc` and failed, and the agent's only
            // recovery was to invent an address — which in practice meant
            // opening google.com and hunting for its search box, on a page
            // built to defeat exactly that. The room already runs seven
            // engines for its own address bar; the agent searches with those.
            // PRIV-4: this is the same outbound seam as `web_search`/`fetch_page`
            // in agent.rs, and it was the one left open. The privacy door
            // RESTORES real names into a cloud model's tool arguments before
            // dispatch (`room_mcp::restore_value`, and its sidecar twin), so a
            // model that only ever saw "[Person A]" can ask `browse_open` for
            // "[Person A] linkedin" and have the real name handed to seven
            // search engines — or put it in a URL's query string. Decide here,
            // before anything leaves.
            let url = match classify_browse_open(&raw) {
                BrowseOpen::Nothing => {
                    return Err("Say what to open, or what to search for.".into())
                }
                BrowseOpen::Refuse(msg) => return Ok(msg),
                BrowseOpen::Search { query, mask_note } => {
                    let state = app.state::<AppState>();
                    let result = search::run_search(&app, &state, &query).await?;
                    // Show the user the SAME results page they would get from
                    // the address bar. Watching the agent search is the point:
                    // a browser that searches invisibly is a browser you cannot
                    // check. Dropped harmlessly when the area is not on screen.
                    let _ = tauri::Emitter::emit(&app, "browser-searched", &result);
                    return Ok(format!(
                        "{}{mask_note}",
                        search::format_hits_for_agent(&result)
                    ));
                }
                BrowseOpen::Url(url) => url,
            };
            let checked = browse_guard_url(&url).await?;
            browser::ensure(&app, &checked)?;
            // The page script is injected at document START, so it does not
            // exist for the first few hundred ms of a navigation. Waiting here
            // is what stops a transient "not ready" from reaching the model as
            // a failure it then retries in a loop.
            browser::wait_ready(&app, READY_BUDGET).await?;
            browser::journal(&app, "open", &checked, "Opened by the agent");
            let _ = tauri::Emitter::emit(&app, "browser-navigated", &checked);
            // Give the page time to load and quiesce before describing it —
            // "waiting" is deterministic code here, never a model turn.
            let settled = browser::call_async(
                &app,
                "settle",
                serde_json::json!({ "budget_ms": 8000 }),
                SETTLE_BUDGET,
            )
            .await?;
            let snap = settled.get("snapshot").cloned().unwrap_or(settled);
            Ok(format_snapshot(&snap))
        }

        "browse_read" => {
            let mode = args["mode"].as_str().unwrap_or("main");
            let offset = args["offset"].as_u64().unwrap_or(0);
            let v = browser::call(
                &app,
                "read",
                serde_json::json!({ "mode": mode, "offset": offset }),
            )
            .await?;
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            browser::journal(&app, "read", url, "Read the page text");
            Ok(format_read(&v))
        }

        "browse_find" => {
            let text = args["text"].as_str().unwrap_or_default();
            let v = browser::call(&app, "find", serde_json::json!({ "text": text })).await?;
            let matches = v
                .get("matches")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default();
            let occurrences = v.get("textOccurrences").and_then(|t| t.as_u64()).unwrap_or(0);
            if matches.is_empty() {
                // browse_find searches the numbering the model already has,
                // rather than re-scanning (which would cancel every ref it was
                // just given). A control that appeared since that numbering was
                // taken is therefore invisible here — so say what to do about it.
                return Ok(if occurrences > 0 {
                    format!(
                        "No control is labelled \"{text}\", but the page text mentions it {occurrences} time(s) — browse_read to see the context, or browse_snapshot if the page has changed since your last one."
                    )
                } else {
                    format!(
                        "Nothing on this page matches \"{text}\". If the page has changed since your last snapshot, take a fresh browse_snapshot and look again."
                    )
                });
            }
            let listed = serde_json::json!({ "elements": matches });
            Ok(format!(
                "{} match(es) for \"{text}\":\n{}",
                matches.len(),
                format_snapshot(&listed)
            ))
        }

        "browse_snapshot" => {
            let v = browser::call(&app, "snapshot", serde_json::json!({})).await?;
            Ok(format_snapshot(&v))
        }

        "browse_do" => {
            let actions = args["actions"].as_array().cloned().unwrap_or_default();
            if actions.is_empty() {
                return Err("browse_do needs at least one action.".into());
            }
            let info = browser::call(&app, "info", serde_json::json!({})).await?;
            let url = info.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();

            // THE OUTBOUND DOOR — before ANY action runs, so a batch is never
            // half-applied while the user is being asked about a later step.
            let ui = app.state::<AgentUi>();
            for (field, text) in typed_texts(&actions) {
                if let Some(hits) = outbound_hits(&text) {
                    browser::journal(
                        &app,
                        "consent",
                        &url,
                        &if hits.is_empty() {
                            format!("Asked to type into {field} (this room has no list of protected details to check it against)")
                        } else {
                            format!("Asked to type room information into {field}: {}", hits.join(", "))
                        },
                    );
                    consent_for_typing(window, &ui, &url, &field, &text, &hits).await?;
                    browser::journal(
                        &app,
                        "consent",
                        &url,
                        &format!("User approved typing into {field}"),
                    );
                }
            }

            let v = browser::call_async(
                &app,
                "act",
                serde_json::json!({ "actions": actions }),
                ACT_BUDGET,
            )
            .await?;
            // A navigation cut the batch short (browser::call_async). Truthful,
            // not "done": the click landed and the page moved, but any LATER
            // action in the batch never ran, and saying otherwise is the
            // fabrication class this whole feature is built against.
            if v.get("navigated").and_then(|n| n.as_bool()) == Some(true) {
                let after = browser::call(&app, "info", serde_json::json!({}))
                    .await
                    .unwrap_or(serde_json::Value::Null);
                let now_url = after.get("url").and_then(|u| u.as_str()).unwrap_or("");
                browser::journal(
                    &app,
                    "act",
                    now_url,
                    "An action navigated the page; later steps in the batch did not run",
                );
                crate::turn::step_for(turn, &app, "Navigated the page");
                let snap = v.get("snapshot").cloned().unwrap_or(serde_json::Value::Null);
                return Ok(format!(
                    "The first action loaded a new page, so any later actions in that \
                     batch did NOT run. You are now on {now_url}\n{}",
                    format_snapshot(&snap)
                ));
            }

            let did = summarize_actions(&v);
            browser::journal(&app, "act", &url, &did);
            crate::turn::step_for(turn, &app, did);

            let mut out = format_act(&v);
            // Vision is first-class here: a failed action attaches the pixels
            // in the SAME result, so self-correction never needs a second turn
            // just to ask for eyes.
            if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
                match look_png(&app).await {
                    Ok(b64) => {
                        effects.pending_images.push(b64);
                        out.push_str(
                            "\nAn action failed, so a picture of the page (with the element numbers drawn on it) is attached.\n",
                        );
                    }
                    Err(e) => out.push_str(&format!(
                        "\n(An action failed; the page picture could not be taken: {e})\n"
                    )),
                }
            }
            Ok(out)
        }

        "browse_look" => {
            let b64 = look_png(&app).await?;
            effects.pending_images.push(b64);
            let info = browser::call(&app, "info", serde_json::json!({})).await?;
            let url = info.get("url").and_then(|u| u.as_str()).unwrap_or("");
            browser::journal(&app, "look", url, "Looked at the page");
            Ok(format!(
                "Looking at {} — every interactive element is numbered with the same ref browse_snapshot uses.{}",
                info.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or(url),
                uncapturable_media_note(&info).unwrap_or_default(),
            ))
        }

        "browse_save" => {
            let what = match args["what"].as_str() {
                Some("selection") => "selection",
                _ => "page",
            };
            capture_and_save(&app, what).await
        }

        other => Err(format!("Unknown browsing tool: {other}")),
    }
}

fn summarize_actions(v: &serde_json::Value) -> String {
    let results = v
        .get("results")
        .and_then(|r| r.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let done: Vec<&str> = results
        .iter()
        .filter(|r| r.get("ok").and_then(|o| o.as_bool()) == Some(true))
        .filter_map(|r| r.get("did").and_then(|d| d.as_str()))
        .collect();
    if done.is_empty() {
        "Nothing was done — the first action failed.".to_string()
    } else {
        format!("Browser: {}", done.join("; "))
    }
}

/// Paint the marks, screenshot, un-paint — so the picture the model sees and
/// the refs it acts on are one numbering. The un-paint is deliberate: the badge
/// overlay is for the model, and leaving it on the page would make the human's
/// browser permanently annotated.
/// A PNG's IHDR dimensions, when they are too small for the picture to show
/// anything. `BrowserView` parks the native webview at 1×1 (on unmount, and while a
/// consent card is open, because nothing can draw OVER a native webview), and
/// `set_bounds` resizes the live view — so `capture_png` then returns a perfectly
/// valid two-pixel PNG. Attaching that under "every interactive element is numbered"
/// is the fabrication this feature exists to prevent. Returns `None` when the header
/// is not a PNG we can read: never guess.
fn png_too_small_to_see(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (w < 64 || h < 64).then_some((w, h))
}

async fn look_png(app: &tauri::AppHandle) -> Result<String, String> {
    browser::call_async(
        app,
        "annotate",
        serde_json::json!({ "on": true }),
        Duration::from_secs(10),
    )
    .await?;
    // Every exit from here on must un-paint. The early return for a parked
    // webview used to skip it, leaving the numbered pink outlines on the page
    // the human is looking at — the badges are for the model, and the browser
    // must not stay annotated because a screenshot failed.
    let outcome = capture_look_png(app).await;
    let _ = browser::call_async(
        app,
        "annotate",
        serde_json::json!({ "on": false }),
        Duration::from_secs(10),
    )
    .await;
    outcome
}

/// The screenshot half of [`look_png`], split out so its caller can un-paint
/// the badges on every path.
async fn capture_look_png(app: &tauri::AppHandle) -> Result<String, String> {
    let wv = browser::webview(app).ok_or("The browser isn't open.")?;
    // capture_png must not run on the main thread (it would deadlock on the
    // snapshot completion handler), so it goes to a blocking worker.
    let png = tokio::task::spawn_blocking(move || crate::snapshot::capture_png(&wv))
        .await
        .map_err(|e| e.to_string())??;
    if let Some((w, h)) = png_too_small_to_see(&png) {
        return Err(format!(
            "the browser is parked off-screen ({w}×{h}px), so a screenshot would show \
             nothing. Do NOT describe the page — read it with browse_read instead, or \
             tell the user to open the Browser area (and answer any pending consent \
             card) and ask again."
        ));
    }
    downscale_png_b64(&png, 1280)
}

/// What a screenshot of this page CANNOT show, in the tool result itself.
///
/// `WKWebView`'s snapshot API composites the DOM, not the media layers: a
/// playing `<video>`, a WebGL canvas and a plugin surface all come back as
/// empty rectangles. The picture is still worth taking — the rest of the page
/// is in it — but reporting it as a complete view is how a model ends up
/// describing a playing video as "nothing there". The page script counts the
/// visible media areas so the caveat is only attached when there is one.
fn uncapturable_media_note(info: &serde_json::Value) -> Option<String> {
    let n = info.get("mediaAreas").and_then(|m| m.as_u64()).unwrap_or(0);
    (n > 0).then(|| {
        format!(
            " Note: {n} video/3D area(s) on this page cannot be captured and appear \
             BLANK in the picture — do not describe them as empty."
        )
    })
}

// ---------------------------------------------------------------------------
// Tauri commands (the browser area's chrome)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<String, String> {
    require_web_enabled(&app.state::<AppState>())?;
    let url = url.trim().to_string();
    let url = if url.contains("://") { url } else { format!("https://{url}") };
    let checked = browse_guard_url(&url).await?;
    browser::ensure(&app, &checked)?;
    browser::journal(&app, "open", &checked, "Opened by the user");
    Ok(checked)
}

#[tauri::command]
pub fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    browser::close(&app)
}

/// BROWSE-2: the toolbar's Save page / Save selection. Same capture-and-save
/// path as the agent's `browse_save` tool (D22). No web gate: this reads the
/// ALREADY-LOADED page — nothing is fetched, and no page can exist in a room
/// whose internet switch was off when it was opened.
#[tauri::command]
pub async fn browser_save_page(app: tauri::AppHandle, what: String) -> Result<String, String> {
    capture_and_save(&app, if what == "selection" { "selection" } else { "page" }).await
}

/// Open a page in a NEW tab. Same guard as `browser_navigate` — a new tab is
/// still a navigation, and the address it is given gets the identical check.
#[tauri::command]
pub async fn browser_new_tab(app: tauri::AppHandle, url: String) -> Result<String, String> {
    require_web_enabled(&app.state::<AppState>())?;
    let url = url.trim().to_string();
    // An empty new tab is the webview's own idle document, not a destination —
    // `navigation_allowed` already treats `about:` that way, and there is
    // nothing for the URL guard to check because nothing is fetched.
    let checked = if url.is_empty() {
        "about:blank".to_string()
    } else {
        let full = if url.contains("://") { url } else { format!("https://{url}") };
        browse_guard_url(&full).await?
    };
    let id = browser::new_tab(&app, &checked)?;
    browser::journal(&app, "open", &checked, "Opened by the user in a new tab");
    Ok(id)
}

#[tauri::command]
pub fn browser_select_tab(app: tauri::AppHandle, id: String) -> Result<(), String> {
    browser::select_tab(&app, &id)
}

#[tauri::command]
pub fn browser_close_tab(app: tauri::AppHandle, id: String) -> Result<(), String> {
    browser::close_tab(&app, &id)
}

#[tauri::command]
pub fn browser_tabs(app: tauri::AppHandle) -> Vec<browser::TabInfo> {
    browser::tab_list(&app)
}

#[tauri::command]
pub fn browser_set_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    browser::set_bounds(&app, browser::Bounds { x, y, width, height })
}

#[tauri::command]
pub async fn browser_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if !browser::is_open(&app) {
        return Ok(serde_json::json!({ "open": false }));
    }
    let (info, error) = match browser::call(&app, "info", serde_json::json!({})).await {
        Ok(info) => (info, None),
        // The reason the page did not answer used to be written into a local
        // and then dropped, so the poll returned nulls, the address bar kept
        // showing the last URL it knew, and a page that had stopped answering
        // looked exactly like one that was fine. Hand the reason back.
        Err(e) => (serde_json::Value::Null, Some(e)),
    };
    // The page script answers for the MAIN frame, so this is the authoritative
    // "where is this page" — write it back so a record corrupted by a
    // sub-frame navigation heals on the next poll instead of persisting as a
    // wrong tab title (or, before `is_recordable_url`, a vanished page).
    if let Some(url) = info.get("url").and_then(|u| u.as_str()) {
        browser::record_active_url(&app, url);
    }
    // With no answer from the page, our own RECORD of where this page was sent
    // is the only honest address there is — better than a null the view falls
    // back to its last known value for.
    let url = match info.get("url").cloned() {
        Some(url) if !url.is_null() => url,
        _ => browser::active_url(&app)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
    };
    let mut out = serde_json::json!({
        "open": true,
        // Recorded, not read from the page script — a blank page runs no script.
        "blank": browser::is_blank(&app),
        "url": url,
        "title": info.get("title").cloned().unwrap_or(serde_json::Value::Null),
        "ready": info.get("ready").cloned().unwrap_or(serde_json::Value::Null),
        "takeover": app.state::<browser::BrowserState>().takeover.load(Ordering::SeqCst),
        // Item #18: the page latches a double Escape and reports it here, once.
        // This poll is the ONLY channel out of the native layer — nothing the
        // page script does can reach the app directly — so the flag has to ride
        // the state the chrome already asks for.
        "leaveRequested": info.get("leaveRequested").and_then(|l| l.as_bool()) == Some(true),
    });
    // Present ONLY when there is a reason, so the field means what `apiTypes.ts`
    // declares it to mean (`error?: string`). A `null` on every poll is not an
    // optional field, it is a null one — and the view would have to know the
    // difference for no gain.
    if let Some(reason) = error {
        out["error"] = serde_json::Value::from(reason);
    }
    Ok(out)
}

/// What one chrome action runs, and whether it puts the browser back on the
/// network.
///
/// Back, forward and reload all issue a real load, so a room whose internet
/// switch reads "Off — room stays offline" must refuse them exactly like the
/// address bar does. `stop` only CANCELS a load, which is always allowed —
/// refusing it would mean the one control that takes a room offline faster
/// than anything else stopped working the moment you turned the room offline.
fn browser_go_js(action: &str) -> Result<(&'static str, bool), String> {
    Ok(match action {
        "back" => ("history.back()", true),
        "forward" => ("history.forward()", true),
        "reload" => ("location.reload()", true),
        "stop" => ("window.stop()", false),
        _ => return Err(format!("Unknown browser action: {action}")),
    })
}

/// back / forward / reload / stop, driven from the chrome.
#[tauri::command]
pub async fn browser_go(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let (js, goes_online) = browser_go_js(&action)?;
    if goes_online {
        require_web_enabled(&app.state::<AppState>())?;
    }
    let wv = browser::webview(&app).ok_or("The browser isn't open.")?;
    wv.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_takeover(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    app.state::<browser::BrowserState>()
        .takeover
        .store(on, Ordering::SeqCst);
    browser::journal(
        &app,
        "takeover",
        "",
        if on { "User took over the browser" } else { "User handed the browser back" },
    );
    Ok(())
}

#[tauri::command]
pub fn browser_journal(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::BrowseJournalRow>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_browse_journal(&room.conn, limit.unwrap_or(300))
}

/// Clear the browser's whole record: the journal AND the web cache behind it.
///
/// The cache is not an implementation detail from the user's side — it holds
/// the words they searched for and the full text and thumbnails of the result
/// pages, inside a browser that promises to keep nothing. Clearing the journal
/// while leaving that behind was a Clear button that did not clear.
#[tauri::command]
pub fn browser_clear_journal(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::clear_browse_journal(&room.conn)?;
    db::clear_web_cache(&room.conn)
}

/// Ask the LIVE webview whether its storage is really ephemeral. Surfaced in
/// the shield chip so the privacy claim is something the app checks, not
/// something it asserts.
#[tauri::command]
pub async fn browser_verify_private(app: tauri::AppHandle) -> Result<bool, String> {
    browser::verify_ephemeral(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(elements: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
        let mut v = serde_json::json!({
            "url": "https://example.com/",
            "title": "Example",
            "summary": "2 interactive elements on Example",
            "elements": elements,
        });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e {
                o.insert(k.clone(), val.clone());
            }
        }
        v
    }

    #[test]
    fn a_snapshot_that_renders_to_nothing_says_so_instead_of_returning_nothing() {
        // browse_open hands `settle`'s value straight to format_snapshot, and when the
        // settle ticket is lost to a redirect that value can be null or bare. Returning
        // "" told the model "this page has nothing on it" and showed the user a green
        // step chip — a failure that reads as success (live QA 2026-07-30).
        for v in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"ok": true, "navigated": true}),
        ] {
            let out = format_snapshot(&v);
            assert!(
                out.contains("could not be described"),
                "silent empty snapshot for {v}: {out:?}"
            );
        }
        // A real snapshot is untouched by the floor.
        let good = format_snapshot(&snap(
            serde_json::json!([{"ref": "e1", "role": "link", "label": "Home", "region": "nav"}]),
            serde_json::json!({}),
        ));
        assert!(!good.contains("could not be described"), "{good:?}");
    }

    #[test]
    fn a_read_with_no_title_url_or_text_is_reported_as_nothing_read() {
        let out = format_read(&serde_json::json!({"title": "", "url": "", "text": ""}));
        assert!(out.contains("no text yet"), "{out:?}");
        // Real text still formats normally, decoration and all.
        let real = format_read(
            &serde_json::json!({"title": "Example", "url": "https://example.com/", "text": "hi"}),
        );
        assert!(real.starts_with("Example — https://example.com/"), "{real:?}");
    }

    #[test]
    fn a_parked_browser_never_passes_off_two_pixels_as_a_screenshot() {
        // BrowserView parks the native view at 1×1 on unmount and while a consent card
        // is open; set_bounds resizes the LIVE webview, so capture_png returns a valid
        // but blind PNG. browse_look then claimed "every interactive element is
        // numbered" over it.
        let ihdr = |w: u32, h: u32| {
            let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
            png.extend_from_slice(b"IHDR");
            png.extend_from_slice(&w.to_be_bytes());
            png.extend_from_slice(&h.to_be_bytes());
            png
        };
        assert_eq!(png_too_small_to_see(&ihdr(1, 1)), Some((1, 1)));
        assert_eq!(png_too_small_to_see(&ihdr(2, 2)), Some((2, 2)));
        assert_eq!(png_too_small_to_see(&ihdr(1280, 800)), None);
        // Never guess about bytes we cannot parse.
        assert_eq!(png_too_small_to_see(b"not a png at all"), None);
        assert_eq!(png_too_small_to_see(&[]), None);
    }

    #[test]
    fn snapshot_renders_one_terse_line_per_ref() {
        let out = format_snapshot(&snap(
            serde_json::json!([
                {"ref": "e1", "role": "link", "label": "Home", "region": "nav"},
                {"ref": "e2", "role": "textbox", "label": "Search", "region": "form", "state": "empty"},
            ]),
            serde_json::json!({}),
        ));
        assert!(out.contains("Example — https://example.com/"));
        assert!(out.contains("e1 link \"Home\" [nav]"));
        assert!(out.contains("e2 textbox \"Search\" [form] (empty)"));
        // Terse enough to be worth the design: two controls in well under the
        // 3-5k tokens a raw DOM dump would cost.
        assert!(out.len() < 220, "snapshot rendering is too verbose: {}", out.len());
    }

    #[test]
    fn low_signal_pages_tell_the_model_to_look_instead_of_guessing() {
        let out = format_snapshot(&snap(
            serde_json::json!([]),
            serde_json::json!({ "lowSignal": "canvas covers most of the viewport" }),
        ));
        assert!(out.contains("browse_look"));
        assert!(out.contains("canvas covers most of the viewport"));
        // ...and a normal page must NOT nag.
        let normal = format_snapshot(&snap(
            serde_json::json!([{"ref": "e1", "role": "link", "label": "Home", "region": "nav"}]),
            serde_json::json!({ "lowSignal": serde_json::Value::Null }),
        ));
        assert!(!normal.contains("browse_look"));
    }

    #[test]
    fn truncated_reads_say_exactly_how_to_continue() {
        let v = serde_json::json!({
            "title": "Doc", "url": "https://x/", "text": "abcde",
            "truncated": true, "offset": 100, "nextOffset": 105, "total": 900,
        });
        let out = format_read(&v);
        assert!(out.contains("offset 105"), "got: {out}");
        assert!(out.contains("of 900 characters"));
        // The PAGE's own count wins. Rust counts `char`s and JavaScript counts
        // UTF-16 code units, so an emoji makes them differ by one — and a short
        // offset makes the next chunk repeat text already read.
        let emoji = serde_json::json!({
            "title": "Doc", "url": "https://x/", "text": "a🎉b",
            "truncated": true, "offset": 0, "nextOffset": 4, "total": 900,
        });
        let out = format_read(&emoji);
        assert!(out.contains("offset 4"), "the page's own count must win: {out}");
        // A page script older than `nextOffset` still gets a usable answer.
        let legacy = serde_json::json!({
            "title": "Doc", "url": "https://x/", "text": "abcde",
            "truncated": true, "offset": 100, "total": 900,
        });
        assert!(format_read(&legacy).contains("offset 105"));
        // A complete read must not invite a pointless follow-up call.
        let done = serde_json::json!({
            "title": "Doc", "url": "https://x/", "text": "abcde", "truncated": false,
        });
        assert!(!format_read(&done).contains("offset"));
    }

    #[test]
    fn action_results_report_failures_as_failures() {
        let v = serde_json::json!({
            "ok": false,
            "urlChanged": false,
            "results": [
                {"ok": true, "did": "clicked e1 — button \"Go\""},
                {"ok": false, "error": "e9 is gone — act on the fresh snapshot below."},
            ],
            "snapshot": snap(serde_json::json!([]), serde_json::json!({})),
        });
        let out = format_act(&v);
        assert!(out.contains("1. clicked e1"));
        assert!(out.contains("2. FAILED — e9 is gone"));
        assert!(out.contains("The page now:"));
    }

    #[test]
    fn typed_texts_finds_every_type_action_in_a_batch() {
        let actions = vec![
            serde_json::json!({"click": "e1"}),
            serde_json::json!({"type": {"ref": "e3", "text": "hello"}}),
            serde_json::json!({"scroll": "down"}),
            serde_json::json!({"type": {"ref": "e4", "text": "  "}}),
            serde_json::json!({"type": {"ref": "e5", "text": "world"}}),
        ];
        let found = typed_texts(&actions);
        // Whitespace-only text is nothing to ask consent about.
        assert_eq!(
            found,
            vec![
                ("e3".to_string(), "hello".to_string()),
                ("e5".to_string(), "world".to_string())
            ]
        );
    }

    /// PRIV-4, the hole the web-seam fix left open. `web_search`/`fetch_page`
    /// were masked at the seam, but `browse_open` reaches the SAME seven engines
    /// and the same public web, and its `url` argument goes through the very
    /// same `restore_value` on the way in from a cloud model. Without the mask
    /// the real name left this Mac through the browser instead.
    #[test]
    fn browse_open_masks_a_restored_name_before_it_reaches_the_engines() {
        let _guard = crate::commands::privacy::policy_test_lock();
        crate::commands::privacy::clear_policy();
        // No room / no policy: unchanged behaviour, and no note invented.
        assert_eq!(
            classify_browse_open("Ben Reich CV"),
            BrowseOpen::Search { query: "Ben Reich CV".into(), mask_note: String::new() }
        );

        crate::commands::privacy::set_policy_for_test(true);
        // A search still runs — masked — and SAYS it was masked.
        match classify_browse_open("Ben Reich CV") {
            BrowseOpen::Search { query, mask_note } => {
                assert_eq!(query, "[Person A] CV");
                assert!(!mask_note.is_empty(), "a masked search must disclose itself");
            }
            other => panic!("a protected name must not reach the engines: {other:?}"),
        }
        // A query with nothing protected in it is untouched and silent.
        assert_eq!(
            classify_browse_open("weather in Haifa"),
            BrowseOpen::Search { query: "weather in Haifa".into(), mask_note: String::new() }
        );
        // A URL cannot be masked and still resolve, so it is refused — the
        // exfiltration shape that matters is `https://anywhere/?q=<real name>`.
        match classify_browse_open("https://example.com/?q=Ben%20Reich") {
            BrowseOpen::Url(u) => panic!("a protected name left in a URL: {u}"),
            BrowseOpen::Refuse(msg) => assert!(msg.contains("protected name"), "{msg}"),
            other => panic!("unexpected: {other:?}"),
        }
        // An ordinary address is still opened.
        assert_eq!(
            classify_browse_open("https://example.com/docs"),
            BrowseOpen::Url("https://example.com/docs".into())
        );

        // Switch OFF: same documented asymmetry as `web_search` — real names
        // already flow to cloud models, so masking here would only break
        // lookups. Asserted so a change in EITHER direction lands loudly.
        crate::commands::privacy::set_policy_for_test(false);
        assert_eq!(
            classify_browse_open("Ben Reich CV"),
            BrowseOpen::Search { query: "Ben Reich CV".into(), mask_note: String::new() }
        );
        crate::commands::privacy::clear_policy();
    }

    #[test]
    fn every_advertised_browse_tool_has_a_dispatch_name() {
        let specs = browse_tools_specs();
        assert_eq!(specs.len(), BROWSE_TOOL_NAMES.len());
        for spec in &specs {
            let name = spec["function"]["name"].as_str().unwrap();
            assert!(is_browse_tool(name), "{name} is advertised but not dispatchable");
        }
        // ...and nothing is dispatchable that is not advertised.
        for name in BROWSE_TOOL_NAMES {
            assert!(
                specs.iter().any(|s| s["function"]["name"] == *name),
                "{name} is dispatchable but never advertised"
            );
        }
    }

    /// The room's internet switch is a promise ("this room stays offline"), and
    /// Back/Forward/Reload are real loads. Stop is the exception: cancelling a
    /// load must never be refused for being offline.
    #[test]
    fn only_the_chrome_actions_that_load_are_gated_on_the_internet_switch() {
        assert_eq!(browser_go_js("back"), Ok(("history.back()", true)));
        assert_eq!(browser_go_js("forward"), Ok(("history.forward()", true)));
        assert_eq!(browser_go_js("reload"), Ok(("location.reload()", true)));
        assert_eq!(browser_go_js("stop"), Ok(("window.stop()", false)));
        assert!(browser_go_js("teleport").is_err());
    }

    /// A screenshot composites the DOM, not the media layers, so a playing
    /// video is a blank rectangle in the picture. The model must be told, or it
    /// describes the video as "nothing there".
    #[test]
    fn a_page_with_video_warns_that_the_picture_cannot_show_it() {
        let note = uncapturable_media_note(&serde_json::json!({ "mediaAreas": 2 })).unwrap();
        assert!(note.contains("BLANK"), "{note:?}");
        assert!(note.contains('2'), "{note:?}");
        // An ordinary page must not carry the caveat.
        for quiet in [
            serde_json::json!({ "mediaAreas": 0 }),
            serde_json::json!({}),
            serde_json::Value::Null,
        ] {
            assert_eq!(uncapturable_media_note(&quiet), None, "for {quiet}");
        }
    }

    /// The gate and the list have to be ONE matcher. `Redactor` folds only
    /// ASCII case, so a name whose only difference is an accented letter's case
    /// failed the old `redact()` gate, never reached the list, and was typed
    /// into the page with no prompt and nothing in the journal.
    #[test]
    fn the_outbound_door_matches_names_the_same_way_it_lists_them() {
        let _guard = crate::commands::privacy::policy_test_lock();
        crate::commands::privacy::set_policy_rules_for_test(
            true,
            vec![
                ("José Álvarez".to_string(), "[Person A]".to_string()),
                // Below Redactor's own floor: a one-character entity matches
                // almost everything, and a card on every keystroke is a card
                // people learn to click through.
                ("A".to_string(), "[Person B]".to_string()),
            ],
        );
        assert_eq!(
            entities_in("please contact JOSÉ ÁLVAREZ today"),
            vec!["José Álvarez".to_string()],
            "an accented name in caps must still be recognised"
        );
        assert_eq!(entities_in("please contact josé álvarez"), vec!["José Álvarez".to_string()]);
        // The one-character rule must never make every string a match.
        assert!(entities_in("a plain sentence about nothing").is_empty());
        crate::commands::privacy::clear_policy();
    }

    /// A room with NO entity map is the case the door used to be blind to: it
    /// matched nothing, so it asked nothing, and the agent could type anything
    /// the room had told it into any web form. "Nothing matched" is not
    /// "nothing private".
    #[test]
    fn a_room_with_no_entity_map_still_asks_before_typing() {
        let _guard = crate::commands::privacy::policy_test_lock();
        crate::commands::privacy::clear_policy();
        let hits = outbound_hits("my flat is at 12 Herzl St").expect("must ask");
        assert!(hits.is_empty(), "nothing was recognised, so nothing may be named");

        // With a map, only a real match asks — the card must not cry wolf.
        crate::commands::privacy::set_policy_for_test(true);
        assert_eq!(outbound_hits("hello there"), None);
        assert_eq!(
            outbound_hits("mail from Ben Reich"),
            Some(vec!["Ben Reich".to_string()])
        );
        crate::commands::privacy::clear_policy();
    }

    /// The spec block is re-sent on EVERY model turn. The Playwright-MCP
    /// measurement (~13.7k tokens of tool definitions per turn) is the thing
    /// this budget exists to avoid.
    #[test]
    fn browse_specs_stay_within_their_token_budget() {
        let bytes = serde_json::to_string(&browse_tools_specs()).unwrap().len();
        assert!(
            bytes < 4_500,
            "browse tool specs grew to {bytes} bytes (~{} tokens) — trim them",
            bytes / 4
        );
    }
}
