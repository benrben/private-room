//! ADD-33: run one answer through the local Python/LangGraph agent sidecar.
//!
//! This is the app's ONLY answering path — the native `agent_loop` it was once
//! an alternative to is deleted, and the `agent_engine` setting that chose
//! between them is gone. The sidecar is the BRAIN only: it decides which tools
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

/// The sidecar itself would not start. Three unrelated failures used to arrive
/// as one `OLLAMA_DOWN`: a stalled model, a broken Python helper, and a genuinely
/// closed Ollama. The first now keeps its own message (see the timeout branch in
/// `sidecar_json_timeout`); this is the second.
pub const SIDECAR_DOWN: &str = "SIDECAR_DOWN";

impl SidecarError {
    /// Rebuild the pre-migration engine sentinel: `OLLAMA_DOWN` straight through,
    /// `MODEL_MISSING` re-tagged with the model name (the sidecar doesn't echo it),
    /// anything else a plain `Local AI error (<status>): <msg>` — so summarize.rs /
    /// file_pass.rs / vision.rs match exactly what they returned when Rust called
    /// Ollama directly. Mirrors `ollama::map_sidecar_error` (the Phase-1 gateway's).
    pub fn sentinel(&self, model: Option<&str>) -> String {
        match self.code.as_str() {
            "OLLAMA_DOWN" => "OLLAMA_DOWN".to_string(),
            // The AI HELPER failed to start — a different thing from Ollama
            // being closed, and the reason a cloud-model room (where Ollama may
            // not even be installed) was shown "the local AI isn't running" and
            // an Open Ollama button that could not help. Deliberately NOT the
            // `OLLAMA_DOWN` token: that token IS the frontend's trigger for that
            // button (`composer.isOllamaDown`), so the only way to stop offering
            // it is to stop saying it.
            SIDECAR_DOWN => format!(
                "Arcelle's AI helper could not start, so nothing could run: {}",
                self.error
            ),
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
/// The phrases that actually mean "the provider refused this because of your
/// allowance". A bare "quota" used to be one of them, which threw the real
/// message away whenever the word appeared for any other reason — a disk quota,
/// a file named `quota.xlsx`, a connector's own wording — and sent the user
/// chasing a billing problem that did not exist.
const EMPTY_GENERATION_HINTS: &[&str] = &[
    "usage limit",
    "reached your",
    "no generation chunks",
    "quota exceeded",
    "quota exhausted",
    "out of quota",
    "insufficient_quota",
    "insufficient quota",
];

pub(crate) fn humanize_empty_generation(msg: &str) -> Option<String> {
    let e = msg.to_lowercase();
    if EMPTY_GENERATION_HINTS.iter().any(|hint| e.contains(hint)) {
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

/// The per-request budget for a single gateway POST.
///
/// This said "every endpoint here is ONE model generation, and 600s is generous
/// for one". That reasoning holds for Ollama and is FALSE for a cloud coding
/// CLI: engine parity means any of these endpoints can be answered by
/// `claude-cli`/`codex-cli`, where one "generation" is a whole agentic session
/// that reads files and drives its own tool loop. 600s cut those off mid-work
/// and the caller replayed the whole step.
///
/// Raised rather than removed, and it is no longer the primary guard. The
/// sidecar now bounds its own work by LIVENESS (`external_llm.EXTERNAL_IDLE_SECS`
/// kills a CLI that goes silent, never one that is merely slow) and cancels
/// in-flight work when this client disconnects, so a wedge is caught there,
/// close to the evidence. What is left here is an outer backstop against a
/// sidecar that stops answering altogether — sized far above any real run, so
/// tripping it means something is broken, not that the work was ambitious.
/// The user's own escape hatch is Stop, which reaches the CLI subprocess.
/// Shared with the Phase-1 gateway (`ollama::client_timeout`), which carries
/// `/generate`, `/embed` and the structured-output calls for the SAME engines —
/// one budget, so the two paths cannot drift apart again.
pub const SIDECAR_TIMEOUT: Duration = Duration::from_secs(3600);

/// A CHAIN endpoint's budget. `/wf_node` runs up to seven generations (refine)
/// or ten (plan_and_map) behind a single POST, so it cannot share the
/// one-generation budget: a local 4B at 15 tok/s would trip mid-chain and the
/// whole step would replay. Sized as the one-call budget times the longest
/// chain, rather than removed — an unbounded request would hang the lane
/// forever if the sidecar stopped answering.
pub const SIDECAR_CHAIN_TIMEOUT: Duration = Duration::from_secs(3600 * 10);

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
        crate::commands::ensure_provider_catalog(&model).await;
        request_body = crate::commands::inject_provider_runtime(&request_body, &model).map_err(|e| {
            SidecarError { code: "ENGINE_ERROR".into(), error: e, status: 400 }
        })?;
    }
    let body = &request_body;
    // A dead sidecar is its OWN failure, not Ollama's (see `SIDECAR_DOWN`).
    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => {
            return Err(SidecarError {
                code: SIDECAR_DOWN.to_string(),
                error: e,
                status: 503,
            })
        }
    };
    // Held for the whole POST so a health probe on another task cannot replace
    // the sidecar that is answering this one.
    let _busy = sidecar_lifecycle::busy();
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| SidecarError {
            code: "ENGINE_ERROR".to_string(),
            error: e.to_string(),
            status: 0,
        })?;
    let resp = sidecar_lifecycle::authed(client.post(format!("{base}{path}")))
        .json(body)
        .send()
        .await
        .map_err(|e| SidecarError {
            // A CONNECT failure to a sidecar that just answered its health check
            // is an engine-availability failure — classify as OLLAMA_DOWN so the
            // caller's existing branch fires. A TIMEOUT is not: the request was
            // accepted and the model just ran long, so it must keep its own
            // message instead of putting an "Open Ollama" button in front of a
            // user whose engine is running (or who has no Ollama at all).
            code: if e.is_connect() {
                "OLLAMA_DOWN".to_string()
            } else {
                "ENGINE_ERROR".to_string()
            },
            error: if e.is_timeout() {
                format!(
                    "The AI engine did not answer within {}s. Try a shorter request, \
                     or a faster model in Settings → Model.",
                    timeout.as_secs()
                )
            } else {
                e.to_string()
            },
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
/// How long a streaming answer may deliver NOTHING before the app gives up on
/// it. Not a budget on the answer — a stream that keeps producing tokens is
/// never cut off, however long it runs (see [`SIDECAR_TIMEOUT`], which this
/// deliberately does not duplicate). This is the wedged-engine backstop: before
/// it existed, a stream that simply stopped arriving left quitting the app as
/// the only way out.
///
/// Deliberately the LOOSEST of the stall budgets, because it is the one with the
/// least information. The caller's watchdog knows which engine it asked
/// (`chat_commands::stream_idle_secs`, 300 s streaming / 960 s for an engine
/// that cannot stream) and the sidecar knows what its CLI subprocess is doing
/// (`external_llm.EXTERNAL_IDLE_SECS`, 900 s) — both must be able to report a
/// stall in their own words before this fires, or a wedged cloud CLI would be
/// reported here as a generic silence with the specific advice lost.
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(1_200);

/// What waiting for the next stream chunk produced.
enum StreamStep<T> {
    Chunk(T),
    /// The user pressed Stop while we were waiting.
    Stopped,
    /// Nothing arrived for [`STREAM_IDLE_TIMEOUT`].
    Idle,
    /// The stream closed.
    Ended,
}

/// Wait for the next chunk while staying answerable to Stop and to an engine
/// that has gone silent. Polling (rather than `select!` on the flag) because an
/// `AtomicBool` has nothing to await on; 100 ms is the same cadence
/// [`sidecar_json_cancellable`] already uses.
async fn next_stream_chunk<S, T>(
    stream: &mut S,
    cancel: Option<&Arc<AtomicBool>>,
    idle: Duration,
) -> StreamStep<T>
where
    S: futures_util::Stream<Item = T> + Unpin,
{
    use futures_util::StreamExt;
    const TICK: Duration = Duration::from_millis(100);
    let deadline = tokio::time::Instant::now() + idle;
    loop {
        if cancel.is_some_and(|f| f.load(Ordering::SeqCst)) {
            return StreamStep::Stopped;
        }
        tokio::select! {
            next = stream.next() => return match next {
                Some(chunk) => StreamStep::Chunk(chunk),
                None => StreamStep::Ended,
            },
            _ = tokio::time::sleep(TICK) => {
                if tokio::time::Instant::now() >= deadline {
                    // Re-read the flag first: a Stop that landed during the last
                    // tick is the user's answer, not a wedge.
                    return if cancel.is_some_and(|f| f.load(Ordering::SeqCst)) {
                        StreamStep::Stopped
                    } else {
                        StreamStep::Idle
                    };
                }
            }
        }
    }
}

pub async fn generate_stream(
    path: &str,
    body: &serde_json::Value,
    cancel: Option<Arc<AtomicBool>>,
    mut on_delta: impl FnMut(&str),
) -> Result<String, String> {
    // PRIV-1: same single injection as `sidecar_json` — the streaming twin.
    let mut request_body = crate::commands::inject_policy(body).unwrap_or_else(|| body.clone());
    if let Some(model) = request_body
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::to_string)
    {
        crate::commands::ensure_provider_catalog(&model).await;
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

    // A dead sidecar is its OWN failure, not Ollama's (see `SIDECAR_DOWN`).
    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => return Err(sentinel(SIDECAR_DOWN, &e)),
    };
    // Held for the stream's whole duration: a missed health probe on another task
    // must not SIGTERM the sidecar that is streaming this answer.
    let _busy = sidecar_lifecycle::busy();
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
    // No request timeout: a stream delivers tokens incrementally, so the shared
    // whole-request cap would abort a long answer mid-way.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| sentinel("ENGINE_ERROR", &e.to_string()))?;
    let resp = sidecar_lifecycle::authed(client.post(format!("{base}{path}")))
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
    loop {
        // ADD-7: user pressed Stop — abandon the stream, keep the partial
        // (dropping `resp` closes the connection, stopping Ollama).
        //
        // The Stop flag used to be read only after a chunk ARRIVED, so a model
        // that had gone quiet — the exact moment anyone reaches for Stop —
        // ignored it until the next token, and a model that never spoke again
        // ignored it forever. There was no time limit on this loop either, so a
        // wedged engine left quitting the app as the only way out. Waiting for
        // the next chunk is now a race against both.
        let chunk = match next_stream_chunk(&mut stream, cancel.as_ref(), STREAM_IDLE_TIMEOUT).await
        {
            StreamStep::Chunk(c) => c,
            StreamStep::Stopped | StreamStep::Ended => break,
            StreamStep::Idle => {
                return Err(sentinel(
                    "ENGINE_ERROR",
                    &format!(
                        "The AI engine stopped sending anything for {}s. \
                         Whatever it had written is kept.",
                        STREAM_IDLE_TIMEOUT.as_secs()
                    ),
                ))
            }
        };
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
/// so on Stop we DROP the in-flight request and return `Ok(None)` — the caller
/// treats `None` as a stopped step. A completed body is `Ok(Some(value))`.
///
/// What the drop actually buys, in two eras. It never stopped the work by
/// itself: measured against the pinned uvicorn/starlette (see
/// [`sidecar_json_cancellable_run`]) a non-streaming handler ran on for seconds
/// past a hard disconnect, so the generation this step started kept going and
/// kept holding the single local-model slot. The sidecar now watches for the
/// hangup on exactly these endpoints (`server.until_hangup`, on `/generate_doc`
/// and both file-pass windows) and cancels the task, which closes its own
/// connection to the engine — so on those, dropping the request does end the
/// generation. A chain endpoint still cannot be stopped this way, because one
/// POST covers many generations; that is what the `_run` variant below is for.
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
                        let _busy = sidecar_lifecycle::busy();
                        let _ = deliver_cancel(&base, run_id).await;
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

/// Which bridge tier the sidecar gets while driving `model`.
///
/// ENGINE PARITY: the agent hub runs on a cloud engine too — its rounds go
/// through the same `ChatModel` seam — and the tools the sidecar may serve are
/// decided HERE, by the ENGINE, not by who is asking. A non-local engine gets
/// [`ToolScope::CloudEngine`]: everything the local engine gets EXCEPT the
/// UI/screen-driving tools. "Any model drives the screen" stays forbidden;
/// everything else is parity (owner decision 2026-07-25).
///
/// The test is "does this engine run ON THIS MAC", not "is it one of the two
/// CLIs". It used to be `is_cli_engine`, written when claude-cli and codex-cli
/// were the only non-local engines. OpenRouter (0.12.0) and Ollama `:cloud`
/// arrived afterwards and fell through to the LOCAL branch, so a room driven by
/// a cloud API model was handed `ui_snapshot`, `ui_act` and `view_screenshot` —
/// the one grant `CloudEngine` exists to withhold, and the one its own doc
/// calls the single remaining gap ("a cloud engine is still a cloud engine, and
/// the user's screen never leaves the machine"). Nothing else in the tier
/// changes, so this costs such a room only the screen.
///
/// The tier is now a FIELD of the engine's declared capability record
/// (`commands::capabilities`), not a test performed here. Same answer — that
/// record's Ollama split is `runs_on_this_mac` for the reason written on that
/// function (Ollama also tags hosted models `<size>-cloud`, e.g.
/// `gpt-oss:120b-cloud`, which an exact `:cloud` suffix check misses) — but
/// stated once, where the published provider × agent matrix reads it too, so
/// the bridge and the matrix cannot disagree about which tools an engine gets.
pub(crate) fn bridge_scope_for(model: &str) -> ToolScope {
    crate::commands::declared_for(model).tier
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

impl SidecarOutcome {
    /// This outcome's name for the host log, and the two things the log may
    /// carry about it: how much text it produced and the KIND of its error.
    ///
    /// A `&'static str` off the variant rather than a caller-supplied string,
    /// so "done" can never be recorded for a run that failed — the same rule
    /// the rest of the app follows about claiming success.
    fn log_parts(&self) -> (&'static str, usize, Option<&str>) {
        match self {
            SidecarOutcome::Done(t) => ("done", t.len(), None),
            SidecarOutcome::Unavailable(e) => ("unavailable", 0, Some(e.as_str())),
            SidecarOutcome::EngineError(e) => ("engine_error", 0, Some(e.as_str())),
            SidecarOutcome::Failed { text, error } => ("failed", text.len(), Some(error.as_str())),
        }
    }
}

/// Which kind of engine this model routes to, as a `&'static str` for the host
/// log. Derived from the SAME two predicates `run_via_sidecar` uses to decide
/// whether to wake the local Ollama daemon, so the log cannot disagree with the
/// routing it is describing.
pub(crate) fn engine_label(model: &str) -> &'static str {
    if crate::commands::is_cli_engine(model) {
        "cli"
    } else if crate::commands::is_api_provider_model(model) {
        "api"
    } else {
        "ollama"
    }
}

/// Record how a run landed and return it unchanged.
///
/// Every exit from [`run_via_sidecar`] goes through here so no path can end
/// silently — an engine that failed before the bridge even started is exactly
/// the case that used to leave nothing behind at all.
fn finished(
    outcome: SidecarOutcome,
    turn: Option<&crate::turn::TurnId>,
    started: std::time::Instant,
) -> SidecarOutcome {
    let (label, text_bytes, error) = outcome.log_parts();
    crate::obs::run_end(turn, label, started.elapsed(), text_bytes, error);
    outcome
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
    // Owner replacement #4: the run/chat this turn belongs to. `None` for a
    // headless workflow turn, which owns no conversation and emits no events.
    turn: Option<&crate::turn::TurnId>,
) -> SidecarOutcome {
    use tauri::Manager;

    // Owner replacement #1: the host log's record of what this turn DECIDED —
    // which engine, which bridge tier, how big the request was. Sizes and counts
    // only; the question and the history are room content and never appear.
    let started = std::time::Instant::now();
    crate::obs::run_start(
        turn,
        model,
        engine_label(model),
        bridge_scope_for(model).label(),
        web_enabled,
        headless,
        advisors.len(),
        chat_messages.len(),
        question.len(),
    );

    let base = match sidecar_lifecycle::ensure_up().await {
        Ok(b) => b,
        Err(e) => return finished(SidecarOutcome::Unavailable(e), turn, started),
    };
    // Held for the whole run: this is the streaming answer a missed health probe
    // used to kill, and every tool call it makes re-enters `ensure_up`.
    let _busy = sidecar_lifecycle::busy();

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
            Err(e) => return finished(SidecarOutcome::Unavailable(e), turn, started),
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

    // The bridge tier for this room's engine. Torn down when we return.
    let scope = bridge_scope_for(model);
    let bridge = match room_mcp::start(
        window.app_handle().clone(),
        web_enabled,
        scope,
        Some(sink.clone()),
        room_mcp::StartOpts {
            privacy_bypass,
            advisor: advisor_runtime,
            // The room's per-agent web switches. Read here rather than passed
            // down with `web_enabled` because this is the bridge the AGENTS
            // run on — the only place the toggles are meant to bite.
            lanes: crate::commands::open_room_web_lanes(
                &window.app_handle().state::<crate::commands::AppState>(),
            ),
            // This turn's Stop flag: a tool call that arrives after the user
            // stopped is refused before it can write (owner decision #7).
            cancel: Some(cancel.clone()),
            // Owner replacement #4: a step chip emitted from inside a tool call
            // names the same run/chat as the deltas around it.
            turn: turn.cloned(),
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
            return finished(
                SidecarOutcome::Unavailable(format!("sidecar bridge failed: {e}")),
                turn,
                started,
            );
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
    // The catalog cache is in-memory, so after a restart a room already set to
    // an OpenRouter model knew nothing about it: tools were offered to
    // text-only models and no context window was declared. Fill it once, here,
    // before the config is built.
    crate::commands::ensure_provider_catalog(model).await;
    // ONE handle for the whole turn. The ask id the frontend minted is already
    // the `/cancel` token on the host side; making it the sidecar's `run_id`
    // too means the id on a delta, on a tool step dispatched over the bridge,
    // and on a sub-agent's report is the same string the chat registered before
    // it sent the question. A headless run has no ask, so it still mints one.
    let run_id = turn
        .map(|t| t.run_id().to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
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
        // A fresh opaque id, NOT the bridge token. The token is the bearer
        // credential that lets the sidecar reach this room's tools; the run id
        // is a public handle echoed back in `/cancel` bodies and read straight
        // off the request. They had no reason to be the same value, and reusing
        // one carried the secret into places that only need a name.
        "run_id": run_id,
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
        // A misconfigured provider (no model chosen, key gone from Keychain)
        // fails HERE — after the loopback MCP bridge is already listening. This
        // arm used to return straight out, leaking the bridge's bound port and
        // its accept task for the rest of the session, and throwing away work
        // the turn had already done (image preparation, `vision_chat`) because
        // the sink was never merged back. Same teardown as the `start` failure
        // arm above.
        //
        // `EngineError`, not `Unavailable`: nothing is wrong with the sidecar —
        // the room is pointed at a provider model with no key or no model
        // chosen. `Unavailable` is rewritten upstream into "the agent sidecar
        // could not start", which sent users to debug a Python install over a
        // disconnected API key.
        Err(e) => {
            bridge.stop();
            if let Some(nested) = consulted_room_bridge {
                nested.stop();
            }
            *effects = sink.lock().await.clone();
            return finished(SidecarOutcome::EngineError(e), turn, started);
        }
    };

    let streamed = stream_run(&base, &body, window, &cancel, headless, turn).await;
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
            finished(SidecarOutcome::Done(text), turn, started)
        }
        // Stop mid-answer is expected — keep whatever streamed (the caller adds
        // the "(stopped)" marker).
        StreamResult::Cancelled(text, usage, plan) => {
            effects.token_usage = usage;
            effects.agent_plan = plan;
            // Logged as "stopped", NOT as the `Done` it is returned as. The
            // caller treats a clean Stop as a successful partial answer, but the
            // log has to say the user pressed Stop — otherwise the one record
            // that could explain a short answer calls it a completed one.
            let bytes = text.len();
            crate::obs::run_end(turn, "stopped", started.elapsed(), bytes, None);
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
            finished(
                failure_outcome(text, error, tool_ran || bridge_tool_ran, headless),
                turn,
                started,
            )
        }
    }
}

#[derive(Debug)]
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
///
/// Generic over the Tauri runtime ONLY so this loop can be driven under
/// `tauri::test`'s mock runtime against a local NDJSON server. Every exit path
/// in here decides what the user's answer is, and until that was testable the
/// most load-bearing one — the sidecar's own terminal `error` event, which is
/// how a long run ends — could be reverted with the whole 884-test suite still
/// green. The app itself only ever instantiates this at `Wry`.
async fn stream_run<R: tauri::Runtime>(
    base: &str,
    body: &serde_json::Value,
    window: &tauri::Window<R>,
    cancel: &Arc<AtomicBool>,
    headless: bool,
    // Owner replacement #4: who this stream's events belong to. Every ask-*
    // emit below travels in this turn's envelope, so the chat that asked is the
    // only one that paints them. `None` for a headless run, which emits none.
    turn: Option<&crate::turn::TurnId>,
) -> StreamResult {
    use futures_util::StreamExt;

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
    let resp = match sidecar_lifecycle::authed(client.post(format!("{base}/run")))
        .json(body)
        .send()
        .await
    {
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
    // SPEC §4 promises exactly ONE `final` per run, and the graph floors an empty
    // answer to DONE_TEXT (graph.py) — so a stream that ends without a `final` did
    // not answer, it LOST the answer. Returning `Done("")` for that made a torn-down
    // run byte-identical to a completed one: an empty assistant row, no `stopped`
    // marker, no error, the turn reporting itself finished. Live QA 2026-07-30 (the
    // Yahoo/ETF task) hit exactly that and produced zero bytes with no diagnostics.
    let mut final_seen = false;
    // What the user has WATCHED ARRIVE this round. `final_text` is assigned from
    // the `final` event alone, and Stop returns without waiting for one — so on
    // every stopped run `final_text` was "", which `stream_answer` then rewrote
    // into "the reply was lost before it reached the app". The text was not lost;
    // it was streamed to the screen and simply never kept. Live QA reported it
    // twice as "Stop worked, but the reply was lost".
    //
    // The plain-chat and `#command` paths have always mirrored their deltas for
    // exactly this reason (`generate_stream`'s `full`, `chat_commands`' `partial`);
    // only the `/run` agent stream did not. Cleared on `round` because the UI
    // clears its own view then (effects.ts `onAskRound`), so this stays a mirror
    // of what is actually on screen rather than a transcript of every round.
    let mut streamed = String::new();
    // One place where "a headless run is silent" and "a visible run's events
    // are owned" are both true: below, an event is emitted iff `turn` is Some.
    let turn = if headless { None } else { turn };
    let emit = |event: &str, payload: serde_json::Value| {
        if let Some(turn) = turn {
            turn.emit(window, event, payload);
        }
    };
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
                        text: answer_so_far(&final_text, &streamed),
                        error: e.to_string(),
                        tool_ran,
                        usage: last_usage,
                        plan: last_plan,
                    }
                }
                None => break, // stream ended
            },
            _ = wait_for_cancel(cancel) => {
                // Checked, and retried once if the sidecar did not confirm it.
                let _ = deliver_cancel(base, &run_id).await;
                return StreamResult::Cancelled(
                    answer_so_far(&final_text, &streamed),
                    last_usage,
                    last_plan,
                );
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
                let _ = deliver_cancel(base, &run_id).await;
                return StreamResult::Cancelled(
                    answer_so_far(&final_text, &streamed),
                    last_usage,
                    last_plan,
                );
            }
            let ev: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue, // skip a malformed line rather than abort
            };
            // Owner replacement #4: the sidecar names the run on every line it
            // writes (server.py `stamped`), including the ones a delegated
            // sub-agent produces. A line naming a DIFFERENT run is not ours to
            // attribute, so it is dropped rather than painted into this chat.
            // An unstamped line is an older sidecar, not a foreign run, and is
            // read exactly as before.
            if ev
                .get("run_id")
                .and_then(|r| r.as_str())
                .is_some_and(|theirs| theirs != run_id)
            {
                continue;
            }
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
                    emit(
                        "ask-plan",
                        last_plan.clone().unwrap_or(serde_json::Value::Null),
                    );
                }
                Some("agent") => {
                    emit(
                        "ask-agent",
                        ev.get("v").cloned().unwrap_or(serde_json::Value::Null),
                    );
                }
                Some("lane") => {
                    emit("ask-lane", str_v(&ev).into());
                }
                Some("round") => {
                    // The UI drops the previous round's text here, so the mirror
                    // must too — otherwise a stopped multi-round turn hands back
                    // deliberation the user never saw, stitched to what they did.
                    streamed.clear();
                    emit("ask-round", serde_json::Value::Null);
                }
                Some("delta") => {
                    let d = str_v(&ev);
                    // Kept even when headless: a stopped background run's partial
                    // is just as much the honest answer as a visible one's.
                    streamed.push_str(d);
                    emit("ask-delta", d.into());
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
                    emit(
                        "ask-step",
                        serde_json::json!({
                            "label": str_v(&ev),
                            "node": ev.get("node").and_then(|n| n.as_str()),
                        }),
                    );
                }
                // What a specialist handed back to the Main agent, stamped with
                // its graph slot. The child's words also stream as `delta`s
                // while it holds the live-text lease and are wiped by the next
                // `round` — so without this the report flashed up and vanished,
                // and a FAILED child's reason never reached the screen at all.
                Some("report") => {
                    emit(
                        "ask-report",
                        serde_json::json!({
                            "node": ev.get("node").and_then(|n| n.as_str()),
                            "text": str_v(&ev),
                            "ok": ev.get("ok").and_then(|b| b.as_bool()).unwrap_or(true),
                        }),
                    );
                }
                Some("step_status") => {
                    emit(
                        "ask-step-status",
                        serde_json::json!({
                            "ok": ev.get("ok").and_then(|b| b.as_bool()).unwrap_or(false),
                            "node": ev.get("node").and_then(|n| n.as_str()),
                        }),
                    );
                }
                Some("final") => {
                    final_text = str_v(&ev).to_string();
                    final_seen = true;
                }
                // PRIV-1: what the door did this turn ("N details hidden") —
                // arrives after `final`, rendered on the finished message.
                Some("privacy") => {
                    emit(
                        "ask-privacy",
                        ev.get("v").cloned().unwrap_or(serde_json::Value::Null),
                    );
                }
                // Token-budget bar: one snapshot per round. Strip the NDJSON
                // discriminator before emitting/persisting — the payload shape
                // is `AskTokenUsage` (apiTypes.ts), which carries no `"t"` key.
                Some("usage") => {
                    let mut usage = ev.clone();
                    if let serde_json::Value::Object(map) = &mut usage {
                        map.remove("t");
                        // …and `run_id`, for the same reason. This is the ONE
                        // event whose whole NDJSON line becomes the payload, so
                        // owner replacement #4's per-line stamp would otherwise
                        // ride into `AskTokenUsage` — and, via
                        // `effects.token_usage`, be written into the room's
                        // message rows. The identity belongs on the envelope,
                        // not inside the reading.
                        map.remove("run_id");
                    }
                    emit("ask-token-usage", usage.clone());
                    last_usage = Some(usage);
                }
                // The sidecar's own terminal event — a torn-down run, a stalled
                // provider stream (`chat.StreamStalled`), any exception the
                // driver caught (graph.py `stream_events`). This is how a LONG
                // run ends in practice, and it read `final_text` (always "" here,
                // since no `final` arrived) instead of the mirror: the whole
                // partial answer was dropped and the turn reported "the reply
                // was lost … nothing was written".
                Some("error") => {
                    return StreamResult::Failed {
                        text: answer_so_far(&final_text, &streamed),
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
    stream_outcome(
        final_seen,
        final_text,
        &streamed,
        tool_ran,
        last_usage,
        last_plan,
    )
}

/// The honest answer text at any moment: the real `final` if one arrived,
/// otherwise the mirror of what the user has watched stream by.
///
/// A free function rather than [`stream_run`]'s local closure because the two
/// exit paths that could NOT see the closure — the in-stream `error` event and
/// the end-of-stream verdict — are exactly the two that threw the partial away.
/// Whitespace counts as empty: a `final` carrying only a newline is not an
/// answer, and preferring it over real streamed text would blank the reply.
/// Which no-fallback surface a failed stream becomes.
///
/// Two things are true at once and only one of them used to be read. If a tool
/// already ran — the in-stream `step` line OR the bridge's own dispatch flag —
/// its side-effect is committed, so this is [`SidecarOutcome::Failed`]: the
/// caller keeps the partial reply plus the merged effects, and re-running would
/// double the write. If nothing ran AND nothing streamed, the sidecar failed
/// before producing anything, so it is [`SidecarOutcome::EngineError`] and the
/// caller shows the provider error. Neither path re-runs anything.
///
/// The third case is the one that was missing. `EngineError` carries no text,
/// so a turn that STREAMED an answer and then died without ever calling a tool
/// — a long tool-free write-up whose provider stream stalls, the exact shape of
/// the owner's 2026-08-03 report — had its whole partial dropped here, one line
/// after `answer_so_far` had just recovered it, and the user was told "AI
/// provider error" about text they had watched arrive. A visible chat turn
/// keeps it.
///
/// `headless` is deliberately excluded: a background workflow step must still
/// FAIL on a stall so its job parks and stays resumable. Handing the next step
/// a truncated result as though the node had completed would be this codebase's
/// own prose fabricating a success.
fn failure_outcome(
    text: String,
    error: String,
    tool_ran: bool,
    headless: bool,
) -> SidecarOutcome {
    if tool_ran || (!headless && !text.trim().is_empty()) {
        SidecarOutcome::Failed { text, error }
    } else {
        SidecarOutcome::EngineError(error)
    }
}

fn answer_so_far(final_text: &str, streamed: &str) -> String {
    if final_text.trim().is_empty() {
        streamed.to_string()
    } else {
        final_text.to_string()
    }
}

/// The end-of-stream verdict. Split out of [`stream_run`] so it can be unit-tested
/// without a live sidecar — the whole point is the `false` arm, which used to be
/// spelled `Done("")`.
///
/// `streamed` is the delta mirror. It is load-bearing here and not a nicety:
/// `final_text` is written by the `final` event ALONE, so on the very path this
/// function exists for — the stream ending WITHOUT a `final` — it is always ""
/// and the partial the user watched arrive was discarded every time. That is
/// the "the reply was lost" the owner retested on 2026-08-03: the mirror had
/// been added to `stream_run`'s three early returns but never reached the two
/// paths a long run actually ends on (a stall, and the sidecar's own terminal
/// `error` event).
fn stream_outcome(
    final_seen: bool,
    final_text: String,
    streamed: &str,
    tool_ran: bool,
    usage: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
) -> StreamResult {
    let text = answer_so_far(&final_text, streamed);
    if final_seen {
        return StreamResult::Done(text, usage, plan);
    }
    StreamResult::Failed {
        text,
        error: "the agent sidecar ended the run without an answer".to_string(),
        tool_ran,
        usage,
        plan,
    }
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

/// Tell a RUNNING sidecar to drop everything it still holds about the room that
/// just closed (today: the compaction digest cache).
///
/// The sidecar is one long-lived process serving whichever room is open, so its
/// in-memory state does not end when a room does — boiled-down summaries of a
/// room's own conversation survived lock, room-switch and chat deletion. Room
/// teardown is synchronous and must not block, so this is fire-and-forget; and
/// it deliberately does NOT `ensure_up`, because a lock has no business starting
/// the AI service. No sidecar means nothing to forget.
pub(crate) fn forget_room_memory() {
    let Some(base) = sidecar_lifecycle::base_url_if_running() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
        else {
            return;
        };
        let sent = sidecar_lifecycle::authed(client.post(format!("{base}/forget")))
            .json(&serde_json::json!({}))
            .send()
            .await;
        // Say so rather than assume it landed: an unheard "forget" leaves the
        // digests in memory, and the whole point of this call is that nothing
        // else would ever notice.
        match sent {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => eprintln!(
                "[sidecar] /forget refused (status {}) — compacted summaries may still be held",
                resp.status().as_u16()
            ),
            Err(e) => eprintln!(
                "[sidecar] /forget did not reach the AI service ({}) — compacted summaries may \
                 still be held",
                e
            ),
        }
    });
}

/// POST one `/cancel` and READ THE ANSWER.
///
/// This used to `send()` and return `Ok(())` without looking at the status or
/// the body, so a Stop that never arrived — or one the sidecar did not
/// recognise — was indistinguishable from a Stop that landed. On a multi-step
/// run that means the UI shows "stopped" while the graph keeps spending the
/// single local-model slot for several more steps.
async fn cancel_run(base: &str, run_id: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = sidecar_lifecycle::authed(client.post(format!("{base}/cancel")))
        .json(&serde_json::json!({ "run_id": run_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.json::<serde_json::Value>().await.ok();
    cancel_verdict(status, body.as_ref())
}

/// Did the sidecar accept the Stop? Its contract is
/// `{"ok": true, "known": <bool>}`, where `known` is false for a `run_id` the
/// run registry never had — i.e. the Stop reached the service but stopped
/// nothing. A non-2xx means it never reached the registry at all.
///
/// An absent `known` is treated as accepted on purpose: a 2xx from `/cancel` is
/// the contract's success marker, and inventing a failure for a body shape we
/// merely do not recognise would make every Stop report a phantom problem.
fn cancel_verdict(status: u16, body: Option<&serde_json::Value>) -> Result<(), String> {
    if !(200..300).contains(&status) {
        return Err(format!("the AI service refused the Stop (status {status})"));
    }
    match body.and_then(|b| b.get("known")).and_then(|k| k.as_bool()) {
        Some(false) => Err("the AI service did not recognise the run".to_string()),
        _ => Ok(()),
    }
}

/// Deliver Stop and confirm it was accepted, retrying once.
///
/// One retry, not none: `known == false` is also what a Stop that RACED the
/// run's registration looks like (the host can POST `/cancel` while the sidecar
/// is still entering the handler that registers the run), and that one is
/// genuinely retryable. If the second attempt still is not confirmed the run
/// really may keep going, so say so on stderr rather than swallowing it — the
/// callers below tear their side down either way, because the user asked to
/// stop and the answer is already abandoned.
async fn deliver_cancel(base: &str, run_id: &str) -> Result<(), String> {
    // Owner replacement #1: "was the Stop DELIVERED" is the exact question the
    // host could never answer after the fact. Timed from the first attempt so
    // the retry below is inside the recorded duration.
    let started = std::time::Instant::now();
    let first = match cancel_run(base, run_id).await {
        Ok(()) => {
            crate::obs::cancel_delivered(run_id, started.elapsed(), Ok(()));
            return Ok(());
        }
        Err(e) => e,
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    match cancel_run(base, run_id).await {
        Ok(()) => {
            crate::obs::cancel_delivered(run_id, started.elapsed(), Ok(()));
            Ok(())
        }
        Err(second) => {
            crate::obs::cancel_delivered(run_id, started.elapsed(), Err(&second));
            eprintln!(
                "[arcelle] Stop was not accepted for run {run_id} ({first}; then {second}) \
                 — the AI service may still be finishing this step."
            );
            Err(second)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_that_never_sent_final_is_a_lost_answer_not_an_empty_one() {
        // SPEC §4: exactly one `final` per run, and the graph floors an empty answer to
        // "Done." before it reaches the wire. So a stream with no `final` LOST the
        // answer. Reporting that as Done("") is how the Yahoo/ETF turn (live QA
        // 2026-07-30) saved a zero-byte assistant message with no error at all.
        match stream_outcome(false, String::new(), "", true, None, None) {
            StreamResult::Failed { error, tool_ran, .. } => {
                assert!(error.contains("without an answer"), "{error:?}");
                assert!(tool_ran, "tool_ran must survive so the partial is kept");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        // A real `final` — including the floored "Done." — still passes through.
        match stream_outcome(true, "Done.".into(), "", true, None, None) {
            StreamResult::Done(t, ..) => assert_eq!(t, "Done."),
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn a_torn_down_run_keeps_the_text_the_user_watched_arrive() {
        // The owner's 2026-08-03 retest: a long run ends with no `final`, and
        // `final_text` is written by the `final` event ALONE — so it is "" on
        // exactly this path. The old signature took only `final_text`, so the
        // whole streamed partial was thrown away and the turn was persisted as
        // "the reply was lost … nothing was written". The mirror is the only
        // record of what was on screen; it must be the answer here.
        match stream_outcome(false, String::new(), "half an answer", false, None, None) {
            StreamResult::Failed { text, .. } => assert_eq!(text, "half an answer"),
            other => panic!("expected Failed, got {other:?}"),
        }
        // A `final` that arrived carrying nothing is not an answer either — the
        // mirror still wins, rather than blanking a reply the user can see.
        match stream_outcome(true, "  \n".into(), "half an answer", false, None, None) {
            StreamResult::Done(t, ..) => assert_eq!(t, "half an answer"),
            other => panic!("expected Done, got {other:?}"),
        }
        // Nothing streamed and nothing finalized stays genuinely empty — the
        // caller's "no answer" notice must not be manufactured out of a mirror
        // that is itself blank.
        match stream_outcome(false, String::new(), "", false, None, None) {
            StreamResult::Failed { text, .. } => assert_eq!(text, ""),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// A one-shot NDJSON `/run` server. Answers exactly one request with the
    /// given event lines and then closes, which is how the real sidecar's
    /// stream ends. Returns the base URL.
    async fn fake_run_stream(lines: Vec<serde_json::Value>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Drain the WHOLE request — headers, then exactly `Content-Length`
            // body bytes — before answering. Reading one chunk and replying is
            // a flake: under a loaded test binary the body can land in a later
            // segment, and closing while the client is still writing it turns
            // into "sidecar /run failed" instead of the stream under test.
            let mut req = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                let n = match sock.read(&mut scratch).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                req.extend_from_slice(&scratch[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                let Some(head_end) = text.find("\r\n\r\n") else { continue };
                let want: usize = text[..head_end]
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse().ok())?
                    })
                    .unwrap_or(0);
                if req.len() >= head_end + 4 + want {
                    break;
                }
            }
            let body: String =
                lines.iter().map(|l| format!("{l}\n")).collect();
            let _ = sock
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = sock.flush().await;
        });
        format!("http://127.0.0.1:{port}")
    }

    /// THE exit path of a long run, driven end to end.
    ///
    /// `graph.py`'s `stream_events` catches every exception from the driver —
    /// `chat.StreamStalled`, a torn-down run — and emits `{"t":"error"}`. That
    /// arm inside `stream_run` returned `final_text`, which is written by the
    /// `final` event ALONE and is therefore ALWAYS "" here, so the partial the
    /// user had watched arrive was discarded and the turn was persisted as "the
    /// reply was lost … nothing was written".
    ///
    /// Verified untested before this: reverting that one line to `final_text`
    /// left all 884 lib tests green, because the only coverage was of
    /// `stream_outcome`, a DIFFERENT exit path.
    #[tokio::test]
    async fn the_error_event_keeps_the_partial_the_user_watched_arrive() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::window::WindowBuilder::new(&app, "run-finalization")
            .build()
            .unwrap();
        let base = fake_run_stream(vec![
            serde_json::json!({"t": "delta", "v": "half an "}),
            serde_json::json!({"t": "delta", "v": "answer"}),
            serde_json::json!({"t": "error", "v": "the run was torn down"}),
        ])
        .await;
        let body = serde_json::json!({ "run_id": "r1" });
        let cancel = Arc::new(AtomicBool::new(false));
        // `headless: true` — the mirror is kept for a background run too, and a
        // stopped background turn's partial is just as much the honest answer.
        match stream_run(&base, &body, &window, &cancel, true, None).await {
            StreamResult::Failed { text, error, .. } => {
                assert_eq!(text, "half an answer");
                assert!(error.contains("torn down"), "{error:?}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// The mirror is per-ROUND, matching what is on screen: the UI clears its
    /// live text on `round`, so a stopped multi-round turn must not hand back
    /// deliberation from a round the user no longer sees.
    #[tokio::test]
    async fn a_new_round_resets_the_mirror_the_way_the_screen_does() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::window::WindowBuilder::new(&app, "run-finalization-2")
            .build()
            .unwrap();
        let base = fake_run_stream(vec![
            serde_json::json!({"t": "delta", "v": "first round thinking"}),
            serde_json::json!({"t": "round"}),
            serde_json::json!({"t": "delta", "v": "the visible answer"}),
            serde_json::json!({"t": "error", "v": "stalled"}),
        ])
        .await;
        let body = serde_json::json!({ "run_id": "r2" });
        let cancel = Arc::new(AtomicBool::new(false));
        match stream_run(&base, &body, &window, &cancel, true, None).await {
            StreamResult::Failed { text, .. } => assert_eq!(text, "the visible answer"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// Owner replacement #4: every event this loop emits names the run that
    /// produced it and the chat that owns it — including the ones a delegated
    /// sub-agent produced (`node: "web#0"`), which travel on this same stream.
    ///
    /// Verified failing before the change: the emits were bare
    /// `window.emit("ask-delta", d)` broadcasts with no ids at all, so the only
    /// thing the frontend could do was paint them into whatever chat was
    /// mounted — which is exactly the "orphaned run" symptom.
    #[tokio::test]
    async fn every_event_names_the_run_and_the_chat_it_belongs_to() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::window::WindowBuilder::new(&app, "turn-identity")
            .build()
            .unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<(String, serde_json::Value)>::new()));
        for event in ["ask-delta", "ask-step", "ask-token-usage", "ask-round"] {
            let seen = seen.clone();
            window.listen(event, move |e| {
                let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
                seen.lock().unwrap().push((event.to_string(), v));
            });
        }
        let base = fake_run_stream(vec![
            serde_json::json!({"t": "delta", "v": "looking it up", "run_id": "ask-77"}),
            // A tool step from a delegated child, mid-turn.
            serde_json::json!({"t": "step", "v": "Searching the web", "node": "web#0",
                               "run_id": "ask-77"}),
            serde_json::json!({"t": "round", "run_id": "ask-77"}),
            serde_json::json!({"t": "usage", "total_tokens": 42, "max_context": 8192,
                               "estimated": false, "run_id": "ask-77"}),
            serde_json::json!({"t": "final", "v": "the answer", "run_id": "ask-77"}),
        ])
        .await;
        let body = serde_json::json!({ "run_id": "ask-77" });
        let cancel = Arc::new(AtomicBool::new(false));
        let turn = crate::turn::TurnId::new("ask-77", "chat-a");
        let out = stream_run(&base, &body, &window, &cancel, false, Some(&turn)).await;
        assert!(matches!(out, StreamResult::Done(ref t, ..) if t == "the answer"));
        // The listener callbacks run on the emit, which has already happened.
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 4, "one event each: {seen:?}");
        for (name, payload) in &seen {
            assert_eq!(payload["runId"], "ask-77", "{name} lost its run");
            assert_eq!(payload["chatId"], "chat-a", "{name} lost its chat");
        }
        // …and the payload the listener used to receive is unchanged inside `v`.
        let by = |n: &str| {
            seen.iter()
                .find(|(name, _)| name == n)
                .map(|(_, p)| p.clone())
                .unwrap()
        };
        assert_eq!(by("ask-delta")["v"], "looking it up");
        assert_eq!(by("ask-step")["v"]["label"], "Searching the web");
        assert_eq!(by("ask-step")["v"]["node"], "web#0");
        assert_eq!(by("ask-token-usage")["v"]["total_tokens"], 42);
        // The usage line is the one event whose WHOLE NDJSON object becomes the
        // payload, so the per-line run stamp has to be stripped with `t`. It is
        // not display-only either: this same value is kept as
        // `effects.token_usage` and written into the room's message row, so a
        // leaked id would be persisted into the user's file.
        assert_eq!(
            by("ask-token-usage")["v"]["run_id"],
            serde_json::Value::Null,
            "the run stamp belongs on the envelope, not inside the reading",
        );
    }

    /// A line stamped with a DIFFERENT run is not ours to attribute. The
    /// sidecar names the run on every line it writes (server.py `stamped`), so
    /// a foreign one can only be a stray — and painting a stray into this chat
    /// is the whole class of bug this identity exists to close.
    #[tokio::test]
    async fn a_line_from_another_run_is_dropped_not_painted() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::window::WindowBuilder::new(&app, "turn-identity-2")
            .build()
            .unwrap();
        let deltas = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = deltas.clone();
        window.listen("ask-delta", move |e| {
            let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            sink.lock().unwrap().push(v["v"].as_str().unwrap().to_string());
        });
        let base = fake_run_stream(vec![
            serde_json::json!({"t": "delta", "v": "mine", "run_id": "ask-77"}),
            serde_json::json!({"t": "delta", "v": "SOMEONE ELSE'S", "run_id": "ask-99"}),
            // An UNSTAMPED line is an older sidecar, not a foreign run: read it.
            serde_json::json!({"t": "delta", "v": " and mine"}),
            serde_json::json!({"t": "final", "v": "mine and mine", "run_id": "ask-77"}),
        ])
        .await;
        let body = serde_json::json!({ "run_id": "ask-77" });
        let cancel = Arc::new(AtomicBool::new(false));
        let turn = crate::turn::TurnId::new("ask-77", "chat-a");
        let _ = stream_run(&base, &body, &window, &cancel, false, Some(&turn)).await;
        assert_eq!(*deltas.lock().unwrap(), vec!["mine", " and mine"]);
    }

    /// A stream that simply ENDS with no `final` and no `error` — the other
    /// half of the same defect, and the one `stream_outcome`'s unit test could
    /// only assert on a `final_text` production never produces on that path.
    #[tokio::test]
    async fn a_stream_that_just_stops_still_hands_back_what_streamed() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::window::WindowBuilder::new(&app, "run-finalization-3")
            .build()
            .unwrap();
        let base = fake_run_stream(vec![
            serde_json::json!({"t": "delta", "v": "as far as it got"}),
        ])
        .await;
        let body = serde_json::json!({ "run_id": "r3" });
        let cancel = Arc::new(AtomicBool::new(false));
        match stream_run(&base, &body, &window, &cancel, true, None).await {
            StreamResult::Failed { text, error, .. } => {
                assert_eq!(text, "as far as it got");
                assert!(error.contains("without an answer"), "{error:?}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn a_partial_survives_a_stall_even_when_no_tool_ever_ran() {
        // `answer_so_far` recovers the partial into `StreamResult::Failed`, and
        // this is where it was thrown away again: with no tool run the arm
        // returned `EngineError`, which carries no text at all. A long tool-free
        // turn (write me the report) whose stream stalls therefore still showed
        // "AI provider error" with the streamed answer discarded.
        match failure_outcome("half an answer".into(), "stalled".into(), false, false) {
            SidecarOutcome::Failed { text, error } => {
                assert_eq!(text, "half an answer");
                assert_eq!(error, "stalled");
            }
            _ => panic!("a visible turn must keep the text the user watched arrive"),
        }
        // Nothing streamed and nothing ran: still the provider error, so the
        // caller reports the real reason instead of an empty "answer".
        match failure_outcome(String::new(), "no key".into(), false, false) {
            SidecarOutcome::EngineError(e) => assert_eq!(e, "no key"),
            _ => panic!("expected EngineError"),
        }
        match failure_outcome("  \n".into(), "no key".into(), false, false) {
            SidecarOutcome::EngineError(e) => assert_eq!(e, "no key"),
            _ => panic!("whitespace is not an answer"),
        }
        // A committed tool keeps the partial on both surfaces, as before.
        match failure_outcome(String::new(), "boom".into(), true, true) {
            SidecarOutcome::Failed { .. } => {}
            _ => panic!("a committed side-effect must never be re-run"),
        }
        // HEADLESS: a workflow step must still FAIL on a stall so its job parks
        // and stays resumable — never hand the next node a truncated result.
        match failure_outcome("half an answer".into(), "stalled".into(), false, true) {
            SidecarOutcome::EngineError(e) => assert_eq!(e, "stalled"),
            _ => panic!("a background step must not report a partial as its output"),
        }
    }

    #[test]
    fn the_real_final_still_beats_the_mirror() {
        // `answer_so_far` is now the single rule behind all five exit paths, so
        // pin it directly: a real `final` is the authority (the mirror is only
        // the newest ROUND's deltas and can lag it), and only a blank one
        // defers to what the user saw.
        assert_eq!(answer_so_far("the whole answer", "partial"), "the whole answer");
        assert_eq!(answer_so_far("", "partial"), "partial");
        assert_eq!(answer_so_far("\t \n", "partial"), "partial");
        assert_eq!(answer_so_far("", ""), "");
    }

    #[test]
    fn a_stop_the_sidecar_did_not_recognise_is_not_an_accepted_stop() {
        // `/cancel` answers `{"ok": true, "known": <bool>}` and `known` is false
        // for a run the registry never had — the Stop landed on the service and
        // stopped nothing. Reading only the transport (the old behaviour) made
        // that identical to a Stop that worked, so a multi-step run kept
        // spending the local-model slot behind a UI that said "stopped".
        let accepted = serde_json::json!({ "ok": true, "known": true });
        assert!(cancel_verdict(200, Some(&accepted)).is_ok());

        let unknown = serde_json::json!({ "ok": true, "known": false });
        let err = cancel_verdict(200, Some(&unknown)).unwrap_err();
        assert!(err.contains("did not recognise"), "{err:?}");

        // A refusal by the service itself is a failed delivery too, whatever the
        // body says.
        let err = cancel_verdict(503, Some(&accepted)).unwrap_err();
        assert!(err.contains("503"), "{err:?}");
        assert!(cancel_verdict(500, None).is_err());
    }

    /// A fake `/cancel` endpoint that answers `body` to every request it gets,
    /// `attempts` times. Enough for [`deliver_cancel`]'s one retry.
    async fn fake_cancel(status: &'static str, body: &'static str, attempts: usize) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for _ in 0..attempts {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut scratch = [0u8; 4096];
                let _ = sock.read(&mut scratch).await;
                let _ = sock
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                let _ = sock.flush().await;
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    /// Owner replacement #1: whether a Stop was DELIVERED is the question the
    /// host could never answer afterwards. `deliver_cancel` already knew — it
    /// just told nobody but stderr, and only in the failing case.
    #[tokio::test]
    async fn whether_a_stop_landed_is_recorded_either_way() {
        let good = fake_cancel("200 OK", r#"{"ok":true,"known":true}"#, 1).await;
        let (res, log) = crate::obs::capture_async(deliver_cancel(&good, "ask-77")).await;
        assert!(res.is_ok(), "{res:?}");
        assert!(log.contains("cancel.delivered run=ask-77"), "{log}");
        assert!(!log.contains("cancel.refused"), "{log}");

        // A Stop the sidecar does not recognise stopped nothing. Both attempts
        // answer `known:false`, so delivery genuinely fails.
        let bad = fake_cancel("200 OK", r#"{"ok":true,"known":false}"#, 2).await;
        let (res, log) = crate::obs::capture_async(deliver_cancel(&bad, "ask-88")).await;
        assert!(res.is_err(), "an unrecognised run must not report a delivered Stop");
        assert!(log.contains("cancel.refused run=ask-88"), "{log}");
        assert!(log.contains("WARN"), "a Stop that stopped nothing must not read as routine: {log}");
    }

    #[test]
    fn a_runs_engine_and_landing_are_named_by_the_code_not_by_a_caller() {
        // Both labels are `&'static str` picked off the same predicates the
        // routing itself uses, which is what makes the log unable to disagree
        // with the run it describes — and unable to print "done" for a failure.
        assert_eq!(engine_label("qwen3.5:4b"), "ollama");
        assert_eq!(engine_label("gpt-oss:120b-cloud"), "ollama");
        assert_eq!(engine_label("claude-cli"), "cli");
        assert_eq!(engine_label("codex-cli::gpt-5::high"), "cli");

        assert_eq!(SidecarOutcome::Done("hello".into()).log_parts().0, "done");
        assert_eq!(SidecarOutcome::Done("hello".into()).log_parts().1, 5);
        assert_eq!(SidecarOutcome::Unavailable("x".into()).log_parts().0, "unavailable");
        assert_eq!(SidecarOutcome::EngineError("x".into()).log_parts().0, "engine_error");
        let failed = SidecarOutcome::Failed { text: "half".into(), error: "boom".into() };
        assert_eq!(failed.log_parts().0, "failed");
        assert_eq!(failed.log_parts().1, 4, "a failed run still produced text");
        assert_eq!(failed.log_parts().2, Some("boom"));
    }

    #[test]
    fn the_funnel_every_run_returns_through_actually_records_it() {
        // The test above pins the LABELS; this one pins the WIRING. Five of the
        // six exits from `run_via_sidecar` return through `finished`, so if that
        // stops emitting, the host log silently loses every run ending — and the
        // label test would keep passing, which is exactly the shape of hole this
        // packet exists to close.
        let turn = crate::turn::TurnId::new("ask-9", "chat-9");
        let started = std::time::Instant::now();
        let (out, log) = crate::obs::capture(|| {
            finished(
                SidecarOutcome::EngineError("no api key for this provider".into()),
                Some(&turn),
                started,
            )
        });
        assert!(
            matches!(out, SidecarOutcome::EngineError(_)),
            "the outcome must pass through the funnel unchanged"
        );
        assert!(log.contains("sidecar.run.end run=ask-9 chat=chat-9"), "{log}");
        assert!(log.contains("outcome=engine_error"), "{log}");
        assert!(log.contains("err=no_credential"), "{log}");
        // The provider's own wording is not ours to publish, even when it is
        // only an error: `errBytes` is the size, and that is all.
        assert!(!log.contains("api key"), "the message itself travelled: {log}");
        assert!(log.contains("errBytes=28"), "{log}");

        // A run that failed AFTER streaming text still reports the text it made.
        let (_, log) = crate::obs::capture(|| {
            finished(
                SidecarOutcome::Failed { text: "half".into(), error: "boom".into() },
                None,
                std::time::Instant::now(),
            )
        });
        assert!(log.contains("run=- chat=-"), "{log}");
        assert!(log.contains("outcome=failed"), "{log}");
        assert!(log.contains("textBytes=4"), "{log}");
    }

    #[test]
    fn a_cancel_reply_without_the_known_field_is_taken_as_accepted() {
        // Forward-compat: 2xx is the contract's success marker. A body we do not
        // recognise must not manufacture a phantom "Stop failed" on every Stop.
        assert!(cancel_verdict(200, None).is_ok());
        assert!(cancel_verdict(204, Some(&serde_json::json!({ "ok": true }))).is_ok());
        assert!(cancel_verdict(200, Some(&serde_json::json!("done"))).is_ok());
    }

    /// A broken Python helper must not be reported as "the local AI isn't
    /// running" with an Open Ollama button — in a cloud-model room Ollama may
    /// not even be installed, and pressing it can only waste the user's time.
    /// `composer.isOllamaDown` triggers on the literal `OLLAMA_DOWN` token, so
    /// the test is that the token does NOT appear.
    #[test]
    fn a_dead_sidecar_does_not_blame_ollama() {
        let dead = SidecarError {
            code: SIDECAR_DOWN.into(),
            error: "sidecar exited before it answered".into(),
            status: 503,
        };
        let msg = dead.sentinel(Some("claude-cli::sonnet"));
        assert!(!msg.contains("OLLAMA_DOWN"), "must not offer Open Ollama: {msg}");
        assert!(msg.contains("AI helper"), "must name what actually failed: {msg}");
        assert!(
            msg.contains("sidecar exited before it answered"),
            "must keep the real reason: {msg}"
        );
        // A genuinely closed Ollama still reads exactly as it always has.
        let ollama = SidecarError {
            code: "OLLAMA_DOWN".into(),
            error: "connection refused".into(),
            status: 503,
        };
        assert_eq!(ollama.sentinel(None), "OLLAMA_DOWN");
    }

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
    fn only_a_real_allowance_message_is_rewritten_as_a_usage_limit() {
        // The hint list is deliberately narrow: a bare "quota" used to match, so
        // a disk-quota error or a file called quota.xlsx sent the user chasing a
        // billing problem that did not exist. Both directions are pinned because
        // this funnel REPLACES the engine's own message.
        for real in [
            "You have reached your usage limit",
            "No generation chunks were returned",
            "insufficient_quota",
            "QUOTA EXCEEDED",
        ] {
            let out = humanize_empty_generation(real).unwrap_or_default();
            assert!(out.contains("usage limit"), "{real:?} → {out:?}");
        }
        for unrelated in [
            "could not write report.xlsx: disk quota reached",
            "the connector returned 500",
            "",
        ] {
            assert_eq!(humanize_empty_generation(unrelated), None, "{unrelated:?}");
        }
        // And the rewrite only applies to unclassified engine errors — the two
        // sentinels callers branch on must survive it verbatim.
        let down = SidecarError {
            code: "OLLAMA_DOWN".into(),
            error: "quota exceeded".into(),
            status: 503,
        };
        assert_eq!(down.sentinel(None), "OLLAMA_DOWN");
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

    /// EVERY non-local engine is a cloud engine for tool-tier purposes.
    ///
    /// The predicate used to be `is_cli_engine`, so only claude-cli and
    /// codex-cli were treated as remote. OpenRouter and Ollama's hosted models
    /// arrived later and silently landed in the LOCAL tier, which is the only
    /// tier that serves `ui_snapshot` / `ui_act` / `view_screenshot`. A cloud
    /// API model was therefore able to enumerate and operate the app's own
    /// controls — exactly what `ToolScope::CloudEngine` exists to prevent.
    #[test]
    fn only_an_engine_running_on_this_mac_gets_the_screen_tools() {
        use crate::room_mcp::ToolScope;
        for local in ["qwen3.5:4b", "llama3.2", "gemma3:12b", "qwen2.5vl:7b"] {
            assert_eq!(bridge_scope_for(local), ToolScope::LocalEngine, "{local}");
        }
        for remote in [
            "openrouter::openai/gpt-4o",
            "openrouter::google/gemini-pro",
            "claude-cli::opus",
            "codex-cli::gpt-5",
            "gpt-oss:120b-cloud",
            "qwen3-vl:235b-cloud",
            "deepseek-v3.1:cloud",
        ] {
            assert_eq!(bridge_scope_for(remote), ToolScope::CloudEngine, "{remote}");
        }
    }

    /// Every engine the user can CHOOSE to run this room drives the app.
    ///
    /// This test used to assert the opposite for `CloudEngine` — the screen was
    /// the one thing a cloud engine did not inherit. Owner decision 2026-08-03
    /// removed that carve-out: a provider the user picked as their room's engine
    /// gets full control, the interface included. The privacy property it was
    /// protecting is preserved by `perceive_image` (which withholds pixels from
    /// a non-vision model and has a local one describe them), not by withholding
    /// the tool.
    ///
    /// A merely CONSULTED advisor is still excluded — driving the app is an
    /// action, not advice.
    #[test]
    fn every_room_engine_can_drive_the_app_but_an_advisor_cannot() {
        use crate::room_mcp::ToolScope;
        assert!(ToolScope::LocalEngine.include_ui_tools());
        assert!(ToolScope::CloudEngine.include_ui_tools());
        assert!(ToolScope::ExternalAgent.include_ui_tools());
        assert!(!ToolScope::CloudAdvisor { include_mcp: true }.include_ui_tools());
        assert!(!ToolScope::CloudAdvisor { include_mcp: false }.include_ui_tools());
    }

    /// Stop, while the model is SILENT.
    ///
    /// The streaming loop only looked at the Stop flag after a chunk arrived, so
    /// pressing Stop during a pause — which is exactly when anyone presses it —
    /// did nothing until the next token, and did nothing at all if the engine
    /// never spoke again.
    #[tokio::test]
    async fn stop_is_noticed_while_the_engine_is_saying_nothing() {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            flag.store(true, Ordering::SeqCst);
        });
        // A stream that will never yield anything, ever.
        let mut silent = futures_util::stream::pending::<u8>();
        let step = tokio::time::timeout(
            Duration::from_secs(5),
            next_stream_chunk(&mut silent, Some(&cancel), Duration::from_secs(3600)),
        )
        .await
        .expect("Stop was ignored while the engine was quiet");
        assert!(matches!(step, StreamStep::Stopped));
    }

    /// …and with nobody pressing anything, a wedged engine still has to end.
    /// There was no time limit on a silent stream at all: quitting the app was
    /// the only way out.
    #[tokio::test]
    async fn a_stream_that_goes_silent_forever_gives_up() {
        let mut silent = futures_util::stream::pending::<u8>();
        let step = tokio::time::timeout(
            Duration::from_secs(5),
            next_stream_chunk(&mut silent, None, Duration::from_millis(250)),
        )
        .await
        .expect("a silent stream never gave up");
        assert!(matches!(step, StreamStep::Idle));
    }

    /// The stall budgets are a ladder, and this is the last rung. If it ever
    /// slipped below the caller's own watchdog, a wedged cloud CLI would be
    /// reported here as a generic silence and the specific advice those layers
    /// exist to give would never be reached.
    #[test]
    fn the_shared_idle_backstop_stays_looser_than_the_watchdogs_above_it() {
        // `chat_commands::stream_idle_secs`'s widest budget (an engine that
        // cannot stream, sized just past the sidecar's own 900s CLI guard).
        assert!(
            STREAM_IDLE_TIMEOUT > Duration::from_secs(960),
            "the backstop now fires before the layer that knows what stalled",
        );
    }

    /// The ordinary case must not be disturbed: a chunk that is there is
    /// returned immediately, and a finished stream ends the loop rather than
    /// waiting out the idle timeout.
    #[tokio::test]
    async fn a_speaking_stream_is_passed_straight_through() {
        let mut live = futures_util::stream::iter(vec![1u8, 2]);
        for expected in [1u8, 2] {
            match next_stream_chunk(&mut live, None, Duration::from_secs(60)).await {
                StreamStep::Chunk(c) => assert_eq!(c, expected),
                _ => panic!("a delivered chunk was not passed through"),
            }
        }
        assert!(matches!(
            next_stream_chunk(&mut live, None, Duration::from_secs(60)).await,
            StreamStep::Ended
        ));
    }
}
