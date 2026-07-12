use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Ollama's HTTP base URL from the ENV/DEFAULT layer only. Normally the local
/// daemon, but overridable via the `PRIVATE_ROOM_OLLAMA_URL` env var so
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
        std::env::var("PRIVATE_ROOM_OLLAMA_URL")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:11434".to_string())
    })
}

/// C1: the runtime base-URL override — the "closet supercomputer" Settings
/// value that points the app at a remote Ollama box on the LAN. Unlike
/// `PRIVATE_ROOM_OLLAMA_URL` (read once, cached), this is settable while the app
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
/// runtime override (`set_base_url_override`) > `PRIVATE_ROOM_OLLAMA_URL` env >
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
/// (~270 MB), served by Ollama's `/api/embed`. Both chunk vectors (stored in
/// `chunks.embedding`) and the question vector are produced by this model.
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
    pub raw: serde_json::Value,
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

/// Streaming chat that can also carry a tool catalog. Returns the streamed
/// text plus any tool calls the model made this round.
///
/// `cancel`, when set true mid-stream (ADD-7), breaks out of the token loop
/// promptly and returns whatever text streamed so far.
///
/// `keep_alive` (HLT-5) is how long Ollama holds the model resident after this
/// call (e.g. "30m" to stay warm, "2m"/"0" to release a vision model on
/// low-RAM machines). The caller decides per model — see `vision_keep_alive`.
/// ADD-27: which latency class a call belongs to, which decides how big a
/// `num_ctx` it may allocate. `Chat` is the interactive path — prefill time is
/// user-visible, so its window stays small. `Job` is background work (deep
/// summaries, digests): prefill minutes are fine, so it gets the big window.
#[derive(Clone, Copy)]
pub enum CtxTier {
    Chat,
    Job,
}

/// ADD-22: the working-memory window (`num_ctx`) handed to Ollama, sized so a
/// 16 GB Mac never OOMs. Measured 2026-07 on qwen3.5:9b (Q4_K_M, GQA cache
/// ≈34 KB/token, 16 GB M-series): 12k ctx → 5.9 GB · 32k → 6.6 GB · 64k →
/// 7.7 GB · 128k → 9.9 GB, all 100% GPU. Chat sizes stay small because the
/// user waits for prefill (~210 tok/s on that machine); Job sizes go big
/// because a background step can afford minutes. Read once.
fn num_ctx_for(has_tools: bool, tier: CtxTier) -> u32 {
    static HIGH_RAM: OnceLock<bool> = OnceLock::new();
    let high = *HIGH_RAM.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory() >= 32 * 1024 * 1024 * 1024
    });
    match (tier, has_tools, high) {
        (CtxTier::Job, _, true) => 131072,
        (CtxTier::Job, _, false) => 65536,
        (CtxTier::Chat, true, true) => 24576,
        (CtxTier::Chat, true, false) => 12288,
        (CtxTier::Chat, false, true) => 16384,
        (CtxTier::Chat, false, false) => 8192,
    }
}

/// ADD-27: rough character budget for a background-job call (≈3 chars/token —
/// a safe floor across English and Hebrew), so read-loop callers can size
/// their windows to what the engine will actually see instead of a hardcoded
/// snippet. 16 GB Mac → ~196k chars; 32 GB+ → ~393k.
pub fn job_context_chars() -> usize {
    num_ctx_for(true, CtxTier::Job) as usize * 3
}

pub async fn chat_stream_tools(
    model: &str,
    messages: Vec<ChatMessage>,
    tools: Option<&serde_json::Value>,
    temperature: Option<f64>,
    cancel: Option<Arc<AtomicBool>>,
    keep_alive: &str,
    on_delta: impl FnMut(&str),
) -> Result<(String, Vec<ToolCall>), String> {
    chat_core(
        model, messages, tools, temperature, cancel, keep_alive, None, false, CtxTier::Chat,
        on_delta,
    )
    .await
}

