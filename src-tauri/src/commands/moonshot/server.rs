use super::*;

// ---- D9: the Leash (persistent room MCP server) -----------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomServerStatus {
    pub running: bool,
    pub url: String,
    pub config: String,
    /// Wave 1a: the running tier — `"files"` | `"full"`.
    pub scope: String,
    /// Wave 1a: true when the fixed Leash port was bound, so the pasted
    /// config survives restarts.
    pub stable: bool,
    /// The effective cloud sub-option (files tier). Echoed so a reopened
    /// Settings shows the truth instead of a reset local default.
    pub allow_cloud: bool,
}

/// Wave 1a: the fixed port the full tier binds by default (open decision 1).
pub(crate) const LEASH_DEFAULT_PORT: u16 = 17872;

/// Wave 1a: map the persisted `room_server_scope` setting to a bridge scope.
/// Anything but an explicit `"full"` opt-in is the safe files tier, with
/// `allow_cloud` mapping to the advisor sub-option.
pub(crate) fn leash_scope(setting: Option<&str>, allow_cloud: bool) -> crate::room_mcp::ToolScope {
    match setting {
        Some("full") => crate::room_mcp::ToolScope::ExternalAgent,
        _ => crate::room_mcp::ToolScope::CloudAdvisor { include_mcp: allow_cloud },
    }
}

/// The wire name of a bridge scope, as the status/discovery surfaces spell it.
pub(crate) fn scope_name(scope: crate::room_mcp::ToolScope) -> &'static str {
    match scope {
        crate::room_mcp::ToolScope::ExternalAgent => "full",
        _ => "files",
    }
}

/// Wave 1a: read-or-create the full tier's stable identity — `leash_port`
/// (default 17872) and `leash_token` (uuid, encrypted at rest in the room DB
/// like every setting). Persisting on first read is what lets a pasted config
/// survive restarts.
pub(crate) fn leash_identity(conn: &Connection) -> Result<(u16, String), String> {
    let port = match db::get_setting(conn, "leash_port").and_then(|p| p.parse::<u16>().ok()) {
        Some(p) => p,
        None => {
            db::set_setting(conn, "leash_port", &LEASH_DEFAULT_PORT.to_string())?;
            LEASH_DEFAULT_PORT
        }
    };
    let token = match db::get_setting(conn, "leash_token") {
        Some(t) if !t.is_empty() => t,
        _ => {
            let t = Uuid::new_v4().simple().to_string();
            db::set_setting(conn, "leash_token", &t)?;
            t
        }
    };
    Ok((port, token))
}

/// Snapshot the current room server state (running URL + the mcp-config JSON a
/// CLI would paste). Pure over the stored Bridge — no locking of the room.
pub(crate) fn room_server_status_snapshot(state: &AppState) -> RoomServerStatus {
    let guard = state.room_server.lock().unwrap();
    match guard.as_ref() {
        Some(b) => RoomServerStatus {
            running: true,
            url: format!("http://127.0.0.1:{}/mcp", b.port),
            config: b.mcp_config_json(),
            scope: scope_name(b.scope).to_string(),
            stable: b.stable,
            allow_cloud: matches!(
                b.scope,
                crate::room_mcp::ToolScope::CloudAdvisor { include_mcp: true }
            ),
        },
        None => RoomServerStatus {
            running: false,
            url: String::new(),
            config: String::new(),
            scope: "files".into(),
            stable: false,
            allow_cloud: false,
        },
    }
}

/// Store a freshly-started bridge ONLY while the room it was started for is
/// still the open one, the slot is still empty, and the toggle is still on —
/// otherwise stop it. The start awaited; `teardown_open_room` (close,
/// open-over-open) may have run in that window, and its invariant is
/// "teardown always kills the server + its token" — an unvalidated store
/// would leak a bridge serving the NEXT room with THIS room's token. Holding
/// the room lock across the store (same room→server order teardown uses)
/// closes the gap between check and store. Returns whether it stored.
pub(crate) fn store_bridge_if_current(
    state: &AppState,
    room_path: &str,
    bridge: crate::room_mcp::Bridge,
) -> bool {
    {
        let room_guard = state.room.lock().unwrap();
        let current = matches!(
            room_guard.as_ref(),
            Some(r) if r.path == room_path
                && db::get_setting(&r.conn, "room_server_enabled").as_deref() == Some("1")
        );
        if current {
            let mut slot = state.room_server.lock().unwrap();
            if slot.is_none() {
                *slot = Some(bridge);
                return true;
            }
        }
    }
    bridge.stop();
    false
}

