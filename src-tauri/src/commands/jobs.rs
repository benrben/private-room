//! ADD-30: the job runner. A heavy operation (deep summary, media digest) is a
//! `Plan` — a DAG of `Step`s tagged with a `Lane`. The scheduler dispatches
//! every step whose dependencies are met and whose lane has a free slot, runs
//! them, checkpoints to the `jobs` table, and emits `job-progress`. Parallelism
//! is per-lane: local models are serial (one resident model), CPU and cloud
//! work run several at once.
//!
//! This module is the *foundation*. `plan_dispatch` (the scheduling decision)
//! is pure and unit-tested; `run_plan` drives it; `execute_step` maps a step to
//! real work. The first job kind wired on top is a room deep-summary.

use super::*;
use std::collections::HashSet;

// ADD-32: the whole-file pass job kind (exhaustive windowed map/fold/reduce).
mod file_pass;
pub use file_pass::*;

/// Where a step runs — decides how many may run at once. Local-model work is
/// serial because only one model is resident; CPU and cloud work fan out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    LocalLlm,
    Whisper,
    Cpu,
    Cloud,
}

impl Lane {
    /// Concurrent slots per lane. Local model and Whisper are serial (RAM and a
    /// single resident model); CPU threads and remote cloud calls overlap.
    pub fn slots(self) -> usize {
        match self {
            Lane::LocalLlm => 1,
            Lane::Whisper => 1,
            Lane::Cpu => 4,
            Lane::Cloud => 4,
        }
    }
}

/// One node in a job's plan. `kind`/`params` describe the work; `depends_on`
/// lists step ids (indices) that must finish first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: usize,
    pub lane: Lane,
    pub kind: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub depends_on: Vec<usize>,
}

/// Pure scheduling decision: given the full step list, the ids already done,
/// and the ids currently running, return the steps that may start NOW —
/// dependencies satisfied and their lane still has a free slot (counting steps
/// already running plus ones chosen earlier in this same call). Deterministic:
/// lower ids win a contested slot, so runs are reproducible.
pub fn plan_dispatch(steps: &[Step], done: &HashSet<usize>, running: &HashSet<usize>) -> Vec<usize> {
    // Slots left per lane after accounting for what's already running.
    let mut free: std::collections::HashMap<Lane, usize> = std::collections::HashMap::new();
    for lane in [Lane::LocalLlm, Lane::Whisper, Lane::Cpu, Lane::Cloud] {
        free.insert(lane, lane.slots());
    }
    for s in steps.iter().filter(|s| running.contains(&s.id)) {
        if let Some(n) = free.get_mut(&s.lane) {
            *n = n.saturating_sub(1);
        }
    }
    let mut chosen = Vec::new();
    for s in steps {
        if done.contains(&s.id) || running.contains(&s.id) {
            continue;
        }
        if !s.depends_on.iter().all(|d| done.contains(d)) {
            continue;
        }
        let slot = free.get_mut(&s.lane).unwrap();
        if *slot == 0 {
            continue;
        }
        *slot -= 1;
        chosen.push(s.id);
    }
    chosen
}

/// True once every step is done — the plan is complete.
fn plan_complete(steps: &[Step], done: &HashSet<usize>) -> bool {
    steps.iter().all(|s| done.contains(&s.id))
}

/// Detect a plan that can never finish (a dependency cycle or a dangling
/// dependency) — nothing is running yet nothing is dispatchable. Guards the
/// scheduler against an infinite idle loop.
fn plan_is_stuck(steps: &[Step], done: &HashSet<usize>, running: &HashSet<usize>) -> bool {
    running.is_empty()
        && !plan_complete(steps, done)
        && plan_dispatch(steps, done, running).is_empty()
}

/// How a plan run ended.
#[derive(Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Done,
    /// Cancel flag was set — the job is checkpointed and resumable.
    Paused,
    /// A step failed (its error) — the job is parked resumable.
    Error(String),
}

