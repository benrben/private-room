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

/// The ONE sentence every "the queue is full" refusal uses. It is one situation
/// — deep summary, studio, file pass, download and workflow all hit the same
/// cap — so it must not read like three different problems.
pub(crate) const QUEUE_FULL: &str =
    "Too many background jobs are already waiting — let some finish first.";

/// True when the queue is at capacity — a new job should be refused. A queue
/// that cannot be READ counts as full: guessing "there's room" would let the
/// cap silently stop protecting the room the moment the DB is unhappy.
pub(crate) fn at_capacity(conn: &Connection) -> bool {
    queued_count(conn).map(|n| n >= MAX_QUEUED).unwrap_or(true)
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

/// How many jobs are waiting in the queue right now (for the "cap" error). An
/// unreadable jobs table is an Err, never a confident zero.
pub(crate) fn queued_count(conn: &Connection) -> Result<usize, String> {
    db::unfinished_jobs(conn).map(|jobs| jobs.iter().filter(|j| j.status == "queued").count())
}

/// How starting a job from its row ended.
enum Started {
    /// A durable runner is driving; it holds the slot and its epilogue pumps.
    Runner,
    /// Finished synchronously (the slot is already freed here) — pump the next.
    Immediate,
    /// Could not start; the row is marked 'error' and the slot freed, so the
    /// pump moves on to the next row.
    Poisoned,
    /// Could not start AND could not record that — re-picking this row would
    /// spin the pump at full speed forever, so the pump must stop.
    Stuck,
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
        // `Stuck` means the room couldn't even record the failure — pumping
        // would just re-pick the same row, so stop.
        match start_job_from_row(&app, window, &job_id).await {
            Started::Runner | Started::Stuck => {}
            Started::Immediate | Started::Poisoned => pump(&app, window).await,
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
        if !slot_free_for_this_room(&state) {
            return; // slot busy — the running job's epilogue will pump next
        }
        // A failed READ is not "nothing is waiting": treat it as a stop, never
        // as an empty queue, so a transient DB error can't silently retire the
        // queue for the rest of the session (the next finish_and_pump retries).
        let Ok(next) = state.with_room(|room| {
            let jobs = db::unfinished_jobs(&room.conn)?;
            Ok(jobs.into_iter().find(|j| j.status == "queued").map(|j| j.id))
        }) else {
            return;
        };
        let Some(job_id) = next else { return };
        if !try_reserve(&state, &job_id) {
            return; // someone reserved between the check and here
        }
        match start_job_from_row(app, window, &job_id).await {
            Started::Runner => return, // a runner holds the slot; its epilogue pumps next
            Started::Stuck => return,  // couldn't record the failure — don't spin on it
            Started::Immediate | Started::Poisoned => continue, // try the next row
        }
    }
}

/// True when the single heavy-work slot is available to the OPEN room. A slot
/// still held by a job of a room that has since been closed or swapped would
/// otherwise block the new room's queue for as long as the cancelled job takes
/// to notice — minutes, inside a slow model call. A job id the current room has
/// never heard of cannot be running against it, so that claim is released here.
fn slot_free_for_this_room(state: &AppState) -> bool {
    let holder = state.running_job.lock().unwrap().clone();
    let Some(holder) = holder else { return true };
    match state.with_room(|room| Ok(db::get_job(&room.conn, &holder).is_ok())) {
        // The open room owns the running job — genuinely busy.
        Ok(true) => false,
        // The open room has no such job: the slot belongs to a room that is
        // gone. Its own epilogue's `finish_and_pump` becomes a no-op, which is
        // exactly right — its writes were already room-pinned.
        Ok(false) => {
            let mut g = state.running_job.lock().unwrap();
            if g.as_deref() == Some(holder.as_str()) {
                *g = None;
            }
            true
        }
        // No room open — there is nothing to pump anyway.
        Err(_) => false,
    }
}

/// Wave 4a: called from `open_room`/`create_room` to restart any work left
/// 'queued' from a previous session (open decision 2: auto-start at unlock).
pub(crate) fn pump_on_open(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(window) = crate::main_window(&app) else { return };
        pump(&app, &window).await;
    });
}

