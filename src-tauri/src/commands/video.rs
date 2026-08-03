//! Video as a thing you can WORK ON, not only play: read what the container
//! actually says, cut a span out of it, and keep a still from it.
//!
//! All three lean on the media stack the Mac already has —
//! [`crate::media_probe`] for the facts and `/usr/bin/avconvert` for the cut,
//! the same binary `stt::decode_to_pcm` already pulls audio tracks with. There
//! is no ffmpeg in this app to fall back to, so when a tool is missing the
//! command says so in plain language instead of pretending it did the work.
//!
//! PRIVACY NOTE (same bargain as `quicklook.rs` and `stt::decode_bytes_to_pcm`,
//! and it is a real cost): avconvert takes FILE paths, so trimming writes the
//! decrypted source and the decrypted result to owner-only temp files for the
//! length of the cut. Both are removed on every exit path, including the error
//! ones. `commands/media.rs` promises staged playback bytes never touch the
//! disk; that promise is about playback and still holds — this is the export
//! path, and the alternative is not "no temp file", it is "no trim at all".

use super::*;
use crate::media_probe::{self, MediaMeta};
use std::path::Path;

/// A clip shorter than this is not a cut, it is a mistake — avconvert will
/// happily emit a zero-frame file, and a room full of empty videos is worse
/// than a refused button.
const MIN_TRIM_SECS: f64 = 0.1;

/// Where the trimmed span must sit for the cut to mean anything.
///
/// `duration` is what the probe read, or None when the container never said.
/// An unknown duration is NOT a reason to refuse: it only removes the upper
/// bound, and avconvert still fails honestly if the span runs off the end.
fn validate_span(start: f64, end: f64, duration: Option<f64>) -> Result<(f64, f64), String> {
    if !start.is_finite() || !end.is_finite() {
        return Err("The trim points aren't real numbers.".into());
    }
    if start < 0.0 {
        return Err("A trim can't start before the beginning of the video.".into());
    }
    if end - start < MIN_TRIM_SECS {
        return Err(format!(
            "That span is too short to trim — the end has to be at least {MIN_TRIM_SECS}s after the start."
        ));
    }
    if let Some(d) = duration {
        if start >= d {
            return Err(format!(
                "The trim starts at {start:.1}s but the video is only {d:.1}s long."
            ));
        }
        // A tail that overruns is the normal "drag to the end" case: clamp it
        // rather than refusing, because the user's intent is unambiguous.
        return Ok((start, end.min(d)));
    }
    Ok((start, end))
}

/// Seconds → the "1-23" form used inside a file name. Colons are legal in a
/// room file name but read as a path separator to the Finder the moment the
/// file is exported, so the stamp uses hyphens.
fn stamp_for_name(secs: f64) -> String {
    let s = secs.max(0.0).round() as u64;
    if s >= 3600 {
        format!("{}-{:02}-{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{}-{:02}", s / 60, s % 60)
    }
}