/// Drive a plan to completion. Plans are built in dependency order (a step's
/// deps always have lower ids), so `start_done` is seeded as `0..cursor` on
/// resume. Each wave dispatches every ready step its lanes allow, runs them
/// concurrently, then `checkpoint(done_count)` persists progress and
/// `progress(done, total)` updates the UI. A set `cancel` flag pauses between
/// waves; a step error parks the job. Generic over `execute` so it is unit-
/// tested without the app.
pub async fn run_plan<F, Fut, C>(
    steps: &[Step],
    start_cursor: usize,
    cancel: Arc<AtomicBool>,
    mut execute: F,
    mut checkpoint: C,
    mut progress: impl FnMut(usize, usize),
) -> RunOutcome
where
    F: FnMut(Step) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
    C: FnMut(usize),
{
    use futures_util::future::join_all;
    let total = steps.len();
    let mut done: HashSet<usize> = (0..start_cursor).collect();
    progress(done.len(), total);

    while !plan_complete(steps, &done) {
        if cancel.load(Ordering::SeqCst) {
            return RunOutcome::Paused;
        }
        let empty = HashSet::new();
        if plan_is_stuck(steps, &done, &empty) {
            return RunOutcome::Error("job plan cannot make progress".into());
        }
        let wave = plan_dispatch(steps, &done, &empty);
        // Run the wave concurrently; each future is one step's work.
        let futs = wave
            .iter()
            .map(|&id| execute(steps[id].clone()))
            .collect::<Vec<_>>();
        let results = join_all(futs).await;
        for (&id, res) in wave.iter().zip(results) {
            if let Err(e) = res {
                return RunOutcome::Error(e);
            }
            done.insert(id);
        }
        // Cursor advances to the count of finished steps (topo order makes this
        // a valid resume point).
        checkpoint(done.len());
        progress(done.len(), total);
    }
    RunOutcome::Done
}

// ------------------------------------------------------------------ commands

/// Emit the job's live progress to the UI. `label` is human ("Reading part 4 of
/// 17"); `done`/`total` drive the bar.
fn emit_progress(window: &tauri::Window, job_id: &str, label: &str, done: usize, total: usize) {
    use tauri::Emitter;
    let _ = window.emit(
        "job-progress",
        serde_json::json!({ "jobId": job_id, "label": label, "done": done, "total": total }),
    );
}

/// List every job in the open room, newest first — feeds the jobs panel.
#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Result<Vec<db::Job>, String> {
    state.with_room(|room| db::list_jobs(&room.conn))
}

/// Cancel (pause) a running job. The running loop sees the flag between waves,
/// checkpoints, and parks the job as 'paused' — Resume continues from there.
#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.job_cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_job(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Stop it first if it happens to be running.
    if let Some(flag) = state.job_cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    state.with_room(|room| db::delete_job(&room.conn, &id))
}

/// On room open, any job left 'running' belongs to a process that's gone — mark
/// those 'paused' so the UI offers Resume instead of showing a phantom active
/// job. Called from the room-open path.
pub(crate) fn quiesce_stale_jobs(conn: &Connection) {
    if let Ok(jobs) = db::unfinished_jobs(conn) {
        // Any job still 'running' OR 'queued' belongs to a process that's gone
        // (in-memory cancel flags don't survive a restart) — park both as
        // 'paused' so the UI offers Resume instead of a phantom-active card that
        // would leave the Summarize button disabled forever.
        for j in jobs.iter().filter(|j| j.status == "running" || j.status == "queued") {
            let _ = db::set_job_status(conn, &j.id, "paused", None);
        }
    }
}

/// Build the deep-summary plan for the room's CURRENT files: one step per file,
/// on the lane the selected engine implies. Shared by start and resume. Also
/// returns the path of the room the files were read from, so callers can
/// verify the room didn't swap across this function's await.
async fn deep_summary_plan(
    state: &AppState,
) -> Result<(Vec<db::SummaryFile>, String, Vec<Step>, String), String> {
    let (files, model, room_path) = state.with_room(|room| {
        let all = db::list_files_for_summary(&room.conn)?;
        let files: Vec<db::SummaryFile> = all
            .into_iter()
            .filter(|f| !is_summary_file(&f.name, &f.source))
            .take(MAX_SUMMARY_FILES)
            .collect();
        Ok((files, model_setting(&room.conn), room.path.clone()))
    })?;
    if files.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }
    let models = ollama::list_models().await.unwrap_or_default();
    let mut chat_model = model.unwrap_or_else(|| best_default(&models));
    // External CLIs don't speak the Ollama API the summarizer drives — swap in
    // the default model. A `:cloud` model does (ADD-29 parity) and fans out.
    if is_external_engine(&chat_model) {
        chat_model = best_default(&models);
    }
    let lane = if is_cloud_model(&chat_model) {
        Lane::Cloud
    } else {
        Lane::LocalLlm
    };
    let steps: Vec<Step> = files
        .iter()
        .enumerate()
        .map(|(i, _)| Step {
            id: i,
            lane,
            kind: "summarize_file".into(),
            params: serde_json::Value::Null,
            depends_on: vec![],
        })
        .collect();
    Ok((files, chat_model, steps, room_path))
}

