// Wave 3 (Idea 9): whole-room checkpoints — named, consistent, encrypted copies
// of the entire `.roomai` file, and rollback to one with a safety copy taken
// first and all in-flight work drained before the swap. Explicitly NOT
// `snapshot.rs` (that is ADD-25 webview screenshots).
//
// The registry lives OUTSIDE the room DB — it must survive the DB being rolled
// back — in a plaintext sidecar directory beside the room file
// (`<room>.checkpoints/`), following the `.recovery` sidecar precedent. Only
// names/dates/sizes are plaintext; the `<uuid>.roomck` payloads are full
// SQLCipher copies keeping the room's current key.
use super::*;

/// The sidecar directory for a room's checkpoints, beside the room file — the
/// registry cannot live inside the DB that rollback replaces (same reasoning as
/// `recovery_sidecar_path`).
pub(crate) fn checkpoints_dir(room_path: &str) -> String {
    format!("{room_path}.checkpoints")
}

/// The `.roomck` payload path for one checkpoint id inside a checkpoints dir.
pub(crate) fn checkpoint_file_path(dir: &str, id: &str) -> String {
    format!("{dir}/{id}.roomck")
}

/// One checkpoint's plaintext metadata. `auto` marks the pre-rollback safety
/// copies (capped/pruned) apart from user checkpoints. camelCase so the same
/// struct serves the manifest file AND the frontend api.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub size_bytes: i64,
    pub auto: bool,
}

/// The on-disk registry: a versioned list of checkpoint metadata.
#[derive(Serialize, Deserialize, Clone)]
pub struct CheckpointManifest {
    pub v: u32,
    pub entries: Vec<CheckpointMeta>,
}

impl Default for CheckpointManifest {
    fn default() -> Self {
        CheckpointManifest { v: 1, entries: Vec::new() }
    }
}

/// The list command's payload: entries (newest first) plus the total on-disk
/// size, for the disk-growth warning.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointList {
    pub entries: Vec<CheckpointMeta>,
    pub total_bytes: i64,
}

// --------------------------------------------------------------- timestamps
//
// The app has no chrono dependency; every timestamp the DB writes comes from
// `strftime('%Y-%m-%dT%H:%M:%SZ','now')` (see db/schema.rs) — ISO 8601 with the
// trailing Z that says it is UTC. Checkpoint metadata lives in a JSON sidecar
// rather than the DB, so produce that SAME format here.
//
// It used to emit SQLite's older "YYYY-MM-DD HH:MM:SS" under a comment claiming
// that matched the rest of the app. It did not, and a checkpoint date shown by
// any screen that did not know to append the Z rendered in the wrong hour —
// which is why the checkpoints screen carries a private copy of `formatWhen`
// with an "append Z" patch-up. That patch-up passes an already-ISO string
// straight through, so it keeps working unchanged and can now be replaced by
// the shared `composer.formatWhen`.

fn format_epoch(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant's days-since-epoch → civil (y, m, d) algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_timestamp() -> String {
    format_epoch(now_secs())
}

fn now_date() -> String {
    now_timestamp().chars().take(10).collect()
}

fn mtime_timestamp(path: &std::path::Path) -> String {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| format_epoch(d.as_secs()))
        .unwrap_or_else(now_timestamp)
}

// --------------------------------------------------------------- manifest I/O

fn manifest_path(dir: &str) -> String {
    format!("{dir}/manifest.json")
}

