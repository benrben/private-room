use super::*;

/// ADD-26 → BROWSE-2: media downloads through yt-dlp. "Save the video too" for
/// YouTube links stays the user-facing default; the same engine now serves ANY
/// yt-dlp-supported site through [`download_media_to_temp`] — the toolbar's
/// Download video, the Add-link modal, and the agent's `download_media` job all
/// ride it. The captions-only import (ADD-19) remains the cheap path.
///
/// The yt-dlp binary is NOT bundled: it downloads on first use to the app's
/// data dir (the Whisper-model doctrine — nothing else to install, nothing
/// GPL-linked rides in the DMG) and keeps ITSELF fresh: YouTube rotates its
/// player scheme every few weeks and a stale yt-dlp starts failing every
/// download with `HTTP Error 403` (seen 2026-08-21, binary from July), so a
/// copy older than [`YTDLP_STALE_AFTER`] runs its own `-U` before the next
/// download. Both the binary fetch and the video download are labeled
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

/// After this long the installed downloader is treated as stale and asked to
/// update itself. YouTube's player rotation breaks old extractors on roughly
/// a monthly cadence; well under that keeps downloads working between waves.
const YTDLP_STALE_AFTER: std::time::Duration =
    std::time::Duration::from_secs(14 * 24 * 60 * 60);

/// How long the self-update may take before the download proceeds with the
/// old binary anyway (an update is ~38 MB from GitHub).
const YTDLP_UPDATE_BUDGET: std::time::Duration = std::time::Duration::from_secs(180);

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
        refresh_ytdlp_if_stale(&dest, progress).await;
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

/// The download's TOTAL size out of the same progress line — `42.7% of
/// 871.20MiB` (or `of ~ 871.20MiB`, HLS totals are estimates). The first
/// progress line announces where the download is headed, so a video the room
/// will refuse anyway ([`web::MAX_DOWNLOAD_BYTES`]) is stopped in its first
/// second, not after the hour it takes to arrive.
pub(crate) fn parse_ytdlp_total_bytes(line: &str) -> Option<u64> {
    let line = line.trim();
    if !line.starts_with("[download]") {
        return None;
    }
    let mut toks = line.split_whitespace().peekable();
    while let Some(tok) = toks.next() {
        if tok != "of" {
            continue;
        }
        // `of ~ 871.20MiB` and `of ~871.20MiB` both occur.
        let size = match toks.peek() {
            Some(&"~") => {
                toks.next();
                toks.next()?
            }
            Some(_) => toks.next()?,
            None => return None,
        };
        let size = size.trim_start_matches('~');
        let unit_at = size.find(|c: char| c.is_ascii_alphabetic())?;
        let (num, unit) = size.split_at(unit_at);
        let scale: u64 = match unit {
            "B" => 1,
            "KiB" => 1024,
            "MiB" => 1024 * 1024,
            "GiB" => 1024 * 1024 * 1024,
            _ => return None,
        };
        return num.parse::<f64>().ok().map(|n| (n * scale as f64) as u64);
    }
    None
}

/// How often Stop and the overall budget are checked while the downloader is
/// silent. Short enough that Stop feels immediate, long enough to cost nothing.
const CANCEL_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// The longest one media download may run. Generous — a long video on a slow
/// link is a real thing — but a download with NO limit is a job that can never
/// end, and the user's only escape was a Stop button that a stalled downloader
/// never noticed.
const MEDIA_DOWNLOAD_BUDGET: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Let a downloader older than [`YTDLP_STALE_AFTER`] update itself before it
/// is used. Best-effort on purpose: offline, GitHub down, or over budget all
/// leave the old binary in place — it is still worth trying, and the download
/// that follows will say so truthfully if it isn't.
async fn refresh_ytdlp_if_stale(dest: &std::path::Path, progress: MediaProgress<'_>) {
    let stale = std::fs::metadata(dest)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > YTDLP_STALE_AFTER);
    if !stale {
        return;
    }
    // The first-install guard doubles as the update guard; contended means
    // someone else is already refreshing, and the current binary still works.
    if YTDLP_DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    progress("Updating the video downloader…", None);
    // kill_on_drop: an over-budget update is abandoned, not left running —
    // yt-dlp replaces itself atomically at the end, so a kill mid-fetch just
    // keeps the old binary.
    let update = tokio::process::Command::new(dest)
        .arg("-U")
        .kill_on_drop(true)
        .output();
    if let Ok(Ok(out)) = tokio::time::timeout(YTDLP_UPDATE_BUDGET, update).await {
        if out.status.success() {
            // "Already up to date" leaves the file (and its mtime) untouched,
            // which would re-run this check on every download for the rest of
            // the release gap — mark the check done either way.
            let _ = std::fs::File::options()
                .write(true)
                .open(dest)
                .and_then(|f| f.set_modified(std::time::SystemTime::now()));
        }
    }
    YTDLP_DOWNLOADING.store(false, Ordering::SeqCst);
}

