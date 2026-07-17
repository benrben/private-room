use super::*;

/// The one canonical, overwrite-in-place summary file (ADD-17). ADD-22: now HTML
/// (the Summarize-Room button generates an HTML page rendered in the sandboxed
/// viewer). The legacy Markdown name is still recognized for exclusion below.
pub(crate) const SUMMARY_FILE_NAME: &str = "Room summary.html";
/// Cap per run so a huge room stays within the small local context; the rest are
/// listed by name with a note.
pub(crate) const MAX_SUMMARY_FILES: usize = 50;

/// True for the app's own generated summary file — excluded from its own summary.
/// Matches both the current HTML name and the legacy "Room summary.md" so an old
/// room's Markdown summary isn't fed back into the new one. A user-uploaded file
/// that happens to share the name is NOT excluded (source must be "generated").
pub(crate) fn is_summary_file(name: &str, source: &str) -> bool {
    (name == SUMMARY_FILE_NAME || name == "Room summary.md") && source == "generated"
}

/// ADD-17 map step: describe a single file in one sentence. ADD-27: `text` is
/// the file's FULL extracted text; the sidecar noise-filters it and, when it
/// doesn't fit one window, the MODEL drives the reading (a `read_text` tool loop)
/// before a final schema-constrained call produces the sentence.
///
/// MIGRATION Phase 3: all of that compute now lives in the sidecar's
/// `/summarize_file` — the smart_filter, the read_text paging, the final
/// structured call and `clean_one_liner` are byte-reproduced there. Rust gathers
/// the full text (callers already do) and stores the returned one-liner. The
/// error rule is preserved by the sentinel mapping: the endpoint returns 502
/// (→ `OLLAMA_DOWN`/`MODEL_MISSING:<model>`) only for a FATAL engine failure and
/// otherwise degrades internally to a samples-only answer, so this function's
/// callers keep aborting the run only on those two sentinels. `keep_alive` still
/// lets the background filler release the model (CHG-22).
pub(crate) async fn summarize_one_file(
    model: &str,
    name: &str,
    mime: &str,
    text: &str,
    keep_alive: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "name": name,
        "text": text,
        "mime": mime,
        "base_url": ollama::resolved_base_url(),
        "keep_alive": keep_alive,
    });
    let v = crate::sidecar::sidecar_json("/summarize_file", &body)
        .await
        .map_err(|e| e.sentinel(Some(model)))?;
    // Already clean_one_liner'd on the sidecar (≤200 chars, may be "").
    Ok(v["summary"].as_str().unwrap_or_default().to_string())
}

