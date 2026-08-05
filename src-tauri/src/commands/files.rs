use super::*;

/// A room stores a file as one SQLite blob, and SQLite's hard ceiling on a
/// single blob is ~1 GB. There is deliberately no smaller cap on importing (it
/// was removed by request), but this one is real: past it the write can only
/// fail, and reading the file into memory first is how a huge disk image or raw
/// video used to make the app disappear with no message at all.
pub(crate) const MAX_IMPORT_BYTES: u64 = 1_000_000_000;

#[tauri::command]
pub async fn import_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportReport, String> {
    // Fail fast, with the same wording as before, when there is no room at all.
    if state.room.lock().unwrap().is_none() {
        return Err("No room is open.".into());
    }
    // Reading, extracting and indexing every dropped file used to run on the
    // main thread, so the window froze from the first file to the last and the
    // "Importing 2 of 5" counter it emits could never reach the screen.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || import_files_blocking(&handle, paths))
        .await
        .map_err(|e| format!("The import could not be started: {e}"))?
}

fn import_files_blocking(app: &tauri::AppHandle, paths: Vec<String>) -> Result<ImportReport, String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let room_path = room.path.clone();
    // Wave 3 (Idea 9): stamp queued OCR/STT jobs with the current room epoch so
    // a rollback between enqueue and execution drops them instead of writing
    // into the swapped room.
    let room_epoch = state.room_epoch();
    let mut imported = Vec::new();
    let mut errors = Vec::new();
    // ADD-14: files that arrived with no extractable text and could be scans or
    // photos. OCR runs in the background AFTER import returns, so a big scan
    // never freezes the import.
    let mut ocr_jobs: Vec<JobMeta> = Vec::new();
    let total = paths.len();
    for (i, path) in paths.into_iter().enumerate() {
        let file_name = std::path::Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        // ADD-31: a big or multi-file import was invisible until it was over —
        // name each file as it's read/extracted so the sidebar can show a
        // live queue ("Importing 2 of 5 — lease.pdf").
        {
            use tauri::Emitter;
            let _ = app.emit(
                "import-progress",
                serde_json::json!({ "done": i, "total": total, "name": file_name }),
            );
        }
        // No arbitrary size cap on imports (removed by request) — but the
        // ~1 GB per-blob ceiling is checked HERE rather than a gigabyte of
        // reading later, so a huge file is refused in plain language instead of
        // failing deep down with "string or blob too big" (or taking the app
        // with it on the way). A file that can't be stat'd (missing / no
        // permission) still surfaces its own clean error.
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_IMPORT_BYTES => {
                errors.push(format!(
                    "{file_name} is {} MB — larger than the {} MB limit for a room file.",
                    meta.len() / (1024 * 1024),
                    MAX_IMPORT_BYTES / (1024 * 1024)
                ));
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                errors.push(format!("{file_name}: {e}"));
                continue;
            }
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                // Nothing used to check whether these exact bytes were already
                // here, so a repeated drag-and-drop stored the file again,
                // doubled the space it takes and showed the same document twice
                // to the user AND to the model. (Memories have had this check
                // since they were built.)
                if let Some((_, existing)) = db::file_with_same_bytes(&room.conn, &bytes) {
                    errors.push(format!(
                        "{file_name}: already in this room as \"{existing}\" — not added again."
                    ));
                    continue;
                }
                let mime = mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string();
                let mut text = extraction::extract_text(&file_name, &bytes);
                // Anything the built-in extractors can't read (ppt, doc, xls,
                // epub, …) gets a second chance through MarkItDown if installed.
                if text.as_deref().map_or(true, |t| t.trim().is_empty())
                    && !extraction::is_image(&mime)
                {
                    text = extraction::markitdown_extract(&path);
                }
                let ext = extraction::extension_of(&file_name);
                let no_text = text.as_deref().map_or(true, |t| t.trim().is_empty());
                // A PDF whose text came back DEGRADED — interleaved columns,
                // words with no spaces, an unmapped font — used to be indexed
                // exactly as it arrived, because the only OCR trigger was "no
                // text at all". That silently poisoned search and every answer
                // the model gave from the file. Vision reads the RENDERED page,
                // so it is layout- and font-independent; the pass is queued on
                // the same background lane as a scan.
                let degraded_pdf = ext == "pdf"
                    && text.as_deref().is_some_and(extraction::should_reread_with_ocr);
                let needs_ocr = (no_text || degraded_pdf) && ocr::is_ocr_candidate(&mime, &ext);
                // ADD-18: recordings/videos get transcribed in the background,
                // the audio twin of the OCR fallback below.
                let needs_stt = no_text && stt::media_kind(&mime, &ext).is_some();
                // The user's own file is still on disk here, so a video can be
                // asked what it is for free — no temp copy, no second decrypt.
                // A probe that read nothing writes nothing: the column stays
                // NULL and means "not probed yet", never "probed, all unknown".
                let media_meta = (stt::media_kind(&mime, &ext) == Some(stt::MediaKind::Video))
                    .then(|| crate::media_probe::probe_path(std::path::Path::new(&path)))
                    .flatten()
                    .and_then(|m| serde_json::to_string(&m).ok());
                match db::insert_file(&room.conn, &file_name, &mime, &bytes, text.as_deref(), "upload")
                {
                    Ok(meta) => {
                        if let Some(json) = &media_meta {
                            let _ = db::set_media_meta(&room.conn, &meta.id, json);
                        }
                        if needs_ocr || needs_stt {
                            // CHG-27: enqueue metadata only; the worker re-reads
                            // bytes from the DB when it runs.
                            ocr_jobs.push(JobMeta {
                                id: meta.id.clone(),
                                name: file_name.clone(),
                                mime: mime.clone(),
                                ext,
                                room_path: room_path.clone(),
                                epoch: room_epoch,
                            });
                        }
                        imported.push(meta);
                    }
                    Err(e) => errors.push(format!("{file_name}: {e}")),
                }
            }
            Err(e) => errors.push(format!("{file_name}: {e}")),
        }
    }
    // ADD-31: terminal receipt — the queue strip clears on total==done and the
    // frontend toasts "Imported N files" (with the failure count when any).
    {
        use tauri::Emitter;
        let _ = app.emit(
            "import-progress",
            serde_json::json!({
                "done": total, "total": total, "name": "",
                "imported": imported.len(), "failed": errors.len()
            }),
        );
    }
    // Release the room lock before kicking off background OCR/STT — the
    // worker lanes re-acquire it once, briefly, only when they have text.
    drop(guard);
    for job in ocr_jobs {
        // Media files route to the transcriber lane, everything else to OCR.
        if stt::media_kind(&job.mime, &job.ext).is_some() {
            enqueue_stt(&app, job);
        } else {
            enqueue_ocr(&app, job);
        }
    }
    // CHG-22 → Wave 1b (idea 8): freshly-imported files go through the
    // debounced auto-index scheduler (one decision per drop, after the lock).
    schedule_auto_index(&app, room_path.clone());
    // PRIV-2: newly imported text gets its privacy scan (no-op when the door
    // is off for this room).
    schedule_privacy_scan(app.clone());
    Ok(ImportReport { imported, errors })
}

