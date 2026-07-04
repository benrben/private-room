use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "http://127.0.0.1:11434";

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
pub async fn chat_stream_tools(
    model: &str,
    messages: Vec<ChatMessage>,
    tools: Option<&serde_json::Value>,
    temperature: Option<f64>,
    cancel: Option<Arc<AtomicBool>>,
    mut on_delta: impl FnMut(&str),
) -> Result<(String, Vec<ToolCall>), String> {
    use futures_util::StreamExt;

    // Tool catalogs and tool results (search hits, fetched pages) need more
    // room than plain chat, but stay far below the model-declared maximums
    // that OOM 16 GB machines.
    let num_ctx = if tools.is_some() { 12288 } else { 8192 };
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
        // Keep the model resident so follow-up questions don't pay the
        // multi-second load cost again.
        "keep_alive": "30m",
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
    // Qwen3 thinking variants burn thousands of hidden reasoning tokens
    // (measured: 90s for a one-line answer). Instruct variants don't think
    // and reject the flag, so only send it to the thinking ones.
    if model.contains("qwen3") && !model.contains("instruct") {
        body["think"] = serde_json::Value::Bool(false);
    }
    let resp = client()?
        .post(format!("{BASE_URL}/api/chat"))
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
                            arguments: c["function"]["arguments"].clone(),
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
    Ok((full, tool_calls))
}

/// Load a model into memory without generating anything, so the first real
/// request is fast. Fire-and-forget.
pub async fn warm(model: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "model": model,
        "keep_alive": "30m",
        "options": { "num_ctx": 8192 },
    });
    client()?
        .post(format!("{BASE_URL}/api/generate"))
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
    let resp = client
        .post(format!("{BASE_URL}/api/pull"))
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
        .delete(format!("{BASE_URL}/api/delete"))
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
        .get(format!("{BASE_URL}/api/tags"))
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
