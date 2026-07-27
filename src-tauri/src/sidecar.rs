//! ADD-33: run one answer through the local Python/LangGraph agent sidecar.
//!
//! This is the alternative to the native `agent_loop`, selected by the
//! `agent_engine` setting. The sidecar is the BRAIN only: it decides which tools
//! to call and when, but every tool executes back in THIS process through the
//! token-guarded loopback MCP bridge ([`crate::room_mcp`] with
//! [`ToolScope::LocalEngine`]). Decryption and file access never leave Rust.
//!
//! The sidecar streams NDJSON events; we translate each to the SAME Tauri events
//! the native loop emits (`ask-round`/`ask-delta`/`ask-step`/…), so the frontend
//! cannot tell the two engines apart. Tool side-effects (`wrote`/`annotation`/
//! `boxes`) accumulate into a shared [`EffectsSink`] and flow back to `ask`, so
//! the post-answer anti-fabrication gate works identically to the native path.
//!
//! Scope (MIGRATION Phase 2b): the sidecar handles EVERY local turn — file ops
//! (incl. writes), search, web, the whole-file-pass jobs, AND the app-driving
//! perception turns. The perception tools (`ui_snapshot`/`view_screenshot`/
//! `view_media_frame`) now hand their captured pixels back over the MCP bridge as
//! `image` content blocks ([`crate::room_mcp`] `tool_call` drains
//! `effects.pending_images`), which the sidecar graph feeds into the next model
//! turn as a user image message — so the perception handoff the in-process
//! `ToolEffects` used to carry natively now rides the bridge. A top-level turn
//! may also receive `consult_advisor`; the consulted advisor's restricted nested
//! bridge omits that runtime capability, keeping recursion structurally closed.
//!
//! No-fallback rule (MIGRATION): the sidecar is the app's SOLE local AI engine.
//! `Unavailable` (the sidecar failed BEFORE running any tool) surfaces an error to
//! the user ("AI engine unavailable …") — there is NO native Rust LLM fallback;
//! the native `agent_loop` is deleted. A mid-run failure is surfaced (`Failed`),
//! never retried: once a tool has run, its side-effect already happened in the
//! room, so re-running would double it.

use crate::commands::{AppState, ToolEffects};
use crate::room_mcp::{self, EffectsSink, ToolScope};
use crate::{ollama, sidecar_lifecycle};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

// MIGRATION Phase 3: the shared client for the FEATURE endpoints (summarize,
// studio, ai_action, vision_locate, file_pass_*, knowledge_extract, generate_doc,
// label, feedback_draft). Rust gathers the DB text, POSTs it here, and stores what
// comes back — the prompt + model I/O now live entirely in Python. Like the Phase-1
// gateway in `ollama.rs`, this ensures the sidecar is up first (no native fallback)
// and rebuilds the pre-migration error sentinels so each command's error surfaces
// stay byte-identical to when Rust called Ollama directly.

/// A classified failure from a sidecar feature endpoint: the sidecar's
/// `{code,error}` envelope plus the HTTP status. Most callers turn this into the
/// legacy `OLLAMA_DOWN` / `MODEL_MISSING:<model>` sentinel via [`Self::sentinel`];
/// a few (studios' `STUDIO_EMPTY`, ai_action's `UNKNOWN_ACTION`/`NEEDS_LANGUAGE`/
/// `EMPTY_RESULT`) match on [`Self::code`] to surface their own toast string verbatim.
pub struct SidecarError {
    pub code: String,
    pub error: String,
    pub status: u16,
}

impl SidecarError {
    /// Rebuild the pre-migration engine sentinel: `OLLAMA_DOWN` straight through,
    /// `MODEL_MISSING` re-tagged with the model name (the sidecar doesn't echo it),
    /// anything else a plain `Local AI error (<status>): <msg>` — so summarize.rs /
    /// file_pass.rs / vision.rs match exactly what they returned when Rust called
    /// Ollama directly. Mirrors `ollama::map_sidecar_error` (the Phase-1 gateway's).
    pub fn sentinel(&self, model: Option<&str>) -> String {
        match self.code.as_str() {
            "OLLAMA_DOWN" => "OLLAMA_DOWN".to_string(),
            "MODEL_MISSING" => match model {
                Some(m) => format!("MODEL_MISSING:{m}"),
                None => "MODEL_MISSING".to_string(),
            },
            _ => humanize_empty_generation(&self.error)
                .unwrap_or_else(|| format!("Local AI error ({}): {}", self.status, self.error)),
        }
    }
}

