use super::*;

pub(crate) async fn cmd_summarize(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    if let Some(file_id) = ctx.refs.first() {
        let (name, text) = ctx.state.with_room(|room| {
            let (name, _m, _b, text) = db::get_file_full(&room.conn, file_id)?;
            Ok((name, text.unwrap_or_default()))
        })?;
        if text.trim().is_empty() {
            return Err(format!("\"{name}\" has no readable text to summarize."));
        }
        let doc = clamp_bytes(text, 8000);
        let out = ctx
            .ask_streaming(
                "You summarize a document faithfully and concisely.",
                format!(
                    "Summarize this document in 3-4 sentences, then list up to 3 key points as \
                     bullets.\n\n{doc}"
                ),
            )
            .await?;
        return Ok(CommandResult {
            content: out,
            sources: vec![name],
            ..Default::default()
        });
    }
    // Whole-room overview from the file inventory + cached one-liners.
    let inventory = ctx.state.with_room(|room| db::list_file_inventory(&room.conn))?;
    if inventory.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }
    let mut listing = String::new();
    for (name, mime, summary) in inventory.iter().take(60) {
        match summary {
            Some(s) if !s.trim().is_empty() => {
                listing.push_str(&format!("- {name} — {}\n", s.trim()))
            }
            _ => listing.push_str(&format!("- {name} ({mime})\n")),
        }
    }
    let out = ctx
        .ask_streaming(
            "You describe what a personal document room is for, based only on the file list given.",
            format!(
                "Given these files, describe in 3-4 sentences what this room is about, then \
                 suggest 3 things the user could ask.\n\nFiles:\n{listing}"
            ),
        )
        .await?;
    Ok(CommandResult {
        content: format!(
            "{out}\n\n_Tip: the “Summarize room” button saves this as a file with per-file notes._"
        ),
        ..Default::default()
    })
}

pub(crate) async fn cmd_compare(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    if ctx.refs.len() < 2 {
        return Err("Add at least two files with @ — e.g. #compare @plan-a.md @plan-b.md".into());
    }
    let (refctx, names) = ctx.state.with_room(|room| Ok(refs_context(&room.conn, ctx.refs, 9000)))?;
    if refctx.trim().is_empty() {
        return Err("Those files have no readable text to compare.".into());
    }
    let out = ctx
        .ask_streaming(
            "You compare documents clearly and fairly.",
            format!(
                "Compare the following documents. Give a one-sentence overview, then a short \
                 bullet list of the key similarities and a short bullet list of the key \
                 differences.\n\n{refctx}"
            ),
        )
        .await?;
    Ok(CommandResult { content: out, sources: names, ..Default::default() })
}

