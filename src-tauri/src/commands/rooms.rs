use super::*;

#[tauri::command]
pub fn create_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
    name: Option<String>,
) -> Result<RoomInfo, String> {
    // Wave 3 (Idea 9): don't create/switch rooms while a rollback is swapping.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // The name the user TYPED on the Create screen, when they typed one. It used
    // to be a filename suggestion and nothing else: the room was named after
    // whatever the save panel ended up called, so typing "Journal" and saving as
    // "stuff" left the room called "stuff" in the title bar, the recents list
    // and every mention of it. Falling back to the path keeps every other caller
    // (and a room created without a name) behaving exactly as before.
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| room_name_from_path(&path));
    let conn = db::create_room(&path, &password, &name)?;
    // Creating a room while another is open must fully tear the old one down
    // first — its MCP bridge (and bearer token) would otherwise survive and
    // serve tools that now resolve against the NEW room.
    if state.room_guard().is_some() {
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
    *state.room_guard() = Some(room);
    // ADD-30: a job left 'running' belongs to a process that's gone — mark it
    // 'paused' so the UI offers Resume rather than a phantom active job.
    if let Some(r) = state.room_guard().as_ref() {
        quiesce_stale_jobs(&r.conn);
    }
    refresh_mcp(&app);
    spawn_reextract_backfill(&app);
    spawn_legacy_text_repair(&app);
    spawn_embedding_backfill(&app);
    spawn_room_server_if_enabled(&app);
    // Wave 4a: start the workflow scheduler and pump any jobs left queued.
    spawn_workflow_scheduler(&app);
    pump_on_open(&app);
    Ok(info)
}

#[tauri::command]
pub fn open_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    // Wave 3 (Idea 9): a rollback is mid-swap — opening a (different) room now
    // would tear down the room it is about to reopen. The rollback path itself
    // reopens via `open_room_impl`, which skips this guard.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    open_room_impl(&app, &state, path, password)
}

