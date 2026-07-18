//! Wave 1b (idea 8): always-on indexing — the debounced scheduler that turns
//! "files were imported/OCR'd/transcribed" into `ai_summary` coverage without
//! the user pressing Summarize.
//!
//! Shape: every ingest event calls `schedule_auto_index`, which bumps a
//! generation stamp and spawns one waiter. The waiter debounces (~30 s, so a
//! multi-file drop coalesces), re-checks it is still the LATEST waiter, then
//! runs the pure `auto_index_decision`: tiny drops go through the quiet
//! opportunistic filler (no job card), big drops become one visible,
//! cancellable, resumable "Indexing new files" job over the MISSING-summary
//! set, busy moments retry bounded, and rooms with no model installed skip.
//!
//! INTEGRATION DECISION (2026-07-18, master plan Wave 1b): this module and
//! `start_deep_summary_inner(auto = true)` are the ONE auto-index entry point.
//! Wave 4a's "new-file summarizer" workflow template must call this same
//! machinery — it must NOT duplicate the scheduler, the missing-set plan, or
//! the sentinel policy.

use super::*;

/// Debounce between the ingest event and the indexing decision. Also replaces
/// the quiet filler's own 45 s head start (the filler is invoked with delay 0
/// once this debounce has already passed, so tiny drops don't wait ~75 s).
pub(crate) const AUTO_INDEX_DEBOUNCE_SECS: u64 = 30;
/// While a question streams or another job runs, retry this often…
const AUTO_INDEX_RETRY_SECS: u64 = 60;
/// …at most this many times (a fresh import re-arms from zero).
const AUTO_INDEX_MAX_RETRIES: u32 = 10;
/// Drops of at most this many missing files stay silent (quiet filler, no
/// job-card noise); anything larger becomes a visible job.
pub(crate) const QUIET_FILLER_MAX: usize = 5;

/// What the scheduler should do once the debounce elapses. Pure — this is
/// where the whole policy lives, so it is unit-tested exhaustively below.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum AutoIndexDecision {
    /// Nothing to do (or nothing can be done); the next ingest re-arms.
    Skip,
    /// Run the legacy opportunistic filler — silent, non-durable. Used when
    /// the feature is toggled off (today's behavior) and for tiny drops.
    QuietFiller,
    /// Start one durable, visible "Indexing new files" job.
    StartJob,
    /// The room is busy (streaming answer or live job) — try again shortly.
    Retry,
}

/// `setting_on`: the `auto_index` room setting (absent = on, "0" = off).
/// `missing`: `files_missing_summary` count (sentinel'd files excluded).
/// `job_running` / `asking`: live cancel-registry probes.
/// `models_available`: whether Ollama reported any installed model.
pub(crate) fn auto_index_decision(
    setting_on: bool,
    missing: usize,
    job_running: bool,
    asking: bool,
    models_available: bool,
) -> AutoIndexDecision {
    if !setting_on {
        // Off = byte-for-byte today's behavior: the opportunistic filler,
        // which yields to streaming answers internally.
        return AutoIndexDecision::QuietFiller;
    }
    if asking || job_running {
        return AutoIndexDecision::Retry;
    }
    if !models_available || missing == 0 {
        return AutoIndexDecision::Skip;
    }
    if missing <= QUIET_FILLER_MAX {
        AutoIndexDecision::QuietFiller
    } else {
        AutoIndexDecision::StartJob
    }
}