/// S3 (2026-08-04): a downloaded file's MIME today comes ONLY from
/// `mime_guess::from_path(display_name)` — a name the SERVER chose (via
/// `Content-Disposition` or the URL), sanitized for path-safety by
/// `safe_file_name` but never checked against what the bytes actually are.
/// This is deliberately narrow — not a general file-type detector, just the
/// one dangerous shape: a script/executable signature wearing an inert-looking
/// extension. `None` on any other mismatch (or none at all); a `.pdf` that
/// sniffs as a `.docx` is a labeling curiosity, not a safety question.
fn dangerous_content_mismatch(bytes: &[u8], claimed_ext: &str) -> bool {
    const EXECUTABLE_LIKE_EXTS: &[&str] = &[
        "sh", "bash", "zsh", "py", "js", "exe", "bin", "app", "command", "scpt", "workflow",
        "applescript", "bat", "cmd", "ps1", "dmg", "pkg",
    ];
    if EXECUTABLE_LIKE_EXTS.contains(&claimed_ext) {
        return false; // already labeled as something the user would treat with care
    }
    let looks_executable = bytes.starts_with(b"\x7fELF") // Linux ELF
        || bytes.starts_with(b"MZ") // Windows PE
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCE]) // Mach-O 32-bit
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF]) // Mach-O 64-bit
        || bytes.starts_with(&[0xCE, 0xFA, 0xED, 0xFE]) // Mach-O 32-bit, reverse byte order
        || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE]) // Mach-O 64-bit, reverse byte order
        || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]) // Mach-O / Java class fat binary
        || bytes.starts_with(b"#!"); // shebang script
    looks_executable
}

/// BROWSE-2: import one downloaded file into the room and delete its staged
/// temp copy. The single-file twin of [`import_files`], reachable from
/// background threads (browser downloads, agent tools, download jobs) — the
/// same funnel: extraction, OCR/STT lanes, auto-index, privacy scan — plus the
/// download provenance (D19: `source="download"` and the origin URL).
pub(crate) fn import_download(
    app: &tauri::AppHandle,
    staged: &std::path::Path,
    display_name: &str,
    origin_url: &str,
) -> Result<FileMeta, String> {
    use tauri::Manager;
    // D15: the room stores a file as one SQLite blob (~1 GB ceiling) — refuse
    // before storage does, with the real limit in the message. Checked here so
    // EVERY inlet (browser click, agent tool, download job) hits the same cap.
    let size = std::fs::metadata(staged).map(|m| m.len()).unwrap_or(0);
    if size > web::MAX_DOWNLOAD_BYTES {
        let _ = std::fs::remove_file(staged);
        return Err(format!(
            "{display_name} is {} MB — larger than the {} MB limit for a room file.",
            size / (1024 * 1024),
            web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ));
    }
    let bytes = match std::fs::read(staged) {
        Ok(bytes) => bytes,
        Err(e) => {
            let _ = std::fs::remove_file(staged);
            return Err(format!("{display_name}: {e}"));
        }
    };
    // S3 (2026-08-04): the name a server chose can lie. Check the bytes
    // BEFORE anything downstream treats this as its claimed type. A flagged
    // file skips extraction entirely (never falls to `markitdown_extract`
    // below, which reads from `staged`'s own path — still on disk under its
    // ORIGINAL, misleading extension — and would otherwise hand a disguised
    // executable to a parser expecting PDF/office content).
    let claimed_ext = extraction::extension_of(display_name);
    let flagged = dangerous_content_mismatch(&bytes, &claimed_ext);
    let display_name: std::borrow::Cow<'_, str> = if flagged {
        let stem = display_name.strip_suffix(&format!(".{claimed_ext}")).unwrap_or(display_name);
        std::borrow::Cow::Owned(format!("{stem} (blocked - not really a .{claimed_ext}).bin"))
    } else {
        std::borrow::Cow::Borrowed(display_name)
    };
    let display_name: &str = &display_name;
    let mime = mime_guess::from_path(display_name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let text = if flagged {
        None
    } else {
        let mut text = extraction::extract_text(display_name, &bytes);
        if text.as_deref().map_or(true, |t| t.trim().is_empty()) && !extraction::is_image(&mime) {
            // MarkItDown reads from a path; the staged file still ends with the
            // real name ("{uuid}-{name}"), so its extension survives.
            text = extraction::markitdown_extract(&staged.to_string_lossy());
        }
        text
    };
    let ext = extraction::extension_of(display_name);
    // Ask the container what it is while the staged copy still exists — after
    // the remove below there is no file left to probe without writing another.
    let media_meta = (stt::media_kind(&mime, &ext) == Some(stt::MediaKind::Video))
        .then(|| crate::media_probe::probe_path(staged))
        .flatten()
        .and_then(|m| serde_json::to_string(&m).ok());
    let _ = std::fs::remove_file(staged);

    let no_text = text.as_deref().map_or(true, |t| t.trim().is_empty());
    let degraded_pdf =
        ext == "pdf" && text.as_deref().is_some_and(extraction::should_reread_with_ocr);
    let needs_ocr = (no_text || degraded_pdf) && ocr::is_ocr_candidate(&mime, &ext);
    let needs_stt = no_text && stt::media_kind(&mime, &ext).is_some();

    let state = app.state::<AppState>();
    let room_epoch = state.room_epoch();
    let (meta, room_path) = state.with_room(|room| {
        let meta = db::insert_file_from_url(
            &room.conn,
            display_name,
            &mime,
            &bytes,
            text.as_deref(),
            "download",
            Some(origin_url),
        )?;
        if let Some(json) = &media_meta {
            db::set_media_meta(&room.conn, &meta.id, json)?;
        }
        Ok((meta, room.path.clone()))
    })?;
    if needs_ocr || needs_stt {
        let job = JobMeta {
            id: meta.id.clone(),
            name: display_name.to_string(),
            mime: mime.clone(),
            ext,
            room_path: room_path.clone(),
            epoch: room_epoch,
        };
        if needs_stt {
            enqueue_stt(app, job);
        } else {
            enqueue_ocr(app, job);
        }
    }
    schedule_auto_index(app, room_path);
    schedule_privacy_scan(app.clone());
    {
        use tauri::Emitter;
        let _ = app.emit("room-files-changed", ());
    }
    Ok(meta)
}

/// CHG-27: a background enrichment job carrying only metadata — NOT the file
/// bytes. The file is already in the room DB before dispatch, so the worker
/// re-reads bytes under the room lock; this keeps peak memory to one in-flight
/// file per lane instead of holding every dropped file's bytes at once.
#[derive(Clone)]
pub(crate) struct JobMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) mime: String,
    pub(crate) ext: String,
    pub(crate) room_path: String,
    /// Wave 3 (Idea 9): the room epoch at enqueue. The OCR/STT worker lanes are
    /// static queues whose entries survive a teardown; a queued transcription
    /// started before a rollback must NOT land its transcript in the swapped
    /// room (the path is unchanged, so the path pin alone would pass). The write
    /// sites require this to still equal `state.room_epoch()`.
    pub(crate) epoch: u64,
}

/// CHG-27: two lazily-started, long-lived worker lanes (OCR and STT) draining an
/// mpsc channel, so importing 30 scans runs them one at a time instead of
/// spawning 30 concurrent multi-hundred-MB OCR passes that starve the chat.
pub(crate) static OCR_TX: OnceLock<std::sync::mpsc::Sender<JobMeta>> = OnceLock::new();
pub(crate) static STT_TX: OnceLock<std::sync::mpsc::Sender<JobMeta>> = OnceLock::new();

pub(crate) fn enqueue_ocr(app: &tauri::AppHandle, job: JobMeta) {
    let app = app.clone();
    let tx = OCR_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<JobMeta>();
        std::thread::spawn(move || {
            for job in rx {
                run_ocr_job(&app, job);
            }
        });
        tx
    });
    let _ = tx.send(job);
}

