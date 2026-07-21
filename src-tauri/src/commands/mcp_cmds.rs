use super::*;

#[tauri::command]
pub fn mcp_get_config(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })
}

#[tauri::command]
pub fn mcp_apply_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    json: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let servers = mcp::parse_config(&json)?;
    state.with_room(|room| db::set_setting(&room.conn, MCP_CONFIG_KEY, &json))?;
    // SEC-1: the user just typed and saved this config, which counts as
    // approval — remember its fingerprint so reopening the room won't re-ask.
    add_mcp_approval(&app, &mcp_fingerprint(&json));
    start_mcp_connections(app, servers);
    Ok(state.mcp.lock().unwrap().statuses())
}

/// SEC-1: SHA-256 of the room's mcp_config JSON, hex-encoded. Any change to the
/// config text changes the fingerprint, so an old approval no longer counts.
pub(crate) fn mcp_fingerprint(config_json: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(config_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// SEC-1: what a server would do, shown in the approval dialog so the user sees
/// exactly what they're allowing. Local: the full command line, e.g.
/// "uvx duckduckgo-mcp-server". Remote: the endpoint it would reach, flagged so
/// the dialog can distinguish "start a program" from "reach a service".
pub(crate) fn render_command_line(cfg: &mcp::ServerConfig) -> String {
    match &cfg.transport {
        mcp::Transport::Stdio { command, args, .. } => {
            let mut parts = Vec::with_capacity(1 + args.len());
            parts.push(command.clone());
            parts.extend(args.iter().cloned());
            parts.join(" ")
        }
        mcp::Transport::Http { url, .. } => format!("{url}  (remote — reaches the internet)"),
    }
}

/// Approved MCP fingerprints live OUTSIDE any room, in the app's own data
/// folder — the room's author is the attacker, so approvals are per-Mac and
/// never travel inside the `.roomai` file (SEC-1).
pub(crate) fn mcp_approvals_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp_approvals.json"))
}

pub(crate) fn read_mcp_approvals(app: &tauri::AppHandle) -> Vec<String> {
    mcp_approvals_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn add_mcp_approval(app: &tauri::AppHandle, fingerprint: &str) {
    let mut list = read_mcp_approvals(app);
    if list.iter().any(|f| f == fingerprint) {
        return;
    }
    list.push(fingerprint.to_string());
    if let Ok(path) = mcp_approvals_file(app) {
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// SEC-1: the spawn/approval decision for a room's MCP config, decided PURELY
/// from the config text and the set of already-approved fingerprints — no I/O,
/// so it is unit-testable. `refresh_mcp` (the spawner) and `pending_mcp_for`
/// (the dialog) both route through this, so they can never disagree about
/// whether a config is allowed to run.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum McpGate {
    /// No enabled servers — spawn nothing, show no dialog.
    Nothing,
    /// Enabled servers whose exact config is already approved — start them.
    Start(Vec<(String, mcp::ServerConfig)>),
    /// Enabled servers whose fingerprint is NOT approved — spawn nothing and
    /// ask the user first. `servers` are the enabled ones, for the dialog.
    NeedsApproval {
        fingerprint: String,
        servers: Vec<(String, mcp::ServerConfig)>,
    },
}

pub(crate) fn mcp_gate(config_json: &str, approved: &std::collections::HashSet<String>) -> McpGate {
    let servers = match mcp::parse_config(config_json) {
        Ok(s) => s,
        Err(_) => return McpGate::Nothing,
    };
    if !servers.iter().any(|(_, c)| !c.disabled) {
        return McpGate::Nothing;
    }
    let fingerprint = mcp_fingerprint(config_json);
    if approved.contains(&fingerprint) {
        return McpGate::Start(servers);
    }
    let enabled = servers.into_iter().filter(|(_, c)| !c.disabled).collect();
    McpGate::NeedsApproval {
        fingerprint,
        servers: enabled,
    }
}

/// SEC-1: if the open room's config has ENABLED servers whose fingerprint isn't
/// approved on this Mac, describe them for the approval dialog. None otherwise
/// (no enabled servers, or already approved).
pub(crate) fn pending_mcp_for(app: &tauri::AppHandle, conn: &Connection) -> Option<McpApproval> {
    let config = db::get_setting(conn, MCP_CONFIG_KEY)?;
    let approved: std::collections::HashSet<String> = read_mcp_approvals(app).into_iter().collect();
    match mcp_gate(&config, &approved) {
        McpGate::NeedsApproval {
            fingerprint,
            servers,
        } => Some(McpApproval {
            fingerprint,
            servers: servers
                .iter()
                .map(|(name, cfg)| McpServerBrief {
                    name: name.clone(),
                    command: render_command_line(cfg),
                })
                .collect(),
        }),
        McpGate::Start(_) | McpGate::Nothing => None,
    }
}

/// SEC-1: approve the currently open room's plug-in config on this Mac, then
/// start its servers and return their statuses. Declining is simply never
/// calling this — the servers stay stopped.
#[tauri::command]
pub fn approve_mcp(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    add_mcp_approval(&app, &fingerprint);
    refresh_mcp(&app);
    Ok(state.mcp.lock().unwrap().statuses())
}

#[tauri::command]
pub fn mcp_status(state: State<'_, AppState>) -> Result<Vec<mcp::ServerStatus>, String> {
    Ok(state.mcp.lock().unwrap().statuses())
}

/// (Re)connect servers from the open room's saved config. Runs in the
/// background — opening a room must not wait on `uvx` downloads.
pub(crate) fn refresh_mcp(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    let config_json: Option<String> = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| db::get_setting(&room.conn, MCP_CONFIG_KEY))
    };
    // SEC-1: never auto-spawn a room's plug-ins without a per-Mac approval of
    // this exact config. If the gate says NeedsApproval, start NOTHING — the UI
    // surfaces the approval dialog via RoomInfo.pendingMcp and calls approve_mcp
    // on "Allow". This is the SAME decision pending_mcp_for shows the user.
    let approved: std::collections::HashSet<String> = read_mcp_approvals(app).into_iter().collect();
    if let Some(McpGate::NeedsApproval { .. }) =
        config_json.as_deref().map(|j| mcp_gate(j, &approved))
    {
        return;
    }
    // Approved, or only-disabled/no config: register the parsed servers (disabled
    // ones simply show as Disabled; enabled+approved ones connect).
    let servers = config_json
        .as_deref()
        .and_then(|j| mcp::parse_config(j).ok())
        .unwrap_or_default();
    start_mcp_connections(app.clone(), servers);
}

pub(crate) fn start_mcp_connections(
    app: tauri::AppHandle,
    servers: Vec<(String, mcp::ServerConfig)>,
) {
    use tauri::{Emitter, Manager as _};
    let generation = {
        let state = app.state::<AppState>();
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        mgr.servers = servers
            .iter()
            .map(|(name, cfg)| mcp::Server {
                name: name.clone(),
                status: if cfg.disabled {
                    mcp::Status::Disabled
                } else {
                    mcp::Status::Connecting
                },
                error: None,
                tools: Vec::new(),
                remote: cfg.transport.is_remote(),
                client: None,
            })
            .collect();
        mgr.generation
    };
    let _ = app.emit(
        "mcp-status",
        app.state::<AppState>().mcp.lock().unwrap().statuses(),
    );
    for (name, cfg) in servers.into_iter().filter(|(_, c)| !c.disabled) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = mcp::Client::connect(&cfg).await;
            let state = app.state::<AppState>();
            {
                let mut mgr = state.mcp.lock().unwrap();
                // A newer config was applied while we were connecting.
                if mgr.generation != generation {
                    return;
                }
                if let Some(entry) = mgr.servers.iter_mut().find(|s| s.name == name) {
                    match result {
                        Ok((client, tools)) => {
                            entry.status = mcp::Status::Connected;
                            entry.tools = tools;
                            entry.client = Some(Arc::new(tokio::sync::Mutex::new(client)));
                        }
                        Err(e) => {
                            entry.status = mcp::Status::Failed;
                            entry.error = Some(e);
                        }
                    }
                }
            }
            let _ = app.emit(
                "mcp-status",
                app.state::<AppState>().mcp.lock().unwrap().statuses(),
            );
        });
    }
}