pub(crate) async fn cmd_transcribe(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a recording with @ — e.g. #transcribe @meeting.m4a")?;
    let (name, mime, text) = ctx.state.with_room(|room| {
        let (name, mime, _b, text) = db::get_file_full(&room.conn, file_id)?;
        Ok((name, mime.unwrap_or_default(), text.unwrap_or_default()))
    })?;
    let ext = extraction::extension_of(&name);
    let is_media = stt::media_kind(&mime, &ext).is_some();
    if text.trim().is_empty() {
        if !is_media {
            return Err(format!("\"{name}\" isn't an audio or video file."));
        }
        use tauri::{Emitter, Manager};
        let app = ctx.window.app_handle().clone();
        // Prefer a bundled/downloaded model; only unbundled builds with nothing
        // downloaded yet reach the error.
        let Some(model_path) = stt_effective_model(&app) else {
            return Err(
                "The voice model isn't available yet — get it in Settings → AI (Voice model), \
                 then run #transcribe again."
                    .into(),
            );
        };
        // The import-time background job may have failed or not finished — so do
        // it now, on demand. Whisper is CPU-bound, so run it OFF the async runtime.
        let _ = ctx.window.emit(
            "ask-step",
            format!("Transcribing {name} (long recordings take a while)…"),
        );
        let (bytes, room_path) = ctx.state.with_room(|room| {
            let bytes = db::get_file_bytes(&room.conn, file_id)?
                .ok_or("This recording has no stored audio.")?;
            Ok((bytes, room.path.clone()))
        })?;
        let kind = stt::media_kind(&mime, &ext).unwrap_or(stt::MediaKind::Audio);
        let ext_owned = ext.clone();
        let model_for_job = model_path.clone();
        let transcript = tauri::async_runtime::spawn_blocking(move || {
            stt::decode_bytes_to_pcm(&bytes, &ext_owned, kind)
                .and_then(|pcm| stt::transcribe(&model_for_job, &pcm, true))
        })
        .await
        .map_err(|e| e.to_string())??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(format!(
                "Couldn't get any speech from \"{name}\" — it may be silent, music-only, or an \
                 unreadable format."
            ));
        }
        // Cache it so a re-run is instant and the one-liner filler picks it up.
        let full_text = format!("(transcribed from recording)\n{transcript}");
        {
            let guard = ctx.state.room.lock().unwrap();
            if let Some(room) = guard.as_ref() {
                if room.path == room_path {
                    if let Ok(Some(b)) = db::get_file_bytes(&room.conn, file_id) {
                        let _ = db::update_file_content(&room.conn, file_id, &b, Some(&full_text));
                    }
                }
            }
        }
        let _ = ctx.window.emit("room-files-changed", ());
        return Ok(CommandResult {
            content: format!("Transcript of **{name}**:\n\n{transcript}"),
            sources: vec![name],
            ..Default::default()
        });
    }
    Ok(CommandResult {
        content: format!("Transcript of **{name}**:\n\n{}", text.trim()),
        sources: vec![name],
        ..Default::default()
    })
}

/// #minutes @<transcript/recording/notes> — turn a meeting source into a
/// timeline-styled HTML minutes document (ADD-22). The model only fills the
/// structured `minutes_schema`; Rust renders the template. Falls back to the
/// recent chat when no @ files are pinned.
pub(crate) async fn cmd_minutes(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let (refctx, ref_names) = ctx.state.with_room(|room| Ok(refs_context(&room.conn, ctx.refs, 12000)))?;
    // A pinned file with no readable text is usually an un-transcribed recording.
    if !ctx.refs.is_empty() && refctx.trim().is_empty() {
        return Err(
            "That file has no readable text yet — if it's a recording, run #transcribe on it \
             first, then #minutes."
                .into(),
        );
    }
    let source = if !refctx.trim().is_empty() {
        refctx
    } else if !ctx.history.trim().is_empty() {
        format!("Conversation:\n{}", ctx.history)
    } else {
        return Err(
            "Give me something to turn into minutes — e.g. #minutes @meeting.m4a (a transcript \
             or notes), or run it after a discussion in this chat."
                .into(),
        );
    };
    let _ = ctx.window.emit("ask-step", "Building the meeting minutes…");
    let raw = ctx
        .ask_structured(
            "You turn a meeting transcript or notes into structured minutes. Produce a short \
             title; the date if stated; attendees if named; a TIMELINE of the discussion as an \
             ordered list of items, each with an optional time or phase label, a short topic, and \
             a 1-2 sentence summary; the key decisions; and action items with an owner when known. \
             Base everything ONLY on the source — leave a field empty rather than inventing it.",
            format!("Source:\n{source}"),
            Some(0.3),
            &minutes_schema(),
        )
        .await?;
    let parsed: serde_json::Value = serde_json::from_str(raw.trim()).unwrap_or_default();
    let has_timeline = parsed
        .get("timeline")
        .and_then(|v| v.as_array())
        .map_or(false, |a| !a.is_empty());
    if !has_timeline {
        return Err(
            "Couldn't find a meeting to summarize in that source. Point #minutes at a transcript \
             or notes with @, e.g. #minutes @meeting.m4a."
                .into(),
        );
    }
    let title = parsed
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Meeting minutes")
        .to_string();
    let body = render_minutes_html(&parsed, &title);
    let doc = html_document(&title, &body);
    let name = html_note_name(&title);
    let meta = ctx.state.with_room(|room| create_note(&room.conn, &name, &doc))?;
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!("Created **{}** — a timeline of the meeting.", meta.name),
        sources: ref_names,
        ..Default::default()
    })
}