/// What the STT lane is doing right now, so `stt_status` can answer "is it
/// done?" — the agent's only way to check.
///
/// The lane is an unbounded mpsc channel with no observable depth, and
/// `retranscribe_file` is NOT a durable job (it never reaches the jobs table),
/// so `job_status` cannot see it. The Transcription agent could therefore start
/// a re-transcription and never learn whether it finished: the self-test
/// (2026-08-01, wave 5) correctly graded its own "done" as unverifiable. This
/// pair is the smallest thing that makes the claim checkable — `stt_status` is
/// already that agent's free probe, so it costs no extra round.
pub(crate) static STT_PENDING: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
pub(crate) static STT_CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// A snapshot of the lane: (file being transcribed now, jobs still queued).
pub(crate) fn stt_progress() -> (Option<String>, usize) {
    let current = STT_CURRENT.lock().unwrap().clone();
    // `STT_PENDING` counts the in-flight one too; report the QUEUE behind it.
    let pending = STT_PENDING.load(Ordering::SeqCst);
    (current, pending.saturating_sub(1).max(0))
}

pub(crate) fn enqueue_stt(app: &tauri::AppHandle, job: JobMeta) {
    let app = app.clone();
    let tx = STT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<JobMeta>();
        std::thread::spawn(move || {
            for job in rx {
                *STT_CURRENT.lock().unwrap() = Some(job.name.clone());
                run_stt_job(&app, job);
                // Cleared BEFORE the count drops, so a reader can never see
                // "nothing running" while the count still says one is.
                *STT_CURRENT.lock().unwrap() = None;
                STT_PENDING.fetch_sub(1, Ordering::SeqCst);
            }
        });
        tx
    });
    STT_PENDING.fetch_add(1, Ordering::SeqCst);
    if tx.send(job).is_err() {
        STT_PENDING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Re-run on-device transcription for one audio/video file, replacing its
/// transcript with a fresh pass. Routes through the SAME STT lane as import-time
/// transcription, so it queues behind any in-flight job instead of spawning a
/// competing decode, and emits the usual `stt-progress` events the viewer reads.
#[tauri::command]
pub fn retranscribe_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_id: String,
) -> Result<(), String> {
    let epoch = state.room_epoch();
    let (name, mime, room_path) = state.with_room(|room| {
        let meta = db::get_file_meta(&room.conn, &file_id)?;
        Ok((meta.name, meta.mime_type, room.path.clone()))
    })?;
    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if stt::media_kind(&mime, &ext).is_none() {
        return Err("This file isn't audio or video, so there's nothing to transcribe.".into());
    }
    enqueue_stt(
        &app,
        JobMeta { id: file_id, name, mime, ext, room_path, epoch },
    );
    Ok(())
}

/// Read a job's stored bytes iff its room is still the open one. None → the room
/// was closed/switched while the job was queued; the worker drops the job.
pub(crate) fn read_job_bytes(app: &tauri::AppHandle, job: &JobMeta) -> Option<Vec<u8>> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        // Wave 3 (Idea 9): the epoch pin drops a job queued before a rollback —
        // the room path is unchanged after a rollback, so it alone would pass.
        Some(room) if room.path == job.room_path && state.room_epoch() == job.epoch => {
            db::get_file_bytes(&room.conn, &job.id).ok().flatten()
        }
        _ => None,
    }
}

/// The text a queued file already carries, under the same epoch pin as
/// `read_job_bytes` — a rollback between enqueue and execution must not let a
/// job read the swapped room.
fn read_job_text(app: &tauri::AppHandle, job: &JobMeta) -> Option<String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) if room.path == job.room_path && state.room_epoch() == job.epoch => {
            db::get_file_full(&room.conn, &job.id).ok().and_then(|(_, _, _, text)| text)
        }
        _ => None,
    }
}

/// ADD-14: on-device OCR for one file. On success, store the recognized text
/// (prefixed so the AI can flag OCR uncertainty), re-index it, and tell the UI.
/// Any failure is silent — the file simply keeps having no text.
pub(crate) fn run_ocr_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let _ = app.emit("ocr-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    // Whatever reading the file already has. For a scan this is None; for a
    // PDF queued because its embedded text was DEGRADED it is that text, and
    // it must not be thrown away unless the OCR is genuinely better.
    let existing = read_job_text(app, &job);
    let Some(text) = ocr::recognize(&job.mime, &job.ext, &bytes) else {
        let _ = app.emit("ocr-progress", (&job.name, "none"));
        return;
    };
    let recognized = format!("(text recognized from scan)\n{text}");
    // `choose` keeps faultless embedded text over any OCR (Vision can misread
    // a ligature where the embedded text is exact) and never lets a blank
    // recognition erase a real, if imperfect, reading.
    let full_text =
        match extraction::choose(existing.as_deref(), Some(recognized.as_str())) {
            Some(chosen) => chosen.to_string(),
            None => {
                let _ = app.emit("ocr-progress", (&job.name, "none"));
                return;
            }
        };
    if existing.as_deref() == Some(full_text.as_str()) {
        // The existing reading won — nothing to write, and claiming "done"
        // would report an improvement that did not happen.
        let _ = app.emit("ocr-progress", (&job.name, "none"));
        return;
    }
    {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        match guard.as_ref() {
            Some(room) if room.path == job.room_path && state.room_epoch() == job.epoch => {
                let _ = db::update_file_content(&room.conn, &job.id, &bytes, Some(&full_text));
            }
            _ => return,
        }
    }
    let _ = app.emit("room-files-changed", ());
    let _ = app.emit("ocr-progress", (&job.name, "done"));
    // CHG-22 → Wave 1b (idea 8): newly-readable file goes through the
    // debounced auto-index scheduler.
    schedule_auto_index(app, job.room_path.clone());
    schedule_privacy_scan(app.clone());
}

#[tauri::command]
pub fn list_files(state: State<'_, AppState>) -> Result<Vec<FileMeta>, String> {
    state.with_room(|room| db::list_files(&room.conn))
}

/// The format registry is the single source of truth for what a file is; these
/// re-exports keep every existing caller in this module working unchanged.
pub(crate) use crate::formats::{classify_file, Delivery, TextSource};

/// Text files are read as UTF-8. Bytes that aren't valid UTF-8 come back from
/// `from_utf8_lossy` with every unreadable byte turned into U+FFFD, so writing
/// that text back would permanently replace the file's accented letters with
/// boxes. Every in-place write path checks first and refuses with this.
pub(crate) fn non_utf8_error(name: &str) -> String {
    format!(
        "\"{name}\" is not saved as UTF-8 text, so editing it here would replace its \
         accented characters with □. Re-save it as UTF-8 first, or save a corrected \
         copy as a new file."
    )
}

/// Clip huge extracted text at a char boundary for preview/edit payloads.
/// Lifted out of `get_file_content` (Idea 11) so the version-compare command
/// shapes its payload identically — both sides are clipped the same way, so a
/// >1 MB file never shows its truncation tail as a phantom one-sided diff.
pub(crate) fn clip_preview(mut t: String) -> String {
    if t.len() > 1_000_000 {
        let mut cut = 1_000_000;
        while !t.is_char_boundary(cut) {
            cut -= 1;
        }
        t.truncate(cut);
        t.push_str("\n\n… (truncated preview)");
    }
    t
}

/// The text representation `get_file_content` exposes for a file's bytes,
/// factored out so the Idea 11 compare view can shape BOTH the stored version
/// and the current file the SAME way. Both sides go through `classify_file`, so
/// the two diff panes can never pick different representations for the same
/// bytes. Every branch runs through `clip_preview` so truncation is symmetric.
/// None = there is genuinely no text (an image with no OCR, an unreadable
/// binary) → the modal shows "no text to compare".
pub(crate) fn content_text(
    name: &str,
    mime: &str,
    bytes: &[u8],
    extracted: Option<String>,
) -> Option<String> {
    let ext = extraction::extension_of(name);
    // Media (audio/video/recording): the transcript is the comparable text.
    if stt::media_kind(mime, &ext).is_some() {
        return extracted.map(clip_preview);
    }
    match classify_file(name, mime, bytes.len()).text {
        // Decoded exactly as the viewer decodes it, so a legacy-encoded file's
        // two diff panes read as its own words rather than as U+FFFD on both
        // sides — the compare view is where a bad decode looks like an edit.
        TextSource::Raw => Some(clip_preview(extraction::decode_text_bytes(bytes))),
        TextSource::Extracted => extracted.map(clip_preview),
    }
}