/// ADD-17 reduce step: one call producing the "What this room is for" paragraph
/// and three suggested questions, given the per-file one-liners for context. The
/// deterministic file list is assembled by the caller (never invented here).
pub(crate) async fn combine_summary(
    model: &str,
    room_name: &str,
    memories: &[String],
    file_lines: &str,
) -> Result<(String, Vec<String>), String> {
    // MIGRATION Phase 3: the two reduce calls (free-text purpose + string-array
    // questions), the context assembly and the questions cap now live in the
    // sidecar's `/combine_summary`. Rust still builds `file_lines` deterministically
    // from the cached per-file one-liners (see write_room_summary). Error rule
    // reproduced: the purpose call propagates (→ this `?`), the questions call
    // swallows to `[]` — both handled inside the endpoint, so a 502 here means the
    // purpose call failed, mapped to the same sentinel it produced before.
    let body = serde_json::json!({
        "model": model,
        "room_name": room_name,
        "file_lines": file_lines,
        "memories": memories,
        "base_url": ollama::resolved_base_url(),
        "keep_alive": KEEP_ALIVE_WARM,
    });
    let v = crate::sidecar::sidecar_json("/combine_summary", &body)
        .await
        .map_err(|e| e.sentinel(Some(model)))?;
    let purpose = v["purpose"].as_str().unwrap_or_default().to_string();
    let questions: Vec<String> = v["questions"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok((purpose, questions))
}

/// ADD-17: generate (or refresh) the room's single "Room summary.md" via a
/// two-step map-reduce, caching each file's one-liner so re-runs only summarize
/// new or changed files. Emits `summarize-progress` while running. Writes
/// nothing if the model is unreachable (returns the normal friendly error).
#[tauri::command]
pub async fn summarize_room(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;

    // Phase 1 (locked): pull the file rows that need a one-liner. The room's
    // path pins the final write — the map loop below awaits model calls, and a
    // room swapped mid-run must never receive this room's summary.
    let (explicit_model, files, room_path) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let files: Vec<db::SummaryFile> = db::list_files_for_summary(conn)?
            .into_iter()
            .filter(|f| !is_summary_file(&f.name, &f.source))
            .collect();
        (model_setting(conn), files, room.path.clone())
    };

    if files.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }

    // The map-reduce drives the Ollama API directly, so an external CLI engine
    // falls back to the default model; a `:cloud` model works (ADD-29 parity).
    let models = ollama::list_models()
        .await
        .map_err(|_| "The local AI (Ollama) isn't running — start it and try again.".to_string())?;
    if models.is_empty() {
        return Err("No local AI model is installed yet — download one first.".into());
    }
    let mut model = explicit_model.unwrap_or_else(|| best_default(&models));
    if is_external_engine(&model) {
        model = best_default(&models);
    }

    let to_do = files.len().min(MAX_SUMMARY_FILES);

    // Map: fill the per-file one-liner CACHE for any gaps. The reduce + HTML
    // write below (write_room_summary) reads the cache back, so this loop and
    // the ADD-30 deep-summary job feed the exact same writer.
    for (i, f) in files.iter().take(MAX_SUMMARY_FILES).enumerate() {
        let _ = window.emit(
            "summarize-progress",
            format!("Summarizing file {} of {}…", i + 1, to_do),
        );
        if f.ai_summary.is_some() || f.text.as_deref().map_or(true, |t| t.trim().is_empty()) {
            // Cached already, or no extractable text (e.g. an image without
            // OCR): the writer lists it by name and type, never invents content.
            continue;
        }
        // ADD-27: hand the summarizer the FULL extracted text (the listing
        // row only carries a 1500-char probe); it filters and pages through
        // it itself. Falls back to the probe if the row vanished mid-run.
        let full = {
            let guard = state.room.lock().unwrap();
            guard
                .as_ref()
                .and_then(|room| db::get_file_extracted_text(&room.conn, &f.id))
        }
        .unwrap_or_else(|| f.text.clone().unwrap_or_default());
        // CHG-26: one flaky file must not abort the whole run. A
        // non-transient error (Ollama down / model missing) still aborts —
        // every remaining call would fail too — but a one-off error just
        // degrades this file to name-and-type (and, being uncached, retries
        // on the next run).
        match summarize_one_file(&model, &f.name, &f.mime, &full, KEEP_ALIVE_WARM).await {
            Ok(liner) => {
                if !liner.is_empty() {
                    if let Some(room) = state.room.lock().unwrap().as_ref() {
                        let _ = db::set_file_ai_summary(&room.conn, &f.id, &liner);
                    }
                }
            }
            Err(e) if e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING") => {
                return Err(e);
            }
            Err(_) => {}
        }
    }

    write_room_summary(&window, state.inner(), &model, Some(&room_path)).await
}

/// Resolve the open room, honoring an optional pin (the path of the room the
/// caller started in). With a pin, a room that was closed or swapped mid-run
/// counts as gone — the caller's writes must never land in whatever room
/// happens to be open NOW.
fn pinned_room<'a>(guard: &'a Option<Room>, pin: Option<&str>) -> Result<&'a Room, String> {
    match pin {
        Some(p) => guard
            .as_ref()
            .filter(|r| r.path == p)
            .ok_or_else(|| "the room this job belongs to was closed".to_string()),
        None => guard.as_ref().ok_or_else(|| "No room is open.".to_string()),
    }
}