/// When an engine error means "the model gave us nothing usable" — a cloud model
/// out of quota (the provider's "usage limit" text), or an empty generation the
/// non-streamed langchain path masks as "No generation chunks were returned" —
/// return one actionable line; otherwise None. Shared by `SidecarError::sentinel`
/// AND the workflow node-error funnel, so an `agent_run`/`generate` failure reads
/// the same clear message no matter which path surfaced it.
pub(crate) fn humanize_empty_generation(msg: &str) -> Option<String> {
    let e = msg.to_lowercase();
    if e.contains("usage limit")
        || e.contains("reached your")
        || e.contains("no generation chunks")
        || e.contains("quota")
    {
        Some(
            "The AI model returned nothing. If this room uses a cloud model, it may \
             have hit its usage limit — switch to an on-device model in Settings → \
             Model, or try again later."
                .to_string(),
        )
    } else {
        None
    }
}

/// The per-request budget for a single gateway POST. Every endpoint here is
/// ONE model generation, and 600s is generous for one.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(600);

/// A CHAIN endpoint's budget. `/wf_node` runs up to seven generations (refine)
/// or ten (plan_and_map) behind a single POST, so it cannot share the
/// one-generation budget: a local 4B at 15 tok/s would trip 600s mid-chain and
/// the whole step would replay. Sized as the one-call budget times the longest
/// chain, rather than removed — an unbounded request would hang the lane
/// forever if the sidecar wedged.
pub const SIDECAR_CHAIN_TIMEOUT: Duration = Duration::from_secs(600 * 10);

/// POST a JSON body to a sidecar FEATURE endpoint and return the parsed JSON.
/// Ensures the sidecar is up first (no native fallback — a dead sidecar surfaces
/// as `OLLAMA_DOWN` so callers map it the same way a dead Ollama used to map). A
/// classified engine/feature failure comes back as [`SidecarError`] carrying the
/// `{code,error}` envelope; success is the raw response `Value`.
pub async fn sidecar_json(
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, SidecarError> {
    sidecar_json_timeout(path, body, SIDECAR_TIMEOUT).await
}

pub async fn sidecar_json_timeout(
    path: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, SidecarError> {
    // PRIV-1: THE Rust-side injection point — when the body's model is
    // non-local and the room's door is on, the privacy policy rides along so
    // the sidecar's mechanical seam engages. Bodies without a model (or with a
    // local one) pass through untouched.
    let mut request_body = crate::commands::inject_policy(body).unwrap_or_else(|| body.clone());
    if let Some(model) = request_body
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::to_string)
    {
        request_body = crate::commands::inject_provider_runtime(&request_body, &model).map_err(|e| {
            SidecarError { code: "ENGINE_ERROR".into(), error: e, status: 400 }
        })?;
    }
    let body = &request_body;
    // A dead sidecar is the no-fallback OLLAMA_DOWN surface (see module note).
    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => {
            return Err(SidecarError {
                code: "OLLAMA_DOWN".to_string(),
                error: e,
                status: 503,
            })
        }
    };
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| SidecarError {
            code: "ENGINE_ERROR".to_string(),
            error: e.to_string(),
            status: 0,
        })?;
    let resp = client
        .post(format!("{base}{path}"))
        .json(body)
        .send()
        .await
        .map_err(|e| SidecarError {
            // A connect/timeout to a sidecar that just answered its health check is
            // still an engine-availability failure — classify as OLLAMA_DOWN so the
            // caller's existing branch fires.
            code: if e.is_connect() || e.is_timeout() {
                "OLLAMA_DOWN".to_string()
            } else {
                "ENGINE_ERROR".to_string()
            },
            error: e.to_string(),
            status: 0,
        })?;
    let status = resp.status();
    if status.is_success() {
        return resp.json().await.map_err(|e| SidecarError {
            code: "ENGINE_ERROR".to_string(),
            error: e.to_string(),
            status: status.as_u16(),
        });
    }
    let v: serde_json::Value = resp.json().await.unwrap_or_default();
    Err(SidecarError {
        code: v["code"].as_str().unwrap_or("ENGINE_ERROR").to_string(),
        error: v["error"].as_str().unwrap_or("unknown error").to_string(),
        status: status.as_u16(),
    })
}