#[tauri::command]
pub fn get_file_content(
    state: State<'_, AppState>,
    media: State<'_, MediaStreams>,
    id: String,
) -> Result<FileContent, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (name, mime, bytes, extracted) = db::get_file_full(&room.conn, &id)?;
    let mime = mime.unwrap_or_default();
    let mut bytes = bytes.unwrap_or_default();
    let ext = extraction::extension_of(&name);

    // Idea 11: the clip closure is now a shared free fn (both the viewer and the
    // compare view shape text through it).
    let clip = clip_preview;

    // ADD-24: recordings/videos stream through roommedia:// (Range-capable),
    // so any size plays and seeks — no base64 through IPC, no 50MB ceiling.
    // The timestamped transcript still rides along for "[m:ss]" seeking.
    // ADD-27: a live-recording file (it has a recordings meta row) opens in
    // the Recording editor instead of the plain player.
    if let Some(kind) = stt::media_kind(&mime, &ext) {
        let k = if db::get_rec_meta(&room.conn, &id).is_some() {
            "recording"
        } else if kind == stt::MediaKind::Video {
            "video"
        } else {
            "audio"
        };
        let playable = playable_media_mime(&mime, &ext, kind == stt::MediaKind::Video);
        // Whatever the container was already asked about. NOT probed here: the
        // probe opens the file through AVFoundation, and this command runs
        // holding the room lock. The viewer asks for `probe_video_meta` when
        // this is None, which does the work with the lock released.
        let media_meta = db::get_media_meta(&room.conn, &id)
            .and_then(|j| serde_json::from_str(&j).ok());
        let token = stage_media_bytes(&media, std::mem::take(&mut bytes), &playable);
        return Ok(FileContent {
            kind: k.into(),
            name,
            mime,
            editable: false,
            text: extracted.map(clip),
            data_b64: None,
            media_token: Some(token),
            media_meta,
            // A media file is not a saved page; the column is NULL for it and
            // the strip has nothing to draw.
            web_meta: None,
        });
    }

    let view = classify_file(&name, &mime, bytes.len());

    // A viewer that parses the real bytes (pdf, docx, sheet, slides, book,
    // archive, image) now STREAMS them over roommedia:// instead of receiving a
    // base64 data URL through IPC.
    //
    // The old payload was 4/3 the size of the file, had to be built in Rust,
    // copied across the IPC boundary and parsed by JS before a single page could
    // render — which is why there was a 50 MB ceiling on it at all, and why a
    // file one byte over that ceiling silently lost its real viewer and opened
    // as a plain `<pre>`. Nothing about a 60 MB scan or a 200-page deck makes it
    // unviewable; only the transport did. The staged map is capped and cleared
    // on lock exactly as it already was for audio and video.
    let stream_token = |bytes: Vec<u8>| {
        // The MIME the protocol response announces. Media has its own
        // playability mapping; everything else is served as-is, with a generic
        // fallback so a mislabelled upload still downloads/renders.
        let served = if mime.is_empty() || mime == "application/octet-stream" {
            mime_guess::from_path(&name).first_or_octet_stream().essence_str().to_string()
        } else {
            mime.clone()
        };
        stage_media_bytes(&media, bytes, &served)
    };

    // What the page this file was saved from declared about itself, if it was
    // saved from one. Parsed here so a row written by an older build — or by a
    // hand-edited room — can only cost the strip, never the file.
    let web_meta = db::get_web_meta(&room.conn, &id).and_then(|j| serde_json::from_str(&j).ok());

    let content =
        |kind: &str, editable: bool, text: Option<String>, token: Option<String>| FileContent {
            kind: kind.into(),
            name: name.clone(),
            mime: mime.clone(),
            editable,
            text,
            data_b64: None,
            media_token: token,
            // Non-media viewers: there is no container to have technical
            // metadata about.
            media_meta: None,
            web_meta: web_meta.clone(),
        };

    match view.text {
        // The bytes ARE the text: handed over whole (never clipped — a clipped
        // buffer saved back would truncate the file), which is what
        // MAX_RAW_TEXT_BYTES in the registry bounds.
        TextSource::Raw => {
            // This was `from_utf8_lossy`, which turned every byte of a legacy
            // encoding into U+FFFD — so a Turkish ISO-8859-9 .txt opened as a
            // wall of "" AND lost its Edit button, since a lossy string is
            // exactly what must never be written back (live QA 2026-08-03, 1/5).
            //
            // It goes through the SAME function the encoding strip re-runs, so
            // the text on screen and the encoding the strip names can never come
            // from two different readings of the file — including the rule for
            // whether Edit is on the table at all.
            let decoded = decode_stored_text(&name, &mime, &bytes, None)?;
            let token = (view.delivery == Delivery::Stream).then(|| stream_token(bytes));
            Ok(content(view.kind, decoded.editable, Some(decoded.text), token))
        }
        TextSource::Extracted => {
            let token = (view.delivery == Delivery::Stream).then(|| stream_token(bytes));
            match extracted {
                Some(text) => Ok(content(view.kind, view.editable, Some(clip(text)), token)),
                // No text was read out of it after all (an image awaiting OCR
                // keeps its viewer; anything else falls back to the binary card).
                None if token.is_some() => Ok(content(view.kind, false, None, token)),
                None => Ok(content("binary", false, None, None)),
            }
        }
    }
}

/// One charset the viewer's encoding picker may offer. `name` is the WHATWG
/// name a decode reports back, so the menu's selected row and the strip's
/// "read as …" are always the same string.
#[derive(Serialize, Clone, Debug)]
pub struct EncodingChoice {
    pub name: String,
    pub title: String,
}

/// A text file re-read from its ORIGINAL BYTES, for the viewer's encoding strip.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DecodedFileText {
    pub text: String,
    pub encoding: String,
    /// bom | utf8 | detected | chosen — a fact about the bytes, or a guess, or
    /// the user's override. The strip says which.
    pub source: extraction::EncodingSource,
    /// Bytes with no meaning in this encoding became U+FFFD, so the text is not
    /// the file and must not be saved back over it.
    pub lossy: bool,
    /// Whether Edit is on the table for this reading (the format allows an
    /// in-place rewrite AND the decode was clean).
    pub editable: bool,
    pub options: Vec<EncodingChoice>,
}

