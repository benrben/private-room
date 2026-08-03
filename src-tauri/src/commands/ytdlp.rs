use super::*;

/// ADD-26 → BROWSE-2: media downloads through yt-dlp. "Save the video too" for
/// YouTube links stays the user-facing default; the same engine now serves ANY
/// yt-dlp-supported site through [`download_media_to_temp`] — the toolbar's
/// Download video, the Add-link modal, and the agent's `download_media` job all
/// ride it. The captions-only import (ADD-19) remains the cheap path.
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

/// The Stop flag for the INTERACTIVE download (the Add-link modal's "Video from
/// this page", the toolbar's Download video).
///
/// `download_media_to_temp` has always been able to be stopped — the agent's
/// `download_media` job passes its run's flag — but the interactive command
/// passed `None`, so a video the user started by mistake ran to completion (up
/// to the whole `MEDIA_DOWNLOAD_BUDGET`) with no way to abandon it short of
/// quitting the app. Process-global is right here rather than per-call: there
/// is exactly one interactive download at a time, and the Stop button belongs
/// to whichever one is running.
static MEDIA_CANCEL: AtomicBool = AtomicBool::new(false);

/// Stop the interactive video download that is running now. Idempotent, and
/// harmless when nothing is downloading — the flag is cleared at the start of
/// every download, so a stale Stop can never kill the NEXT one.
#[tauri::command]
pub fn cancel_media_download() {
    MEDIA_CANCEL.store(true, Ordering::SeqCst);
}

/// Arm a fresh download. Separate from the command so the clear-before-start
/// order is a thing a test can hold onto.
fn arm_media_cancel() {
    MEDIA_CANCEL.store(false, Ordering::SeqCst);
}

/// Hard cap on the fetched downloader. The real binary is ~35 MB; this is
/// generous headroom and still stops a misbehaving mirror from filling the
/// disk while the UI says "Getting the video downloader".
const MAX_YTDLP_BYTES: u64 = 200 * 1024 * 1024;

/// …and the floor. A few hundred bytes of HTML error page served with a 200 is
/// the realistic failure, not a truncated executable.
const MIN_YTDLP_BYTES: u64 = 1024 * 1024;

/// How long the whole downloader fetch may take.
const YTDLP_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Is this the head of a macOS executable?
///
/// The binary is fetched from a fixed HTTPS address, marked runnable and run,
/// always at whatever "latest" happens to be — so there is no published digest
/// to pin it against. This is not a signature check and does not pretend to
/// be one; it is the cheap sanity check that catches what actually goes wrong:
/// a captive portal, an error page or a truncated body arriving with a 200 and
/// being chmod +x'd.
fn looks_like_macos_binary(head: &[u8]) -> bool {
    matches!(
        head.get(..4),
        // Mach-O 64/32-bit, and both byte orders of a universal binary —
        // yt-dlp_macos ships as a universal (FAT) binary.
        Some([0xcf, 0xfa, 0xed, 0xfe])
            | Some([0xce, 0xfa, 0xed, 0xfe])
            | Some([0xca, 0xfe, 0xba, 0xbe])
            | Some([0xbe, 0xba, 0xfe, 0xca])
    )
}

/// Progress sink for media downloads: (status, percent). The user path
/// forwards to the `ytdlp-progress` event; the download-job runner forwards to
/// `job-progress` — one engine, two dashboards.
pub(crate) type MediaProgress<'a> = &'a (dyn Fn(&str, Option<f64>) + Sync);

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
    progress: MediaProgress<'_>,
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
        progress("Getting the video downloader (first time only)…", None);
        let part = dest.with_extension("part");
        // A bare `reqwest::get` has no timeout at all: a server that accepts
        // the connection and then goes quiet left the app on "Getting the
        // video downloader…" forever, with no way out.
        let client = reqwest::Client::builder()
            .timeout(YTDLP_FETCH_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(YTDLP_URL)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("downloader fetch failed: {e}"))?;
        if resp.content_length().is_some_and(|len| len > MAX_YTDLP_BYTES) {
            return Err("The video downloader download is implausibly large — refused.".into());
        }
        let total = resp.content_length().unwrap_or(35 * 1024 * 1024);
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut head: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        let oversized = loop {
            let Some(chunk) = stream.next().await else { break false };
            let chunk = chunk.map_err(|e| format!("downloader fetch interrupted: {e}"))?;
            got += chunk.len() as u64;
            if got > MAX_YTDLP_BYTES {
                break true;
            }
            if head.len() < 4 {
                head.extend_from_slice(&chunk[..chunk.len().min(4)]);
            }
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            progress(
                "Getting the video downloader (first time only)…",
                Some((got as f64 / total as f64 * 100.0).min(100.0)),
            );
        };
        drop(file);
        // Every rejection removes the partial file, so the next attempt starts
        // clean rather than inheriting whatever arrived.
        if oversized {
            let _ = std::fs::remove_file(&part);
            return Err("The video downloader download is implausibly large — refused.".into());
        }
        if got < MIN_YTDLP_BYTES || !looks_like_macos_binary(&head) {
            let _ = std::fs::remove_file(&part);
            return Err(
                "What arrived is not the video downloader — the download was refused rather \
                 than run."
                    .into(),
            );
        }
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