/// MIGRATION Phase 2a: streaming plain-text generation through the sidecar
/// `POST /generate_stream` (NDJSON). The streaming twin of the Phase-1
/// non-streaming `/generate` — POSTs `body` (the tool-less `/generate` schema
/// from [`crate::ollama::plain_generate_body`]), invokes `on_delta` once per
/// token as it arrives, and accumulates the full text to return. Replaces the
/// tool-less native streaming call whose output is streamed live into the chat
/// (`chat_commands::ask_streaming`), keeping the same per-token `ask-delta`
/// events.
///
/// `cancel` (ADD-7): when the user presses Stop we break out of the token loop and
/// return whatever streamed so far — dropping the response drops the in-flight
/// request, which closes the connection and stops Ollama. The caller treats the
/// partial as a stopped answer, exactly as the old native stream's partial was.
///
/// Errors ride INSIDE the `200` body as a `{"t":"error","code":…}` line (matching
/// `/pull`), possibly mid-stream after deltas already flushed and with no `done`.
/// We rebuild the pre-migration sentinel from `code` via [`SidecarError::sentinel`]
/// (`OLLAMA_DOWN` straight through, `MODEL_MISSING:<model>` re-tagged from the
/// body's model) so the caller surfaces the same string it did when Rust streamed
/// from Ollama directly. A dead sidecar is the no-fallback `OLLAMA_DOWN` surface.
pub async fn generate_stream(
    path: &str,
    body: &serde_json::Value,
    cancel: Option<Arc<AtomicBool>>,
    mut on_delta: impl FnMut(&str),
) -> Result<String, String> {
    use futures_util::StreamExt;

    // PRIV-1: same single injection as `sidecar_json` — the streaming twin.
    let mut request_body = crate::commands::inject_policy(body).unwrap_or_else(|| body.clone());
    if let Some(model) = request_body
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::to_string)
    {
        request_body = crate::commands::inject_provider_runtime(&request_body, &model)
            .map_err(|e| SidecarError {
                code: "ENGINE_ERROR".into(),
                error: e,
                status: 400,
            })
            .map_err(|e| e.sentinel(Some(&model)))?;
    }
    let body = &request_body;

    // The sidecar doesn't echo the model back on the error line, so rebuild the
    // `MODEL_MISSING:<model>` sentinel from the body's model (Copy `Option<&str>`).
    let model = body["model"].as_str();
    let sentinel = |code: &str, error: &str| {
        SidecarError {
            code: code.to_string(),
            error: error.to_string(),
            status: 200,
        }
        .sentinel(model)
    };

    // A dead sidecar is the no-fallback OLLAMA_DOWN surface (see `sidecar_json`).
    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => return Err(sentinel("OLLAMA_DOWN", &e)),
    };
    // The sidecar reaches Ollama but can't START it: ensure the local daemon is up
    // and hold the guard for the stream's whole duration (idle watcher won't sleep
    // it mid-answer). Engine parity: an external CLI model never touches Ollama,
    // so don't boot (or fail on) the daemon for it.
    let _daemon = match model.map(crate::commands::is_external_engine) {
        Some(true) => None,
        _ => match crate::ollama::wake_daemon().await {
            Ok(g) => Some(g),
            Err(e) => return Err(sentinel("OLLAMA_DOWN", &e)),
        },
    };
    // No request timeout: a stream delivers tokens incrementally and the shared
    // 600s cap would abort a long answer mid-way.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| sentinel("ENGINE_ERROR", &e.to_string()))?;
    let resp = client
        .post(format!("{base}{path}"))
        .json(body)
        .send()
        .await
        .map_err(|e| {
            // A connect/timeout to a sidecar that just passed its health check is
            // still an engine-availability failure — classify as OLLAMA_DOWN.
            let code = if e.is_connect() || e.is_timeout() {
                "OLLAMA_DOWN"
            } else {
                "ENGINE_ERROR"
            };
            sentinel(code, &e.to_string())
        })?;
    // The transport status is always 200 — the failure rides inside the body. A
    // non-200 (should not happen) is still surfaced classified, defensively.
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let v: serde_json::Value = resp.json().await.unwrap_or_default();
        return Err(SidecarError {
            code: v["code"].as_str().unwrap_or("ENGINE_ERROR").to_string(),
            error: v["error"].as_str().unwrap_or("unknown error").to_string(),
            status,
        }
        .sentinel(model));
    }

    let mut full = String::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        // ADD-7: user pressed Stop — abandon the stream, keep the partial
        // (dropping `resp` closes the connection, stopping Ollama).
        if let Some(flag) = &cancel {
            if flag.load(Ordering::SeqCst) {
                break;
            }
        }
        let chunk =
            chunk.map_err(|e| sentinel("ENGINE_ERROR", &format!("Local AI stream failed: {e}")))?;
        buf.extend_from_slice(&chunk);
        // NDJSON: process every complete line, keep the trailing partial.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1]; // drop '\n'
            if line.is_empty() {
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue, // skip a malformed line rather than abort
            };
            match ev.get("t").and_then(|t| t.as_str()) {
                Some("delta") => {
                    let d = ev.get("v").and_then(|v| v.as_str()).unwrap_or("");
                    if !d.is_empty() {
                        full.push_str(d);
                        on_delta(d);
                    }
                }
                // Clean end: exactly one `done` after the last delta.
                Some("done") => return Ok(full),
                Some("error") => {
                    let code = ev
                        .get("code")
                        .and_then(|c| c.as_str())
                        .unwrap_or("ENGINE_ERROR");
                    let error = ev
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("unknown error");
                    return Err(sentinel(code, error));
                }
                _ => {}
            }
        }
    }
    // Stream ended without an explicit `done` (Stop broke the loop, or a clean end
    // whose terminator was already drained): return whatever accumulated.
    Ok(full)
}