pub(crate) fn read_manifest(dir: &str) -> CheckpointManifest {
    std::fs::read_to_string(manifest_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Single-shot manifest write: serialize to a temp file, then rename over the
/// live one (like the recovery sidecar), so a crash mid-write never leaves a
/// half-written manifest behind.
pub(crate) fn write_manifest(dir: &str, manifest: &CheckpointManifest) -> Result<(), String> {
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    let tmp = format!("{dir}/manifest.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Could not write the checkpoint manifest: {e}"))?;
    std::fs::rename(&tmp, manifest_path(dir))
        .map_err(|e| format!("Could not save the checkpoint manifest: {e}"))
}

/// The crash-recovery point in BOTH directions: drop manifest entries whose
/// `.roomck` is gone, refresh the sizes of the rest, delete stale `*.tmp` files
/// (a crash mid-vacuum), and ADOPT orphan `.roomck` files that no entry names (a
/// crash between the tmp→final rename and the manifest append) so no multi-GB
/// copy is ever an invisible leak. The healed manifest is written back.
pub(crate) fn reconcile(dir: &str) -> CheckpointManifest {
    let mut manifest = read_manifest(dir);
    // 0. Defensive dedupe by id (keep first) — a duplicate id must never leak
    //    into rekey/prune loops that would then act on the same file twice.
    {
        let mut seen: HashSet<String> = HashSet::new();
        manifest.entries.retain(|e| seen.insert(e.id.clone()));
    }
    // 1. Drop entries whose payload vanished; refresh the survivors' sizes.
    manifest
        .entries
        .retain(|e| std::path::Path::new(&checkpoint_file_path(dir, &e.id)).exists());
    for e in manifest.entries.iter_mut() {
        if let Ok(m) = std::fs::metadata(checkpoint_file_path(dir, &e.id)) {
            e.size_bytes = m.len() as i64;
        }
    }
    let known: HashSet<String> = manifest.entries.iter().map(|e| e.id.clone()).collect();
    // 2. Sweep the dir: delete stale temp files, adopt orphan payloads.
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let fname = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if fname.ends_with(".tmp") {
                let _ = std::fs::remove_file(&path);
            } else if let Some(id) = fname.strip_suffix(".roomck") {
                if !known.contains(id) {
                    let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                    manifest.entries.push(CheckpointMeta {
                        id: id.to_string(),
                        name: "Recovered checkpoint".into(),
                        created_at: mtime_timestamp(&path),
                        size_bytes: size,
                        auto: false,
                    });
                }
            }
        }
    }
    let _ = write_manifest(dir, &manifest);
    manifest
}

/// Every checkpoint's `.roomck` path for a room — used by `change_password` to
/// re-key each copy so a later password change never strands them.
pub(crate) fn checkpoint_ck_paths(room_path: &str) -> Vec<String> {
    let dir = checkpoints_dir(room_path);
    if !std::path::Path::new(&dir).exists() {
        return Vec::new();
    }
    reconcile(&dir)
        .entries
        .iter()
        .map(|e| checkpoint_file_path(&dir, &e.id))
        .collect()
}

fn checkpoint_name(dir: &str, id: &str) -> String {
    read_manifest(dir)
        .entries
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| e.name)
        .unwrap_or_else(|| "checkpoint".into())
}

/// Keep only the newest `keep` auto (pre-rollback) checkpoints; delete the rest.
fn prune_auto_checkpoints(dir: &str, keep: usize) {
    let mut manifest = reconcile(dir);
    let mut autos: Vec<(String, String)> = manifest
        .entries
        .iter()
        .filter(|e| e.auto)
        .map(|e| (e.id.clone(), e.created_at.clone()))
        .collect();
    autos.sort_by(|a, b| b.1.cmp(&a.1));
    let doomed: HashSet<String> = autos.into_iter().skip(keep).map(|(id, _)| id).collect();
    if doomed.is_empty() {
        return;
    }
    for id in &doomed {
        let _ = std::fs::remove_file(checkpoint_file_path(dir, id));
    }
    manifest.entries.retain(|e| !doomed.contains(&e.id));
    let _ = write_manifest(dir, &manifest);
}

// --------------------------------------------------------------- disk space
//
// A checkpoint is a SECOND FULL COPY of the room and a rollback stages a THIRD
// alongside it, so on a nearly-full disk the copy dies part-way through and the
// user sees SQLite's "database or disk is full". Check first and say so in
// words instead.

/// Bytes free on the volume holding `path`, or None when it cannot be told.
/// std has no free-space API and the app has no libc dependency, so ask `df`
/// — the same "shell out to a system tool" the extraction/STT paths already do.
/// `-P` pins the POSIX one-line-per-filesystem format; `-k` makes the blocks
/// 1024 bytes, so the Available column is column 3.
fn free_bytes(path: &str) -> Option<u64> {
    let out = std::process::Command::new("/bin/df")
        .args(["-Pk", path])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let blocks: u64 = text
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()?;
    blocks.checked_mul(1024)
}