/// ADD-27: like `chat_stream_tools`, but for BACKGROUND JOB rounds: runs at
/// the Job context tier (big `num_ctx`) and lets a thinking-capable model
/// think. Measured on qwen3.5: with `think: false` it answers directly and
/// NEVER calls the offered tools, so tool-driven flows (the summarizer's read
/// loop) silently degrade; with thinking on it reasons briefly and calls
/// them. Interactive chat keeps the fast non-thinking, small-context default.
pub async fn chat_stream_tools_thinking(
    model: &str,
    messages: Vec<ChatMessage>,
    tools: Option<&serde_json::Value>,
    temperature: Option<f64>,
    cancel: Option<Arc<AtomicBool>>,
    keep_alive: &str,
    on_delta: impl FnMut(&str),
) -> Result<(String, Vec<ToolCall>), String> {
    chat_core(
        model, messages, tools, temperature, cancel, keep_alive, None, true, CtxTier::Job,
        on_delta,
    )
    .await
}

/// ADD-22 training wheel: a one-shot call whose output is CONSTRAINED to a JSON
/// schema via Ollama's `format` (grammar-based token masking). No tools, no
/// streaming, no cancel — for the small side-jobs (grounding boxes, field
/// extraction, list-making, summaries) that used to beg the model for JSON in
/// prose and salvage-parse the result. The model literally cannot emit a
/// structurally invalid document, and constrained decoding is markedly faster.
pub async fn chat_structured(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
) -> Result<String, String> {
    chat_structured_tier(model, messages, temperature, keep_alive, schema, CtxTier::Chat, None)
        .await
}

/// ADD-31: `chat_structured` with a caller-owned cancel flag, for long
/// structured generations the user must be able to stop (a Studio writing a
/// whole HTML page on a local model runs for minutes). Flipping the flag
/// abandons the stream promptly; the caller treats the partial as stopped.
pub async fn chat_structured_cancel(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    chat_structured_tier(
        model,
        messages,
        temperature,
        keep_alive,
        schema,
        CtxTier::Chat,
        Some(cancel),
    )
    .await
}

/// ADD-27: `chat_structured` at the Job context tier — for the final call of a
/// background job whose messages carry big gathered windows (a deep summary's
/// reads would overflow the small chat `num_ctx` and silently drop the user's
/// question).
pub async fn chat_structured_job(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
) -> Result<String, String> {
    chat_structured_tier(model, messages, temperature, keep_alive, schema, CtxTier::Job, None)
        .await
}

/// ADD-32: `chat_structured_job` with a caller-owned cancel flag — a whole-file
/// pass runs one Job-tier structured call per window for possibly hours, and
/// Stop must be able to abandon the in-flight window, not just wait it out.
pub async fn chat_structured_job_cancel(
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    chat_structured_tier(
        model,
        messages,
        temperature,
        keep_alive,
        schema,
        CtxTier::Job,
        Some(cancel),
    )
    .await
}

async fn chat_structured_tier(
    model: &str,
    mut messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    keep_alive: &str,
    schema: &serde_json::Value,
    tier: CtxTier,
    cancel: Option<Arc<AtomicBool>>,
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
    let (text, _) = chat_core(
        model, messages, None, temperature, cancel, keep_alive, Some(schema), false, tier,
        |_| {},
    )
    .await?;
    Ok(recover_json(&text))
}

/// Recover the JSON payload from a structured-output response. Models that honor
/// Ollama's `format` return bare JSON, so this is a no-op for them; but some
/// models — notably Ollama *cloud* models, which ignore `format` — wrap the JSON
/// in a ```json code fence or emit a `<think>` preamble, which a strict
/// `serde_json::from_str` then rejects (the caller reports "nothing usable").
/// Drop any `<think>` span, then slice from the first opening bracket to the last
/// closing one so callers can parse it regardless of the model's framing.
fn recover_json(text: &str) -> String {
    let mut s = text.trim().to_string();
    while let Some(a) = s.find("<think>") {
        match s[a..].find("</think>") {
            Some(rel) => {
                let b = a + rel + "</think>".len();
                s.replace_range(a..b, "");
            }
            None => break,
        }
    }
    let s = s.trim();
    match (
        s.find(|c| c == '{' || c == '['),
        s.rfind(|c| c == '}' || c == ']'),
    ) {
        (Some(a), Some(b)) if b >= a => s[a..=b].to_string(),
        _ => s.to_string(),
    }
}