/// How many trailing stderr lines are kept to explain a failure.
const STDERR_TAIL_LINES: usize = 3;

/// A system ffmpeg, if this Mac has one. The app's no-ffmpeg doctrine is about
/// BUNDLING (nothing to sign or notarize, media_probe.rs) — it has never
/// forbidden using an ffmpeg the owner already installed. The explicit paths
/// come first because a GUI app's PATH is the bare system one: Homebrew,
/// Intel-Homebrew and MacPorts don't appear in it.
fn find_ffmpeg() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec![
        "/opt/homebrew/bin/ffmpeg".into(),
        "/usr/local/bin/ffmpeg".into(),
        "/opt/local/bin/ffmpeg".into(),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("ffmpeg")));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Which formats to ask yt-dlp for. YouTube increasingly serves ONLY separate
/// video and audio streams (no pre-muxed file at all — first seen 2026-08-21),
/// and joining them needs ffmpeg. Without one, the merge branches must not be
/// OFFERED: yt-dlp would pick them anyway and leave two unmerged files behind.
///
/// The merge branches prefer h264 (`avc1`): AVFoundation — the app's playback
/// and probe stack — does not decode the VP9 that yt-dlp's plain "best" picks,
/// so best-by-bitrate would import a video the room can't play. No automatic
/// size preference on purpose (owner call, 2026-08-22): quality is never
/// traded away to fit a limit — the RESOLUTION is the user's to pick
/// (`max_height`, from the modal's quality chips), and their pick leads the
/// chain with unconstrained fallbacks behind it, so a stale choice degrades
/// to "best available" instead of failing.
fn format_selector(has_ffmpeg: bool, max_height: Option<u32>) -> String {
    let free: String = if has_ffmpeg {
        "b[ext=mp4]/bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b/bv*+ba".into()
    } else {
        "b[ext=mp4]/b".into()
    };
    let Some(h) = max_height else {
        return free;
    };
    let capped = if has_ffmpeg {
        format!(
            "b[ext=mp4][height<={h}]\
             /bv*[vcodec^=avc1][height<={h}]+ba[ext=m4a]\
             /bv*[ext=mp4][height<={h}]+ba[ext=m4a]\
             /b[height<={h}]/bv*[height<={h}]+ba"
        )
    } else {
        format!("b[ext=mp4][height<={h}]/b[height<={h}]")
    };
    format!("{capped}/{free}")
}

/// How long the quality probe (`-j`, metadata only) may take.
const FORMAT_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

/// One quality the user can pick before a video download: a resolution, what
/// it roughly costs on disk, and whether the room can store it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub height: u32,
    /// Estimated finished size (video + audio) when the site states one —
    /// None is shown as "size unknown", never a made-up number.
    pub approx_bytes: Option<u64>,
    /// Whether that estimate fits the room-file cap. An UNKNOWN size is
    /// offered as fitting: refusing on a guess would be a false claim, and
    /// the download itself still enforces the real limit.
    pub fits: bool,
}