// ---------------------------------------------------------------- chat / AI

#[allow(clippy::too_many_arguments)]
/// SEC-1b: prompt the frontend to approve one MCP tool call, tying consent to
/// the moment data actually leaves the room. Returns true when the user allows
/// it — or already chose "always allow" for this connector this session. A
/// timeout or a closed window counts as a decline, never a silent yes.
pub(crate) async fn mcp_call_approved(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    route: &McpRoute,
    args: &serde_json::Value,
) -> bool {
    use tauri::Emitter;
    if state
        .mcp_session_ok
        .lock()
        .unwrap()
        .contains(&route.server_name)
    {
        return true;
    }
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<McpDecision>();
    state.mcp_pending.lock().unwrap().insert(id.clone(), tx);
    let preview: String = args.to_string().chars().take(400).collect();
    let _ = window.emit(
        "mcp-approve-request",
        serde_json::json!({
            "id": id,
            "server": route.server_name,
            "tool": route.tool_name,
            "args": preview,
        }),
    );
    let decision = match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.mcp_pending.lock().unwrap().remove(&id);
            McpDecision {
                approved: false,
                remember: false,
            }
        }
    };
    if decision.approved && decision.remember {
        state
            .mcp_session_ok
            .lock()
            .unwrap()
            .insert(route.server_name.clone());
    }
    decision.approved
}

