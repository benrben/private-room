//! ADD-20: Room MCP bridge — the room's agent tools, served over loopback.
//!
//! The local model gets file abilities through `agent_loop`'s tool calls;
//! `claude -p` is a one-shot text pipe and gets none. This bridge closes that
//! gap the architecturally honest way: a token-guarded, loopback-only MCP
//! endpoint (streamable HTTP, JSON-RPC) that executes the SAME `exec_tool`
//! dispatch the local agent uses — decryption stays inside this process; only
//! tool RESULTS cross the boundary, exactly like chat content already does.
//!
//! Lifetime = one `ask`: started right before the client spawns, stopped when it
//! returns. A fresh bearer token per run; requests without it are rejected.
//! If the room closes mid-run, `exec_tool` itself errors ("No room is open"),
//! so a stale client can never read a locked room.
//!
//! ADD-33/Wave 1a: the same bridge now feeds three different clients, so what
//! it advertises is scoped (see [`ToolScope`]) — the scope is the security
//! boundary; do not widen the cloud scope.
//! - `CloudAdvisor` — a CLOUD CLI (`claude -p`, a consulted advisor): ONLY the
//!   built-in file tools — never the app-driving UI tools, the
//!   hours-of-local-compute job tools, or `consult_advisor`.
//! - `LocalEngine` — the LOCAL Python agent engine, trusted exactly like the
//!   native `agent_loop`: the full local tool set.
//! - `ExternalAgent` (Wave 1a) — an external agent the user explicitly opted
//!   in per room (Claude Code, Codex, Claude Desktop on the Leash's full
//!   tier): the file tools plus the job tools, `local_generate`, and the
//!   content-perception `view_media_frame`. NEVER the UI-driving tools
//!   (ui_snapshot/ui_act/view_screenshot — an external agent must not observe
//!   or operate the user's screen) and NEVER `consult_advisor` (that tool
//!   lives outside every catalog, keeping the cloud-recursion path closed) —
//!   the only two intentional gaps from in-room-agent parity.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::commands;

/// Which tools this bridge advertises — the trust boundary between a cloud
/// client, the local engine, and a user-configured external agent.
/// `PartialEq` because `set_room_server` restarts a running bridge on a scope
/// mismatch (a flipped cloud sub-option counts — `include_mcp` compares too).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToolScope {
    /// A CLOUD client (top-level `claude -p`, or a consulted advisor). Built-in
    /// file tools only. `include_mcp` (ADD-21) additionally advertises the room's
    /// connected MCP servers so a consulted advisor can reach them — gated by the
    /// advisor sub-option. NEVER the UI/job tools or `consult_advisor`: a cloud
    /// client must not drive the user's screen, start hours of local compute, or
    /// spawn another cloud CLI.
    CloudAdvisor { include_mcp: bool },
    /// The LOCAL Python agent engine (ADD-33). Trusted like `agent_loop`: built-in
    /// tools PLUS the UI/perception tools and the whole-file-pass job tools, plus
    /// the room's connected MCP servers. Still NEVER `consult_advisor` — that tool
    /// lives outside every catalog by design, keeping the cloud-recursion path
    /// closed no matter which engine is driving.
    LocalEngine,
    /// Wave 1a: an EXTERNAL agent the user explicitly opted in per room (the
    /// Leash's full tier — Claude Code, Codex, Claude Desktop). Built-in tools
    /// PLUS the job tools, `local_generate`, the content-perception
    /// `view_media_frame`, and the room's connected MCP servers. NEVER the
    /// UI-driving tools and NEVER `consult_advisor` (see the module doc).
    ExternalAgent,
}

impl ToolScope {
    fn include_mcp(self) -> bool {
        match self {
            ToolScope::CloudAdvisor { include_mcp } => include_mcp,
            ToolScope::LocalEngine | ToolScope::ExternalAgent => true,
        }
    }
    /// The app-driving/screen-observing tools: the local engine's alone.
    fn include_ui_tools(self) -> bool {
        matches!(self, ToolScope::LocalEngine)
    }
    /// The whole-file-pass job tools: hours of local compute, so only the
    /// trusted local engine or an explicitly opted-in external agent.
    fn include_job_tools(self) -> bool {
        matches!(self, ToolScope::LocalEngine | ToolScope::ExternalAgent)
    }
    /// `local_generate` + `view_media_frame`: what an external orchestrator
    /// needs for parity that the in-room engines get another way (the local
    /// engine IS the model; its perception specs ride `include_ui_tools`).
    fn include_external_tools(self) -> bool {
        matches!(self, ToolScope::ExternalAgent)
    }
}

