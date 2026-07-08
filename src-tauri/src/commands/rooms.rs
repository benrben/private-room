use super::*;

#[tauri::command]
pub fn create_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    let name = room_name_from_path(&path);
    let conn = db::create_room(&path, &password, &name)?;
    // D10 (the Closet): apply this room's saved remote-Ollama URL (a fresh room
    // has none, which clears any override the previous room set).
    apply_ollama_override(&conn);
    let room = Room {
        conn,
        path,
        name,
        password,
    };
    let info = info_of(&app, &room)?;
    push_recent(&app, &room.name, &room.path);
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
    spawn_reextract_backfill(&app);
    spawn_embedding_backfill(&app);
    spawn_room_server_if_enabled(&app);
    Ok(info)
}

#[tauri::command]
pub fn open_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    let conn = db::open_room(&path, &password)?;
    let name = db::get_meta(&conn, "name").unwrap_or_else(|| room_name_from_path(&path));
    // D10 (the Closet): re-apply this room's saved remote-Ollama URL on unlock.
    apply_ollama_override(&conn);
    let room = Room {
        conn,
        path,
        name,
        password,
    };
    let info = info_of(&app, &room)?;
    push_recent(&app, &room.name, &room.path);
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
    spawn_reextract_backfill(&app);
    spawn_embedding_backfill(&app);
    // D9 (the Leash): if the user left the room server on, start it again now.
    spawn_room_server_if_enabled(&app);
    Ok(info)
}

/// Recovery (the printed sheet): create a recovery key for the CURRENTLY OPEN
/// room and return the human code to show once. Uses the open room's own path
/// and password, so the create/settings flows pass nothing sensitive across the
/// boundary. Writes the `<path>.recovery` sidecar (outside the encrypted file —
/// it must be, or it couldn't unlock the file it lives beside).
#[tauri::command]
pub fn write_recovery_key(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::write_recovery(&room.path, &room.password)
}

/// True when the room at `path` has a recovery sidecar — the gate shows
/// "Unlock with recovery code" only then.
#[tauri::command]
pub fn has_recovery_key(path: String) -> bool {
    db::has_recovery(&path)
}

/// Unlock a room with its recovery code instead of the password: recover the
/// password from the sidecar, then open exactly as `open_room` does.
#[tauri::command]
pub fn open_room_with_recovery(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    code: String,
) -> Result<RoomInfo, String> {
    let password = db::recover_password(&path, &code)?;
    open_room(app, state, path, password)
}

/// D9 (the Leash): on unlock, restart the persistent room MCP server if its
/// toggle (`room_server_enabled`) was left on. Fire-and-forget — starting the
/// server is async and must never block the unlock path. The advisor/cloud
/// sub-option is not persisted, so a restart begins with cloud MCP OFF (the
/// safe default); the user re-enables it from Settings if they want it.
pub(crate) fn spawn_room_server_if_enabled(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (enabled, web_enabled) = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            let enabled =
                db::get_setting(&room.conn, "room_server_enabled").as_deref() == Some("1");
            (enabled, web_access_enabled(&room.conn))
        };
        if !enabled {
            return;
        }
        // Never double-start (a stale flag plus a manual toggle could race).
        {
            let state = app.state::<AppState>();
            if state.room_server.lock().unwrap().is_some() {
                return;
            }
        }
        if let Ok(bridge) = crate::room_mcp::start(app.clone(), web_enabled, false).await {
            let state = app.state::<AppState>();
            *state.room_server.lock().unwrap() = Some(bridge);
        }
    });
}

// ---------------------------------------------------------------- speech-to-text (ADD-18)

/// True if a biometric Keychain entry exists for this room path. Never prompts.
#[tauri::command]
pub fn touchid_has(path: String) -> Result<bool, String> {
    Ok(crate::biometrics::has(&path))
}

/// Store the CURRENTLY-OPEN room's password in the Keychain, guarded by
/// biometrics. The secret is read from the in-memory Room — it is never taken
/// from a file and never written anywhere but the Keychain.
#[tauri::command]
pub fn touchid_enable(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    crate::biometrics::store(&room.path, &room.password)
}

/// Turn Touch ID off for a room: delete its Keychain entry (idempotent).
#[tauri::command]
pub fn touchid_disable(path: String) -> Result<(), String> {
    crate::biometrics::delete(&path)
}

/// Fingerprint-unlock: trigger the system biometric prompt to read the stored
/// password, then take the normal `open_room` path. On cancel/failure this
/// returns a clear error and the UI falls back to the password field.
#[tauri::command]
pub fn touchid_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RoomInfo, String> {
    let password = crate::biometrics::read(&path)?;
    open_room(app, state, path, password)
}

#[tauri::command]
pub async fn close_room(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri::Emitter;
    // HLT-7: if an answer is streaming, cancel it and wait briefly for its
    // save-partial phase to finish, so locking never races the DB shut.
    {
        let flags: Vec<Arc<AtomicBool>> =
            state.cancels.lock().unwrap().values().cloned().collect();
        if !flags.is_empty() {
            for f in &flags {
                f.store(true, Ordering::SeqCst);
            }
            // Up to ~1s; the ask removes its own entry once it has saved.
            for _ in 0..20 {
                if state.cancels.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    // SEC-7: reclaim space before closing when a large amount was freed (e.g.
    // the user deleted big files). Small deletions skip the slow vacuum.
    {
        let guard = state.room.lock().unwrap();
        if let Some(room) = guard.as_ref() {
            if db::reclaimable_bytes(&room.conn).unwrap_or(0) > 10 * 1024 * 1024 {
                let _ = db::vacuum(&room.conn);
            }
        }
    }
    *state.room.lock().unwrap() = None;
    // D9 (the Leash): a locked room must not leave its MCP endpoint reachable —
    // stop and clear it here so close/lock always tears the server down.
    {
        let taken = state.room_server.lock().unwrap().take();
        if let Some(bridge) = taken {
            bridge.stop();
        }
    }
    // Dropping the clients kills the server processes (kill_on_drop).
    {
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        mgr.servers.clear();
    }
    // SEC-1b: per-call MCP consent is per session — forget it on lock, and drop
    // any in-flight approval requests (their awaiters resolve to a decline).
    state.mcp_session_ok.lock().unwrap().clear();
    state.mcp_pending.lock().unwrap().clear();
    let _ = app.emit("mcp-status", Vec::<mcp::ServerStatus>::new());
    Ok(())
}

#[tauri::command]
pub fn room_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<RoomInfo>, String> {
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => Ok(Some(info_of(&app, room)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn take_pending_open(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.pending_open.lock().unwrap().take())
}

// ---------------------------------------------------------------- files