// ---------------------------------------------------------------- OAuth

/// Merge an `Authorization: Bearer <token>` header into one server's entry in an
/// mcpServers config JSON, preserving everything else. Pure — unit-tested.
pub(crate) fn merge_bearer(config: &str, server: &str, token: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    let entry = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| format!("\"{server}\" is not in the connector config"))?;
    let headers = entry
        .entry("headers")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = headers.as_object_mut() {
        obj.insert(
            "Authorization".to_string(),
            serde_json::Value::String(format!("Bearer {token}")),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Run the OAuth sign-in for one remote connector: discover, register, PKCE
/// browser flow, store the token, merge the bearer into the room config, and
/// reconnect. The interactive step opens the system browser.
#[tauri::command]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let config = state
        .with_room(|room| Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default()))?;
    let url = mcp::parse_config(&config)?
        .into_iter()
        .find(|(n, _)| n == &server)
        .and_then(|(_, c)| match c.transport {
            mcp::Transport::Http { url, .. } => Some(url),
            _ => None,
        })
        .ok_or_else(|| format!("\"{server}\" is not a remote connector in this room."))?;

    // Interactive authorization — opens the browser via the opener plugin. We
    // also emit the URL first so the UI can offer a manual "open / copy the
    // sign-in link" fallback when the system browser doesn't come up on its own.
    let app_open = app.clone();
    let server_ev = server.clone();
    let open = move |u: &str| -> Result<(), String> {
        use tauri::Emitter;
        let _ = app_open.emit(
            "mcp-oauth-url",
            serde_json::json!({ "server": server_ev, "url": u }),
        );
        use tauri_plugin_opener::OpenerExt;
        app_open
            .opener()
            .open_url(u.to_string(), None::<&str>)
            .map_err(|e| e.to_string())
    };
    let www = super::mcp_oauth::probe_www_authenticate(&url).await;
    let token = super::mcp_oauth::authorize(&url, www.as_deref(), open).await?;

    // Persist the token + merge the bearer into the config, then reconnect. The
    // config change is a deliberate user action (they just signed in), so its
    // new fingerprint is approved like a saved config (SEC-1).
    let merged = state.with_room(|room| {
        super::mcp_oauth::save_tokens(&room.conn, &server, &token)?;
        let json = merge_bearer(&config, &server, &token.access_token)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    add_mcp_approval(&app, &mcp_fingerprint(&merged));
    start_mcp_connections(app, mcp::parse_config(&merged)?);
    Ok(state.mcp.lock().unwrap().statuses())
}

/// Whether a remote connector has a stored, non-expired OAuth token — drives
/// the "Signed in" vs "Connect account" state in the marketplace drawer.
#[tauri::command]
pub fn mcp_oauth_status(state: State<'_, AppState>, server: String) -> Result<bool, String> {
    state.with_room(|room| {
        Ok(super::mcp_oauth::load_tokens(&room.conn, &server)
            .map(|t| !super::mcp_oauth::needs_refresh(&t))
            .unwrap_or(false))
    })
}

/// Forget a remote connector's OAuth token and strip its bearer header.
#[tauri::command]
pub fn mcp_oauth_sign_out(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let merged = state.with_room(|room| {
        super::mcp_oauth::clear_tokens(&room.conn, &server)?;
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        // Drop the Authorization header if present, leaving the rest intact.
        let json = strip_bearer(&config, &server).unwrap_or(config);
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    add_mcp_approval(&app, &mcp_fingerprint(&merged));
    start_mcp_connections(app, mcp::parse_config(&merged).unwrap_or_default());
    Ok(state.mcp.lock().unwrap().statuses())
}

// ------------------------------------------------ agent CRUD (local-only)

const AGENT_SECRET_KEYS: &[&str] = &[
    "headers",
    "env",
    "bearer_token_env_var",
    "authorization",
    "token",
    "oauth",
];

fn agent_mcp_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(
            "Connector names use 1-64 letters, numbers, dots, dashes, or underscores.".into(),
        );
    }
    Ok(name)
}

fn agent_mcp_root(raw: &str) -> Result<serde_json::Value, String> {
    let mut root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    if !root.is_object() {
        return Err("the room's connector config must be a JSON object".into());
    }
    if root.get("mcpServers").is_none() {
        root["mcpServers"] = serde_json::json!({});
    }
    if !root["mcpServers"].is_object() {
        return Err("the room's mcpServers value must be an object".into());
    }
    Ok(root)
}

fn redact_agent_mcp_config(config: &serde_json::Value) -> serde_json::Value {
    let mut safe = config.clone();
    if let Some(map) = safe.as_object_mut() {
        for key in AGENT_SECRET_KEYS {
            if map.remove(*key).is_some() {
                map.insert(
                    (*key).to_string(),
                    serde_json::Value::String("[redacted]".into()),
                );
            }
        }
    }
    safe
}

fn remove_agent_mcp_secrets(config: &mut serde_json::Value) {
    if let Some(map) = config.as_object_mut() {
        for key in AGENT_SECRET_KEYS {
            map.remove(*key);
        }
    }
}

/// Inventory available to the local main agent. It deliberately describes
/// transports/statuses, never credential values.
pub(crate) fn agent_list_mcps(state: &AppState) -> Result<String, String> {
    let config = state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })?;
    let servers = mcp::parse_config(&config)?;
    if servers.is_empty() {
        return Ok("No MCP connectors are configured in this room.".into());
    }
    let statuses: std::collections::HashMap<String, String> = state
        .mcp
        .lock()
        .unwrap()
        .statuses()
        .into_iter()
        .map(|status| (status.name, format!("{:?}", status.status).to_lowercase()))
        .collect();
    let lines = servers
        .iter()
        .map(|(name, cfg)| {
            let transport = match &cfg.transport {
                mcp::Transport::Stdio { command, args, .. } => {
                    let args = if args.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", args.join(" "))
                    };
                    format!("local: {command}{args}")
                }
                mcp::Transport::Http { url, .. } => format!("remote: {url}"),
            };
            let state = if cfg.disabled {
                "disabled".to_string()
            } else {
                statuses
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| "configured".into())
            };
            format!("- {name} [{state}] — {transport}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(lines)
}

/// Read one server's editable, secret-free configuration.
pub(crate) fn agent_read_mcp(state: &AppState, name: &str) -> Result<String, String> {
    let name = agent_mcp_name(name)?;
    let config = state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })?;
    let root = agent_mcp_root(&config)?;
    let server = root["mcpServers"]
        .get(name)
        .ok_or_else(|| format!("No connector named \"{name}\" exists."))?;
    let safe = redact_agent_mcp_config(server);
    Ok(format!(
        "Connector {name} (credentials redacted):\n{}",
        serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?
    ))
}

