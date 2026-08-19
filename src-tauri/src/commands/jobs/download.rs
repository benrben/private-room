//! BROWSE-2 (D18): the "download" job kind — a URL fetched (or media pulled
//! via yt-dlp) into the room as a durable background job with live progress
//! and cancel. A download is a SINGLE atomic unit like a studio run: no
//! mid-work checkpoint, so a Stop or crash parks the job and resuming
//! re-downloads from scratch. The live `job-progress` events carry the 0–100
//! byte percentage, and that is what draws the card's bar; the ROW's total is
//! 0, because nothing ever advances its cursor (see `create_job` below).

use super::*;

/// Plain fetch of one file (`web::download_to_temp`).
pub(crate) const DOWNLOAD_ENGINE_FETCH: &str = "fetch";
/// yt-dlp media download (`download_media_to_temp`).
pub(crate) const DOWNLOAD_ENGINE_MEDIA: &str = "media";

/// A short honest job title: the filename when the URL has one, else the host.
fn download_title(url: &str, engine: &str) -> String {
    let short = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|s| s.filter(|p| !p.is_empty()).next_back().map(str::to_string))
                .filter(|s| engine == DOWNLOAD_ENGINE_FETCH && !s.is_empty())
                .or_else(|| u.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| url.to_string());
    format!("Download {short}")
}

/// Create + submit a download job. The URL passes the literal guard here so a
/// bad address is refused at creation, not discovered by a queued runner later;
/// the full guard (DNS) runs again inside the engines.
pub(crate) async fn start_download_job_inner(
    window: &tauri::Window,
    state: &AppState,
    url: &str,
    engine: &str,
) -> Result<String, String> {
    if !matches!(engine, DOWNLOAD_ENGINE_FETCH | DOWNLOAD_ENGINE_MEDIA) {
        return Err("Unknown download engine.".into());
    }
    // Refuse at CREATION when the room is offline, rather than queueing a job
    // whose only possible outcome is a network reach the switch forbids.
    crate::commands::require_web_access(state)?;
    crate::web::check_public_http_url(url)?;
    let plan = serde_json::json!({ "url": url, "engine": engine });
    let title = download_title(url, engine);
    let (job_id, room_path) = state.with_room(|room| {
        if queue::at_capacity(&room.conn) {
            return Err(queue::QUEUE_FULL.into());
        }
        // No step count, for the Studio row's reason: the cursor never moves,
        // so a total of 100 turned that absence into a claim — a finished
        // download sat in History reading "Finished — 0 of 100 steps". The
        // percentage the user watches comes from the live event, which still
        // carries its own 0–100; the row itself states no fraction.
        let id = db::create_job(&room.conn, "download", &title, &plan, 0)?;
        Ok((id, room.path.clone()))
    })?;
    if queue::try_reserve(state, &job_id) {
        let cancel = Arc::new(AtomicBool::new(false));
        state.job_cancels.lock().unwrap().insert(job_id.clone(), cancel.clone());
        spawn_download(
            window.clone(),
            job_id.clone(),
            room_path,
            url.to_string(),
            engine.to_string(),
            cancel,
        );
    }
    Ok(job_id)
}

/// Queue-pump entry: rebuild a download job from its plan and spawn the runner.
pub(crate) fn start_download_row(
    window: &tauri::Window,
    _state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let url = job
        .plan
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("This job's plan is unreadable.")?
        .to_string();
    let engine = job
        .plan
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or(DOWNLOAD_ENGINE_FETCH)
        .to_string();
    spawn_download(window.clone(), job.id.clone(), room_path.to_string(), url, engine, cancel);
    Ok(())
}

/// The runner: download by engine, import through the one funnel
/// (`import_download` — D13), report truthfully, free the queue slot.
fn spawn_download(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    url: String,
    engine: String,
    cancel: Arc<AtomicBool>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let (runner_window, runner_job, runner_room) =
        (window.clone(), job_id.clone(), room_path.clone());
    super::spawn_job_runner(runner_window, runner_job, runner_room, async move {
        let state = app.state::<AppState>();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }
        emit_progress(&window, &job_id, "Downloading…", 0, 100);

        // Ok(meta) = imported; Err(None) = paused (Stop); Err(Some(e)) = error.
        let outcome: Result<FileMeta, Option<String>> = {
            let run = run_download(&app, &window, &job_id, &url, &engine, &cancel).await;
            match run {
                Ok(meta) => Ok(meta),
                Err(_) if cancel.load(Ordering::SeqCst) => Err(None),
                Err(e) => Err(Some(e)),
            }
        };

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
                "label": format!("{} arrived in the room", meta.name),
                "done": 100, "total": 100, "finished": true,
                "fileId": meta.id,
            }),
            Err(None) => serde_json::json!({
                "jobId": job_id, "label": "Paused", "done": 0, "total": 100, "paused": true,
            }),
            Err(Some(e)) => serde_json::json!({
                "jobId": job_id, "label": format!("Download failed — {e}"), "done": 0, "total": 100,
                "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
        queue::finish_and_pump(&app, &window, &job_id).await;
    });
}

