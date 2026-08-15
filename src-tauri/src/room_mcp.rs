//! ADD-20: Room MCP bridge — the room's agent tools, served over loopback.
//!
//! Every engine — the local Python agent hub included — reaches the room's
//! files through THIS bridge; `claude -p` on its own is a one-shot text pipe
//! with no abilities at all. A token-guarded, loopback-only MCP endpoint
//! (streamable HTTP, JSON-RPC) executing the same `exec_tool` dispatch for all
//! of them — decryption stays inside this process; only tool RESULTS cross the
//! boundary, exactly like chat content already does.
//!
//! Lifetime = one `ask`: started right before the client spawns, stopped when it
//! returns. A fresh bearer token per run; requests without it are rejected.
//! If the room closes mid-run, `exec_tool` itself errors ("No room is open"),
//! so a stale client can never read a locked room.
//!
//! ADD-33/Wave 1a: the same bridge now feeds three different clients, so what
//! it advertises is scoped (see [`ToolScope`]) — the scope is the security
//! boundary; do not widen the cloud scope.
//! - `CloudAdvisor` — a CLOUD CLI *consulted* mid-turn (`claude -p` as an
//!   advisor): the built-in file tools and, when explicitly enabled for that
//!   invocation, connected MCP tools — never the app-driving UI tools or the
//!   hours-of-local-compute job tools. A consulted advisor never gets an
//!   [`AdvisorRuntime`], which is what closes the recursion path.
//! - `CloudEngine` (owner decision 2026-07-25) — a cloud CLI selected as the
//!   ROOM'S OWN engine. It IS the room's main agent, so it gets what the local
//!   engine gets: job/workflow/script/studio/transcription tools and connector
//!   management, plus `consult_advisor` from a per-turn runtime. The ONE gap
//!   stays the screen: never `ui_act`/`ui_snapshot`/`view_screenshot`, because
//!   "any model drives the screen" remains forbidden for a cloud engine.
//! - `LocalEngine` — the LOCAL Python agent engine, the most trusted tier:
//!   the full local tool set plus the optional per-turn Advisor capability.
//! - `ExternalAgent` (Wave 1a) — an external agent the user explicitly opted
//!   in per room (Claude Code, Codex, Claude Desktop on the Leash's full
//!   tier): the file tools plus the job tools, `local_generate`, and the
//!   content-perception `view_media_frame`. NEVER the UI-driving tools
//!   (ui_snapshot/ui_act/view_screenshot — an external agent must not observe
//!   or operate the user's screen) and NEVER `consult_advisor` (that tool
//!   lives outside every catalog, keeping the cloud-recursion path closed) —
//!   the only two intentional gaps from in-room-agent parity.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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
    /// A CLOUD client consulted mid-turn (`claude -p` as an advisor) or the
    /// Leash's default "files" tier. Built-in file tools only. `include_mcp`
    /// (ADD-21) additionally advertises the room's connected MCP servers,
    /// gated by that advisor's dedicated sub-option. NEVER the UI/job tools.
    /// A consulted advisor never receives an AdvisorRuntime, so recursion
    /// closes. The room's OWN cloud engine is [`ToolScope::CloudEngine`].
    CloudAdvisor { include_mcp: bool },
    /// Owner decision 2026-07-25: a cloud CLI (Claude Code / Codex) selected as
    /// the ROOM'S OWN engine. Engine parity — it is the main agent, and the
    /// user asked for it to do everything the local engine does, so it gets the
    /// job/workflow/script/studio/transcription tools, connector management and
    /// the room's connected MCP servers. NEVER the UI/screen tools (the single
    /// remaining gap, see the module doc). It may receive `consult_advisor`
    /// from a per-turn runtime, exactly like the local engine.
    ///
    /// Distinct from [`ToolScope::CloudAdvisor`] on purpose: the same bridge
    /// code serves nested advisor bridges, and widening `CloudAdvisor` would
    /// have handed job tools to every consulted advisor too.
    CloudEngine,
    /// The LOCAL Python agent engine (ADD-33), the most trusted tier: built-in
    /// tools PLUS the UI/perception tools and the whole-file-pass job tools, plus
    /// the room's connected MCP servers. A per-turn AdvisorRuntime may add
    /// `consult_advisor` for the top-level model only.
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
            ToolScope::CloudEngine | ToolScope::LocalEngine | ToolScope::ExternalAgent => true,
        }
    }
    /// The app-driving/screen-observing tools (`ui_snapshot`, `ui_act`,
    /// `view_screenshot`).
    ///
    /// Owner decision 2026-08-03: EVERY provider gets full control, the app's
    /// interface included — the room's own cloud CLI was the main agent while
    /// being the one engine that could not press a button, which is the gap
    /// live QA kept reporting as "Claude Code says it cannot see Arcelle".
    ///
    /// This does NOT send the user's screen to a cloud provider, and the reason
    /// is structural rather than a promise. All three tools hand their pixels to
    /// `perceive_image`, which attaches a frame to the conversation only when
    /// `effects.vision_chat` is set — and `chat_model_sees_images` leaves that
    /// false for a `claude-cli`/`codex-cli`/API model. So a cloud engine's
    /// screenshot is described by a LOCAL vision model and only that TEXT
    /// crosses, through the redaction door like any other tool result. Exactly
    /// the mechanism `include_media_perception` already relies on for a room
    /// video's frames; this extends the same guarantee to the screen.
    ///
    /// A merely CONSULTED advisor is still excluded: driving the app is an
    /// action, not advice — the same line `include_browse_tools` draws.
    ///
    /// `pub(crate)` so the tier decision in `sidecar::bridge_scope_for` can be
    /// pinned against the thing it protects, rather than against a scope name.
    pub(crate) fn include_ui_tools(self) -> bool {
        matches!(
            self,
            ToolScope::LocalEngine | ToolScope::CloudEngine | ToolScope::ExternalAgent
        )
    }
    /// The whole-file-pass job tools: hours of local compute, so only an engine
    /// the user chose to run this room (local or a cloud CLI) or an explicitly
    /// opted-in external agent. A merely *consulted* advisor never gets them.
    fn include_job_tools(self) -> bool {
        matches!(
            self,
            ToolScope::LocalEngine | ToolScope::CloudEngine | ToolScope::ExternalAgent
        )
    }
    /// `local_generate`: what an external orchestrator needs and an in-room
    /// engine does not — the local engine IS the model, and a cloud engine
    /// asking the local model to generate is a named parity exception.
    fn include_external_tools(self) -> bool {
        matches!(self, ToolScope::ExternalAgent)
    }
    /// `view_media_frame` — a ROOM VIDEO's pixels: content, like `open_file`,
    /// never the user's screen. The local engine gets it via `include_ui_tools`
    /// alongside its screen tools; the external tier has always had it, so the
    /// room's own cloud engine having less than an opted-in external agent
    /// would be backwards. No pixels leave for a cloud engine: `perceive_image`
    /// attaches the frame only when `effects.vision_chat` is set, which
    /// `chat_model_sees_images` leaves false for a `claude-cli`/`codex-cli`
    /// model — so a LOCAL vision model describes the frame and only that TEXT
    /// crosses, through the redaction door like any other tool result.
    fn include_media_perception(self) -> bool {
        matches!(self, ToolScope::CloudEngine | ToolScope::ExternalAgent)
    }
    /// BROWSE-1: the private browser's tools. Same trust class as
    /// `include_media_perception` plus the local engine — the browser shows WEB
    /// content, never the user's screen, so the reason `include_ui_tools` is
    /// local-only does not apply here. A merely CONSULTED advisor still never
    /// gets them: driving a browser is an action, not advice.
    ///
    /// The doors that make this safe are engine-independent by construction:
    /// the navigation guard, the password fence and the outbound-typing consent
    /// all live in Rust, below every engine.
    fn include_browse_tools(self) -> bool {
        matches!(
            self,
            ToolScope::LocalEngine | ToolScope::CloudEngine | ToolScope::ExternalAgent
        )
    }
    /// The File agent's organize box (`organize_files`, `trash_files`,
    /// `merge_files`) — moving, renaming, deleting into the trash and merging
    /// the user's own documents.
    ///
    /// The same line `include_browse_tools` draws: the engine the user chose to
    /// run this room, or an external agent they explicitly opted in — never a
    /// merely CONSULTED advisor. Asking a second model for an opinion must not
    /// hand it the power to reorganize the room it was asked about; tidying is
    /// an action, not advice.
    ///
    /// This is precisely why these specs are NOT in `tools_catalog`, which is
    /// served to every scope unconditionally. Putting a delete verb there would
    /// have granted it to the advisor tier by default, silently.
    ///
    /// What the grant is bounded BY, rather than by trust: the box has no
    /// permanent delete in it at all. `trash_files` is recoverable from
    /// Library → Trash and is recorded against the agent, and `delete_file` /
    /// `empty_trash` are reachable from no scope and no tool.
    fn include_organize_tools(self) -> bool {
        matches!(
            self,
            ToolScope::LocalEngine | ToolScope::CloudEngine | ToolScope::ExternalAgent
        )
    }
    /// Connector configuration can start local programs or reach remote
    /// services, so its CRUD tools belong only to the engine the user chose to
    /// run this room — local or a cloud CLI — never to a consulted advisor or
    /// an external agent. The save operation still writes DISABLED drafts;
    /// explicit user approval remains required before a connector can run,
    /// which is what makes the cloud-engine grant safe.
    fn include_mcp_management_tools(self) -> bool {
        matches!(self, ToolScope::LocalEngine | ToolScope::CloudEngine)
    }
    /// The tier's name for the host log. A `&'static str`, so the observability
    /// layer's privacy boundary is satisfied by construction rather than by
    /// trusting a caller to pass something safe.
    pub(crate) fn label(self) -> &'static str {
        match self {
            ToolScope::CloudAdvisor { include_mcp: true } => "CloudAdvisor+mcp",
            ToolScope::CloudAdvisor { include_mcp: false } => "CloudAdvisor",
            ToolScope::CloudEngine => "CloudEngine",
            ToolScope::LocalEngine => "LocalEngine",
            ToolScope::ExternalAgent => "ExternalAgent",
        }
    }
}