/// The body of `open_room`, without the rollback-in-flight guard, so
/// `rollback_room_checkpoint` can reopen the swapped file while its own flag is
/// still set. Takes references (not `State` by value) so the rollback path can
/// call it on both its error and success branches. Every other caller goes
/// through the guarded command.
pub(crate) fn open_room_impl(
    app: &tauri::AppHandle,
    state: &AppState,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    let conn = db::open_room(&path, &password)?;
    // Opening a room while another is open (Finder double-click on a second
    // .roomai) must fully tear the old one down first — its MCP bridge (and
    // bearer token) would otherwise survive and serve tools that now resolve
    // against the NEW room. Runs only after the password proved right, so a
    // failed unlock never locks the room the user is in.
    if state.room_guard().is_some() {
        teardown_open_room(app, state);
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
    let info = info_of(app, &room)?;
    push_recent(app, &room.name, &room.path);
    *state.room_guard() = Some(room);
    // ADD-30: a job left 'running' belongs to a process that's gone — mark it
    // 'paused' so the UI offers Resume rather than a phantom active job.
    if let Some(r) = state.room_guard().as_ref() {
        quiesce_stale_jobs(&r.conn);
        // A live recording that died with the app left audio checkpoints
        // behind — splice them onto the WAV so nothing recorded is lost.
        match db::recover_rec_chunks(&r.conn) {
            Ok(0) => {}
            Ok(n) => eprintln!("recovered {n} interrupted recording(s)"),
            // Swallowing this meant the user simply found the end of a meeting
            // missing, with nothing said either way — on every unlock, forever.
            Err(e) => report_rec_recovery_failure(app, &r.path, e),
        }
    }
    refresh_mcp(app);
    spawn_reextract_backfill(app);
    spawn_legacy_text_repair(app);
    spawn_embedding_backfill(app);
    // D9 (the Leash): if the user left the room server on, start it again now.
    spawn_room_server_if_enabled(app);
    // Wave 4a: start the workflow scheduler and pump any jobs left queued from a
    // previous session (open decision 2: auto-start at unlock).
    spawn_workflow_scheduler(app);
    pump_on_open(app);
    // PRIV-1: resolve this room's privacy policy into the cache, and catch up
    // on any files imported while the door was off/absent.
    refresh_policy(app, state);
    schedule_privacy_scan(app.clone());
    Ok(info)
}

/// Tell the user that audio left behind by a crashed recording could NOT be
/// spliced back. Rides the recording area's existing `rec-error` channel (an
/// error toast), because a rescue that silently does nothing looks exactly like
/// a meeting whose end was never recorded.
///
/// The message is PARKED first and emitted second, and the parked copy is the
/// one that counts. `open_room_impl` returns before the workspace has mounted
/// its listeners — the unlock ritual alone is ~520 ms, then the tree renders,
/// then Tauri's async `listen()` registration completes — so a one-shot emit on
/// a fixed timer is a guess, and on a cold start it loses the race and the
/// failure is silent again, which is the very thing this reports. The workspace
/// collects the parked message on mount (`take_rec_recovery_error`), so
/// delivery no longer depends on when anyone started listening.
///
/// The emit stays for the workspace that IS already up (an open-over-open
/// unlock), and it re-checks that this room is still the open one, so locking up
/// immediately can't produce a toast about a room that is gone.
fn report_rec_recovery_failure(app: &tauri::AppHandle, room_path: &str, err: String) {
    use tauri::Manager as _;
    eprintln!("recording recovery failed: {err}");
    let message = format!(
        "Audio from an interrupted recording could not be restored: {err} \
         Nothing was lost — it is still stored in the room, and the rescue \
         runs again the next time you unlock it."
    );
    if let Ok(mut parked) = app.state::<AppState>().rec_recovery_error.lock() {
        *parked = Some(message.clone());
    }
    let (app, room_path) = (app.clone(), room_path.to_string());
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter as _;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let still_open = app
            .state::<AppState>()
            .room
            .lock()
            .map(|g| g.as_ref().is_some_and(|r| r.path == room_path))
            .unwrap_or(false);
        if !still_open {
            return;
        }
        // Only if nobody has collected it yet — otherwise a workspace that was
        // already listening gets the same failure twice.
        let claimed = app
            .state::<AppState>()
            .rec_recovery_error
            .lock()
            .map(|mut p| p.take().is_some())
            .unwrap_or(false);
        if !claimed {
            return;
        }
        let _ = app.emit(
            "rec-error",
            serde_json::json!({ "fileId": "", "message": message }),
        );
    });
}

/// The parked "audio could not be restored" message, if the last unlock left
/// one. Cleared by the read: the workspace calls this once on mount, so the
/// failure reaches the screen whether or not a listener existed when the rescue
/// ran. `None` is the ordinary answer and means exactly nothing went wrong.
#[tauri::command]
pub fn take_rec_recovery_error(state: State<'_, AppState>) -> Option<String> {
    take_recovery_error(&state)
}