/// Like [`sidecar_json`], but races the POST against a caller-owned cancel flag
/// (ADD-31/ADD-32): a Studio authoring a whole page, or a whole-file pass running
/// one Job-tier call per window, runs for minutes and Stop must abandon it
/// promptly. The feature endpoints are single blocking POSTs with no cancel token,
/// so on Stop we DROP the in-flight request (dropping the reqwest future closes the
/// connection, which stops Ollama) and return `Ok(None)` — the caller treats `None`
/// as a stopped step. A completed body is `Ok(Some(value))`.
pub async fn sidecar_json_cancellable(
    path: &str,
    body: &serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<serde_json::Value>, SidecarError> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let fut = sidecar_json(path, body);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return res.map(Some),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    // Returning here drops `fut`, aborting the in-flight request.
                    return Ok(None);
                }
            }
        }
    }
}

/// Like [`sidecar_json_cancellable`], but for a CHAIN endpoint that runs many
/// generations behind one POST, and therefore cannot be stopped by hanging up.
///
/// Dropping the request closes the connection, and the docstring above assumes
/// that stops the work. Measured against the sidecar's pinned uvicorn/starlette,
/// it does not: a non-streaming handler kept running three seconds past a hard
/// disconnect. For `/generate` that wastes at most one generation. For
/// `/wf_node` it would waste up to six more — on `Lane::LocalLlm`'s single slot,
/// holding the GPU and the resident model while the next job queues behind.
///
/// So Stop is DELIVERED, not implied: POST `/cancel` with the same `run_id` the
/// body carried, then drop. The sidecar registers `/wf_node` in the very same
/// `RunRegistry` `/run` uses, so this is the path that already works for chat.
pub async fn sidecar_json_cancellable_run(
    path: &str,
    body: &serde_json::Value,
    cancel: &Arc<AtomicBool>,
    run_id: &str,
    timeout: Duration,
) -> Result<Option<serde_json::Value>, SidecarError> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let fut = sidecar_json_timeout(path, body, timeout);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return res.map(Some),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    // Tell the sidecar BEFORE dropping: the drop alone does not
                    // stop it. Best-effort — if the POST fails the chain
                    // finishes, which is the pre-existing behaviour, not worse.
                    if let Ok(base) = sidecar_lifecycle::ensure_up().await {
                        let _ = cancel_run(&base, run_id).await;
                    }
                    return Ok(None);
                }
            }
        }
    }
}