/// Spawn the checkpointed runner for a deep-summary job (fresh or resumed).
/// On completion it runs the reduce and writes "Room summary.html" — the job is
/// only 'done' once the summary file exists. The heavy per-file text and model
/// calls happen off the room lock; only the short one-liner reads/writes take it.
/// `room_path` pins the job to the room it was started in: every read/write
/// re-checks the CURRENT room against it, so a room closed or swapped mid-run
/// can never receive this job's writes.
#[allow(clippy::too_many_arguments)]
fn spawn_deep_summary(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    files: Vec<db::SummaryFile>,
    chat_model: String,
    steps: Vec<Step>,
    start_cursor: usize,
    cancel: Arc<AtomicBool>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }

        let total = steps.len();
        // Surface the card immediately, even before the first file resolves (and
        // even when the job was started outside the UI).
        emit_progress(&window, &job_id, "Starting…", start_cursor, total);
        // Last checkpointed cursor, so pause/error events report real progress.
        let last_cursor = Arc::new(std::sync::atomic::AtomicUsize::new(start_cursor));
        let lc = last_cursor.clone();
        let outcome = run_plan(
            &steps,
            start_cursor,
            cancel.clone(),
            |s| {
                let state = app.state::<AppState>();
                let f = files[s.id].clone();
                let model = chat_model.clone();
                let room_path = room_path.clone();
                async move {
                    // Skip files that already have a cached one-liner.
                    if f.ai_summary.is_some() {
                        return Ok(());
                    }
                    let full = {
                        let guard = state.room.lock().unwrap();
                        guard
                            .as_ref()
                            .filter(|r| r.path == room_path)
                            .and_then(|r| db::get_file_extracted_text(&r.conn, &f.id))
                    };
                    let Some(full) = full.filter(|t| !t.trim().is_empty()) else {
                        return Ok(()); // no text (e.g. image w/o OCR) — nothing to do
                    };
                    match summarize_one_file(&model, &f.name, &f.mime, &full, KEEP_ALIVE_WARM).await {
                        Ok(liner) if !liner.is_empty() => {
                            let guard = state.room.lock().unwrap();
                            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                                let _ = db::set_file_ai_summary(&r.conn, &f.id, &liner);
                            }
                            Ok(())
                        }
                        Ok(_) => Ok(()),
                        // A hard error (server down / model gone) parks the job;
                        // a one-off failure just leaves this file uncached.
                        Err(e) if e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING") => Err(e),
                        Err(_) => Ok(()),
                    }
                }
            },
            |cursor| {
                lc.store(cursor, Ordering::SeqCst);
                let state = app.state::<AppState>();
                let guard = state.room.lock().unwrap();
                if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                    let _ = db::checkpoint_job(&r.conn, &job_id, cursor as i64, &serde_json::json!({}));
                }
            },
            |done, total| {
                emit_progress(
                    &window,
                    &job_id,
                    &format!("Summarizing file {done} of {total}…"),
                    done,
                    total,
                );
            },
        )
        .await;

        // Done means every one-liner is cached — now the reduce writes the
        // actual summary file. A failure here parks the job as an error so
        // Resume retries the (cheap, cache-fed) write. The pin is checked up
        // front (fast fail) AND passed into write_room_summary, whose every
        // room access re-checks it — a room closed or swapped mid-reduce can
        // never receive this job's writes.
        let mut summary_file: Option<FileMeta> = None;
        let outcome = if matches!(outcome, RunOutcome::Done) {
            // A Stop pressed during the final wave is only observable AFTER
            // run_plan returns Done — honor it here so the reduce never runs
            // cancelled. Resume re-derives the cursor and retries the reduce.
            if cancel.load(Ordering::SeqCst) {
                RunOutcome::Paused
            } else {
                let pinned = {
                    let guard = state.room.lock().unwrap();
                    guard.as_ref().is_some_and(|r| r.path == room_path)
                };
                if pinned {
                    emit_progress(&window, &job_id, "Writing the summary…", total, total);
                    match write_room_summary(&window, state.inner(), &chat_model, Some(&room_path))
                        .await
                    {
                        Ok(meta) => {
                            summary_file = Some(meta);
                            outcome
                        }
                        Err(e) => RunOutcome::Error(e),
                    }
                } else {
                    RunOutcome::Error("the room this job belongs to was closed".into())
                }
            }
        } else {
            outcome
        };

        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    RunOutcome::Done => ("done", None),
                    RunOutcome::Paused => ("paused", None),
                    RunOutcome::Error(e) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);

        // Terminal event: the jobs panel re-reads the job list on any of these.
        use tauri::Emitter;
        let done_now = last_cursor.load(Ordering::SeqCst);
        let payload = match &outcome {
            RunOutcome::Done => serde_json::json!({
                "jobId": job_id, "label": "Summary ready", "done": total, "total": total,
                "finished": true, "fileId": summary_file.map(|m| m.id),
            }),
            RunOutcome::Paused => serde_json::json!({
                "jobId": job_id, "label": "Paused", "done": done_now, "total": total,
                "paused": true,
            }),
            RunOutcome::Error(e) => serde_json::json!({
                "jobId": job_id, "label": format!("Stopped — {e}"), "done": done_now,
                "total": total, "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
    });
}