/// A file name split into its stem and its extension, KEEPING the extension's
/// own case.
///
/// Not `extraction::extension_of`: that lowercases, and stripping a lowercased
/// suffix off the real name silently fails to match. Every camera and phone
/// writes `IMG_0042.MOV`, so that miss is the common case, not the exotic one —
/// it produced `IMG_0042.MOV (trim 0-00 to 0-05).mov`, with the original
/// extension left sitting in the middle of the name.
fn split_name(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        // A leading dot is not an extension: ".hidden" is the whole name.
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

/// `talk.mp4` + 7.3s–19.0s → `talk (trim 0-07 to 0-19).mp4`. The span is IN the
/// name because a room can hold several trims of one video and "talk
/// (trimmed).mp4" three times over says nothing about which is which.
fn trimmed_name(name: &str, start: f64, end: f64) -> String {
    let (stem, ext) = split_name(name);
    let (a, b) = (stamp_for_name(start), stamp_for_name(end));
    if ext.is_empty() {
        format!("{stem} (trim {a} to {b})")
    } else {
        format!("{stem} (trim {a} to {b}).{ext}")
    }
}

/// `talk.mp4` at 83.4s → `talk @ 1-23.png`.
fn frame_name(name: &str, secs: f64) -> String {
    let (stem, _) = split_name(name);
    format!("{stem} @ {}.png", stamp_for_name(secs))
}

/// What went wrong with the cut, said in a sentence.
///
/// The `NotFound` branch is the one that matters: `avconvert` ships with macOS
/// and this app bundles no media tools of its own, so if it is gone there is
/// nothing to silently fall back to. Saying "trimmed" there would be the exact
/// unevidenced success this codebase exists not to write.
fn describe_convert_error(err: &str) -> String {
    if err.contains("NotFound") || err.contains("No such file or directory") {
        return "This Mac has no /usr/bin/avconvert, which is the tool that cuts video here — \
                nothing was trimmed."
            .into();
    }
    format!("The video couldn't be trimmed: {err}")
}

/// Cut `[start, end)` out of `src` into `dst` with the OS's own converter.
///
/// `PresetPassthrough` copies the encoded samples: no re-encode, no generation
/// loss, seconds rather than minutes, and a non-keyframe start is handled by
/// avconvert itself. A container it refuses to pass through falls back to a
/// real re-encode; both failing is an error, never a quiet success.
fn run_avconvert(src: &Path, dst: &Path, start: f64, dur: f64) -> Result<(), String> {
    let mut last = String::new();
    for preset in ["PresetPassthrough", "PresetHighestQuality"] {
        let out = std::process::Command::new("/usr/bin/avconvert")
            .args(["-p", preset, "-s"])
            .arg(src)
            .arg("-o")
            .arg(dst)
            .args([
                "--start",
                &format!("{start}"),
                "--duration",
                &format!("{dur}"),
                "--replace",
            ])
            .output()
            .map_err(|e| describe_convert_error(&format!("{e:?}")))?;
        if out.status.success() && dst.exists() {
            return Ok(());
        }
        last = String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(300)
            .collect::<String>()
            .trim()
            .to_string();
        if last.is_empty() {
            last = format!("{preset} exited with {}", out.status);
        }
    }
    Err(describe_convert_error(&last))
}

/// Owner-only from creation — a decrypted copy must never exist world-readable,
/// not even for the instant between `create` and `chmod`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

/// Read one media file's bytes out of the room and RELEASE the lock. Every
/// operation below shells out or re-encodes, and holding the room mutex across
/// that froze files, chat and search for the duration (the reason
/// `rec_export_clean` is written the same way).
fn take_media_bytes(
    state: &AppState,
    id: &str,
) -> Result<(String, String, String, Vec<u8>, String, u64), String> {
    let epoch = state.room_epoch();
    state.with_room(|room| {
        let (name, mime, bytes, _text) = db::get_file_full(&room.conn, id)?;
        let mime = mime.unwrap_or_default();
        let ext = extraction::extension_of(&name);
        if stt::media_kind(&mime, &ext) != Some(stt::MediaKind::Video) {
            return Err("This file isn't a video.".into());
        }
        let bytes = bytes.unwrap_or_default();
        if bytes.is_empty() {
            return Err("This video has no stored bytes.".into());
        }
        Ok((name, mime, ext, bytes, room.path.clone(), epoch))
    })
}

// ------------------------------------------------------------------ probe

/// What this video actually is — duration, display size, codec, frame rate,
/// audio track — read from the container itself.
///
/// Cached in `files.media_meta` after the first read, so opening the same video
/// again costs one SELECT. Returns `None` when the OS would not open the file
/// as media or opened it and could say nothing: the viewer then shows the
/// fields as unknown rather than inventing them.
///
/// Deliberately ONE FILE AT A TIME rather than a room-wide backfill pass: the
/// per-file blob ceiling is ~1 GB, and a pass that selected every video's bytes
/// at once (the shape `files_missing_text` uses for documents) would be an
/// out-of-memory bug on a room full of video.
#[tauri::command]
pub async fn probe_video_meta(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<MediaMeta>, String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    if let Some(json) = state.with_room(|room| Ok(db::get_media_meta(&room.conn, &id)))? {
        // A stored value this app can no longer parse is not an answer; fall
        // through and probe again rather than handing the viewer a shape it
        // will render as blanks.
        if let Ok(meta) = serde_json::from_str::<MediaMeta>(&json) {
            return Ok(Some(meta));
        }
    }
    let (_name, _mime, ext, bytes, room_path, epoch) = take_media_bytes(&state, &id)?;

    // AVAsset's accessors load synchronously; this must not run on the main
    // thread (the same note `quicklook.rs` makes about its own blocking call).
    let probed = tauri::async_runtime::spawn_blocking(move || media_probe::probe_bytes(&bytes, &ext))
        .await
        .map_err(|e| format!("The video couldn't be examined: {e}"))?;

    let Some(meta) = probed else {
        return Ok(None);
    };
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    // Wave 3 (Idea 9): the room may have been closed or rolled back while the
    // probe ran — writing then would land this in a different room.
    let _ = state.with_room(|room| {
        if room.path == room_path && state.room_epoch() == epoch {
            db::set_media_meta(&room.conn, &id, &json)?;
        }
        Ok(())
    });
    Ok(Some(meta))
}

// ------------------------------------------------------------------- trim

/// Cut `[start_secs, end_secs)` out of a video into a NEW room file.
///
/// The original is never touched: this is the `rec_export_clean` bargain for
/// video — read under the lock, work with the lock released, insert a sibling
/// file, tell the UI. The clip carries NO transcript of its own (the parent's
/// "[m:ss]" stamps would all be off by `start_secs`, and the AI would quote
/// them back with confident times that seek to the wrong moment), so it is
/// queued on the transcriber lane like any freshly imported video —
/// `db::insert_file` enqueues nothing by itself.
///
/// It also gets NO `recordings` row: `get_file_content` treats that row as the
/// live-recording marker, and an MP4 with one opens in the recording studio,
/// which tries to parse it as a WAV.
#[tauri::command]
pub async fn video_trim(
    app: tauri::AppHandle,
    id: String,
    start_secs: f64,
    end_secs: f64,
) -> Result<FileMeta, String> {
    use tauri::{Emitter, Manager};
    let state = app.state::<AppState>();
    let (name, mime, ext, bytes, room_path, epoch) = take_media_bytes(&state, &id)?;
    let known_duration = state
        .with_room(|room| Ok(db::get_media_meta(&room.conn, &id)))?
        .and_then(|j| serde_json::from_str::<MediaMeta>(&j).ok())
        .and_then(|m| m.duration_secs);
    let (start, end) = validate_span(start_secs, end_secs, known_duration)?;

    let new_name = trimmed_name(&name, start, end);
    let cut_ext = ext.clone();
    let (clip, clip_meta) = tauri::async_runtime::spawn_blocking(move || {
        let stamp = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir();
        let suffix = if cut_ext.is_empty() { "mp4".to_string() } else { cut_ext };
        let src = dir.join(format!("arcelle-trim-in-{stamp}.{suffix}"));
        let dst = dir.join(format!("arcelle-trim-out-{stamp}.{suffix}"));
        write_private(&src, &bytes).map_err(|e| format!("The video couldn't be staged: {e}"))?;
        drop(bytes);

        let result = run_avconvert(&src, &dst, start, end - start).and_then(|()| {
            // The clip's own metadata is free here: it is already a file on
            // disk, so probing it costs no second temp copy.
            let meta = media_probe::probe_path(&dst);
            std::fs::read(&dst)
                .map_err(|e| format!("The trimmed video couldn't be read back: {e}"))
                .map(|b| (b, meta))
        });
        // Always, on every path — neither the source nor the result may
        // outlive the call as plaintext.
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        result
    })
    .await
    .map_err(|e| format!("The trim could not be started: {e}"))??;

    if clip.is_empty() {
        return Err("The trim produced an empty file — nothing was saved.".into());
    }
    if clip.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "The trimmed clip is {} MB — larger than the {} MB limit for a room file.",
            clip.len() as u64 / (1024 * 1024),
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }

    let meta_json = clip_meta
        .filter(|m| !m.is_empty())
        .and_then(|m| serde_json::to_string(&m).ok());
    let file = state.with_room(|room| {
        if room.path != room_path || state.room_epoch() != epoch {
            return Err("The room changed while the video was being trimmed — nothing was saved.".into());
        }
        // Several trims of one video are a normal thing to want, and three
        // files called "talk (trim …).mp4" are impossible to tell apart.
        let new_name = db::available_name(&room.conn, &new_name)?;
        let file = db::insert_file(&room.conn, &new_name, &mime, &clip, None, "generated")?;
        if let Some(json) = &meta_json {
            db::set_media_meta(&room.conn, &file.id, json)?;
        }
        Ok(file)
    })?;
    let _ = app.emit("room-files-changed", ());

    // `file.name`, not the name we asked for: `available_name` may have
    // disambiguated it, and the viewer keys transcription progress by the name
    // the room actually stored.
    enqueue_stt(
        &app,
        JobMeta { id: file.id.clone(), name: file.name.clone(), mime, ext, room_path, epoch },
    );
    Ok(file)
}

