//! Wave 4a: the job QUEUE. The one-job guard (three `job_cancels.is_empty()`
//! checks) becomes a serialized FIFO queue so a second heavy job (a scheduled
//! run colliding with a manual summarize) waits instead of erroring — no
//! parallelism (one resident local model makes concurrent heavy work strictly
//! slower), just no collision. The DB `status='queued'` IS the queue (FIFO by
//! created_at via `unfinished_jobs`); `AppState.running_job` is the single slot.
//!
//! `start_job_from_row` is the ONE dispatcher the queue pump, resume, and the
//! scheduler share: given a job row it rebuilds the job's plan and spawns the
//! runner. A start failure marks that row 'error' and pumps the next row, so a
//! poisoned head can never head-of-line-block the whole queue.

use super::*;

/// Cap on queued rows so a runaway scheduler can't pile up unbounded work.
pub(crate) const MAX_QUEUED: usize = 10;

/// True when the queue is at capacity — a new job should be refused.
pub(crate) fn at_capacity(conn: &Connection) -> bool {
    queued_count(conn) >= MAX_QUEUED
}

/// Reserve the running slot iff free (compare-and-swap None → Some).
pub(crate) fn try_reserve(state: &AppState, job_id: &str) -> bool {
    let mut g = state.running_job.lock().unwrap();
    if g.is_none() {
        *g = Some(job_id.to_string());
        true
    } else {
        false
    }
}

/// How many jobs are waiting in the queue right now (for the "cap" error).
pub(crate) fn queued_count(conn: &Connection) -> usize {
    db::unfinished_jobs(conn)
        .map(|jobs| jobs.iter().filter(|j| j.status == "queued").count())
        .unwrap_or(0)
}

/// Whether starting a job spawned a durable runner (whose epilogue will free the
/// slot) or finished synchronously (the slot is already freed here).
enum Started {
    Runner,
    Immediate,
}

/// Submit a freshly-created (or re-queued) job. Starts it now if the slot is
/// free, else leaves the row 'queued' for a later pump.
pub(crate) async fn submit(
    window: &tauri::Window,
    state: &AppState,
    job_id: String,
) -> Result<(), String> {
    use tauri::Manager;
    let app = window.app_handle().clone();
    if try_reserve(state, &job_id) {
        // Only a spawned RUNNER holds the slot; anything else (finished-sync or
        // a poisoned row that freed the slot) means we pump the next waiter.
        if !matches!(start_job_from_row(&app, window, &job_id).await, Ok(Started::Runner)) {
            pump(&app, window).await;
        }
    }
    Ok(())
}

/// Clear the slot (only if this job holds it) and start the next queued job.
/// Called from EVERY job's terminal epilogue.
pub(crate) async fn finish_and_pump(app: &tauri::AppHandle, window: &tauri::Window, job_id: &str) {
    use tauri::Manager;
    {
        let state = app.state::<AppState>();
        let mut g = state.running_job.lock().unwrap();
        if g.as_deref() == Some(job_id) {
            *g = None;
        }
    }
    pump(app, window).await;
}

/// Start the oldest queued job of the CURRENT room, if the slot is free. Loops
/// over poisoned rows (a start that fails is marked 'error' and skipped) so the
/// queue never head-of-line-blocks. Room-pinned: only the open room's queue runs.
pub(crate) async fn pump(app: &tauri::AppHandle, window: &tauri::Window) {
    use tauri::Manager;
    loop {
        let state = app.state::<AppState>();
        if state.running_job.lock().unwrap().is_some() {
            return; // slot busy — the running job's epilogue will pump next
        }
        let next: Option<String> = state
            .with_room(|room| {
                let jobs = db::unfinished_jobs(&room.conn)?;
                Ok(jobs.into_iter().find(|j| j.status == "queued").map(|j| j.id))
            })
            .ok()
            .flatten();
        let Some(job_id) = next else { return };
        if !try_reserve(&state, &job_id) {
            return; // someone reserved between the check and here
        }
        match start_job_from_row(app, window, &job_id).await {
            Ok(Started::Runner) => return, // a runner holds the slot; its epilogue pumps next
            Ok(Started::Immediate) => continue, // finished synchronously — try the next row
            Err(()) => continue,           // poisoned row — already 'error' + slot freed
        }
    }
}

