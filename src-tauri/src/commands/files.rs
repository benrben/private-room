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
                let needs_ocr = no_text && ocr::is_ocr_candidate(&mime, &ext);
                // ADD-18: recordings/videos get transcribed in the background,
                // the audio twin of the OCR fallback below.
                let needs_stt = no_text && stt::media_kind(&mime, &ext).is_some();
                match db::insert_file(&room.conn, &file_name, &mime, &bytes, text.as_deref(), "upload")
                {
                    Ok(meta) => {
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
    let mime = mime_guess::from_path(display_name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let mut text = extraction::extract_text(display_name, &bytes);
    if text.as_deref().map_or(true, |t| t.trim().is_empty()) && !extraction::is_image(&mime) {
        // MarkItDown reads from a path; the staged file still ends with the
        // real name ("{uuid}-{name}"), so its extension survives.
        text = extraction::markitdown_extract(&staged.to_string_lossy());
    }
    let _ = std::fs::remove_file(staged);

    let ext = extraction::extension_of(display_name);
    let no_text = text.as_deref().map_or(true, |t| t.trim().is_empty());
    let needs_ocr = no_text && ocr::is_ocr_candidate(&mime, &ext);
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

/// ADD-14: on-device OCR for one file. On success, store the recognized text
/// (prefixed so the AI can flag OCR uncertainty), re-index it, and tell the UI.
/// Any failure is silent — the file simply keeps having no text.
pub(crate) fn run_ocr_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let _ = app.emit("ocr-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    let Some(text) = ocr::recognize(&job.mime, &job.ext, &bytes) else {
        let _ = app.emit("ocr-progress", (&job.name, "none"));
        return;
    };
    let full_text = format!("(text recognized from scan)\n{text}");
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

pub(crate) const MAX_VIEWER_BYTES: usize = 50 * 1024 * 1024;

/// Ceiling on a file whose RAW bytes are handed over as editable text (csv,
/// markdown, html, code). That text crosses IPC unclipped — it has to, because
/// a clipped buffer saved back would truncate the file — so the ceiling is the
/// only guard. csv and markdown used to have none at all, which is how opening
/// a large exported spreadsheet hung the window.
pub(crate) const MAX_RAW_TEXT_BYTES: usize = 10 * 1024 * 1024;

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

/// Where a file's text comes from.
///
/// There is deliberately no "no text" case: `classify_file` sees only a name,
/// a MIME type and a length, so it can never know whether a file HAS text —
/// "the stored text is None" answers that, and both readers already handle it
/// (the viewer falls back to the binary card, the compare view to "no text to
/// compare"). A third variant only ever encoded a guess, and guessing it for
/// oversized images is what hid a large scan's OCR text from the viewer.
pub(crate) enum TextSource {
    /// The stored bytes ARE the text (csv, markdown, html, code).
    Raw,
    /// Text was read OUT of a binary format (pdf, docx, xlsx, pptx, OCR, STT).
    Extracted,
}

/// What a file looks like to the app: which viewer opens it, where its text
/// comes from, whether that text round-trips (so it can be edited in place),
/// and whether the viewer needs the raw bytes.
///
/// This is the ONE table behind BOTH `get_file_content` (the viewer) and
/// `content_text` (the version-compare view). They used to keep two hand-written
/// copies of these rules, kept in step only by a comment asking future editors
/// to match them — and they had already drifted, which is why comparing two
/// versions of a spreadsheet always said there was nothing to compare.
pub(crate) struct FileView {
    pub kind: &'static str,
    pub text: TextSource,
    pub editable: bool,
    pub needs_bytes: bool,
}

pub(crate) fn classify_file(name: &str, mime: &str, len: usize) -> FileView {
    let ext = extraction::extension_of(name);
    let view = |kind, text, editable, needs_bytes| FileView { kind, text, editable, needs_bytes };
    // Images: the picture itself, plus whatever OCR read off it (ADD-14) — the
    // recognized text was being computed, indexed and then withheld from the
    // viewer, so it could never be seen, copied or corrected.
    if extraction::is_image(mime) {
        return if len <= MAX_VIEWER_BYTES {
            view("image", TextSource::Extracted, false, true)
        } else {
            // Too big to hand the picture over base64 — drop the RAW BYTES, not
            // the text. A 60 MB TIFF scan of a map or a poster that OCR read
            // successfully opened as a read-only text preview before the
            // refactor; sending it down the binary branch put its recognized
            // text (still stored and still indexed) out of reach of the viewer
            // and of "Copy all text".
            view("text", TextSource::Extracted, false, false)
        };
    }
    match ext.as_str() {
        // PDF/DOCX/XLSX carry their extracted text too, so the viewer can offer
        // "edit as text" and the compare view has something to diff.
        "pdf" if len <= MAX_VIEWER_BYTES => return view("pdf", TextSource::Extracted, false, true),
        "docx" if len <= MAX_VIEWER_BYTES => return view("docx", TextSource::Extracted, false, true),
        "xlsx" | "xls" if len <= MAX_VIEWER_BYTES => {
            return view("sheet", TextSource::Extracted, false, true)
        }
        "csv" | "tsv" if len <= MAX_RAW_TEXT_BYTES => return view("csv", TextSource::Raw, true, false),
        "md" | "markdown" if len <= MAX_RAW_TEXT_BYTES => {
            return view("markdown", TextSource::Raw, true, false)
        }
        // HTML runs live in a sandboxed preview iframe (the "runner"); the raw
        // source is editable text that round-trips, so Edit drops to Monaco.
        "html" | "htm" if len <= MAX_RAW_TEXT_BYTES => {
            return view("html", TextSource::Raw, true, false)
        }
        _ => {}
    }
    // Files whose bytes ARE text: viewable and safely editable in place.
    if extraction::is_text_extension(&ext) && len <= MAX_RAW_TEXT_BYTES {
        return view("code", TextSource::Raw, true, false);
    }
    // Everything else (pptx, MarkItDown output, an oversized pdf or csv):
    // read-only preview of whatever text we managed to extract.
    view("text", TextSource::Extracted, false, false)
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
        TextSource::Raw => Some(clip_preview(String::from_utf8_lossy(bytes).into_owned())),
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
        let token = stage_media_bytes(&media, std::mem::take(&mut bytes), &playable);
        return Ok(FileContent {
            kind: k.into(),
            name,
            mime,
            editable: false,
            text: extracted.map(clip),
            data_b64: None,
            media_token: Some(token),
        });
    }

    let content = |kind: &str, editable: bool, text: Option<String>, b64: bool| FileContent {
        kind: kind.into(),
        name: name.clone(),
        mime: mime.clone(),
        editable,
        text,
        data_b64: if b64 {
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
        } else {
            None
        },
        media_token: None,
    };

    let view = classify_file(&name, &mime, bytes.len());
    match view.text {
        // The bytes ARE the text: handed over whole (never clipped — a clipped
        // buffer saved back would truncate the file), which is what
        // MAX_RAW_TEXT_BYTES in `classify_file` bounds.
        TextSource::Raw => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            // Bytes that aren't UTF-8 came back with U+FFFD in place of every
            // unreadable one; saving that would destroy the original encoding's
            // accented letters for good, so the file is preview-only.
            let editable = view.editable && std::str::from_utf8(&bytes).is_ok();
            Ok(content(view.kind, editable, Some(text), view.needs_bytes))
        }
        TextSource::Extracted => match extracted {
            Some(text) => Ok(content(view.kind, view.editable, Some(clip(text)), view.needs_bytes)),
            // No text was read out of it after all (an image awaiting OCR keeps
            // its viewer; anything else falls back to the binary card).
            None if view.needs_bytes => Ok(content(view.kind, false, None, true)),
            None => Ok(content("binary", false, None, false)),
        },
    }
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

#[tauri::command]
pub fn delete_file(
    state: State<'_, AppState>,
    rec: State<'_, super::RecState>,
    id: String,
) -> Result<(), String> {
    // ADD-27: deleting the file a live recording writes into must stop the
    // engine first, or it keeps flushing into a row that no longer exists.
    // The stop is NOT awaited — its final flush would only recreate nothing
    // (the row is going away); dropping the session is what matters.
    {
        let mut session = rec.session.lock().unwrap();
        if session.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
            if let Some(live) = session.take() {
                let (done_tx, _) = std::sync::mpsc::channel();
                let _ = live.handle.tx.send(crate::recording::EngineMsg::Stop { done: done_tx });
            }
        }
    }
    state.with_room(|room| db::delete_file(&room.conn, &id))
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
        let name = link_file_name(title, url);
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
pub(crate) async fn import_link_impl(state: &AppState, url: &str) -> Result<FileMeta, String> {
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
        web::fetch_page(&url).await?
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
    fn link_file_name_is_safe_and_falls_back() {
        assert_eq!(link_file_name("Hello World", "https://x.com"), "Hello World.md");
        // Path/reserved characters are folded, whitespace collapsed.
        assert_eq!(link_file_name("A/B: c\td", "https://x.com"), "A B c d.md");
        // Empty title falls back to the URL (reserved chars folded), never empty.
        assert_eq!(link_file_name("   ", "https://ex.com/p"), "https ex.com p.md");
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
        assert!(image.needs_bytes);
        assert!(matches!(image.text, TextSource::Extracted));

        // Regression: an image too big for the viewer payload went down the
        // binary branch with TextSource::None, so a large scan OCR HAD read
        // opened as "no preview available" and its text — stored and indexed —
        // could no longer be read or copied. Only the raw bytes are dropped.
        let huge = classify_file("map.tif", "image/tiff", MAX_VIEWER_BYTES + 1);
        assert_eq!(huge.kind, "text", "an oversized scan lost its text preview");
        assert!(!huge.needs_bytes, "the picture itself is still too big to send");
        assert!(matches!(huge.text, TextSource::Extracted));
        assert_eq!(
            content_text(
                "map.tif",
                "image/tiff",
                &vec![0u8; MAX_VIEWER_BYTES + 1],
                Some("Sheet 3 of 12".into())
            )
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
        // Web pages, code and images all had a size gate; csv and markdown had
        // none, so opening a large export handed the entire file to the screen
        // in one payload and hung the window.
        let big = MAX_RAW_TEXT_BYTES + 1;
        for name in ["export.csv", "notes.md", "page.html", "main.rs"] {
            let v = classify_file(name, "text/plain", big);
            assert_eq!(v.kind, "text", "{name} should fall back to a clipped preview");
            assert!(!v.editable, "{name} must not be editable at this size");
        }
        // Just under the gate they are still the real editors.
        assert_eq!(classify_file("export.csv", "text/csv", MAX_RAW_TEXT_BYTES).kind, "csv");
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