/// Re-decode a stored file's bytes, optionally as a NAMED encoding.
///
/// `get_file_content` reads its raw-text payload through here too, so the text
/// the viewer draws and the encoding the strip names are one answer rather than
/// two readings that have to agree by eye.
///
/// Pure so it can be unit-tested without a room. Detection is a guess and
/// single-byte encodings are genuinely ambiguous — the same bytes really are
/// Turkish and really are Cyrillic — so the viewer has to let a human overrule
/// it, and the override has to re-read the BYTES. Re-interpreting the string we
/// already decoded could only ever launder one wrong reading into another.
pub(crate) fn decode_stored_text(
    name: &str,
    mime: &str,
    bytes: &[u8],
    encoding: Option<&str>,
) -> Result<DecodedFileText, String> {
    let view = classify_file(name, mime, bytes.len());
    // Extracted-text formats (a PDF, a Word file) have no charset the user could
    // usefully change: their reader already decided how to read them. Saying so
    // beats handing back a plausible-looking re-decode of a zip container.
    if view.text != TextSource::Raw {
        return Err(format!(
            "\"{name}\" is not stored as plain text — its words are read out of the file, so \
             there is no text encoding to change."
        ));
    }
    let decoded = match encoding {
        Some(label) => extraction::decode_text_as(bytes, label)
            .ok_or_else(|| format!("Arcelle can't read text as \"{label}\"."))?,
        None => extraction::decode_text_detail(bytes),
    };
    Ok(DecodedFileText {
        text: decoded.text,
        encoding: decoded.encoding.to_string(),
        source: decoded.source,
        lossy: decoded.lossy,
        editable: view.editable && !decoded.lossy,
        options: extraction::encoding_choices()
            .into_iter()
            .map(|(name, title)| EncodingChoice { name: name.to_string(), title: title.to_string() })
            .collect(),
    })
}

/// The viewer's encoding strip: what encoding this text file is being read as,
/// and what it says when read as another one.
///
/// `encoding: None` answers with the automatic reading — the same one
/// `get_file_content` shows — which is how the strip learns what to display
/// without the viewer having to guess a second time.
#[tauri::command]
pub fn decode_file_text(
    state: State<'_, AppState>,
    id: String,
    encoding: Option<String>,
) -> Result<DecodedFileText, String> {
    state.with_room(|room| {
        let (name, mime, bytes, _) = db::get_file_full(&room.conn, &id)?;
        decode_stored_text(
            &name,
            &mime.unwrap_or_default(),
            &bytes.unwrap_or_default(),
            encoding.as_deref(),
        )
    })
}

/// The single write path for changing an existing file's bytes. Snapshots the
/// CURRENT bytes into version history (ADD-2) tagged with `cause`, then
/// overwrites and rebuilds the search index. Every caller that mutates a file's
/// content goes through here so nothing is ever irreversibly overwritten.
pub(crate) fn store_file_bytes(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
    text: Option<&str>,
    cause: &str,
) -> Result<(), String> {
    db::snapshot_file_version(conn, id, cause)?;
    db::update_file_content(conn, id, bytes, text)
}

#[tauri::command]
pub fn update_file_content(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let bytes = content.as_bytes();
        let text = extraction::extract_text(&name, bytes).unwrap_or_else(|| content.clone());
        store_file_bytes(&room.conn, &id, bytes, Some(&text), "You saved")?;
        db::get_file_meta(&room.conn, &id)
    })?;
    // Every OTHER way of changing a file broadcasts this; the plain Save in the
    // built-in editor did not, so the Library, the Scripts index and the front
    // page all kept showing what the file used to say.
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// ADD-27: whatever is about to happen to `id`, a live recording writing into
/// it must be stopped first, or the engine keeps flushing into a row that is
/// leaving the library. The stop is NOT awaited — its final flush would only
/// recreate nothing; dropping the session is what matters.
fn stop_recording_into(rec: &super::RecState, id: &str) {
    let mut session = rec.session.lock().unwrap();
    if session.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
        if let Some(live) = session.take() {
            let (done_tx, _) = std::sync::mpsc::channel();
            let _ = live.handle.tx.send(crate::recording::EngineMsg::Stop { done: done_tx });
        }
    }
}

/// Delete a file the way a person means it: it leaves the room's views and
/// stops counting as present, and it is recoverable from the trash until
/// someone explicitly destroys it.
///
/// This is the ONLY delete the UI can reach without a second, differently
/// worded confirmation. "Ask before AI edits files" is off by owner decision,
/// so the app changes and removes things without asking — the trash is the net
/// under that, and a net with a hole in it is not one.
#[tauri::command]
pub fn trash_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, super::RecState>,
    id: String,
) -> Result<(), String> {
    stop_recording_into(&rec, &id);
    // A Tauri command invoked from the window IS the person: the agent driver
    // is blocked from clicking a destructive confirm (ADD-25), so nothing else
    // can get here. An AI-initiated delete would come through `db::trash_file`
    // with `TrashActor::Agent(tool)` and be labelled as such in the trash.
    state.with_room(|room| db::trash_file(&room.conn, &id, db::TrashActor::User))?;
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(())
}

/// Everything currently in this room's trash, newest deletion first.
#[tauri::command]
pub fn list_trashed_files(state: State<'_, AppState>) -> Result<Vec<crate::commands::TrashedFile>, String> {
    state.with_room(|room| db::list_trashed_files(&room.conn))
}

/// Put a trashed file back — row, bytes, versions, transcript and search index
/// (keyword AND vector, see `db::restore_file`). Returns the restored file's
/// metadata, which is also the proof it is really back: `db::get_file_meta`
/// refuses to return a trashed row, so a `Ok(meta)` here cannot be reported for
/// a file that is still in the trash.
#[tauri::command]
pub fn restore_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        db::restore_file(&room.conn, &id)?;
        db::get_file_meta(&room.conn, &id)
    })?;
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// Destroy one trashed file for good. Named for what it does: no caller reaches
/// this by way of an ordinary "delete".
///
/// Refuses anything that is not already in the trash, so permanent deletion is
/// always a SECOND, separate act — a file cannot go from the library to gone in
/// one click, however that click was made.
#[tauri::command]
pub fn delete_file_permanently(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, super::RecState>,
    id: String,
) -> Result<(), String> {
    stop_recording_into(&rec, &id);
    state.with_room(|room| {
        let trashed: bool = room
            .conn
            .query_row(
                "SELECT count(*) FROM files WHERE id = ?1 AND trashed_at IS NOT NULL",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0;
        if !trashed {
            return Err("Only a file already in the trash can be deleted permanently.".into());
        }
        db::delete_file(&room.conn, &id)
    })?;
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(())
}

/// Destroy everything in the trash. Returns how many files were destroyed, so
/// the caller can say what actually happened instead of "trash emptied" over an
/// empty trash.
#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let destroyed = state.with_room(|room| db::empty_trash(&room.conn))?;
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(destroyed)
}

#[tauri::command]
pub fn save_generated_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<FileMeta, String> {
    save_generated_impl(&app, state.inner(), name, content)
}

/// The command's body, callable from inside another command (the chat ask
/// path's deterministic "save that" bypass reuses the exact Save-to-room
/// logic instead of asking the model to reproduce it).
pub(crate) fn save_generated_impl(
    app: &tauri::AppHandle,
    state: &AppState,
    name: String,
    content: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        let name = if extraction::extension_of(&name).is_empty() {
            format!("{name}.md")
        } else {
            name
        };
        let mime = mime_guess::from_path(&name)
            .first_or(mime_guess::mime::TEXT_PLAIN)
            .essence_str()
            .to_string();
        db::insert_file(
            &room.conn,
            &name,
            &mime,
            content.as_bytes(),
            Some(&content),
            "generated",
        )
    })?;
    // A new file (e.g. a New script .py) must re-index the Scripts page etc.
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

// ---------------------------------------------------------------- import link (ADD-12)

/// A safe, readable Markdown filename derived from a page title (or its URL when
/// the title is empty). Pure so it can be unit-tested.
pub(crate) fn link_file_name(title: &str, url: &str) -> String {
    let base = title.trim();
    let base = if base.is_empty() { url } else { base };
    // Fold path/reserved characters and collapse whitespace to keep one clean
    // line that is valid as a file name on macOS.
    let folded: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect();
    let cleaned = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut name: String = cleaned.chars().take(80).collect();
    name = name.trim().to_string();
    if name.is_empty() {
        name = "Web page".into();
    }
    format!("{name}.md")
}

