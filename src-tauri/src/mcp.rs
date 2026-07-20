//! Minimal MCP (Model Context Protocol) client — two transports.
//!
//! A configured server is reached one of two ways:
//! - **Stdio**: a child process speaking newline-delimited JSON-RPC 2.0 on
//!   stdin/stdout — the same framing style we already parse for Ollama. Runs on
//!   this Mac.
//! - **Http** (Wave "marketplace"): a *remote* server reached over streamable
//!   HTTP (JSON-RPC POST, JSON or `text/event-stream` reply). This one leaves
//!   the Mac, so the UI badges it loudly and the SEC-1 gate still asks first.
//!
//! We implement just the client half we need: initialize, tools/list and
//! tools/call. Remote auth is header-based for now (a `Bearer` token pasted in
//! `headers`); interactive OAuth is a later phase that will populate the same
//! header slot.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

const PROTOCOL_VERSION: &str = "2025-06-18";
/// First connect may run `uvx`/`npx`, which downloads the server package.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// Web searches and page fetches are legitimately slow.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);

// ------------------------------------------------------------------ config

/// How a configured server is reached. `disabled` lives on [`ServerConfig`]
/// because it is transport-independent.
#[derive(Clone, Debug)]
pub enum Transport {
    /// A local child process (stdio JSON-RPC). Runs on this Mac.
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    /// A remote HTTP(S) endpoint (streamable HTTP JSON-RPC). Reaches the
    /// internet — every call leaves the Mac.
    Http {
        url: String,
        /// Static headers sent on every request (e.g. `Authorization: Bearer …`).
        headers: HashMap<String, String>,
    },
}

impl Transport {
    /// True for a remote endpoint — the seam where room data leaves the Mac.
    pub fn is_remote(&self) -> bool {
        matches!(self, Transport::Http { .. })
    }
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub transport: Transport,
    pub disabled: bool,
}

/// Parse the de-facto standard `{"mcpServers": {name: {…}}}` format used by
/// Claude Desktop and Cursor, so users can paste configs straight from any MCP
/// server's README. Two server shapes are accepted:
/// - **local**: `{"command": "uvx", "args": [...], "env": {...}}`
/// - **remote**: `{"type": "http", "url": "https://…", "headers": {...}}`
///   (`type` is optional — a bare `"url"` is enough to mark it remote).
/// Extra key we accept on either: `"disabled"`.
pub fn parse_config(json: &str) -> Result<Vec<(String, ServerConfig)>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Config is not valid JSON: {e}"))?;
    let servers = v
        .get("mcpServers")
        .and_then(|s| s.as_object())
        .ok_or("Config needs a top-level \"mcpServers\" object.")?;
    let mut out = Vec::new();
    for (name, s) in servers {
        let disabled = s["disabled"].as_bool().unwrap_or(false);
        // Remote if it declares an http/https type OR simply carries a url. A
        // `"command"` present alongside a url still means remote — the url wins,
        // matching how Claude Desktop treats `"type": "http"`.
        let ty = s["type"].as_str().unwrap_or("");
        let has_url = s["url"].is_string();
        let transport = if ty == "http" || ty == "streamable-http" || ty == "sse" || has_url {
            let url = s["url"]
                .as_str()
                .ok_or_else(|| format!("Remote server \"{name}\" is missing \"url\"."))?
                .to_string();
            let headers = string_map(&s["headers"]);
            Transport::Http { url, headers }
        } else {
            let command = s["command"]
                .as_str()
                .ok_or_else(|| {
                    format!("Server \"{name}\" needs a \"command\" (local) or a \"url\" (remote).")
                })?
                .to_string();
            let args = s["args"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let env = string_map(&s["env"]);
            Transport::Stdio { command, args, env }
        };
        out.push((name.clone(), ServerConfig { transport, disabled }));
    }
    Ok(out)
}

