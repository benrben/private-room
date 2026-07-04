//! Minimal MCP (Model Context Protocol) client over stdio.
//!
//! Each configured server is a child process speaking newline-delimited
//! JSON-RPC 2.0 on stdin/stdout — the same framing style we already parse
//! for Ollama. We implement just the client half we need: initialize,
//! tools/list and tools/call.

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

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub disabled: bool,
}

/// Parse the de-facto standard `{"mcpServers": {name: {command, args, env}}}`
/// format used by Claude Desktop and Cursor, so users can paste configs
/// straight from any MCP server's README. Extra key we accept: `"disabled"`.
pub fn parse_config(json: &str) -> Result<Vec<(String, ServerConfig)>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Config is not valid JSON: {e}"))?;
    let servers = v
        .get("mcpServers")
        .and_then(|s| s.as_object())
        .ok_or("Config needs a top-level \"mcpServers\" object.")?;
    let mut out = Vec::new();
    for (name, s) in servers {
        let command = s["command"]
            .as_str()
            .ok_or_else(|| format!("Server \"{name}\" is missing \"command\"."))?
            .to_string();
        let args = s["args"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let env = s["env"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let disabled = s["disabled"].as_bool().unwrap_or(false);
        out.push((
            name.clone(),
            ServerConfig {
                command,
                args,
                env,
                disabled,
            },
        ));
    }
    Ok(out)
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
            })
            .collect()
    }
}

// ------------------------------------------------------------------ client

pub struct Client {
    _child: Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
    /// Tail of the server's stderr, for useful error messages when it dies.
    stderr_tail: Arc<Mutex<String>>,
    next_id: u64,
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

impl Client {
    /// Spawn the server, run the initialize handshake and list its tools.
    pub async fn connect(config: &ServerConfig) -> Result<(Self, Vec<Tool>), String> {
        // Resolving PATH shells out; keep it off the async runtime.
        let path = tokio::task::spawn_blocking(login_shell_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut child = tokio::process::Command::new(&config.command)
            .args(&config.args)
            .envs(&config.env)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start \"{}\": {e}", config.command))?;

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

        let mut client = Client {
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
                    "clientInfo": {"name": "Private Room", "version": env!("CARGO_PKG_VERSION")},
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
            for t in result["tools"].as_array().unwrap_or(&Vec::new()) {
                if let Some(name) = t["name"].as_str() {
                    tools.push(Tool {
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
            cursor = result["nextCursor"].as_str().map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok((client, tools))
    }

    /// Call a tool and flatten its content blocks into plain text.
    pub async fn call_tool(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_config() {
        let cfg = parse_config(
            r#"{"mcpServers": {"web": {"command": "uvx",
                "args": ["duckduckgo-mcp-server"],
                "env": {"DDG_REGION": "us-en"}, "disabled": true}}}"#,
        )
        .unwrap();
        assert_eq!(cfg.len(), 1);
        let (name, s) = &cfg[0];
        assert_eq!(name, "web");
        assert_eq!(s.command, "uvx");
        assert_eq!(s.args, vec!["duckduckgo-mcp-server"]);
        assert_eq!(s.env["DDG_REGION"], "us-en");
        assert!(s.disabled);
    }

    #[test]
    fn rejects_bad_config() {
        assert!(parse_config("not json").is_err());
        assert!(parse_config(r#"{"servers": {}}"#).is_err());
        assert!(parse_config(r#"{"mcpServers": {"x": {"args": []}}}"#).is_err());
    }

    #[test]
    fn sanitizes_tool_names() {
        assert_eq!(sanitize_tool_name("fetch-page.v2"), "fetch_page_v2");
        assert_eq!(sanitize_tool_name("search"), "search");
    }
}
