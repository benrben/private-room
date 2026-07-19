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

// Wave 1b (idea 8): the debounced always-on-indexing scheduler.
mod auto_index;
pub(crate) use auto_index::*;

// Wave 4a (Idea 2): the LLM graph workflow engine, the job queue, and the
// workflow scheduler.
mod workflow;
pub use workflow::*;
mod queue;
pub(crate) use queue::*;
mod scheduler;
pub use scheduler::*;

// Wave 5 (Idea 13): the runnable/schedulable SCRIPT runner — a new `script_run`
// node kind in the workflow engine (no parallel job system).
mod script_run;
pub use script_run::*;

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

/// Wave 4a [BLOCKER] fix: the largest CONTIGUOUS done prefix — the smallest id
/// NOT in `done`. `run_plan` no longer stores `done.len()` as the resume cursor,
/// because a branched multi-lane plan (a workflow) can finish a wave leaving a
/// NON-dense done-set (e.g. `{0,1,3}` while step 2 waits its lane slot). Storing
/// the count there would seed resume as `0..count` = `{0,1,2}`, marking step 2
/// done though it never ran and re-running step 3. The dense prefix is always a
/// valid `0..n` resume seed: every id below it is genuinely finished, and any
/// done-but-above-prefix step simply re-runs (all step side-effects are
/// idempotent — `INSERT OR REPLACE` artifacts). deep_summary/file_pass are
/// single-slot serial in practice, so for them the prefix equals the count and
/// their resume is unchanged.
pub(crate) fn dense_prefix(done: &HashSet<usize>) -> usize {
    (0..).find(|i| !done.contains(i)).unwrap_or(0)
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
/// deps always have lower ids). Each wave dispatches every ready step its lanes
/// allow, runs them concurrently, then `checkpoint(&done)` persists progress and
/// `progress(done, total)` updates the UI. A set `cancel` flag pauses between
/// waves; a step error parks the job. Generic over `execute` so it is unit-
/// tested without the app.
///
/// Wave 4a [BLOCKER] fix: `start_done` is the actual set of finished step ids
/// (seeded `0..cursor` for the serial job kinds, an arbitrary persisted set for
/// a branched workflow), and the checkpoint callback receives the whole `&done`
/// set — NOT a scalar count — so a workflow spawner can serialize the real
/// done-set for a correct resume, and the serial spawners can keep storing their
/// dense-prefix cursor.
pub async fn run_plan<F, Fut, C>(
    steps: &[Step],
    start_done: HashSet<usize>,
    cancel: Arc<AtomicBool>,
    mut execute: F,
    mut checkpoint: C,
    mut progress: impl FnMut(usize, usize),
) -> RunOutcome
where
    F: FnMut(Step) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
    C: FnMut(&HashSet<usize>),
{
    use futures_util::future::join_all;
    let total = steps.len();
    let mut done: HashSet<usize> = start_done;
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
        checkpoint(&done);
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
    let has_flag = {
        let flags = state.job_cancels.lock().unwrap();
        if let Some(flag) = flags.get(&id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    };
    // Wave 4a: a QUEUED job has no in-memory cancel flag (it never spawned), so
    // the flag flip above is a no-op — park the row directly instead, so
    // "Remove from queue" actually stops it starting later.
    if !has_flag {
        let _ = state.with_room(|room| {
            let job = db::get_job(&room.conn, &id)?;
            if job.status == "queued" {
                db::set_job_status(&room.conn, &id, "paused", None)?;
            }
            Ok(())
        });
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
        // A job left 'running' belongs to a process that's gone (in-memory cancel
        // flags don't survive a restart) — park it 'paused' so the UI offers
        // Resume instead of a phantom-active card. A 'queued' job never started,
        // so it is LEFT queued: `pump_on_open` auto-resumes it at unlock (engine
        // review #3 — demoting queued here made pump_on_open a dead no-op).
        for j in jobs.iter().filter(|j| j.status == "running") {
            let _ = db::set_job_status(conn, &j.id, "paused", None);
        }
    }
}

/// Wave 1b (idea 8): a cached one-liner that actually says something. The ''
/// sentinel an auto job writes for a stuck file (see `spawn_deep_summary`)
/// counts as MISSING here, so a user-started run retries it while the auto
/// scheduler (which reads `files_missing_summary`, NULL-only) leaves it alone.
fn has_liner(f: &db::SummaryFile) -> bool {
    f.ai_summary.as_deref().is_some_and(|s| !s.trim().is_empty())
}

/// Build the deep-summary plan for the room's CURRENT files: one step per file,
/// on the lane the selected engine implies. Shared by start and resume. Also
/// returns the path of the room the files were read from, so callers can
/// verify the room didn't swap across this function's await, and whether a
/// generated Room summary page already exists (the auto reduce rule).
///
/// `auto` (Wave 1b, idea 8): a MANUAL plan is the capped whole-room list
/// (unchanged behavior); an AUTO plan is built from the files still MISSING a
/// one-liner — uncapped, newest drops included — because in a ≥50-file room
/// the capped list's `take()` would never reach freshly imported files (they
/// sort last) and the job would do nothing for them. An auto plan may be
/// EMPTY (nothing to index); auto callers handle that, manual callers keep
/// today's error.
async fn deep_summary_plan(
    state: &AppState,
    auto: bool,
) -> Result<(Vec<db::SummaryFile>, String, Vec<Step>, String, bool), String> {
    let (files, model, room_path, has_summary_page) = state.with_room(|room| {
        let all = db::list_files_for_summary(&room.conn)?;
        let has_summary_page = all
            .iter()
            .any(|f| f.name == SUMMARY_FILE_NAME && f.source == "generated");
        let files: Vec<db::SummaryFile> = if auto {
            all.into_iter()
                .filter(|f| !is_summary_file(&f.name, &f.source))
                .filter(|f| {
                    f.ai_summary.is_none()
                        && f.text.as_deref().is_some_and(|t| !t.trim().is_empty())
                })
                .collect()
        } else {
            all.into_iter()
                .filter(|f| !is_summary_file(&f.name, &f.source))
                .take(MAX_SUMMARY_FILES)
                .collect()
        };
        Ok((files, model_setting(&room.conn), room.path.clone(), has_summary_page))
    })?;
    if files.is_empty() && !auto {
        return Err("This room has no files to summarize yet.".into());
    }
    let models = ollama::list_models().await.unwrap_or_default();
    // Engine parity: the room's chosen engine drives the summarizer — external
    // CLIs go through the sidecar's external backend, `:cloud` through the
    // proxy; both ride the Cloud lane (remote capacity, visible labeling).
    let chat_model = model.unwrap_or_else(|| best_default(&models));
    let lane = if is_cloud_model(&chat_model) || is_external_engine(&chat_model) {
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
    Ok((files, chat_model, steps, room_path, has_summary_page))
}

/// Spawn the checkpointed runner for a deep-summary job (fresh or resumed).
/// On completion it runs the reduce and writes "Room summary.html" — the job is
/// only 'done' once the summary file exists. The heavy per-file text and model
/// calls happen off the room lock; only the short one-liner reads/writes take it.
/// `room_path` pins the job to the room it was started in: every read/write
/// re-checks the CURRENT room against it, so a room closed or swapped mid-run
/// can never receive this job's writes.
///
/// Wave 1b (idea 8): `auto` marks a self-started indexing run — a stuck file
/// (empty/errored one-liner) gets the '' sentinel so it leaves the missing set
/// and the scheduler terminates, and the terminal event neither hijacks the
/// viewer nor claims "Summary ready". `reduce` says whether the final
/// Room-summary write runs at all: always for manual jobs; for auto jobs only
/// when a generated summary page already existed at plan time (refresh, never
/// create unasked).
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
    auto: bool,
    reduce: bool,
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
            (0..start_cursor).collect(),
            cancel.clone(),
            |s| {
                let state = app.state::<AppState>();
                let f = files[s.id].clone();
                let model = chat_model.clone();
                let room_path = room_path.clone();
                async move {
                    // Skip files that already have a REAL cached one-liner (the
                    // '' sentinel counts as missing, so a manual run retries it).
                    if has_liner(&f) {
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
                    // Wave 1b (idea 8): an auto job writes the '' sentinel for a
                    // file that yields no liner, so it leaves files_missing_summary
                    // and the scheduler can't loop over it forever. Cleared back to
                    // NULL whenever the file's content changes; a manual run still
                    // retries it (has_liner treats '' as missing).
                    let mark = |liner: &str| {
                        let guard = state.room.lock().unwrap();
                        if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                            let _ = db::set_file_ai_summary(&r.conn, &f.id, liner);
                        }
                    };
                    match summarize_one_file(&model, &f.name, &f.mime, &full, KEEP_ALIVE_WARM).await {
                        Ok(liner) if !liner.is_empty() => {
                            mark(&liner);
                            Ok(())
                        }
                        Ok(_) => {
                            if auto {
                                mark("");
                            }
                            Ok(())
                        }
                        // A hard error (server down / model gone) parks the job;
                        // a one-off failure just leaves this file uncached (or
                        // sentinel-marked on an auto run).
                        Err(e) if e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING") => Err(e),
                        Err(_) => {
                            if auto {
                                mark("");
                            }
                            Ok(())
                        }
                    }
                }
            },
            |done_set| {
                // deep_summary steps are independent and single-lane serial, so
                // the done-set is always a dense prefix — the cursor is its size.
                let cursor = dense_prefix(done_set);
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
                    &if auto {
                        format!("Indexing file {done} of {total}…")
                    } else {
                        format!("Summarizing file {done} of {total}…")
                    },
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
        //
        // Wave 1b (idea 8): an auto job runs this only when `reduce` says an
        // existing generated summary page should stay fresh — "done" for a
        // plain auto job means all one-liners cached, and no summary page is
        // ever created unasked.
        let mut summary_file: Option<FileMeta> = None;
        let outcome = if matches!(outcome, RunOutcome::Done) {
            // A Stop pressed during the final wave is only observable AFTER
            // run_plan returns Done — honor it here so the reduce never runs
            // cancelled. Resume re-derives the cursor and retries the reduce.
            if cancel.load(Ordering::SeqCst) {
                RunOutcome::Paused
            } else if !reduce {
                outcome
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
            // Wave 1b (idea 8): an auto job's terminal event says what actually
            // happened and NEVER carries a fileId — effects.ts force-opens any
            // fileId in the viewer, unacceptable for a job the user never started.
            RunOutcome::Done => serde_json::json!({
                "jobId": job_id,
                "label": if auto { "Indexing finished" } else { "Summary ready" },
                "done": total, "total": total, "finished": true,
                "fileId": if auto { None } else { summary_file.map(|m| m.id) },
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
        // Wave 4a: free the queue slot and start the next waiting job.
        queue::finish_and_pump(&app, &window, &job_id).await;
    });
}

/// Start a room deep-summary as a durable background job. Each file is one
/// checkpointed step; the reduce + HTML write run once every step is done.
/// Returns the job id immediately; progress arrives via `job-progress` and the
/// finished summary via `room-files-changed`.
///
/// Wave 1b (idea 8) — AUTO-INDEX ENTRY POINT: `auto: true` is how the
/// `auto_index` scheduler starts an indexing run (missing-set plan, honest
/// labels, no unasked summary page). INTEGRATION DECISION (2026-07-18): Wave
/// 4a's "new-file summarizer" workflow template must call THIS machinery
/// (`schedule_auto_index` / `start_deep_summary_inner(auto = true)`) — it must
/// not grow its own scheduler or plan builder.
pub(crate) async fn start_deep_summary_inner(
    window: tauri::Window,
    state: &AppState,
    auto: bool,
) -> Result<String, String> {
    // Wave 3 (Idea 9): don't start heavy work while a rollback is swapping.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let (files, chat_model, steps, plan_room, has_summary_page) =
        deep_summary_plan(state, auto).await?;
    if files.is_empty() {
        // Only reachable for auto plans (manual ones error inside the builder):
        // everything is already indexed, nothing to start.
        return Err("Nothing to index — every file already has a description.".into());
    }
    // The auto reduce rule is decided at START time and stored in the plan, so
    // a resume after restart keeps the same semantics (no plan re-reading races).
    let reduce = !auto || has_summary_page;
    let plan = serde_json::json!({ "steps": steps, "auto": auto, "reduce": reduce });
    let total = steps.len() as i64;
    let title = if auto { "Indexing new files" } else { "Room summary" };

    let (job_id, room_path) = state.with_room(|room| {
        // The plan was read before an await (the Ollama model probe) — a room
        // swapped in that window must not receive a job built from the old
        // room's files.
        if room.path != plan_room {
            return Err("The room changed while starting this job.".into());
        }
        // Wave 4a: too many jobs already waiting — refuse rather than pile up.
        if queue::at_capacity(&room.conn) {
            return Err("Too many background jobs are already waiting — let some finish first.".into());
        }
        let id = db::create_job(&room.conn, "deep_summary", title, &plan, total)?;
        Ok((id, room.path.clone()))
    })?;

    // Wave 4a: start now if the single heavy-work slot is free, else leave the
    // row 'queued' — the queue pump (or room-open) starts it later. Clicking
    // Summarize while a job runs now enqueues instead of erroring.
    if queue::try_reserve(state, &job_id) {
        let cancel = Arc::new(AtomicBool::new(false));
        state
            .job_cancels
            .lock()
            .unwrap()
            .insert(job_id.clone(), cancel.clone());
        spawn_deep_summary(
            window,
            job_id.clone(),
            room_path,
            files,
            chat_model,
            steps,
            0,
            cancel,
            auto,
            reduce,
        );
    }
    Ok(job_id)
}

#[tauri::command]
pub async fn start_deep_summary(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    start_deep_summary_inner(window, state.inner(), false).await
}

// ------------------------------------------------------------ studio (background)

/// Run one Studio artifact (flashcards / mind map / podcast script) as a durable
/// background job — a SINGLE atomic unit (`total = 1`), unlike deep_summary's
/// per-file checkpointed steps. There is no mid-work checkpoint, so a Stop or
/// crash parks the job and resuming re-runs it from scratch (a fresh file).
/// Reports via the terminal `job-progress` event carrying the generated file's
/// id (the frontend auto-opens it), then frees the queue slot.
#[allow(clippy::too_many_arguments)]
fn spawn_studio(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    kind: String,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    cancel: Arc<AtomicBool>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // Status → running, room-pinned so a swapped room can't be mislabeled.
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }
        emit_progress(&window, &job_id, "Starting…", 0, 1);

        // Ok(meta) = done; Err(None) = paused (Stop); Err(Some(e)) = error.
        let outcome: Result<FileMeta, Option<String>> = match studio_spec_for(&kind) {
            Some(spec) => match run_studio_core(
                &window,
                &state,
                spec,
                scope,
                instructions,
                refs,
                cancel.clone(),
                Some(&room_path),
            )
            .await
            {
                Ok(meta) => Ok(meta),
                // A Stop surfaces as Err("Stopped."); treat any error while the
                // cancel flag is set as a clean Paused, like the file-pass runner.
                Err(_) if cancel.load(Ordering::SeqCst) => Err(None),
                Err(e) => Err(Some(e)),
            },
            None => Err(Some(format!("Unknown studio kind '{kind}'."))),
        };

        // Terminal status write (room-pinned).
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    Ok(_) => ("done", None),
                    Err(None) => ("paused", None),
                    Err(Some(e)) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);

        use tauri::Emitter;
        let payload = match outcome {
            Ok(meta) => serde_json::json!({
                "jobId": job_id,
                "label": format!("{} ready", studio_title(&kind)),
                "done": 1, "total": 1, "finished": true,
                "fileId": meta.id,
            }),
            Err(None) => serde_json::json!({
                "jobId": job_id, "label": "Paused", "done": 0, "total": 1, "paused": true,
            }),
            Err(Some(e)) => serde_json::json!({
                "jobId": job_id, "label": format!("Stopped — {e}"), "done": 0, "total": 1,
                "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
        queue::finish_and_pump(&app, &window, &job_id).await;
    });
}

/// Enqueue a Studio generation as a background job and return its id immediately.
/// The result arrives via `room-files-changed` + the terminal `job-progress`
/// (which auto-opens the generated HTML). If the single job slot is busy the job
/// waits in the queue and the running job's epilogue pumps it.
pub(crate) async fn start_studio_job_inner(
    window: tauri::Window,
    state: &AppState,
    kind: String,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
) -> Result<String, String> {
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    if studio_spec_for(&kind).is_none() {
        return Err("Unknown studio kind.".into());
    }
    let title = studio_title(&kind);
    // Borrow into the plan so the values stay owned for spawn_studio below.
    let plan = serde_json::json!({
        "kind": &kind, "scope": &scope, "instructions": &instructions, "refs": &refs,
    });
    let (job_id, room_path) = state.with_room(|room| {
        if queue::at_capacity(&room.conn) {
            return Err("Too many background jobs are already waiting — let one finish first.".into());
        }
        let id = db::create_job(&room.conn, "studio", title, &plan, 1)?;
        Ok((id, room.path.clone()))
    })?;
    if queue::try_reserve(state, &job_id) {
        let cancel = Arc::new(AtomicBool::new(false));
        state.job_cancels.lock().unwrap().insert(job_id.clone(), cancel.clone());
        spawn_studio(window, job_id.clone(), room_path, kind, scope, instructions, refs, cancel);
    }
    Ok(job_id)
}

#[tauri::command]
pub async fn start_studio_job(
    window: tauri::Window,
    state: State<'_, AppState>,
    kind: String,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
) -> Result<String, String> {
    start_studio_job_inner(window, state.inner(), kind, scope, instructions, refs).await
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
    // Wave 3 (Idea 9): don't resume a job while a rollback is swapping the DB.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // The job must exist and be resumable, and must not be an inline child (a
    // workflow's file_pass child is re-driven by its parent, never on its own).
    let job = state.with_room(|room| db::get_job(&room.conn, &id))?;
    if job.parent_job_id.is_some() {
        return Err("This job runs as part of a workflow — resume the workflow instead.".into());
    }
    if !matches!(job.kind.as_str(), "deep_summary" | "file_pass" | "workflow" | "studio") {
        return Err("This job can't be resumed.".into());
    }
    // Wave 4a: resume through the QUEUE — set the row back to 'queued' and submit.
    // If the single slot is free it starts now (queue::start_job_from_row rebuilds
    // the plan, exactly as the old resume did); if a job is already running it
    // waits and the running job's epilogue pumps it — no "already running" error.
    state.with_room(|room| db::set_job_status(&room.conn, &id, "queued", None))?;
    queue::submit(&window, state.inner(), id).await
}

// ------------------------------------------------------------ file pass (ADD-32)

/// The engine a pass runs on: the room's CHOSEN model — engine parity means
/// external CLIs (sidecar external backend) and `:cloud` proxies are honored,
/// riding the Cloud lane with the same visible labeling as chat. Only a room
/// with no model setting falls back to the best local model.
async fn resolve_pass_engine(state: &AppState) -> (String, Lane) {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|r| model_setting(&r.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let chat_model = explicit.unwrap_or_else(|| best_local_default(&models));
    let lane = if is_cloud_model(&chat_model) || is_external_engine(&chat_model) {
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
    // Wave 3 (Idea 9): don't start a file pass while a rollback is swapping.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
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
        if queue::at_capacity(&room.conn) {
            return Err("Too many background jobs are already waiting — let some finish first.".into());
        }
        db::create_job(&room.conn, "file_pass", &title, &plan_json, steps.len() as i64)
    })?;
    // Wave 4a: start now if the heavy-work slot is free, else leave it queued.
    if queue::try_reserve(state, &job_id) {
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
    }
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
            (0..start_cursor).collect(),
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
            |done_set| {
                // Store the dense prefix, not the count: a file_pass on the Cloud
                // lane (4 slots) can finish a compose section out of id order,
                // leaving a non-dense done-set — the prefix is the only valid
                // `0..cursor` resume seed (artifacts are idempotent, so a
                // done-but-above-prefix step simply re-runs).
                let cursor = dense_prefix(done_set);
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
        // Wave 4a: free the queue slot and start the next waiting job.
        queue::finish_and_pump(&app, &window, &job_id).await;
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

    #[test]
    fn dense_prefix_is_smallest_missing_id() {
        // Wave 4a: a dense set's prefix is its size; a hole caps it at the hole.
        assert_eq!(dense_prefix(&HashSet::new()), 0);
        assert_eq!(dense_prefix(&[0, 1, 2].into_iter().collect()), 3);
        // {0,1,3}: step 2 is a hole, so the valid resume prefix is 2 (NOT 3).
        assert_eq!(dense_prefix(&[0, 1, 3].into_iter().collect()), 2);
        // A set missing 0 entirely resumes from scratch.
        assert_eq!(dense_prefix(&[1, 2, 3].into_iter().collect()), 0);
    }

    #[tokio::test]
    async fn run_plan_checkpoints_dense_prefix_not_count_on_branched_plan() {
        // Wave 4a [BLOCKER] regression (engine-review #4): to actually exercise a
        // NON-dense done-set the contention must be SAME-lane. LocalLlm concurrency
        // is 1, so with two LocalLlm steps (1,2) both ready after 0, only one runs
        // per wave while the Cpu step (3) runs alongside — a wave finishes {0,1,3}
        // with id 2 still pending. dense_prefix there is 2, but done.len() is 3.
        // The checkpoint MUST record the prefix (2), never the count (3): recording
        // 3 would mark id 2 done though it never ran. We assert some checkpoint saw
        // prefix < done_count, which a regression to checkpoint(done.len()) fails.
        let steps = vec![
            step(0, Lane::LocalLlm, &[]),
            step(1, Lane::LocalLlm, &[0]),
            step(2, Lane::LocalLlm, &[0]),
            step(3, Lane::Cpu, &[0]),
        ];
        // Record (dense_prefix, done_count) at every checkpoint.
        let seen = Arc::new(std::sync::Mutex::new(Vec::<(usize, usize)>::new()));
        let s2 = seen.clone();
        let outcome = run_plan(
            &steps,
            HashSet::new(),
            Arc::new(AtomicBool::new(false)),
            move |_s| async move { Ok(()) },
            move |done| s2.lock().unwrap().push((dense_prefix(done), done.len())),
            |_, _| {},
        )
        .await;
        assert_eq!(outcome, RunOutcome::Done);
        let cps = seen.lock().unwrap().clone();
        // The whole point: the stored resume value is the contiguous prefix, which
        // is strictly below the raw done-count at least once (the non-dense wave).
        assert!(
            cps.iter().any(|&(prefix, count)| prefix < count),
            "expected a non-dense checkpoint (prefix < done_count); saw {cps:?}"
        );
        // Every recorded prefix is a valid contiguous resume point, ending full.
        assert!(cps.iter().all(|&(prefix, _)| prefix <= 4));
        assert_eq!(cps.last().unwrap().0, 4);
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
            HashSet::new(),
            Arc::new(AtomicBool::new(false)),
            move |s| {
                let o = o2.clone();
                async move {
                    o.lock().unwrap().push(s.id);
                    Ok(())
                }
            },
            move |done| c2.lock().unwrap().push(done.len()),
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
            HashSet::new(),
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
            move |done| lc2.store(dense_prefix(done), Ordering::SeqCst),
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
            (0..2).collect(),
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
            HashSet::new(),
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
            HashSet::new(),
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
