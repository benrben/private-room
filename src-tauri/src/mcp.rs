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

/// A stable fingerprint of ONE server's transport — everything that decides
/// where a call goes and how. Two configs with the same key reach the same
/// place the same way, so an already-connected client can be carried across a
/// config apply instead of being torn down and dialled again. Without it,
/// flipping one connector's switch restarted every other connector. Pure —
/// unit-tested.
pub fn config_key(cfg: &ServerConfig) -> String {
    fn pairs(map: &HashMap<String, String>) -> String {
        let mut kv: Vec<String> = map.iter().map(|(k, v)| format!("{k}={v}")).collect();
        kv.sort(); // HashMap order is not stable; the key must be
        kv.join("\u{1e}")
    }
    match &cfg.transport {
        Transport::Stdio { command, args, env } => format!(
            "stdio\u{1f}{command}\u{1f}{}\u{1f}{}",
            args.join("\u{1e}"),
            pairs(env)
        ),
        Transport::Http { url, headers } => format!("http\u{1f}{url}\u{1f}{}", pairs(headers)),
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
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let env = string_map(&s["env"]);
            Transport::Stdio { command, args, env }
        };
        out.push((
            name.clone(),
            ServerConfig {
                transport,
                disabled,
            },
        ));
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
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
    /// Standard MCP safety hints supplied by the connector. The room bridge
    /// preserves these when it re-exports connected tools to an external
    /// agent; without them non-interactive Codex rejects even read-only calls.
    pub annotations: Option<serde_json::Value>,
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
    /// [`config_key`] of the config this entry was built from, so a later apply
    /// can tell "same server, untouched" from "same name, different target".
    pub config_key: String,
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

    /// Call a tool and normalize its content blocks (text plus any pictures).
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<ToolOutput, String> {
        match self {
            Client::Stdio(c) => c.call_tool(name, arguments).await,
            Client::Http(c) => c.call_tool(name, arguments).await,
        }
    }
}

/// How many pictures one connector call may hand over. A screenshot tool
/// answers with one; a contact sheet could answer with forty, and every one of
/// them costs a vision round.
const MAX_TOOL_IMAGES: usize = 2;

/// Largest base64 payload accepted for one picture (~3 MB of PNG). Past this a
/// connector is not sending a screenshot, it is sending a file — and the
/// conversation it would land in has a context window.
const MAX_TOOL_IMAGE_B64: usize = 4 * 1024 * 1024;

/// Image MIME types the perception path can actually decode. Anything else is
/// reported as omitted rather than handed on as pixels that will fail later.
const TOOL_IMAGE_MIMES: &[&str] = &["image/png", "image/jpeg", "image/jpg", "image/webp"];

/// What one connector tool call produced.
#[derive(Debug)]
pub struct ToolOutput {
    pub text: String,
    /// Standard base64 (no `data:` prefix) for each usable `image` block, in
    /// the order the server sent them.
    pub images: Vec<String>,
}