/// A JSON object of `{string: string}`, dropping non-string values. Shared by
/// `env` (stdio) and `headers` (http) parsing.
fn string_map(v: &serde_json::Value) -> HashMap<String, String> {
    v.as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Ollama tool names must stay plain for small local models: keep
/// `[a-zA-Z0-9_]`, replace the rest.
pub fn sanitize_tool_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect()
}

// ------------------------------------------------------------------- state

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Connecting,
    Connected,
    Failed,
    Disabled,
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

pub struct Server {
    pub name: String,
    pub status: Status,
    pub error: Option<String>,
    pub tools: Vec<Tool>,
    /// True when this server is reached over the network (Transport::Http) — the
    /// UI badges it and the outbound-redaction seam keys off it.
    pub remote: bool,
    pub client: Option<Arc<tokio::sync::Mutex<Client>>>,
}

/// Lives in AppState behind a std Mutex — hold it only briefly, never
/// across an await. Long tool calls lock the per-server client instead.
#[derive(Default)]
pub struct Manager {
    pub servers: Vec<Server>,
    /// Bumped on every config apply so stale background connects from a
    /// previous config can tell they lost the race and discard themselves.
    pub generation: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub name: String,
    pub status: Status,
    pub error: Option<String>,
    pub tools: Vec<String>,
    /// Surfaced to the UI so a connected server still reads as local vs remote.
    pub remote: bool,
}

impl Manager {
    pub fn statuses(&self) -> Vec<ServerStatus> {
        self.servers
            .iter()
            .map(|s| ServerStatus {
                name: s.name.clone(),
                status: s.status.clone(),
                error: s.error.clone(),
                tools: s.tools.iter().map(|t| t.name.clone()).collect(),
                remote: s.remote,
            })
            .collect()
    }
}

// ------------------------------------------------------------------ client

/// A connected client, over whichever transport its config chose. The public
/// surface (`connect`, `call_tool`) is transport-agnostic so callers in
/// `mcp_cmds`/`agent` never branch on it.
pub enum Client {
    Stdio(StdioClient),
    Http(HttpClient),
}

impl Client {
    /// Spawn/open the server, run the initialize handshake and list its tools.
    pub async fn connect(config: &ServerConfig) -> Result<(Self, Vec<Tool>), String> {
        match &config.transport {
            Transport::Stdio { command, args, env } => {
                let (c, tools) = StdioClient::connect(command, args, env).await?;
                Ok((Client::Stdio(c), tools))
            }
            Transport::Http { url, headers } => {
                let (c, tools) = HttpClient::connect(url, headers).await?;
                Ok((Client::Http(c), tools))
            }
        }
    }

    /// Call a tool and flatten its content blocks into plain text.
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<String, String> {
        match self {
            Client::Stdio(c) => c.call_tool(name, arguments).await,
            Client::Http(c) => c.call_tool(name, arguments).await,
        }
    }
}

/// Normalize a `tools/call` result into plain text (or an `Err` when the tool
/// reported `isError`). Shared by both transports — non-text blocks are noted,
/// `structuredContent` is a fallback, and empty output becomes `(no output)`.
fn flatten_call_result(result: &serde_json::Value) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for block in result["content"].as_array().unwrap_or(&Vec::new()) {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(t) = block["text"].as_str() {
                    parts.push(t.to_string());
                }
            }
            Some(other) => parts.push(format!("[{other} content omitted]")),
            None => {}
        }
    }
    if parts.is_empty() {
        if let Some(s) = result.get("structuredContent") {
            parts.push(s.to_string());
        }
    }
    let text = parts.join("\n");
    if result["isError"].as_bool().unwrap_or(false) {
        return Err(if text.is_empty() { "Tool failed.".into() } else { text });
    }
    Ok(if text.is_empty() { "(no output)".into() } else { text })
}

