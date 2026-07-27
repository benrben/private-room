use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Ollama's HTTP base URL from the ENV/DEFAULT layer only. Normally the local
/// daemon, but overridable via the `ARCELLE_OLLAMA_URL` env var so
/// end-to-end tests (HLT-8) can point the app at a mock server with no real
/// model. Cached on first read; behaviour is identical to the old hardcoded
/// constant when the env var is unset.
///
/// Actual requests do NOT call this directly — they call `resolved_base_url()`,
/// which layers a runtime override (the "closet supercomputer" Settings value)
/// on top of this. Kept as `&'static str` because the env/default is fixed for
/// the process lifetime.
fn base_url() -> &'static str {
    static BASE_URL: OnceLock<String> = OnceLock::new();
    BASE_URL.get_or_init(|| {
        std::env::var("ARCELLE_OLLAMA_URL")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:11434".to_string())
    })
}

/// C1: the runtime base-URL override — the "closet supercomputer" Settings
/// value that points the app at a remote Ollama box on the LAN. Unlike
/// `ARCELLE_OLLAMA_URL` (read once, cached), this is settable while the app
/// runs, so flipping the Settings field takes effect on the next request with no
/// restart. `None` (the default) means "no override — fall back to env, then the
/// local default".
fn base_url_override() -> &'static std::sync::RwLock<Option<String>> {
    static BASE_URL_OVERRIDE: OnceLock<std::sync::RwLock<Option<String>>> = OnceLock::new();
    BASE_URL_OVERRIDE.get_or_init(|| std::sync::RwLock::new(None))
}

/// C1: set (or clear, with `None`) the runtime base-URL override. Trailing
/// slashes are trimmed so a pasted `http://box:11434/` is stored the same as
/// `http://box:11434`. An empty or whitespace-only string clears the override,
/// same as `None`.
pub fn set_base_url_override(url: Option<String>) {
    let normalized = url
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    if let Ok(mut guard) = base_url_override().write() {
        *guard = normalized;
    }
}

/// C1: the base URL that actual requests use. Precedence:
/// runtime override (`set_base_url_override`) > `ARCELLE_OLLAMA_URL` env >
/// default `http://127.0.0.1:11434`. Returns an owned `String` (not the
/// `&'static str` of `base_url()`) because the override can change at runtime.
pub fn resolved_base_url() -> String {
    if let Ok(guard) = base_url_override().read() {
        if let Some(url) = guard.as_ref() {
            return url.clone();
        }
    }
    base_url().to_string()
}

/// ADD-13: default local embedding model for meaning-based retrieval. Small
/// (~270 MB), run by Ollama via the sidecar `/embed` endpoint. Both chunk
/// vectors (stored in `chunks.embedding`) and the question vector are produced
/// by this model.
pub const EMBED_MODEL: &str = "nomic-embed-text";

#[derive(Serialize, Clone, Default)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        ChatMessage {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

fn map_send_err(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        "OLLAMA_DOWN".to_string()
    } else {
        format!("Local AI request failed: {e}")
    }
}

// MIGRATION Phase 1: the Python/LangGraph sidecar is the app's SOLE AI service.
// Every non-agent LLM call in this file POSTs to it (after ensuring it is up)
// instead of hitting Ollama directly — Rust gathers the DB text, the sidecar owns
// all model I/O. There is NO native fallback: if the sidecar can't start, the call
// errors. The Ollama base URL the sidecar should talk to is `resolved_base_url()`
// (the runtime "closet supercomputer" override still lives HERE on the Rust side),
// so we pass it in every request body rather than the sidecar holding its own copy.