/// ADD-33: a run-scoped accumulator for tool side-effects (`wrote`, `annotation`,
/// `boxes`, …). The native loop threads one `&mut ToolEffects` through every tool
/// call so the post-answer anti-fabrication gate and viewer-effect persistence
/// know what actually happened. When the LOCAL engine drives over this bridge,
/// each `tools/call` mutates this SHARED sink instead of a throwaway default, so
/// those same effects flow back to `ask`. A cloud scope passes `None` (its tool
/// effects are correctly discarded — nothing downstream reads them for a cloud
/// answer). A `tokio` mutex so a guard may be held across `exec_tool`'s awaits.
pub(crate) type EffectsSink = std::sync::Arc<tokio::sync::Mutex<commands::ToolEffects>>;

pub struct Bridge {
    pub port: u16,
    pub token: String,
    /// The tier this bridge serves for its whole lifetime — echoed by the
    /// Leash status snapshot and compared for the scope-mismatch restart.
    pub scope: ToolScope,
    /// Wave 1a: true when the requested fixed port was actually bound (the
    /// pasted config survives restarts); false for ephemeral, including the
    /// fixed-port-taken fallback.
    pub stable: bool,
    shutdown: tokio::sync::watch::Sender<bool>,
    /// The accept-loop task, so `stop_and_wait` can await the listener's death
    /// before a caller rebinds the same fixed port (fire-and-forget `stop`
    /// races EADDRINUSE on an immediate restart).
    task: tauri::async_runtime::JoinHandle<()>,
    /// Set true the instant a `tools/call` is dispatched to `exec_tool` — the
    /// AUTHORITATIVE "a tool ran on this bridge" signal. The sidecar client's own
    /// fallback guard keys off the `step` NDJSON line, but that line and the tool's
    /// side-effect commit travel on two independent connections: a sidecar crash
    /// after the commit but before the line reaches Rust would otherwise let the
    /// caller believe no tool ran, fall back to the native loop, and DOUBLE the
    /// side-effect. Reading this flag closes that race (see `sidecar.rs`).
    tool_ran: Arc<AtomicBool>,
}

impl Bridge {
    /// Whether any `tools/call` was dispatched to `exec_tool` over this bridge —
    /// the crash-safe "a tool ran" signal for the sidecar fallback guard.
    pub fn tool_ran(&self) -> bool {
        self.tool_ran.load(Ordering::SeqCst)
    }

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

    /// The loopback URL the local Python engine POSTs JSON-RPC to.
    pub fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    /// Fire-and-forget stop: signals the accept loop AND every live connection
    /// (each `handle_conn` selects on the same watch channel). Callers that
    /// immediately rebind the same fixed port must use `stop_and_wait`.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Stop and WAIT for the accept loop to die, releasing the bound port —
    /// the restart paths (scope flip, token rotation) rebind the fixed Leash
    /// port right after, and a fire-and-forget stop races EADDRINUSE there.
    pub async fn stop_and_wait(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// Wave 1a: how `start` binds. Default = today's behavior (ephemeral port,
/// fresh token). The Leash's full tier passes its persisted port + token so a
/// pasted external-agent config survives restarts.
#[derive(Default)]
pub struct StartOpts {
    pub port: Option<u16>,
    pub token: Option<String>,
    /// PRIV-1: "send real details this once" — this bridge's turn skips the
    /// privacy door (per-ask bridges only; persistent bridges keep false).
    pub privacy_bypass: bool,
}

/// Bind loopback and serve MCP until `stop()`. `scope` fixes what the bridge
/// advertises for its whole lifetime (see [`ToolScope`]). A fixed `opts.port`
/// is retried briefly (a just-stopped listener may still hold it), then falls
/// back to ephemeral with `stable: false` rather than failing the start.
pub async fn start(
    app: tauri::AppHandle,
    web_enabled: bool,
    scope: ToolScope,
    effects: Option<EffectsSink>,
    opts: StartOpts,
) -> Result<Bridge, String> {
    let (listener, stable) = match opts.port {
        Some(fixed) => {
            let mut bound = None;
            for _ in 0..5 {
                match TcpListener::bind(("127.0.0.1", fixed)).await {
                    Ok(l) => {
                        bound = Some(l);
                        break;
                    }
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                }
            }
            match bound {
                Some(l) => (l, true),
                None => (
                    TcpListener::bind(("127.0.0.1", 0))
                        .await
                        .map_err(|e| format!("mcp bridge bind failed: {e}"))?,
                    false,
                ),
            }
        }
        None => (
            TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| format!("mcp bridge bind failed: {e}"))?,
            false,
        ),
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = opts
        .token
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let tok = token.clone();
    let tool_ran = Arc::new(AtomicBool::new(false));
    let tool_ran_task = tool_ran.clone();
    let privacy_bypass = opts.privacy_bypass;
    let task = tauri::async_runtime::spawn(async move {
        // Each connection watches the same shutdown channel, so `stop()`
        // severs LIVE keep-alive connections too — not just future accepts (a
        // downgraded/stopped bridge must not keep serving its captured scope
        // and token).
        let conn_rx = rx.clone();
        loop {
            tokio::select! {
                _ = rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let app = app.clone();
                    let tok = tok.clone();
                    let effects = effects.clone();
                    let tool_ran = tool_ran_task.clone();
                    let rx = conn_rx.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_conn(
                            stream, app, tok, web_enabled, scope, effects, tool_ran, rx,
                            privacy_bypass,
                        )
                        .await;
                    });
                }
            }
        }
    });
    Ok(Bridge { port, token, scope, stable, shutdown: tx, task, tool_ran })
}