// ---------------------------------------------------------------- still

/// Keep one frame of a video as a PNG file in the room.
///
/// The pixels come from the viewer (a canvas draw off the same
/// `roommedia://` stream the player uses), because that decoder is already
/// warm and already knows how to wait for a PRESENTED frame — see
/// `src/viewers/frameGrab.ts`. This end only stores them, and it checks the
/// payload really is a PNG first: writing whatever arrived and calling it a
/// saved frame would be a success this command can't evidence.
#[tauri::command]
pub fn save_video_frame(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    png_b64: String,
    at_secs: f64,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_b64.trim())
        .map_err(|_| "That frame didn't arrive as valid image data — nothing was saved.".to_string())?;
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("That frame didn't arrive as a PNG — nothing was saved.".into());
    }
    let file = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        // Two stills a second apart round to the same stamp; `available_name`
        // is what keeps the second one from being indistinguishable.
        let still = db::available_name(&room.conn, &frame_name(&name, at_secs))?;
        db::insert_file(
            &room.conn,
            &still,
            "image/png",
            &png,
            None,
            "generated",
        )
    })?;
    let _ = app.emit("room-files-changed", ());
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_span_outside_the_video_is_refused_and_an_overrun_tail_is_clamped() {
        assert_eq!(validate_span(1.0, 4.0, Some(10.0)), Ok((1.0, 4.0)));
        // Dragging the out-point past the end is unambiguous: clamp it.
        assert_eq!(validate_span(1.0, 99.0, Some(10.0)), Ok((1.0, 10.0)));
        assert!(validate_span(-1.0, 4.0, Some(10.0)).is_err(), "negative start");
        assert!(validate_span(4.0, 4.0, Some(10.0)).is_err(), "zero-length span");
        assert!(validate_span(4.0, 3.0, Some(10.0)).is_err(), "inverted span");
        assert!(validate_span(4.0, 4.05, Some(10.0)).is_err(), "sub-frame span");
        assert!(validate_span(20.0, 25.0, Some(10.0)).is_err(), "starts past the end");
        assert!(validate_span(f64::NAN, 4.0, Some(10.0)).is_err());
        assert!(validate_span(0.0, f64::INFINITY, Some(10.0)).is_err());
    }

    /// An unreadable duration must not disable trimming. The probe returning
    /// None means "the container didn't say", not "the video is zero seconds
    /// long" — treating it as the latter would refuse every cut on a file
    /// whose header is merely thin.
    #[test]
    fn an_unknown_duration_removes_the_upper_bound_rather_than_blocking_the_cut() {
        assert_eq!(validate_span(1.0, 4.0, None), Ok((1.0, 4.0)));
        assert_eq!(validate_span(500.0, 600.0, None), Ok((500.0, 600.0)));
        // The lower bounds still apply — they don't depend on the duration.
        assert!(validate_span(-1.0, 4.0, None).is_err());
        assert!(validate_span(4.0, 4.0, None).is_err());
    }

    #[test]
    fn a_missing_converter_says_so_instead_of_reporting_a_trim() {
        let msg = describe_convert_error("Os { code: 2, kind: NotFound, message: \"…\" }");
        assert!(msg.contains("avconvert"), "{msg}");
        assert!(msg.contains("nothing was trimmed"), "{msg}");
        // Anything else keeps the converter's own words — that detail is the
        // only clue about WHY a particular file refused.
        assert!(describe_convert_error("codec not supported").contains("codec not supported"));
    }

    #[test]
    fn derived_names_carry_the_span_and_keep_the_container() {
        assert_eq!(trimmed_name("talk.mp4", 7.3, 19.0), "talk (trim 0-07 to 0-19).mp4");
        assert_eq!(trimmed_name("a.b.mov", 0.0, 90.0), "a.b (trim 0-00 to 1-30).mov");
        assert_eq!(trimmed_name("noext", 0.0, 5.0), "noext (trim 0-00 to 0-05)");
        // Past an hour the stamp grows a field rather than rolling over.
        assert_eq!(trimmed_name("x.mp4", 3661.0, 3670.0), "x (trim 1-01-01 to 1-01-10).mp4");
        assert_eq!(frame_name("talk.mp4", 83.4), "talk @ 1-23.png");
        // No colons: they read as a path separator once the file is exported.
        assert!(!frame_name("talk.mp4", 83.4).contains(':'));
    }

    /// The extension a CAMERA writes is upper case, and `extension_of`
    /// lowercases — so stripping its result off the real name matched nothing
    /// and left the original extension buried inside the derived name
    /// ("IMG_0042.MOV (trim 0-00 to 0-05).mov").
    #[test]
    fn an_upper_case_extension_is_not_left_inside_the_derived_name() {
        assert_eq!(
            trimmed_name("IMG_0042.MOV", 0.0, 5.0),
            "IMG_0042 (trim 0-00 to 0-05).MOV"
        );
        assert_eq!(frame_name("IMG_0042.MOV", 5.0), "IMG_0042 @ 0-05.png");
        assert_eq!(trimmed_name("Clip.Mp4", 0.0, 5.0), "Clip (trim 0-00 to 0-05).Mp4");
        // A leading dot is the whole name, not an extension.
        assert_eq!(frame_name(".hidden", 5.0), ".hidden @ 0-05.png");
    }

    /// avconvert really does cut, losslessly, in the shape this command drives
    /// it. Skipped (not failed) where the system fixture source is absent —
    /// that is a fact about the machine, not about the code.
    #[test]
    fn a_real_cut_lands_and_leaves_a_probeable_clip() {
        let Some(src) = media_probe::test_fixture("trim.mov", &["--duration", "4"]) else {
            eprintln!("skipped: no system fixture source on this machine");
            return;
        };
        let dst = std::env::temp_dir().join(format!("arcelle-trimtest-{}.mov", uuid::Uuid::new_v4()));
        let cut = run_avconvert(&src, &dst, 1.0, 2.0);
        let meta = cut.as_ref().ok().and_then(|()| media_probe::probe_path(&dst));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        cut.expect("avconvert should cut a system .mov");
        let secs = meta.expect("the clip must probe").duration_secs.expect("duration");
        assert!((secs - 2.0).abs() < 0.3, "asked for 2 s, got {secs}");
    }

    #[test]
    fn trimming_leaves_no_decrypted_copy_behind() {
        // The staging file is written before avconvert ever runs, so this holds
        // even on a machine with no converter at all.
        let leftovers = || {
            std::fs::read_dir(std::env::temp_dir())
                .map(|d| {
                    d.filter_map(Result::ok)
                        .filter(|e| {
                            let n = e.file_name().to_string_lossy().into_owned();
                            n.starts_with("arcelle-trim-") && n.ends_with(".trimtest")
                        })
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(leftovers(), 0, "a previous run leaked");
        let stamp = uuid::Uuid::new_v4();
        let src = std::env::temp_dir().join(format!("arcelle-trim-in-{stamp}.trimtest"));
        let dst = std::env::temp_dir().join(format!("arcelle-trim-out-{stamp}.trimtest"));
        write_private(&src, b"not a video").expect("stage");
        let failed = run_avconvert(&src, &dst, 0.0, 1.0);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        assert!(failed.is_err(), "a non-video must not report a successful cut");
        assert_eq!(leftovers(), 0, "a decrypted trim copy survived the call");
    }

    #[cfg(unix)]
    #[test]
    fn the_staged_copy_is_owner_only_while_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("arcelle-trim-in-{}.perm", uuid::Uuid::new_v4()));
        write_private(&path, b"secret").expect("write");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let _ = std::fs::remove_file(&path);
        assert_eq!(mode, 0o600, "a decrypted video copy was readable by other users");
    }
}