/// Collect `tools/list` records (one page) into `Tool`s. Shared by both
/// transports; returns the `nextCursor` for pagination.
fn collect_tools(result: &serde_json::Value, into: &mut Vec<Tool>) -> Option<String> {
    for t in result["tools"].as_array().unwrap_or(&Vec::new()) {
        if let Some(name) = t["name"].as_str() {
            into.push(Tool {
                name: name.to_string(),
                description: t["description"].as_str().unwrap_or("").to_string(),
                schema: if t["inputSchema"].is_object() {
                    t["inputSchema"].clone()
                } else {
                    serde_json::json!({"type": "object", "properties": {}})
                },
            });
        }
    }
    result["nextCursor"].as_str().map(String::from)
}

/// GUI apps on macOS get a bare PATH, so `npx`/`uvx` from a server config
/// would not be found. Ask a login shell once, like detect_external does.
fn login_shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let from_shell = std::process::Command::new("zsh")
            .args(["-lc", "printf %s \"$PATH\""])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let inherited = std::env::var("PATH").unwrap_or_default();
        // Well-known tool homes login shells often miss: uv installs to
        // ~/.local/bin (via .zshrc only, which -lc doesn't source).
        let home = std::env::var("HOME").unwrap_or_default();
        format!(
            "{from_shell}:{inherited}:/opt/homebrew/bin:/usr/local/bin:\
             {home}/.local/bin:{home}/.cargo/bin"
        )
    })
}

// ------------------------------------------------------------- stdio client

pub struct StdioClient {
    _child: Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
    /// Tail of the server's stderr, for useful error messages when it dies.
    stderr_tail: Arc<Mutex<String>>,
    next_id: u64,
}

impl StdioClient {
    /// Spawn the server, run the initialize handshake and list its tools.
    async fn connect(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<(Self, Vec<Tool>), String> {
        // Resolving PATH shells out; keep it off the async runtime.
        let path = tokio::task::spawn_blocking(login_shell_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut child = tokio::process::Command::new(command)
            .args(args)
            .envs(env)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start \"{command}\": {e}"))?;

        let stdin = child.stdin.take().ok_or("No stdin pipe.")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("No stdout pipe.")?).lines();
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut t = tail.lock().unwrap();
                    t.push_str(&line);
                    t.push('\n');
                    let len = t.len();
                    if len > 2000 {
                        *t = t[len - 2000..].to_string();
                    }
                }
            });
        }

        let mut client = StdioClient {
            _child: child,
            stdin,
            stdout,
            stderr_tail,
            next_id: 0,
        };

        client
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "Arcelle", "version": env!("CARGO_PKG_VERSION")},
                }),
                CONNECT_TIMEOUT,
            )
            .await?;
        client
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;

        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => serde_json::json!({"cursor": c}),
                None => serde_json::json!({}),
            };
            let result = client.request("tools/list", params, CONNECT_TIMEOUT).await?;
            cursor = collect_tools(&result, &mut tools);
            if cursor.is_none() {
                break;
            }
        }
        Ok((client, tools))
    }

    /// Call a tool and flatten its content blocks into plain text.
    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<String, String> {
        let args = if arguments.is_object() {
            arguments.clone()
        } else {
            serde_json::json!({})
        };
        let result = self
            .request(
                "tools/call",
                serde_json::json!({"name": name, "arguments": args}),
                CALL_TIMEOUT,
            )
            .await?;
        flatten_call_result(&result)
    }

    async fn send(&mut self, msg: &serde_json::Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Server stdin closed: {e}"))
    }

    async fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.send(&serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    /// Send a request and read lines until its response arrives. Server
    /// notifications are ignored; server→client requests get a stub reply
    /// so well-behaved servers don't hang (pings get a real pong).
    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }))
        .await?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let line = tokio::time::timeout_at(deadline, self.stdout.next_line())
                .await
                .map_err(|_| format!("Server timed out on {method}."))?
                .map_err(|e| format!("Server stdout failed: {e}"))?
                .ok_or_else(|| {
                    let tail = self.stderr_tail.lock().unwrap().trim().to_string();
                    if tail.is_empty() {
                        "Server exited.".to_string()
                    } else {
                        format!("Server exited: {tail}")
                    }
                })?;
            let v: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(_) => continue, // servers sometimes log to stdout — skip
            };
            if v["id"].as_u64() == Some(id) && v.get("method").is_none() {
                if let Some(err) = v.get("error") {
                    let msg = err["message"].as_str().unwrap_or("unknown error");
                    return Err(format!("{method} failed: {msg}"));
                }
                return Ok(v["result"].clone());
            }
            if let (Some(their_id), Some(their_method)) = (v.get("id"), v["method"].as_str()) {
                let reply = if their_method == "ping" {
                    serde_json::json!({"jsonrpc": "2.0", "id": their_id, "result": {}})
                } else {
                    serde_json::json!({"jsonrpc": "2.0", "id": their_id,
                        "error": {"code": -32601, "message": "Not supported by this client."}})
                };
                self.send(&reply).await?;
            }
        }
    }
}