/// ADD-29: recover tool calls a model emitted INLINE as text instead of in the
/// structured `tool_calls` field. Some engines (historically Ollama `:cloud`
/// proxies, some OpenAI-compatible backends) wrap a call in `<tool_call>…JSON…
/// </tool_call>`; the stream parser never sees it, so the call silently never
/// runs. This is the safety net that gives EVERY selected engine tool parity:
/// after streaming, if no structured calls arrived, scan the text for these
/// spans, parse each `{name, arguments}` object, and return the calls plus the
/// text with those spans removed. Returns `(cleaned_text, calls)`.
fn parse_inline_tool_calls(text: &str) -> (String, Vec<ToolCall>) {
    let mut calls = Vec::new();
    let mut cleaned = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<tool_call>") {
        let (before, after_open) = rest.split_at(start);
        cleaned.push_str(before);
        let after_open = &after_open["<tool_call>".len()..];
        let (inner, remainder) = match after_open.find("</tool_call>") {
            Some(end) => (&after_open[..end], &after_open[end + "</tool_call>".len()..]),
            // Unterminated: treat the remainder as the payload and stop.
            None => (after_open, ""),
        };
        if let Some(call) = tool_call_from_json(inner) {
            calls.push(call);
        }
        rest = remainder;
    }
    cleaned.push_str(rest);
    (cleaned.trim().to_string(), calls)
}

/// Parse one `{"name": "...", "arguments": {...}}` object (tolerating fences /
/// `<think>` via recover_json) into a ToolCall. `arguments` may be an object or
/// a JSON-encoded string. Returns None if there's no usable name.
fn tool_call_from_json(raw: &str) -> Option<ToolCall> {
    let v: serde_json::Value = serde_json::from_str(raw.trim())
        .or_else(|_| serde_json::from_str(&recover_json(raw)))
        .ok()?;
    let name = v["name"].as_str().or_else(|| v["function"]["name"].as_str())?;
    let args_src = if v["arguments"].is_null() {
        &v["function"]["arguments"]
    } else {
        &v["arguments"]
    };
    Some(ToolCall {
        name: name.to_string(),
        arguments: normalize_tool_arguments(args_src),
        raw: serde_json::json!({
            "function": { "name": name, "arguments": normalize_tool_arguments(args_src) }
        }),
    })
}

/// Normalize a tool call's `arguments`. Ollama's native `/api/chat` returns
/// them as a JSON object, but OpenAI-style engines and `:cloud` proxies return
/// a JSON-ENCODED STRING (e.g. `"{\"old_text\":\"…\"}"`). Left as a string,
/// every `args["field"]` lookup in exec_tool indexes into a scalar, yields
/// null, and the tool reports the field "required" even though the model
/// supplied it. Parse a string payload back into a value (tolerating fences /
/// `<think>` via recover_json); pass objects through untouched.
fn normalize_tool_arguments(v: &serde_json::Value) -> serde_json::Value {
    match v.as_str() {
        Some(s) => serde_json::from_str(s)
            .or_else(|_| serde_json::from_str(&recover_json(s)))
            .unwrap_or_else(|_| v.clone()),
        None => v.clone(),
    }
}