/// Normalize a `tools/call` result (or an `Err` when the tool reported
/// `isError`). Shared by both transports — `structuredContent` is a fallback,
/// and empty output becomes `(no output)`.
///
/// `image` blocks are CARRIED, not dropped. A screenshot tool, a chart renderer
/// or a map connector answers with a picture, and flattening it to
/// "[image content omitted]" left the model with nothing to look at — while
/// Arcelle's own room tools pass pixels over this very protocol (`tool_result`
/// in `room_mcp`). Bounded on purpose (count, size, MIME): what a connector
/// sends is not ours to trust, and anything refused is still SAID rather than
/// silently dropped, so the model never treats a picture it did not get as one
/// it did.
fn flatten_call_result(result: &serde_json::Value) -> Result<ToolOutput, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut images: Vec<String> = Vec::new();
    for block in result["content"].as_array().unwrap_or(&Vec::new()) {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(t) = block["text"].as_str() {
                    parts.push(t.to_string());
                }
            }
            Some("image") => {
                let mime = block["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
                let data = block["data"].as_str().unwrap_or("");
                if !TOOL_IMAGE_MIMES.contains(&mime.as_str()) {
                    parts.push(format!("[image omitted: unsupported format \"{mime}\"]"));
                } else if data.len() > MAX_TOOL_IMAGE_B64 {
                    parts.push("[image omitted: too large to attach]".to_string());
                } else if images.len() >= MAX_TOOL_IMAGES {
                    parts.push("[further images omitted]".to_string());
                } else {
                    images.push(data.to_string());
                }
            }
            // An embedded resource CARRIES its payload: `text` for a text
            // resource, base64 `blob` for a binary one. Flattening it to
            // "[resource content omitted]" threw away the very answer — the
            // reference `server-everything` and several docs/git servers reply
            // this way, and the model was told the connector returned nothing.
            Some("resource") => {
                let resource = &block["resource"];
                let uri = resource["uri"].as_str().unwrap_or("");
                let named = if uri.is_empty() { "resource" } else { uri };
                if let Some(text) = resource["text"].as_str() {
                    parts.push(text.to_string());
                } else if resource["blob"].is_string() {
                    let mime = resource["mimeType"].as_str().unwrap_or("unknown type");
                    parts.push(format!("[binary resource omitted: {named} ({mime})]"));
                } else {
                    parts.push(format!("[resource omitted: {named} carried no content]"));
                }
            }
            // A link has no payload of its own; its uri IS the content.
            Some("resource_link") => match block["uri"].as_str() {
                Some(uri) if !uri.is_empty() => parts.push(format!("[resource link: {uri}]")),
                _ => parts.push("[resource link omitted: no uri]".to_string()),
            },
            Some(other) => parts.push(format!("[{other} content omitted]")),
            None => {}
        }
    }
    if parts.is_empty() && images.is_empty() {
        if let Some(s) = result.get("structuredContent") {
            parts.push(s.to_string());
        }
    }
    let text = parts.join("\n");
    if result["isError"].as_bool().unwrap_or(false) {
        return Err(if text.is_empty() {
            "Tool failed.".into()
        } else {
            text
        });
    }
    let text = if text.is_empty() && images.is_empty() {
        "(no output)".to_string()
    } else {
        text
    };
    Ok(ToolOutput { text, images })
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
                annotations: t.get("annotations").filter(|v| v.is_object()).cloned(),
            });
        }
    }
    result["nextCursor"].as_str().map(String::from)
}

/// How much of a stdio server's stderr we keep for its error message.
const STDERR_TAIL_MAX: usize = 2000;

/// Append one stderr line to the retained tail, keeping the last
/// [`STDERR_TAIL_MAX`] bytes.
///
/// The trim MUST land on a char boundary. Slicing at a raw byte offset panicked
/// the moment a server logged anything non-ASCII (an accent, an emoji): the
/// reader task died, the tail mutex was left poisoned so the real error message
/// panicked too, and with nothing draining the pipe a chatty child then blocked
/// mid-write — the connector sat on "Connecting…" forever. Pure — unit-tested.
fn push_stderr_line(tail: &mut String, line: &str) {
    tail.push_str(line);
    tail.push('\n');
    if tail.len() > STDERR_TAIL_MAX {
        let mut cut = tail.len() - STDERR_TAIL_MAX;
        while cut < tail.len() && !tail.is_char_boundary(cut) {
            cut += 1;
        }
        *tail = tail[cut..].to_string();
    }
}

/// Lock the stderr tail, tolerating poisoning — a panic anywhere near this
/// buffer must not turn every later error message into a second panic.
fn lock_tail(tail: &Mutex<String>) -> std::sync::MutexGuard<'_, String> {
    tail.lock().unwrap_or_else(|e| e.into_inner())
}