/// Record the catalog this bridge is about to advertise.
///
/// THE event owner replacement #1 was ordered for. An engine handed an empty
/// tool bridge does not report "my bridge is empty" — it rationalises, and the
/// rationalisation becomes the bug report (the `set(keys)`-drained-generator
/// incident of 2026-07-30 cost days for exactly this reason). The count and the
/// names now exist in a file the model cannot narrate over.
fn log_catalog(scope: ToolScope, tools: &[serde_json::Value], turn: Option<&crate::turn::TurnId>) {
    let names: Vec<String> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect();
    crate::obs::tool_catalog(scope.label(), &names, turn);
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

/// CHG-33: the bridge-lifetime "web search is failing, stop hammering it" brake.
///
/// `ToolEffects::web_search_throttled` is where a hard `web_search` failure
/// raises it, and for the LocalEngine scope that flag rides the run-scoped
/// [`EffectsSink`], so it survives the whole answer. EVERY other scope — a
/// consulted advisor, an external agent, a headless workflow turn — gets a
/// THROWAWAY `ToolEffects` per `tools/call`, so the flag was dropped before the
/// next call could read it and the model retried the same dead endpoint every
/// round. Holding it here fixes that without giving those scopes a run-scoped
/// sink (which would also switch on the per-turn edit-approval cadence).
///
/// Stored as "when it last failed" rather than a bare bool because the Leash's
/// external-agent bridge lives for the whole session: refusing every search for
/// hours because one was rate-limited is its own bug.
type WebThrottle = Arc<std::sync::Mutex<Option<std::time::Instant>>>;

/// How long a hard web-search failure keeps the brake on.
const WEB_THROTTLE_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(180);

/// Is the brake currently on (and not yet expired)?
fn web_throttled(throttle: &WebThrottle) -> bool {
    throttle
        .lock()
        .ok()
        .and_then(|at| *at)
        .is_some_and(|at| at.elapsed() < WEB_THROTTLE_COOLDOWN)
}

/// Raise the brake, starting a fresh cooldown.
fn note_web_throttled(throttle: &WebThrottle) {
    if let Ok(mut at) = throttle.lock() {
        *at = Some(std::time::Instant::now());
    }
}

/// A top-level model's permission and runtime state for `consult_advisor`.
///
/// This is deliberately separate from [`ToolScope`]. The same primary turn may
/// be driven by a local model, an API-provider model, or a Claude/Codex CLI; all
/// three may consult an enabled advisor. A *consulted* advisor is started with
/// no `AdvisorRuntime`, so it can never see or call `consult_advisor` itself.
#[derive(Clone)]
pub struct AdvisorRuntime {
    advisors: Vec<String>,
    cancel: Arc<AtomicBool>,
    room_bridge: Option<Arc<Bridge>>,
    calls: Arc<AtomicU8>,
}

impl AdvisorRuntime {
    pub fn new(
        advisors: Vec<String>,
        cancel: Arc<AtomicBool>,
        room_bridge: Option<Arc<Bridge>>,
    ) -> Self {
        Self {
            advisors,
            cancel,
            room_bridge,
            calls: Arc::new(AtomicU8::new(0)),
        }
    }

    fn tool(&self) -> Option<serde_json::Value> {
        // `consult_advisor_spec` itself returns None when no RECOGNISED CLI is
        // present, so an `advisors` list carrying only unknown ids serves no
        // tool rather than one with an unsatisfiable empty enum.
        commands::consult_advisor_spec(&self.advisors)
            .as_ref()
            .and_then(|spec| to_mcp_tool(spec, true))
    }
}

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
    /// Present only for a top-level model turn with Advisors enabled. Nested
    /// advisor bridges and persistent Leash servers always leave this `None`.
    pub advisor: Option<AdvisorRuntime>,
    /// The room's per-agent web switches (Settings → Online features). Defaults
    /// to both ON, so a caller that does not care keeps today's catalog.
    pub lanes: commands::WebLanes,
    /// The ASK's Stop flag, for a per-turn bridge. A `tools/call` that arrives
    /// after Stop is refused before it executes (see `dispatch_jsonrpc`).
    ///
    /// Owner decision 2026-08-03: cancelling a parent must block artifact
    /// writes, not merely sever their delivery. `serve_conn` already declines to
    /// return a result once the bridge is shutting down, but by then the write
    /// has happened — the code says so itself ("the dispatch's side effects have
    /// already happened"). This flag is what makes the refusal land BEFORE the
    /// side effect. `None` for persistent/nested bridges, which have no ask.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Owner replacement #4: the run/chat this bridge serves. A tool call
    /// dispatched here emits its step chip under the SAME identity as the
    /// deltas around it, so the conversation that asked is the only one that
    /// paints it. `None` for a persistent/nested bridge, which has no ask.
    pub turn: Option<crate::turn::TurnId>,
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
    // CHG-33: one brake per BRIDGE, owned by the accept task and cloned into
    // each connection — so it lives exactly as long as the bridge serves, which
    // is one answer for a per-ask bridge and the session for the Leash's.
    let web_throttle_task: WebThrottle = Arc::new(std::sync::Mutex::new(None));
    let privacy_bypass = opts.privacy_bypass;
    let advisor = opts.advisor;
    let lanes = opts.lanes;
    let run_cancel = opts.cancel;
    let turn = opts.turn;
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
                    let web_throttle = web_throttle_task.clone();
                    let rx = conn_rx.clone();
                    let advisor = advisor.clone();
                    let run_cancel = run_cancel.clone();
                    let turn = turn.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_conn(
                            stream, app, tok, web_enabled, lanes, scope, effects, tool_ran,
                            web_throttle, rx, privacy_bypass, advisor, run_cancel, turn,
                        )
                        .await;
                    });
                }
            }
        }
    });
    Ok(Bridge {
        port,
        token,
        scope,
        stable,
        shutdown: tx,
        task,
        tool_ran,
    })
}

/// Build the optional Advisor capability for one top-level turn. When the room
/// tools sub-option is enabled, Claude receives its own restricted bridge. That
/// nested bridge intentionally has no AdvisorRuntime, which is the recursion
/// boundary. The returned handle lets the caller stop it with the main bridge.
pub async fn prepare_advisor_runtime(
    app: tauri::AppHandle,
    web_enabled: bool,
    advisors: Vec<String>,
    advisor_tools_enabled: bool,
    cancel: Arc<AtomicBool>,
    privacy_bypass: bool,
) -> (Option<AdvisorRuntime>, Option<Arc<Bridge>>) {
    if advisors.is_empty() {
        return (None, None);
    }
    let nested = if advisor_tools_enabled && advisors.iter().any(|item| item == "claude-cli") {
        start(
            app,
            web_enabled,
            ToolScope::CloudAdvisor { include_mcp: true },
            None,
            StartOpts {
                privacy_bypass,
                ..Default::default()
            },
        )
        .await
        .ok()
        .map(Arc::new)
    } else {
        None
    };
    let runtime = AdvisorRuntime::new(advisors, cancel, nested.clone());
    (Some(runtime), nested)
}