/// Reduce + write: assemble "Room summary.html" from the CACHED per-file
/// one-liners and save it into the room. The cache is filled beforehand — by
/// summarize_room's foreground loop or by the ADD-30 deep-summary job — so this
/// makes exactly two model calls (purpose + questions) regardless of room size.
/// `pin` (the originating room's path) guards EVERY room access here: the
/// reduce awaits model calls that can take minutes, and a room swapped in that
/// window must error out, never receive the old room's summary.
pub(crate) async fn write_room_summary(
    window: &tauri::Window,
    state: &AppState,
    model: &str,
    pin: Option<&str>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;

    let (room_name, memories, files, existing_id, legacy_md_id) = {
        let guard = state.room.lock().unwrap();
        let room = pinned_room(&guard, pin)?;
        let conn = &room.conn;
        let all = db::list_files_for_summary(conn)?;
        let existing_id = all
            .iter()
            .find(|f| f.name == SUMMARY_FILE_NAME && f.source == "generated")
            .map(|f| f.id.clone());
        let legacy_md_id = all
            .iter()
            .find(|f| f.name == "Room summary.md" && f.source == "generated")
            .map(|f| f.id.clone());
        let files: Vec<db::SummaryFile> = all
            .into_iter()
            .filter(|f| !is_summary_file(&f.name, &f.source))
            .collect();
        let memories: Vec<String> =
            db::list_memories(conn)?.into_iter().map(|m| m.content).collect();
        (room.name.clone(), memories, files, existing_id, legacy_md_id)
    };
    if files.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }
    let capped = files.len() > MAX_SUMMARY_FILES;

    // `file_lines` is the text context handed to the reduce step; `file_items`
    // (display, one-liner) drives the deterministic HTML file list.
    let mut file_lines = String::new();
    let mut file_items: Vec<(String, Option<String>)> = Vec::new();
    for f in files.iter().take(MAX_SUMMARY_FILES) {
        let display = match &f.folder {
            Some(folder) => format!("{folder}/{}", f.name),
            None => f.name.clone(),
        };
        match f.ai_summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(liner) => {
                file_lines.push_str(&format!("- {display} — {liner}\n"));
                file_items.push((display, Some(liner.to_string())));
            }
            None => {
                file_lines.push_str(&format!("- {display} ({})\n", f.mime));
                file_items.push((display, None));
            }
        }
    }

    // Reduce: purpose paragraph + suggested questions. CHG-24: run the reduce on
    // ONLY the summarized files' one-liners — the beyond-cap name-only tail is
    // for the deterministic "## Files" section and is appended AFTER, so it
    // never crowds the 8K context the model actually needs here.
    let _ = window.emit("summarize-progress", "Writing the summary…");
    let (purpose, questions) = combine_summary(model, &room_name, &memories, &file_lines).await?;

    if capped {
        for f in files.iter().skip(MAX_SUMMARY_FILES) {
            let display = match &f.folder {
                Some(folder) => format!("{folder}/{}", f.name),
                None => f.name.clone(),
            };
            file_items.push((display, None));
        }
    }

    // ADD-22: assemble a self-contained HTML page (rendered in the sandboxed,
    // network-blocked viewer). Purpose + questions come from the model as
    // guaranteed fields; the file list is deterministic. Everything is escaped.
    let saved_date = {
        let guard = state.room.lock().unwrap();
        db::current_date(&pinned_room(&guard, pin)?.conn)
    };
    let mut body = doc_hero(
        "Room summary",
        &room_name,
        &format!("Generated on {}", html_escape(&saved_date)),
    );
    body.push_str("<h2>What this room is for</h2>\n");
    body.push_str(&format!(
        "<div class=\"lead-wrap\"><p class=\"lead\">{}</p></div>\n",
        if purpose.is_empty() {
            "A personal document room.".to_string()
        } else {
            html_escape(&purpose)
        }
    ));
    body.push_str(&format!(
        "<h2>Files <span class=\"count\">{}</span></h2>\n<ul class=\"files\">\n",
        file_items.len()
    ));
    for (display, liner) in &file_items {
        let icon = file_glyph(display);
        match liner {
            Some(l) => body.push_str(&format!(
                "<li><span class=\"ic\">{}</span><div><div class=\"nm\">{}</div>\
                 <div class=\"ds\">{}</div></div></li>\n",
                icon,
                html_escape(display),
                html_escape(l)
            )),
            None => body.push_str(&format!(
                "<li><span class=\"ic\">{}</span><div><div class=\"nm\">{}</div></div></li>\n",
                icon,
                html_escape(display)
            )),
        }
    }
    body.push_str("</ul>\n");
    if capped {
        body.push_str(&format!(
            "<p class=\"note\">Only the first {MAX_SUMMARY_FILES} files were summarized; the rest are listed by name.</p>\n"
        ));
    }
    if !questions.is_empty() {
        body.push_str("<h2>Try asking</h2>\n<ol class=\"asks\">\n");
        for q in &questions {
            body.push_str(&format!("<li>{}</li>\n", html_escape(q)));
        }
        body.push_str("</ol>\n");
    }
    let content = html_document(&format!("{room_name} — Room summary"), &body);

    // Phase 3 (locked): write the ONE canonical summary file — overwrite in
    // place (ADD-2 keeps the previous versions) or create it the first time.
    let guard = state.room.lock().unwrap();
    let room = pinned_room(&guard, pin)?;
    let meta = match existing_id {
        Some(id) => {
            store_file_bytes(&room.conn, &id, content.as_bytes(), Some(&content), "Summarized")?;
            db::get_file_meta(&room.conn, &id)?
        }
        None => db::insert_file(
            &room.conn,
            SUMMARY_FILE_NAME,
            "text/html",
            content.as_bytes(),
            Some(&content),
            "generated",
        )?,
    };
    // ADD-22: drop the legacy Markdown summary so only the HTML one remains.
    if let Some(md_id) = legacy_md_id {
        let _ = db::delete_file(&room.conn, &md_id);
    }
    let _ = window.emit("room-files-changed", ());
    Ok(meta)
}