/// One bridge connection: `serve_conn` with the real JSON-RPC dispatcher.
#[allow(clippy::too_many_arguments)]
async fn handle_conn(
    stream: TcpStream,
    app: tauri::AppHandle,
    token: String,
    web_enabled: bool,
    scope: ToolScope,
    effects: Option<EffectsSink>,
    tool_ran: Arc<AtomicBool>,
    shutdown: tokio::sync::watch::Receiver<bool>,
    privacy_bypass: bool,
) -> Result<(), String> {
    let dispatch = move |body: Vec<u8>| {
        let app = app.clone();
        let effects = effects.clone();
        let tool_ran = tool_ran.clone();
        async move {
            dispatch_jsonrpc(
                &app, &body, web_enabled, scope, effects.as_ref(), &tool_ran, privacy_bypass,
            )
            .await
        }
    };
    serve_conn(stream, token, shutdown, dispatch).await
}

/// Serve HTTP/1.1 requests on one connection until the peer hangs up OR the
/// bridge stops (`shutdown` is the bridge-wide watch channel — MCP clients
/// hold keep-alive connections, and a stopped or tier-downgraded bridge must
/// not keep serving them with the captured scope and token). Only what the
/// MCP client actually sends is implemented: POST /mcp with a Content-Length
/// JSON-RPC body (a GET — the optional SSE channel — gets 405). Generic over
/// the dispatcher so the severing behavior is testable without an AppHandle.
async fn serve_conn<F, Fut>(
    mut stream: TcpStream,
    token: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    mut dispatch: F,
) -> Result<(), String>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = (u16, Vec<u8>)>,
{
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    loop {
        // `biased` so an already-signalled stop always wins over a request
        // that raced in — the connection is severed, never served once more.
        // A closed channel (Bridge dropped without stop) severs too.
        let request = tokio::select! {
            biased;
            _ = shutdown.changed() => return Ok(()),
            read = read_framed_request(&mut stream, &mut buf) => match read? {
                Some(request) => request,
                None => return Ok(()), // peer closed between requests
            },
        };
        if !authorize(&request.head, &token) {
            write_response(&mut stream, 401, b"{}").await?;
            continue;
        }
        if !request.head.starts_with("POST ") {
            write_response(&mut stream, 405, b"{}").await?;
            continue;
        }
        let (status, body) = dispatch(request.body).await;
        // A stop that arrived while the dispatch ran revokes the response too:
        // a tier downgrade or token rotation must not hand a result back on
        // the old scope. (The dispatch's side effects have already happened —
        // this severs delivery, the strongest guarantee available post-read.)
        if *shutdown.borrow() {
            return Ok(());
        }
        write_response(&mut stream, status, &body).await?;
    }
}

/// One parsed HTTP request: the header block and the exact body bytes.
struct FramedRequest {
    head: String,
    body: Vec<u8>,
}