/// One bridge connection: `serve_conn` with the real JSON-RPC dispatcher.
#[allow(clippy::too_many_arguments)]
async fn handle_conn(
    stream: TcpStream,
    app: tauri::AppHandle,
    token: String,
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
    effects: Option<EffectsSink>,
    tool_ran: Arc<AtomicBool>,
    web_throttle: WebThrottle,
    shutdown: tokio::sync::watch::Receiver<bool>,
    privacy_bypass: bool,
    advisor: Option<AdvisorRuntime>,
    run_cancel: Option<Arc<AtomicBool>>,
    turn: Option<crate::turn::TurnId>,
) -> Result<(), String> {
    let dispatch = move |body: Vec<u8>| {
        let app = app.clone();
        let effects = effects.clone();
        let tool_ran = tool_ran.clone();
        let web_throttle = web_throttle.clone();
        let advisor = advisor.clone();
        let run_cancel = run_cancel.clone();
        let turn = turn.clone();
        async move {
            dispatch_jsonrpc(
                &app,
                &body,
                web_enabled,
                lanes,
                scope,
                effects.as_ref(),
                &tool_ran,
                &web_throttle,
                privacy_bypass,
                advisor.as_ref(),
                run_cancel.as_ref(),
                turn.as_ref(),
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
        let request = match request {
            Ok(request) => request,
            // An oversized request is refused with 413 and the connection is
            // dropped: the framing is only trustworthy up to the head, so
            // there is no safe way to skip past a body we refused to read.
            Err(OversizeRequest) => {
                let _ = write_response(&mut stream, 413, b"{}").await;
                return Ok(());
            }
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

/// The peer declared (or is sending) more than [`MAX_REQUEST_BODY`].
struct OversizeRequest;

/// Ceiling on ONE JSON-RPC request body, in bytes.
///
/// The head block was already capped, but the BODY was read to whatever
/// `Content-Length` claimed — and the bearer token is only checked afterwards,
/// on the parsed head. Anything already running on this Mac could therefore
/// open the loopback port, declare a 100 GB body and push bytes into a `Vec`
/// until the app died, without ever knowing the token. The cap runs BEFORE the
/// first body byte is read, so a declared-huge request costs nothing.
///
/// 16 MiB is far above any real call: the largest thing that legitimately
/// arrives here is a tool call carrying a base64 image, and the sidecar's own
/// result caps sit well below this.
const MAX_REQUEST_BODY: usize = 16 * 1024 * 1024;

/// Read one request off the wire: the head, then EXACTLY Content-Length body
/// bytes (HTTP framing — the body has no self-delimiter, so a short read here
/// would splice the next request's bytes onto this one). `Ok(None)` means the
/// peer closed cleanly between requests.
async fn read_framed_request(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
) -> Result<Option<Result<FramedRequest, OversizeRequest>>, String> {
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
    // Refused on the DECLARATION, before a single body byte is buffered.
    if content_len > MAX_REQUEST_BODY {
        return Ok(Some(Err(OversizeRequest)));
    }
    while buf.len() < body_start + content_len {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("truncated body".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        // A lying Content-Length (or a pipelined flood behind a small one)
        // cannot grow the buffer past the cap either.
        if buf.len() > body_start + MAX_REQUEST_BODY {
            return Ok(Some(Err(OversizeRequest)));
        }
    }
    let body = buf[body_start..body_start + content_len].to_vec();
    buf.drain(..body_start + content_len);
    Ok(Some(Ok(FramedRequest { head, body })))
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
    lanes: commands::WebLanes,
    scope: ToolScope,
    effects: Option<&EffectsSink>,
    tool_ran: &AtomicBool,
    web_throttle: &WebThrottle,
    privacy_bypass: bool,
    advisor: Option<&AdvisorRuntime>,
    run_cancel: Option<&Arc<AtomicBool>>,
    turn: Option<&crate::turn::TurnId>,
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
    // The room's per-agent web switches are read PER REQUEST rather than
    // captured when the bridge started. An external agent (Claude Code, Codex,
    // Claude Desktop) holds ONE connection for the whole session, so a bridge
    // that answered `tools/list` at connect time kept serving the web and
    // browser tools for the rest of it: flipping either switch in Settings
    // changed nothing until the room was closed, with no hint it had not taken.
    // Intersected with what the caller asked for, so a caller that deliberately
    // narrowed the catalog (a workflow node) keeps its narrowing.
    let lanes = {
        use tauri::Manager;
        let live = commands::open_room_web_lanes(&app.state::<commands::AppState>());
        commands::WebLanes {
            search: lanes.search && live.search,
            browse: lanes.browse && live.browse,
        }
    };
    let result = match method {
        "initialize" => Ok(serde_json::json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "arcelle", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(serde_json::json!({})),
        "tools/list" => {
            let tools = served_tools(app, web_enabled, lanes, scope, advisor);
            log_catalog(scope, &tools, turn);
            Ok(serde_json::json!({ "tools": tools }))
        }
        // Stop lands BEFORE the side effect, not after it. Everything else the
        // bridge answers (initialize / ping / tools/list) stays served even on a
        // cancelled run: refusing `tools/list` would report an EMPTY CATALOG,
        // which the Main agent now surfaces as "the room tool bridge served 0
        // tools" — turning a clean user Stop into what looks like a wiring
        // failure. Only the call that would actually write is refused.
        "tools/call" if run_cancel.is_some_and(|c| c.load(Ordering::SeqCst)) => {
            Ok(serde_json::json!({
                "content": [{
                    "type": "text",
                    "text": "Stopped by the user — this tool was not run.",
                }],
                "isError": true,
            }))
        }
        "tools/call" => {
            tool_call(
                app,
                &req["params"],
                web_enabled,
                lanes,
                scope,
                effects,
                tool_ran,
                web_throttle,
                privacy_bypass,
                advisor,
                run_cancel,
                turn,
            )
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

/// Safety metadata for Arcelle-owned tools. Codex `exec` is deliberately
/// non-interactive (`approval_policy=never`); without MCP annotations it treats
/// every server tool as approval-requiring and returns "user cancelled MCP
/// tool call" before the request reaches Arcelle. These hints let reads and
/// recoverable/non-destructive writes run while keeping genuinely unknown
/// third-party tools fail-closed.
fn arcelle_tool_annotations(name: &str) -> Option<serde_json::Value> {
    let (read_only, destructive, idempotent, open_world) = match name {
        // Room/content reads and viewer-only effects.
        "list_room_files"
        | "search_room"
        | "open_file"
        | "mark_image"
        | "annotate_file"
        | "list_memories"
        | "list_skills"
        | "read_skill"
        | "read_skill_resource"
        | "job_status"
        | "list_workflows"
        | "list_scripts"
        | "stt_status"
        | "ui_snapshot"
        | "view_screenshot"
        | "view_media_frame"
        | "local_generate"
        | "list_mcps"
        // Reading a drawing. Stays read-only despite rendering a picture:
        // the picture is derived from the document and nothing changes.
        | "read_drawing"
        | "read_mcp" => (true, false, true, false),
        // Reads that may contact the public web. Arcelle only advertises them
        // when the room's Online features setting is enabled.
        "web_search" | "fetch_page" => (true, false, true, true),
        // BROWSE-1: reads of a live web page. `open_world` because they reach
        // the public internet; `read_only` because none of them changes the
        // room. `browse_open` is NOT idempotent — loading a URL twice can post
        // analytics, advance a session, or land somewhere else entirely.
        "browse_read" | "browse_find" | "browse_snapshot" | "browse_look" => {
            (true, false, true, true)
        }
        "browse_open" => (true, false, false, true),
        // Driving a page is an ACTION on the open web: it can submit forms and
        // spend the user's credentials on a site. Not read-only, not
        // idempotent, and honestly open-world. Marked non-destructive because
        // the room itself is untouched and every typing action carrying room
        // data passes the outbound consent door first.
        "browse_do" => (false, false, false, true),
        // BROWSE-2: capture the ALREADY-LOADED page into the room. Mutates the
        // room (new files, recoverable) without reaching the network.
        "browse_save" => (false, false, false, false),
        // BROWSE-2: fetch web content INTO the room. Room-mutating (new files,
        // recoverable) and honestly open-world — the fetch reaches the public
        // internet. Not idempotent: re-downloading lands another copy.
        "save_link" | "download_url" | "download_media" => (false, false, false, true),
        // A paid cloud consultation. It does not mutate the room, but it sends
        // the supplied question to the selected advisor and is not idempotent.
        "consult_advisor" => (false, false, false, true),
        // Recoverable room mutations. File writes are versioned, workflow and
        // skill writes produce reviewable drafts, and script execution has its
        // own explicit Arcelle approval gate.
        "create_file"
        | "edit_file"
        | "edit_files"
        | "write_file"
        | "set_cells"
        | "rename_file"
        | "move_file"
        // Whether Home also lists an object. Room-local and reversible by its
        // own opposite, and it touches no bytes — no export, no upload, no
        // copy. Not read-only (it writes a column), and deliberately not
        // marked open-world: nothing leaves the Mac.
        | "set_in_library"
        | "add_memory"
        | "update_memory"
        | "save_skill"
        | "write_skill_resource"
        | "run_skill_script"
        | "start_file_pass"
        | "save_workflow"
        | "update_workflow"
        | "run_workflow"
        | "run_script"
        | "studio_flashcards"
        | "studio_mindmap"
        | "generate_podcast_script"
        // Drawing on a sketch: a versioned write to a room file, exactly like
        // `edit_file`. `clear` inside a script wipes the page, but the previous
        // document is snapshotted first and restorable, so it is recoverable
        // rather than destructive.
        | "draw"
        | "retranscribe_file"
        | "read_recording"
        | "test_workflow"
        | "ui_act"
        // The organize box's two non-deleting verbs. Recoverable like the file
        // writes above: a move or a rename is undone by another one, a merge
        // only ADDS a file, and deleting a folder never deletes its files.
        // Not idempotent — running the same organize plan twice can rename an
        // already-renamed file again — and never open-world.
        | "organize_files"
        | "merge_files"
        | "save_mcp" => (false, false, false, false),
        // Deletion is intentionally marked honestly. A non-interactive Codex
        // subprocess cannot confirm it, while the local main agent reaches it
        // only through the on-demand management lane.
        //
        // `trash_files` is here rather than beside the file writes above for
        // exactly the reason it is a separate tool at all: the hint a host reads
        // to decide whether to ask a human must say "this removes the user's
        // files". It is recoverable — Library → Trash, with the agent named —
        // but "recoverable" is not "non-destructive", and marking it soft would
        // be the app choosing the model's convenience over the user's.
        "trash_files"
        | "delete_memory"
        | "delete_skill"
        | "delete_skill_resource"
        | "delete_workflow"
        | "delete_mcp" => {
            (false, true, false, false)
        }
        _ => return None,
    };
    Some(serde_json::json!({
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "idempotentHint": idempotent,
        "openWorldHint": open_world,
    }))
}

/// Keep only the standard boolean MCP hints from a connected third-party
/// server. Arcelle's own connector approval gate remains authoritative; this
/// metadata merely prevents Codex from adding an impossible second prompt in
/// its non-interactive subprocess.
fn sanitized_tool_annotations(value: &serde_json::Value) -> Option<serde_json::Value> {
    let source = value.as_object()?;
    let mut out = serde_json::Map::new();
    for key in [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
    ] {
        if let Some(value) = source.get(key).and_then(|v| v.as_bool()) {
            out.insert(key.to_string(), serde_json::Value::Bool(value));
        }
    }
    (!out.is_empty()).then_some(serde_json::Value::Object(out))
}

/// Translate one Ollama-shaped `{"function": {...}}` spec to an MCP tool record.
fn to_mcp_tool(t: &serde_json::Value, arcelle_owned: bool) -> Option<serde_json::Value> {
    let f = t.get("function")?;
    let name = f.get("name")?.as_str()?;
    let mut tool = serde_json::json!({
        "name": f.get("name")?,
        "description": f.get("description").cloned().unwrap_or_default(),
        "inputSchema": f.get("parameters").cloned()
            .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}})),
    });
    let annotations = if arcelle_owned {
        arcelle_tool_annotations(name)
    } else {
        f.get("annotations").and_then(sanitized_tool_annotations)
    };
    if let Some(annotations) = annotations {
        tool["annotations"] = annotations;
    }
    Some(tool)
}

const MCP_SEARCH_TOOL: &str = "search_mcp_tools";
const MCP_RUN_TOOL: &str = "run_mcp_tool";

/// The stable two-tool surface for every connected room connector. Connector
/// catalogs can be very large and change at runtime; keeping them behind this
/// proxy lets the model discover only the relevant schemas, then invoke the
/// exact tool id it selected.
fn mcp_proxy_tools() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": MCP_SEARCH_TOOL,
            "description": "Search all enabled, connected MCP tools installed in this room. Use this before run_mcp_tool. Returns exact tool ids, connector names, descriptions, and input schemas.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What capability or data source you need, such as stock prices, forecasts, web fetch, or prediction markets."},
                    "connector": {"type": "string", "description": "Optional connector name to search within."}
                },
                "required": ["query"]
            },
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        }),
        serde_json::json!({
            "name": MCP_RUN_TOOL,
            "description": "Run one connected room MCP tool returned by search_mcp_tools. Pass its exact tool id and arguments matching the returned input schema.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "description": "Exact tool id returned by search_mcp_tools."},
                    "arguments": {"type": "object", "description": "Arguments matching that tool's input schema."}
                },
                "required": ["tool", "arguments"]
            },
            // NOT `destructiveHint: true`. Every connector call in the room now
            // goes through this ONE proxy, so a blanket destructive label is a
            // claim about tools it knows nothing about — including a read-only
            // lookup. A non-interactive `codex exec` (approval_policy=never)
            // cannot get confirmation for a destructive tool, so it refused
            // every connector call a Codex-engine room made, which by the app's
            // own rules left that room with no connectors at all. The honest
            // marking is "an action, reaching the outside world, not repeatable"
            // — the per-connector approval gate stays authoritative, and it is
            // Arcelle's, not the client's.
            "annotations": {
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": true
            }
        }),
    ]
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchableMcpTool {
    tool: String,
    connector: String,
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

fn searchable_mcp_tools(routes: &[commands::McpRoute]) -> Vec<SearchableMcpTool> {
    routes
        .iter()
        .map(|route| SearchableMcpTool {
            tool: route.catalog_name.clone(),
            connector: route.server_name.clone(),
            name: route.tool_name.clone(),
            description: route.spec["function"]["description"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            input_schema: route.spec["function"]["parameters"].clone(),
        })
        .collect()
}

fn mcp_search_score(entry: &SearchableMcpTool, terms: &[String]) -> usize {
    if terms.is_empty() {
        return 1;
    }
    let tool = entry.tool.to_lowercase();
    let connector = entry.connector.to_lowercase();
    let name = entry.name.to_lowercase();
    let description = entry.description.to_lowercase();
    terms
        .iter()
        .map(|term| {
            usize::from(tool.contains(term)) * 4
                + usize::from(name.contains(term)) * 4
                + usize::from(connector.contains(term)) * 3
                + usize::from(description.contains(term))
        })
        .sum()
}

/// How many connector tools one `search_mcp_tools` call may return.
///
/// The point of the proxy is that a big connector catalog costs nothing until
/// it is used — but the search RESULT is a tool result like any other, carrying
/// each match's full `inputSchema`. Returning every match on a broad query
/// ("data") put a whole 60-tool catalog back into one message, which is the
/// flood the proxy exists to prevent. Ranked, so the cut is always the least
/// relevant tail, and the caller is told when there is more.
const MAX_MCP_SEARCH_RESULTS: usize = 12;

fn search_mcp_entries(
    entries: &[SearchableMcpTool],
    query: &str,
    connector: Option<&str>,
) -> Vec<SearchableMcpTool> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    let connector = connector.map(str::trim).filter(|value| !value.is_empty());
    let connector_lower = connector.map(str::to_lowercase);
    let mut matches: Vec<(usize, SearchableMcpTool)> = entries
        .iter()
        .filter(|entry| {
            connector_lower
                .as_ref()
                .is_none_or(|wanted| entry.connector.to_lowercase().contains(wanted))
        })
        .filter_map(|entry| {
            let score = mcp_search_score(entry, &terms);
            (score > 0).then_some((score, entry.clone()))
        })
        .collect();
    matches.sort_by(|(a_score, a), (b_score, b)| {
        b_score.cmp(a_score).then_with(|| a.tool.cmp(&b.tool))
    });
    matches.into_iter().map(|(_, entry)| entry).collect()
}

/// The built-in room catalog translated to MCP tool records. Same source of
/// truth as the local agent (`tools_catalog`), so the two engines can never
/// drift apart. Pure — this is what the tests exercise.
fn builtin_mcp_tools(web_enabled: bool) -> Vec<serde_json::Value> {
    commands::tools_catalog(web_enabled)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| to_mcp_tool(tool, true))
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
/// Does not include `consult_advisor`; the per-turn runtime adds that separately
/// for top-level local/API/CLI models without widening a nested advisor bridge.
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
        // Scripts share that trust class; run_script keeps its own consent gate.
        extras.extend(commands::script_tools_specs());
        // Studio generation and on-device transcription: same local-compute
        // trust class (minutes of work, results land as reviewable room files).
        extras.extend(commands::studio_tools_specs());
        extras.extend(commands::transcribe_tools_specs());
        // The Sketch page's drawing tools. Same trust class as the studio
        // generators for the same reason: local compute whose whole output is
        // a room file the user can see, version, and undo by restoring. A
        // merely CONSULTED advisor still gets none of them — drawing on the
        // user's page is an action, not advice, which is why these specs are
        // here rather than in `tools_catalog`.
        extras.extend(commands::draw_tools_specs());
    }
    if scope.include_organize_tools() {
        extras.extend(commands::organize_tools_specs());
    }
    if scope.include_mcp_management_tools() {
        extras.extend(commands::mcp_management_tools_specs());
    }
    if scope.include_external_tools() {
        extras.extend(commands::external_agent_tools_specs());
    }
    if scope.include_media_perception() {
        extras.extend(commands::media_tools_specs());
    }
    // Gated on `web_enabled` — the user's existing "may this room reach the
    // web" switch — rather than on the browser being open, which would be
    // circular: the model could never call `browse_open` because the tool that
    // opens the browser would only appear once it was already open.
    if web_enabled && scope.include_browse_tools() {
        extras.extend(commands::browse_tools_specs());
        // BROWSE-2 (D17): the download/save tools share the browse trust class
        // — engine tiers only, never a consulted advisor. Same web gate.
        extras.extend(commands::download_tools_specs());
    }
    list.extend(extras.iter().filter_map(|tool| to_mcp_tool(tool, true)));
    list
}

