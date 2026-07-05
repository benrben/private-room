//! ADD-20: Room MCP bridge — the room's agent tools, served to cloud CLIs.
//!
//! The local model gets file abilities through `agent_loop`'s tool calls;
//! `claude -p` is a one-shot text pipe and gets none. This bridge closes that
//! gap the architecturally honest way: a token-guarded, loopback-only MCP
//! endpoint (streamable HTTP, JSON-RPC) that executes the SAME `exec_tool`
//! dispatch the local agent uses — decryption stays inside this process; only
//! tool RESULTS cross to the cloud, exactly like chat content already does.
//!
//! Lifetime = one `ask`: started right before the CLI spawns, stopped when it
//! returns. A fresh bearer token per run; requests without it are rejected.
//! If the room closes mid-run, `exec_tool` itself errors ("No room is open"),
//! so a stale CLI can never read a locked room.

use std::collections::HashSet;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::commands;

pub struct Bridge {
    pub port: u16,
    pub token: String,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl Bridge {
    /// The `--mcp-config` JSON handed to the CLI: one HTTP server, loopback,
    /// bearer-token header.
    pub fn mcp_config_json(&self) -> String {
        serde_json::json!({
            "mcpServers": {
                "room": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp", self.port),
                    "headers": { "Authorization": format!("Bearer {}", self.token) }
                }
            }
        })
        .to_string()
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Bind 127.0.0.1:ephemeral and serve MCP until `stop()`.
///
/// `include_mcp` (ADD-21): when true the bridge also advertises the room's
/// connected MCP tools, so a consulted cloud advisor can reach them — gated by
/// the advisor sub-option. The top-level cloud-engine path passes false.
pub async fn start(
    app: tauri::AppHandle,
    web_enabled: bool,
    include_mcp: bool,
) -> Result<Bridge, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("mcp bridge bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let tok = token.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let app = app.clone();
                    let tok = tok.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_conn(stream, app, tok, web_enabled, include_mcp).await;
                    });
                }
            }
        }
    });
    Ok(Bridge { port, token, shutdown: tx })
}

/// Serve HTTP/1.1 requests on one connection until the peer hangs up. Only
/// what the MCP client actually sends is implemented: POST /mcp with a
/// Content-Length JSON-RPC body (a GET — the optional SSE channel — gets 405).
async fn handle_conn(
    mut stream: TcpStream,
    app: tauri::AppHandle,
    token: String,
    web_enabled: bool,
    include_mcp: bool,
) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    loop {
        // ---- read one request: head, then exactly Content-Length body bytes.
        let head_end = loop {
            if let Some(pos) = find_head_end(&buf) {
                break pos;
            }
            let mut chunk = [0u8; 4096];
            let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Ok(()); // peer closed between requests
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 4 * 1024 * 1024 {
                return Err("request too large".into());
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let body_start = head_end + 4;
        let content_len = header_value(&head, "content-length")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        while buf.len() < body_start + content_len {
            let mut chunk = [0u8; 4096];
            let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("truncated body".into());
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = buf[body_start..body_start + content_len].to_vec();
        buf.drain(..body_start + content_len);

        // ---- auth + method gate
        let authed = header_value(&head, "authorization")
            .map(|v| v.trim() == format!("Bearer {token}"))
            .unwrap_or(false);
        if !authed {
            write_response(&mut stream, 401, b"{}").await?;
            continue;
        }
        if !head.starts_with("POST ") {
            write_response(&mut stream, 405, b"{}").await?;
            continue;
        }

        // ---- JSON-RPC dispatch
        let req: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => {
                write_response(&mut stream, 400, b"{}").await?;
                continue;
            }
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if id.is_none() {
            // Notifications (e.g. notifications/initialized) need no body.
            write_response(&mut stream, 202, b"").await?;
            continue;
        }
        let result = match method {
            "initialize" => Ok(serde_json::json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "private-room", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Ok(serde_json::json!({})),
            "tools/list" => {
                Ok(serde_json::json!({ "tools": served_tools(&app, web_enabled, include_mcp) }))
            }
            "tools/call" => tool_call(&app, &req["params"], web_enabled, include_mcp).await,
            _ => Err(format!("method not found: {method}")),
        };
        let reply = match result {
            Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(msg) => serde_json::json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": msg }
            }),
        };
        write_response(&mut stream, 200, reply.to_string().as_bytes()).await?;
    }
}

/// Translate one Ollama-shaped `{"function": {...}}` spec to an MCP tool record.
fn to_mcp_tool(t: &serde_json::Value) -> Option<serde_json::Value> {
    let f = t.get("function")?;
    Some(serde_json::json!({
        "name": f.get("name")?,
        "description": f.get("description").cloned().unwrap_or_default(),
        "inputSchema": f.get("parameters").cloned()
            .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}})),
    }))
}