pub(crate) async fn cmd_to_sheet(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    // The most recent table anywhere in the conversation (extract_md_table
    // returns the last one).
    let Some(rows) = extract_md_table(ctx.history) else {
        return Err("No table found in a recent answer to convert.".into());
    };
    let csv = serialize_delim(&rows, ',');
    let meta = ctx.state.with_room(|room| create_note(&room.conn, "table.csv", &csv))?;
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!(
            "Saved the table as **{}** ({} row(s)).",
            meta.name,
            rows.len().saturating_sub(1)
        ),
        sources: vec![meta.name],
        ..Default::default()
    })
}

pub(crate) async fn cmd_translate(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a file with @ — e.g. #translate @notes.md to Spanish")?;
    // Accept "to <lang>" or a bare language name.
    let a = ctx.args.trim();
    let lang = a
        .rsplit_once(" to ")
        .map(|(_, l)| l)
        .or_else(|| a.strip_prefix("to "))
        .unwrap_or(a)
        .trim();
    if lang.is_empty() {
        return Err("Say the target language — e.g. #translate @notes.md to Spanish".into());
    }
    let (name, text) = ctx.state.with_room(|room| {
        let (name, _m, _b, text) = db::get_file_full(&room.conn, file_id)?;
        Ok((name, text.unwrap_or_default()))
    })?;
    if text.trim().is_empty() {
        return Err(format!("\"{name}\" has no readable text to translate."));
    }
    // Chunk so a long file fits the small context; translate each piece.
    let chars: Vec<char> = text.chars().collect();
    let chunks: Vec<String> = chars.chunks(3000).map(|c| c.iter().collect()).collect();
    let total = chunks.len();
    let mut out = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx
            .window
            .emit("ask-step", format!("Translating part {}/{}", i + 1, total));
        let piece = ctx
            .ask_quiet(
                &format!(
                    "You translate text into {lang}. Output ONLY the translation, preserving \
                     Markdown structure. Do not add commentary."
                ),
                chunk.clone(),
                Some(0.2),
            )
            .await?;
        out.push_str(piece.trim());
        out.push('\n');
    }
    if out.trim().is_empty() {
        return Err("The model returned nothing to save.".into());
    }
    let base = name.rsplit_once('.').map(|(b, _)| b).unwrap_or(&name);
    let fname = format!("{base} ({lang}).md");
    let meta = ctx.state.with_room(|room| create_note(&room.conn, &fname, &out))?;
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!("Translated **{name}** into {lang} → **{}**.", meta.name),
        sources: vec![meta.name],
        ..Default::default()
    })
}