/// Refuse before writing when `need` bytes (plus a little headroom) will not
/// fit on `dir`'s volume. Silent when free space can't be determined — a
/// missing `df` must never block a checkpoint that would have worked.
fn check_room_for(dir: &str, need: u64, what: &str) -> Result<(), String> {
    /// Leave the volume some air: SQLite's journal, the manifest, and whatever
    /// else the Mac is doing while a multi-GB copy runs.
    const HEADROOM: u64 = 256 * 1024 * 1024;
    let Some(free) = free_bytes(dir) else { return Ok(()) };
    let needed = need.saturating_add(HEADROOM);
    if free >= needed {
        return Ok(());
    }
    let mb = |n: u64| n as f64 / (1024.0 * 1024.0);
    Err(format!(
        "Not enough free disk space {what}: a full copy of this room needs about {:.0} MB \
         (with room to work) and only {:.0} MB is free. Free some space — deleting an old \
         checkpoint is the quickest way — and try again.",
        mb(needed),
        mb(free),
    ))
}

/// How many bytes a full copy of this room would take, as SQLite sees it.
/// `VACUUM INTO` writes a COMPACTED copy, so this is an upper bound.
fn room_size_bytes(conn: &Connection) -> u64 {
    let pragma = |name: &str| -> u64 {
        conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, i64>(0))
            .map(|v| v.max(0) as u64)
            .unwrap_or(0)
    };
    pragma("page_count").saturating_mul(pragma("page_size"))
}

// --------------------------------------------------------------- create core

/// Write a full SQLCipher copy of `conn` into `dir` as a new checkpoint, append
/// its manifest entry, and return the metadata. Pure over a Connection + dir (no
/// `AppState`) so it is unit-testable against a real room file. The copy is made
/// via `VACUUM INTO` into a `.tmp` path then renamed to `<uuid>.roomck`, so a
/// crash never leaves a torn payload the manifest already names.
pub(crate) fn write_checkpoint(
    conn: &Connection,
    dir: &str,
    name: &str,
    auto: bool,
) -> Result<CheckpointMeta, String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create the checkpoints folder: {e}"))?;
    // Self-heal the dir FIRST — before creating the new payload — so reconcile
    // can't mistake our fresh `.roomck` for an orphan and double-count it.
    let mut manifest = reconcile(dir);
    check_room_for(dir, room_size_bytes(conn), "to save a checkpoint")?;
    let id = Uuid::new_v4().to_string();
    let tmp = format!("{dir}/{id}.tmp");
    let final_path = checkpoint_file_path(dir, &id);
    // VACUUM INTO refuses an existing destination — a fresh uuid never clashes,
    // but clear any stale tmp defensively.
    let _ = std::fs::remove_file(&tmp);
    db::vacuum_into(conn, &tmp).inspect_err(|_| {
        // A copy that died part-way (out of space, unplugged drive) must not
        // leave a multi-GB `.tmp` behind for reconcile to sweep much later.
        let _ = std::fs::remove_file(&tmp);
    })?;
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save the checkpoint: {e}")
    })?;
    let size_bytes = std::fs::metadata(&final_path).map(|m| m.len() as i64).unwrap_or(0);
    let name = {
        let t = name.trim();
        if t.is_empty() {
            format!("Checkpoint — {}", now_date())
        } else {
            t.to_string()
        }
    };
    let meta = CheckpointMeta {
        id,
        name,
        created_at: now_timestamp(),
        size_bytes,
        auto,
    };
    manifest.entries.push(meta.clone());
    write_manifest(dir, &manifest)?;
    Ok(meta)
}

/// Create a checkpoint of the OPEN room. Holds the room lock across the
/// `VACUUM INTO` (unavoidable — the copy sources the live connection).
pub(crate) fn create_checkpoint_core(
    state: &AppState,
    name: &str,
    auto: bool,
) -> Result<CheckpointMeta, String> {
    state.with_room(|room| write_checkpoint(&room.conn, &checkpoints_dir(&room.path), name, auto))
}