/// The BUILT-IN tool names one tier may ever be served, for the published
/// provider × agent matrix.
///
/// No room-specific lanes and no per-turn advisor: the matrix answers "what can
/// this class of engine EVER do here", which is a property of the tier, not of
/// whichever room happens to be open. The sidecar turns these names into the set
/// of workers its own registry considers reachable, which is what makes the
/// matrix derived rather than written down.
///
/// The connector proxy pair IS included, gated on `include_mcp` exactly as the
/// bridge gates it. It is not part of `scoped_specs` because the live bridge
/// only adds it once a connector is actually installed — but "this room has no
/// connector yet" is a fact about the ROOM, and leaving the pair out made the
/// published matrix say the Connector agent (whose whole box is
/// `search_mcp_tools`/`run_mcp_tool`) works with NO provider at all, on every
/// row, forever. A tier that may serve connectors can reach that agent; a tier
/// that may not (a consulted advisor without the sub-option) cannot, and that
/// is the distinction this reports.
pub(crate) fn tier_tool_names(web_enabled: bool, scope: ToolScope) -> Vec<String> {
    let mut specs = scoped_specs(web_enabled, scope);
    if scope.include_mcp() {
        specs.extend(mcp_proxy_tools());
    }
    specs
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect()
}

/// The tool names THIS ROOM's bridge would serve right now, for `scope`.
///
/// [`tier_tool_names`] answers a question about a class of engine; this one
/// answers it about the room that is actually open, so it applies the room's
/// per-agent web lanes and its connected MCP servers exactly as a turn would.
/// The composer's `*` specialist menu is built from these names (the sidecar
/// turns them into its reachable domains): a lane the user switched off has to
/// remove that specialist from the MENU too, or the menu offers a turn the room
/// would then refuse.
///
/// No per-turn advisor is passed — `consult_advisor` belongs to no agent's box,
/// so it cannot make a specialist reachable or unreachable either way.
pub(crate) fn room_tool_names(
    app: &tauri::AppHandle,
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<commands::AppState>();
    let routes = if scope.include_mcp() {
        commands::mcp_routes(&state)
    } else {
        Vec::new()
    };
    room_tool_names_with(web_enabled, lanes, scope, &routes)
}

/// [`room_tool_names`] against routes the caller already has — the handle-free
/// half, so the invariant the menu rests on (a lane the user switched off
/// removes its tools from the menu too) is pinnable in a unit test.
pub(crate) fn room_tool_names_with(
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
    routes: &[commands::McpRoute],
) -> Vec<String> {
    names_of(&served_tools_with(web_enabled, lanes, scope, None, routes))
}

fn names_of(tools: &[serde_json::Value]) -> Vec<String> {
    tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect()
}

/// The full list served over the bridge for `scope`: the pure tier catalog
/// (`scoped_specs`) plus the stable search/run proxy when connected room MCP
/// tools exist. Individual third-party schemas are returned on demand by the
/// search tool instead of flooding every model request.
fn served_tools(
    app: &tauri::AppHandle,
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
    advisor: Option<&AdvisorRuntime>,
) -> Vec<serde_json::Value> {
    use tauri::Manager;
    let state = app.state::<commands::AppState>();
    let routes = if scope.include_mcp() {
        commands::mcp_routes(&state)
    } else {
        Vec::new()
    };
    served_tools_with(web_enabled, lanes, scope, advisor, &routes)
}

/// [`served_tools`] against routes the caller already has. `tools/call` needs
/// the routes anyway (to dispatch), and it also has to check the name against
/// the served catalog — going through `served_tools` there enumerated every
/// connector's tools a second time, under the `mcp` lock, on every single call.
fn served_tools_with(
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
    advisor: Option<&AdvisorRuntime>,
    routes: &[commands::McpRoute],
) -> Vec<serde_json::Value> {
    let mut list = scoped_specs(web_enabled, scope);
    // The room's per-agent web switches, applied HERE because this one function
    // is what both `tools/list` (line ~595) and `tools/call`'s allow-check go
    // through — so a lane the user turned off is neither advertised nor
    // executable, and the two can never disagree. `scoped_specs` above stays
    // pure TIER truth ("what may this trust level ever serve"); a lane is user
    // PREFERENCE layered on top, which is why they are separate steps.
    if lanes != commands::WebLanes::ALL {
        list.retain(|t| {
            t.get("name")
                .and_then(|n| n.as_str())
                .is_none_or(|n| !lanes.blocks(n))
        });
    }
    if !matches!(scope, ToolScope::ExternalAgent) {
        if let Some(tool) = advisor.and_then(AdvisorRuntime::tool) {
            list.push(tool);
        }
    }
    if scope.include_mcp() && !routes.is_empty() {
        list.extend(mcp_proxy_tools());
    }
    list
}

/// Which Stop flag one dispatched tool carries down to its own commit gate.
///
/// Owner replacement #3: the arrival check in `dispatch_jsonrpc` refuses a
/// `tools/call` that STARTS after the Stop; this is the other half — the flag a
/// call already in flight hands to `Artifact::cancel_maybe`, to the scratch-pad
/// rewrite and to the `run_script` wait, so the write is gated at the moment it
/// commits. The advisor runtime's flag and the bridge's `run_cancel` are the
/// SAME ask's flag when both exist (`prepare_advisor_runtime` is handed it);
/// the fallback matters because `prepare_advisor_runtime` returns `None` for
/// every room with no Advisor configured, which is most of them — and that left
/// `exec_tool` holding `None` and every commit gate below it inert.
fn tool_cancel_for(
    advisor: Option<&AdvisorRuntime>,
    run_cancel: Option<&Arc<AtomicBool>>,
) -> Option<Arc<AtomicBool>> {
    advisor
        .map(|runtime| runtime.cancel.clone())
        .or_else(|| run_cancel.cloned())
}