/// D8 — the Airlock. Search the web, save each source into the room as an owned
/// offline copy, then answer from those freshly-imported files. The privacy
/// story: the only thing that leaves the Mac is the search query and the page
/// fetches (both explicit, both surfaced as steps); the answer itself is written
/// offline from files the room now owns, so the sources survive after the network
/// is gone.
///
/// CONTRACT-NOTE (D8 step 4): "web access" in this app is simply whether a
/// provider is configured (`web_access_enabled` == provider set) — there is no
/// separate on/off switch this command could toggle. So #research REQUIRES a
/// provider already configured (step 1) and never mutates any web setting, which
/// satisfies "turn web access OFF again if this command temporarily enabled it"
/// trivially: it never enables anything, so it leaves nothing on.
pub(crate) async fn cmd_research(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let question = ctx.args.trim();
    if question.is_empty() {
        return Err("Usage: #research <question>".into());
    }

    // (1) Require a web provider. If off, tell the user how to turn one on — a
    // saved assistant message, not an error toast, since it is actionable.
    let (provider, endpoint) = ctx.state.with_room(|room| {
        Ok((
            db::get_setting(&room.conn, "web_provider").unwrap_or_default(),
            db::get_setting(&room.conn, "web_endpoint").unwrap_or_default(),
        ))
    })?;
    if !matches!(provider.as_str(), "duckduckgo" | "brave" | "searxng") {
        return Ok(CommandResult {
            content: "Web access is off in this room. Turn on a provider in \
                      **Settings → Online features**, then try #research again."
                .into(),
            ..Default::default()
        });
    }

    // (2) Search. Reuse the same provider dispatch the agent's web_search uses.
    let _ = ctx.window.emit(
        "ask-step",
        format!("Searching the web for \"{question}\" (leaves this Mac)"),
    );
    let hits = match provider.as_str() {
        "duckduckgo" | "brave" => web::search_duckduckgo(question).await,
        _ => web::search_searxng(&endpoint, question).await,
    }?;
    if hits.is_empty() {
        return Ok(CommandResult {
            content: format!("No web results found for **{question}**."),
            ..Default::default()
        });
    }

    // (3) For each top result, fetch a readable copy and save it into the room as
    // an owned file (source "web"), so the source is now part of the room. Dedup
    // by URL within this run so the same page isn't imported twice.
    let mut imported: Vec<(String, String)> = Vec::new(); // (file name, text)
    let mut source_names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for hit in hits.iter().filter(|h| seen.insert(h.url.clone())).take(RESEARCH_SOURCES) {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx.window.emit(
            "ask-step",
            format!("Saving source: {} (leaves this Mac)", hit.title),
        );
        // fetch_readable keeps the SEC-5 private-network guard intact.
        let (title, text, _html) = match web::fetch_readable(&hit.url).await {
            Ok(v) => v,
            Err(_) => continue, // one bad page must not abort the whole run
        };
        if text.trim().is_empty() {
            continue;
        }
        let title = if title.trim().is_empty() { hit.title.clone() } else { title };
        let name = link_file_name(&title, &hit.url);
        let meta = {
            let guard = ctx.state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { break };
            let saved = db::current_date(&room.conn);
            let content =
                format!("# {title}\n\nSource: {}\nSaved: {saved}\n\n{text}", hit.url);
            match db::insert_file(
                &room.conn,
                &name,
                "text/markdown",
                content.as_bytes(),
                Some(&content),
                "web",
            ) {
                Ok(m) => m,
                Err(_) => continue,
            }
        };
        imported.push((meta.name.clone(), clamp_bytes(text, 4000)));
        source_names.push(meta.name);
    }
    let _ = ctx.window.emit("room-files-changed", ());

    if imported.is_empty() {
        return Ok(CommandResult {
            content: format!(
                "Found results for **{question}** but couldn't save any readable copies — \
                 the pages may be blocked or empty. Try a different question."
            ),
            ..Default::default()
        });
    }

    // (5) Answer from the freshly-imported sources. Everything from here on is
    // offline: the context is built from files the room now owns.
    let mut context = String::new();
    for (name, text) in &imported {
        context.push_str(&format!("## Source: {name}\n{text}\n\n"));
    }
    let context = clamp_bytes(context, 12_000);
    let _ = ctx.window.emit("ask-step", "Answering from the saved sources");
    let answer = ctx
        .ask_streaming(
            "You answer the user's question using ONLY the provided sources, which were just \
             saved into their workspace. Cite the source file names inline where relevant. \
             If the sources don't cover it, say so plainly.",
            format!("Question: {question}\n\nSources:\n{context}"),
        )
        .await
        .unwrap_or_default();
    let body = if answer.trim().is_empty() {
        format!(
            "Saved {} source(s) into the room:\n{}",
            source_names.len(),
            source_names.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n")
        )
    } else {
        answer
    };
    Ok(CommandResult {
        content: body,
        sources: source_names,
        ..Default::default()
    })
}