// ---------------------------------------------------------------- data safety


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_file_excludes_only_the_generated_one() {
        // ADD-17: the app's own generated summary is excluded from itself.
        assert!(is_summary_file("Room summary.md", "generated"));
        // A user upload with the same name is NOT the canonical summary.
        assert!(!is_summary_file("Room summary.md", "upload"));
        assert!(!is_summary_file("notes.md", "generated"));
    }

    /// ADD-27 end-to-end proof: the answer is ONLY reachable by paging past the
    /// first window, so a correct summary means the model really drove
    /// read_text. Needs a running Ollama with a tool-capable local model:
    /// `cargo test summarize_pages_past_first_window -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn summarize_pages_past_first_window() {
        let mut text = String::from(
            "NOTICE: This file's real content is described later in the document. \
             To learn what this file actually is, search for the word MANIFEST \
             and read what follows it.\n\n",
        );
        for i in 0..4000 {
            text.push_str(&format!("Log entry {i}: heartbeat OK, no events recorded.\n"));
        }
        text.push_str(
            "\nMANIFEST: This document is the official maintenance manual for the \
             Zephyr-9 submarine engine, covering cooling, torque limits and \
             emergency shutdown procedures.\n",
        );
        for i in 0..2000 {
            text.push_str(&format!("Appendix row {i}: reserved.\n"));
        }
        let model = std::env::var("PR_TEST_MODEL").unwrap_or_else(|_| "qwen3.5:9b".into());
        let liner = summarize_one_file(&model, "big.log", "text/plain", &text, "2m")
            .await
            .expect("summarize failed — is Ollama running?");
        eprintln!("one-liner: {liner}");
        assert!(
            ["zephyr", "submarine", "engine", "maintenance", "manual"]
                .iter()
                .any(|w| liner.to_lowercase().contains(w)),
            "summary never found the buried MANIFEST: {liner}"
        );
    }

    #[test]
    fn pinned_room_rejects_a_swapped_or_closed_room() {
        let room = Some(Room {
            conn: Connection::open_in_memory().unwrap(),
            path: "/tmp/a.roomai".into(),
            name: "A".into(),
            password: String::new(),
        });
        // Unpinned and matching-pin lookups resolve the open room.
        assert!(pinned_room(&room, None).is_ok());
        assert!(pinned_room(&room, Some("/tmp/a.roomai")).is_ok());
        // A pin for a DIFFERENT room (swapped mid-run) must error, never
        // hand back the room that is currently open.
        assert_eq!(
            pinned_room(&room, Some("/tmp/b.roomai")).err().as_deref(),
            Some("the room this job belongs to was closed")
        );
        // No room open: the pinned path keeps the job-style message.
        assert_eq!(
            pinned_room(&None, None).err().as_deref(),
            Some("No room is open.")
        );
        assert_eq!(
            pinned_room(&None, Some("/tmp/a.roomai")).err().as_deref(),
            Some("the room this job belongs to was closed")
        );
    }

}