/// Create/update a connector without ever accepting, exposing, approving, or
/// starting credentials/programs. A changed connector remains disabled until a
/// human reviews it in Connectors and completes the existing SEC-1 approval.
pub(crate) fn agent_save_mcp(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    use tauri::Manager as _;

    let name = agent_mcp_name(args["name"].as_str().unwrap_or_default())?.to_string();
    let mut incoming = args
        .get("config")
        .cloned()
        .filter(serde_json::Value::is_object)
        .ok_or("save_mcp needs a `config` object.")?;
    remove_agent_mcp_secrets(&mut incoming);
    let json = state.with_room(|room| {
        let raw = db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string());
        let mut root = agent_mcp_root(&raw)?;
        let servers = root["mcpServers"].as_object_mut().expect("checked above");
        let existed = servers.get(&name).is_some();
        // Preserve already-stored credentials while refusing new secret values
        // from model context. A connector edit must never erase a user's token.
        if let Some(old) = servers.get(&name).and_then(serde_json::Value::as_object) {
            if let Some(new) = incoming.as_object_mut() {
                for key in ["headers", "env", "bearer_token_env_var"] {
                    if let Some(value) = old.get(key) {
                        new.insert(key.to_string(), value.clone());
                    }
                }
            }
        }
        incoming["disabled"] = serde_json::Value::Bool(true);
        servers.insert(name.clone(), incoming);
        let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        mcp::parse_config(&json)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok((json, existed))
    })?;
    let servers = mcp::parse_config(&json.0)?;
    start_mcp_connections(window.app_handle().clone(), servers);
    Ok(format!(
        "{} connector \"{}\" as disabled. Review it in Connectors, add any credentials there, then explicitly enable and approve it before it can run or reach the network.",
        if json.1 { "Updated" } else { "Saved" },
        name
    ))
}