/// How often Stop and the overall budget are checked while the downloader is
/// silent. Short enough that Stop feels immediate, long enough to cost nothing.
const CANCEL_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// The longest one media download may run. Generous — a long video on a slow
/// link is a real thing — but a download with NO limit is a job that can never
/// end, and the user's only escape was a Stop button that a stalled downloader
/// never noticed.
const MEDIA_DOWNLOAD_BUDGET: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// How many trailing stderr lines are kept to explain a failure.
const STDERR_TAIL_LINES: usize = 3;

/// A media file staged by yt-dlp: the work dir to sweep and the file inside it.
pub(crate) struct MediaDownload {
    pub(crate) work_dir: std::path::PathBuf,
    pub(crate) path: std::path::PathBuf,
}

/// BROWSE-2: download the media at any yt-dlp-supported URL into a temp work
/// dir. Best pre-muxed MP4, else best single file — no ffmpeg needed.
///
/// D16: yt-dlp is a subprocess doing its own networking, so the SSRF guard
/// cannot pin its connections — it gets a pre-flight instead (literal check +
/// DNS resolve of the target). The redirect residual risk is documented and
/// accepted, same posture the YouTube feature always shipped with.
/// D15: the size cap is enforced on the finished file, before import.
/// `cancel` is polled per progress line and kills the subprocess.
pub(crate) async fn download_media_to_temp(
    app: &tauri::AppHandle,
    url: &str,
    cancel: Option<&AtomicBool>,
    progress: MediaProgress<'_>,
) -> Result<MediaDownload, String> {
    let parsed = crate::web::check_public_http_url(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    crate::web::resolve_public_addr(&host, port).await?;

    let bin = ensure_ytdlp(app, progress).await?;
    let work_dir = std::env::temp_dir().join(format!("arcelle-yt-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    progress("Downloading the video…", Some(0.0));

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
        .arg(url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start the video downloader: {e}"))?;

    // Drain stderr CONCURRENTLY. It used to be read only after the process
    // exited, so a downloader that was noisy enough to fill the 64 KB pipe
    // buffer blocked writing, stopped producing progress lines, and both sides
    // waited on each other forever.
    let stderr_tail = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join(" ")
        })
    });

    // Stop used to be checked only when a progress line ARRIVED, so a stalled
    // download ignored it completely — and nothing bounded the whole thing.
    // Poll on a timer alongside the output, so both are answered while the
    // downloader is silent.
    let started = std::time::Instant::now();
    let mut abandoned: Option<String> = None;
    if let Some(stdout) = child.stdout.take() {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        loop {
            tokio::select! {
                next = lines.next_line() => match next {
                    Ok(Some(line)) => {
                        if let Some(pct) = parse_ytdlp_percent(&line) {
                            progress("Downloading the video…", Some(pct));
                        }
                    }
                    // Closed or unreadable: the process is on its way out.
                    _ => break,
                },
                _ = tokio::time::sleep(CANCEL_POLL) => {}
            }
            if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                abandoned = Some("Stopped.".into());
                break;
            }
            if started.elapsed() > MEDIA_DOWNLOAD_BUDGET {
                abandoned = Some(format!(
                    "The video download gave up after {} minutes — it may be stalled.",
                    MEDIA_DOWNLOAD_BUDGET.as_secs() / 60
                ));
                break;
            }
        }
    }
    if let Some(why) = abandoned {
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(why);
    }
    let status = child
        .wait()
        .await
        .map_err(|e| format!("video download failed: {e}"))?;
    if !status.success() {
        let tail = match stderr_tail {
            Some(task) => task.await.unwrap_or_default(),
            None => String::new(),
        };
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(format!("The download failed: {tail}"));
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

    let size = std::fs::metadata(&downloaded).map(|m| m.len()).unwrap_or(0);
    if size > crate::web::MAX_DOWNLOAD_BYTES {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(format!(
            "The video is {} MB — larger than the {} MB limit for a room file.",
            size / (1024 * 1024),
            crate::web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ));
    }
    Ok(MediaDownload { work_dir, path: downloaded })
}