fn take_recovery_error(state: &AppState) -> Option<String> {
    state.rec_recovery_error.lock().ok().and_then(|mut p| p.take())
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

/// D9/Wave 1a (the Leash): on unlock, restart the persistent room MCP server
/// if its toggle (`room_server_enabled`) was left on, at the PERSISTED tier
/// (`room_server_scope`). Fire-and-forget — starting the server is async and
/// must never block the unlock path. Deliberate asymmetry: the advisor/cloud
/// sub-option is not persisted, so a files-tier restart begins with cloud MCP
/// OFF (the safe default), while the user-configured full tier IS restored —
/// with its persisted `leash_port`/`leash_token`, so a pasted external-agent
/// config keeps working across restarts (loopback + bearer + explicit opt-in).
pub(crate) fn spawn_room_server_if_enabled(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (enabled, web_enabled, scope, opts, room_path, room_name) = {
            let state = app.state::<AppState>();
            let guard = state.room_guard();
            let Some(room) = guard.as_ref() else { return };
            let enabled =
                db::get_setting(&room.conn, "room_server_enabled").as_deref() == Some("1");
            let scope_setting = db::get_setting(&room.conn, "room_server_scope");
            let scope = leash_scope(scope_setting.as_deref(), false);
            let mut opts = if scope == crate::room_mcp::ToolScope::ExternalAgent {
                match leash_identity(&room.conn) {
                    Ok((port, token)) => {
                        crate::room_mcp::StartOpts { port: Some(port), token: Some(token), ..Default::default() }
                    }
                    Err(_) => return,
                }
            } else {
                crate::room_mcp::StartOpts::default()
            };
            opts.lanes = web_lanes(&room.conn);
            (
                enabled,
                web_access_enabled(&room.conn),
                scope,
                opts,
                room.path.clone(),
                room.name.clone(),
            )
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
        if let Ok(bridge) =
            crate::room_mcp::start(app.clone(), web_enabled, scope, None, opts).await
        {
            let state = app.state::<AppState>();
            // Store only if this room is still the open one — a teardown
            // (close, open-over-open) during the await must win, or the
            // stale bridge would serve the NEXT room with THIS room's token.
            let (port, token, bscope) = (bridge.port, bridge.token.clone(), bridge.scope);
            if store_bridge_if_current(&state, &room_path, bridge) {
                let _ = write_discovery(&app, port, &token, scope_name(bscope), &room_name);
            }
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
    // Wave 3 (Idea 9): the rollback path tears the room down itself via
    // teardown_open_room — a concurrent close_room mid-swap must not race it
    // (a user LOCKING mid-rollback would otherwise get the room reopened under
    // them by step 6.7). Refuse; the rollback finishes in a moment.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // Stop the live recording, cancel in-flight asks and background jobs, and
    // wait (bounded) for each to finish writing — the same drain the rollback
    // path uses (Wave 3, Idea 9). close_room ignores whether every writer
    // reported done; the teardown below is the correctness backstop.
    let _ = drain_inflight(&app, &state).await;
    // SEC-7 used to VACUUM here whenever more than 10 MB was reclaimable, which
    // made "Lock" rewrite the entire (possibly multi-GB) room file with no
    // message, no progress and no way to skip — deleting two documents from a
    // big room was enough to trigger it. Compacting is now only ever the
    // explicit Settings → "Compact room" action (`compact_room`), which reports
    // what it reclaimed; locking just locks.
    // The synchronous teardown (room handle, MCP bridge + servers, consents,
    // staged media, agent-UI round-trips) is shared with the open-over-open
    // path — see `teardown_open_room`.
    teardown_open_room(&app, &state);
    Ok(())
}

/// Wave 3 (Idea 9): what `drain_inflight` observed — whether each cancellable
/// writer class emptied within its bounded wait. `close_room` ignores this;
/// `rollback_room_checkpoint` refuses on any `false`, so a straggler that never
/// observed the cancel flag can't slip past the swap.
pub(crate) struct DrainReport {
    pub asks_drained: bool,
    pub jobs_drained: bool,
}

/// Stop the live recording (waiting for its final flush) and signal every
/// in-flight ask + background job to cancel, waiting briefly for each registry
/// to empty. Extracted from `close_room` (behavior-preserving) so the rollback
/// path drains the exact same writers before it swaps the DB. The recording
/// flush is awaited (bounded 30s); the ask/job waits are bounded and reported.
pub(crate) async fn drain_inflight(app: &tauri::AppHandle, state: &AppState) -> DrainReport {
    use tauri::Manager;
    // ADD-27: a live recording must land in the DB before the room changes.
    // Stop it and wait for the engine's final flush (it drains its decoder
    // first), bounded so a stuck decode can never wedge lock/close/rollback.
    {
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
    // save-partial phase to finish, so the swap never races the DB shut.
    let asks_drained = {
        let flags: Vec<Arc<AtomicBool>> =
            state.cancels.lock().unwrap().values().cloned().collect();
        for f in &flags {
            f.store(true, Ordering::SeqCst);
        }
        // Owner replacement #3: the map above holds ROOTS. Work a run started —
        // a Studio build dispatched by an agent tool — carries its own flag,
        // which lives only in the cancel TREE, so flipping roots alone would
        // leave it generating against a room being sealed and then writing its
        // page into it. The wait below is unchanged: it still watches this map
        // empty, which is what a run's own epilogue reports.
        crate::cancel::cancel_all(state);
        // Up to ~1s; the ask/command removes its own entry once it has saved.
        let mut drained = true;
        if !flags.is_empty() {
            drained = false;
            for _ in 0..20 {
                if state.cancels.lock().unwrap().is_empty() {
                    drained = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        drained
    };
    // Background jobs (deep summary / file pass) must stop before the room
    // state is torn down, so a runner can't keep writing after the swap.
    // Signal every job's cancel flag and wait briefly — the runner removes its
    // entry once it has parked the job 'paused'. Bounded: a model call doesn't
    // observe the flag, so the wait is best-effort here; the room-epoch pin is
    // the correctness guarantee, and rollback refuses if this returns false.
    //
    // Stamp WHY first, while the room is still open and every runner is still
    // alive. The two landings a moment from now write different statuses — a
    // runner that observes the flag parks itself 'paused', one still inside a
    // model call is forced 'paused' by `teardown_open_room` — and neither of
    // them knows it was the LOCK that stopped it. Recorded here, once, so the
    // card can't read as a Stop the user chose.
    let _ = state.with_room(|room| {
        mark_jobs_parking(&room.conn, PARKED_BY_LOCK);
        Ok(())
    });
    let jobs_drained = {
        let flags: Vec<Arc<AtomicBool>> =
            state.job_cancels.lock().unwrap().values().cloned().collect();
        for f in &flags {
            f.store(true, Ordering::SeqCst);
        }
        let mut drained = true;
        if !flags.is_empty() {
            drained = false;
            for _ in 0..20 {
                if state.job_cancels.lock().unwrap().is_empty() {
                    drained = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        drained
    };
    DrainReport { asks_drained, jobs_drained }
}

/// Park whatever this room still has in flight, at the LAST moment its DB is
/// reachable. Returns how many jobs were parked.
///
/// A runner inside a model call will not observe the lock's cancel flag for
/// minutes; when it finally does, its epilogue finds the room gone and writes
/// nothing at all — so the row simply stayed 'running' in the encrypted file,
/// work the app had definitively abandoned recorded as work in progress, until
/// some later unlock happened to quiesce it. Locking is terminal for the work
/// and the row must say so from the instant it happens.
///
/// The checkpoint (`cursor`/`state`) is deliberately untouched: parked is not
/// cancelled, and Resume continues from where the job actually got to.
///
/// Split out of `teardown_open_room` so the rule can be exercised against a
/// real `AppState` on its own, without a Tauri runtime in the way. The teardown
/// that calls it is covered too, on a mock runtime — the call site and its
/// position in the sequence are the part that used to be invisible.
pub(crate) fn park_inflight_jobs_for_teardown(state: &AppState) -> usize {
    let guard = state.room_guard();
    match guard.as_ref() {
        Some(room) => park_running_jobs(&room.conn, PARKED_BY_LOCK),
        // Nothing open — a second teardown, or a failed unlock. There is no room
        // whose jobs could be in flight, so there is nothing to record.
        None => 0,
    }
}

/// Synchronously tear down every piece of per-room state: the room handle, the
/// persistent MCP bridge (and its bearer token), connected MCP servers,
/// per-session consents, staged media, and pending agent↔UI round-trips.
/// Shared by `close_room` and the open-over-open path (`open_room` /
/// `create_room` on top of an already-open room), so the old room's bridge can
/// never keep serving tools that resolve against the new room. Cancel flags
/// are signalled but not awaited — callers that can await (`close_room`) drain
/// them first; a live recording is told to stop without waiting.
///
/// Generic over the runtime so the sequence below can actually be tested: the
/// order matters (the browser's journal and the job park both need the room's
/// DB still open), and with a concrete `AppHandle` there is no way to stand one
/// up outside a running app. Every caller passes the real handle and infers
/// `R = Wry`, so nothing at the call sites changes.
pub(crate) fn teardown_open_room<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState) {
    use tauri::{Emitter, Manager};
    // Signal every in-flight ask and background job to stop (no wait here) —
    // and, through the tree, whatever they had started (see `cancel::cancel_all`).
    for f in state.cancels.lock().unwrap().values() {
        f.store(true, Ordering::SeqCst);
    }
    for f in state.job_cancels.lock().unwrap().values() {
        f.store(true, Ordering::SeqCst);
    }
    crate::cancel::cancel_all(state);
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
    // BROWSE-1: the private browser must not outlive the room. Its webview is
    // non-persistent, so destroying it takes the whole session's cookies,
    // cache and history with it — but a LIVE page left floating over a locked
    // room would also still be showing whatever the room was looking at, and
    // its agent journal has to flush into the DB while the DB is still open.
    // Closed BEFORE the room handle drops, for exactly that reason.
    let _ = crate::browser::close(app);
    park_inflight_jobs_for_teardown(state);
    // The warm window is for someone who stepped away from an open room, not
    // for a locked one — see `note_room_closed`.
    crate::ollama_lifecycle::note_room_closed();
    *state.room_guard() = None;
    // PRIV-1: the cached privacy policy holds the room's protected strings —
    // it must not outlive the room handle (same invariant as the MCP token).
    clear_policy();
    // Wave 3 (Idea 9): bump the room epoch the instant the room handle drops.
    // Every path-pinned background writer (OCR/STT lanes, summary filler,
    // re-extract backfill, room summarize) captured the old epoch at spawn and
    // re-checks it before writing, so a straggler that was mid-await when a
    // rollback swapped the DB can't land its write against the reopened room
    // (the room PATH is unchanged after a rollback, so the path pin can't tell).
    state.room_epoch.fetch_add(1, Ordering::SeqCst);
    // D9 (the Leash): a locked room must not leave its MCP endpoint reachable —
    // stop and clear it here so teardown always kills the server + its token
    // (live connections included — the bridge's shutdown channel severs them),
    // and the discovery file never advertises a dead or foreign endpoint.
    {
        let taken = state.room_server.lock().unwrap().take();
        if let Some(bridge) = taken {
            bridge.stop();
            remove_discovery(app);
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
    // Wave 2 (Idea 6): drop any in-flight diff-preview approval requests too —
    // their awaiters resolve to a decline, so nothing lands after a room closes.
    state.edit_pending.lock().unwrap().clear();
    // Wave 5 (Idea 13): drop any in-flight script-run approval requests too.
    state.script_pending.lock().unwrap().clear();
    // ADD-24/ADD-25: a locked room leaves no decrypted media staged for the
    // streaming protocol, and no agent↔UI round-trip left hanging.
    clear_media(&app.state::<MediaStreams>());
    // Waveform envelopes are derived from decrypted audio, so they leave with it.
    clear_peaks(&app.state::<PeakCache>());
    clear_slides(&app.state::<SlideCache>());
    // Staged preview pages are BUILT FROM the room's files (flashcard decks,
    // mind maps, podcast scripts, HTML previews) and stayed readable at
    // `roomdoc://localhost/<token>` after the lock — the one decrypted store
    // this teardown did not touch. Same invariant as the media/peak/slide
    // caches above: locking means the room's content is gone from memory.
    app.state::<HtmlPreviews>().map.lock().unwrap().clear();
    // "Open in browser" writes real page content, unencrypted, to a temp folder.
    // It used to be swept only at the next app START or a clean exit, so a
    // locked room (or a crash) left it on disk indefinitely. Swept here too,
    // with a grace period: `/usr/bin/open` returns BEFORE the browser has read
    // the file, so a page opened seconds ago must survive its own hand-off.
    crate::commands::studios::cleanup_browser_previews_older_than(
        std::time::Duration::from_secs(60),
    );
    app.state::<AgentUi>().pending.lock().unwrap().clear();
    // The AI service keeps its compacted digests of this conversation in
    // memory, keyed by content hash, and outlives every room — nothing had ever
    // asked it to let go. Fire-and-forget on purpose: the sidecar may not be
    // running, and a lock must never block on it.
    crate::sidecar::forget_room_memory();
    let _ = app.emit("mcp-status", Vec::<mcp::ServerStatus>::new());
}

#[tauri::command]
pub fn room_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<RoomInfo>, String> {
    let guard = state.room_guard();
    match guard.as_ref() {
        Some(room) => Ok(Some(info_of(&app, room)?)),
        None => Ok(None),
    }
}

/// Longest room name we will store. Long enough for any sentence someone would
/// call a room, short enough that the top bar and the recents list stay
/// readable.
pub(crate) const MAX_ROOM_NAME_CHARS: usize = 120;

/// Rename the open room.
///
/// The name lives in the room's own encrypted `meta` table, where `create_room`
/// wrote it once from the file name — and nothing ever wrote it again. Renaming
/// the `.roomai` file in Finder changed nothing (the name is read from `meta`,
/// not the path), so the file and the app showed different names forever, and
/// "Save a copy" carried the original's name into the duplicate.
///
/// Both copies of the name are updated together: the room's `meta` (the
/// authority, which travels with the file) and the recents entry for this path
/// (which has to carry its own copy — it names rooms that are locked).
#[tauri::command]
pub fn rename_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<RoomInfo, String> {
    // Wave 3 (Idea 9): a rollback is about to replace this DB — a name written
    // now would be swapped away without a word.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("A room needs a name.".into());
    }
    if name.chars().count() > MAX_ROOM_NAME_CHARS {
        return Err(format!(
            "That name is too long — {MAX_ROOM_NAME_CHARS} characters at most."
        ));
    }
    let info = {
        let mut guard = state.room_guard();
        let room = guard.as_mut().ok_or("No room is open.")?;
        db::set_meta(&room.conn, "name", name)?;
        room.name = name.to_string();
        info_of(&app, room)?
    };
    let _ = write_recent(
        &app,
        &rename_recent(read_recent(&app), &info.path, &info.name),
    );
    Ok(info)
}

#[tauri::command]
pub fn take_pending_open(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.pending_open.lock().unwrap().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `AppState` with a room open on an in-memory DB, plus a SECOND handle
    /// to the same database — so the test can still read the jobs table after
    /// the room handle is gone, which is the only way to see what locking wrote.
    fn open_room_with_reader(tag: &str) -> (AppState, Connection) {
        let uri = format!("file:{tag}?mode=memory&cache=shared");
        // Held open for the whole test: a shared-cache in-memory DB lives only
        // as long as one connection to it does.
        let reader = Connection::open(&uri).unwrap();
        reader.execute_batch(crate::db::SCHEMA).unwrap();
        let conn = Connection::open(&uri).unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn,
            path: uri,
            name: "QA".into(),
            password: "qa".into(),
        });
        (state, reader)
    }

    #[test]
    fn locking_a_room_parks_the_job_that_was_running_inside_it() {
        // The empirical hole this closes. `close_room` signals every job to stop
        // and waits ~2s; a runner inside a model call does not observe the flag
        // in that window, and by the time it does its epilogue finds no open
        // room and writes NOTHING. The row therefore stayed 'running' in the
        // room file — work the app had definitively abandoned, recorded as work
        // in progress — until some later unlock happened to quiesce it.
        let (state, reader) = open_room_with_reader("park-teardown-running");
        let plan = serde_json::json!({ "workflow_id": "wf-1" });
        let (running, queued) = state
            .with_room(|room| {
                let running =
                    db::create_job(&room.conn, "workflow", "Workflow — Digest", &plan, 4)?;
                db::set_job_status(&room.conn, &running, "running", None)?;
                db::checkpoint_job(&room.conn, &running, 2, &serde_json::json!({ "done": [0, 1] }))?;
                let queued = db::create_job(&room.conn, "file_pass", "Full pass", &plan, 4)?;
                Ok((running, queued))
            })
            .unwrap();

        assert_eq!(park_inflight_jobs_for_teardown(&state), 1);

        // Read the room the way the next unlock will.
        let j = db::get_job(&reader, &running).unwrap();
        assert_eq!(j.status, "paused", "never left claiming to be running");
        assert_eq!(j.parked_reason.as_deref(), Some(PARKED_BY_LOCK));
        assert_eq!(j.cursor, 2, "the checkpoint Resume needs is untouched");
        assert_eq!(j.state["done"], serde_json::json!([0, 1]));
        // A queued job never started, holds nothing half-done, and is what
        // `pump_on_open` auto-starts at the next unlock — parking it here is the
        // change that once made that path a dead no-op.
        assert_eq!(db::get_job(&reader, &queued).unwrap().status, "queued");
    }

    #[test]
    fn the_teardown_sweep_is_a_park_not_a_reset() {
        // History is the other half of the Activity split, and a completed run
        // rewritten to 'paused' would come back offering to redo work that is
        // already done. A job the USER stopped keeps its own story too: nobody
        // interrupted it, so nothing gets blamed on the lock.
        let (state, reader) = open_room_with_reader("park-teardown-terminal");
        let (done, paused, failed) = state
            .with_room(|room| {
                let p = serde_json::json!({});
                let done = db::create_job(&room.conn, "studio", "Flashcards", &p, 1)?;
                db::set_job_status(&room.conn, &done, "done", None)?;
                let paused = db::create_job(&room.conn, "file_pass", "Full pass", &p, 4)?;
                db::set_job_status(&room.conn, &paused, "paused", None)?;
                let failed = db::create_job(&room.conn, "deep_summary", "Room summary", &p, 2)?;
                db::set_job_status(&room.conn, &failed, "error", Some("OLLAMA_DOWN"))?;
                Ok((done, paused, failed))
            })
            .unwrap();

        assert_eq!(park_inflight_jobs_for_teardown(&state), 0, "nothing was in flight");

        assert_eq!(db::get_job(&reader, &done).unwrap().status, "done");
        assert_eq!(db::get_job(&reader, &done).unwrap().parked_reason, None);
        let p = db::get_job(&reader, &paused).unwrap();
        assert_eq!(p.status, "paused");
        assert_eq!(p.parked_reason, None);
        let f = db::get_job(&reader, &failed).unwrap();
        assert_eq!(f.status, "error");
        assert_eq!(f.error.as_deref(), Some("OLLAMA_DOWN"), "a real failure keeps its message");
    }

    /// A mock-runtime app carrying every per-room state `teardown_open_room`
    /// reaches for. `app.state::<T>()` panics on anything unmanaged, so this
    /// list is also the honest inventory of what the teardown touches.
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Manager as _;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(crate::browser::BrowserState::default());
        app.manage(RecState::default());
        app.manage(MediaStreams::default());
        app.manage(PeakCache::default());
        app.manage(SlideCache::default());
        app.manage(HtmlPreviews::default());
        app.manage(AgentUi::default());
        app
    }

    #[test]
    fn teardown_clears_the_staged_preview_pages() {
        // Flashcards, mind maps, podcast scripts and HTML previews are BUILT
        // FROM the room's files and stay readable at
        // `roomdoc://localhost/<token>` for as long as they sit in this map.
        // Every other decrypted store — media, peaks, slides — left on lock;
        // this one did not, so a locked room's documents were still served.
        use tauri::Manager as _;
        let (state, _reader) = open_room_with_reader("teardown-previews");
        let app = mock_app();
        let token = crate::commands::studios::stage_preview_html_core(
            app.state::<HtmlPreviews>().inner(),
            "<p>the room's own text</p>".into(),
        );
        assert!(app.state::<HtmlPreviews>().map.lock().unwrap().contains_key(&token));

        teardown_open_room(app.handle(), &state);

        assert!(
            app.state::<HtmlPreviews>().map.lock().unwrap().is_empty(),
            "a locked room's previewed documents must not stay readable in memory",
        );
    }

    #[test]
    fn teardown_parks_in_flight_jobs_while_the_room_can_still_be_written_to() {
        // The rule above is only worth having if the teardown still CALLS it,
        // and calls it in the right place. Both halves were invisible to the
        // tests: `park_inflight_jobs_for_teardown` was exercised directly, so
        // deleting its one call site — or moving it below `state.room = None`,
        // where the park would have no database to write to — left every
        // assertion green while the room went back to disk claiming a job it
        // had abandoned was still running. This drives the real teardown.
        let (state, reader) = open_room_with_reader("teardown-call-site");
        let running = state
            .with_room(|room| {
                let id = db::create_job(
                    &room.conn,
                    "workflow",
                    "Workflow — Digest",
                    &serde_json::json!({ "workflow_id": "wf-1" }),
                    4,
                )?;
                db::set_job_status(&room.conn, &id, "running", None)?;
                db::checkpoint_job(&room.conn, &id, 2, &serde_json::json!({ "done": [0, 1] }))?;
                Ok(id)
            })
            .unwrap();

        let app = mock_app();
        teardown_open_room(app.handle(), &state);

        assert!(state.room.lock().unwrap().is_none(), "the room handle is gone");
        let j = db::get_job(&reader, &running).unwrap();
        assert_eq!(j.status, "paused", "the park happened, and it happened in time");
        assert_eq!(j.parked_reason.as_deref(), Some(PARKED_BY_LOCK));
        assert_eq!(j.cursor, 2, "parked, not reset — Resume still has its checkpoint");
    }

    #[test]
    fn teardown_bumps_the_room_epoch_so_stragglers_cannot_write_after_it() {
        // The other half of "the room is gone": a background writer that was
        // mid-await re-checks this counter before it lands anything. A teardown
        // that dropped the handle without bumping it would still let a
        // straggler write into whatever room opened next.
        let (state, _reader) = open_room_with_reader("teardown-epoch");
        let before = state.room_epoch.load(Ordering::SeqCst);
        let app = mock_app();
        teardown_open_room(app.handle(), &state);
        assert!(
            state.room_epoch.load(Ordering::SeqCst) > before,
            "the epoch must move, or a straggler's write still looks current",
        );
    }

    /// One panic under the room lock used to end the session.
    ///
    /// Rust marks a mutex POISONED for the rest of the process if a thread
    /// panics while holding it, and every command that touches the room takes
    /// this one lock with `.unwrap()`. So a single internal panic anywhere
    /// underneath it turned every LATER room action into a panic of its own:
    /// the window stayed up, nothing worked, and nothing explained why.
    #[test]
    fn the_room_survives_a_panic_under_its_own_lock() {
        let (state, _reader) = open_room_with_reader("poisoned-room-lock");
        let state = Arc::new(state);
        let poisoner = Arc::clone(&state);
        // Panic while holding the guard — exactly what poisons a mutex.
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.room.lock().unwrap();
            panic!("something under the room lock went wrong");
        })
        .join();
        assert!(state.room.is_poisoned(), "the test did not actually poison it");

        // The room is still open and still usable.
        let name = state
            .with_room(|room| Ok(db::get_meta(&room.conn, "missing").unwrap_or_default()))
            .expect("every room action failed for the rest of the session");
        assert_eq!(name, "");
        assert!(state.room_guard().is_some());
    }

    /// A rescue failure has to reach the user, and the event alone could not:
    /// the unlock is over before the workspace has mounted its listeners, so the
    /// message is parked for it to collect. Reading it clears it — nobody gets
    /// told twice — and an unlock where nothing failed parks nothing at all.
    #[test]
    fn a_failed_recording_rescue_waits_for_the_workspace_to_collect_it() {
        let state = AppState::default();
        // An unlock where the rescue worked (or had nothing to do) parks
        // nothing, and the workspace shows nothing.
        assert_eq!(take_recovery_error(&state), None);

        *state.rec_recovery_error.lock().unwrap() =
            Some("Audio from an interrupted recording could not be restored".into());
        assert!(take_recovery_error(&state)
            .is_some_and(|m| m.contains("could not be restored")));
        assert_eq!(
            take_recovery_error(&state),
            None,
            "collecting it must clear it, or every mount re-reports the same failure",
        );
    }

    #[test]
    fn a_teardown_with_no_room_open_reports_nothing_rather_than_guessing() {
        // A second teardown, or one after a failed unlock. There is no room
        // whose jobs could be in flight — and no room to write to either, so
        // claiming a park here would be a count of nothing.
        let state = AppState::default();
        assert_eq!(park_inflight_jobs_for_teardown(&state), 0);
    }
}

// ---------------------------------------------------------------- files