/// Read one request off the wire: the head, then EXACTLY Content-Length body
/// bytes (HTTP framing — the body has no self-delimiter, so a short read here
/// would splice the next request's bytes onto this one). `Ok(None)` means the
/// peer closed cleanly between requests.
async fn read_framed_request(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
) -> Result<Option<FramedRequest>, String> {
    let head_end = loop {
        if let Some(pos) = find_head_end(buf) {
            break pos;
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None); // peer closed between requests
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
    Ok(Some(FramedRequest { head, body }))
}

/// The request carries the run's bearer token, or it is rejected. The compare
/// is constant-time over the supplied bytes: the full-tier token is long-lived
/// (persisted across restarts), so a short-circuiting `==` would hand a local
/// prober a timing oracle it never had against the old per-run tokens.
fn authorize(head: &str, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    header_value(head, "authorization")
        .map(|v| ct_eq(v.trim().as_bytes(), expected.as_bytes()))
        .unwrap_or(false)
}

/// Length-independent byte equality: XOR-folds every position of the longer
/// input so timing does not reveal a prefix-match length.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    diff == 0
}

/// Dispatch one JSON-RPC request to its handler, returning (HTTP status, body).
#[allow(clippy::too_many_arguments)]
async fn dispatch_jsonrpc(
    app: &tauri::AppHandle,
    body: &[u8],
    web_enabled: bool,
    scope: ToolScope,
    effects: Option<&EffectsSink>,
    tool_ran: &AtomicBool,
    privacy_bypass: bool,
) -> (u16, Vec<u8>) {
    let req: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return (400, b"{}".to_vec()),
    };
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if id.is_none() {
        // Notifications (e.g. notifications/initialized) need no body.
        return (202, Vec::new());
    }
    let result = match method {
        "initialize" => Ok(serde_json::json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "private-room", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(serde_json::json!({})),
        "tools/list" => Ok(serde_json::json!({ "tools": served_tools(app, web_enabled, scope) })),
        "tools/call" => {
            tool_call(app, &req["params"], web_enabled, scope, effects, tool_ran, privacy_bypass)
                .await
        }
        _ => Err(format!("method not found: {method}")),
    };
    let reply = match result {
        Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(msg) => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": msg }
        }),
    };
    (200, reply.to_string().into_bytes())
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

/// The app-handle-free part of the served catalog: the built-ins plus the
/// scope's extra specs. Pure — this is what the tier tests exercise.
/// - `include_ui_tools` (LocalEngine): the UI/perception tools the native
///   loop injects.
/// - `include_job_tools` (LocalEngine | ExternalAgent): the whole-file-pass
///   tools.
/// - `include_external_tools` (ExternalAgent): `local_generate` plus the
///   content-perception `view_media_frame` (a room video's pixels — content,
///   not the user's screen).
/// NEVER includes `consult_advisor` — that tool lives outside `tools_catalog`
/// by design, closing the cloud-recursion path for every scope.
fn scoped_specs(web_enabled: bool, scope: ToolScope) -> Vec<serde_json::Value> {
    let mut list = builtin_mcp_tools(web_enabled);
    let mut extras: Vec<serde_json::Value> = Vec::new();
    if scope.include_ui_tools() {
        extras.extend(commands::ui_tools_specs());
    }
    if scope.include_job_tools() {
        extras.extend(commands::job_tools_specs());
        // Wave 4a: the workflow authoring tools share the job tools' trust class
        // (LocalEngine + ExternalAgent). save/update only produce drafts a human
        // must activate, and run_workflow is the same compute class as
        // start_file_pass, which the external tier already grants.
        extras.extend(commands::workflow_tools_specs());
    }
    if scope.include_external_tools() {
        extras.extend(commands::external_agent_tools_specs());
        extras.extend(commands::media_tools_specs());
    }
    list.extend(extras.iter().filter_map(to_mcp_tool));
    list
}