/// Streaming chat that can also carry a tool catalog and/or a `format` schema.
/// `format`, when set, constrains the response to a JSON schema; it is mutually
/// exclusive with tool calling in practice (Ollama injects tool specs into the
/// prompt but masks tokens for `format`), so tool callers pass None.
#[allow(clippy::too_many_arguments)]
async fn chat_core(
    model: &str,
    messages: Vec<ChatMessage>,
    tools: Option<&serde_json::Value>,
    temperature: Option<f64>,
    cancel: Option<Arc<AtomicBool>>,
    keep_alive: &str,
    format: Option<&serde_json::Value>,
    think: bool,
    tier: CtxTier,
    mut on_delta: impl FnMut(&str),
) -> Result<(String, Vec<ToolCall>), String> {
    use futures_util::StreamExt;

    // Tool catalogs and tool results (search hits, fetched pages) need more
    // room than plain chat, but stay far below the model-declared maximums
    // that OOM 16 GB machines.
    let num_ctx = num_ctx_for(tools.is_some(), tier);
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
        // HLT-5: how long Ollama keeps this model resident after the call.
        // Chat passes "30m" to stay warm; vision/grounding calls pass a short
        // value on low-RAM machines so both models never sit resident at once.
        "keep_alive": keep_alive,
        // CRITICAL: some models (qwen3-vl) declare a 256K context window and
        // Ollama will allocate ~30 GB of KV cache for it, OOM-killing the
        // server on a 16 GB machine. Our prompts fit comfortably in 8K.
        "options": { "num_ctx": num_ctx },
    });
    if let Some(t) = temperature {
        body["options"]["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = tools {
        body["tools"] = tools.clone();
    }
    // ADD-22: constrain the output to a JSON schema (grammar token masking).
    if let Some(fmt) = format {
        body["format"] = fmt.clone();
    }
    // Qwen3 thinking variants burn thousands of hidden reasoning tokens
    // (measured: 90s for a one-line answer). Instruct variants don't think
    // and reject the flag, so only send it to the thinking ones. ADD-27:
    // `think` re-enables it for short tool-decision rounds (see
    // `chat_stream_tools_thinking`); it still only applies to models that
    // accept the flag.
    if model.contains("qwen3") && !model.contains("instruct") {
        body["think"] = serde_json::Value::Bool(think);
    }
    // ADD-29: start the daemon on demand and keep it awake for this call. The
    // guard bumps the idle clock when the call ends, so the 5-minute sleep
    // window is measured from here. Held to the end of the function.
    let base = resolved_base_url();
    let _busy = crate::ollama_lifecycle::ensure_up(&base).await?;
    let resp = client()?
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(map_send_err)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 404 && text.contains("not found") {
            return Err(format!("MODEL_MISSING:{model}"));
        }
        return Err(format!("Local AI error ({status}): {text}"));
    }

    let mut full = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        // ADD-7: user pressed Stop — abandon the stream, keep partial text.
        if let Some(flag) = &cancel {
            if flag.load(Ordering::SeqCst) {
                break;
            }
        }
        let chunk = chunk.map_err(|e| format!("Local AI stream failed: {e}"))?;
        buf.extend_from_slice(&chunk);
        // Ollama streams newline-delimited JSON objects.
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
            if let Some(err) = v["error"].as_str() {
                return Err(format!("Local AI error: {err}"));
            }
            if let Some(calls) = v["message"]["tool_calls"].as_array() {
                for c in calls {
                    if let Some(name) = c["function"]["name"].as_str() {
                        tool_calls.push(ToolCall {
                            name: name.to_string(),
                            arguments: normalize_tool_arguments(&c["function"]["arguments"]),
                            raw: c.clone(),
                        });
                    }
                }
            }
            if let Some(delta) = v["message"]["content"].as_str() {
                if !delta.is_empty() {
                    full.push_str(delta);
                    on_delta(delta);
                }
            }
        }
    }
    // ADD-29 parity net: if tools were offered but none arrived structurally,
    // the model may have leaked them inline as `<tool_call>…</tool_call>` text
    // (some cloud/OpenAI-compatible engines do). Recover them so EVERY engine
    // can drive the tool loop, and strip the spans from the visible answer.
    if tools.is_some() && tool_calls.is_empty() && full.contains("<tool_call>") {
        let (cleaned, inline) = parse_inline_tool_calls(&full);
        if !inline.is_empty() {
            full = cleaned;
            tool_calls = inline;
        }
    }
    Ok((full, tool_calls))
}