/// GUI apps on macOS get a bare PATH, so `npx`/`uvx` from a server config
/// would not be found. Ask a login shell once, like detect_external does.
pub(crate) fn login_shell_path() -> &'static str {
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
        // A runtime the app downloaded for this user (`commands::runtimes`)
        // lives under the app's data folder, which is on no shell PATH — so
        // without this prefix the download button fetched 45 MB into a folder
        // nothing ever looked in. First, so a provisioned `uvx`/`npx` wins over
        // a broken system one.
        let prefix = crate::commands::cached_path_prefix();
        let path = if prefix.is_empty() {
            path.to_string()
        } else {
            format!("{prefix}:{path}")
        };
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
                    push_stderr_line(&mut lock_tail(&tail), &line);
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
            let result = client
                .request("tools/list", params, CONNECT_TIMEOUT)
                .await?;
            cursor = collect_tools(&result, &mut tools);
            if cursor.is_none() {
                break;
            }
        }
        Ok((client, tools))
    }

    /// Call a tool and normalize its content blocks (text plus any pictures).
    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<ToolOutput, String> {
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
                    let tail = lock_tail(&self.stderr_tail).trim().to_string();
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
            let result = client
                .request("tools/list", params, CONNECT_TIMEOUT)
                .await?;
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
    ) -> Result<ToolOutput, String> {
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
            return Err(format!(
                "{method}: remote server returned HTTP {} {snippet}",
                status.as_u16()
            ));
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
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
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
    fn preserves_tool_annotations_from_connector_catalogs() {
        let page = serde_json::json!({
            "tools": [{
                "name": "lookup",
                "description": "Look something up",
                "inputSchema": {"type": "object", "properties": {}},
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false
                }
            }]
        });
        let mut tools = Vec::new();
        assert!(collect_tools(&page, &mut tools).is_none());
        assert_eq!(tools.len(), 1);
        let annotations = tools[0].annotations.as_ref().unwrap();
        assert_eq!(annotations["readOnlyHint"], true);
        assert_eq!(annotations["destructiveHint"], false);
    }

    #[test]
    fn flattens_tool_result_variants() {
        // text blocks joined; unknown blocks noted; isError → Err; empty → (no output).
        let ok = serde_json::json!({"content": [{"type": "text", "text": "hello"},
            {"type": "audio", "data": "…"}]});
        assert_eq!(
            flatten_call_result(&ok).unwrap().text,
            "hello\n[audio content omitted]"
        );
        let err =
            serde_json::json!({"content": [{"type": "text", "text": "boom"}], "isError": true});
        assert_eq!(flatten_call_result(&err).unwrap_err(), "boom");
        let empty = serde_json::json!({"content": []});
        assert_eq!(flatten_call_result(&empty).unwrap().text, "(no output)");
        let structured = serde_json::json!({"content": [], "structuredContent": {"n": 1}});
        assert_eq!(flatten_call_result(&structured).unwrap().text, r#"{"n":1}"#);
        // An embedded resource's own text is the answer, not something to note
        // as omitted; a blob and a link are named, since neither is readable.
        let embedded = serde_json::json!({"content": [
            {"type": "resource", "resource": {"uri": "file:///x.md",
                "mimeType": "text/plain", "text": "the answer"}}]});
        assert_eq!(flatten_call_result(&embedded).unwrap().text, "the answer");
        let blob = serde_json::json!({"content": [
            {"type": "resource", "resource": {"uri": "file:///x.bin",
                "mimeType": "application/octet-stream", "blob": "AAAA"}}]});
        let out = flatten_call_result(&blob).unwrap().text;
        assert!(out.contains("file:///x.bin"), "{out}");
        assert!(out.contains("application/octet-stream"), "{out}");
        let link = serde_json::json!({"content": [
            {"type": "resource_link", "uri": "file:///y.md", "name": "y"}]});
        assert!(
            flatten_call_result(&link).unwrap().text.contains("file:///y.md"),
            "a link's uri is all it carries"
        );
        // Neither text nor blob: say so rather than claim a binary payload.
        let hollow = serde_json::json!({"content": [
            {"type": "resource", "resource": {"uri": "file:///z"}}]});
        let out = flatten_call_result(&hollow).unwrap().text;
        assert!(out.contains("carried no content"), "{out}");
    }

    #[test]
    fn carries_a_connector_image_instead_of_omitting_it() {
        // A screenshot/chart/map connector answers with a picture, and it used
        // to be flattened to "[image content omitted]" — the model was handed a
        // note about an image rather than the image, on the very protocol the
        // room's own tools use to pass pixels.
        let shot = serde_json::json!({"content": [
            {"type": "text", "text": "here you go"},
            {"type": "image", "data": "AAAA", "mimeType": "image/png"}]});
        let out = flatten_call_result(&shot).unwrap();
        assert_eq!(out.images, vec!["AAAA".to_string()]);
        assert_eq!(out.text, "here you go");
        // An image ALONE is a real result, not "(no output)".
        let bare = serde_json::json!({"content": [
            {"type": "image", "data": "AAAA", "mimeType": "image/jpeg"}]});
        assert!(flatten_call_result(&bare).unwrap().text.is_empty());
        assert_eq!(flatten_call_result(&bare).unwrap().images.len(), 1);
        // The three refusals are SAID, never silent — a model must not treat a
        // picture it did not get as one it did.
        let odd = serde_json::json!({"content": [
            {"type": "image", "data": "AAAA", "mimeType": "image/tiff"}]});
        let out = flatten_call_result(&odd).unwrap();
        assert!(out.images.is_empty());
        assert!(out.text.contains("unsupported format"), "{}", out.text);
        let huge = serde_json::json!({"content": [
            {"type": "image", "data": "A".repeat(MAX_TOOL_IMAGE_B64 + 1), "mimeType": "image/png"}]});
        let out = flatten_call_result(&huge).unwrap();
        assert!(out.images.is_empty());
        assert!(out.text.contains("too large"), "{}", out.text);
        let many: Vec<serde_json::Value> = (0..MAX_TOOL_IMAGES + 2)
            .map(|_| serde_json::json!({"type": "image", "data": "A", "mimeType": "image/png"}))
            .collect();
        let out = flatten_call_result(&serde_json::json!({"content": many})).unwrap();
        assert_eq!(out.images.len(), MAX_TOOL_IMAGES);
        assert!(out.text.contains("further images omitted"), "{}", out.text);
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
    fn config_key_identifies_an_unchanged_server() {
        // Same target, same key → the live connection is carried across a config
        // apply instead of every connector restarting.
        let a = parse_config(
            r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"1","B":"2"}}}}"#,
        )
        .unwrap();
        let b = parse_config(
            r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"B":"2","A":"1"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            config_key(&a[0].1),
            config_key(&b[0].1),
            "env order is not a change — HashMap iteration order must not leak in"
        );
        // Enabling/disabling is not a transport change either.
        let off =
            parse_config(r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"1","B":"2"},"disabled":true}}}"#)
                .unwrap();
        assert_eq!(config_key(&a[0].1), config_key(&off[0].1));
        // Anything that changes WHERE the call goes does change the key.
        for changed in [
            r#"{"mcpServers":{"web":{"command":"uvx","args":["other"],"env":{"A":"1","B":"2"}}}}"#,
            r#"{"mcpServers":{"web":{"command":"npx","args":["ddg"],"env":{"A":"1","B":"2"}}}}"#,
            r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"9","B":"2"}}}}"#,
        ] {
            let c = parse_config(changed).unwrap();
            assert_ne!(config_key(&a[0].1), config_key(&c[0].1), "{changed}");
        }
        // Remote: url and headers (the bearer) both count — a refreshed token
        // must reconnect rather than keep dialling with the old one.
        let h1 = parse_config(r#"{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer a"}}}}"#).unwrap();
        let h2 = parse_config(r#"{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer b"}}}}"#).unwrap();
        assert_ne!(config_key(&h1[0].1), config_key(&h2[0].1));
        // A local and a remote server never collide.
        assert_ne!(config_key(&a[0].1), config_key(&h1[0].1));
    }

    #[test]
    fn stderr_tail_trims_on_char_boundaries() {
        // A server that logs accents/emoji used to panic the reader task here,
        // which lost the real error AND left the child blocked on a full pipe.
        let mut tail = String::new();
        for _ in 0..40 {
            push_stderr_line(&mut tail, "héllo wörld 🚀 — connector said something");
        }
        assert!(tail.len() <= STDERR_TAIL_MAX + 64, "tail must stay bounded");
        assert!(tail.is_char_boundary(0));
        // The retained text is still valid UTF-8 with whole characters, and the
        // newest line survived.
        assert!(tail.ends_with("🚀 — connector said something\n"));
        // A single line longer than the cap is kept whole-charactered too.
        let mut one = String::new();
        push_stderr_line(&mut one, &"🚀".repeat(2000));
        assert!(one.len() <= STDERR_TAIL_MAX + 8);
        assert!(one.starts_with('🚀'));
        assert!(one.ends_with('\n'));
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