/// The built-in room catalog translated to MCP tool records. Same source of
/// truth as the local agent (`tools_catalog`), so the two engines can never
/// drift apart. Pure — this is what the tests exercise.
fn builtin_mcp_tools(web_enabled: bool) -> Vec<serde_json::Value> {
    commands::tools_catalog(web_enabled)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(to_mcp_tool)
        .collect()
}

/// The full list served over the bridge: the built-ins, plus (ADD-21, when the
/// advisor sub-option is on) the room's connected MCP tools, so a consulted
/// advisor can drive them too. Never includes `consult_advisor` itself — that
/// tool lives outside `tools_catalog` by design, closing the recursion path.
fn served_tools(
    app: &tauri::AppHandle,
    web_enabled: bool,
    include_mcp: bool,
) -> Vec<serde_json::Value> {
    use tauri::Manager;
    let mut list = builtin_mcp_tools(web_enabled);
    if include_mcp {
        let state = app.state::<commands::AppState>();
        let (routes, _omitted) = commands::mcp_routes(&state);
        for r in &routes {
            if let Some(rec) = to_mcp_tool(&r.spec) {
                list.push(rec);
            }
        }
    }
    list
}

/// Execute one tool through the room's own dispatch. Tool errors come back as
/// MCP `isError` results (the model can react), not JSON-RPC failures.
async fn tool_call(
    app: &tauri::AppHandle,
    params: &serde_json::Value,
    web_enabled: bool,
    include_mcp: bool,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("tools/call without a name")?
        .to_string();
    // Only tools we actually advertise are callable. By default that's the
    // built-in room catalog; with `include_mcp` (the advisor sub-option) it also
    // includes the room's connected MCP servers. `consult_advisor` is never in
    // either set, so an advisor can never spawn another cloud CLI.
    if !served_tools(app, web_enabled, include_mcp)
        .iter()
        .any(|t| t["name"].as_str() == Some(&name))
    {
        return Err(format!("unknown tool: {name}"));
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let call = crate::ollama::ToolCall {
        name,
        arguments,
        raw: serde_json::json!({}),
    };
    let window = app
        .get_webview_window("main")
        .ok_or("main window is gone")?
        .as_ref()
        .window();
    let state = app.state::<commands::AppState>();
    let mut effects = commands::ToolEffects::default();
    // Connected MCP tools are dispatched through the same routes the local agent
    // uses; empty unless the advisor sub-option is on. No cancel flag here — the
    // parent consult's own cancel already kills this whole CLI on Stop.
    let routes = if include_mcp {
        commands::mcp_routes(&state).0
    } else {
        Vec::new()
    };
    // No advisor bridge here: consult_advisor is never served over the bridge,
    // so the advisor path cannot re-enter through this dispatch.
    let outcome =
        commands::exec_tool(&state, &window, &call, &mut effects, &routes, &HashSet::new(), None, None)
            .await;
    Ok(match outcome {
        Ok(text) => serde_json::json!({
            "content": [{ "type": "text", "text": text }],
            "isError": false
        }),
        Err(msg) => serde_json::json!({
            "content": [{ "type": "text", "text": msg }],
            "isError": true
        }),
    })
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

async fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(body).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_end_and_headers() {
        let raw = b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\nAuthorization: Bearer abc\r\n\r\n{}";
        let end = find_head_end(raw).unwrap();
        let head = std::str::from_utf8(&raw[..end]).unwrap();
        assert_eq!(header_value(head, "content-length"), Some("2"));
        assert_eq!(header_value(head, "authorization"), Some("Bearer abc"));
        assert_eq!(header_value(head, "x-missing"), None);
    }

    #[test]
    fn catalog_translates_to_mcp_shape() {
        let tools = builtin_mcp_tools(false);
        assert!(tools.iter().any(|t| t["name"] == "list_room_files"));
        assert!(tools.iter().any(|t| t["name"] == "search_room"));
        let open = tools.iter().find(|t| t["name"] == "open_file").unwrap();
        assert!(open["inputSchema"]["properties"]["name"].is_object());
        // web tools appear only when web access is on
        assert!(!tools.iter().any(|t| t["name"] == "web_search"));
        assert!(builtin_mcp_tools(true).iter().any(|t| t["name"] == "web_search"));
        // ADD-21: the advisor tool is NOT in the bridge catalog — a consulted
        // cloud CLI must never be handed a tool that spawns another one.
        assert!(!tools.iter().any(|t| t["name"] == "consult_advisor"));
    }
}