/// One download by engine, ending in the room. Byte progress maps onto the
/// 0–100 card; a fetch with no declared length just keeps its bar at zero
/// rather than inventing one.
async fn run_download(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    job_id: &str,
    url: &str,
    engine: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<FileMeta, String> {
    if engine == DOWNLOAD_ENGINE_MEDIA {
        let progress = |status: &str, pct: Option<f64>| {
            let done = pct.unwrap_or(0.0).clamp(0.0, 100.0) as usize;
            emit_progress(window, job_id, status, done, 100);
        };
        let media = download_media_to_temp(app, url, Some(cancel), &progress).await?;
        let name = media
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "media".to_string());
        emit_progress(window, job_id, "Sealing into the room…", 99, 100);
        let imported = import_download(app, &media.path, &name, url);
        let _ = std::fs::remove_dir_all(&media.work_dir);
        return imported;
    }
    let outcome = web::download_to_temp(url, web::MAX_DOWNLOAD_BYTES, Some(cancel), |got, declared| {
        let done = declared
            .filter(|d| *d > 0)
            .map(|d| ((got as f64 / d as f64) * 100.0).clamp(0.0, 99.0) as usize)
            .unwrap_or(0);
        emit_progress(window, job_id, "Downloading…", done, 100);
    })
    .await?;
    match outcome {
        web::DownloadOutcome::Done(d) => {
            emit_progress(window, job_id, "Sealing into the room…", 99, 100);
            import_download(app, &d.path, &d.file_name, url)
        }
        web::DownloadOutcome::TooLarge => Err(format!(
            "The file is larger than the {} MB limit for a room file.",
            web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
        )),
    }
}

/// BROWSE-2: the frontend entry — the toolbar's "Download video" and any
/// explicit "download this URL as a job" action.
#[tauri::command]
pub async fn start_download_job(
    window: tauri::Window,
    state: State<'_, AppState>,
    url: String,
    engine: String,
) -> Result<String, String> {
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    start_download_job_inner(&window, state.inner(), url.trim(), &engine).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_titles_prefer_the_filename_then_the_host() {
        assert_eq!(
            download_title("https://example.com/reports/q3.pdf", DOWNLOAD_ENGINE_FETCH),
            "Download q3.pdf"
        );
        // Media URLs rarely end in a meaningful filename — the host is honest.
        assert_eq!(
            download_title("https://www.youtube.com/watch?v=abc12345", DOWNLOAD_ENGINE_MEDIA),
            "Download www.youtube.com"
        );
        assert_eq!(
            download_title("not a url", DOWNLOAD_ENGINE_FETCH),
            "Download not a url"
        );
    }

    /// The Studio row's defect, one kind over: nothing in `spawn_download`
    /// ever calls `checkpoint_job`, so the cursor of a download row is 0 for
    /// the whole of its life — including after it succeeded. Created with a
    /// total of 100, the finished row read "Finished — 0 of 100 steps": a job
    /// stating it completed none of the hundred steps it had just completed.
    ///
    /// Zero is the honest total. `HistoryRow` already drops the "N of M steps"
    /// clause when `total > 0` is false, and the live bar is unaffected — it
    /// reads the `job-progress` event, which carries its own 0–100 byte
    /// percentage.
    #[test]
    fn a_download_job_claims_no_step_count_it_never_advances() {
        let src = include_str!("download.rs");
        let line = src
            .lines()
            .find(|l| l.contains(concat!("create_job(&room.conn, \"down", "load\"")))
            .expect("the download job creation site moved — find it and re-pin this");
        assert!(
            line.trim_end().ends_with(", 0)?;"),
            "a download row must be created with no step count, got: {}",
            line.trim()
        );
    }
}