/// Execute one tool through the room's own dispatch. Tool errors come back as
/// MCP `isError` results (the model can react), not JSON-RPC failures.
#[allow(clippy::too_many_arguments)]
async fn tool_call(
    app: &tauri::AppHandle,
    params: &serde_json::Value,
    web_enabled: bool,
    lanes: commands::WebLanes,
    scope: ToolScope,
    effects_sink: Option<&EffectsSink>,
    tool_ran: &AtomicBool,
    web_throttle: &WebThrottle,
    privacy_bypass: bool,
    advisor: Option<&AdvisorRuntime>,
    // Owner replacement #3, the commit half: this bridge's ASK Stop flag. The
    // arrival check in `dispatch_jsonrpc` refuses a call that starts after the
    // Stop, but a call already in flight has to carry the flag DOWN to the
    // funnel that writes — `Artifact::cancel_maybe`, the pad rewrite, the
    // `run_script` wait. Before this it was fed `advisor.cancel`, which only
    // exists when the room has an Advisor configured: in every ordinary room
    // `exec_tool` got `None` and the "a Stop lands BEFORE the commit" comment
    // on `create_file` was describing a gate that could not fire.
    run_cancel: Option<&Arc<AtomicBool>>,
    turn: Option<&crate::turn::TurnId>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let tool_cancel = tool_cancel_for(advisor, run_cancel);
    // PRIV-1: a CLOUD-bound bridge (a consulted advisor or an external CLI
    // agent) is part of the door — the client sends placeholders in its tool
    // arguments (restore them so the room tools see real values) and every
    // tool RESULT it gets back is redacted before it leaves. The LocalEngine
    // scope is exempt: its tool results flow to the sidecar, whose own chat
    // seam redacts them if (and only if) the chat model is non-local.
    let cloud_policy = match scope {
        // `CloudEngine` redacts here exactly as `CloudAdvisor` did before it
        // split off: widening that tier's TOOLS must not quietly widen what
        // leaves the machine. (Belt and braces — the sidecar's chat seam also
        // redacts for a non-local model. Placeholders are restored on the way
        // in, so double coverage is not double damage.)
        ToolScope::CloudAdvisor { .. } | ToolScope::CloudEngine | ToolScope::ExternalAgent
            if !privacy_bypass =>
        {
            commands::active_policy()
        }
        _ => None,
    };
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("tools/call without a name")?
        .to_string();
    let state = app.state::<commands::AppState>();
    // Connected MCP tools are dispatched through the same routes the local agent
    // uses; empty unless this scope includes them. Enumerated ONCE and reused
    // for both the served-catalog check below and the dispatch further down —
    // it walks every connector's tool list under the `mcp` lock, and doing it
    // twice per call was pure duplicated work. No cancel flag here — the parent
    // run's own cancel already kills this whole client on Stop.
    let routes = if scope.include_mcp() {
        commands::mcp_routes(&state)
    } else {
        Vec::new()
    };
    // Only tools we actually advertise for this scope are callable. That guards
    // the cloud scope from the UI/job tools even if a client fabricates the name;
    // `consult_advisor` appears only when this exact top-level bridge carries an
    // AdvisorRuntime. Nested advisor bridges carry None, so a fabricated call
    // cannot recurse even though the tool is available to every primary model.
    if !served_tools_with(web_enabled, lanes, scope, advisor, &routes)
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
    // MCP says `arguments` is an object. A model can emit anything, and the CLI
    // forwards it verbatim, so normalise here: a non-object (a bare string, an
    // array, a number) becomes `{}` rather than reaching code that indexes it.
    // `serde_json`'s `IndexMut` PANICS on a non-object — `arguments["advisor"]`
    // below would have killed this connection task with no HTTP response.
    let arguments = params
        .get("arguments")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    // Placeholders in from the cloud client → real values for the room tools
    // (a search for "[Person A]" must find the actual name in the DB).
    let mut arguments = match &cloud_policy {
        Some(p) => p.redactor.restore_value(&arguments),
        None => arguments,
    };
    // `restore_value` maps a JSON value through the redactor; it preserves
    // shape, but the invariant this code depends on is worth asserting rather
    // than assuming across a module boundary.
    if !arguments.is_object() {
        arguments = serde_json::json!({});
    }
    if name == "consult_advisor" {
        let Some(runtime) = advisor else {
            return Err("unknown tool: consult_advisor".into());
        };
        let question = arguments
            .get("question")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if question.is_empty() {
            return Ok(tool_result(
                "consult_advisor requires a non-empty, self-contained question.".to_string(),
                true,
                Vec::new(),
            ));
        }
        let requested = arguments.get("advisor").and_then(|value| value.as_str());
        let chosen = match requested {
            Some("claude") if runtime.advisors.iter().any(|item| item == "claude-cli") => {
                "claude"
            }
            Some("codex") if runtime.advisors.iter().any(|item| item == "codex-cli") => "codex",
            Some(other) => {
                return Ok(tool_result(
                    format!("Advisor {other:?} is not installed or available for this turn."),
                    true,
                    Vec::new(),
                ));
            }
            None if runtime.advisors.iter().any(|item| item == "claude-cli") => "claude",
            None => "codex",
        };
        arguments["advisor"] = serde_json::Value::String(chosen.to_string());
        // SATURATING, not `fetch_add`. A consult is a slow, paid cloud call that
        // sends room text off the Mac, so the per-turn cap has to hold no matter
        // how hard a looping model leans on it — and `fetch_add` on an AtomicU8
        // WRAPS: after 256 refused calls the counter returned to 0 and the very
        // next one was allowed through for real.
        if runtime
            .calls
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_add(1))
            })
            .unwrap_or(u8::MAX)
            >= commands::MAX_ADVISOR_CALLS
        {
            return Ok(tool_result(
                "You have already consulted an advisor this turn. Use that answer instead of consulting again."
                    .to_string(),
                false,
                Vec::new(),
            ));
        }
    }
    if name == MCP_SEARCH_TOOL {
        let query = arguments
            .get("query")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if query.is_empty() {
            return Ok(tool_result(
                "search_mcp_tools requires a non-empty query.".to_string(),
                true,
                Vec::new(),
            ));
        }
        let connector = arguments.get("connector").and_then(|value| value.as_str());
        let entries = searchable_mcp_tools(&routes);
        let mut matches = search_mcp_entries(&entries, query, connector);
        // Say what was dropped rather than silently truncating: a model that
        // cannot see its tool is entitled to know a narrower query would find
        // it, instead of concluding the connector doesn't have one.
        let total = matches.len();
        matches.truncate(MAX_MCP_SEARCH_RESULTS);
        let next = if total > matches.len() {
            format!(
                "Showing the {} best of {total} matches — search again with more \
                 specific words if none fit. Then call run_mcp_tool with an exact \
                 tool id and arguments matching its inputSchema.",
                matches.len()
            )
        } else {
            "Call run_mcp_tool with an exact tool id and arguments matching its inputSchema."
                .to_string()
        };
        let text = serde_json::to_string_pretty(&serde_json::json!({
            "count": matches.len(),
            "total_matches": total,
            "matches": matches,
            "next": next,
        }))
        .map_err(|e| e.to_string())?;
        return Ok(tool_result(text, false, Vec::new()));
    }

    let (dispatch_name, dispatch_arguments) = if name == MCP_RUN_TOOL {
        let Some(target) = arguments.get("tool").and_then(|value| value.as_str()) else {
            return Ok(tool_result(
                "run_mcp_tool requires the exact tool id returned by search_mcp_tools."
                    .to_string(),
                true,
                Vec::new(),
            ));
        };
        if !routes.iter().any(|route| route.catalog_name == target) {
            return Ok(tool_result(
                format!(
                    "Unknown or disconnected room MCP tool: {target}. Search again with search_mcp_tools."
                ),
                true,
                Vec::new(),
            ));
        }
        (
            target.to_string(),
            arguments
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
    } else {
        (name, arguments)
    };
    let call = crate::ollama::ToolCall {
        name: dispatch_name,
        arguments: dispatch_arguments,
    };
    // `crate::main_window`, NOT `get_webview_window` — see its doc comment. This
    // is the dispatch point for EVERY tool the sidecar calls, and with the old
    // lookup opening the private browser turned every one of them into
    // "main window is gone" for the rest of the session.
    let window = crate::main_window(app).ok_or("main window is gone")?;
    // ADD-33: the LOCAL engine accumulates effects into the run-scoped sink so
    // `wrote`/`annotation`/`boxes` reach the post-answer gate; a cloud scope uses
    // a throwaway default (its effects are correctly discarded). The tokio guard
    // is held across the whole `exec_tool` await, serialising concurrent bridge
    // calls into the shared sink — the same one-effects-log-per-run the native
    // loop keeps. A top-level bridge may carry a nested Claude room bridge for
    // consult_advisor; that nested bridge has no AdvisorRuntime and therefore
    // cannot expose consult_advisor again.
    let (outcome, images) = match effects_sink {
        Some(sink) => {
            let mut effects = sink.lock().await;
            // Wave 2 (Idea 6): only the run-scoped LocalEngine sink lives for the
            // whole answer, so "Apply for the rest of this answer" is meaningful
            // here (and hidden for the sink-less cloud/external scopes below).
            effects.run_scoped = true;
            let outcome = commands::exec_tool(
                &state,
                &window,
                &call,
                &mut effects,
                &routes,
                &HashSet::new(),
                tool_cancel.clone(),
                advisor.and_then(|runtime| runtime.room_bridge.as_deref()),
                turn,
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
            // CHG-33: seed the web-search brake from the BRIDGE, not from this
            // throwaway. Without it a failed search raised the flag, the
            // `ToolEffects` carrying it was dropped at the end of this call,
            // and the model searched again — every round, forever.
            let was_throttled = web_throttled(web_throttle);
            effects.web_search_throttled = was_throttled;
            let outcome = commands::exec_tool(
                &state,
                &window,
                &call,
                &mut effects,
                &routes,
                &HashSet::new(),
                tool_cancel.clone(),
                advisor.and_then(|runtime| runtime.room_bridge.as_deref()),
                turn,
            )
            .await;
            if effects.web_search_throttled && !was_throttled {
                note_web_throttled(web_throttle);
            }
            let images: Vec<String> = effects.pending_images.drain(..).collect();
            (outcome, images)
        }
    };
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(msg) => (msg, true),
    };
    // Owner replacement #1, at `debug` because it fires per tool call: WHICH
    // tool the engine reached for and whether it worked. Off by default; this is
    // what you turn on when a turn is doing something inexplicable. The tool's
    // ARGUMENTS are room content (a filename, a query, a passage) and never
    // appear — only its name, its verdict and the size of what came back.
    // `call.name` rather than the requested name: for an `mcp_call` proxy those
    // differ, and the one worth recording is the tool that actually ran.
    crate::obs::tool_dispatched(scope.label(), &call.name, is_error, text.len(), turn);
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
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(body).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gate `dispatch_jsonrpc` applies: only `tools/call` is refused after
    /// Stop, and only when the run actually carries a flag.
    fn refuses(method: &str, cancel: Option<&AtomicBool>) -> bool {
        matches!(method, "tools/call") && cancel.is_some_and(|c| c.load(Ordering::SeqCst))
    }

    #[test]
    fn a_stopped_run_refuses_tool_calls_but_still_answers_tools_list() {
        // Owner decision 2026-08-03 (#7): Stop must block the WRITE, not just
        // sever its delivery. `serve_conn` only declined to return the result,
        // by which point the file had already been written — the code said so
        // itself ("the dispatch's side effects have already happened").
        let flag = AtomicBool::new(false);
        assert!(!refuses("tools/call", Some(&flag)), "a live run runs its tools");

        flag.store(true, Ordering::SeqCst);
        assert!(refuses("tools/call", Some(&flag)), "a stopped run does not");

        // …but the catalog is STILL served. Refusing `tools/list` would report an
        // empty catalog, which the Main agent now surfaces as "the room tool
        // bridge served 0 tools" — dressing a clean user Stop up as a wiring
        // failure, the exact misdiagnosis that made the v0.15.0 agent report
        // read as a capability regression.
        for m in ["initialize", "ping", "tools/list"] {
            assert!(!refuses(m, Some(&flag)), "{m} must still be answered");
        }

        // A bridge with no ask behind it (persistent Leash server, nested
        // advisor bridge) is never gated by someone else's Stop.
        assert!(!refuses("tools/call", None), "no ask, no gate");
    }

    #[test]
    fn a_tool_call_in_flight_carries_the_asks_stop_flag_to_its_commit_gate() {
        // The arrival gate above only refuses a call that STARTS after the Stop.
        // A `create_file` already running has to reach `Artifact::cancel_maybe`
        // holding a real flag, or "a Stop lands BEFORE the commit" is a comment
        // about nothing. It used to be fed `advisor.cancel` alone — and
        // `prepare_advisor_runtime` returns None whenever the room has no
        // Advisor configured, so in an ordinary room the funnel got `None` and
        // committed the artifact the user had already stopped.
        let ask = Arc::new(AtomicBool::new(false));

        let carried = tool_cancel_for(None, Some(&ask)).expect("no flag reached the commit gate");
        assert!(Arc::ptr_eq(&carried, &ask), "a different flag than the ask's");
        ask.store(true, Ordering::SeqCst);
        assert!(carried.load(Ordering::SeqCst), "the Stop did not reach the write");

        // An Advisor room is unchanged: its runtime holds this same ask's flag.
        let runtime = AdvisorRuntime::new(vec!["claude-cli".into()], ask.clone(), None);
        assert!(Arc::ptr_eq(
            &tool_cancel_for(Some(&runtime), None).expect("advisor flag"),
            &ask
        ));

        // A persistent Leash bridge has no ask behind it — and must not be
        // handed someone else's.
        assert!(tool_cancel_for(None, None).is_none());
    }

    #[test]
    fn the_web_search_brake_outlives_one_tool_call_but_not_the_session() {
        let brake: WebThrottle = Arc::new(std::sync::Mutex::new(None));
        assert!(!web_throttled(&brake));
        note_web_throttled(&brake);
        // Survives — the whole point: the throwaway `ToolEffects` a sink-less
        // scope builds per call used to drop this before the next search.
        assert!(web_throttled(&brake));

        // …and expires, so the Leash's session-long bridge is not left refusing
        // every search because one failed hours ago.
        *brake.lock().unwrap() =
            Some(std::time::Instant::now() - WEB_THROTTLE_COOLDOWN - std::time::Duration::from_secs(1));
        assert!(!web_throttled(&brake));
    }

    #[test]
    fn a_connector_call_is_not_advertised_as_destructive() {
        // One proxy now fronts EVERY connector, so a blanket destructive label
        // is a claim about tools it knows nothing about — and a non-interactive
        // `codex exec` refuses anything it cannot get confirmation for, which
        // left a Codex-engine room unable to call any connector at all.
        let run = mcp_proxy_tools()
            .into_iter()
            .find(|t| t["name"] == MCP_RUN_TOOL)
            .expect("run tool");
        assert_eq!(run["annotations"]["destructiveHint"], false);
        // Still honestly an action that reaches the outside world.
        assert_eq!(run["annotations"]["readOnlyHint"], false);
        assert_eq!(run["annotations"]["idempotentHint"], false);
        assert_eq!(run["annotations"]["openWorldHint"], true);
    }

    #[test]
    fn mcp_proxy_catalog_is_stable_and_searchable() {
        let tools = mcp_proxy_tools();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().any(|tool| tool["name"] == MCP_SEARCH_TOOL));
        assert!(tools.iter().any(|tool| tool["name"] == MCP_RUN_TOOL));

        let entries = vec![
            SearchableMcpTool {
                tool: "yahoo_finance_quote".into(),
                connector: "yahoo-finance".into(),
                name: "quote".into(),
                description: "Get current stock price and market data".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {"symbol": {"type": "string"}}
                }),
            },
            SearchableMcpTool {
                tool: "fetch_fetch".into(),
                connector: "fetch".into(),
                name: "fetch".into(),
                description: "Fetch a web page".into(),
                input_schema: serde_json::json!({"type": "object"}),
            },
        ];
        let finance = search_mcp_entries(&entries, "stock price", None);
        assert_eq!(finance.len(), 1);
        assert_eq!(finance[0].tool, "yahoo_finance_quote");
        let fetch = search_mcp_entries(&entries, "web", Some("fetch"));
        assert_eq!(fetch.len(), 1);
        assert_eq!(fetch[0].tool, "fetch_fetch");
        assert!(search_mcp_entries(&entries, "weather", None).is_empty());
    }

    #[test]
    fn a_broad_search_is_ranked_and_capped_not_a_whole_catalog() {
        // The proxy exists so a 60-tool connector costs nothing until it is
        // used. A search RESULT carries each match's full inputSchema, so an
        // uncapped broad query put the entire catalog back into one message —
        // the exact flood the proxy replaced.
        let entries: Vec<SearchableMcpTool> = (0..60)
            .map(|i| SearchableMcpTool {
                tool: format!("big_data_tool_{i:02}"),
                connector: "big".into(),
                name: format!("data_{i:02}"),
                description: "data data data".into(),
                input_schema: serde_json::json!({"type": "object"}),
            })
            .collect();
        let hits = search_mcp_entries(&entries, "data", None);
        assert_eq!(hits.len(), 60, "the ranking itself is not what caps");
        // The CAP lives at the call site, and it keeps the best-ranked head.
        let capped: Vec<_> = hits.into_iter().take(MAX_MCP_SEARCH_RESULTS).collect();
        assert_eq!(capped.len(), MAX_MCP_SEARCH_RESULTS);
        assert_eq!(capped[0].tool, "big_data_tool_00");
    }

    #[test]
    fn the_advisor_cap_cannot_be_worn_down_by_repetition() {
        // A consult is a slow, paid cloud call that sends room text off the Mac,
        // so the per-turn cap must hold however hard a looping model leans on
        // it. `fetch_add` on an AtomicU8 WRAPS: after 256 refusals the counter
        // returned to 0 and the next call went out for real.
        let runtime = AdvisorRuntime::new(
            vec!["claude-cli".into()],
            Arc::new(AtomicBool::new(false)),
            None,
        );
        let spend = || {
            runtime
                .calls
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                    Some(n.saturating_add(1))
                })
                .unwrap_or(u8::MAX)
                >= commands::MAX_ADVISOR_CALLS
        };
        // The one allowed consult…
        assert!(!spend(), "the first consult must go through");
        // …and every one after it, past the point a u8 would have wrapped.
        for i in 0..600 {
            assert!(spend(), "consult {i} slipped past the cap");
        }
        assert_eq!(runtime.calls.load(Ordering::SeqCst), u8::MAX);
    }

    #[test]
    fn advisor_tool_is_dynamic_and_not_part_of_any_base_scope() {
        let runtime = AdvisorRuntime::new(
            vec!["codex-cli".into()],
            Arc::new(AtomicBool::new(false)),
            None,
        );
        let tool = runtime.tool().expect("enabled advisor tool");
        assert_eq!(tool["name"], "consult_advisor");
        assert_eq!(
            tool["inputSchema"]["properties"]["advisor"]["enum"],
            serde_json::json!(["codex"])
        );
        assert_eq!(tool["annotations"]["openWorldHint"], true);

        // ToolScope never grants Advisor by itself. Only a per-turn runtime does,
        // so nested advisors and persistent external bridges stay recursion-safe.
        for scope in [
            ToolScope::CloudAdvisor { include_mcp: true },
            ToolScope::CloudEngine,
            ToolScope::LocalEngine,
            ToolScope::ExternalAgent,
        ] {
            assert!(!scoped_specs(false, scope)
                .iter()
                .any(|item| item["name"] == "consult_advisor"));
        }
    }

    #[test]
    fn an_unrecognised_advisor_serves_no_tool_instead_of_an_empty_enum() {
        // The day a THIRD cloud CLI is added, `advisors` is non-empty but maps
        // to no name: the old code emitted `"enum": []` — a parameter no value
        // can satisfy, on a tool still advertised as callable. Serve nothing.
        let runtime = AdvisorRuntime::new(
            vec!["future-cli".into()],
            Arc::new(AtomicBool::new(false)),
            None,
        );
        assert!(runtime.tool().is_none(), "an unknown CLI must serve no tool");
        assert!(commands::consult_advisor_spec(&["future-cli".to_string()]).is_none());
        // A known CLI alongside an unknown one still works, listing only the
        // one that can actually run.
        let mixed = commands::consult_advisor_spec(&[
            "future-cli".to_string(),
            "codex-cli".to_string(),
        ])
        .expect("a recognised CLI must still serve the tool");
        assert_eq!(
            mixed["function"]["parameters"]["properties"]["advisor"]["enum"],
            serde_json::json!(["codex"])
        );
    }

    #[test]
    fn every_served_tool_carries_annotations() {
        // The fourth parity assertion (2026-07-28). Name-parity between the
        // catalog, the dispatcher and BUILTIN_TOOL_NAMES is already pinned
        // three ways, but `arcelle_tool_annotations` ends in `_ => return None`
        // — so a tool added without an arm ships UNANNOTATED and silently: a
        // destructive verb arrives at a non-interactive Codex subprocess with
        // no `destructiveHint`, and nothing anywhere says so.
        //
        // Every tool, every tier, must be annotated.
        for web in [true, false] {
            for scope in [
                ToolScope::CloudAdvisor { include_mcp: true },
                ToolScope::CloudAdvisor { include_mcp: false },
                ToolScope::CloudEngine,
                ToolScope::LocalEngine,
                ToolScope::ExternalAgent,
            ] {
                for tool in scoped_specs(web, scope) {
                    let name = tool["name"].as_str().unwrap_or("<unnamed>");
                    let ann = &tool["annotations"];
                    assert!(
                        ann.is_object(),
                        "{name} ({scope:?}, web={web}) is served with no annotations — \
                         add an arm to arcelle_tool_annotations"
                    );
                    for hint in [
                        "readOnlyHint",
                        "destructiveHint",
                        "idempotentHint",
                        "openWorldHint",
                    ] {
                        assert!(
                            ann[hint].is_boolean(),
                            "{name} ({scope:?}) is missing {hint}"
                        );
                    }
                    // A read-only tool that also claims to be destructive is a
                    // contradiction the client cannot act on.
                    if ann["readOnlyHint"] == serde_json::json!(true) {
                        assert_eq!(
                            ann["destructiveHint"],
                            serde_json::json!(false),
                            "{name} is read-only AND destructive"
                        );
                    }
                }
            }
        }
    }

    /// Rough token count for a served catalog: ~4 chars per token is the usual
    /// English approximation and is the right precision here — this guards an
    /// order of magnitude, not a byte.
    fn approx_tokens(specs: &[serde_json::Value]) -> usize {
        specs
            .iter()
            .map(|s| serde_json::to_string(s).map(|t| t.len()).unwrap_or(0))
            .sum::<usize>()
            / 4
    }

    #[test]
    fn each_tier_catalog_stays_inside_its_token_budget() {
        // Context caps are engine-blind: the same catalog is sent to a room
        // whose local window is 8k and to codex-cli's 272k. On the small end
        // the catalog is a real fraction of the whole budget, and a catalog
        // that quietly regrows is how a 4B starts context-shifting mid-turn
        // and answering "Done." to work it never did.
        //
        // MEASURED 2026-07-28, web enabled (the larger case), after moving the
        // workflow node grammar out of `save_workflow`'s description:
        //   CloudAdvisor  26 tools  ~4.2k    CloudEngine    46 tools  ~7.3k
        //   ExternalAgent 43 tools  ~7.0k    LocalEngine    49 tools  ~7.8k
        //
        // RE-MEASURED 2026-08-03, after `include_ui_tools` was opened to the
        // cloud and external tiers (owner decision: every provider gets full
        // control, the interface included):
        //   CloudAdvisor  4,267    CloudEngine   9,450
        //   ExternalAgent 9,161    LocalEngine   9,297
        //
        // The three UI tools cost ~350 tokens, and CloudEngine/ExternalAgent
        // budgets are raised to cover exactly that (+9,100 -> 9,900, 8,800 ->
        // 9,600) — NOT to create new headroom. Two things are worth noticing in
        // those numbers: the tiers have crept much closer to their ceilings than
        // the 2026-07-28 note suggests, and CloudEngine is now the LARGEST
        // catalog, because it carries `view_media_frame` from
        // `include_media_perception` on top of the screen tools the local tier
        // gets through this gate. The next wave that grows any tier should spend
        // its effort shrinking descriptions rather than raising these again.
        //
        // RE-MEASURED 2026-08-07, after the File agent's ORGANIZE box
        // (`organize_files`, `trash_files`, `merge_files` — see
        // `include_organize_tools`):
        //   CloudAdvisor  4,458    CloudEngine  10,453
        //   ExternalAgent 10,163   LocalEngine  10,300
        //
        // The three tools cost ~1,000 tokens across the three engine tiers, and
        // those three budgets are raised by ~700 each to sit ~2% clear rather
        // than the ~25% the note above describes. That is a deliberate
        // tightening, not headroom: the next addition to any of these tiers has
        // to trip this test immediately.
        //
        // The previous note's advice — shrink rather than raise — WAS tried
        // first and rejected on the evidence. The longest descriptions in the
        // catalog (`save_skill`, `edit_file`, `create_file`, `start_file_pass`)
        // are each mostly one hard-won rule: create_file's is the whole
        // "self-contained HTML, never a CDN" paragraph that exists because
        // charts silently rendered blank without it. Cutting those to make room
        // would buy catalog size by re-introducing shipped bugs, which is a
        // worse trade than 700 tokens. CloudAdvisor is untouched and still sits
        // 16% clear — the advisor tier does not get this box at all.
        //
        // This is the BRIDGE catalog — what a cloud CLI or external agent sees
        // whole. An in-room worker is narrowed to its box first (`toolbox_for`
        // in the sidecar), so it never carries all of this; the tiers that do
        // are the ones with big windows. The budgets below sit ~25% above the
        // measurement: ordinary tool work never trips them, while a change that
        // meaningfully grows the catalog has to come here and say so out loud.
        // Lower them when a wave makes real headroom; never raise one without
        // measuring the window it eats.
        // EVERY tier is measured and PRINTED before any of them is asserted.
        // Failing on the first one over budget told you one number and hid the
        // other three, so re-measuring after a change that touches the catalog
        // meant editing this test, running it, and editing it back. The whole
        // table is what the comment above has to be updated from, so the test
        // hands it over. (`cargo test -- --nocapture each_tier` to read it.)
        // Raised by ~40 for `read_recording` (2026-08-07): the room reads
        // recordings automatically, and the tool is what lets it be asked for
        // in words — "make chapters for this meeting", "what did we decide".
        // Its description is already cut to one sentence plus its precondition;
        // the remaining cost is the tool existing at all, which is the point.
        // RE-MEASURED 2026-08-13, after the Sketch page's drawing box (`draw`,
        // `read_drawing` — see `include_job_tools`):
        //   CloudAdvisor  4,473    CloudEngine  10,964
        //   ExternalAgent 10,674   LocalEngine  10,811
        //
        // Two tools, ~300 tokens across the three engine tiers, and the three
        // budgets go up by exactly that. The shrink-first advice above WAS
        // followed and is most of why the number is 300 rather than 900:
        //  - the script grammar was cut to seven lines and its worked example
        //    deleted, because the full grammar is returned by
        //    `sketchdoc::SCRIPT_HELP` the first time a script fails to parse
        //    and is repeated in the drawing agent's own prompt — both of which
        //    cost nothing on a turn that never draws;
        //  - a third tool was removed outright. `see_drawing` returned the same
        //    text as `read_drawing` with a picture attached, which is both ~150
        //    tokens and the kind of near-duplicate a 4B picks between wrongly.
        //    Reading a drawing and looking at one are now one act.
        // What is left is the cost of the capability existing, which is the
        // point. CloudAdvisor is untouched: an advisor cannot draw.
        //
        // RE-MEASURED 2026-08-15, after `set_in_library` (the contextual-
        // navigation work): one tool, ~155 tokens on the three engine tiers,
        // and the three budgets go up by exactly that.
        //
        // It has to exist as a TOOL rather than as a rule in the prompt: the
        // whole point of section-only is that promotion is an explicit act with
        // a name, reported in Activity, that the user asked for. A model that
        // could only describe the promotion in prose would either not do it
        // when asked, or "do" it and be believed. The description is already
        // one sentence plus the never-automatically rule, which is the part
        // that stops it becoming the default ending of every generation.
        let measured: Vec<(ToolScope, usize, usize)> = [
            (ToolScope::CloudAdvisor { include_mcp: true }, 5_300usize),
            (ToolScope::CloudEngine, 11_130),
            (ToolScope::LocalEngine, 10_975),
            (ToolScope::ExternalAgent, 10_840),
        ]
        .into_iter()
        .map(|(scope, budget)| (scope, approx_tokens(&scoped_specs(true, scope)), budget))
        .collect();
        for (scope, tokens, budget) in &measured {
            println!("{:<14} {tokens:>6} / {budget}", scope.label());
        }
        for (scope, tokens, budget) in &measured {
            assert!(
                tokens <= budget,
                "{scope:?} catalog is ~{tokens} tokens, over its {budget} budget — \
                 if this growth is intended, raise the budget here and say why"
            );
        }
    }

    #[test]
    fn the_workflow_grammar_is_not_in_the_always_served_description() {
        // The 2,668-char node DSL used to live in `save_workflow`'s own
        // description, so every turn that served the workflow tier paid for the
        // whole grammar whether or not the model was authoring anything. It now
        // rides the `list_workflows` RESULT — the free probe the Workflow
        // agent's flow fires first — so it arrives once per task instead.
        let save = scoped_specs(false, ToolScope::LocalEngine)
            .into_iter()
            .find(|t| t["name"] == "save_workflow")
            .expect("save_workflow is served to LocalEngine");
        let desc = save["description"].as_str().unwrap();
        assert!(
            desc.len() < 1_000,
            "save_workflow's description is back up to {} chars",
            desc.len()
        );
        // The grammar's distinctive tokens must be gone from the description...
        for marker in ["dedupe_lines", "missing_summary", "strip_html", "plan_and_map"] {
            assert!(!desc.contains(marker), "{marker} is back in the description");
        }
        // ...but the iteration contract it must NOT lose stays put.
        assert!(desc.contains("VALIDATED: yes"));
        assert!(desc.contains("DRAFT"));
        // ...and the description must point at where the grammar now lives.
        assert!(desc.contains("list_workflows"), "the model must be told where to look");

        // The reference itself is complete, wherever it is served from.
        let reference = crate::commands::WORKFLOW_NODE_REFERENCE;
        for marker in [
            "dedupe_lines",
            "missing_summary",
            "strip_html",
            "plan_and_map",
            "run_input",
            "{{files}}",
        ] {
            assert!(reference.contains(marker), "{marker} missing from the node reference");
        }
    }

    #[test]
    fn the_mcp_proxy_pair_is_annotated_too() {
        // These bypass `to_mcp_tool` (they are already MCP-shaped), so the
        // sweep above cannot see them — assert them directly.
        for tool in mcp_proxy_tools() {
            let name = tool["name"].as_str().unwrap();
            for hint in [
                "readOnlyHint",
                "destructiveHint",
                "idempotentHint",
                "openWorldHint",
            ] {
                assert!(
                    tool["annotations"][hint].is_boolean(),
                    "{name} is missing {hint}"
                );
            }
        }
    }

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

    /// The published provider × agent matrix asks this function what a tier may
    /// ever serve, and the sidecar turns the answer into a list of AGENTS. So a
    /// tool name missing here is not a cosmetic gap: it prints as a hard "✕" in
    /// a table shown to the user.
    ///
    /// The Connector agent's whole box is the proxy pair, which the live bridge
    /// only attaches once a connector exists. That is a fact about the ROOM, not
    /// about the tier — and omitting it made every provider's row claim the
    /// Connector agent works nowhere. Pinned in both directions: a tier that may
    /// serve connectors offers the pair, a consulted advisor without the
    /// sub-option does not.
    #[test]
    fn a_tier_that_may_serve_connectors_says_so_in_the_matrix() {
        for scope in [
            ToolScope::LocalEngine,
            ToolScope::CloudEngine,
            ToolScope::ExternalAgent,
            ToolScope::CloudAdvisor { include_mcp: true },
        ] {
            let names = tier_tool_names(true, scope);
            assert!(
                names.iter().any(|n| n == MCP_SEARCH_TOOL)
                    && names.iter().any(|n| n == MCP_RUN_TOOL),
                "{scope:?} may serve connectors, so the matrix must see the proxy pair"
            );
        }
        let advisor = tier_tool_names(true, ToolScope::CloudAdvisor { include_mcp: false });
        assert!(!advisor.iter().any(|n| n == MCP_RUN_TOOL));
    }

    /// Write the FULL served catalog — every tool, with its real description
    /// and inputSchema — to a checked-in JSON snapshot.
    ///
    /// Two jobs in one file. It pins the catalog against silent drift (a
    /// renamed tool or a changed schema fails this test), and it is the only
    /// way the offline dataset builder in `sidecar/devtools/dataset/` can see
    /// real schemas: that builder has no AppHandle and no running room, and
    /// fabricating `"<name> — see the room tool catalog"` with empty parameters
    /// produced training rows whose tool specs did not match inference.
    ///
    /// Regenerate deliberately: `UPDATE_TOOL_SNAPSHOT=1 cargo test tool_catalog_snapshot`.
    #[test]
    fn tool_catalog_snapshot_is_current() {
        // The union of every scope, so the snapshot is a superset of any one
        // agent's box. LocalEngine is the widest single scope but does not
        // carry `local_generate` (ExternalAgent's alone).
        let mut all = scoped_specs(true, ToolScope::LocalEngine);
        // …plus the connector proxy pair, which `scoped_specs` omits because it
        // is added per-room only when a connector is actually installed. A
        // room with connectors is the normal case for these agents, so a
        // catalog without them would leave `connectors.use` unschema'd.
        let rest = scoped_specs(true, ToolScope::ExternalAgent)
            .into_iter()
            .chain(mcp_proxy_tools());
        for spec in rest {
            if !all.iter().any(|t| t["name"] == spec["name"]) {
                all.push(spec);
            }
        }
        all.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

        let rendered = serde_json::to_string_pretty(&all).expect("catalog serialises");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sidecar/devtools/dataset/tool_catalog.json");
        if std::env::var("UPDATE_TOOL_SNAPSHOT").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).expect("snapshot dir");
            std::fs::write(&path, format!("{rendered}\n")).expect("write snapshot");
            return;
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            on_disk.trim(),
            rendered.trim(),
            "tool catalog drifted from {}; regenerate with UPDATE_TOOL_SNAPSHOT=1",
            path.display()
        );
    }

    /// The two per-agent web switches (owner decision 2026-07-30).
    ///
    /// The mechanism under test is deliberately indirect: a lane being off just
    /// removes its tools from the served catalog, and the sidecar's
    /// `worker_reachable` (which requires a worker's box to intersect that
    /// catalog) does the rest. So what has to be true here is exactly "the tools
    /// are gone, and ONLY those tools" — plus, critically, that `tools/call`
    /// agrees with `tools/list`, since both go through `served_tools_with`.
    /// Owner replacement #1. The failure this exists for: a bridge that served
    /// an empty catalog produced no evidence of having done so, and the only
    /// account of it came from the model — which invented a reason instead of
    /// reporting the emptiness. The catalog now lands in the host log with its
    /// tier, its size and its names, none of which a model can narrate over.
    #[test]
    fn the_catalog_an_engine_is_served_is_recorded_with_its_tier() {
        use commands::WebLanes;
        let served = |scope| served_tools_with(true, WebLanes::ALL, scope, None, &[]);
        let turn = crate::turn::TurnId::new("run42", "chat7");

        let local = served(ToolScope::LocalEngine);
        let (_, log) = crate::obs::capture(|| {
            log_catalog(ToolScope::LocalEngine, &local, Some(&turn))
        });
        assert!(log.contains("tools.catalog run=run42 chat=chat7"), "{log}");
        assert!(log.contains("scope=LocalEngine"), "{log}");
        assert!(log.contains(&format!("served={}", local.len())), "{log}");
        // The names, not just the count: "23 tools" would not have caught a
        // bridge that served the wrong TIER's 23 tools.
        for n in ["open_file", "web_search"] {
            assert!(log.contains(n), "{n} missing from the recorded catalog: {log}");
        }

        // The tier is part of the record, and every tier has a distinct name —
        // the two cloud tiers differ only by a sub-option and used to be one.
        let mut labels = std::collections::HashSet::new();
        for scope in [
            ToolScope::CloudAdvisor { include_mcp: true },
            ToolScope::CloudAdvisor { include_mcp: false },
            ToolScope::CloudEngine,
            ToolScope::LocalEngine,
            ToolScope::ExternalAgent,
        ] {
            assert!(labels.insert(scope.label()), "{:?} shares a label", scope);
        }

        // An EMPTY catalog is the whole point: it must read as empty, not as
        // silence. (No scope really serves nothing, so this is asserted on the
        // recorder directly.)
        let (_, log) = crate::obs::capture(|| log_catalog(ToolScope::CloudEngine, &[], None));
        assert!(log.contains("scope=CloudEngine served=0 names=[]"), "{log}");
    }

    #[test]
    fn each_web_lane_can_be_switched_off_independently() {
        use commands::WebLanes;
        let names = |lanes: WebLanes| -> Vec<String> {
            served_tools_with(true, lanes, ToolScope::LocalEngine, None, &[])
                .into_iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .collect()
        };
        // The download verbs are part of the Web agent's box (the sidecar boxes
        // them on `chat.web` alone), so they belong to the SEARCH lane. While
        // they did not, "Web agent off" still left the room able to save a
        // link, download a file and download a video — and left the agent
        // itself reachable, because its box still intersected the catalog.
        let search_tools: Vec<&str> = ["web_search", "fetch_page"]
            .into_iter()
            .chain(commands::DOWNLOAD_TOOL_NAMES.iter().copied())
            .collect();
        let search_tools = search_tools.as_slice();
        let both = names(WebLanes::ALL);
        for n in search_tools.iter().chain(commands::BROWSE_TOOL_NAMES.iter()) {
            assert!(both.contains(&n.to_string()), "{n} missing with both lanes on");
        }

        // Search off: the Web agent's box goes, the browser's stays.
        let no_search = names(WebLanes { search: false, browse: true });
        for n in search_tools {
            assert!(!no_search.contains(&n.to_string()), "{n} survived search=off");
        }
        for n in commands::BROWSE_TOOL_NAMES {
            assert!(no_search.contains(&n.to_string()), "{n} lost to an unrelated lane");
        }

        // Browser off: the mirror image.
        let no_browse = names(WebLanes { search: true, browse: false });
        for n in commands::BROWSE_TOOL_NAMES {
            assert!(!no_browse.contains(&n.to_string()), "{n} survived browse=off");
        }
        for n in search_tools {
            assert!(no_browse.contains(&n.to_string()), "{n} lost to an unrelated lane");
        }

        // Both off is a room with no web AGENTS but still a working room: the
        // rest of the catalog must be untouched, or this would be
        // indistinguishable from flipping the master switch.
        let neither = names(WebLanes { search: false, browse: false });
        for n in search_tools.iter().chain(commands::BROWSE_TOOL_NAMES.iter()) {
            assert!(!neither.contains(&n.to_string()), "{n} survived both lanes off");
        }
        for core in ["list_room_files", "search_room", "open_file"] {
            assert!(neither.contains(&core.to_string()), "{core} must not depend on a web lane");
        }
        assert!(
            neither.len() + search_tools.len() + commands::BROWSE_TOOL_NAMES.len() == both.len(),
            "turning the lanes off removed something other than the two web boxes"
        );
    }

    /// A lane that is off must not merely be UNADVERTISED — it must be
    /// unexecutable. `tools/call` name-checks against `served_tools_with`, so
    /// this pins that the two use the same predicate rather than drifting into
    /// "hidden but still callable", which is how a privacy switch becomes a lie.
    #[test]
    fn a_switched_off_lane_is_not_callable_either() {
        use commands::WebLanes;
        for (lanes, blocked) in [
            (WebLanes { search: false, browse: true }, "web_search"),
            // The download verbs are the Web agent's too: unadvertised AND
            // unexecutable, or "Web agent off" is a claim the room breaks.
            (WebLanes { search: false, browse: true }, "save_link"),
            (WebLanes { search: false, browse: true }, "download_media"),
            (WebLanes { search: true, browse: false }, "browse_open"),
        ] {
            let served = served_tools_with(true, lanes, ToolScope::LocalEngine, None, &[]);
            assert!(
                !served
                    .iter()
                    .any(|t| t["name"].as_str() == Some(blocked)),
                "{blocked} is still in the catalog tools/call validates against"
            );
            assert!(lanes.blocks(blocked), "{blocked} must be reported as lane-blocked");
        }
    }

    /// The composer's `*` specialist menu is built from the names this room's
    /// bridge would ACTUALLY serve, not from the tier's ceiling.
    ///
    /// Why that distinction is the whole point: the sidecar decides which
    /// specialists exist by intersecting each agent's box with the served
    /// names. Fed `tier_tool_names` (pure tier truth) the menu would keep
    /// offering the Web and Browser agents in a room whose owner had switched
    /// those lanes off — and tagging one would then be refused by the very
    /// turn the menu promised. Same predicate, same answer, both directions.
    #[test]
    fn the_specialist_menu_sees_the_rooms_own_lanes_not_the_tiers_ceiling() {
        use commands::WebLanes;
        let ceiling = tier_tool_names(true, ToolScope::LocalEngine);
        assert!(ceiling.iter().any(|n| n == "web_search"));
        assert!(ceiling.iter().any(|n| n == "browse_open"));

        let both = room_tool_names_with(true, WebLanes::ALL, ToolScope::LocalEngine, &[]);
        assert!(both.iter().any(|n| n == "web_search"));
        assert!(both.iter().any(|n| n == "browse_open"));

        let off = room_tool_names_with(
            true,
            WebLanes { search: false, browse: false },
            ToolScope::LocalEngine,
            &[],
        );
        assert!(
            !off.iter().any(|n| n == "web_search" || n == "browse_open"),
            "a switched-off lane still reaches the specialist menu: {off:?}"
        );
        // The room's own content tools are untouched — the menu must not lose
        // the File specialist because the internet lanes are off.
        assert!(off.iter().any(|n| n == "search_room"));
    }

    /// BROWSE-1: the private browser rides the room's single internet switch.
    ///
    /// Live QA 2026-07-29: the first browser test failed with "this room does
    /// not have a tool … to browse the live internet" — which was CORRECT (the
    /// room was offline) but proved nothing about the wiring. This pins both
    /// halves so the honest refusal and the working case are each a test.
    #[test]
    fn browse_tools_follow_the_rooms_internet_switch() {
        for scope in [ToolScope::LocalEngine, ToolScope::CloudEngine, ToolScope::ExternalAgent] {
            let off: Vec<_> = scoped_specs(false, scope)
                .into_iter()
                .filter(|t| t["name"].as_str().is_some_and(|n| n.starts_with("browse_")))
                .collect();
            assert!(off.is_empty(), "{scope:?} advertises browsing in an OFFLINE room");

            let on: Vec<String> = scoped_specs(true, scope)
                .into_iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .filter(|n| n.starts_with("browse_"))
                .collect();
            for name in commands::BROWSE_TOOL_NAMES {
                assert!(
                    on.iter().any(|n| n == name),
                    "{scope:?} is missing {name} with the internet ON"
                );
            }
        }
        // A merely CONSULTED advisor never gets them, on or off: driving a
        // browser is an action, not advice.
        for include_mcp in [true, false] {
            let advisor = scoped_specs(true, ToolScope::CloudAdvisor { include_mcp });
            assert!(
                !advisor.iter().any(|t| t["name"]
                    .as_str()
                    .is_some_and(|n| n.starts_with("browse_"))),
                "a consulted advisor must never be able to drive the browser"
            );
        }
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
        assert!(builtin_mcp_tools(true)
            .iter()
            .any(|t| t["name"] == "web_search"));
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
        for name in [
            "local_generate",
            "start_file_pass",
            "job_status",
            "view_media_frame",
        ] {
            assert!(
                !cloud.iter().any(|t| t["name"] == name),
                "{name} leaked to cloud"
            );
        }
    }

    #[test]
    fn arcelle_tools_publish_codex_approval_hints() {
        let tools = builtin_mcp_tools(true);
        let read = tools
            .iter()
            .find(|t| t["name"] == "list_room_files")
            .unwrap();
        assert_eq!(read["annotations"]["readOnlyHint"], true);
        assert_eq!(read["annotations"]["idempotentHint"], true);
        assert_eq!(read["annotations"]["destructiveHint"], false);
        assert_eq!(read["annotations"]["openWorldHint"], false);

        let write = tools.iter().find(|t| t["name"] == "create_file").unwrap();
        assert_eq!(write["annotations"]["readOnlyHint"], false);
        assert_eq!(write["annotations"]["destructiveHint"], false);
        assert_eq!(write["annotations"]["openWorldHint"], false);

        let web = tools.iter().find(|t| t["name"] == "web_search").unwrap();
        assert_eq!(web["annotations"]["readOnlyHint"], true);
        assert_eq!(web["annotations"]["openWorldHint"], true);

        // Every Arcelle-owned tool exposed to any bridge tier must be classified.
        // An unclassified future tool deliberately has no annotations and will
        // fail closed in non-interactive Codex until its safety is reviewed.
        for scope in [
            ToolScope::CloudAdvisor { include_mcp: false },
            ToolScope::CloudEngine,
            ToolScope::LocalEngine,
            ToolScope::ExternalAgent,
        ] {
            for tool in scoped_specs(true, scope) {
                assert!(
                    tool["annotations"].is_object(),
                    "{} is missing MCP safety annotations",
                    tool["name"].as_str().unwrap_or("<unnamed>")
                );
            }
        }
    }

    #[test]
    fn connected_tool_annotations_are_preserved_but_sanitized() {
        let spec = serde_json::json!({"type": "function", "function": {
            "name": "connector_lookup",
            "description": "Look something up",
            "parameters": {"type": "object", "properties": {}},
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "openWorldHint": true,
                "vendorSecret": "must not be forwarded"
            }
        }});
        let tool = to_mcp_tool(&spec, false).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool["annotations"]["destructiveHint"], false);
        assert_eq!(tool["annotations"]["openWorldHint"], true);
        assert!(tool["annotations"].get("vendorSecret").is_none());

        let unknown = serde_json::json!({"type": "function", "function": {
            "name": "unknown_tool", "parameters": {"type": "object"}
        }});
        assert!(to_mcp_tool(&unknown, false)
            .unwrap()
            .get("annotations")
            .is_none());
    }

    #[test]
    fn external_scope_serves_job_and_generate_tools() {
        // Wave 1a: the ExternalAgent tier = file tools + job tools +
        // local_generate + the content-perception view_media_frame…
        let ext = scoped_specs(false, ToolScope::ExternalAgent);
        for name in [
            "list_room_files",
            "start_file_pass",
            "job_status",
            "local_generate",
            "view_media_frame",
        ] {
            assert!(
                ext.iter().any(|t| t["name"] == name),
                "{name} missing from external tier"
            );
        }
        // …and the screen tools too, as of 2026-08-03 (owner: every provider
        // gets full control). `perceive_image` still withholds the pixels from a
        // non-vision model, so this grants the ABILITY TO ACT, not a view of the
        // user's screen.
        for name in ["ui_act", "ui_snapshot", "view_screenshot"] {
            assert!(
                ext.iter().any(|t| t["name"] == name),
                "{name} missing from external tier"
            );
        }
        // …and NEVER connector CRUD or consult_advisor: configuring connectors
        // can start local programs, and advice is not the external tier's job.
        for name in [
            "consult_advisor",
            "list_mcps",
            "save_mcp",
            "delete_mcp",
        ] {
            assert!(
                !ext.iter().any(|t| t["name"] == name),
                "{name} leaked to external tier"
            );
        }
        // The local engine keeps its full set but has no local_generate — it
        // IS the local model already.
        let local = scoped_specs(false, ToolScope::LocalEngine);
        for name in [
            "ui_act",
            "ui_snapshot",
            "view_screenshot",
            "view_media_frame",
            "start_file_pass",
            "job_status",
            "list_mcps",
            "read_mcp",
            "save_mcp",
            "delete_mcp",
        ] {
            assert!(
                local.iter().any(|t| t["name"] == name),
                "{name} missing from local tier"
            );
        }
        assert!(!local.iter().any(|t| t["name"] == "local_generate"));

        // Wave 4a: the workflow authoring tools ride the job-tools trust class —
        // served to LocalEngine and ExternalAgent, NEVER to a cloud advisor.
        let wf_names = [
            "list_workflows",
            "save_workflow",
            "update_workflow",
            "delete_workflow",
            "run_workflow",
            "test_workflow",
        ];
        for name in wf_names {
            assert!(
                local.iter().any(|t| t["name"] == name),
                "{name} missing from local tier"
            );
            assert!(
                ext.iter().any(|t| t["name"] == name),
                "{name} missing from external tier"
            );
        }
        let cloud = scoped_specs(false, ToolScope::CloudAdvisor { include_mcp: true });
        for name in wf_names {
            assert!(
                !cloud.iter().any(|t| t["name"] == name),
                "{name} leaked to cloud"
            );
        }
    }

    #[test]
    fn cloud_engine_matches_the_local_tier_exactly() {
        // Owner decision 2026-07-25: a cloud CLI chosen as the ROOM'S engine is
        // the main agent, so it does what the local engine does. Live QA found
        // the opposite — it shared the consulted-advisor tier, so no jobs,
        // workflows, scripts, studio or transcription reached it and the model
        // silently substituted a disabled draft skill for a requested workflow.
        //
        // 2026-08-03 the LAST gap closed too: the screen tools. The owner's rule
        // is that every provider gets full control, the interface included, and
        // the privacy reason for the old carve-out does not survive contact with
        // how the tools actually work — `view_screenshot`/`ui_snapshot` hand
        // their pixels to `perceive_image`, which withholds the frame from a
        // non-vision cloud model and has a LOCAL model describe it instead. The
        // screen never left the Mac before this change and still does not.
        let engine = scoped_specs(false, ToolScope::CloudEngine);
        let local = scoped_specs(false, ToolScope::LocalEngine);
        // The room's own engine always sees its connected connectors.
        assert!(ToolScope::CloudEngine.include_mcp());
        let name_set = |list: &[serde_json::Value]| -> std::collections::BTreeSet<String> {
            list.iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .collect()
        };
        // Parity is asserted as a SET DIFFERENCE, not a checklist: a future tool
        // added to the local tier must either reach the cloud engine too or be
        // named here as a deliberate gap.
        let missing: Vec<String> = name_set(&local)
            .difference(&name_set(&engine))
            .cloned()
            .collect();
        assert_eq!(
            missing,
            Vec::<String>::new(),
            "the room's own cloud engine must now match the local tier exactly — \
             a tool the local engine has and this one does not is a regression"
        );
        // The domains live QA lost, spelled out.
        for name in [
            "start_file_pass",
            "job_status",
            "run_workflow",
            "save_workflow",
            "list_scripts",
            "run_script",
            "studio_flashcards",
            "generate_podcast_script",
            "stt_status",
            "retranscribe_file",
            "list_mcps",
            "save_mcp",
            // Room-video pixels are CONTENT, not the screen — and a cloud
            // engine gets them as a locally-generated text description, never
            // as an image (see `include_media_perception`).
            "view_media_frame",
        ] {
            assert!(
                engine.iter().any(|t| t["name"] == name),
                "{name} missing from the cloud-engine tier"
            );
        }
        // The screen tools are the room engine's too now, and the screen still
        // never leaves the machine — `perceive_image` withholds the frame from a
        // non-vision cloud model and a LOCAL model describes it instead.
        for name in ["ui_act", "ui_snapshot", "view_screenshot"] {
            assert!(
                engine.iter().any(|t| t["name"] == name),
                "{name} missing from the cloud-engine tier"
            );
        }
        // `local_generate` stays out: it exists so an EXTERNAL orchestrator can
        // reach the local model. The room's own engine IS the model.
        assert!(
            !engine.iter().any(|t| t["name"] == "local_generate"),
            "local_generate leaked to the cloud-engine tier"
        );
        // The split is the whole point: a merely CONSULTED advisor keeps the
        // narrow tier it always had.
        let advisor = scoped_specs(false, ToolScope::CloudAdvisor { include_mcp: true });
        for name in ["start_file_pass", "run_workflow", "run_script", "save_mcp"] {
            assert!(
                !advisor.iter().any(|t| t["name"] == name),
                "{name} leaked to a consulted advisor"
            );
        }
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_before_it_is_read_and_before_the_token() {
        // The head block was capped; the BODY was read to whatever
        // Content-Length claimed, and the bearer token is only checked
        // afterwards. Anything already running on this Mac could declare a
        // 100 GB body — with no token at all — and push bytes into a Vec until
        // the app ran out of memory.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let dispatched = Arc::new(AtomicBool::new(false));
        let saw = dispatched.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = serve_conn(stream, "tok".into(), rx, move |_body: Vec<u8>| {
                let saw = saw.clone();
                async move {
                    saw.store(true, Ordering::SeqCst);
                    (200u16, b"{}".to_vec())
                }
            })
            .await;
        });
        // No Authorization header at all, and a declared body far past the cap.
        let head = format!(
            "POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_REQUEST_BODY + 1
        );
        let mut conn = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        conn.write_all(head.as_bytes()).await.unwrap();
        // Deliberately send only a token amount of the promised body: the
        // refusal must come from the DECLARATION, not from reading it all.
        conn.write_all(&[b'x'; 64]).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            conn.read(&mut buf),
        )
        .await
        .expect("an oversized request must be answered, not absorbed")
        .unwrap();
        assert!(
            std::str::from_utf8(&buf[..n]).unwrap().starts_with("HTTP/1.1 413"),
            "expected 413, got {:?}",
            String::from_utf8_lossy(&buf[..n])
        );
        assert!(
            !dispatched.load(Ordering::SeqCst),
            "an unauthenticated oversized request must never reach the dispatcher"
        );
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
            std::str::from_utf8(&buf[..n])
                .unwrap()
                .starts_with("HTTP/1.1 200"),
            "first request on the live connection must be served"
        );
        // Stop. The SAME socket: the write may land in the OS buffer, but no
        // response ever comes back — the connection is severed (EOF/reset),
        // never served once more with its captured scope and token.
        tx.send(true).unwrap();
        let _ = conn.write_all(head.as_bytes()).await;
        let _ = conn.write_all(body).await;
        let mut rest = Vec::new();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            conn.read_to_end(&mut rest),
        )
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