/// Start a room deep-summary as a durable background job. Each file is one
/// checkpointed step; the reduce + HTML write run once every step is done.
/// Returns the job id immediately; progress arrives via `job-progress` and the
/// finished summary via `room-files-changed`.
#[tauri::command]
pub async fn start_deep_summary(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // One heavy background job at a time — the local lane is serial anyway, and
    // two concurrent summaries would just fight over the same cache.
    if !state.job_cancels.lock().unwrap().is_empty() {
        return Err("A background job is already running.".into());
    }
    let (files, chat_model, steps, plan_room) = deep_summary_plan(state.inner()).await?;
    let plan = serde_json::json!({ "steps": steps });
    let total = steps.len() as i64;

    let (job_id, room_path) = state.with_room(|room| {
        // The plan was read before an await (the Ollama model probe) — a room
        // swapped in that window must not receive a job built from the old
        // room's files.
        if room.path != plan_room {
            return Err("The room changed while starting this job.".into());
        }
        let id = db::create_job(&room.conn, "deep_summary", "Room summary", &plan, total)?;
        Ok((id, room.path.clone()))
    })?;

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .job_cancels
        .lock()
        .unwrap()
        .insert(job_id.clone(), cancel.clone());
    spawn_deep_summary(window, job_id.clone(), room_path, files, chat_model, steps, 0, cancel);
    Ok(job_id)
}

/// Resume a paused (or errored) job from its checkpoint. For a deep summary
/// the plan is rebuilt from the room's CURRENT files and the resume point is
/// re-derived from the one-liner cache — the stored cursor is positional and
/// the file list may have changed, so trusting it could silently skip
/// unsummarized files. Files summarized earlier hit the cache and cost
/// nothing, so a changed file list degrades gracefully.
#[tauri::command]
pub async fn resume_job(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let (job, room_path) = state.with_room(|room| {
        Ok((db::get_job(&room.conn, &id)?, room.path.clone()))
    })?;
    // One heavy background job at a time — mirrors the start paths' guard
    // (any live job blocks a resume, including this same job resumed twice),
    // so the per-job LocalLlm lane serialization is never defeated.
    if !state.job_cancels.lock().unwrap().is_empty() {
        return Err("A background job is already running.".into());
    }
    match job.kind.as_str() {
        "deep_summary" => {
            let (files, chat_model, steps, plan_room) = deep_summary_plan(state.inner()).await?;
            // The plan was read after an await — a room swapped since the job
            // row was read must not run a plan built from the other room.
            if plan_room != room_path {
                return Err("The room changed while resuming this job.".into());
            }
            // Skip the already-summarized prefix; every uncached file (newly
            // added, moved, or transiently failed) sits at or after this stop
            // point and gets dispatched again — cached ones beyond it are
            // skipped for free by the in-step cache check.
            let cursor = files.iter().take_while(|f| f.ai_summary.is_some()).count();
            let cancel = Arc::new(AtomicBool::new(false));
            state
                .job_cancels
                .lock()
                .unwrap()
                .insert(id.clone(), cancel.clone());
            spawn_deep_summary(window, id, room_path, files, chat_model, steps, cursor, cancel);
            Ok(())
        }
        // ADD-32: a whole-file pass resumes from its IMMUTABLE stored plan —
        // the windows must be byte-identical to the ones the artifacts were
        // made from, so they are never re-derived, only verified.
        "file_pass" => {
            let plan: PassPlan = serde_json::from_value(job.plan.clone())
                .map_err(|_| "This job's plan is unreadable.")?;
            let filtered = state.with_room(|room| {
                let text = db::get_file_extracted_text(&room.conn, &plan.file_id)
                    .ok_or("The file this pass was reading is no longer in the room.")?;
                Ok(extraction::smart_filter(&text))
            })?;
            if filtered.len() != plan.text_len {
                return Err(
                    "The file changed since this pass started — start a new pass instead."
                        .into(),
                );
            }
            // Equal length is not equal content — the digest catches a
            // same-length replacement the cheap check above misses. Plans
            // persisted before the digest existed (None) keep the length
            // check as their only guard.
            if plan
                .text_sha256
                .as_deref()
                .is_some_and(|h| h != text_digest(&filtered))
            {
                return Err(
                    "The file changed since this pass started — start a new pass instead."
                        .into(),
                );
            }
            let (chat_model, lane) = resolve_pass_engine(state.inner()).await;
            let steps = build_pass_steps(plan.windows.len(), &plan.mode, lane);
            let cursor = usize::try_from(job.cursor).unwrap_or(0).min(steps.len());
            let cancel = Arc::new(AtomicBool::new(false));
            state
                .job_cancels
                .lock()
                .unwrap()
                .insert(id.clone(), cancel.clone());
            spawn_file_pass(
                window,
                id,
                room_path,
                plan,
                chat_model,
                steps,
                cursor,
                cancel,
                Arc::new(filtered),
            );
            Ok(())
        }
        _ => Err("This job can't be resumed.".into()),
    }
}