/// Lane routing for one ask, with per-conversation LATCHING (2026-07-23).
///
/// The keyword routers used to see only the CURRENT question, so "research X"
/// → "now save that" lost the very tools the follow-up needed whenever the
/// follow-up's phrasing missed the hint list (live QA: the agent told the user
/// it could not save files). Lanes now latch monotonically over the chat: a
/// lane fires if the current question OR any PRIOR user turn wanted it.
///
/// Two deliberate exclusions:
/// * The LAST message is skipped — it is the composed user turn carrying
///   injected file context, the skills preamble ("Available Agent Skills…"),
///   and memories, any of which would false-fire lanes on every ask.
/// * `write` stays question-only: the write tools are always in the catalog
///   now, so the boolean only colors the "Working on your files" lane label,
///   which should reflect THIS turn's intent.
pub(crate) fn sticky_lanes(
    question: &str,
    chat_messages: &[ollama::ChatMessage],
) -> serde_json::Value {
    let prior: Vec<&str> = chat_messages
        .iter()
        .take(chat_messages.len().saturating_sub(1))
        .filter(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .collect();
    let fires = |f: fn(&str) -> bool| f(question) || prior.iter().any(|q| f(q));
    serde_json::json!({
        "write": crate::commands::wants_write_tools(question),
        "ui": fires(crate::commands::wants_ui_tools),
        "jobs": fires(crate::commands::wants_job_tools),
        "skills": fires(crate::commands::wants_skill_tools),
        "connectors": fires(crate::commands::wants_mcp_management_tools),
    })
}

/// The result of attempting an answer through the sidecar.
pub enum SidecarOutcome {
    /// Completed (or was cleanly stopped) — use this text.
    Done(String),
    /// Failed before any tool ran. With no native fallback, the caller now surfaces
    /// this as an error ("AI engine unavailable …"); the carried string is the
    /// underlying reason, logged for debugging a broken sidecar/Python install.
    Unavailable(String),
    /// The sidecar started and accepted the run, but the selected model/provider
    /// rejected or failed the request before any tool executed. This is not a
    /// sidecar startup failure and must retain its actionable upstream message.
    EngineError(String),
    /// Failed after a tool already executed — do NOT fall back (re-running would
    /// double the side-effect). Carries whatever text had streamed plus the error,
    /// so the caller can still persist the partial reply + committed effects: a
    /// write that DID happen must be visible even though the run then failed.
    Failed { text: String, error: String },
}

/// Run the answer through the sidecar, accumulating tool effects into `effects`.
/// Emits the same events the native loop does.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub async fn run_via_sidecar(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    model: &str,
    question: &str,
    chat_messages: Vec<ollama::ChatMessage>,
    temperature: Option<f64>,
    effects: &mut ToolEffects,
    web_enabled: bool,
    cancel: Arc<AtomicBool>,
    // Wave 4a: HEADLESS mode for a workflow agent_run node — suppress the global
    // ask-* stream events so a background/scheduled turn never corrupts (or
    // interleaves with) the visible chat. Ordinary chat asks pass `false`.
    headless: bool,
    // PRIV-1: "send real details this once" — the user explicitly confirmed
    // sharing real values for THIS turn, so the policy is not attached.
    privacy_bypass: bool,
    // Installed advisors available to this top-level model. Empty when the
    // room setting is off; never forwarded to a consulted advisor.
    advisors: Vec<String>,
    advisor_tools_enabled: bool,
) -> SidecarOutcome {
    use tauri::Manager;

    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => return SidecarOutcome::Unavailable(e),
    };

    // The sidecar reaches Ollama but can't START it: ensure the local daemon is up
    // and hold the guard for the run's duration. No tool has run yet, so a down or
    // unstartable daemon is the safe `Unavailable` surface.
    // Only an Ollama-served model needs the local daemon. An API provider and a
    // cloud CLI engine both generate elsewhere, so requiring Ollama would make
    // chat fail on a Mac that never runs it.
    let _daemon = if crate::commands::is_api_provider_model(model)
        || crate::commands::is_cli_engine(model)
    {
        None
    } else {
        match ollama::wake_daemon().await {
            Ok(g) => Some(g),
            Err(e) => return SidecarOutcome::Unavailable(e),
        }
    };

    // The run-scoped effects sink the bridge accumulates into, seeded with the
    // caller's current effects (esp. `vision_chat`) so nothing is lost.
    let sink: EffectsSink = Arc::new(tokio::sync::Mutex::new(std::mem::take(effects)));

    let advisor_names = advisors.clone();
    let (advisor_runtime, consulted_room_bridge) = room_mcp::prepare_advisor_runtime(
        window.app_handle().clone(),
        web_enabled,
        advisors,
        advisor_tools_enabled,
        cancel.clone(),
        privacy_bypass,
    )
    .await;

    // The LOCAL-engine bridge: the sidecar is trusted like the native loop, so it
    // gets the app-driving + job tools too (ADD-33). Torn down when we return.
    //
    // ENGINE PARITY: the agent hub now runs on a cloud CLI too (its rounds are
    // `claude -p`/`codex exec` behind the same ChatModel seam), and the tools
    // the sidecar can serve are decided HERE, not by who is asking. So the
    // scope follows the ENGINE: a CLI engine gets `CloudEngine` — everything
    // the local engine gets EXCEPT the UI/screen-driving tools. "Any model
    // drives the screen" stays forbidden; everything else is parity (owner
    // decision 2026-07-25, see `primary_cli_scope`).
    let scope = if crate::commands::is_cli_engine(model) {
        crate::commands::primary_cli_scope()
    } else {
        ToolScope::LocalEngine
    };
    let bridge = match room_mcp::start(
        window.app_handle().clone(),
        web_enabled,
        scope,
        Some(sink.clone()),
        room_mcp::StartOpts {
            privacy_bypass,
            advisor: advisor_runtime,
            ..Default::default()
        },
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            if let Some(nested) = consulted_room_bridge {
                nested.stop();
            }
            // Restore effects before bailing (nothing ran).
            *effects = sink.lock().await.clone();
            return SidecarOutcome::Unavailable(format!("sidecar bridge failed: {e}"));
        }
    };

    let mcp_route_count = crate::commands::mcp_routes(state).len();
    // Token-bar denominator for an engine that reports no usage of its own. The
    // app imposes no context limit on a cloud CLI — this is display only, and
    // it is resolved HERE because only the host can read the live Codex
    // catalog. Ollama/provider models report their own window; they send none.
    let max_context: Option<u32> = if crate::commands::is_cli_engine(model) {
        let (engine, submodel, _effort) = crate::commands::split_external_model(model);
        Some(match engine {
            "codex-cli" => crate::commands::codex_context_window(submodel)
                .await
                .unwrap_or_else(|| crate::model_limits::external_max_context(engine)),
            _ => crate::model_limits::external_max_context(engine),
        })
    } else {
        None
    };
    let body = serde_json::json!({
        "model": model,
        "max_context": max_context,
        "question": question,
        "messages": chat_messages,
        "temperature": temperature,
        "ollama_base_url": ollama::resolved_base_url(),
        "mcp": { "url": bridge.mcp_url(), "token": bridge.token },
        // The sidecar re-derives the tool subset from these, mirroring the native
        // router. MIGRATION Phase 2b: ui turns now route here too, so `ui` reflects
        // the same deterministic router the native loop used — the LocalEngine
        // bridge scope serves the ui/perception + job tools when they fire.
        // 2026-07-23: lanes LATCH per conversation (sticky_lanes) — once a prior
        // turn opened a lane, a follow-up phrased without a keyword ("now do
        // that for the rest") must not silently lose the tools. `write` stays
        // question-only: it feeds only the cosmetic lane label now (the write
        // tools themselves are always in the catalog).
        "routing": sticky_lanes(question, &chat_messages),
        "web_enabled": web_enabled,
        "mcp_routes": mcp_route_count,
        "advisors": advisor_names,
        "run_id": bridge.token,
    });
    // PRIV-1: attach the room policy for a non-local model (the sidecar's chat
    // seam + live guard engage on it) — unless the user opened the door for
    // this one turn.
    let body = if privacy_bypass {
        body
    } else {
        crate::commands::inject_policy(&body).unwrap_or(body)
    };
    let body = match crate::commands::inject_provider_runtime(&body, model) {
        Ok(body) => body,
        Err(e) => return SidecarOutcome::Unavailable(e),
    };

    let streamed = stream_run(&base, &body, window, &cancel, headless).await;
    // The bridge's own record of whether a tool was dispatched to `exec_tool`.
    // This is the crash-safe source of truth: the in-stream `step` line and the
    // tool's side-effect commit travel on two independent connections, so a
    // sidecar crash between the commit and the line reaching us would leave
    // `StreamResult`'s `tool_ran` false while a write already happened. Read it
    // while the bridge is still alive, then tear the bridge down.
    let bridge_tool_ran = bridge.tool_ran();
    bridge.stop();
    if let Some(nested) = consulted_room_bridge {
        nested.stop();
    }

    // Merge whatever the bridge accumulated back into the caller's effects,
    // regardless of outcome — a write that DID happen must be visible to the
    // anti-fabrication gate even if the stream then failed.
    *effects = sink.lock().await.clone();

    match streamed {
        StreamResult::Done(text, usage, plan) => {
            effects.token_usage = usage;
            effects.agent_plan = plan;
            SidecarOutcome::Done(text)
        }
        // Stop mid-answer is expected — keep whatever streamed (the caller adds
        // the "(stopped)" marker).
        StreamResult::Cancelled(text, usage, plan) => {
            effects.token_usage = usage;
            effects.agent_plan = plan;
            SidecarOutcome::Done(text)
        }
        StreamResult::Failed {
            text,
            error,
            tool_ran,
            usage,
            plan,
        } => {
            effects.token_usage = usage;
            effects.agent_plan = plan;
            // Distinguish the two no-fallback surfaces. If a tool already ran —
            // per the in-stream `step` line OR the bridge's own dispatch flag —
            // its side-effect is committed, so we surface `Failed` (the caller
            // keeps the partial reply + merged effects; re-running would double
            // the write). If NO tool ran, the sidecar failed before doing
            // anything, so it's `Unavailable` → the caller shows the
            // provider/model error. Neither path re-runs anything.
            if tool_ran || bridge_tool_ran {
                SidecarOutcome::Failed { text, error }
            } else {
                SidecarOutcome::EngineError(error)
            }
        }
    }
}