/// The single dispatcher: rebuild a job row's plan and spawn its runner. See
/// `Started` for what each outcome obliges the caller to do.
async fn start_job_from_row(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    job_id: &str,
) -> Started {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let read = state.with_room(|room| Ok((db::get_job(&room.conn, job_id)?, room.path.clone())));
    let (job, room_path) = match read {
        Ok(v) => v,
        Err(_) => {
            // The row itself is unreadable, so it cannot be marked 'error'
            // either — re-picking it would loop, so stop the pump.
            free_slot(&state, job_id);
            return Started::Stuck;
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
        "podcast_audio" => {
            start_podcast_audio_row(window, &state, &job, &room_path, cancel).map(|_| true)
        }
        "download" => start_download_row(window, &state, &job, &room_path, cancel).map(|_| true),
        "rec_read" => start_rec_read_row(window, &state, &job, &room_path, cancel)
            .await
            .map(|_| true),
        _ => Err("This job kind can't be started.".into()),
    };
    match started {
        Ok(true) => Started::Runner,
        Ok(false) => {
            // Finished without a runner (e.g. an auto-index with nothing to do):
            // drop the flag and free the slot so the pump continues.
            state.job_cancels.lock().unwrap().remove(job_id);
            free_slot(&state, job_id);
            Started::Immediate
        }
        Err(e) => {
            // Poisoned row: mark it 'error' (Sidebar shows Retry), drop the flag,
            // free the slot, and let the caller pump the next queued row. If the
            // room refused that write the row is STILL 'queued', so continuing
            // would re-pick it immediately and spin at full processor speed —
            // report Stuck instead and leave the queue for the next pump.
            let marked = state
                .with_room(|room| db::set_job_status(&room.conn, job_id, "error", Some(&e)))
                .is_ok();
            state.job_cancels.lock().unwrap().remove(job_id);
            free_slot(&state, job_id);
            if marked {
                Started::Poisoned
            } else {
                Started::Stuck
            }
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

/// Rebuild + spawn a podcast recording from its plan.
///
/// Like a studio run, a single atomic unit with no cursor: a half-recorded
/// episode is not a resumable state, it is a file nobody wants. Resuming
/// re-records from the top, which is also what the user means by "try again".
fn start_podcast_audio_row(
    window: &tauri::Window,
    _state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let script = job
        .plan
        .get("scriptFileId")
        .and_then(|v| v.as_str())
        .ok_or("This job's plan is unreadable.")?;
    super::spawn_podcast_audio(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        script.to_string(),
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
        assert_eq!(queued_count(&conn).unwrap(), 0);
        for i in 0..3 {
            db::create_job(&conn, "workflow", &format!("w{i}"), &serde_json::json!({}), 1).unwrap();
        }
        assert_eq!(queued_count(&conn).unwrap(), 3);
        assert!(3 < MAX_QUEUED);
        assert!(!at_capacity(&conn));
        // A running job is not counted as queued.
        let running = db::create_job(&conn, "workflow", "r", &serde_json::json!({}), 1).unwrap();
        db::set_job_status(&conn, &running, "running", None).unwrap();
        assert_eq!(queued_count(&conn).unwrap(), 3);
    }

    #[test]
    fn an_unreadable_queue_counts_as_full_rather_than_empty() {
        // The cap is a protection: if the jobs table can't be read we must NOT
        // guess "there's room" — that is exactly when a runaway scheduler would
        // pile work up unchecked.
        let conn = Connection::open_in_memory().unwrap(); // no `jobs` table
        assert!(queued_count(&conn).is_err());
        assert!(at_capacity(&conn), "an unreadable queue must refuse new work");
    }

    #[test]
    fn the_slot_is_released_when_its_holder_belongs_to_another_room() {
        // Switching rooms leaves `running_job` claimed by the old room's job
        // until that job notices the cancel — which can be minutes inside a
        // model call. The new room's queue must not wait on it.
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn: db::mem(),
            path: "mem://new-room".into(),
            name: "new".into(),
            password: "pw".into(),
        });
        // A job of the room that IS open holds the slot → genuinely busy.
        let mine = state
            .with_room(|room| db::create_job(&room.conn, "workflow", "w", &serde_json::json!({}), 1))
            .unwrap();
        assert!(try_reserve(&state, &mine));
        assert!(!slot_free_for_this_room(&state));
        assert_eq!(state.running_job.lock().unwrap().as_deref(), Some(mine.as_str()));

        // A job id this room has never heard of cannot be running against it.
        *state.running_job.lock().unwrap() = Some("job-from-the-previous-room".into());
        assert!(slot_free_for_this_room(&state));
        assert!(state.running_job.lock().unwrap().is_none(), "the stale claim is dropped");

        // With no room open there is nothing to pump, so the slot stays as-is.
        *state.running_job.lock().unwrap() = Some("whatever".into());
        *state.room.lock().unwrap() = None;
        assert!(!slot_free_for_this_room(&state));
        assert_eq!(state.running_job.lock().unwrap().as_deref(), Some("whatever"));
    }
}
