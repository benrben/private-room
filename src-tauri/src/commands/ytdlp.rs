use super::*;

/// ADD-26: "Save the video too" for YouTube links. The captions-only import
/// (ADD-19) stays the default; this optional path downloads the actual video
/// through yt-dlp and seals it into the room like any imported file — where
/// the existing pipeline then previews it (roommedia streaming) and
/// transcribes it in the background (Whisper lane).
///
/// The yt-dlp binary is NOT bundled: it downloads on first use to the app's
/// data dir (the Whisper-model doctrine — nothing else to install, nothing
/// GPL-linked rides in the DMG) and can be re-fetched any time YouTube breaks
/// old extractors. Both the binary fetch and the video download are labeled
/// outbound network moments, kicked off only by an explicit user action.
const YTDLP_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

/// Single-flight guard so two clicks can't download the binary twice.
static YTDLP_DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// Where the fetched yt-dlp binary lives (app data, outside any room).
fn ytdlp_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    Ok(dir.join("yt-dlp"))
}

fn emit_progress(window: &tauri::Window, status: &str, percent: Option<f64>) {
    use tauri::Emitter;
    let _ = window.emit(
        "ytdlp-progress",
        serde_json::json!({ "status": status, "percent": percent }),
    );
}

/// Fetch the yt-dlp binary if it isn't installed yet. `.part` + rename so a
/// failed download never leaves a half binary behind (stt_download_model's
/// pattern).
async fn ensure_ytdlp(
    app: &tauri::AppHandle,
    window: &tauri::Window,
) -> Result<std::path::PathBuf, String> {
    use futures_util::StreamExt;
    let dest = ytdlp_path(app)?;
    if dest.exists() {
        return Ok(dest);
    }
    if YTDLP_DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("The video downloader is already being installed — try again in a moment.".into());
    }
    let result: Result<(), String> = async {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        emit_progress(window, "Getting the video downloader (first time only)…", None);
        let part = dest.with_extension("part");
        let resp = reqwest::get(YTDLP_URL)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("downloader fetch failed: {e}"))?;
        let total = resp.content_length().unwrap_or(35 * 1024 * 1024);
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("downloader fetch interrupted: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            emit_progress(
                window,
                "Getting the video downloader (first time only)…",
                Some((got as f64 / total as f64 * 100.0).min(100.0)),
            );
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    YTDLP_DOWNLOADING.store(false, Ordering::SeqCst);
    result.map(|_| dest)
}

/// Percentage out of a yt-dlp `--newline` progress line, e.g.
/// `[download]  42.7% of 12.3MiB at 1.2MiB/s`.
pub(crate) fn parse_ytdlp_percent(line: &str) -> Option<f64> {
    let line = line.trim();
    if !line.starts_with("[download]") {
        return None;
    }
    line.split_whitespace()
        .find(|tok| tok.ends_with('%'))
        .and_then(|tok| tok.trim_end_matches('%').parse::<f64>().ok())
}

/// Download a YouTube video into the room. Fetches yt-dlp on first use, saves
/// the best single-file MP4 to a private temp folder, imports it through the
/// normal pipeline (so preview + background transcription just happen), then
/// removes the temp copy.
#[tauri::command]
pub async fn import_youtube_video(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    url: String,
) -> Result<ImportReport, String> {
    let url = url.trim().to_string();
    if web::youtube_video_id(&url).is_none() {
        return Err("That doesn't look like a YouTube video link.".into());
    }
    {
        // Fail fast (and don't fetch anything) when no room is open.
        let guard = state.room.lock().unwrap();
        guard.as_ref().ok_or("No room is open.")?;
    }
    let bin = ensure_ytdlp(&app, &window).await?;

    let work_dir = std::env::temp_dir().join(format!("private-room-yt-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    emit_progress(&window, "Downloading the video…", Some(0.0));

    // Best pre-muxed MP4 (no ffmpeg needed), else best single file. Title is
    // byte-clamped so the filename can't overflow macOS limits.
    let output = work_dir.join("%(title).100B.%(ext)s");
    let mut child = tokio::process::Command::new(&bin)
        .arg("--no-playlist")
        .arg("--newline")
        .arg("--no-warnings")
        .arg("-f")
        .arg("b[ext=mp4]/b")
        .arg("-o")
        .arg(&output)
        .arg(&url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start the video downloader: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(pct) = parse_ytdlp_percent(&line) {
                emit_progress(&window, "Downloading the video…", Some(pct));
            }
        }
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("video download failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(format!("The video download failed: {tail}"));
    }

    // The finished file is whatever yt-dlp left behind (partials are cleaned
    // up by yt-dlp itself on success).
    let downloaded = std::fs::read_dir(&work_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map_or(true, |x| x != "part"))
        .max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .ok_or("The downloader finished but produced no file.")?;

    emit_progress(&window, "Sealing the video into the room…", None);
    let report = import_files(
        app.clone(),
        state,
        vec![downloaded.to_string_lossy().into_owned()],
    );
    // The plain-disk copy exists only for this import; remove it regardless.
    let _ = std::fs::remove_dir_all(&work_dir);
    emit_progress(&window, "Done", Some(100.0));
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_parse_and_noise_is_ignored() {
        assert_eq!(
            parse_ytdlp_percent("[download]  42.7% of 12.3MiB at 1.2MiB/s"),
            Some(42.7)
        );
        assert_eq!(parse_ytdlp_percent("[download] 100% of 5MiB"), Some(100.0));
        assert_eq!(parse_ytdlp_percent("[youtube] abc: Downloading webpage"), None);
        assert_eq!(parse_ytdlp_percent("[download] Destination: x.mp4"), None);
        assert_eq!(parse_ytdlp_percent(""), None);
    }
}