enum StreamResult {
    Done(String, Option<serde_json::Value>, Option<serde_json::Value>),
    Cancelled(String, Option<serde_json::Value>, Option<serde_json::Value>),
    Failed {
        text: String,
        error: String,
        tool_ran: bool,
        usage: Option<serde_json::Value>,
        plan: Option<serde_json::Value>,
    },
}

/// POST /run and translate the NDJSON event stream to Tauri events.
async fn stream_run(
    base: &str,
    body: &serde_json::Value,
    window: &tauri::Window,
    cancel: &Arc<AtomicBool>,
    headless: bool,
) -> StreamResult {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            return StreamResult::Failed {
                text: String::new(),
                error: e.to_string(),
                tool_ran: false,
                usage: None,
                plan: None,
            }
        }
    };
    let resp = match client.post(format!("{base}/run")).json(body).send().await {
        Ok(r) => r,
        Err(e) => {
            return StreamResult::Failed {
                text: String::new(),
                error: format!("sidecar /run failed: {e}"),
                tool_ran: false,
                usage: None,
                plan: None,
            }
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| safe_validation_detail(&value));
        return StreamResult::Failed {
            text: String::new(),
            error: match detail {
                Some(detail) => format!("sidecar /run status {status}: {detail}"),
                None => format!("sidecar /run status {status}"),
            },
            tool_ran: false,
            usage: None,
            plan: None,
        };
    }

    let run_id = body["run_id"].as_str().unwrap_or_default().to_string();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut final_text = String::new();
    // Token-budget bar: the latest round's usage snapshot seen so far — last
    // one wins, mirroring `final_text`'s own "whatever streamed so far" shape.
    let mut last_usage: Option<serde_json::Value> = None;
    // Agent visibility: the turn's roster (the `plan` event body). Captured
    // regardless of `headless` — it also persists into the message effects.
    let mut last_plan: Option<serde_json::Value> = None;
    // A `step` event means a tool is being executed over the bridge — once seen,
    // a side-effect has (or is about to have) happened, so no native fallback.
    let mut tool_ran = false;

    loop {
        // Poll `cancel` CONCURRENTLY with the next chunk. A tool executes over a
        // separate connection and streams no NDJSON while it runs, so waiting only
        // on `stream.next()` would leave Stop unobserved for the whole tool (up to
        // ~90s) — the exact "stop after the next tool" lag the loop is meant to
        // avoid. `biased` prefers draining data; the cancel arm wins only when the
        // stream is idle. On Stop we POST /cancel (so the sidecar drops its own
        // between-tool token) and return whatever streamed.
        let chunk = tokio::select! {
            biased;
            next = stream.next() => match next {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    return StreamResult::Failed {
                        text: final_text,
                        error: e.to_string(),
                        tool_ran,
                        usage: last_usage,
                        plan: last_plan,
                    }
                }
                None => break, // stream ended
            },
            _ = wait_for_cancel(cancel) => {
                let _ = cancel_run(base, &run_id).await; // best-effort
                return StreamResult::Cancelled(final_text, last_usage, last_plan);
            }
        };
        buf.extend_from_slice(&chunk);
        // NDJSON: process every complete line, keep the trailing partial.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = &line[..line.len() - 1]; // drop '\n'
            if line.is_empty() {
                continue;
            }
            if cancel.load(Ordering::SeqCst) {
                let _ = cancel_run(base, &run_id).await; // best-effort
                return StreamResult::Cancelled(final_text, last_usage, last_plan);
            }
            let ev: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue, // skip a malformed line rather than abort
            };
            match ev.get("t").and_then(|t| t.as_str()) {
                // Wave 4a: headless runs (a workflow agent_run node) suppress every
                // ask-* emit so a background turn never streams into the chat UI.
                // Dispatch-first agent visibility: `plan` is the full roster of
                // domain agents handling this ask (emitted once, before work
                // starts); `agent` marks which one is active as steps advance.
                // Payloads are forwarded as-is (JSON) — the shapes are the
                // sidecar's plan/agent event bodies (graph.py run_agent).
                Some("plan") => {
                    last_plan = ev.get("v").cloned();
                    if !headless {
                        let _ = window.emit(
                            "ask-plan",
                            last_plan.clone().unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
                Some("agent") => {
                    if !headless {
                        let _ = window.emit(
                            "ask-agent",
                            ev.get("v").cloned().unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
                Some("lane") => {
                    if !headless {
                        let _ = window.emit("ask-lane", str_v(&ev));
                    }
                }
                Some("round") => {
                    if !headless {
                        let _ = window.emit("ask-round", ());
                    }
                }
                Some("delta") => {
                    if !headless {
                        let _ = window.emit("ask-delta", str_v(&ev));
                    }
                }
                // Both carry `node`: the agent-graph slot of the loop that
                // emitted them ("main", or "<agent id>#<slot>"). Parallel
                // children interleave their events, so arrival order attributes
                // nothing — the stamp is the only way the UI files a step under
                // the right node. Absent on an older sidecar; forwarded as null,
                // which the frontend reads as "the active agent" (the old
                // behaviour).
                Some("step") => {
                    tool_ran = true;
                    if !headless {
                        let _ = window.emit(
                            "ask-step",
                            serde_json::json!({
                                "label": str_v(&ev),
                                "node": ev.get("node").and_then(|n| n.as_str()),
                            }),
                        );
                    }
                }
                Some("step_status") => {
                    if !headless {
                        let ok = ev.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                        let _ = window.emit(
                            "ask-step-status",
                            serde_json::json!({
                                "ok": ok,
                                "node": ev.get("node").and_then(|n| n.as_str()),
                            }),
                        );
                    }
                }
                Some("final") => {
                    final_text = str_v(&ev).to_string();
                }
                // PRIV-1: what the door did this turn ("N details hidden") —
                // arrives after `final`, rendered on the finished message.
                Some("privacy") => {
                    if !headless {
                        let _ = window.emit(
                            "ask-privacy",
                            ev.get("v").cloned().unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
                // Token-budget bar: one snapshot per round. Strip the NDJSON
                // discriminator before emitting/persisting — the payload shape
                // is `AskTokenUsage` (apiTypes.ts), which carries no `"t"` key.
                Some("usage") => {
                    let mut usage = ev.clone();
                    if let serde_json::Value::Object(map) = &mut usage {
                        map.remove("t");
                    }
                    if !headless {
                        let _ = window.emit("ask-token-usage", usage.clone());
                    }
                    last_usage = Some(usage);
                }
                Some("error") => {
                    return StreamResult::Failed {
                        text: final_text,
                        error: str_v(&ev).to_string(),
                        tool_ran,
                        usage: last_usage,
                        plan: last_plan,
                    };
                }
                _ => {}
            }
        }
    }
    StreamResult::Done(final_text, last_usage, last_plan)
}

fn str_v(ev: &serde_json::Value) -> &str {
    ev.get("v").and_then(|v| v.as_str()).unwrap_or("")
}

/// Extract only Pydantic's safe location/message pairs. FastAPI validation
/// bodies can also contain the rejected input value, which for provider
/// requests includes the API key and must never reach logs or the UI.
fn safe_validation_detail(value: &serde_json::Value) -> Option<String> {
    let errors = value.get("detail")?.as_array()?;
    let parts: Vec<String> = errors
        .iter()
        .filter_map(|error| {
            let message = error.get("msg")?.as_str()?;
            let location = error
                .get("loc")
                .and_then(|loc| loc.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .filter(|item| *item != "body")
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            Some(if location.is_empty() {
                message.to_string()
            } else {
                format!("{location}: {message}")
            })
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// Resolve as soon as `cancel` is set. Polled every 100ms so Stop is observed
/// even while a silent, long-running tool holds the `/run` stream idle.
async fn wait_for_cancel(cancel: &Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn cancel_run(base: &str, run_id: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .post(format!("{base}/cancel"))
        .json(&serde_json::json!({ "run_id": run_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_sentinels_survive_the_migration() {
        // The `{code}` → legacy-sentinel mapping the callers still match on.
        let down = SidecarError {
            code: "OLLAMA_DOWN".into(),
            error: "x".into(),
            status: 503,
        };
        assert_eq!(down.sentinel(Some("gemma3:4b")), "OLLAMA_DOWN");
        let missing = SidecarError {
            code: "MODEL_MISSING".into(),
            error: "x".into(),
            status: 404,
        };
        assert_eq!(
            missing.sentinel(Some("gemma3:4b")),
            "MODEL_MISSING:gemma3:4b"
        );
        assert_eq!(missing.sentinel(None), "MODEL_MISSING");
        let other = SidecarError {
            code: "ENGINE_ERROR".into(),
            error: "boom".into(),
            status: 500,
        };
        assert_eq!(
            other.sentinel(Some("gemma3:4b")),
            "Local AI error (500): boom"
        );
    }

    #[test]
    fn validation_detail_never_includes_rejected_secret_input() {
        let body = serde_json::json!({
            "detail": [{
                "loc": ["body", "provider", "api_key"],
                "msg": "Field required",
                "type": "missing",
                "input": {"apiKey": "do-not-leak"}
            }]
        });
        let detail = safe_validation_detail(&body).unwrap();
        assert_eq!(detail, "provider.api_key: Field required");
        assert!(!detail.contains("do-not-leak"));
    }

    fn msg(role: &str, content: &str) -> ollama::ChatMessage {
        ollama::ChatMessage::new(role, content)
    }

    #[test]
    fn lanes_latch_over_prior_user_turns() {
        // Turn 1 opened the jobs lane; turn 2's phrasing has no jobs keyword —
        // the lane must stay open ("now save that" must not lose the tools).
        let history = vec![
            msg("system", "You are the room assistant."),
            msg("user", "summarize the entire book"),
            msg("assistant", "Working on it."),
            msg("user", "now give me the three main points"), // composed final turn
        ];
        let r = sticky_lanes("now give me the three main points", &history);
        assert_eq!(r["jobs"], true);
        // A lane no prior turn wanted stays closed.
        assert_eq!(r["connectors"], false);
    }

    #[test]
    fn the_composed_final_turn_and_system_prompt_never_fire_lanes() {
        // The final user message carries injected context ("Available Agent
        // Skills…", file excerpts mentioning workflows) and the system prompt
        // names every tool — neither may open a lane by itself.
        let history = vec![
            msg("system", "tools: save_workflow, skills, connectors, screenshot"),
            msg(
                "user",
                "Available Agent Skills (specialized instructions)…\nQuestion: what is the rent",
            ),
        ];
        let r = sticky_lanes("what is the rent", &history);
        assert_eq!(r["jobs"], false);
        assert_eq!(r["skills"], false);
        assert_eq!(r["connectors"], false);
        assert_eq!(r["ui"], false);
    }

    #[test]
    fn hebrew_questions_route_lanes() {
        // Substring hints must cover Hebrew or a Hebrew-speaking user can NEVER
        // open a lane (to_lowercase is identity for Hebrew — plain contains()).
        assert_eq!(sticky_lanes("תרגם את כל הספר", &[])["jobs"], true);
        assert_eq!(sticky_lanes("פתח את המסמך על המסך", &[])["ui"], true);
        let write = sticky_lanes("שמור את זה כקובץ", &[]);
        assert_eq!(write["write"], true);
    }
}