/// POST a JSON body to a sidecar gateway endpoint, returning the parsed JSON.
/// Ensures the sidecar is up first (no native fallback). A classified engine
/// failure comes back as a non-2xx `{code,error}` body; `model` (when known) lets
/// us rebuild the `MODEL_MISSING:<model>` sentinel the callers still branch on.
async fn sidecar_post(
    path: &str,
    body: &serde_json::Value,
    model: Option<&str>,
) -> Result<serde_json::Value, String> {
    let base = crate::sidecar_lifecycle::ensure_up().await?;
    // PRIV-1: the room's redaction rules must ride along for a cloud/CLI model,
    // exactly as they do on the other gateway (`sidecar.rs::sidecar_json`). Without
    // this, `privacy.guard_outbound` sidecar-side sees `policy is None` and returns
    // the messages UNTOUCHED — so studio HTML, meeting transcripts and grounding
    // images reached cloud engines as raw room content. Idempotent: `inject_policy`
    // returns None when a `privacy` key is already present, so `handoff_summary`'s
    // own injection below is unaffected.
    let body = crate::commands::inject_policy(body).unwrap_or_else(|| body.clone());
    let body = match model {
        Some(model) => crate::commands::inject_provider_runtime(&body, model)?,
        None => body,
    };
    let resp = client()?
        .post(format!("{base}{path}"))
        .json(&body)
        .send()
        .await
        .map_err(map_send_err)?;
    let status = resp.status();
    if status.is_success() {
        return resp.json().await.map_err(|e| e.to_string());
    }
    let v: serde_json::Value = resp.json().await.unwrap_or_default();
    Err(map_sidecar_error(&v, model, status))
}

/// Rebuild the pre-migration error sentinels from the sidecar's `{code,error}`
/// envelope: `OLLAMA_DOWN` straight through, `MODEL_MISSING` re-tagged with the
/// model name (the sidecar doesn't echo it back), anything else a plain engine
/// error — so summarize.rs / jobs.rs / file_pass.rs match exactly what they did
/// when Rust called Ollama directly.
fn map_sidecar_error(
    v: &serde_json::Value,
    model: Option<&str>,
    status: reqwest::StatusCode,
) -> String {
    match v["code"].as_str() {
        Some("OLLAMA_DOWN") => "OLLAMA_DOWN".to_string(),
        Some("MODEL_MISSING") => match model {
            Some(m) => format!("MODEL_MISSING:{m}"),
            None => "MODEL_MISSING".to_string(),
        },
        _ => format!(
            "Local AI error ({status}): {}",
            v["error"].as_str().unwrap_or("unknown error")
        ),
    }
}

/// MIGRATION follow-up (ADD-33): the Python sidecar TALKS to Ollama but cannot
/// START it. Before any model-loading gateway call, ensure the local
/// `ollama serve` daemon is up (spawned on demand — local base URLs only) and
/// hold the returned `Busy` guard for the call's whole duration so the idle
/// watcher won't sleep it mid-request. A remote or unstartable daemon yields the
/// same `OLLAMA_DOWN` surface the callers already handle. Metadata reads
/// (`list_models`/`capabilities`/`delete_model`) deliberately SKIP this — they
/// must never boot a sleeping daemon just to inspect state.
pub async fn wake_daemon() -> Result<crate::ollama_lifecycle::Busy, String> {
    crate::ollama_lifecycle::ensure_up(&resolved_base_url()).await
}

/// POST `/generate`, but honour a caller-owned cancel flag (ADD-31/ADD-32): a
/// Studio writing a whole HTML page, or a whole-file pass running one Job-tier
/// call per window, runs for minutes and Stop must abandon it promptly. The
/// sidecar `/generate` is non-streaming, so there is no partial text to keep —
/// we race the request against the flag and DROP it on Stop (dropping the reqwest
/// future closes the connection, which stops Ollama), returning an empty `text`
/// the caller treats as a stopped run (same "partial == stopped" contract as the
/// old streamed path, minus the partial tokens the non-streaming endpoint can't
/// surface).
async fn post_generate_cancellable(
    body: &serde_json::Value,
    model: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<serde_json::Value, String> {
    // Ensure the local Ollama daemon is up (the sidecar can't start it) and hold
    // the guard across the request; both branches below await under it. Engine
    // parity: an external CLI model never touches Ollama — booting (or failing
    // to boot) the daemon would only block a room that runs entirely on a CLI.
    let _daemon = if crate::commands::is_external_engine(model) {
        None
    } else {
        Some(wake_daemon().await?)
    };
    let Some(flag) = cancel else {
        return sidecar_post("/generate", body, Some(model)).await;
    };
    let fut = sidecar_post("/generate", body, Some(model));
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return res,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if flag.load(Ordering::SeqCst) {
                    // Returning here drops `fut`, aborting the in-flight request.
                    return Ok(serde_json::json!({ "text": "" }));
                }
            }
        }
    }
}