/// Download a YouTube video into the room. Fetches yt-dlp on first use, saves
/// the best single-file MP4 to a private temp folder, imports it through the
/// download funnel (so preview + background transcription just happen, and the
/// file keeps its origin URL), then removes the temp copy.
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
    import_media_url(app, window, state, url).await
}

/// BROWSE-2: the same download for ANY yt-dlp-supported site — what the
/// toolbar's "Download video" and the Add-link modal's non-YouTube video
/// option call. yt-dlp failing on an unsupported site surfaces truthfully.
#[tauri::command]
pub async fn import_media_url(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    url: String,
) -> Result<ImportReport, String> {
    let url = url.trim().to_string();
    // Fail fast (and don't fetch anything) when no room is open — or when the
    // room's internet switch is off. Downloading a video is as much a network
    // reach as the browser's address bar, which has been gated since BROWSE-1.
    crate::commands::require_web_access(state.inner())?;
    // Clear FIRST: a Stop pressed against a download that already ended must
    // not cancel the next one before it has fetched a byte.
    arm_media_cancel();
    let progress = |status: &str, pct: Option<f64>| emit_progress(&window, status, pct);
    let media = download_media_to_temp(&app, &url, Some(&MEDIA_CANCEL), &progress).await?;

    emit_progress(&window, "Sealing the video into the room…", None);
    let name = media
        .path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video.mp4".to_string());
    let imported = import_download(&app, &media.path, &name, &url);
    let _ = std::fs::remove_dir_all(&media.work_dir);
    emit_progress(&window, "Done", Some(100.0));
    match imported {
        Ok(meta) => Ok(ImportReport { imported: vec![meta], errors: vec![] }),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_is_armed_per_download_not_left_latched() {
        // The interactive download used to pass `None` for its cancel flag, so
        // "Video from this page" could not be abandoned at all. Now it passes
        // one — and the flag MUST be cleared as each download starts, or a Stop
        // pressed a moment too late would kill the next download instead.
        arm_media_cancel();
        assert!(!MEDIA_CANCEL.load(Ordering::SeqCst));
        cancel_media_download();
        assert!(MEDIA_CANCEL.load(Ordering::SeqCst), "Stop must set the flag");
        arm_media_cancel();
        assert!(
            !MEDIA_CANCEL.load(Ordering::SeqCst),
            "a stale Stop must not cancel the next download"
        );
    }

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

    /// The downloader is fetched, chmod +x'd and RUN. It cannot be pinned to a
    /// digest (the URL is "latest"), but what actually arrives when the fetch
    /// goes wrong is a page of HTML with a 200 on it — and that must not be
    /// made executable.
    #[test]
    fn only_something_shaped_like_a_mac_binary_is_accepted() {
        // Mach-O 64-bit, and both byte orders of a universal binary.
        assert!(looks_like_macos_binary(&[0xcf, 0xfa, 0xed, 0xfe, 0x07]));
        assert!(looks_like_macos_binary(&[0xce, 0xfa, 0xed, 0xfe]));
        assert!(looks_like_macos_binary(&[0xca, 0xfe, 0xba, 0xbe]));
        assert!(looks_like_macos_binary(&[0xbe, 0xba, 0xfe, 0xca]));
        // An error page, a zip, a truncated body, nothing at all.
        assert!(!looks_like_macos_binary(b"<!DOCTYPE html>"));
        assert!(!looks_like_macos_binary(b"PK\x03\x04"));
        assert!(!looks_like_macos_binary(&[0xcf, 0xfa]));
        assert!(!looks_like_macos_binary(&[]));
    }

    /// A download with no ceiling is a job that can never end, and the Stop
    /// button was only noticed when a progress line happened to arrive.
    #[test]
    fn a_media_download_is_bounded_and_stop_is_polled_while_it_is_silent() {
        assert!(MEDIA_DOWNLOAD_BUDGET.as_secs() > 0);
        assert!(
            CANCEL_POLL < std::time::Duration::from_secs(1),
            "Stop must feel immediate, not wait on the downloader's output"
        );
        assert!(CANCEL_POLL < MEDIA_DOWNLOAD_BUDGET);
        assert!(MIN_YTDLP_BYTES < MAX_YTDLP_BYTES);
    }
}