/// Swap a checkpoint's `.roomck` in for the room file: delete stale WAL/SHM/
/// journal siblings of the pre-swap DB, copy the checkpoint to a swap temp
/// beside the room (same volume → atomic rename), then rename it over the room
/// path. Pure (no `AppState`) so it is unit-testable. The caller MUST have torn
/// down the open connection first — this only touches the filesystem.
pub(crate) fn perform_swap(room_path: &str, ck_path: &str) -> Result<(), String> {
    // The staged copy sits beside the room until the rename, so the volume
    // briefly holds the room AND the checkpoint twice. Say so before starting
    // rather than dying half-way through with a raw copy error.
    let ck_size = std::fs::metadata(ck_path).map(|m| m.len()).unwrap_or(0);
    check_room_for(room_path, ck_size, "to roll back")?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{room_path}{suffix}"));
    }
    let swap_tmp = format!("{room_path}.swap-{}", Uuid::new_v4());
    std::fs::copy(ck_path, &swap_tmp)
        .map_err(|e| format!("Could not stage the rollback copy: {e}"))?;
    std::fs::rename(&swap_tmp, room_path).map_err(|e| {
        let _ = std::fs::remove_file(&swap_tmp);
        format!("Could not swap in the checkpoint: {e}")
    })
}

// --------------------------------------------------------------- commands

/// Idea 9: create a named checkpoint of the open room. Async so the (possibly
/// GB-scale) `VACUUM INTO` runs on the async runtime rather than tying up
/// command dispatch; the room-lock hold during the copy is unavoidable while
/// the copy sources the live connection.
///
/// `block_in_place` because the body is *blocking* work, not async work: an
/// `async fn` that simply calls `VACUUM INTO` pins one of the runtime's few
/// worker threads for the whole multi-GB copy, and every other async command
/// (including plain `.await` points elsewhere) queues behind it. This hands the
/// thread back to the scheduler for the duration. It is not `spawn_blocking`
/// because that needs a `'static` body and `State<'_, AppState>` is borrowed —
/// moving to a task would mean adding an `AppHandle` parameter to a settled
/// command signature.
#[tauri::command]
pub async fn create_room_checkpoint(
    state: State<'_, AppState>,
    name: String,
) -> Result<CheckpointMeta, String> {
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let state = state.inner();
    tokio::task::block_in_place(|| create_checkpoint_core(state, &name, false))
}

/// Idea 9: the room's checkpoints, newest first, plus the total on-disk size.
/// `reconcile` self-heals the registry (adopts orphans, drops entries whose file
/// was hand-deleted in Finder) so the list and size are always honest.
#[tauri::command]
pub fn list_room_checkpoints(state: State<'_, AppState>) -> Result<CheckpointList, String> {
    let room_path = state.with_room(|room| Ok(room.path.clone()))?;
    let dir = checkpoints_dir(&room_path);
    if !std::path::Path::new(&dir).exists() {
        return Ok(CheckpointList { entries: Vec::new(), total_bytes: 0 });
    }
    let mut manifest = reconcile(&dir);
    manifest.entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total_bytes = manifest.entries.iter().map(|e| e.size_bytes).sum();
    Ok(CheckpointList { entries: manifest.entries, total_bytes })
}

/// Idea 9: delete a checkpoint and free its disk space. Refused while a rollback
/// is in flight (it may be reading/pruning the same dir).
#[tauri::command]
pub fn delete_room_checkpoint(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.rolling_back() {
        return Err("Can't delete a checkpoint while the room is rolling back.".into());
    }
    let room_path = state.with_room(|room| Ok(room.path.clone()))?;
    let dir = checkpoints_dir(&room_path);
    let _ = std::fs::remove_file(checkpoint_file_path(&dir, &id));
    let mut manifest = reconcile(&dir);
    manifest.entries.retain(|e| e.id != id);
    write_manifest(&dir, &manifest)
}