/// D9: is the room server running, and if so, its URL + mcp config.
#[tauri::command]
pub fn room_server_status(state: State<'_, AppState>) -> Result<RoomServerStatus, String> {
    Ok(room_server_status_snapshot(state.inner()))
}

/// D9/Wave 1a: turn the persistent room MCP server on/off at a chosen tier.
/// `scope` is `"files"` (today's cloud-advisor catalog; `allow_cloud` mirrors
/// the advisor sub-option, fresh token + ephemeral port each start) or
/// `"full"` (`ToolScope::ExternalAgent`: job tools + `local_generate` +
/// `view_media_frame`, on the persisted `leash_port`/`leash_token` so a pasted
/// external-agent config survives restarts). Both the toggle and the tier are
/// persisted so unlock can restore them (see `spawn_room_server_if_enabled`).
/// A running bridge whose scope differs from the request — including a flipped
/// cloud sub-option — is stopped (severing live connections) and restarted.
#[tauri::command]
pub async fn set_room_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    allow_cloud: bool,
    scope: String,
) -> Result<RoomServerStatus, String> {
    let want_full = scope == "full";
    // Persist toggle + tier and read everything the start needs, all under the
    // room lock, which is dropped before any await. The room path is captured
    // so the post-await store can verify the SAME room is still open.
    let (web_enabled, opts, room_path, room_name) = state.with_room(|room| {
        db::set_setting(&room.conn, "room_server_enabled", if enabled { "1" } else { "0" })?;
        db::set_setting(&room.conn, "room_server_scope", if want_full { "full" } else { "files" })?;
        let opts = if want_full {
            let (port, token) = leash_identity(&room.conn)?;
            crate::room_mcp::StartOpts { port: Some(port), token: Some(token), ..Default::default() }
        } else {
            // Files tier keeps the fresh-token / ephemeral-port behavior.
            crate::room_mcp::StartOpts::default()
        };
        Ok((web_access_enabled(&room.conn), opts, room.path.clone(), room.name.clone()))
    })?;
    let want = leash_scope(Some(if want_full { "full" } else { "files" }), allow_cloud);
    if enabled {
        let existing = {
            let mut guard = state.room_server.lock().unwrap();
            match guard.as_ref() {
                // Same tier AND same policy already running — keep it (and its
                // token) untouched.
                Some(b) if b.scope == want => None,
                _ => guard.take(),
            }
        };
        let already_right = existing.is_none()
            && state.room_server.lock().unwrap().is_some();
        if !already_right {
            if let Some(b) = existing {
                // Await the listener's death — the full tier rebinds the same
                // fixed port right below.
                b.stop_and_wait().await;
            }
            let bridge = crate::room_mcp::start(app.clone(), web_enabled, want, None, opts).await?;
            let (port, token, bscope) = (bridge.port, bridge.token.clone(), bridge.scope);
            if store_bridge_if_current(&state, &room_path, bridge) {
                // Only the full tier advertises itself on disk — the files-tier
                // UI promises the token reaches the room by paste only, so we
                // must not drop its bearer token into ~/.arcelle/leash.json.
                if matches!(bscope, crate::room_mcp::ToolScope::ExternalAgent) {
                    let _ = write_discovery(&app, port, &token, scope_name(bscope), &room_name);
                } else {
                    let _ = remove_discovery(&app);
                }
            }
        }
    } else {
        let taken = state.room_server.lock().unwrap().take();
        if let Some(b) = taken {
            b.stop();
        }
        remove_discovery(&app);
    }
    Ok(room_server_status_snapshot(state.inner()))
}