/// Streaming chat that can also carry a tool catalog. Returns the streamed
/// text plus any tool calls the model made this round.
///
/// `cancel`, when set true mid-stream (ADD-7), breaks out of the token loop
/// promptly and returns whatever text streamed so far.
///
/// `keep_alive` (HLT-5) is how long Ollama holds the model resident after this
/// call (e.g. "30m" to stay warm, "2m"/"0" to release a vision model on
/// low-RAM machines). The caller decides per model — see `vision_keep_alive`.
/// Compatibility classification retained for existing callers. Context-window
/// sizing is now owned by Ollama/the selected model, so both variants use the
/// same uncapped request body.
#[derive(Clone, Copy, Default)]
pub enum CtxTier {
    #[default]
    Chat,
    Job,
}

/// The knobs a `chat_structured` caller may vary. `Default` is the interactive
/// case: Chat context tier, no cancellation.
#[derive(Default, Clone)]
pub struct StructuredOpts {
    // `tier: CtxTier` lived here and is DELETED (2026-07-25). Its own doc said
    // "no longer changes the context window", so it was a field callers set and
    // nothing read — kept alive only by `#[allow(dead_code)]`. The same dead
    // `tier` argument was removed from the Python twin (`summarize.py`
    // `_chat_structured`) in the same pass; the context window is now decided
    // by payload-fitted `num_ctx`, not by a caller's classification.
    /// ADD-31/ADD-32: a caller-owned flag for long structured generations the
    /// user must be able to stop — a Studio writing a whole HTML page on a
    /// local model runs for minutes, and a whole-file pass runs one Job-tier
    /// call per window for possibly hours. Flipping the flag abandons the
    /// stream promptly; the caller treats the partial as stopped.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl StructuredOpts {
    /// Attach a caller-owned cancel flag.
    pub fn with_cancel(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = Some(cancel);
        self
    }
}

/// ADD-22 training wheel: a one-shot call whose output is CONSTRAINED to a JSON
/// schema via Ollama's `format` (grammar-based token masking). No tools, no
/// streaming — for the small side-jobs (grounding boxes, field extraction,
/// list-making, summaries) that used to beg the model for JSON in prose and
/// salvage-parse the result. The model literally cannot emit a structurally
/// invalid document, and constrained decoding is markedly faster.
pub async fn chat_structured(
    model: &str,
    mut messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
    opts: StructuredOpts,
) -> Result<String, String> {
    // CRITICAL (Ollama's own guidance): `format` constrains the output GRAMMAR
    // but the model NEVER SEES the schema. Without the field names in the prompt
    // a small model tends to fill the forced JSON with empty strings, so we
    // append the schema to the last user message to ground its content.
    if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "user") {
        last.content.push_str(&format!(
            "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n{}",
            serde_json::to_string(schema).unwrap_or_default()
        ));
    }
    let body = serde_json::json!({
        "model": model,
        // Images (vision grounding) ride inline on the user messages; the sidecar
        // reads them straight off the message dicts, so no separate `images` field.
        "messages": messages,
        "base_url": resolved_base_url(),
        // `null` when unset — the sidecar treats a null temperature as "omit".
        "temperature": temperature,
        "keep_alive": keep_alive,
        // ADD-22: the structured-output grammar (token masking) — the sidecar
        // passes it to Ollama as `format`.
        "format": schema,
    });
    let value = post_generate_cancellable(&body, model, opts.cancel).await?;
    let text = value["text"].as_str().unwrap_or_default();
    Ok(recover_json(text))
}

// MIGRATION Phase 2a: the PLAIN-GENERATION path (no tools, no `format` schema)
// off the old streaming native chat path. These replace the tool-less streaming
// calls whose only job was to turn a prompt into text — STT/recording naming +
// shaping (non-streaming, `generate`) and the interactive #command answers
// streamed into the chat (streaming, `sidecar::generate_stream`). Both POST the
// SAME `/generate` request schema (`plain_generate_body`), so the streamed and
// non-streamed variants omit `num_ctx`, think-disable, and pass the base URL
// identically.

