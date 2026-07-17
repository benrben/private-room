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
    // Creating a room while another is open must fully tear the old one down
    // first — its MCP bridge (and bearer token) would otherwise survive and
    // serve tools that now resolve against the NEW room.
    if state.room.lock().unwrap().is_some() {
        teardown_open_room(&app, &state);
    }
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
    // ADD-30: a job left 'running' belongs to a process that's gone — mark it
    // 'paused' so the UI offers Resume rather than a phantom active job.
    if let Some(r) = state.room.lock().unwrap().as_ref() {
        quiesce_stale_jobs(&r.conn);
    }
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
    // Opening a room while another is open (Finder double-click on a second
    // .roomai) must fully tear the old one down first — its MCP bridge (and
    // bearer token) would otherwise survive and serve tools that now resolve
    // against the NEW room. Runs only after the password proved right, so a
    // failed unlock never locks the room the user is in.
    if state.room.lock().unwrap().is_some() {
        teardown_open_room(&app, &state);
    }
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
    // ADD-30: a job left 'running' belongs to a process that's gone — mark it
    // 'paused' so the UI offers Resume rather than a phantom active job.
    if let Some(r) = state.room.lock().unwrap().as_ref() {
        quiesce_stale_jobs(&r.conn);
        // A live recording that died with the app left audio checkpoints
        // behind — splice them onto the WAV so nothing recorded is lost.
        match db::recover_rec_chunks(&r.conn) {
            Ok(0) | Err(_) => {}
            Ok(n) => eprintln!("recovered {n} interrupted recording(s)"),
        }
    }
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
    state.with_room(|room| db::write_recovery(&room.path, &room.password))
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
        if let Ok(bridge) = crate::room_mcp::start(
            app.clone(),
            web_enabled,
            crate::room_mcp::ToolScope::CloudAdvisor { include_mcp: false },
            None,
        )
        .await
        {
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
    state.with_room(|room| crate::biometrics::store(&room.path, &room.password))
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
    // ADD-27: a live recording must land in the DB before the room locks.
    // Stop it and wait for the engine's final flush (it drains its decoder
    // first), bounded so a stuck decode can never wedge lock/close.
    {
        use tauri::Manager;
        let rec = app.state::<RecState>();
        let done_rx = {
            let mut session = rec.session.lock().unwrap();
            session.take().map(|live| {
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                let _ = live.handle.tx.send(recording::EngineMsg::Stop { done: done_tx });
                done_rx
            })
        };
        if let Some(done_rx) = done_rx {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                done_rx.recv_timeout(std::time::Duration::from_secs(30))
            })
            .await;
        }
    }
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
    // Background jobs (deep summary / file pass) must stop before the room
    // state is torn down, so a runner can't keep writing after the lock.
    // Signal every job's cancel flag and wait briefly — the runner removes its
    // entry once it has parked the job 'paused' on this room's still-open
    // conn. Bounded: a deep-summary model call doesn't observe the flag, so
    // the wait is best-effort; each job's room pin (see `spawn_deep_summary` /
    // `execute_pass_step`) is the correctness guarantee.
    {
        let flags: Vec<Arc<AtomicBool>> =
            state.job_cancels.lock().unwrap().values().cloned().collect();
        if !flags.is_empty() {
            for f in &flags {
                f.store(true, Ordering::SeqCst);
            }
            for _ in 0..20 {
                if state.job_cancels.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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
    // The synchronous teardown (room handle, MCP bridge + servers, consents,
    // staged media, agent-UI round-trips) is shared with the open-over-open
    // path — see `teardown_open_room`.
    teardown_open_room(&app, &state);
    Ok(())
}

/// Synchronously tear down every piece of per-room state: the room handle, the
/// persistent MCP bridge (and its bearer token), connected MCP servers,
/// per-session consents, staged media, and pending agent↔UI round-trips.
/// Shared by `close_room` and the open-over-open path (`open_room` /
/// `create_room` on top of an already-open room), so the old room's bridge can
/// never keep serving tools that resolve against the new room. Cancel flags
/// are signalled but not awaited — callers that can await (`close_room`) drain
/// them first; a live recording is told to stop without waiting.
pub(crate) fn teardown_open_room(app: &tauri::AppHandle, state: &AppState) {
    use tauri::{Emitter, Manager};
    // Signal every in-flight ask and background job to stop (no wait here).
    for f in state.cancels.lock().unwrap().values() {
        f.store(true, Ordering::SeqCst);
    }
    for f in state.job_cancels.lock().unwrap().values() {
        f.store(true, Ordering::SeqCst);
    }
    // Best-effort: tell a live recording engine to stop and flush. No wait —
    // the done receiver is dropped and the engine ignores the failed send.
    {
        let rec = app.state::<RecState>();
        let taken = rec.session.lock().unwrap().take();
        if let Some(live) = taken {
            let (done_tx, _) = std::sync::mpsc::channel();
            let _ = live.handle.tx.send(recording::EngineMsg::Stop { done: done_tx });
        }
    }
    *state.room.lock().unwrap() = None;
    // D9 (the Leash): a locked room must not leave its MCP endpoint reachable —
    // stop and clear it here so teardown always kills the server + its token.
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
    // ADD-24/ADD-25: a locked room leaves no decrypted media staged for the
    // streaming protocol, and no agent↔UI round-trip left hanging.
    clear_media(&app.state::<MediaStreams>());
    app.state::<AgentUi>().pending.lock().unwrap().clear();
    let _ = app.emit("mcp-status", Vec::<mcp::ServerStatus>::new());
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


