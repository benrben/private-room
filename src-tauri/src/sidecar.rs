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
//! `ToolEffects` used to carry natively now rides the bridge. `consult_advisor`
//! remains served over no scope's catalog (the cloud-recursion guard stays shut).
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

/// POST a JSON body to a sidecar FEATURE endpoint and return the parsed JSON.
/// Ensures the sidecar is up first (no native fallback — a dead sidecar surfaces
/// as `OLLAMA_DOWN` so callers map it the same way a dead Ollama used to map). A
/// classified engine/feature failure comes back as [`SidecarError`] carrying the
/// `{code,error}` envelope; success is the raw response `Value`.
pub async fn sidecar_json(
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, SidecarError> {
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
        .timeout(Duration::from_secs(600))
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
    // it mid-answer).
    let _daemon = match crate::ollama::wake_daemon().await {
        Ok(g) => g,
        Err(e) => return Err(sentinel("OLLAMA_DOWN", &e)),
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
                    let code = ev.get("code").and_then(|c| c.as_str()).unwrap_or("ENGINE_ERROR");
                    let error = ev.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error");
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

/// The result of attempting an answer through the sidecar.
pub enum SidecarOutcome {
    /// Completed (or was cleanly stopped) — use this text.
    Done(String),
    /// Failed before any tool ran. With no native fallback, the caller now surfaces
    /// this as an error ("AI engine unavailable …"); the carried string is the
    /// underlying reason, logged for debugging a broken sidecar/Python install.
    Unavailable(String),
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
) -> SidecarOutcome {
    use tauri::Manager;

    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => return SidecarOutcome::Unavailable(e),
    };

    // The sidecar reaches Ollama but can't START it: ensure the local daemon is up
    // and hold the guard for the run's duration. No tool has run yet, so a down or
    // unstartable daemon is the safe `Unavailable` surface.
    let _daemon = match ollama::wake_daemon().await {
        Ok(g) => g,
        Err(e) => return SidecarOutcome::Unavailable(e),
    };

    // The run-scoped effects sink the bridge accumulates into, seeded with the
    // caller's current effects (esp. `vision_chat`) so nothing is lost.
    let sink: EffectsSink = Arc::new(tokio::sync::Mutex::new(std::mem::take(effects)));

    // The LOCAL-engine bridge: the sidecar is trusted like the native loop, so it
    // gets the app-driving + job tools too (ADD-33). Torn down when we return.
    let bridge = match room_mcp::start(
        window.app_handle().clone(),
        web_enabled,
        ToolScope::LocalEngine,
        Some(sink.clone()),
        room_mcp::StartOpts::default(),
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            // Restore effects before bailing (nothing ran).
            *effects = sink.lock().await.clone();
            return SidecarOutcome::Unavailable(format!("sidecar bridge failed: {e}"));
        }
    };

    let mcp_route_count = crate::commands::mcp_routes(state).0.len();
    let body = serde_json::json!({
        "model": model,
        "question": question,
        "messages": chat_messages,
        "temperature": temperature,
        "ollama_base_url": ollama::resolved_base_url(),
        "mcp": { "url": bridge.mcp_url(), "token": bridge.token },
        // The sidecar re-derives the tool subset from these, mirroring the native
        // router. MIGRATION Phase 2b: ui turns now route here too, so `ui` reflects
        // the same deterministic router the native loop used — the LocalEngine
        // bridge scope serves the ui/perception + job tools when they fire.
        "routing": {
            "write": crate::commands::wants_write_tools(question),
            "ui": crate::commands::wants_ui_tools(question),
            "jobs": crate::commands::wants_job_tools(question),
        },
        "web_enabled": web_enabled,
        "mcp_routes": mcp_route_count,
        // The sidecar never runs consult_advisor (recursion guard) — no advisors.
        "advisors": Vec::<String>::new(),
        "run_id": bridge.token,
    });

    let streamed = stream_run(&base, &body, window, &cancel, headless).await;
    // The bridge's own record of whether a tool was dispatched to `exec_tool`.
    // This is the crash-safe source of truth: the in-stream `step` line and the
    // tool's side-effect commit travel on two independent connections, so a
    // sidecar crash between the commit and the line reaching us would leave
    // `StreamResult`'s `tool_ran` false while a write already happened. Read it
    // while the bridge is still alive, then tear the bridge down.
    let bridge_tool_ran = bridge.tool_ran();
    bridge.stop();

    // Merge whatever the bridge accumulated back into the caller's effects,
    // regardless of outcome — a write that DID happen must be visible to the
    // anti-fabrication gate even if the stream then failed.
    *effects = sink.lock().await.clone();

    match streamed {
        StreamResult::Done(text) => SidecarOutcome::Done(text),
        // Stop mid-answer is expected — keep whatever streamed (the caller adds
        // the "(stopped)" marker).
        StreamResult::Cancelled(text) => SidecarOutcome::Done(text),
        StreamResult::Failed { text, error, tool_ran } => {
            // Distinguish the two no-fallback surfaces. If a tool already ran —
            // per the in-stream `step` line OR the bridge's own dispatch flag —
            // its side-effect is committed, so we surface `Failed` (the caller
            // keeps the partial reply + merged effects; re-running would double
            // the write). If NO tool ran, the sidecar failed before doing
            // anything, so it's `Unavailable` → the caller shows the
            // "AI engine unavailable" error. Neither path re-runs anything.
            if tool_ran || bridge_tool_ran {
                SidecarOutcome::Failed { text, error }
            } else {
                SidecarOutcome::Unavailable(error)
            }
        }
    }
}

enum StreamResult {
    Done(String),
    Cancelled(String),
    Failed {
        text: String,
        error: String,
        tool_ran: bool,
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
            }
        }
    };
    if !resp.status().is_success() {
        return StreamResult::Failed {
            text: String::new(),
            error: format!("sidecar /run status {}", resp.status()),
            tool_ran: false,
        };
    }

    let run_id = body["run_id"].as_str().unwrap_or_default().to_string();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut final_text = String::new();
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
                    }
                }
                None => break, // stream ended
            },
            _ = wait_for_cancel(cancel) => {
                let _ = cancel_run(base, &run_id).await; // best-effort
                return StreamResult::Cancelled(final_text);
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
                return StreamResult::Cancelled(final_text);
            }
            let ev: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue, // skip a malformed line rather than abort
            };
            match ev.get("t").and_then(|t| t.as_str()) {
                // Wave 4a: headless runs (a workflow agent_run node) suppress every
                // ask-* emit so a background turn never streams into the chat UI.
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
                Some("step") => {
                    tool_ran = true;
                    if !headless {
                        let _ = window.emit("ask-step", str_v(&ev));
                    }
                }
                Some("step_status") => {
                    if !headless {
                        let ok = ev.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                        let _ = window.emit("ask-step-status", serde_json::json!({ "ok": ok }));
                    }
                }
                Some("final") => {
                    final_text = str_v(&ev).to_string();
                }
                Some("error") => {
                    return StreamResult::Failed {
                        text: final_text,
                        error: str_v(&ev).to_string(),
                        tool_ran,
                    };
                }
                _ => {}
            }
        }
    }
    StreamResult::Done(final_text)
}

fn str_v(ev: &serde_json::Value) -> &str {
    ev.get("v").and_then(|v| v.as_str()).unwrap_or("")
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
        let down = SidecarError { code: "OLLAMA_DOWN".into(), error: "x".into(), status: 503 };
        assert_eq!(down.sentinel(Some("gemma3:4b")), "OLLAMA_DOWN");
        let missing = SidecarError { code: "MODEL_MISSING".into(), error: "x".into(), status: 404 };
        assert_eq!(missing.sentinel(Some("gemma3:4b")), "MODEL_MISSING:gemma3:4b");
        assert_eq!(missing.sentinel(None), "MODEL_MISSING");
        let other = SidecarError { code: "ENGINE_ERROR".into(), error: "boom".into(), status: 500 };
        assert_eq!(other.sentinel(Some("gemma3:4b")), "Local AI error (500): boom");
    }
}