/// The qualities a video actually offers, for the modal's picker. Same web
/// gating and SSRF pre-flight as the download itself — a metadata probe is
/// still an outbound reach.
#[tauri::command]
pub async fn list_media_formats(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    url: String,
) -> Result<Vec<QualityOption>, String> {
    crate::commands::require_web_access(state.inner())?;
    let url = url.trim().to_string();
    let parsed = crate::web::check_public_http_url(&url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    crate::web::resolve_public_addr(&host, port).await?;

    let progress = |status: &str, pct: Option<f64>| emit_progress(&window, status, pct);
    let bin = ensure_ytdlp(&app, &progress).await?;
    // `-j`: the video's whole info dict as one JSON line, nothing downloaded.
    let probe = tokio::process::Command::new(&bin)
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("-j")
        .arg(&url)
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(FORMAT_PROBE_BUDGET, probe)
        .await
        .map_err(|_| "Looking up this video's qualities took too long.".to_string())?
        .map_err(|e| format!("couldn't start the video downloader: {e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail = tail.lines().rev().take(STDERR_TAIL_LINES).collect::<Vec<_>>();
        return Err(format!(
            "Couldn't look up this video's qualities: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" ")
        ));
    }
    let info: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| "The site's answer about this video made no sense.".to_string())?;
    Ok(quality_options(&info, find_ffmpeg().is_some()))
}

/// Fold yt-dlp's `formats` array into the height choices the picker offers,
/// best first. Without ffmpeg only pre-muxed formats are downloadable, so
/// only their heights are offered — a choice the downloader can't honor is
/// worse than a short list. Sizes mirror what the downloader will pick at
/// that height (best h264 video plus the audio track).
fn quality_options(info: &serde_json::Value, has_ffmpeg: bool) -> Vec<QualityOption> {
    let Some(formats) = info.get("formats").and_then(|f| f.as_array()) else {
        return Vec::new();
    };
    let size_of = |f: &serde_json::Value| -> Option<u64> {
        f.get("filesize")
            .and_then(|v| v.as_u64())
            .or_else(|| f.get("filesize_approx").and_then(|v| v.as_u64()))
    };
    let has = |f: &serde_json::Value, key: &str| -> bool {
        f.get(key).and_then(|v| v.as_str()).is_some_and(|v| v != "none")
    };
    // The audio that rides along with a merged pick: the largest stated
    // audio-only size, so the estimate errs honest (never under).
    let audio_bytes = formats
        .iter()
        .filter(|f| !has(f, "vcodec") && has(f, "acodec"))
        .filter_map(size_of)
        .max();
    // height → (pre-muxed size, avc1 video-only size, any video-only size).
    // A pre-muxed file already CARRIES its audio; only a video-only pick
    // pays for the audio track on top.
    #[derive(Default)]
    struct Heights {
        premuxed: Option<u64>,
        avc_only: Option<u64>,
        any_only: Option<u64>,
    }
    let mut by_height: std::collections::BTreeMap<u32, Heights> = std::collections::BTreeMap::new();
    for f in formats {
        if !has(f, "vcodec") {
            continue;
        }
        let premuxed = has(f, "acodec");
        if !has_ffmpeg && !premuxed {
            continue;
        }
        let Some(height) = f.get("height").and_then(|v| v.as_u64()).filter(|h| *h > 0) else {
            continue;
        };
        let entry = by_height.entry(height as u32).or_default();
        let size = size_of(f);
        let is_avc = f
            .get("vcodec")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.starts_with("avc"));
        if premuxed {
            entry.premuxed = entry.premuxed.max(size);
        } else if is_avc {
            entry.avc_only = entry.avc_only.max(size);
        } else {
            entry.any_only = entry.any_only.max(size);
        }
    }
    by_height
        .into_iter()
        .rev()
        .map(|(height, h)| {
            let approx = h
                .premuxed
                .or_else(|| {
                    h.avc_only
                        .or(h.any_only)
                        .map(|v| v + audio_bytes.unwrap_or(0))
                })
                .filter(|b| *b > 0);
            QualityOption {
                height,
                approx_bytes: approx,
                fits: approx.is_none_or(|b| b <= crate::web::MAX_DOWNLOAD_BYTES),
            }
        })
        .collect()
}

/// The user-facing failure. The one failure shape the user can actually do
/// something about — split-stream-only media on a machine with no ffmpeg —
/// says what to do; everything else surfaces yt-dlp's own words.
fn explain_download_failure(stderr_tail: &str, has_ffmpeg: bool) -> String {
    let mut msg = format!("The download failed: {stderr_tail}");
    if !has_ffmpeg && stderr_tail.contains("Requested format is not available") {
        msg.push_str(
            " This video is only offered as separate picture and sound streams, \
             and joining them needs ffmpeg — install it (brew install ffmpeg) \
             and try again.",
        );
    }
    msg
}

/// A media file staged by yt-dlp: the work dir to sweep and the file inside it.
pub(crate) struct MediaDownload {
    pub(crate) work_dir: std::path::PathBuf,
    pub(crate) path: std::path::PathBuf,
}

