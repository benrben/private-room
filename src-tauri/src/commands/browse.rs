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
            "description": "Open a web page in the room's private browser and return the page's interactive elements. The browser keeps nothing — no history, cookies or cache. Use this when the user asks you to visit, check or look something up on a specific site. Example: {\"url\": \"https://example.com\"}",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string", "description": "Full http(s) URL to open"}},
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
        let next = v.get("offset").and_then(|o| o.as_u64()).unwrap_or(0)
            + text.chars().count() as u64;
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
    let mut report = PrivacyReport::default();
    let _ = policy.redactor.redact(text, &mut report);
    if report.replacements == 0 {
        return Vec::new();
    }
    // Report the REAL strings that matched, in the order the map lists them —
    // the user is being asked about their own data, so showing placeholders
    // here would defeat the point of asking.
    policy
        .rules
        .iter()
        .filter(|(real, _)| {
            !real.trim().is_empty()
                && text.to_lowercase().contains(&real.to_lowercase())
        })
        .map(|(real, _)| real.clone())
        .collect()
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

    let outcome = exec_browse_inner(window, &app, name, args, effects).await;
    if let Err(e) = &outcome {
        // A failing browser tool must leave a trace the USER can read; the
        // model's own transcript is not something they can inspect after the
        // fact, and a silent loop is exactly what this feature must not do.
        browser::journal(&app, "error", "", &format!("{name} failed: {e}"));
    }
    outcome
}

async fn exec_browse_inner(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    name: &str,
    args: &serde_json::Value,
    effects: &mut ToolEffects,
) -> Result<String, String> {
    let app = app.clone();
    match name {
        "browse_open" => {
            let url = args["url"].as_str().unwrap_or_default().trim().to_string();
            // Bare hostnames are what people (and models) actually produce.
            let url = if url.contains("://") { url } else { format!("https://{url}") };
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
            Ok(clamp_tool_result(format_snapshot(&snap)))
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
            Ok(clamp_tool_result(format_read(&v)))
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
                return Ok(if occurrences > 0 {
                    format!(
                        "No control is labelled \"{text}\", but the page text mentions it {occurrences} time(s) — browse_read to see the context."
                    )
                } else {
                    format!("Nothing on this page matches \"{text}\".")
                });
            }
            let listed = serde_json::json!({ "elements": matches });
            Ok(clamp_tool_result(format!(
                "{} match(es) for \"{text}\":\n{}",
                matches.len(),
                format_snapshot(&listed)
            )))
        }

        "browse_snapshot" => {
            let v = browser::call(&app, "snapshot", serde_json::json!({})).await?;
            Ok(clamp_tool_result(format_snapshot(&v)))
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
                let hits = entities_in(&text);
                if !hits.is_empty() {
                    browser::journal(
                        &app,
                        "consent",
                        &url,
                        &format!("Asked to type room information into {field}: {}", hits.join(", ")),
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
                let _ = tauri::Emitter::emit(&app, "ask-step", "Navigated the page");
                let snap = v.get("snapshot").cloned().unwrap_or(serde_json::Value::Null);
                return Ok(clamp_tool_result(format!(
                    "The first action loaded a new page, so any later actions in that \
                     batch did NOT run. You are now on {now_url}\n{}",
                    format_snapshot(&snap)
                )));
            }

            let did = summarize_actions(&v);
            browser::journal(&app, "act", &url, &did);
            let _ = tauri::Emitter::emit(&app, "ask-step", did);

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
            Ok(clamp_tool_result(out))
        }

        "browse_look" => {
            let b64 = look_png(&app).await?;
            effects.pending_images.push(b64);
            let info = browser::call(&app, "info", serde_json::json!({})).await?;
            let url = info.get("url").and_then(|u| u.as_str()).unwrap_or("");
            browser::journal(&app, "look", url, "Looked at the page");
            Ok(format!(
                "Looking at {} — every interactive element is numbered with the same ref browse_snapshot uses.",
                info.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or(url)
            ))
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
    let _ = browser::call_async(
        app,
        "annotate",
        serde_json::json!({ "on": false }),
        Duration::from_secs(10),
    )
    .await;
    downscale_png_b64(&png, 1280)
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
    let info = browser::call(&app, "info", serde_json::json!({}))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e }));
    Ok(serde_json::json!({
        "open": true,
        "url": info.get("url").cloned().unwrap_or(serde_json::Value::Null),
        "title": info.get("title").cloned().unwrap_or(serde_json::Value::Null),
        "ready": info.get("ready").cloned().unwrap_or(serde_json::Value::Null),
        "takeover": app.state::<browser::BrowserState>().takeover.load(Ordering::SeqCst),
    }))
}

/// back / forward / reload / stop, driven from the chrome.
#[tauri::command]
pub async fn browser_go(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let wv = browser::webview(&app).ok_or("The browser isn't open.")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err(format!("Unknown browser action: {action}")),
    };
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

#[tauri::command]
pub fn browser_clear_journal(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::clear_browse_journal(&room.conn)
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
            "truncated": true, "offset": 100, "total": 900,
        });
        let out = format_read(&v);
        assert!(out.contains("offset 105"), "got: {out}");
        assert!(out.contains("of 900 characters"));
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
