use super::*;

// ---- D9: the Leash (persistent room MCP server) -----------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomServerStatus {
    pub running: bool,
    pub url: String,
    pub config: String,
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
        },
        None => RoomServerStatus {
            running: false,
            url: String::new(),
            config: String::new(),
        },
    }
}

/// D9: is the room server running, and if so, its URL + mcp config.
#[tauri::command]
pub fn room_server_status(state: State<'_, AppState>) -> Result<RoomServerStatus, String> {
    Ok(room_server_status_snapshot(state.inner()))
}

/// D9: turn the persistent room MCP server on/off. `allow_cloud` mirrors the
/// advisor sub-option (include the room's connected MCP tools). Persists the
/// toggle so unlock can restore it (see `spawn_room_server_if_enabled`).
/// CONTRACT-NOTE: `room_mcp::start(app, web_enabled, include_mcp)` — `allow_cloud`
/// maps to `include_mcp`.
#[tauri::command]
pub async fn set_room_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    allow_cloud: bool,
) -> Result<RoomServerStatus, String> {
    // Persist the toggle + read whether web tools should be exposed, all under
    // the room lock, which is dropped before any await.
    let web_enabled = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::set_setting(&room.conn, "room_server_enabled", if enabled { "1" } else { "0" })?;
        web_access_enabled(&room.conn)
    };
    if enabled {
        let already = state.room_server.lock().unwrap().is_some();
        if !already {
            let bridge = crate::room_mcp::start(app.clone(), web_enabled, allow_cloud).await?;
            *state.room_server.lock().unwrap() = Some(bridge);
        }
    } else {
        let taken = state.room_server.lock().unwrap().take();
        if let Some(b) = taken {
            b.stop();
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