pub(crate) fn agent_delete_mcp(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    use tauri::Manager as _;

    let name = agent_mcp_name(args["name"].as_str().unwrap_or_default())?.to_string();
    let json = state.with_room(|room| {
        let raw = db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string());
        let root = agent_mcp_root(&raw)?;
        if root["mcpServers"].get(&name).is_none() {
            return Err(format!("No connector named \"{name}\" exists."));
        }
        super::mcp_oauth::clear_tokens(&room.conn, &name)?;
        let json = remove_server_from_config(&raw, &name)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    start_mcp_connections(window.app_handle().clone(), mcp::parse_config(&json)?);
    Ok(format!(
        "Deleted connector \"{name}\" and its saved OAuth token."
    ))
}

// ------------------------------------------------------------ enable/remove

/// Set or clear `"disabled"` on one server in an mcpServers config. Pure —
/// unit-tested. Disabling keeps the connector in the config but stops it.
pub(crate) fn set_server_disabled(
    config: &str,
    server: &str,
    disabled: bool,
) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    let entry = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| format!("\"{server}\" is not in the connector config"))?;
    if disabled {
        entry.insert("disabled".to_string(), serde_json::Value::Bool(true));
    } else {
        entry.remove("disabled");
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Remove one server from an mcpServers config entirely. Pure — unit-tested.
pub(crate) fn remove_server_from_config(config: &str, server: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    if let Some(map) = root.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        map.remove(server);
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Persist an edited config, re-approve it (the edit is a deliberate user
/// action so its new fingerprint counts as approved — SEC-1), and reconnect.
fn apply_edited_config(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    json: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    add_mcp_approval(app, &mcp_fingerprint(&json));
    start_mcp_connections(app.clone(), mcp::parse_config(&json).unwrap_or_default());
    Ok(state.mcp.lock().unwrap().statuses())
}

/// Turn one connector on or off without removing it (writes `"disabled"`).
#[tauri::command]
pub fn mcp_set_server_enabled(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
    enabled: bool,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let json = state.with_room(|room| {
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        let json = set_server_disabled(&config, &server, !enabled)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    apply_edited_config(&app, &state, json)
}

/// Remove one connector from the room entirely (also forgets its OAuth token).
#[tauri::command]
pub fn mcp_remove_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let json = state.with_room(|room| {
        let _ = super::mcp_oauth::clear_tokens(&room.conn, &server);
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        let json = remove_server_from_config(&config, &server)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    apply_edited_config(&app, &state, json)
}

/// Remove the Authorization header from one server's config entry. Pure.
fn strip_bearer(config: &str, server: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config).map_err(|e| e.to_string())?;
    if let Some(h) = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.get_mut("headers"))
        .and_then(|h| h.as_object_mut())
    {
        h.remove("Authorization");
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

// ------------------------------------------------------- per-tool whitelist

/// Read the per-connector tool opt-outs (`{server: [disabled tool names]}`).
/// Missing/invalid → empty (everything on). Pure over the stored string.
pub(crate) fn parse_tool_prefs(
    raw: &str,
) -> std::collections::HashMap<String, std::collections::HashSet<String>> {
    serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(raw)
        .map(|m| {
            m.into_iter()
                .map(|(k, v)| (k, v.into_iter().collect()))
                .collect()
        })
        .unwrap_or_default()
}

/// Update one server's disabled-tools list and return the new prefs JSON. Pure —
/// unit-tested. `enabled=false` adds the tool to the off-list; `true` removes it.
pub(crate) fn set_tool_pref(
    raw: &str,
    server: &str,
    tool: &str,
    enabled: bool,
) -> Result<String, String> {
    let mut map: std::collections::BTreeMap<String, Vec<String>> =
        serde_json::from_str(raw).unwrap_or_default();
    let list = map.entry(server.to_string()).or_default();
    list.retain(|t| t != tool);
    if !enabled {
        list.push(tool.to_string());
    }
    if list.is_empty() {
        map.remove(server);
    }
    serde_json::to_string(&map).map_err(|e| e.to_string())
}

/// The room's tool opt-outs as `{server: [disabled tools]}` — drives the per-tool
/// toggles in the Connectors page. Empty object when nothing is turned off.
#[tauri::command]
pub fn mcp_get_tool_prefs(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_TOOL_PREFS_KEY).unwrap_or_else(|| "{}".to_string()))
    })
}

/// Turn one connector tool on or off for this room. No reconnect needed — the
/// change takes effect on the next turn, when `mcp_routes` re-reads the prefs.
#[tauri::command]
pub fn mcp_set_tool_enabled(
    state: State<'_, AppState>,
    server: String,
    tool: String,
    enabled: bool,
) -> Result<String, String> {
    state.with_room(|room| {
        let raw =
            db::get_setting(&room.conn, MCP_TOOL_PREFS_KEY).unwrap_or_else(|| "{}".to_string());
        let next = set_tool_pref(&raw, &server, &tool, enabled)?;
        db::set_setting(&room.conn, MCP_TOOL_PREFS_KEY, &next)?;
        Ok(next)
    })
}

/// Parse the "ignore the tool cap" server list. Missing/invalid → empty.
pub(crate) fn parse_uncapped(raw: &str) -> std::collections::HashSet<String> {
    serde_json::from_str::<Vec<String>>(raw)
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

/// Add/remove a server from the uncapped list, returning the new JSON. Pure —
/// unit-tested.
pub(crate) fn set_uncapped(raw: &str, server: &str, uncapped: bool) -> Result<String, String> {
    let mut set: std::collections::BTreeSet<String> = serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .collect();
    if uncapped {
        set.insert(server.to_string());
    } else {
        set.remove(server);
    }
    serde_json::to_string(&set.into_iter().collect::<Vec<_>>()).map_err(|e| e.to_string())
}

/// The connectors the user has exempted from the tool-count cap (JSON array).
#[tauri::command]
pub fn mcp_get_uncapped(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_TOOL_UNCAPPED_KEY).unwrap_or_else(|| "[]".to_string()))
    })
}