/// ADD-13: embed one or more texts via Ollama's `/api/embed`. Returns one f32
/// vector per input, in the same order. `keep_alive` (HLT-5) controls how long
/// Ollama holds the (small) embed model resident after the call — a query pass
/// keeps it briefly warm; a background batch pass uses a short value so the
/// model releases itself once indexing goes idle.
///
/// A missing model surfaces as `MODEL_MISSING:<model>` and a stopped server as
/// `OLLAMA_DOWN`, mirroring `chat_stream_tools`; callers treat any error as a
/// silent signal to fall back to the keyword path.
pub async fn embed(model: &str, texts: &[String], keep_alive: &str) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let body = serde_json::json!({
        "model": model,
        "input": texts,
        "keep_alive": keep_alive,
    });
    let base = resolved_base_url();
    let _busy = crate::ollama_lifecycle::ensure_up(&base).await?;
    let resp = client()?
        .post(format!("{base}/api/embed"))
        .json(&body)
        .send()
        .await
        .map_err(map_send_err)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 404 && text.contains("not found") {
            return Err(format!("MODEL_MISSING:{model}"));
        }
        return Err(format!("Local AI error ({status}): {text}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
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
    let body = serde_json::json!({
        "model": model,
        "keep_alive": "30m",
        "options": { "num_ctx": 8192 },
    });
    let base = resolved_base_url();
    let _busy = crate::ollama_lifecycle::ensure_up(&base).await?;
    client()?
        .post(format!("{base}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(map_send_err)?;
    Ok(())
}

/// Download a model from the Ollama registry, reporting progress. No request
/// timeout — pulls are multi-gigabyte.
pub async fn pull(
    model: &str,
    mut on_progress: impl FnMut(&str, Option<f64>),
) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let base = resolved_base_url();
    let _busy = crate::ollama_lifecycle::ensure_up(&base).await?;
    let resp = client
        .post(format!("{base}/api/pull"))
        .json(&serde_json::json!({ "model": model, "stream": true }))
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
            if let Some(err) = v["error"].as_str() {
                return Err(err.to_string());
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
    let resp = client()?
        .delete(format!("{}/api/delete", resolved_base_url()))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(map_send_err)?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Could not delete model: {}",
            resp.text().await.unwrap_or_default()
        ))
    }
}