/// Wave 4a: called from `open_room`/`create_room` to restart any work left
/// 'queued' from a previous session (open decision 2: auto-start at unlock).
pub(crate) fn pump_on_open(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(webview) = app.get_webview_window("main") else { return };
        let window = webview.as_ref().window();
        pump(&app, &window).await;
    });
}

/// The single dispatcher: rebuild a job row's plan and spawn its runner. `Runner`
/// = a durable runner is now driving (slot stays held, its epilogue frees it);
/// `Immediate` = finished synchronously (slot freed here); `Err(())` = could not
/// start (already 'error', slot freed) so the pump moves on to the next row.
async fn start_job_from_row(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    job_id: &str,
) -> Result<Started, ()> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let read = state.with_room(|room| Ok((db::get_job(&room.conn, job_id)?, room.path.clone())));
    let (job, room_path) = match read {
        Ok(v) => v,
        Err(_) => {
            free_slot(&state, job_id);
            return Err(());
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .job_cancels
        .lock()
        .unwrap()
        .insert(job_id.to_string(), cancel.clone());
    // Ok(true) = a runner was spawned; Ok(false) = the job finished synchronously.
    let started: Result<bool, String> = match job.kind.as_str() {
        "deep_summary" => start_deep_summary_row(window, &state, &job, &room_path, cancel).await,
        "file_pass" => start_file_pass_row(window, &state, &job, &room_path, cancel)
            .await
            .map(|_| true),
        "workflow" => start_workflow_row(window, &state, &job, &room_path, cancel).map(|_| true),
        "studio" => start_studio_row(window, &state, &job, &room_path, cancel).map(|_| true),
        _ => Err("This job kind can't be started.".into()),
    };
    match started {
        Ok(true) => Ok(Started::Runner),
        Ok(false) => {
            // Finished without a runner (e.g. an auto-index with nothing to do):
            // drop the flag and free the slot so the pump continues.
            state.job_cancels.lock().unwrap().remove(job_id);
            free_slot(&state, job_id);
            Ok(Started::Immediate)
        }
        Err(e) => {
            // Poisoned row: mark it 'error' (Sidebar shows Retry), drop the flag,
            // free the slot, and let the caller pump the next queued row.
            let _ = state.with_room(|room| db::set_job_status(&room.conn, job_id, "error", Some(&e)));
            state.job_cancels.lock().unwrap().remove(job_id);
            free_slot(&state, job_id);
            Err(())
        }
    }
}

/// Free the running slot iff this job holds it.
fn free_slot(state: &AppState, job_id: &str) {
    let mut g = state.running_job.lock().unwrap();
    if g.as_deref() == Some(job_id) {
        *g = None;
    }
}

/// Rebuild + spawn a deep-summary job (fresh or resumed). Mirrors the old
/// `resume_job` deep_summary arm: the plan is rebuilt from the room's CURRENT
/// files and the resume point re-derived from the one-liner cache.
/// Returns Ok(true) when a runner was spawned, Ok(false) when the job finished
/// synchronously (an auto-index with nothing left to do).
async fn start_deep_summary_row(
    window: &tauri::Window,
    state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<bool, String> {
    let auto = job.plan.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
    let reduce = if auto {
        job.plan.get("reduce").and_then(|v| v.as_bool()).unwrap_or(false)
    } else {
        true
    };
    let (files, chat_model, steps, plan_room, _) = deep_summary_plan(state, auto).await?;
    if plan_room != room_path {
        return Err("The room changed while starting this job.".into());
    }
    if auto && files.is_empty() {
        // Everything already indexed — finish cleanly with no runner. The caller
        // frees the slot and pumps the next row (never recursing here).
        state.with_room(|room| db::set_job_status(&room.conn, &job.id, "done", None))?;
        use tauri::Emitter;
        let _ = window.emit(
            "job-progress",
            serde_json::json!({
                "jobId": job.id, "label": "Indexing finished",
                "done": job.total, "total": job.total, "finished": true,
            }),
        );
        return Ok(false);
    }
    let cursor = if auto {
        0
    } else {
        files.iter().take_while(|f| has_liner(f)).count()
    };
    spawn_deep_summary(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        files,
        chat_model,
        steps,
        cursor,
        cancel,
        auto,
        reduce,
    );
    Ok(true)
}

/// Rebuild + spawn a file-pass job from its IMMUTABLE stored plan (verifying the
/// file didn't change). Mirrors the old `resume_job` file_pass arm.
async fn start_file_pass_row(
    window: &tauri::Window,
    state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let plan: PassPlan = serde_json::from_value(job.plan.clone())
        .map_err(|_| "This job's plan is unreadable.")?;
    let filtered = state.with_room(|room| {
        let text = db::get_file_extracted_text(&room.conn, &plan.file_id)
            .ok_or("The file this pass was reading is no longer in the room.")?;
        Ok(extraction::smart_filter(&text))
    })?;
    if filtered.len() != plan.text_len {
        return Err("The file changed since this pass started — start a new pass instead.".into());
    }
    if plan
        .text_sha256
        .as_deref()
        .is_some_and(|h| h != text_digest(&filtered))
    {
        return Err("The file changed since this pass started — start a new pass instead.".into());
    }
    let (chat_model, lane) = resolve_pass_engine(state).await;
    let steps = build_pass_steps(plan.windows.len(), &plan.mode, lane);
    let cursor = usize::try_from(job.cursor).unwrap_or(0).min(steps.len());
    spawn_file_pass(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        plan,
        chat_model,
        steps,
        cursor,
        cancel,
        Arc::new(filtered),
    );
    Ok(())
}

/// Rebuild + spawn a studio job from its plan. A studio run is a SINGLE atomic
/// unit — no immutable-input verification, no cursor — so this just reads the
/// plan's `kind` + inputs and re-spawns (a fresh generation each time).
fn start_studio_row(
    window: &tauri::Window,
    _state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let kind = job
        .plan
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or("This job's plan is unreadable.")?;
    let scope = job.plan.get("scope").and_then(|v| v.as_str()).map(String::from);
    let instructions = job.plan.get("instructions").and_then(|v| v.as_str()).map(String::from);
    let refs = job.plan.get("refs").and_then(|v| v.as_array()).map(|a| {
        a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<String>>()
    });
    spawn_studio(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        kind.to_string(),
        scope,
        instructions,
        refs,
        cancel,
    );
    Ok(())
}

/// Rebuild + spawn a workflow job from its IMMUTABLE plan snapshot, seeding the
/// done-set from the persisted state blob (a branched workflow needs the real
/// set, not a dense cursor).
fn start_workflow_row(
    window: &tauri::Window,
    _state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let plan: WorkflowPlan = serde_json::from_value(job.plan.clone())
        .map_err(|_| "This workflow's plan is unreadable.")?;
    let start_done: std::collections::HashSet<usize> = job
        .state
        .get("done")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect())
        .unwrap_or_default();
    spawn_workflow_job(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        plan,
        start_done,
        cancel,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_is_single_slot() {
        let state = AppState::default();
        assert!(try_reserve(&state, "a"));
        // Slot taken — a second reserve fails until it's freed.
        assert!(!try_reserve(&state, "b"));
        *state.running_job.lock().unwrap() = None;
        assert!(try_reserve(&state, "b"));
        assert_eq!(state.running_job.lock().unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn queued_count_and_cap() {
        let conn = db::mem();
        assert_eq!(queued_count(&conn), 0);
        for i in 0..3 {
            db::create_job(&conn, "workflow", &format!("w{i}"), &serde_json::json!({}), 1).unwrap();
        }
        assert_eq!(queued_count(&conn), 3);
        assert!(3 < MAX_QUEUED);
        // A running job is not counted as queued.
        let running = db::create_job(&conn, "workflow", "r", &serde_json::json!({}), 1).unwrap();
        db::set_job_status(&conn, &running, "running", None).unwrap();
        assert_eq!(queued_count(&conn), 3);
    }
}