// ------------------------------------------------------------ file pass (ADD-32)

/// The engine a pass runs on: the room's chosen model (external CLIs can't be
/// driven by the job runner → default), and the lane its concurrency implies.
async fn resolve_pass_engine(state: &AppState) -> (String, Lane) {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|r| model_setting(&r.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let mut chat_model = explicit.unwrap_or_else(|| best_default(&models));
    if is_external_engine(&chat_model) {
        chat_model = best_default(&models);
    }
    let lane = if is_cloud_model(&chat_model) {
        Lane::Cloud
    } else {
        Lane::LocalLlm
    };
    (chat_model, lane)
}

/// SHA-256 (hex) of the smart-filtered pass text. Stored in the immutable
/// plan so a resume can detect a same-length content swap, which the cheap
/// `text_len` comparison alone cannot.
fn text_digest(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Start a whole-file pass: resolve the file, partition its filtered text into
/// windows, persist the immutable plan, and spawn the checkpointed runner.
/// Shared by the `start_file_pass` command and the agent's tool. Returns
/// (job_id, real file name, window count).
pub(crate) async fn begin_file_pass(
    window: &tauri::Window,
    state: &AppState,
    file: &str,
    instruction: &str,
    mode: &str,
) -> Result<(String, String, usize), String> {
    if !state.job_cancels.lock().unwrap().is_empty() {
        return Err(
            "A background job is already running — stop it or let it finish first.".into(),
        );
    }
    let mode = if mode == "stitch" { "stitch" } else { "merge" };
    let instruction = {
        let t = instruction.trim();
        if t.is_empty() {
            "Summarize this file completely and thoroughly.".to_string()
        } else {
            t.to_string()
        }
    };
    // The pinning room_path is captured HERE, together with the text read —
    // the engine probe below awaits an HTTP call, and a room swapped in that
    // window must not get a job pinned to it but built from this room's text.
    let (file_id, real_name, filtered, room_path) = state.with_room(|room| {
        // A whole-file pass must resolve the SOURCE file, never the app's own
        // generated "Full pass — …"/"Room summary" output — those are newer and
        // name-match, so a plain find_file_like would make a re-run summarize
        // the previous run's tiny output instead of the book.
        let (id, real_name) = db::find_source_file_like(&room.conn, file)?;
        let text = db::get_file_extracted_text(&room.conn, &id).ok_or_else(|| {
            format!("\"{real_name}\" has no readable text — a pass needs extracted text.")
        })?;
        Ok((id, real_name, extraction::smart_filter(&text), room.path.clone()))
    })?;
    let windows = extraction::partition_windows(
        &filtered,
        file_pass::PASS_WINDOW_CHARS,
        file_pass::PASS_WINDOW_OVERLAP,
    );
    if windows.is_empty() {
        return Err(format!("\"{real_name}\" has no readable text after filtering."));
    }
    let (chat_model, lane) = resolve_pass_engine(state).await;
    let steps = build_pass_steps(windows.len(), mode, lane);
    let n_windows = windows.len();
    let plan = PassPlan {
        file_id,
        file_name: real_name.clone(),
        instruction,
        mode: mode.into(),
        text_len: filtered.len(),
        text_sha256: Some(text_digest(&filtered)),
        windows,
    };
    let plan_json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let title = format!("Full pass — {real_name}");
    let job_id = state.with_room(|room| {
        if room.path != room_path {
            return Err("The room changed while starting this pass.".into());
        }
        db::create_job(&room.conn, "file_pass", &title, &plan_json, steps.len() as i64)
    })?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .job_cancels
        .lock()
        .unwrap()
        .insert(job_id.clone(), cancel.clone());
    spawn_file_pass(
        window.clone(),
        job_id.clone(),
        room_path,
        plan,
        chat_model,
        steps,
        0,
        cancel,
        Arc::new(filtered),
    );
    Ok((job_id, real_name, n_windows))
}

/// Start a whole-file pass as a durable background job (Tauri command).
/// `mode` is "merge" (default — notes folded into a final document) or
/// "stitch" (each window transformed; outputs joined in order).
#[tauri::command]
pub async fn start_file_pass(
    window: tauri::Window,
    state: State<'_, AppState>,
    file: String,
    instruction: String,
    mode: Option<String>,
) -> Result<String, String> {
    let (job_id, _, _) = begin_file_pass(
        &window,
        state.inner(),
        &file,
        &instruction,
        mode.as_deref().unwrap_or("merge"),
    )
    .await?;
    Ok(job_id)
}

/// Spawn the checkpointed runner for a whole-file pass (fresh or resumed).
/// Mirrors `spawn_deep_summary`: status flips to running, every finished step
/// checkpoints the cursor, progress is emitted with the exact window being
/// read, and the terminal event carries the published file's id. `room_path`
/// pins the pass to the room it was started in (see `execute_pass_step`).
#[allow(clippy::too_many_arguments)]
fn spawn_file_pass(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    plan: PassPlan,
    chat_model: String,
    steps: Vec<Step>,
    start_cursor: usize,
    cancel: Arc<AtomicBool>,
    filtered: Arc<String>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }
        let total = steps.len();
        // Surface the card the instant the pass starts — a fresh cold model can
        // take tens of seconds on the first window, and a pass the AGENT started
        // has no UI action to seed the sidebar (the frontend pulls the job in on
        // this first tick).
        emit_progress(&window, &job_id, "Starting the pass…", start_cursor, total);
        let published: Arc<std::sync::Mutex<Option<FileMeta>>> =
            Arc::new(std::sync::Mutex::new(None));
        let last_cursor = Arc::new(std::sync::atomic::AtomicUsize::new(start_cursor));
        let lc = last_cursor.clone();
        let label_plan = plan.clone();
        let label_steps = steps.clone();
        let exec_app = app.clone();
        let exec_job = job_id.clone();
        let exec_room_path = room_path.clone();
        let exec_plan = plan.clone();
        let exec_cancel = cancel.clone();
        let exec_published = published.clone();
        let outcome = run_plan(
            &steps,
            start_cursor,
            cancel.clone(),
            |s| {
                let app = exec_app.clone();
                let job_id = exec_job.clone();
                let room_path = exec_room_path.clone();
                let plan = exec_plan.clone();
                let model = chat_model.clone();
                let cancel = exec_cancel.clone();
                let filtered = filtered.clone();
                let published = exec_published.clone();
                async move {
                    execute_pass_step(
                        &app, &job_id, &room_path, &plan, &model, &filtered, &s, &cancel,
                        &published,
                    )
                    .await
                }
            },
            |cursor| {
                lc.store(cursor, Ordering::SeqCst);
                let state = app.state::<AppState>();
                let guard = state.room.lock().unwrap();
                if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                    let _ =
                        db::checkpoint_job(&r.conn, &job_id, cursor as i64, &serde_json::json!({}));
                }
            },
            |done, total| {
                emit_progress(
                    &window,
                    &job_id,
                    &pass_progress_label(&label_plan, &label_steps, done),
                    done,
                    total,
                );
            },
        )
        .await;

        // A Stop pressed mid-model-call surfaces as the call's error, not a
        // clean pause — normalize it so the card says Paused, not Stopped.
        let outcome = match outcome {
            RunOutcome::Error(_) if cancel.load(Ordering::SeqCst) => RunOutcome::Paused,
            o => o,
        };

        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    RunOutcome::Done => ("done", None),
                    RunOutcome::Paused => ("paused", None),
                    RunOutcome::Error(e) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);

        use tauri::Emitter;
        let done_now = last_cursor.load(Ordering::SeqCst);
        let payload = match &outcome {
            RunOutcome::Done => {
                let meta = published.lock().unwrap().take();
                serde_json::json!({
                    "jobId": job_id,
                    "label": format!("Full pass of “{}” is ready", plan.file_name),
                    "done": total, "total": total, "finished": true,
                    "fileId": meta.map(|m| m.id),
                })
            }
            RunOutcome::Paused => serde_json::json!({
                "jobId": job_id, "label": "Paused", "done": done_now, "total": total,
                "paused": true,
            }),
            RunOutcome::Error(e) => serde_json::json!({
                "jobId": job_id, "label": format!("Stopped — {e}"), "done": done_now,
                "total": total, "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn step(id: usize, lane: Lane, deps: &[usize]) -> Step {
        Step {
            id,
            lane,
            kind: "noop".into(),
            params: serde_json::Value::Null,
            depends_on: deps.to_vec(),
        }
    }

    #[test]
    fn local_lane_is_serial() {
        // Three independent local-model steps: only ONE may start at a time.
        let steps = vec![
            step(0, Lane::LocalLlm, &[]),
            step(1, Lane::LocalLlm, &[]),
            step(2, Lane::LocalLlm, &[]),
        ];
        let d = plan_dispatch(&steps, &HashSet::new(), &HashSet::new());
        assert_eq!(d, vec![0]); // lowest id wins the single slot
        // With step 0 running, nothing else can start on the local lane.
        let running: HashSet<usize> = [0].into_iter().collect();
        assert!(plan_dispatch(&steps, &HashSet::new(), &running).is_empty());
    }

    #[test]
    fn cloud_lane_fans_out_to_its_slot_count() {
        // Five independent cloud steps, 4 slots → 4 dispatched at once.
        let steps: Vec<Step> = (0..5).map(|i| step(i, Lane::Cloud, &[])).collect();
        let d = plan_dispatch(&steps, &HashSet::new(), &HashSet::new());
        assert_eq!(d, vec![0, 1, 2, 3]);
    }

    #[test]
    fn different_lanes_run_in_parallel() {
        // A CPU decode, a Whisper transcribe, and a local digest are all ready
        // and on different lanes → all three start together.
        let steps = vec![
            step(0, Lane::Cpu, &[]),
            step(1, Lane::Whisper, &[]),
            step(2, Lane::LocalLlm, &[]),
        ];
        let d = plan_dispatch(&steps, &HashSet::new(), &HashSet::new());
        assert_eq!(d, vec![0, 1, 2]);
    }

    #[test]
    fn dependencies_gate_dispatch() {
        // reduce(2) waits for digests 0 and 1.
        let steps = vec![
            step(0, Lane::Cloud, &[]),
            step(1, Lane::Cloud, &[]),
            step(2, Lane::LocalLlm, &[0, 1]),
        ];
        // Only 0 and 1 are ready initially.
        assert_eq!(
            plan_dispatch(&steps, &HashSet::new(), &HashSet::new()),
            vec![0, 1]
        );
        // With 0 done but 1 still running, reduce still can't start.
        let done: HashSet<usize> = [0].into_iter().collect();
        let running: HashSet<usize> = [1].into_iter().collect();
        assert!(plan_dispatch(&steps, &done, &running).is_empty());
        // Both deps done → reduce is dispatchable.
        let done: HashSet<usize> = [0, 1].into_iter().collect();
        assert_eq!(plan_dispatch(&steps, &done, &HashSet::new()), vec![2]);
    }

    #[test]
    fn completion_and_stuck_detection() {
        let steps = vec![step(0, Lane::Cpu, &[]), step(1, Lane::Cpu, &[0])];
        assert!(!plan_complete(&steps, &HashSet::new()));
        let all: HashSet<usize> = [0, 1].into_iter().collect();
        assert!(plan_complete(&steps, &all));
        // A dangling dependency (step 1 needs a nonexistent step 9) is stuck.
        let broken = vec![step(0, Lane::Cpu, &[]), step(1, Lane::Cpu, &[9])];
        let done: HashSet<usize> = [0].into_iter().collect();
        assert!(plan_is_stuck(&broken, &done, &HashSet::new()));
        // A healthy plan mid-run is NOT stuck.
        assert!(!plan_is_stuck(&steps, &HashSet::new(), &[0].into_iter().collect()));
    }

    #[tokio::test]
    async fn run_plan_runs_deps_before_dependents_and_checkpoints() {
        // digest 0,1,2 (cloud) → reduce 3 (local). Record execution order.
        let steps = vec![
            step(0, Lane::Cloud, &[]),
            step(1, Lane::Cloud, &[]),
            step(2, Lane::Cloud, &[]),
            step(3, Lane::LocalLlm, &[0, 1, 2]),
        ];
        let order = Arc::new(std::sync::Mutex::new(Vec::<usize>::new()));
        let checkpoints = Arc::new(std::sync::Mutex::new(Vec::<usize>::new()));
        let o2 = order.clone();
        let c2 = checkpoints.clone();
        let outcome = run_plan(
            &steps,
            0,
            Arc::new(AtomicBool::new(false)),
            move |s| {
                let o = o2.clone();
                async move {
                    o.lock().unwrap().push(s.id);
                    Ok(())
                }
            },
            move |cursor| c2.lock().unwrap().push(cursor),
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Done);
        let order = order.lock().unwrap().clone();
        // reduce (3) must run only after all digests.
        assert_eq!(*order.last().unwrap(), 3);
        assert!(order[..3].contains(&0) && order[..3].contains(&1) && order[..3].contains(&2));
        // Checkpoints are monotonic and end at the full count.
        let cps = checkpoints.lock().unwrap().clone();
        assert_eq!(*cps.last().unwrap(), 4);
    }

    #[tokio::test]
    async fn run_plan_pauses_on_cancel_and_is_resumable() {
        let steps: Vec<Step> = (0..4).map(|i| step(i, Lane::LocalLlm, &[])).collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let ran = Arc::new(std::sync::Mutex::new(0usize));
        let last_cursor = Arc::new(AtomicUsize::new(0));
        let cancel2 = cancel.clone();
        let ran2 = ran.clone();
        let lc2 = last_cursor.clone();
        let outcome = run_plan(
            &steps,
            0,
            cancel.clone(),
            move |_s| {
                let ran = ran2.clone();
                let cancel = cancel2.clone();
                async move {
                    let mut n = ran.lock().unwrap();
                    *n += 1;
                    // Trip cancel after the second step completes.
                    if *n == 2 {
                        cancel.store(true, Ordering::SeqCst);
                    }
                    Ok(())
                }
            },
            move |cursor| lc2.store(cursor, Ordering::SeqCst),
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Paused);
        // Serial lane ran exactly two before pausing; cursor checkpointed at 2.
        assert_eq!(*ran.lock().unwrap(), 2);
        assert_eq!(last_cursor.load(Ordering::SeqCst), 2);

        // Resume from cursor 2: only the remaining two steps run.
        let ran_resume = Arc::new(std::sync::Mutex::new(Vec::<usize>::new()));
        let rr = ran_resume.clone();
        let outcome = run_plan(
            &steps,
            2,
            Arc::new(AtomicBool::new(false)),
            move |s| {
                let rr = rr.clone();
                async move {
                    rr.lock().unwrap().push(s.id);
                    Ok(())
                }
            },
            |_| {},
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Done);
        assert_eq!(*ran_resume.lock().unwrap(), vec![2, 3]);
    }

    #[tokio::test]
    async fn cancel_during_final_wave_still_returns_done() {
        // A Stop set DURING the last wave is unobservable to run_plan — the
        // loop exits before its next cancel check, so the outcome is Done with
        // the flag still set. This pins the contract that forces
        // spawn_deep_summary to re-check the flag before starting the reduce.
        let steps = vec![step(0, Lane::LocalLlm, &[])];
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let outcome = run_plan(
            &steps,
            0,
            cancel.clone(),
            move |_s| {
                let c = c2.clone();
                async move {
                    c.store(true, Ordering::SeqCst);
                    Ok(())
                }
            },
            |_| {},
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Done);
        assert!(cancel.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn run_plan_parks_on_step_error() {
        let steps = vec![step(0, Lane::LocalLlm, &[]), step(1, Lane::LocalLlm, &[0])];
        let outcome = run_plan(
            &steps,
            0,
            Arc::new(AtomicBool::new(false)),
            move |s| async move {
                if s.id == 0 {
                    Err("OLLAMA_DOWN".to_string())
                } else {
                    Ok(())
                }
            },
            |_| {},
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Error("OLLAMA_DOWN".into()));
    }
}