/// ADD-26: a YouTube transcript failure that means "this video just has no
/// captions" (as opposed to a network/parse error) — the trigger for the
/// download-and-transcribe fallback. Matches the messages youtube_transcript
/// raises for the no-caption cases.
fn is_missing_captions(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("no captions") || e.contains("came back empty") || e.contains("could not be read")
}

/// ADD-12: fetch a web page and save a readable offline copy as a Markdown file.
/// Uses `web::fetch_page` WITH the SEC-5 guard, so private/loopback addresses
/// are refused. An explicit user action, so it works even when the AI's web
/// tools are off. The saved file (source "web") is indexed and searchable.
#[tauri::command]
pub async fn import_link(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<FileMeta, String> {
    // An explicit user action still obeys the room's own internet switch: with
    // it off the settings page promises the room stays offline, and fetching a
    // page on a click would make that promise false. (The AI's `save_link` has
    // always checked; this inlet did not.)
    require_web_access(state.inner())?;
    import_link_and_index(&app, state.inner(), &url).await
}

/// [`import_link_impl`] PLUS the three things every save path owes the room.
///
/// A page saved without them sits un-scanned and un-indexed until something
/// unrelated triggers a pass — and the privacy redactor's substitution table is
/// built from what the scan found, so names and identifiers that appear only in
/// that page can go out to a cloud engine unmasked on the very next turn. That
/// is exactly the shape of the `save_link` path, where a cloud call usually
/// follows immediately.
///
/// Every caller of `import_link_impl` wants THIS; the inner function only
/// writes the row.
pub(crate) async fn import_link_and_index(
    app: &tauri::AppHandle,
    state: &AppState,
    url: &str,
) -> Result<FileMeta, String> {
    let meta = import_link_impl(state, url).await?;
    let room_path = state.with_room(|room| Ok(room.path.clone()))?;
    schedule_auto_index(app, room_path);
    schedule_privacy_scan(app.clone());
    {
        use tauri::Emitter;
        let _ = app.emit("room-files-changed", ());
    }
    Ok(meta)
}

/// BROWSE-3: the ＋ button on a search result — save this page into the room as
/// a source the assistant can actually read.
///
/// One funnel, three branches, all existing machinery:
/// - a YouTube link saves its captions (no video download),
/// - an ordinary readable page saves a Markdown copy,
/// - anything that isn't text (a PDF, an image, a media file) goes through the
///   binary funnel — [`import_download`] — so it gets the 800 MB cap, MarkItDown
///   extraction and the OCR/STT lanes for free.
///
/// The text branches deliberately go through [`save_web_markdown`], which
/// records `origin_url` and schedules the index and privacy passes — the three
/// things the older page-import paths each forgot in a different way.
pub(crate) async fn import_web_source(
    app: &tauri::AppHandle,
    state: &AppState,
    url: &str,
    fallback_title: &str,
) -> Result<FileMeta, String> {
    if web::youtube_video_id(url).is_some() {
        let (title, text) = match web::youtube_transcript(url).await {
            Ok(v) => v,
            Err(e) if is_missing_captions(&e) => {
                return Err(
                    "This video has no captions to save. Open it and use Save → Download video \
                     to transcribe it on this Mac."
                        .into(),
                )
            }
            Err(e) => return Err(e),
        };
        let title = pick_title(&title, fallback_title, url);
        return save_web_markdown(app, state, url, &format!("{title} (transcript)"), &text);
    }
    match web::fetch_readable(url).await {
        Ok((title, text, _html)) if !text.trim().is_empty() => {
            let title = pick_title(&title, fallback_title, url);
            save_web_markdown(app, state, url, &title, &text)
        }
        // Not a readable text page — a PDF, an image, a media file. That is a
        // perfectly good source; it just belongs in the binary funnel.
        _ => match web::download_to_temp(url, web::MAX_DOWNLOAD_BYTES, None, |_, _| {}).await? {
            web::DownloadOutcome::Done(d) => {
                let name = d.file_name.clone();
                import_download(app, &d.path, &name, url)
            }
            // import_download names the real limit the same way; say it here
            // too, because nothing was staged to hand it.
            web::DownloadOutcome::TooLarge => Err(format!(
                "That file is larger than the {} MB limit for a room file.",
                web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
            )),
        },
    }
}

/// First non-empty of: the page's own title, the search result's title, the URL.
fn pick_title(page: &str, fallback: &str, url: &str) -> String {
    for candidate in [page.trim(), fallback.trim()] {
        if !candidate.is_empty() {
            return candidate.to_string();
        }
    }
    url.to_string()
}

/// Save one fetched web page as a room file, the way every web import should
/// have been doing it.
///
/// Three fixes ride here, each of which was a real gap: `origin_url` is recorded
/// (the column existed and only `import_download` ever wrote it), and the
/// auto-index and privacy scans are scheduled (only the binary funnel did).
/// A web page saved through here is indistinguishable from a downloaded file in
/// everything that matters downstream.
pub(crate) fn save_web_markdown(
    app: &tauri::AppHandle,
    state: &AppState,
    url: &str,
    title: &str,
    text: &str,
) -> Result<FileMeta, String> {
    let (meta, room_path) = state.with_room(|room| {
        let saved = db::current_date(&room.conn);
        // The web-research funnel: one call per source, and a run that revisits a
        // site the room already has produced a second file with the identical
        // name. Step past what is already there (see `db::available_name`).
        let name = db::available_name(&room.conn, &link_file_name(title, url))?;
        let content = format!("# {title}\n\nSource: {url}\nSaved: {saved}\n\n{text}");
        let meta = db::insert_file_from_url(
            &room.conn,
            &name,
            "text/markdown",
            content.as_bytes(),
            Some(&content),
            "web",
            Some(url),
        )?;
        Ok((meta, room.path.clone()))
    })?;
    schedule_auto_index(app, room_path);
    schedule_privacy_scan(app.clone());
    {
        use tauri::Emitter;
        let _ = app.emit("room-files-changed", ());
    }
    Ok(meta)
}

/// The command's body: fetch the page and write the row. Nothing more —
/// callers must go through [`import_link_and_index`] so the auto-index and the
/// privacy scan happen too.
///
/// PRIVATE on purpose. It used to be `pub(crate)`, and the assistant's
/// `save_link` tool called it directly: the page it saved was never scanned, so
/// names appearing only in that page went to a cloud engine unmasked on the
/// very next turn. Module privacy is the guard now — a caller outside this file
/// cannot reach the un-scanned write at all.
async fn import_link_impl(state: &AppState, url: &str) -> Result<FileMeta, String> {
    // ADD-19: a YouTube link imports the video's own captions as a timestamped
    // transcript (no video download) instead of the watch page's JS soup.
    let is_youtube = web::youtube_video_id(url).is_some();
    let (title, text) = if is_youtube {
        // ADD-26: when a video simply has no captions, signal the frontend with
        // a sentinel so it can auto-fall-back to downloading the video and
        // transcribing it on-device — rather than surfacing a dead end. Genuine
        // failures (network, blocked) still propagate verbatim.
        match web::youtube_transcript(&url).await {
            Ok(v) => v,
            Err(e) if is_missing_captions(&e) => return Err("YT_NO_CAPTIONS".into()),
            Err(e) => return Err(e),
        }
    } else {
        let page = web::fetch_page(&url).await?;
        (page.title, page.text)
    };
    state.with_room(|room| {
        let saved = db::current_date(&room.conn);
        let name = if is_youtube {
            link_file_name(&format!("{title} (transcript)"), &url)
        } else {
            link_file_name(&title, &url)
        };
        let content = format!("# {title}\n\nSource: {url}\nSaved: {saved}\n\n{text}");
        // Record where it came from. The column has existed since BROWSE-2 and
        // only the binary funnel ever wrote it, so a page saved through "Web
        // link" (or the agent's save_link) forgot its own address.
        db::insert_file_from_url(
            &room.conn,
            &name,
            "text/markdown",
            content.as_bytes(),
            Some(&content),
            "web",
            Some(url),
        )
    })
}

// ---------------------------------------------------------------- summarize room (ADD-17)

#[tauri::command]
pub fn rename_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state.with_room(|room| db::rename_file(&room.conn, &id, &name))?;
    // A rename can turn a note into a script (.md → .py) or back, and several
    // views cache file names — signal a room-files change so the Library, the
    // Scripts index and the front page all re-read.
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_content_mismatch_catches_executables_wearing_a_safe_extension() {
        // ELF, Mach-O (both byte orders, 32/64-bit), PE, and a shebang script —
        // each claiming to be an inert extension like .pdf.
        assert!(dangerous_content_mismatch(b"\x7fELF\x02\x01\x01", "pdf"));
        assert!(dangerous_content_mismatch(b"MZ\x90\x00\x03", "docx"));
        assert!(dangerous_content_mismatch(&[0xFE, 0xED, 0xFA, 0xCE, 0, 0], "png"));
        assert!(dangerous_content_mismatch(&[0xFE, 0xED, 0xFA, 0xCF, 0, 0], "jpg"));
        assert!(dangerous_content_mismatch(&[0xCE, 0xFA, 0xED, 0xFE, 0, 0], "txt"));
        assert!(dangerous_content_mismatch(&[0xCF, 0xFA, 0xED, 0xFE, 0, 0], "csv"));
        assert!(dangerous_content_mismatch(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0], "xlsx"));
        assert!(dangerous_content_mismatch(b"#!/bin/sh\necho hi\n", "pdf"));
    }

    #[test]
    fn dangerous_content_mismatch_leaves_ordinary_files_alone() {
        assert!(!dangerous_content_mismatch(b"%PDF-1.4", "pdf"), "a real PDF is not flagged");
        assert!(!dangerous_content_mismatch(b"PK\x03\x04", "docx"), "a real docx is not flagged");
        assert!(!dangerous_content_mismatch(b"just plain text", "txt"));
        assert!(!dangerous_content_mismatch(b"", "pdf"), "an empty file is not flagged");
    }

    #[test]
    fn dangerous_content_mismatch_does_not_relabel_a_file_already_claiming_to_be_executable() {
        // The claimed extension already told the user to be careful — nothing
        // to correct, and nothing to rename.
        for ext in ["sh", "py", "js", "exe", "bin", "app", "command", "bat", "ps1"] {
            assert!(
                !dangerous_content_mismatch(b"\x7fELF\x02\x01\x01", ext),
                "{ext} already declares itself executable"
            );
        }
    }

    #[test]
    fn link_file_name_is_safe_and_falls_back() {
        assert_eq!(link_file_name("Hello World", "https://x.com"), "Hello World.md");
        // Path/reserved characters are folded, whitespace collapsed.
        assert_eq!(link_file_name("A/B: c\td", "https://x.com"), "A B c d.md");
        // Empty title falls back to the URL (reserved chars folded), never empty.
        assert_eq!(link_file_name("   ", "https://ex.com/p"), "https ex.com p.md");
    }

    /// The file live QA rated 1/5: Turkish prose stored in ISO-8859-9, which
    /// the Encoding Standard reads as windows-1254.
    fn turkish_txt_bytes() -> Vec<u8> {
        let (bytes, _, had_errors) =
            encoding_rs::WINDOWS_1254.encode("Türkçe karakterler: ğ ı ş İ Ğ Ş");
        assert!(!had_errors, "fixture must be representable in the Turkish page");
        assert!(std::str::from_utf8(&bytes).is_err(), "fixture must not be valid UTF-8");
        bytes.into_owned()
    }

    #[test]
    fn a_legacy_encoded_text_file_is_readable_and_offers_an_editor() {
        // It used to arrive as U+FFFD (from_utf8_lossy) AND with `editable`
        // false, so the viewer showed boxes and the header had no Edit button —
        // the two halves of the 1/5.
        let bytes = turkish_txt_bytes();
        let d = decode_stored_text("mektup.txt", "text/plain", &bytes, None).unwrap();
        assert_eq!(d.encoding, "windows-1254");
        assert_eq!(d.source, extraction::EncodingSource::Detected);
        assert!(!d.lossy);
        assert!(!d.text.contains('\u{FFFD}'), "{:?}", d.text);
        assert!(d.editable, "a file we could read whole must be editable");
        assert!(
            d.options.iter().any(|o| o.name == "UTF-8"),
            "the picker must always offer a way back to UTF-8"
        );

        // The compare view reads the same bytes the same way, or a legacy file
        // shows a phantom whole-file diff against itself.
        let compared = content_text("mektup.txt", "text/plain", &bytes, None).unwrap();
        assert_eq!(compared, d.text);
    }

    #[test]
    fn choosing_an_encoding_re_reads_the_bytes_and_can_shut_the_editor() {
        let bytes = turkish_txt_bytes();
        let auto = decode_stored_text("mektup.txt", "text/plain", &bytes, None).unwrap();

        // The override is a genuine second reading of the ORIGINAL bytes, not a
        // re-interpretation of the string we already decoded.
        let cyrillic =
            decode_stored_text("mektup.txt", "text/plain", &bytes, Some("windows-1251")).unwrap();
        assert_eq!(cyrillic.source, extraction::EncodingSource::Chosen);
        assert_eq!(cyrillic.encoding, "windows-1251");
        assert_ne!(cyrillic.text, auto.text);

        // Read as UTF-8 the same bytes are meaningless, so the text on screen is
        // NOT the file — Edit goes away rather than offering to save boxes over it.
        let as_utf8 = decode_stored_text("mektup.txt", "text/plain", &bytes, Some("utf-8")).unwrap();
        assert!(as_utf8.lossy);
        assert!(as_utf8.text.contains('\u{FFFD}'));
        assert!(!as_utf8.editable, "a lossy reading must never be saveable");
    }

    #[test]
    fn re_decoding_is_refused_where_it_would_be_a_lie() {
        // A label the decoder doesn't know: answering with SOME other encoding's
        // reading would look exactly like success.
        assert!(decode_stored_text("a.txt", "text/plain", b"hi", Some("klingon-1")).is_err());
        // An extracted-text format has no charset to change — its reader already
        // decided how to read it.
        let err = decode_stored_text("report.pdf", "application/pdf", b"%PDF-1.4", None)
            .expect_err("a PDF has no text encoding to pick");
        assert!(err.contains("read out of the file"), "{err}");
    }

    #[test]
    fn the_viewer_and_the_compare_view_agree_on_every_kind() {
        // These rules used to be written out twice, kept in step only by a
        // comment asking future editors to match them — and they had already
        // drifted. Both readers now go through `classify_file`, so this pins
        // the table itself.
        let sheet = classify_file("budget.xlsx", "application/vnd.ms-excel", 10_000);
        assert_eq!(sheet.kind, "sheet");
        // A spreadsheet DOES have comparable text: the compare view used to be
        // handed None for it, so reviewing an AI's cell edits was impossible.
        assert!(matches!(sheet.text, TextSource::Extracted));
        assert_eq!(
            content_text("budget.xlsx", "application/vnd.ms-excel", b"PK\x03\x04", Some("A1 | 5".into())).as_deref(),
            Some("A1 | 5")
        );

        // A scan's recognized text reaches the picture viewer instead of being
        // computed, indexed and then withheld.
        let image = classify_file("scan.png", "image/png", 10_000);
        assert_eq!(image.kind, "image");
        assert!(image.needs_bytes());
        assert!(matches!(image.text, TextSource::Extracted));

        // Regression, then its sequel. First an image too big for the viewer
        // payload went down the binary branch, so a large scan OCR HAD read
        // opened as "no preview available". That was fixed by keeping its text.
        // Now the bytes STREAM, so the same scan keeps the real image viewer —
        // there is no size at which a picture stops being a picture.
        let huge = classify_file("map.tif", "image/tiff", 400 * 1024 * 1024);
        assert_eq!(huge.kind, "image", "an oversized scan lost its picture viewer");
        assert!(huge.needs_bytes(), "streamed bytes have no ceiling");
        assert!(matches!(huge.text, TextSource::Extracted));
        assert_eq!(
            content_text("map.tif", "image/tiff", &[0u8; 64], Some("Sheet 3 of 12".into()))
                .as_deref(),
            Some("Sheet 3 of 12")
        );

        // Raw-text kinds are editable; extracted ones never are.
        for (name, kind) in [("a.csv", "csv"), ("b.md", "markdown"), ("c.html", "html"), ("d.rs", "code")] {
            let v = classify_file(name, "text/plain", 100);
            assert_eq!(v.kind, kind);
            assert!(v.editable, "{name} should be editable in place");
            assert!(matches!(v.text, TextSource::Raw));
        }
        for name in ["a.pdf", "b.docx", "c.pptx"] {
            assert!(!classify_file(name, "application/octet-stream", 100).editable);
        }
    }

    #[test]
    fn a_huge_csv_or_markdown_file_stops_being_pushed_through_whole() {
        // csv and markdown had no size gate at all, so opening a large export
        // handed the entire file to the screen in one payload and hung the
        // window. This ceiling is the one that MUST stay: raw text crosses IPC
        // as an unclipped string precisely so saving it back can't truncate the
        // file. (Bytes that STREAM have no ceiling — see the image case above.)
        let big = crate::formats::MAX_RAW_TEXT_BYTES + 1;
        for name in ["export.csv", "notes.md", "page.html", "main.rs"] {
            let v = classify_file(name, "text/plain", big);
            assert_eq!(v.kind, "text", "{name} should fall back to a clipped preview");
            assert!(!v.editable, "{name} must not be editable at this size");
        }
        // Just under the gate they are still the real editors.
        assert_eq!(
            classify_file("export.csv", "text/csv", crate::formats::MAX_RAW_TEXT_BYTES).kind,
            "csv"
        );
    }

    /// The formats the registry newly claims must be readable end to end:
    /// classified to their own viewer AND yielding comparable text, or the
    /// version-compare view silently says "nothing to compare" for them.
    #[test]
    fn the_newly_supported_formats_classify_and_extract() {
        let cases: [(&str, &str, &[u8], &str); 4] = [
            ("notes.eml", "email", b"Subject: Hi\r\n\r\nbody text\r\n", "body text"),
            ("cues.srt", "subtitle", b"1\n00:00:01,000 --> 00:00:02,000\nHello.\n", "Hello."),
            ("logo.svg", "svg", b"<svg><text>Chart</text></svg>", "Chart"),
            ("run.log", "log", b"WARN disk full", "WARN disk full"),
        ];
        for (name, kind, bytes, needle) in cases {
            let v = classify_file(name, "application/octet-stream", bytes.len());
            assert_eq!(v.kind, kind, "{name} landed on the wrong viewer");
            // Raw-source kinds hand the viewer the bytes verbatim (it parses
            // them itself); the SEARCH text is derived separately.
            let text = content_text(name, "application/octet-stream", bytes, None)
                .expect("no comparable text");
            assert!(!text.is_empty(), "{name} produced no text for the compare view");
            let indexed = extraction::extract_text(name, bytes)
                .unwrap_or_else(|| panic!("{name} extracted no searchable text"));
            assert!(
                indexed.contains(needle),
                "{name} indexed {indexed:?}, expected it to contain {needle:?}"
            );
        }
    }

    /// Every `.rs` file under `src/`, as (relative path, contents).
    fn crate_sources() -> Vec<(String, String)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = path.strip_prefix(&root).unwrap_or(&path).display().to_string();
                out.push((rel, std::fs::read_to_string(&path).expect("source is utf-8")));
            }
        }
        out
    }

    /// The un-scanned page write must stay unreachable from anywhere else.
    ///
    /// `import_link_impl` writes the row and NOTHING else. The assistant's
    /// `save_link` tool used to call it directly, so a page the model saved was
    /// never privacy-scanned — and the redactor's substitution table is built
    /// from what the scan found, so names appearing only in that page went out
    /// to a cloud engine unmasked on the very next turn. It is a private `fn`
    /// now; this is the guard against someone widening it again.
    #[test]
    fn the_unscanned_page_write_is_reachable_only_from_this_file() {
        let offenders: Vec<String> = crate_sources()
            .into_iter()
            .filter(|(rel, src)| rel != "commands/files.rs" && src.contains("import_link_impl"))
            .map(|(rel, _)| rel)
            .collect();
        assert!(
            offenders.is_empty(),
            "these files reach the un-scanned page write directly instead of \
             import_link_and_index: {offenders:?}"
        );
    }

    /// The room's "stay offline" switch has to hold for the inlets a PERSON
    /// drives, not only for the model's tools.
    ///
    /// The agent's `save_link`/`download_url` arms have always checked
    /// `web_access_enabled`, and the browser's address bar goes through
    /// `browse::require_web_enabled` — but Add → Web link, the video import and
    /// the download-job button each reached the internet with the switch off.
    /// A settings page reading "Off — room stays offline" that still fetches on
    /// a click is a false privacy claim, so each inlet is pinned by name.
    #[test]
    fn every_user_driven_network_inlet_obeys_the_room_switch() {
        // (file, the function the check must sit in, what a user did to get here)
        let inlets = [
            ("commands/files.rs", "pub async fn import_link", "Add → Web link"),
            ("commands/ytdlp.rs", "pub async fn import_media_url", "video import"),
            (
                "commands/jobs/download.rs",
                "pub(crate) async fn start_download_job_inner",
                "the download-job button",
            ),
        ];
        let sources = crate_sources();
        for (file, signature, what) in inlets {
            let (_, src) = sources
                .iter()
                .find(|(rel, _)| rel == file)
                .unwrap_or_else(|| panic!("{file} has moved — re-point this test"));
            let at = src
                .find(signature)
                .unwrap_or_else(|| panic!("{file}: {signature} has moved — re-point this test"));
            // The check must be in the FIRST few lines of the body, before
            // anything is fetched. Generous window, tight claim.
            let body = &src[at..src.len().min(at + 1200)];
            assert!(
                body.contains("require_web_access"),
                "{what} ({file}) can still reach the internet with the room's switch off"
            );
        }
        // And the one place any of them could be told the room is offline reads
        // the same setting the Settings switch writes.
        let conn = crate::db::open_in_memory_schema();
        assert!(!web_access_enabled(&conn), "an unset switch means offline");
        crate::db::set_setting(&conn, "web_provider", "off").unwrap();
        assert!(!web_access_enabled(&conn));
        crate::db::set_setting(&conn, "web_provider", "on").unwrap();
        assert!(web_access_enabled(&conn));
    }

    #[test]
    fn detects_synced_paths() {
        assert!(is_synced_path(
            "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/room.roomai"
        ));
        assert!(is_synced_path(
            "/Users/x/Library/CloudStorage/Dropbox/room.roomai"
        ));
        assert!(!is_synced_path("/Users/x/Documents/room.roomai"));
    }

}