/// Build the `/generate`(`_stream`) request body for a tool-less, plain-text
/// chat — the shared schema the streaming ([`crate::sidecar::generate_stream`])
/// and non-streaming ([`generate`]) plain paths both POST. The legacy `tier`
/// argument is accepted for caller compatibility, but the request omits
/// `num_ctx` so Ollama/the model owns the context window. No `format` (that is
/// `chat_structured`'s grammar path) and no `tools`.
pub fn plain_generate_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f64>,
    keep_alive: &str,
    _tier: CtxTier,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": messages,
        "base_url": resolved_base_url(),
        // `null` when unset — the sidecar treats a null temperature as "omit".
        "temperature": temperature,
        "keep_alive": keep_alive,
    })
}

/// Non-streaming plain-text generation through the sidecar `/generate`. The
/// drop-in for the tool-less streaming calls whose output was NOT
/// streamed (a #command's quiet step, dictation shaping, recording/segment
/// naming + translation): same messages/temperature/keep_alive, returning the
/// model's RAW text (no
/// `recover_json` — these are prose, not JSON; callers `strip_think_spans`
/// themselves as before). Engine failures come back as the same `OLLAMA_DOWN` /
/// `MODEL_MISSING:<model>` sentinels.
///
/// `cancel` (ADD-7/ADD-31): a quiet #command step the user must be able to Stop
/// races the request against the flag and drops it on Stop, yielding empty text
/// the caller treats as stopped (same "partial == stopped" contract the old
/// streamed path had). Callers with no Stop affordance pass `None`.
///
/// `tier` remains part of this API for existing callers but no longer changes
/// the generated request.
pub async fn generate(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    cancel: Option<Arc<AtomicBool>>,
    tier: CtxTier,
) -> Result<String, String> {
    let body = plain_generate_body(model, &messages, temperature, keep_alive, tier);
    let value = post_generate_cancellable(&body, model, cancel).await?;
    Ok(value["text"].as_str().unwrap_or_default().to_string())
}

/// Context handoff: one summarization call through the sidecar's
/// `/handoff_summary` gateway (`sidecar/arcelle_sidecar/handoff.py`) — the
/// same engine-agnostic `llm.generate` dispatch every other one-shot gateway
/// call gets (Ollama or an external CLI, whichever the room is set to).
/// PRIV-1: the room's privacy policy rides along, same as every other gateway
/// call that touches real chat content (see `sidecar.rs`'s `/run` body).
pub(crate) async fn handoff_summary(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let _daemon = if crate::commands::is_external_engine(model) {
        None
    } else {
        Some(wake_daemon().await?)
    };
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "base_url": resolved_base_url(),
        "temperature": temperature,
    });
    let body = crate::commands::inject_policy(&body).unwrap_or(body);
    let value = sidecar_post("/handoff_summary", &body, Some(model)).await?;
    Ok(value["summary"].as_str().unwrap_or_default().to_string())
}

/// Remove the `<think>…</think>` reasoning spans a model leaks into its visible
/// answer (thinking-capable models do it even with the flag off, and `:cloud`
/// proxies pass them straight through). An UNTERMINATED `<think>` truncates the
/// rest: everything after it is unclosed reasoning, not answer.
pub fn strip_think_spans(raw: &str) -> String {
    let mut out = raw.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(rel) => {
                let end = start + rel + "</think>".len();
                out.replace_range(start..end, "");
            }
            None => {
                out.truncate(start);
                break;
            }
        }
    }
    out
}

/// Recover the JSON payload from a structured-output response. Models that honor
/// Ollama's `format` return bare JSON, so this is a no-op for them; but some
/// models — notably Ollama *cloud* models, which ignore `format` — wrap the JSON
/// in a ```json code fence or emit a `<think>` preamble, which a strict
/// `serde_json::from_str` then rejects (the caller reports "nothing usable").
/// Drop any `<think>` span, then slice from the first opening bracket to the last
/// closing one so callers can parse it regardless of the model's framing.
pub(crate) fn recover_json(text: &str) -> String {
    let s = strip_think_spans(text.trim());
    let s = s.trim();
    match (
        s.find(|c| c == '{' || c == '['),
        s.rfind(|c| c == '}' || c == ']'),
    ) {
        (Some(a), Some(b)) if b >= a => s[a..=b].to_string(),
        _ => s.to_string(),
    }
}