/// BROWSE-2: download the media at any yt-dlp-supported URL into a temp work
/// dir. Format choice is [`format_selector`]'s: pre-muxed first, split
/// streams joined by a system ffmpeg when the machine has one.
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
    max_height: Option<u32>,
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

    // Title is byte-clamped so the filename can't overflow macOS limits.
    let output = work_dir.join("%(title).100B.%(ext)s");
    let ffmpeg = find_ffmpeg();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--no-playlist")
        .arg("--newline")
        .arg("--no-warnings")
        .arg("-f")
        .arg(format_selector(ffmpeg.is_some(), max_height))
        .arg("-o")
        .arg(&output);
    if let Some(ff) = &ffmpeg {
        cmd.arg("--ffmpeg-location").arg(ff);
    }
    let mut child = cmd
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
                        // A file the room will refuse is abandoned on the
                        // FIRST progress line, not after it fully arrives —
                        // same truthful refusal, an hour earlier.
                        if let Some(total) = parse_ytdlp_total_bytes(&line) {
                            if total > crate::web::MAX_DOWNLOAD_BYTES {
                                abandoned = Some(format!(
                                    "This video is about {} MB — larger than the {} MB \
                                     limit for a room file. Stopped before downloading it.",
                                    total / (1024 * 1024),
                                    crate::web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
                                ));
                                break;
                            }
                        }
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
        return Err(explain_download_failure(&tail, ffmpeg.is_some()));
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
/// the best MP4 it can get to a private temp folder, imports it through the
/// download funnel (so preview + background transcription just happen, and the
/// file keeps its origin URL), then removes the temp copy.
#[tauri::command]
pub async fn import_youtube_video(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    url: String,
    max_height: Option<u32>,
) -> Result<ImportReport, String> {
    let url = url.trim().to_string();
    if web::youtube_video_id(&url).is_none() {
        return Err("That doesn't look like a YouTube video link.".into());
    }
    import_media_url(app, window, state, url, max_height).await
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
    max_height: Option<u32>,
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
    let media =
        download_media_to_temp(&app, &url, max_height, Some(&MEDIA_CANCEL), &progress).await?;

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

    /// YouTube serves many videos ONLY as separate picture and sound streams
    /// now. Joining them needs ffmpeg, so the merge branches may be offered
    /// exactly when one exists — offered without one, yt-dlp picks them anyway
    /// and leaves two half-files behind; withheld with one, "Requested format
    /// is not available" comes back for a video we could have downloaded.
    #[test]
    fn merge_formats_are_offered_exactly_when_ffmpeg_exists() {
        for height in [None, Some(720)] {
            assert!(
                !format_selector(false, height).contains('+'),
                "no ffmpeg, no merging"
            );
            assert!(
                format_selector(true, height).contains('+'),
                "ffmpeg unlocks split streams"
            );
        }
        for selector in [format_selector(false, None), format_selector(true, None)] {
            assert!(
                selector.starts_with("b[ext=mp4]/"),
                "a pre-muxed MP4 needs no merge work and must stay first: {selector}"
            );
        }
    }

    /// The user's chosen resolution must LEAD the chain — and must not be able
    /// to fail a download the old chain could do: unconstrained fallbacks
    /// follow, so a quality that vanished between probe and download degrades
    /// to best-available instead of erroring.
    #[test]
    fn a_chosen_height_leads_and_never_strands_the_download() {
        for has_ffmpeg in [true, false] {
            let capped = format_selector(has_ffmpeg, Some(480));
            let free = format_selector(has_ffmpeg, None);
            assert!(capped.starts_with("b[ext=mp4][height<=480]"), "{capped}");
            assert!(
                capped.ends_with(&free),
                "the uncapped chain must remain as fallback: {capped}"
            );
        }
    }

    /// The picker's list is built from yt-dlp's formats array. Heights fold
    /// together across protocols, sizes mirror the h264 pick the downloader
    /// will make (plus audio), and without ffmpeg only pre-muxed entries are
    /// offered — a chip the downloader can't honor is a lie.
    #[test]
    fn quality_options_fold_heights_honestly() {
        let info = serde_json::json!({ "formats": [
            { "format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2",
              "filesize": 50_000_000u64 },
            { "format_id": "136", "vcodec": "avc1.64001f", "acodec": "none",
              "height": 720, "filesize": 400_000_000u64 },
            { "format_id": "247", "vcodec": "vp9", "acodec": "none",
              "height": 720, "filesize": 300_000_000u64 },
            { "format_id": "137", "vcodec": "avc1.640028", "acodec": "none",
              "height": 1080, "filesize_approx": 900_000_000u64 },
            { "format_id": "18", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2",
              "height": 360, "filesize": 80_000_000u64 },
            { "format_id": "sb0", "vcodec": "none", "acodec": "none" },
        ]});
        let with_ffmpeg = quality_options(&info, true);
        assert_eq!(
            with_ffmpeg.iter().map(|q| q.height).collect::<Vec<_>>(),
            vec![1080, 720, 360],
            "best first, heights deduped"
        );
        // 1080p: 900 MB video + 50 MB audio = 950 MB — over the 900 MB cap.
        assert_eq!(with_ffmpeg[0].approx_bytes, Some(950_000_000));
        assert!(!with_ffmpeg[0].fits);
        // 720p: the h264 size (400 MB), not vp9's smaller 300 MB — the
        // downloader will pick h264, and the estimate must match its pick.
        assert_eq!(with_ffmpeg[1].approx_bytes, Some(450_000_000));
        assert!(with_ffmpeg[1].fits);
        // 360p is pre-muxed: its size already carries the audio — no add.
        assert_eq!(with_ffmpeg[2].approx_bytes, Some(80_000_000));
        // Without ffmpeg only the pre-muxed 360p is downloadable.
        let without = quality_options(&info, false);
        assert_eq!(without.iter().map(|q| q.height).collect::<Vec<_>>(), vec![360]);
        assert_eq!(without[0].approx_bytes, Some(80_000_000));
        // No formats at all → an empty list, not a panic.
        assert!(quality_options(&serde_json::json!({}), true).is_empty());
    }

    /// The one failure the user can fix themselves must say how; every other
    /// failure keeps yt-dlp's own words, unembellished.
    #[test]
    fn a_split_stream_failure_without_ffmpeg_says_what_to_install() {
        let format_err = "ERROR: [youtube] abc: Requested format is not available.";
        assert!(explain_download_failure(format_err, false).contains("brew install ffmpeg"));
        // With ffmpeg present that error means something else — don't prescribe.
        assert!(!explain_download_failure(format_err, true).contains("ffmpeg"));
        let other = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
        let explained = explain_download_failure(other, false);
        assert!(explained.contains(other) && !explained.contains("brew"));
    }

    /// The size a download is headed for rides its progress lines; a video
    /// over the room-file limit must be recognized there so it is refused in
    /// its first second, not after it fully arrives. Lines that merely
    /// contain "of" (fragment counters, retry counters) must never parse as
    /// a size — a false positive aborts a legitimate download.
    #[test]
    fn the_total_size_is_read_from_progress_lines_and_noise_never_aborts() {
        let mib = 1024 * 1024;
        assert_eq!(
            parse_ytdlp_total_bytes("[download]  42.7% of 12.3MiB at 1.2MiB/s"),
            Some((12.3f64 * mib as f64) as u64)
        );
        // HLS totals arrive as estimates, both spellings.
        assert_eq!(
            parse_ytdlp_total_bytes("[download]   0.1% of ~ 871.20MiB at 11.33MiB/s"),
            Some((871.2f64 * mib as f64) as u64)
        );
        assert_eq!(
            parse_ytdlp_total_bytes("[download]   0.1% of ~4.71GiB at 1MiB/s"),
            Some((4.71f64 * 1024.0 * mib as f64) as u64)
        );
        assert_eq!(
            parse_ytdlp_total_bytes("[download] 100% of 246.27KiB in 00:00:00"),
            Some((246.27f64 * 1024.0) as u64)
        );
        assert_eq!(
            parse_ytdlp_total_bytes("[download] Downloading fragment 1 of 100"),
            None
        );
        assert_eq!(
            parse_ytdlp_total_bytes("[download] Got error. Retrying (attempt 1 of 3)..."),
            None
        );
        assert_eq!(parse_ytdlp_total_bytes("[youtube] abc: Downloading webpage"), None);
        assert_eq!(parse_ytdlp_total_bytes(""), None);
    }

    /// The self-update exists because a July binary met August's YouTube with
    /// a 403 on every video. Stale must come WELL before the observed monthly
    /// breakage cadence, and the update budget must stay a pause, not a hang.
    #[test]
    fn the_downloader_goes_stale_before_youtube_breaks_it() {
        assert!(YTDLP_STALE_AFTER <= std::time::Duration::from_secs(21 * 24 * 60 * 60));
        assert!(YTDLP_STALE_AFTER >= std::time::Duration::from_secs(24 * 60 * 60));
        assert!(YTDLP_UPDATE_BUDGET < MEDIA_DOWNLOAD_BUDGET);
    }
}
