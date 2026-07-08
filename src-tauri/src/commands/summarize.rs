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

/// Trim a model reply down to a single clean sentence for a file one-liner.
pub(crate) fn clean_one_liner(raw: &str) -> String {
    let line = strip_markup_blocks(raw)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_start_matches(['-', '*', '#', '>', ' '])
        .to_string();
    line.chars().take(200).collect::<String>().trim().to_string()
}

/// ADD-17 map step: one short call describing a single file in a sentence.
/// `keep_alive` lets the background filler use a short warmth (CHG-22) so it
/// never pins the model in RAM, while the interactive path keeps it warm.
pub(crate) async fn summarize_one_file(
    model: &str,
    name: &str,
    mime: &str,
    text: &str,
    keep_alive: &str,
) -> Result<String, String> {
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You describe a single file in ONE short, factual sentence based only on what is given.",
        ),
        ollama::ChatMessage::new(
            "user",
            format!(
                "File name: {name}\nType: {mime}\n\nBeginning of its text:\n{text}\n\n\
                 In one sentence, what is this file about?"
            ),
        ),
    ];
    // ADD-22: a single guaranteed string field, so a chatty model can't wrap the
    // sentence in preamble/markup that clean_one_liner then has to strip.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"]
    });
    let raw = ollama::chat_structured(model, messages, Some(0.2), keep_alive, &schema).await?;
    let summary = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| v.get("summary").and_then(|s| s.as_str()).map(str::to_string))
        .unwrap_or(raw);
    Ok(clean_one_liner(&summary))
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
    let mut context = format!("Room name: {room_name}\n\nFiles and what each is:\n{file_lines}\n");
    if !memories.is_empty() {
        context.push_str("\nMemory notes the user saved for this room:\n");
        for m in memories {
            context.push_str(&format!("- {m}\n"));
        }
    }

    // ADD-22 (fix): the old design asked one constrained call for a nested
    // {purpose, questions[3]} object and often got empty strings back — a small
    // model can't fill a JSON shape it never sees. Split into TWO single-purpose
    // calls instead: free-text prose for the purpose (what a 4B model does most
    // reliably), and a plain string array for the questions (grounded by the
    // schema-in-prompt that chat_structured now adds).
    let purpose = {
        let messages = vec![
            ollama::ChatMessage::new(
                "system",
                "You describe what a personal document room is for. In 2-4 sentences, say what \
                 the room is about and the main topics it covers, based only on the file list. \
                 Be specific and concrete. No preamble, no bullet lists, no file names.",
            ),
            ollama::ChatMessage::new("user", context.clone()),
        ];
        let (t, _) =
            ollama::chat_stream_tools(model, messages, None, Some(0.4), None, KEEP_ALIVE_WARM, |_| {})
                .await?;
        strip_think_spans(&t).trim().to_string()
    };

    let questions = {
        let messages = vec![
            ollama::ChatMessage::new(
                "system",
                "You suggest example questions a user could ask about their own documents. Give \
                 exactly three short, specific questions that these files would actually answer.",
            ),
            ollama::ChatMessage::new("user", context),
        ];
        let schema = serde_json::json!({
            "type": "array",
            "items": {"type": "string"},
            "minItems": 3,
            "maxItems": 3
        });
        let raw = ollama::chat_structured(model, messages, Some(0.4), KEEP_ALIVE_WARM, &schema)
            .await
            .unwrap_or_default();
        parse_string_list(&raw).into_iter().take(3).collect()
    };

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

    // Phase 1 (locked): pull the room name, memories and the file rows.
    let (room_name, explicit_model, memories, files, existing_id, legacy_md_id) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let all = db::list_files_for_summary(conn)?;
        // Overwrite the current (HTML) summary in place.
        let existing_id = all
            .iter()
            .find(|f| f.name == SUMMARY_FILE_NAME && f.source == "generated")
            .map(|f| f.id.clone());
        // ADD-22: the pre-HTML "Room summary.md" (from an older app version) is
        // removed once we regenerate, so the room isn't left with a stale
        // duplicate summary in the other format.
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
        (room.name.clone(), model_setting(conn), memories, files, existing_id, legacy_md_id)
    };

    if files.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }

    // Summarization always runs on a LOCAL model (map-reduce needs many small
    // calls); if a cloud engine is selected, fall back to the default local one.
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

    let capped = files.len() > MAX_SUMMARY_FILES;
    let to_do = files.len().min(MAX_SUMMARY_FILES);

    // Map: a one-liner per file, reusing the cache and filling any gaps.
    // `file_lines` is the text context handed to the reduce step; `file_items`
    // (display, one-liner) drives the deterministic HTML file list.
    let mut file_lines = String::new();
    let mut file_items: Vec<(String, Option<String>)> = Vec::new();
    for (i, f) in files.iter().take(MAX_SUMMARY_FILES).enumerate() {
        let _ = window.emit(
            "summarize-progress",
            format!("Summarizing file {} of {}…", i + 1, to_do),
        );
        let display = match &f.folder {
            Some(folder) => format!("{folder}/{}", f.name),
            None => f.name.clone(),
        };
        let one_liner = if let Some(cached) = &f.ai_summary {
            cached.clone()
        } else if f.text.as_deref().map_or(true, |t| t.trim().is_empty()) {
            // No extractable text (e.g. an image without OCR): list by name and
            // type only, never invent content.
            String::new()
        } else {
            let snippet = f.text.as_deref().unwrap_or("");
            // CHG-26: one flaky file must not abort the whole run. A
            // non-transient error (Ollama down / model missing) still aborts —
            // every remaining call would fail too — but a one-off error just
            // degrades this file to name-and-type (and, being uncached, retries
            // on the next run).
            match summarize_one_file(&model, &f.name, &f.mime, snippet, KEEP_ALIVE_WARM).await {
                Ok(liner) => {
                    if !liner.is_empty() {
                        if let Some(room) = state.room.lock().unwrap().as_ref() {
                            let _ = db::set_file_ai_summary(&room.conn, &f.id, &liner);
                        }
                    }
                    liner
                }
                Err(e) if e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING") => {
                    return Err(e);
                }
                Err(_) => String::new(),
            }
        };
        if one_liner.is_empty() {
            file_lines.push_str(&format!("- {display} ({})\n", f.mime));
            file_items.push((display, None));
        } else {
            file_lines.push_str(&format!("- {display} — {one_liner}\n"));
            file_items.push((display, Some(one_liner)));
        }
    }

    // Reduce: purpose paragraph + suggested questions. CHG-24: run the reduce on
    // ONLY the summarized files' one-liners — the beyond-cap name-only tail is
    // for the deterministic "## Files" section and is appended AFTER, so it
    // never crowds the 8K context the model actually needs here.
    let _ = window.emit("summarize-progress", "Writing the summary…");
    let (purpose, questions) = combine_summary(&model, &room_name, &memories, &file_lines).await?;

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
        guard
            .as_ref()
            .map(|room| db::current_date(&room.conn))
            .unwrap_or_default()
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
    let room = guard.as_ref().ok_or("No room is open.")?;
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

    #[test]
    fn cleans_model_one_liner() {
        assert_eq!(clean_one_liner("- A lease agreement.\nExtra"), "A lease agreement.");
        assert_eq!(clean_one_liner("\n\n  The résumé.  "), "The résumé.");
    }

}