/// The full list served over the bridge for `scope`: the pure tier catalog
/// (`scoped_specs`) plus, when the scope includes them, the room's connected
/// MCP tools (which need the app handle).
fn served_tools(
    app: &tauri::AppHandle,
    web_enabled: bool,
    scope: ToolScope,
) -> Vec<serde_json::Value> {
    use tauri::Manager;
    let mut list = scoped_specs(web_enabled, scope);
    if scope.include_mcp() {
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
#[allow(clippy::too_many_arguments)]
async fn tool_call(
    app: &tauri::AppHandle,
    params: &serde_json::Value,
    web_enabled: bool,
    scope: ToolScope,
    effects_sink: Option<&EffectsSink>,
    tool_ran: &AtomicBool,
    privacy_bypass: bool,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // PRIV-1: a CLOUD-bound bridge (a consulted advisor or an external CLI
    // agent) is part of the door — the client sends placeholders in its tool
    // arguments (restore them so the room tools see real values) and every
    // tool RESULT it gets back is redacted before it leaves. The LocalEngine
    // scope is exempt: its tool results flow to the sidecar, whose own chat
    // seam redacts them if (and only if) the chat model is non-local.
    let cloud_policy = match scope {
        ToolScope::CloudAdvisor { .. } | ToolScope::ExternalAgent if !privacy_bypass => {
            commands::active_policy()
        }
        _ => None,
    };
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("tools/call without a name")?
        .to_string();
    // Only tools we actually advertise for this scope are callable. That guards
    // the cloud scope from the UI/job tools even if a client fabricates the name;
    // `consult_advisor` is in no scope's set, so no client can ever spawn another
    // cloud CLI.
    if !served_tools(app, web_enabled, scope)
        .iter()
        .any(|t| t["name"].as_str() == Some(&name))
    {
        return Err(format!("unknown tool: {name}"));
    }
    // A real, advertised tool is about to hit `exec_tool` — record it NOW, before
    // the (possibly side-effecting) dispatch, so the sidecar fallback guard can
    // never conclude "no tool ran" even if the sidecar crashes before its `step`
    // line reaches Rust. Set on every scope; only the sidecar path reads it.
    tool_ran.store(true, Ordering::SeqCst);
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    // Placeholders in from the cloud client → real values for the room tools
    // (a search for "[Person A]" must find the actual name in the DB).
    let arguments = match &cloud_policy {
        Some(p) => p.redactor.restore_value(&arguments),
        None => arguments,
    };
    let call = crate::ollama::ToolCall { name, arguments };
    let window = app
        .get_webview_window("main")
        .ok_or("main window is gone")?
        .as_ref()
        .window();
    let state = app.state::<commands::AppState>();
    // Connected MCP tools are dispatched through the same routes the local agent
    // uses; empty unless this scope includes them. No cancel flag here — the
    // parent run's own cancel already kills this whole client on Stop.
    let routes = if scope.include_mcp() {
        commands::mcp_routes(&state).0
    } else {
        Vec::new()
    };
    // ADD-33: the LOCAL engine accumulates effects into the run-scoped sink so
    // `wrote`/`annotation`/`boxes` reach the post-answer gate; a cloud scope uses
    // a throwaway default (its effects are correctly discarded). The tokio guard
    // is held across the whole `exec_tool` await, serialising concurrent bridge
    // calls into the shared sink — the same one-effects-log-per-run the native
    // loop keeps. No advisor bridge here: consult_advisor is never served over
    // the bridge, so the advisor path cannot re-enter through this dispatch.
    let (outcome, images) = match effects_sink {
        Some(sink) => {
            let mut effects = sink.lock().await;
            // Wave 2 (Idea 6): only the run-scoped LocalEngine sink lives for the
            // whole answer, so "Apply for the rest of this answer" is meaningful
            // here (and hidden for the sink-less cloud/external scopes below).
            effects.run_scoped = true;
            let outcome = commands::exec_tool(
                &state, &window, &call, &mut effects, &routes, &HashSet::new(), None, None,
            )
            .await;
            // MIGRATION Phase 2b (perception bridge): a UI/perception tool
            // (view_screenshot / ui_snapshot / view_media_frame) captured pixels
            // this call — when the chat model is vision-capable it pushes the
            // base64 PNG(s) into `effects.pending_images`. The native loop hands
            // those to the model as a user image message right after the tool
            // result; over this bridge we return them to the sidecar as MCP
            // `image` content blocks (below), and its graph feeds them into the
            // next model turn identically. DRAIN them here so they ride exactly
            // one tool result and are never re-sent on the next call.
            let images: Vec<String> = effects.pending_images.drain(..).collect();
            (outcome, images)
        }
        None => {
            // No effects sink here — CloudAdvisor AND ExternalAgent both ride
            // this branch deliberately: the job tools emit via the window, not
            // the sink, so an externally-started pass still shows the normal
            // sidebar progress card. A cloud scope's captured pixels stay
            // correctly discarded (a cloud client is never handed the user's
            // screen).
            let mut effects = commands::ToolEffects::default();
            // Wave 1a: the external tier's one perception tool is
            // view_media_frame — a room video's pixels, content like
            // open_file, never the screen. Mark the consumer vision-capable so
            // the frame rides back as an MCP `image` block (parity with what
            // the in-room agent sees) instead of a slower local vision-model
            // description.
            effects.vision_chat = matches!(scope, ToolScope::ExternalAgent);
            let outcome = commands::exec_tool(
                &state, &window, &call, &mut effects, &routes, &HashSet::new(), None, None,
            )
            .await;
            let images: Vec<String> = effects.pending_images.drain(..).collect();
            (outcome, images)
        }
    };
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(msg) => (msg, true),
    };
    // Real values out of the room tools → placeholders for the cloud client,
    // and no pixels at all (an image can't be redacted, so it doesn't leave).
    let (text, images) = match &cloud_policy {
        Some(p) => {
            let mut report = commands::PrivacyReport::default();
            (p.redactor.redact(&text, &mut report), Vec::new())
        }
        None => (text, images),
    };
    Ok(tool_result(text, is_error, images))
}

/// Build the JSON-RPC `tools/call` result envelope. The tool's own result rides
/// as the standard MCP text block; captured screenshots follow as `image`
/// blocks in the EXACT Phase-1 sidecar shape:
/// `{"type":"image","data":<standard-base64>,"mimeType":"image/png"}` — no
/// `data:` URI prefix (the sidecar prepends `data:image/png;base64,` itself),
/// `mimeType` camelCase per MCP spec `2024-11-05`. On `isError` only the text is
/// used, so images attach to a successful result only. Pure — this is what the
/// image-bridge test exercises.
fn tool_result(text: String, is_error: bool, images: Vec<String>) -> serde_json::Value {
    let mut content = vec![serde_json::json!({ "type": "text", "text": text })];
    if !is_error {
        for data in images {
            content.push(serde_json::json!({
                "type": "image",
                "data": data,
                "mimeType": "image/png",
            }));
        }
    }
    serde_json::json!({ "content": content, "isError": is_error })
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
    fn authorize_matches_only_the_run_token() {
        let head = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer secret";
        assert!(authorize(head, "secret"));
        assert!(!authorize(head, "other"));
        assert!(!authorize("POST /mcp HTTP/1.1", "secret"));
        // A prefix of the real token must be rejected too — the constant-time
        // compare folds the length mismatch, so a partial match never passes.
        let head_prefix = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer sec";
        assert!(!authorize(head_prefix, "secret"));
    }

    #[test]
    fn ct_eq_rejects_length_and_content_mismatch() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab")); // prefix, differing length
        assert!(!ct_eq(b"ab", b"abc"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn cloud_scope_serves_builtins_only() {
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
        // ADD-33: the cloud catalog also excludes the app-driving + job tools;
        // those are the local engine's alone. (The full served_tools split is
        // exercised end-to-end in the sidecar integration test, which has an
        // AppHandle; here we assert the built-in catalog stays minimal.)
        assert!(!tools.iter().any(|t| t["name"] == "ui_act"));
        assert!(!tools.iter().any(|t| t["name"] == "start_file_pass"));
        // Wave 1a: the external tier's tools never reach a cloud scope either.
        let cloud = scoped_specs(false, ToolScope::CloudAdvisor { include_mcp: true });
        for name in ["local_generate", "start_file_pass", "job_status", "view_media_frame"] {
            assert!(!cloud.iter().any(|t| t["name"] == name), "{name} leaked to cloud");
        }
    }

    #[test]
    fn external_scope_serves_job_and_generate_tools() {
        // Wave 1a: the ExternalAgent tier = file tools + job tools +
        // local_generate + the content-perception view_media_frame…
        let ext = scoped_specs(false, ToolScope::ExternalAgent);
        for name in ["list_room_files", "start_file_pass", "job_status", "local_generate",
                     "view_media_frame"] {
            assert!(ext.iter().any(|t| t["name"] == name), "{name} missing from external tier");
        }
        // …and NEVER the UI-driving/screen tools or consult_advisor (the two
        // intentional gaps from in-room parity — see the module doc).
        for name in ["ui_act", "ui_snapshot", "view_screenshot", "consult_advisor"] {
            assert!(!ext.iter().any(|t| t["name"] == name), "{name} leaked to external tier");
        }
        // The local engine keeps its full set but has no local_generate — it
        // IS the local model already.
        let local = scoped_specs(false, ToolScope::LocalEngine);
        for name in ["ui_act", "ui_snapshot", "view_screenshot", "view_media_frame",
                     "start_file_pass", "job_status"] {
            assert!(local.iter().any(|t| t["name"] == name), "{name} missing from local tier");
        }
        assert!(!local.iter().any(|t| t["name"] == "local_generate"));

        // Wave 4a: the workflow authoring tools ride the job-tools trust class —
        // served to LocalEngine and ExternalAgent, NEVER to a cloud advisor.
        let wf_names = ["list_workflows", "save_workflow", "update_workflow", "run_workflow"];
        for name in wf_names {
            assert!(local.iter().any(|t| t["name"] == name), "{name} missing from local tier");
            assert!(ext.iter().any(|t| t["name"] == name), "{name} missing from external tier");
        }
        let cloud = scoped_specs(false, ToolScope::CloudAdvisor { include_mcp: true });
        for name in wf_names {
            assert!(!cloud.iter().any(|t| t["name"] == name), "{name} leaked to cloud");
        }
    }

    #[tokio::test]
    async fn shutdown_severs_live_connections() {
        // Wave 1a BLOCKER regression: MCP clients hold keep-alive connections,
        // and Bridge::stop() must sever LIVE connections — not just the accept
        // loop — or a tier downgrade/off leaves an open connection serving the
        // old scope and token forever. Exercises `serve_conn` (the exact
        // production per-connection loop; `start` hands every connection a
        // clone of the same shutdown channel this drives).
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = serve_conn(stream, "tok".into(), rx, |_body: Vec<u8>| async {
                (200u16, b"{}".to_vec())
            })
            .await;
        });
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let head = format!(
            "POST /mcp HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut conn = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        conn.write_all(head.as_bytes()).await.unwrap();
        conn.write_all(body).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = conn.read(&mut buf).await.unwrap();
        assert!(
            std::str::from_utf8(&buf[..n]).unwrap().starts_with("HTTP/1.1 200"),
            "first request on the live connection must be served"
        );
        // Stop. The SAME socket: the write may land in the OS buffer, but no
        // response ever comes back — the connection is severed (EOF/reset),
        // never served once more with its captured scope and token.
        tx.send(true).unwrap();
        let _ = conn.write_all(head.as_bytes()).await;
        let _ = conn.write_all(body).await;
        let mut rest = Vec::new();
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(5), conn.read_to_end(&mut rest))
                .await
                .expect("severed connection must not hang");
        match read {
            Ok(_) => assert!(
                !String::from_utf8_lossy(&rest).contains("HTTP/1.1 200"),
                "stopped bridge served a request on a live connection"
            ),
            Err(_) => {} // reset — also severed
        }
    }

    #[test]
    fn perception_images_ride_as_mcp_image_blocks() {
        // MIGRATION Phase 2b: a successful perception tool returns its text plus
        // one `image` block per captured screenshot, in the EXACT shape the
        // Phase-1 sidecar parses.
        let r = tool_result(
            "Captured the screen.".into(),
            false,
            vec!["QUJD".into(), "REVG".into()],
        );
        assert_eq!(r["isError"], false);
        let content = r["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "Captured the screen.");
        // Contract shape: type "image", raw base64 in `data` (no data: prefix),
        // camelCase `mimeType` = "image/png".
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["data"], "QUJD");
        assert_eq!(content[1]["mimeType"], "image/png");
        assert!(!content[1]["data"].as_str().unwrap().starts_with("data:"));
        assert_eq!(content[2]["type"], "image");
        assert_eq!(content[2]["data"], "REVG");
        // A pure text tool result carries only the text block.
        let plain = tool_result("just text".into(), false, vec![]);
        assert_eq!(plain["content"].as_array().unwrap().len(), 1);
        // On error the text is surfaced and images are dropped (isError: only
        // text is used).
        let err = tool_result("boom".into(), true, vec!["QUJD".into()]);
        assert_eq!(err["isError"], true);
        let ec = err["content"].as_array().unwrap();
        assert_eq!(ec.len(), 1);
        assert_eq!(ec[0]["type"], "text");
        assert_eq!(ec[0]["text"], "boom");
    }
}