/// Clears `rollback_in_flight` on every exit path of the rollback command.
struct RollbackGuard(Arc<AtomicBool>);
impl Drop for RollbackGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Idea 9: roll the room back to a checkpoint. Sets the rollback-in-flight flag
/// (blocking new asks/jobs/studios/recordings and the room-lifecycle commands),
/// drains every cancellable in-flight writer and refuses if any didn't finish,
/// verifies the checkpoint's password, takes a "Before rollback" safety copy,
/// tears the room down, swaps the file, and reopens — remounting the whole
/// workspace against the restored DB.
#[tauri::command]
pub async fn rollback_room_checkpoint(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<RoomInfo, String> {
    use tauri::Emitter;

    // Snapshot (path, password) under the lock — the Room holds the password in
    // memory for exactly this kind of re-key/duplicate/rollback flow.
    let (room_path, password) =
        state.with_room(|room| Ok((room.path.clone(), room.password.clone())))?;
    let dir = checkpoints_dir(&room_path);
    let ck_path = checkpoint_file_path(&dir, &id);
    if !std::path::Path::new(&ck_path).exists() {
        return Err("That checkpoint is no longer available.".into());
    }

    // Claim the rollback: set the flag BEFORE draining + the safety copy, so new
    // async work refuses for the whole swap. The only remaining hole is a sync
    // write racing the safety-copy vacuum (documented: the safety copy is the
    // state as of drain completion). Cleared on every exit by the drop guard.
    if state.rollback_in_flight.swap(true, Ordering::SeqCst) {
        return Err(ROLLBACK_BUSY.into());
    }
    let _rollback_guard = RollbackGuard(state.rollback_in_flight.clone());

    // Refuse-if-busy: drain every cancellable writer and require the drain
    // clean. A writer that never observed its cancel flag within the bounded
    // wait means we cannot prove it won't write post-swap → refuse. (The room
    // epoch bumped by teardown is the backstop for the non-cancellable
    // path-pinned writers the drain can't see.)
    let report = drain_inflight(&app, state.inner()).await;
    if !report.asks_drained || !report.jobs_drained {
        return Err("A background job is still finishing — try again in a moment.".into());
    }
    if !state.cancels.lock().unwrap().is_empty()
        || !state.job_cancels.lock().unwrap().is_empty()
    {
        return Err("A background job is still finishing — try again in a moment.".into());
    }

    // Verify the checkpoint opens with the CURRENT password before tearing
    // anything down (catches a checkpoint that missed a change_password rekey).
    db::verify_password(&ck_path, &password)?;

    // Before-rollback safety copy of the live room, then cap auto copies at 3.
    let target_name = checkpoint_name(&dir, &id);
    let safety_name = format!("Before rollback to \"{target_name}\"");
    if let Err(e) = create_checkpoint_core(state.inner(), &safety_name, true) {
        return Err(format!("Could not take a safety copy before rolling back: {e}"));
    }
    prune_auto_checkpoints(&dir, 3);

    // Tear down every piece of per-room state (connection, Leash bridge + token
    // + leash.json, MCP servers, consents, staged media, agent-UI round-trips).
    // Reuses the security-hardened teardown; also bumps the room epoch so any
    // straggler path-pinned writer that reads the room after reopen is dropped.
    teardown_open_room(&app, state.inner());

    // Swap the checkpoint in. On failure nothing was destructively moved (the
    // copy failed before the rename, or the rename left the original in place),
    // so reopen the ORIGINAL file and surface the error.
    if let Err(e) = perform_swap(&room_path, &ck_path) {
        let _ = open_room_impl(&app, state.inner(), room_path.clone(), password.clone());
        return Err(e);
    }

    // Reopen the swapped file via the unguarded impl (our flag is still up).
    // Integration note (Second-Pass Audit — DECIDED): the checkpoint restored
    // the settings table BYTE-FOR-BYTE, so open_room_impl's
    // spawn_room_server_if_enabled re-reads the RESTORED room_server_*/leash_*
    // settings and starts (or, being disabled, leaves stopped) the Leash on the
    // checkpoint's own tier/token, rewriting ~/.arcelle/leash.json to match.
    // Combined with teardown's stop + remove_discovery above, that IS the
    // restart-or-stop-and-rewrite/remove reconciliation the audit requires — the
    // checkpoint's Leash config is authoritative.
    let info = match open_room_impl(&app, state.inner(), room_path.clone(), password.clone()) {
        Ok(info) => info,
        Err(e) => {
            return Err(format!(
                "Rolled back, but reopening the room failed: {e}. Unlock it again from the start screen."
            ))
        }
    };

    let _ = app.emit("room-rolled-back", &info);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "checkpoint-pw-123";

    fn cleanup(path: &str) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(checkpoints_dir(path));
        let _ = std::fs::remove_file(format!("{path}.recovery"));
    }

    /// A timestamp the app writes: ISO 8601, UTC, e.g. "2026-08-01T09:14:02Z".
    fn is_app_timestamp(s: &str) -> bool {
        s.len() == 20 && s.as_bytes()[10] == b'T' && s.ends_with('Z')
    }

    #[test]
    fn checkpoint_timestamps_match_every_other_timestamp_in_the_app() {
        // The manifest used to write SQLite's older "YYYY-MM-DD HH:MM:SS", with
        // no Z, so a checkpoint date shown anywhere that didn't carry its own
        // patch-up rendered in the wrong hour.
        assert_eq!(format_epoch(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_epoch(1_700_000_000), "2023-11-14T22:13:20Z");
        assert!(is_app_timestamp(&now_timestamp()));
        // The date-only helper (default checkpoint names) is unaffected.
        assert_eq!(format_epoch(1_700_000_000).chars().take(10).collect::<String>(), "2023-11-14");
        let today = now_date();
        assert_eq!(today.len(), 10, "{today}");
        assert!(!today.contains('T'), "{today}");
        // And it is the same shape the DB stamps rows with.
        let conn = Connection::open_in_memory().unwrap();
        let from_db: String = conn
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))
            .unwrap();
        assert!(is_app_timestamp(&from_db));
    }

    #[test]
    fn a_checkpoint_refuses_before_it_fills_the_disk() {
        // Nothing used to check the disk, so a checkpoint on a nearly-full
        // volume died part-way through with SQLite's "database or disk is full".
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        let free = free_bytes(&dir).expect("df reports free space on this Mac");
        assert!(free > 0);
        // A copy that fits goes ahead…
        if free > 2 * 1024 * 1024 * 1024 {
            assert!(check_room_for(&dir, 1024, "to save a checkpoint").is_ok());
        }
        // …one that cannot possibly fit is refused in words, before any bytes
        // are written…
        let err = check_room_for(&dir, free + 1, "to save a checkpoint").unwrap_err();
        assert!(err.contains("Not enough free disk space"), "{err}");
        assert!(err.contains("to save a checkpoint"), "{err}");
        // …and a path we can't measure never blocks a checkpoint that would
        // have worked.
        assert!(check_room_for("/no/such/volume", u64::MAX, "to roll back").is_ok());
        // The size we compare against is the room's own page budget.
        assert!(room_size_bytes(&db::open_in_memory_schema()) > 0);
    }

    #[test]
    fn checkpoint_swap_reopen_restores_old_content() {
        // (a) create room → add file → checkpoint → mutate → swap → reopen with
        // password → the checkpoint-era content is back.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        let file_id;
        let ck_id;
        {
            let conn = db::create_room(&path, PW, "Room").unwrap();
            file_id = db::insert_file(&conn, "note.txt", "text/plain", b"original", Some("original"), "upload")
                .unwrap()
                .id;
            ck_id = write_checkpoint(&conn, &dir, "before edit", false).unwrap().id;
            db::update_file_content(&conn, &file_id, b"changed", Some("changed")).unwrap();
            // Prove the live DB really changed before the swap.
            let (_n, _m, bytes, _t) = db::get_file_full(&conn, &file_id).unwrap();
            assert_eq!(bytes.unwrap(), b"changed");
        } // drop the connection so the file can be swapped

        let ck_path = checkpoint_file_path(&dir, &ck_id);
        perform_swap(&path, &ck_path).unwrap();

        let conn = db::open_room(&path, PW).unwrap();
        let (_n, _m, bytes, text) = db::get_file_full(&conn, &file_id).unwrap();
        assert_eq!(bytes.unwrap(), b"original");
        assert_eq!(text.as_deref(), Some("original"));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn safety_copy_reopens_with_the_same_password() {
        // (b) an auto "safety" checkpoint is itself a full, openable copy.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        let ck_id;
        {
            let conn = db::create_room(&path, PW, "Room").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"hi", Some("hi"), "upload").unwrap();
            ck_id = write_checkpoint(&conn, &dir, "Before rollback to \"x\"", true).unwrap().id;
        }
        let ck_path = checkpoint_file_path(&dir, &ck_id);
        assert!(std::path::Path::new(&ck_path).exists());
        let conn = db::open_room(&ck_path, PW).unwrap();
        assert_eq!(db::get_meta(&conn, "name").as_deref(), Some("Room"));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn reconcile_drops_missing_and_refreshes_sizes() {
        // (c) a manifest entry whose .roomck was hand-deleted self-heals away;
        // survivors' sizes are re-stat'd fresh.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        let (keep_id, gone_id);
        {
            let conn = db::create_room(&path, PW, "Room").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"content here", Some("content here"), "upload").unwrap();
            keep_id = write_checkpoint(&conn, &dir, "keep", false).unwrap().id;
            gone_id = write_checkpoint(&conn, &dir, "gone", false).unwrap().id;
        }
        assert_eq!(read_manifest(&dir).entries.len(), 2);
        // Hand-delete one payload in "Finder".
        std::fs::remove_file(checkpoint_file_path(&dir, &gone_id)).unwrap();
        let manifest = reconcile(&dir);
        assert_eq!(manifest.entries.len(), 1);
        assert_eq!(manifest.entries[0].id, keep_id);
        assert!(manifest.entries[0].size_bytes > 0);
        cleanup(&path);
    }

    #[test]
    fn manifest_write_is_temp_then_rename() {
        // (d) after a write, the manifest is valid and no .tmp remains.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = CheckpointManifest {
            v: 1,
            entries: vec![CheckpointMeta {
                id: "x".into(),
                name: "n".into(),
                created_at: now_timestamp(),
                size_bytes: 10,
                auto: false,
            }],
        };
        write_manifest(&dir, &manifest).unwrap();
        assert!(std::path::Path::new(&manifest_path(&dir)).exists());
        assert!(!std::path::Path::new(&format!("{dir}/manifest.json.tmp")).exists());
        assert_eq!(read_manifest(&dir).entries.len(), 1);
        cleanup(&path);
    }

    #[test]
    fn reconcile_adopts_orphan_payload() {
        // (d, extended) an orphan .roomck (crash between rename and manifest
        // append) is adopted so it counts toward total size and is deletable.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        let orphan_id;
        {
            let conn = db::create_room(&path, PW, "Room").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"hi", Some("hi"), "upload").unwrap();
            // Make a real copy, then rip its entry out of the manifest to
            // simulate a crash before the append.
            orphan_id = write_checkpoint(&conn, &dir, "orphaned", false).unwrap().id;
        }
        let mut m = read_manifest(&dir);
        m.entries.clear();
        write_manifest(&dir, &m).unwrap();
        let healed = reconcile(&dir);
        assert_eq!(healed.entries.len(), 1);
        assert_eq!(healed.entries[0].id, orphan_id);
        assert_eq!(healed.entries[0].name, "Recovered checkpoint");
        cleanup(&path);
    }

    #[test]
    fn checkpoint_path_with_a_quote_survives_vacuum_escaping() {
        // (e) a room path containing a single quote (which flows into the
        // checkpoints dir and the .tmp path) survives vacuum_into's escaping.
        let path = std::env::temp_dir()
            .join(format!("pr-ro'om-{}.room", Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let dir = checkpoints_dir(&path);
        let ck_id;
        {
            let conn = db::create_room(&path, PW, "Quoted").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"q", Some("q"), "upload").unwrap();
            ck_id = write_checkpoint(&conn, &dir, "cp", false).unwrap().id;
        }
        let ck_path = checkpoint_file_path(&dir, &ck_id);
        let conn = db::open_room(&ck_path, PW).unwrap();
        assert_eq!(db::get_meta(&conn, "name").as_deref(), Some("Quoted"));
        drop(conn);
        cleanup(&path);
    }
}