/// ADD-13: embed one or more texts through the sidecar `/embed` (the ollama
/// client's `embed` underneath). Returns one f32 vector per input, in the same
/// order. `keep_alive` (HLT-5) controls how long Ollama holds the (small) embed
/// model resident after the call — a query pass keeps it briefly warm; a
/// background batch pass uses a short value so the model releases itself once
/// indexing goes idle.
///
/// A missing model surfaces as `MODEL_MISSING:<model>` and a stopped server as
/// `OLLAMA_DOWN`, like the other gateway calls; callers treat any error as a
/// silent signal to fall back to the keyword path.
pub async fn embed(model: &str, texts: &[String], keep_alive: &str) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let _daemon = wake_daemon().await?;
    let body = serde_json::json!({
        "model": model,
        "texts": texts,
        "base_url": resolved_base_url(),
        "keep_alive": keep_alive,
    });
    let v = sidecar_post("/embed", &body, Some(model)).await?;
    let embeddings = v["embeddings"]
        .as_array()
        .ok_or("Embed response had no embeddings")?;
    let out = embeddings
        .iter()
        .map(|e| {
            e.as_array()
                .map(|arr| arr.iter().filter_map(|n| n.as_f64().map(|f| f as f32)).collect())
                .unwrap_or_default()
        })
        .collect();
    Ok(out)
}

/// Load a model into memory without generating anything, so the first real
/// request is fast. Fire-and-forget.
pub async fn warm(model: &str) -> Result<(), String> {
    let _daemon = wake_daemon().await?;
    let body = serde_json::json!({
        "model": model,
        "base_url": resolved_base_url(),
        "keep_alive": "30m",
    });
    // Fire-and-forget: the sidecar loads the weights (a no-prompt generate with a
    // small window) and we ignore the body — only a transport/engine failure surfaces.
    sidecar_post("/warm", &body, Some(model)).await?;
    Ok(())
}

/// Download a model from the Ollama registry, reporting progress. No request
/// timeout — pulls are multi-gigabyte.
pub async fn pull(
    model: &str,
    mut on_progress: impl FnMut(&str, Option<f64>),
) -> Result<(), String> {
    use futures_util::StreamExt;

    // The sidecar streams the download as ndjson progress lines (so the UI bar
    // still updates); ensure it is up, then read those lines exactly as we used to
    // read Ollama's own `/api/pull` stream. Not the shared `client()`: a pull must
    // run without its 600s timeout.
    let _daemon = wake_daemon().await?;
    let base = crate::sidecar_lifecycle::ensure_up().await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{base}/pull"))
        .json(&serde_json::json!({ "model": model, "base_url": resolved_base_url() }))
        .send()
        .await
        .map_err(map_send_err)?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download failed: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // A classified failure line from the sidecar: rebuild the sentinels so
            // the UI maps a missing/unreachable engine the same way it always has.
            if let Some(err) = v["error"].as_str() {
                return Err(match v["code"].as_str() {
                    Some("OLLAMA_DOWN") => "OLLAMA_DOWN".to_string(),
                    Some("MODEL_MISSING") => format!("MODEL_MISSING:{model}"),
                    _ => err.to_string(),
                });
            }
            let status = v["status"].as_str().unwrap_or("");
            let percent = match (v["completed"].as_f64(), v["total"].as_f64()) {
                (Some(c), Some(t)) if t > 0.0 => Some(c / t * 100.0),
                _ => None,
            };
            on_progress(status, percent);
        }
    }
    Ok(())
}

pub async fn delete_model(model: &str) -> Result<(), String> {
    // Model management goes through the sidecar (`/delete` → the ollama client's
    // `delete`), same as `/models`, `/warm`, `/pull`. Rust makes no direct Ollama
    // HTTP call. Success returns `{ "ok": true }`; a classified engine failure
    // comes back as a non-2xx `{code,error}` body `sidecar_post` maps for us.
    let body = serde_json::json!({ "model": model, "base_url": resolved_base_url() });
    sidecar_post("/delete", &body, Some(model)).await?;
    Ok(())
}