/// Debounce + dispatch. Called at the end of `import_files`, `run_ocr_job`
/// and `run_stt_job` (after their locks drop), replacing the direct
/// `spawn_summary_filler` calls — so import latency is untouched and repeated
/// drops re-arm the same single waiter.
pub(crate) fn schedule_auto_index(app: &tauri::AppHandle, room_path: String) {
    use tauri::Manager;
    let generation = {
        let state = app.state::<AppState>();
        state.auto_index_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mine = |app: &tauri::AppHandle| {
            let state = app.state::<AppState>();
            state.auto_index_generation.load(Ordering::SeqCst) == generation
        };
        tokio::time::sleep(std::time::Duration::from_secs(AUTO_INDEX_DEBOUNCE_SECS)).await;
        let mut retries = 0u32;
        loop {
            // A later ingest re-armed the debounce — that waiter owns the run.
            if !mine(&app) {
                return;
            }
            let (setting_on, missing, still_open) = {
                let state = app.state::<AppState>();
                let guard = state.room.lock().unwrap();
                match guard.as_ref() {
                    Some(room) if room.path == room_path => {
                        let on = db::get_setting(&room.conn, "auto_index").as_deref() != Some("0");
                        let missing = db::files_missing_summary(&room.conn, QUIET_FILLER_MAX + 1)
                            .map(|v| v.len())
                            .unwrap_or(0);
                        (on, missing, true)
                    }
                    _ => (false, 0, false),
                }
            };
            if !still_open {
                return;
            }
            let (asking, job_running) = {
                let state = app.state::<AppState>();
                let asking = !state.cancels.lock().unwrap().is_empty();
                let job_running = !state.job_cancels.lock().unwrap().is_empty();
                (asking, job_running)
            };
            let models_available = !ollama::list_models().await.unwrap_or_default().is_empty();
            // The model probe awaited — a newer waiter may own the run now.
            if !mine(&app) {
                return;
            }
            match auto_index_decision(setting_on, missing, job_running, asking, models_available) {
                AutoIndexDecision::Skip => return,
                AutoIndexDecision::QuietFiller => {
                    // Delay 0: this waiter already debounced (addendum fix —
                    // the filler's own 45 s head start would stack on top).
                    spawn_summary_filler(app.clone(), room_path.clone(), 0);
                    return;
                }
                AutoIndexDecision::Retry => {
                    retries += 1;
                    if retries > AUTO_INDEX_MAX_RETRIES {
                        return; // bounded; the next ingest re-arms from zero
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(AUTO_INDEX_RETRY_SECS))
                        .await;
                    continue;
                }
                AutoIndexDecision::StartJob => {
                    let state = app.state::<AppState>();
                    // Job-lifecycle amendment: any unfinished auto job (parked
                    // 'paused' by quiesce after a quit mid-run) is strictly
                    // superseded by the fresh missing-set plan — delete it so
                    // stale Resume cards don't stack.
                    let _ = state.with_room(|room| {
                        if room.path != room_path {
                            return Ok(());
                        }
                        for j in db::unfinished_jobs(&room.conn)? {
                            let auto_job = j.kind == "deep_summary"
                                && j.plan.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
                            if auto_job {
                                let _ = db::delete_job(&room.conn, &j.id);
                            }
                        }
                        Ok(())
                    });
                    let Some(webview) = app.get_webview_window("main") else { return };
                    let window = webview.as_ref().window();
                    let _ = start_deep_summary_inner(window, state.inner(), true).await;
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use AutoIndexDecision::*;

    #[test]
    fn auto_index_decision_covers_all_branches() {
        // Toggled off → today's quiet filler, regardless of everything else.
        assert_eq!(auto_index_decision(false, 100, true, true, false), QuietFiller);
        // Busy (a streaming answer or a live job) → bounded retry.
        assert_eq!(auto_index_decision(true, 10, true, false, true), Retry);
        assert_eq!(auto_index_decision(true, 10, false, true, true), Retry);
        // No model installed → skip (the next import re-arms).
        assert_eq!(auto_index_decision(true, 10, false, false, false), Skip);
        // Nothing missing → skip.
        assert_eq!(auto_index_decision(true, 0, false, false, true), Skip);
        // Tiny drop → quiet filler, no job-card noise.
        assert_eq!(auto_index_decision(true, 1, false, false, true), QuietFiller);
        assert_eq!(
            auto_index_decision(true, QUIET_FILLER_MAX, false, false, true),
            QuietFiller
        );
        // Above the threshold → one visible durable job.
        assert_eq!(
            auto_index_decision(true, QUIET_FILLER_MAX + 1, false, false, true),
            StartJob
        );
        // Busy wins over "no model": we re-check availability on the retry.
        assert_eq!(auto_index_decision(true, 10, true, false, false), Retry);
    }
}