/// Wave 1a: mint a NEW `leash_token` (the full tier's long-lived credential —
/// it lives in plaintext in `leash.json` and whatever configs the user pasted
/// it into, and `change_password` deliberately does not rotate it; this is the
/// revocation path). A running full-tier bridge is restarted with the new
/// token, which also severs every live connection holding the old one, and
/// the discovery file is rewritten.
#[tauri::command]
pub async fn regenerate_leash_token(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RoomServerStatus, String> {
    let (web_enabled, opts, room_path, room_name) = state.with_room(|room| {
        let token = Uuid::new_v4().simple().to_string();
        db::set_setting(&room.conn, "leash_token", &token)?;
        let (port, token) = leash_identity(&room.conn)?;
        Ok((
            web_access_enabled(&room.conn),
            crate::room_mcp::StartOpts { port: Some(port), token: Some(token), ..Default::default() },
            room.path.clone(),
            room.name.clone(),
        ))
    })?;
    // Only a running FULL-tier bridge is restarted; a files-tier bridge has
    // its own fresh per-start token and is untouched.
    let existing = {
        let mut guard = state.room_server.lock().unwrap();
        match guard.as_ref() {
            Some(b) if b.scope == crate::room_mcp::ToolScope::ExternalAgent => guard.take(),
            _ => None,
        }
    };
    if let Some(b) = existing {
        b.stop_and_wait().await;
        let bridge = crate::room_mcp::start(
            app.clone(),
            web_enabled,
            crate::room_mcp::ToolScope::ExternalAgent,
            None,
            opts,
        )
        .await?;
        let (port, token, bscope) = (bridge.port, bridge.token.clone(), bridge.scope);
        if store_bridge_if_current(&state, &room_path, bridge) {
            let _ = write_discovery(&app, port, &token, scope_name(bscope), &room_name);
        }
    }
    Ok(room_server_status_snapshot(state.inner()))
}

// ---- D10: the Closet (remote Ollama URL) ------------------------------------

/// D10: point Ollama at a remote base URL ("closet supercomputer") and persist it
/// for this room, or clear it when empty. The override applies immediately and is
/// re-applied on the next unlock via `apply_ollama_override`.
#[tauri::command]
pub fn set_ollama_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    ollama::set_base_url_override(if trimmed.is_empty() { None } else { Some(trimmed.clone()) });
    if let Some(room) = state.room.lock().unwrap().as_ref() {
        db::set_setting(&room.conn, "remote_ollama_url", &trimmed)?;
    }
    Ok(())
}

/// D10: the room's saved remote-Ollama URL (empty = use the local default).
#[tauri::command]
pub fn get_ollama_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .room
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|room| db::get_setting(&room.conn, "remote_ollama_url"))
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room_mcp::ToolScope;

    #[test]
    fn leash_scope_maps_setting_to_tier() {
        // Only an explicit "full" opt-in reaches the external tier; anything
        // else — missing, unknown, "files" — is the safe cloud-advisor tier
        // with allow_cloud mapping to the advisor sub-option.
        assert_eq!(leash_scope(Some("full"), false), ToolScope::ExternalAgent);
        assert_eq!(leash_scope(Some("full"), true), ToolScope::ExternalAgent);
        assert_eq!(
            leash_scope(Some("files"), false),
            ToolScope::CloudAdvisor { include_mcp: false }
        );
        assert_eq!(
            leash_scope(Some("files"), true),
            ToolScope::CloudAdvisor { include_mcp: true }
        );
        assert_eq!(leash_scope(None, false), ToolScope::CloudAdvisor { include_mcp: false });
        assert_eq!(
            leash_scope(Some("banana"), false),
            ToolScope::CloudAdvisor { include_mcp: false }
        );
        assert_eq!(scope_name(ToolScope::ExternalAgent), "full");
        assert_eq!(scope_name(ToolScope::LocalEngine), "files");
        assert_eq!(scope_name(ToolScope::CloudAdvisor { include_mcp: true }), "files");
    }

    #[test]
    fn leash_settings_round_trip() {
        // Wave 1a persistence: tier + stable identity live in the room's
        // generic settings K/V (no migration), and leash_identity creates the
        // identity once and then returns the SAME values forever — that
        // stability is what keeps a pasted config working across restarts.
        let conn = db::open_in_memory_schema();
        db::set_setting(&conn, "room_server_scope", "full").unwrap();
        assert_eq!(db::get_setting(&conn, "room_server_scope").as_deref(), Some("full"));
        let (port, token) = leash_identity(&conn).unwrap();
        assert_eq!(port, LEASH_DEFAULT_PORT);
        assert!(!token.is_empty());
        assert_eq!(db::get_setting(&conn, "leash_port").as_deref(), Some("17872"));
        assert_eq!(db::get_setting(&conn, "leash_token").as_deref(), Some(token.as_str()));
        let (port2, token2) = leash_identity(&conn).unwrap();
        assert_eq!((port, token.clone()), (port2, token2));
        // A rotated token is what the next read returns.
        db::set_setting(&conn, "leash_token", "rotated").unwrap();
        assert_eq!(leash_identity(&conn).unwrap().1, "rotated");
    }
}