pub async fn list_models() -> Result<Vec<String>, String> {
    let resp = client()?
        .get(format!("{}/api/tags", resolved_base_url()))
        .send()
        .await
        .map_err(map_send_err)?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// ADD-22: a model's declared capabilities via `/api/show` (e.g. "tools",
/// "vision", "completion"). This is a metadata call — it does NOT load the model
/// into memory. Empty on any error, so callers treat "unknown" as "no special
/// capability" rather than failing (the Settings badges just don't show).
pub async fn capabilities(model: &str) -> Vec<String> {
    let Ok(client) = client() else { return Vec::new() };
    let resp = client
        .post(format!("{}/api/show", resolved_base_url()))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await;
    let Ok(resp) = resp else { return Vec::new() };
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

    // A structured-output response must parse whether the model returns bare
    // JSON (local, honors `format`) or wraps it in a ```json fence / <think>
    // preamble (Ollama cloud models, which ignore `format`).
    #[test]
    fn recover_json_unwraps_fences_think_and_prose() {
        // Bare JSON is returned unchanged.
        assert_eq!(recover_json("{\"markdown\":\"hi\"}"), "{\"markdown\":\"hi\"}");
        // A ```json code fence (the cloud-model failure that reported "nothing
        // usable") is stripped down to the JSON.
        assert_eq!(
            recover_json("```json\n{\"markdown\":\"hi\"}\n```"),
            "{\"markdown\":\"hi\"}"
        );
        // A <think> reasoning preamble is dropped.
        assert_eq!(recover_json("<think>hmm</think>\n{\"a\":1}"), "{\"a\":1}");
        // A top-level array survives a bare fence.
        assert_eq!(recover_json("```\n[1,2,3]\n```"), "[1,2,3]");
    }

    // Tool-call arguments must resolve whether the engine returns them as a
    // JSON object (Ollama native) or a JSON-encoded string (OpenAI-style /
    // :cloud). The string form was silently dropping every field, so
    // edit_file reported "old_text is required" on a correct call.
    #[test]
    fn normalize_tool_arguments_handles_stringified_payloads() {
        // A native object passes through unchanged.
        let obj = serde_json::json!({"old_text": "a", "new_text": "b"});
        assert_eq!(normalize_tool_arguments(&obj), obj);
        // A JSON-encoded string is parsed back into an object, so field lookups
        // resolve instead of reading null.
        let stringified = serde_json::json!("{\"old_text\":\"a\",\"new_text\":\"b\"}");
        assert_eq!(normalize_tool_arguments(&stringified), obj);
        assert_eq!(normalize_tool_arguments(&stringified)["old_text"], "a");
        // HTML-with-quotes content (the reported failing case) round-trips.
        let html = serde_json::json!("{\"old_text\":\"<p><strong>Test</strong></p>\"}");
        assert_eq!(
            normalize_tool_arguments(&html)["old_text"],
            "<p><strong>Test</strong></p>"
        );
        // A fenced string payload is still recovered.
        let fenced = serde_json::json!("```json\n{\"old_text\":\"a\"}\n```");
        assert_eq!(normalize_tool_arguments(&fenced)["old_text"], "a");
        // Garbage that can't parse is preserved verbatim rather than lost.
        let junk = serde_json::json!("not json");
        assert_eq!(normalize_tool_arguments(&junk), junk);
    }

    // ADD-29: the parity net — a model that leaks tool calls inline as
    // `<tool_call>…</tool_call>` text must still drive the tool loop. Verify
    // the calls are recovered and stripped from the visible answer.
    #[test]
    fn parse_inline_tool_calls_recovers_and_strips() {
        let text = "Let me look.\n<tool_call>{\"name\": \"read_text\", \
                    \"arguments\": {\"offset\": 0, \"limit\": 500}}</tool_call>\nDone.";
        let (cleaned, calls) = parse_inline_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_text");
        assert_eq!(calls[0].arguments["offset"], 0);
        assert_eq!(calls[0].arguments["limit"], 500);
        assert!(!cleaned.contains("<tool_call>"));
        assert!(cleaned.contains("Let me look."));
        assert!(cleaned.contains("Done."));
    }

    #[test]
    fn parse_inline_tool_calls_handles_multiple_and_openai_shape() {
        // Two calls, one in the {function:{name,arguments}} shape.
        let text = "<tool_call>{\"name\":\"a\",\"arguments\":{\"x\":1}}</tool_call>\
                    <tool_call>{\"function\":{\"name\":\"b\",\"arguments\":\"{\\\"y\\\":2}\"}}</tool_call>";
        let (cleaned, calls) = parse_inline_tool_calls(text);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "a");
        assert_eq!(calls[0].arguments["x"], 1);
        assert_eq!(calls[1].name, "b");
        // Stringified arguments are normalized back to an object.
        assert_eq!(calls[1].arguments["y"], 2);
        assert_eq!(cleaned, "");
    }

    #[test]
    fn parse_inline_tool_calls_ignores_plain_text() {
        let (cleaned, calls) = parse_inline_tool_calls("Just a normal answer, no tools.");
        assert!(calls.is_empty());
        assert_eq!(cleaned, "Just a normal answer, no tools.");
    }
}