pub async fn list_models() -> Result<Vec<String>, String> {
    let body = serde_json::json!({ "base_url": resolved_base_url() });
    let v = sidecar_post("/models", &body, None).await?;
    Ok(v["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// The model's real advertised context length, from Ollama's own `/api/tags`
/// catalog — read by the SIDECAR, not here. Until 2026-07-25 this was the last
/// raw `GET {base}/api/tags` left in Rust, which contradicted the module note
/// above ("the sidecar is the app's SOLE AI service"); it now goes through
/// `/context_length`, whose body is `model_limits.native_context_length`.
/// `None` on any failure (sidecar or daemon unreachable, model not listed) —
/// the caller uses a display fallback, so a dead sidecar degrades rather than
/// erroring. Used by `handoff_chat`'s post-handoff usage snapshot.
pub(crate) async fn native_context_length(model: &str) -> Option<u32> {
    let body = serde_json::json!({ "model": model, "base_url": resolved_base_url() });
    let v = sidecar_post("/context_length", &body, Some(model)).await.ok()?;
    v.get("context_length")
        .and_then(|n| n.as_u64())
        .map(|n| n as u32)
}

/// ADD-22: a model's declared capabilities via the sidecar `/capabilities`
/// (Ollama's `/api/show` underneath) — e.g. "tools", "vision", "completion".
/// This is a metadata call — it does NOT load the model into memory. Empty on
/// any error, so callers treat "unknown" as "no special capability" rather than
/// failing (the Settings badges just don't show).
pub async fn capabilities(model: &str) -> Vec<String> {
    // Empty on ANY error (sidecar down, engine error, bad JSON): callers treat
    // "unknown" as "no special capability" so the Settings badges just don't show.
    let Ok(base) = crate::sidecar_lifecycle::ensure_up().await else {
        return Vec::new();
    };
    let Ok(client) = client() else { return Vec::new() };
    let body = serde_json::json!({ "model": model, "base_url": resolved_base_url() });
    let Ok(resp) = client
        .post(format!("{base}/capabilities"))
        .json(&body)
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    v["capabilities"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // C1: the runtime override wins over env/default, trims trailing slashes,
    // and clearing it falls back to the env/default path. No network involved.
    #[test]
    fn base_url_override_precedence() {
        // A set override wins over env/default...
        set_base_url_override(Some("http://example:1".to_string()));
        assert_eq!(resolved_base_url(), "http://example:1");

        // ...trailing slashes (and surrounding whitespace) are trimmed...
        set_base_url_override(Some(" http://example:2/ ".to_string()));
        assert_eq!(resolved_base_url(), "http://example:2");

        // ...clearing with None falls back to the env/default layer...
        set_base_url_override(None);
        assert_eq!(resolved_base_url(), base_url());

        // ...and an empty/whitespace-only string clears it too (same as None).
        set_base_url_override(Some("   ".to_string()));
        assert_eq!(resolved_base_url(), base_url());
    }

    #[test]
    fn plain_generate_body_leaves_context_to_the_engine() {
        let messages = vec![ChatMessage::new("user", "hi")];
        let chat = plain_generate_body("m", &messages, None, "30m", CtxTier::Chat);
        let job = plain_generate_body("m", &messages, None, "30m", CtxTier::Job);
        assert!(chat.get("num_ctx").is_none());
        assert!(job.get("num_ctx").is_none());
    }

    // A structured-output response must parse whether the model returns bare
    // JSON (local, honors `format`) or wraps it in a ```json fence / <think>
    // preamble (Ollama cloud models, which ignore `format`).
    #[test]
    fn recover_json_unwraps_fences_think_and_prose() {
        // The ```json-fence row is the cloud-model failure that reported
        // "nothing usable"; the last is a top-level array under a bare fence.
        let cases = [
            ("{\"markdown\":\"hi\"}", "{\"markdown\":\"hi\"}"),
            ("```json\n{\"markdown\":\"hi\"}\n```", "{\"markdown\":\"hi\"}"),
            ("<think>hmm</think>\n{\"a\":1}", "{\"a\":1}"),
            ("```\n[1,2,3]\n```", "[1,2,3]"),
        ];
        for (input, expected) in cases {
            assert_eq!(recover_json(input), expected);
        }
    }

}