// -------------------------------------------------------------- http client

/// A remote MCP server reached over streamable HTTP (JSON-RPC POST). The reply
/// is either `application/json` (one response) or `text/event-stream` (SSE
/// frames) — we accept both. A server may hand back an `Mcp-Session-Id` on
/// `initialize`; we echo it on every later request.
pub struct HttpClient {
    http: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    session_id: Option<String>,
    next_id: u64,
}

impl HttpClient {
    async fn connect(
        url: &str,
        headers: &HashMap<String, String>,
    ) -> Result<(Self, Vec<Tool>), String> {
        // rustls, not macOS native-tls: hosted MCP servers (GitHub, Notion, …)
        // are HTTP/2 and native-tls's ALPN doesn't reliably negotiate h2, which
        // surfaces as "error sending request". rustls does.
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .user_agent(concat!("Arcelle/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("Could not build HTTP client: {e}"))?;
        let mut client = HttpClient {
            http,
            url: url.to_string(),
            headers: headers.clone(),
            session_id: None,
            next_id: 0,
        };
        client
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "Arcelle", "version": env!("CARGO_PKG_VERSION")},
                }),
                CONNECT_TIMEOUT,
            )
            .await?;
        client
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;

        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => serde_json::json!({"cursor": c}),
                None => serde_json::json!({}),
            };
            let result = client.request("tools/list", params, CONNECT_TIMEOUT).await?;
            cursor = collect_tools(&result, &mut tools);
            if cursor.is_none() {
                break;
            }
        }
        Ok((client, tools))
    }

    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<String, String> {
        let args = if arguments.is_object() {
            arguments.clone()
        } else {
            serde_json::json!({})
        };
        let result = self
            .request(
                "tools/call",
                serde_json::json!({"name": name, "arguments": args}),
                CALL_TIMEOUT,
            )
            .await?;
        flatten_call_result(&result)
    }

    /// POST one JSON body, applying the configured headers, the protocol
    /// version, and the captured session id. On the way back we capture any
    /// `Mcp-Session-Id` the server assigns and any `WWW-Authenticate` header (an
    /// OAuth challenge — it tells us "sign in" vs "your token is wrong").
    async fn post(
        &mut self,
        body: &serde_json::Value,
        timeout: Duration,
    ) -> Result<(reqwest::StatusCode, String, String, Option<String>), String> {
        let mut req = self
            .http
            .post(&self.url)
            .timeout(timeout)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION);
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid);
        }
        let resp = req.json(body).send().await.map_err(|e| {
            if e.is_timeout() {
                "Remote server timed out.".to_string()
            } else if e.is_connect() {
                format!("Could not reach the remote server: {e}")
            } else {
                format!("Request failed: {e}")
            }
        })?;
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(sid.to_string());
        }
        let status = resp.status();
        let ctype = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let www_authenticate = resp
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let text = resp.text().await.map_err(|e| e.to_string())?;
        Ok((status, ctype, text, www_authenticate))
    }

    async fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let (status, _ct, _body, www) = self
            .post(
                &serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params}),
                CONNECT_TIMEOUT,
            )
            .await?;
        // 200 or 202 (Accepted, empty body) are both fine for a notification.
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(auth_error_message(method, status.as_u16(), www.as_deref()));
        }
        Ok(())
    }

    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let (status, ctype, text, www) = self
            .post(
                &serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
                timeout,
            )
            .await?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(auth_error_message(method, status.as_u16(), www.as_deref()));
        }
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            return Err(format!("{method}: remote server returned HTTP {} {snippet}", status.as_u16()));
        }
        let msg = parse_http_message(&ctype, &text, id)
            .ok_or_else(|| format!("{method}: no JSON-RPC response in the reply"))?;
        if let Some(err) = msg.get("error").filter(|e| !e.is_null()) {
            let m = err["message"].as_str().unwrap_or("unknown error");
            return Err(format!("{method} failed: {m}"));
        }
        Ok(msg["result"].clone())
    }
}

