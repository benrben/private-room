use super::*;

#[tauri::command]
pub fn import_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportReport, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let room_path = room.path.clone();
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
        // No size cap on imports (removed by request). We still surface a clean
        // error if the file can't be stat'd (missing / no permission); the only
        // hard ceiling now is SQLite's ~1 GB per-blob limit, which fails at
        // storage with its own message.
        if let Err(e) = std::fs::metadata(&path) {
            errors.push(format!("{file_name}: {e}"));
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
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
    Ok(ImportReport { imported, errors })
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

pub(crate) fn enqueue_stt(app: &tauri::AppHandle, job: JobMeta) {
    let app = app.clone();
    let tx = STT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<JobMeta>();
        std::thread::spawn(move || {
            for job in rx {
                run_stt_job(&app, job);
            }
        });
        tx
    });
    let _ = tx.send(job);
}

/// Read a job's stored bytes iff its room is still the open one. None → the room
/// was closed/switched while the job was queued; the worker drops the job.
pub(crate) fn read_job_bytes(app: &tauri::AppHandle, job: &JobMeta) -> Option<Vec<u8>> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) if room.path == job.room_path => {
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
            Some(room) if room.path == job.room_path => {
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
}

#[tauri::command]
pub fn list_files(state: State<'_, AppState>) -> Result<Vec<FileMeta>, String> {
    state.with_room(|room| db::list_files(&room.conn))
}

pub(crate) const MAX_VIEWER_BYTES: usize = 50 * 1024 * 1024;

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

    // Clip huge extracted text at a char boundary for preview/edit payloads.
    let clip = |mut t: String| {
        if t.len() > 1_000_000 {
            let mut cut = 1_000_000;
            while !t.is_char_boundary(cut) {
                cut -= 1;
            }
            t.truncate(cut);
            t.push_str("\n\n… (truncated preview)");
        }
        t
    };

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

    if extraction::is_image(&mime) && bytes.len() <= MAX_VIEWER_BYTES {
        return Ok(content("image", false, None, true));
    }
    match ext.as_str() {
        // PDF/DOCX carry their extracted text too, so the viewer can offer
        // "edit as text" (saved as a new copy — the binary can't round-trip).
        "pdf" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("pdf", false, extracted.map(clip), true))
        }
        "docx" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("docx", false, extracted.map(clip), true))
        }
        "xlsx" | "xls" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("sheet", false, None, true))
        }
        "csv" | "tsv" => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("csv", true, Some(text), false));
        }
        "md" | "markdown" => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("markdown", true, Some(text), false));
        }
        // HTML runs live in a sandboxed preview iframe (the "runner"); the raw
        // source is editable text that round-trips, so Edit drops to Monaco.
        "html" | "htm" if bytes.len() <= 10 * 1024 * 1024 => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("html", true, Some(text), false));
        }
        _ => {}
    }
    // Files whose bytes ARE text: viewable and safely editable in place.
    if extraction::is_text_extension(&ext) && bytes.len() <= 10 * 1024 * 1024 {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(content("code", true, Some(text), false));
    }
    // Binary formats we could still read text out of (pptx, markitdown output):
    // preview the extracted text read-only — editing it can't round-trip.
    if let Some(text) = extracted {
        let text = clip(text);
        return Ok(content("text", false, Some(text), false));
    }
    Ok(content("binary", false, None, false))
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
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<FileMeta, String> {
    state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let bytes = content.as_bytes();
        let text = extraction::extract_text(&name, bytes).unwrap_or_else(|| content.clone());
        store_file_bytes(&room.conn, &id, bytes, Some(&text), "You saved")?;
        db::get_file_meta(&room.conn, &id)
    })
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
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<FileMeta, String> {
    state.with_room(|room| {
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
    })
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
pub async fn import_link(state: State<'_, AppState>, url: String) -> Result<FileMeta, String> {
    // ADD-19: a YouTube link imports the video's own captions as a timestamped
    // transcript (no video download) instead of the watch page's JS soup.
    let is_youtube = web::youtube_video_id(&url).is_some();
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
        db::insert_file(
            &room.conn,
            &name,
            "text/markdown",
            content.as_bytes(),
            Some(&content),
            "web",
        )
    })
}

// ---------------------------------------------------------------- summarize room (ADD-17)

#[tauri::command]
pub fn rename_file(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.with_room(|room| db::rename_file(&room.conn, &id, &name))
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