/// Turn the "send every tool, ignore the limit" override on/off for one
/// connector. Takes effect next turn (mcp_routes re-reads it); no reconnect.
#[tauri::command]
pub fn mcp_set_server_uncapped(
    state: State<'_, AppState>,
    server: String,
    uncapped: bool,
) -> Result<String, String> {
    state.with_room(|room| {
        let raw =
            db::get_setting(&room.conn, MCP_TOOL_UNCAPPED_KEY).unwrap_or_else(|| "[]".to_string());
        let next = set_uncapped(&raw, &server, uncapped)?;
        db::set_setting(&room.conn, MCP_TOOL_UNCAPPED_KEY, &next)?;
        Ok(next)
    })
}

/// The frontend's answer to an `mcp-approve-request` — "once", "always", or
/// anything else (declined).
#[tauri::command]
pub fn resolve_mcp_call(
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<(), String> {
    let d = match decision.as_str() {
        "once" => McpDecision {
            approved: true,
            remember: false,
        },
        "always" => McpDecision {
            approved: true,
            remember: true,
        },
        _ => McpDecision {
            approved: false,
            remember: false,
        },
    };
    if let Some(tx) = state.mcp_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(d);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_fingerprint_is_stable_and_config_sensitive() {
        // SEC-1: same text → same fingerprint (approval survives reopening).
        let a = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        assert_eq!(mcp_fingerprint(a), mcp_fingerprint(a));
        // A one-character change invalidates the old approval.
        let b = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert_ne!(mcp_fingerprint(a), mcp_fingerprint(b));
        // Hex SHA-256 is 64 chars.
        assert_eq!(mcp_fingerprint(a).len(), 64);
    }

    #[test]
    fn mcp_gate_blocks_unapproved_enabled_server() {
        // SEC-1 core invariant: an enabled server whose exact config has NOT been
        // approved on this Mac must NOT start — the gate asks first.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        match mcp_gate(cfg, &none) {
            McpGate::NeedsApproval {
                fingerprint,
                servers,
            } => {
                // The dialog is asked about exactly the enabled server, and the
                // fingerprint it will approve is this config's SHA-256.
                assert_eq!(fingerprint, mcp_fingerprint(cfg));
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("unapproved enabled server must gate (NeedsApproval), never Start"),
        }
    }

    #[test]
    fn mcp_gate_starts_when_fingerprint_approved() {
        // SEC-1 (b): once this exact config is in the approved set, the same
        // server is allowed to Start.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(cfg)].into_iter().collect();
        match mcp_gate(cfg, &approved) {
            McpGate::Start(servers) => {
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("approved config must Start"),
        }
    }

    #[test]
    fn mcp_gate_nothing_when_only_disabled_servers() {
        // SEC-1 (c): a config with only disabled servers is Nothing — no dialog,
        // no spawn — even though its fingerprint is not approved.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"disabled":true}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        assert!(matches!(mcp_gate(cfg, &none), McpGate::Nothing));
        // An empty server map is likewise Nothing.
        assert!(matches!(
            mcp_gate(r#"{"mcpServers":{}}"#, &none),
            McpGate::Nothing
        ));
    }

    #[test]
    fn mcp_gate_edited_config_needs_reapproval() {
        // SEC-1 (d): approve one config, then edit it — the fingerprint changes,
        // so the OLD approval no longer covers it and the gate asks again.
        let original = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(original)].into_iter().collect();
        // Same text still starts.
        assert!(matches!(mcp_gate(original, &approved), McpGate::Start(_)));
        // One-character edit → different fingerprint → NeedsApproval again.
        let edited = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert!(matches!(
            mcp_gate(edited, &approved),
            McpGate::NeedsApproval { .. }
        ));
    }

    #[test]
    fn renders_full_command_line() {
        let cfg = mcp::ServerConfig {
            transport: mcp::Transport::Stdio {
                command: "uvx".into(),
                args: vec!["duckduckgo-mcp-server".into(), "--verbose".into()],
                env: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        assert_eq!(
            render_command_line(&cfg),
            "uvx duckduckgo-mcp-server --verbose"
        );
        let bare = mcp::ServerConfig {
            transport: mcp::Transport::Stdio {
                command: "node".into(),
                args: vec![],
                env: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        assert_eq!(render_command_line(&bare), "node");
    }

    #[test]
    fn set_disabled_and_remove_edit_the_right_server() {
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]},"gh":{"type":"http","url":"https://x"}}}"#;
        // Disable adds "disabled":true, leaving the other server alone.
        let off = set_server_disabled(cfg, "web", true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&off).unwrap();
        assert_eq!(v["mcpServers"]["web"]["disabled"], true);
        assert_eq!(v["mcpServers"]["web"]["command"], "uvx");
        assert!(v["mcpServers"]["gh"]["url"].is_string());
        // Re-enable removes the flag entirely (not "disabled":false).
        let on = set_server_disabled(&off, "web", false).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&on).unwrap();
        assert!(v2["mcpServers"]["web"].get("disabled").is_none());
        // Remove drops just that server.
        let rm = remove_server_from_config(cfg, "web").unwrap();
        let v3: serde_json::Value = serde_json::from_str(&rm).unwrap();
        assert!(v3["mcpServers"].get("web").is_none());
        assert!(v3["mcpServers"]["gh"].is_object());
        // Unknown server → error for disable, no-op for remove.
        assert!(set_server_disabled(cfg, "nope", true).is_err());
        assert!(remove_server_from_config(cfg, "nope").is_ok());
    }

    #[test]
    fn merge_and_strip_bearer_are_inverse() {
        let cfg =
            r#"{"mcpServers":{"gh":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}"#;
        let merged = merge_bearer(cfg, "gh", "tok123").unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(
            v["mcpServers"]["gh"]["headers"]["Authorization"],
            "Bearer tok123"
        );
        // url is preserved.
        assert_eq!(
            v["mcpServers"]["gh"]["url"],
            "https://api.githubcopilot.com/mcp/"
        );
        // Stripping removes just the Authorization header.
        let stripped = strip_bearer(&merged, "gh").unwrap();
        let sv: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert!(sv["mcpServers"]["gh"]["headers"]
            .get("Authorization")
            .is_none());
        assert_eq!(
            sv["mcpServers"]["gh"]["url"],
            "https://api.githubcopilot.com/mcp/"
        );
        // Unknown server → error, not a panic.
        assert!(merge_bearer(cfg, "nope", "t").is_err());
    }

    #[test]
    fn tool_prefs_toggle_off_and_back_on() {
        // Default: nothing disabled.
        assert!(parse_tool_prefs("{}").is_empty());
        // Turn a tool OFF → it lands in the server's off-list.
        let a = set_tool_pref("{}", "fetch-mcp", "http_head", false).unwrap();
        let m = parse_tool_prefs(&a);
        assert!(m["fetch-mcp"].contains("http_head"));
        // A second tool OFF joins it; no duplicates on repeat.
        let b = set_tool_pref(&a, "fetch-mcp", "http_put", false).unwrap();
        let b = set_tool_pref(&b, "fetch-mcp", "http_put", false).unwrap();
        assert_eq!(parse_tool_prefs(&b)["fetch-mcp"].len(), 2);
        // Turning the last one back ON removes it; emptying a server drops the key.
        let c = set_tool_pref(&b, "fetch-mcp", "http_head", true).unwrap();
        let c = set_tool_pref(&c, "fetch-mcp", "http_put", true).unwrap();
        assert!(parse_tool_prefs(&c).get("fetch-mcp").is_none());
        // Garbage stored value degrades to "all on", never an error.
        assert!(parse_tool_prefs("not json").is_empty());
    }

    #[test]
    fn uncapped_override_toggles_per_server() {
        assert!(parse_uncapped("[]").is_empty());
        // Turn the override ON for one server; idempotent on repeat.
        let a = set_uncapped("[]", "fetch-mcp", true).unwrap();
        let a = set_uncapped(&a, "fetch-mcp", true).unwrap();
        assert!(parse_uncapped(&a).contains("fetch-mcp"));
        assert_eq!(parse_uncapped(&a).len(), 1);
        // A second server joins; turning the first OFF leaves the second.
        let b = set_uncapped(&a, "github", true).unwrap();
        let c = set_uncapped(&b, "fetch-mcp", false).unwrap();
        let m = parse_uncapped(&c);
        assert!(m.contains("github") && !m.contains("fetch-mcp"));
        // Garbage → empty, never an error.
        assert!(parse_uncapped("nope").is_empty());
    }

    #[test]
    fn renders_remote_endpoint_for_dialog() {
        // SEC-1: a remote connector's approval line names the endpoint and flags
        // that it reaches the internet — not a fake command line.
        let cfg = mcp::ServerConfig {
            transport: mcp::Transport::Http {
                url: "https://mcp.notion.com/mcp".into(),
                headers: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        let line = render_command_line(&cfg);
        assert!(line.contains("https://mcp.notion.com/mcp"));
        assert!(line.contains("remote"));
    }

    #[test]
    fn agent_connector_views_never_expose_secret_fields() {
        let raw = serde_json::json!({
            "command": "npx",
            "headers": {"Authorization": "Bearer secret"},
            "env": {"API_KEY": "secret"},
            "bearer_token_env_var": "TOKEN_ENV",
            "token": "secret"
        });
        let safe = redact_agent_mcp_config(&raw);
        assert_eq!(safe["headers"], "[redacted]");
        assert_eq!(safe["env"], "[redacted]");
        assert_eq!(safe["bearer_token_env_var"], "[redacted]");
        assert_eq!(safe["token"], "[redacted]");
        assert!(!safe.to_string().contains("secret"));

        let mut incoming = raw;
        remove_agent_mcp_secrets(&mut incoming);
        for key in AGENT_SECRET_KEYS {
            assert!(
                incoming.get(*key).is_none(),
                "{key} leaked into an agent save"
            );
        }
    }

    #[test]
    fn agent_connector_names_and_roots_are_strict() {
        assert_eq!(agent_mcp_name("github.v2").unwrap(), "github.v2");
        assert!(agent_mcp_name("has space").is_err());
        assert!(agent_mcp_name("../escape").is_err());
        let root = agent_mcp_root(r#"{"mcpServers":{}}"#).unwrap();
        assert!(root["mcpServers"].is_object());
        assert!(agent_mcp_root(r#"{"mcpServers":[]}"#).is_err());
    }
}