/// The message shown when a remote server answers with 401/403. An OAuth
/// challenge (a `WWW-Authenticate` header, RFC 9728) means "sign in" — telling
/// the user to "check the token in this connector's headers" when the connector
/// actually uses OAuth is the confusing case we hit in the wild. A bare 401 with
/// no challenge really is a bad/missing token. Pure — unit-tested.
fn auth_error_message(method: &str, status: u16, www_authenticate: Option<&str>) -> String {
    if www_authenticate.is_some() {
        format!(
            "{method}: this connector needs you to sign in (HTTP {status}). \
             Open it under Connectors and click \u{201c}Connect account\u{201d} to authorize."
        )
    } else {
        format!(
            "{method}: the remote server rejected the request (HTTP {status}). \
             This connector needs a valid token — add one under its auth headers, \
             or use \u{201c}Connect account\u{201d} if it supports sign-in."
        )
    }
}

/// Pull the JSON-RPC response with id `id` out of an HTTP reply body — either a
/// plain JSON object or an SSE stream of `data:` frames (streamable HTTP). Pure,
/// so it is unit-tested without a network.
fn parse_http_message(ctype: &str, body: &str, id: u64) -> Option<serde_json::Value> {
    if ctype.contains("text/event-stream") || body.trim_start().starts_with("event:") {
        // SSE: scan `data:` payloads for the response that carries our id.
        for line in body.lines() {
            let line = line.trim_start();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if v.get("method").is_none() && v["id"].as_u64() == Some(id) {
                    return Some(v);
                }
            }
        }
        None
    } else {
        let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(cfg: &ServerConfig) -> (&str, &[String], &HashMap<String, String>) {
        match &cfg.transport {
            Transport::Stdio { command, args, env } => (command.as_str(), args, env),
            Transport::Http { .. } => panic!("expected a stdio transport"),
        }
    }

    #[test]
    fn parses_standard_local_config() {
        let cfg = parse_config(
            r#"{"mcpServers": {"web": {"command": "uvx",
                "args": ["duckduckgo-mcp-server"],
                "env": {"DDG_REGION": "us-en"}, "disabled": true}}}"#,
        )
        .unwrap();
        assert_eq!(cfg.len(), 1);
        let (name, s) = &cfg[0];
        assert_eq!(name, "web");
        assert!(s.disabled);
        assert!(!s.transport.is_remote());
        let (command, args, env) = stdio(s);
        assert_eq!(command, "uvx");
        assert_eq!(args, ["duckduckgo-mcp-server"]);
        assert_eq!(env["DDG_REGION"], "us-en");
    }

    #[test]
    fn parses_remote_http_config() {
        // The marketplace's remote shape: type=http + url + auth headers.
        let cfg = parse_config(
            r#"{"mcpServers": {"gh": {"type": "http",
                "url": "https://api.githubcopilot.com/mcp/",
                "headers": {"Authorization": "Bearer tok123"}}}}"#,
        )
        .unwrap();
        let (name, s) = &cfg[0];
        assert_eq!(name, "gh");
        assert!(!s.disabled);
        assert!(s.transport.is_remote());
        match &s.transport {
            Transport::Http { url, headers } => {
                assert_eq!(url, "https://api.githubcopilot.com/mcp/");
                assert_eq!(headers["Authorization"], "Bearer tok123");
            }
            _ => panic!("expected http"),
        }
    }

    #[test]
    fn bare_url_is_remote_even_without_type() {
        // A `url` with no `type` is still remote — Arcelle's own Leash
        // config (room_mcp::mcp_config_json) uses `type: http` + url, but many
        // READMEs omit the type.
        let cfg = parse_config(r#"{"mcpServers": {"x": {"url": "https://ex.com/mcp"}}}"#).unwrap();
        assert!(cfg[0].1.transport.is_remote());
    }

    #[test]
    fn rejects_bad_config() {
        assert!(parse_config("not json").is_err());
        assert!(parse_config(r#"{"servers": {}}"#).is_err());
        // Neither command nor url → error naming both options.
        assert!(parse_config(r#"{"mcpServers": {"x": {"args": []}}}"#).is_err());
        // Declared http but no url.
        assert!(parse_config(r#"{"mcpServers": {"x": {"type": "http"}}}"#).is_err());
    }

    #[test]
    fn sanitizes_tool_names() {
        assert_eq!(sanitize_tool_name("fetch-page.v2"), "fetch_page_v2");
        assert_eq!(sanitize_tool_name("search"), "search");
    }

    #[test]
    fn flattens_tool_result_variants() {
        // text blocks joined; non-text noted; isError → Err; empty → (no output).
        let ok = serde_json::json!({"content": [{"type": "text", "text": "hello"},
            {"type": "image", "data": "…"}]});
        assert_eq!(flatten_call_result(&ok).unwrap(), "hello\n[image content omitted]");
        let err = serde_json::json!({"content": [{"type": "text", "text": "boom"}], "isError": true});
        assert_eq!(flatten_call_result(&err).unwrap_err(), "boom");
        let empty = serde_json::json!({"content": []});
        assert_eq!(flatten_call_result(&empty).unwrap(), "(no output)");
        let structured = serde_json::json!({"content": [], "structuredContent": {"n": 1}});
        assert_eq!(flatten_call_result(&structured).unwrap(), r#"{"n":1}"#);
    }

    #[test]
    fn auth_error_distinguishes_signin_from_bad_token() {
        // An OAuth challenge (WWW-Authenticate present) → guide to sign-in, and
        // must NOT tell the user to fix a header token (the confusing case).
        let signin = auth_error_message("initialize", 401, Some(r#"Bearer resource_metadata="…""#));
        assert!(signin.contains("sign in"));
        assert!(signin.contains("Connect account"));
        assert!(!signin.contains("valid token"));
        // A bare 401 (no challenge) really is a bad/missing token.
        let bad = auth_error_message("initialize", 401, None);
        assert!(bad.contains("valid token"));
        assert!(bad.contains("401"));
    }

    #[test]
    fn parses_json_and_sse_http_replies() {
        // Plain JSON reply.
        let json = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        let m = parse_http_message("application/json", json, 7).unwrap();
        assert_eq!(m["result"]["ok"], true);
        // SSE reply: skip a notification frame, match our id in a later frame.
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n\n\
                   event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":1}}\n\n";
        let m = parse_http_message("text/event-stream", sse, 7).unwrap();
        assert_eq!(m["result"]["ok"], 1);
        // Wrong id → nothing.
        assert!(parse_http_message("text/event-stream", sse, 99).is_none());
    }
}
