use super::*;

#[tauri::command]
pub fn mcp_get_config(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
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

/// SEC-1: the full command line a server would run, e.g. "uvx duckduckgo-mcp-server".
/// Shown in the approval dialog so the user sees exactly what would execute.
pub(crate) fn render_command_line(cfg: &mcp::ServerConfig) -> String {
    let mut parts = Vec::with_capacity(1 + cfg.args.len());
    parts.push(cfg.command.clone());
    parts.extend(cfg.args.iter().cloned());
    parts.join(" ")
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
    let approved: std::collections::HashSet<String> =
        read_mcp_approvals(app).into_iter().collect();
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
    let approved: std::collections::HashSet<String> =
        read_mcp_approvals(app).into_iter().collect();
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

pub(crate) fn start_mcp_connections(app: tauri::AppHandle, servers: Vec<(String, mcp::ServerConfig)>) {
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
                client: None,
            })
            .collect();
        mgr.generation
    };
    let _ = app.emit("mcp-status", app.state::<AppState>().mcp.lock().unwrap().statuses());
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
            let _ = app.emit("mcp-status", app.state::<AppState>().mcp.lock().unwrap().statuses());
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
            McpDecision { approved: false, remember: false }
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

/// The frontend's answer to an `mcp-approve-request` — "once", "always", or
/// anything else (declined).
#[tauri::command]
pub fn resolve_mcp_call(
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<(), String> {
    let d = match decision.as_str() {
        "once" => McpDecision { approved: true, remember: false },
        "always" => McpDecision { approved: true, remember: true },
        _ => McpDecision { approved: false, remember: false },
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
            command: "uvx".into(),
            args: vec!["duckduckgo-mcp-server".into(), "--verbose".into()],
            env: std::collections::HashMap::new(),
            disabled: false,
        };
        assert_eq!(render_command_line(&cfg), "uvx duckduckgo-mcp-server --verbose");
        let bare = mcp::ServerConfig {
            command: "node".into(),
            args: vec![],
            env: std::collections::HashMap::new(),
            disabled: false,
        };
        assert_eq!(render_command_line(&bare), "node");
    }

}
