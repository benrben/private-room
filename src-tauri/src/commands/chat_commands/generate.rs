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
        // Full ops: the whole file is read. A file bigger than one call becomes
        // notes over every window, folded down — so the summary covers the end of
        // a long document, which an 8000-byte clamp never did.
        let doc = ctx.digest(&text, &format!("Reading {name}")).await;
        if doc.trim().is_empty() {
            return Err(format!("Couldn't read \"{name}\" — the model returned nothing."));
        }
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
    // Every file in the room, not the first 60 — a room overview that ignores
    // most of the room isn't an overview.
    let mut listing = String::new();
    for (name, mime, summary) in inventory.iter() {
        match summary {
            Some(s) if !s.trim().is_empty() => {
                listing.push_str(&format!("- {name} — {}\n", s.trim()))
            }
            _ => listing.push_str(&format!("- {name} ({mime})\n")),
        }
    }
    let listing = ctx.digest(&listing, "Reading the file list").await;
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
    // Full ops: every file is read end to end. Each is digested on its own first
    // (a no-op for a file that already fits), so the comparison sees all of a
    // long document instead of whatever fit under a shared 9000-byte budget —
    // where, with three files pinned, the third often got nothing at all.
    let files = ctx.state.with_room(|room| Ok(refs_files(&room.conn, ctx.refs)))?;
    let names: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
    let mut refctx = String::new();
    for (name, text) in &files {
        if text.trim().is_empty() {
            continue;
        }
        let digest = ctx.digest(text, &format!("Reading {name}")).await;
        if !digest.trim().is_empty() {
            refctx.push_str(&format!("[file: {name}]\n{digest}\n\n"));
        }
    }
    // Several long files can still add up past one call; fold the assembled
    // context rather than cutting the last file off.
    let refctx = ctx.digest(&refctx, "Lining the documents up").await;
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
///
/// Full ops: the WHOLE source is minuted. A meeting longer than one model call
/// is split into consecutive windows, each window produces its own structured
/// minutes, and `merge_minutes` stitches them into one timeline — so a two-hour
/// meeting yields a two-hour timeline instead of its first ~5 minutes.
pub(crate) async fn cmd_minutes(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let (refctx, ref_names) = ctx.state.with_room(|room| Ok(refs_context(&room.conn, ctx.refs)))?;
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
    const MINUTES_SYS: &str =
        "You turn a meeting transcript or notes into structured minutes. Produce a short \
         title; the date if stated; attendees if named; a TIMELINE of the discussion as an \
         ordered list of items, each with an optional time or phase label, a short topic, and \
         a 1-2 sentence summary; the key decisions; and action items with an owner when known. \
         Base everything ONLY on the source — leave a field empty rather than inventing it.";

    // One structured pass per window of the meeting, in order. A window whose
    // call fails is skipped rather than aborting the run, and a Stop keeps the
    // minutes built so far — the same best-effort contract as every other pass.
    let windows = cmd_windows(&source);
    let total = windows.len();
    let mut parts: Vec<serde_json::Value> = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx.window.emit(
            "ask-step",
            if total > 1 {
                format!("Building the meeting minutes — part {}/{}…", i + 1, total)
            } else {
                "Building the meeting minutes…".to_string()
            },
        );
        let user = if total > 1 {
            format!(
                "This is part {} of {} of one meeting, in order. Minute THIS part only; earlier \
                 and later parts are handled separately.\n\nSource:\n{w}",
                i + 1,
                total
            )
        } else {
            format!("Source:\n{w}")
        };
        let Ok(raw) = ctx.ask_structured(MINUTES_SYS, user, Some(0.3), &minutes_schema()).await else {
            ctx.note_unread();
            continue;
        };
        match serde_json::from_str::<serde_json::Value>(raw.trim()) {
            Ok(v) => parts.push(v),
            Err(_) => ctx.note_unread(),
        }
    }
    let parsed = merge_minutes(&parts);
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
    let items = parsed["timeline"].as_array().map_or(0, |a| a.len());
    let coverage = if total > 1 {
        format!(" — a {items}-point timeline, read in {total} passes over the whole source")
    } else {
        " — a timeline of the meeting".to_string()
    };
    Ok(CommandResult {
        content: format!("Created **{}**{coverage}.", meta.name),
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

/// How many chunks in a row may fail before a chunked pass stops trying. One bad
/// slice is a slice; three in a row is the engine (Ollama stopped, model gone,
/// model wedged) — and every further attempt costs a full
/// `COMMAND_STEP_TIMEOUT_SECS` while the step chip pretends to make progress.
pub(crate) const CHUNK_GIVE_UP_AFTER: usize = 3;

/// Best-effort bookkeeping for a chunked pass: a slice the model failed on is
/// skipped rather than aborting the run, but the first error is KEPT so a global
/// failure can be reported with the cause the engine actually gave instead of a
/// generic "returned nothing".
#[derive(Default)]
pub(crate) struct ChunkFailures {
    first: Option<String>,
    run: usize,
}

impl ChunkFailures {
    /// Record a failed chunk. `true` means the run of failures is long enough
    /// that the engine, not the slice, is the problem — stop retrying it.
    pub(crate) fn note(&mut self, err: String) -> bool {
        self.first.get_or_insert(err);
        self.run += 1;
        self.run >= CHUNK_GIVE_UP_AFTER
    }

    /// A chunk came back fine, so the failures so far were local ones.
    pub(crate) fn ok(&mut self) {
        self.run = 0;
    }

    /// What to say when the pass produced nothing at all: the engine's own
    /// message ("The local AI (Ollama) isn't running…") is actionable, the
    /// generic one is not.
    pub(crate) fn nothing_saved(self) -> String {
        self.first
            .unwrap_or_else(|| "The model returned nothing to save.".into())
    }
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
    let mut done = 0usize;
    let mut failures = ChunkFailures::default();
    for (i, chunk) in chunks.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx
            .window
            .emit("ask-step", format!("Translating part {}/{}", i + 1, total));
        // One bad piece must not cost the user the twenty already translated:
        // skip it and report it, the same best-effort contract `map_windows`
        // gives every other full-ops command. But a RUN of failures is the
        // engine, not the piece — keep the first error to report and stop
        // spending a five-minute timeout per chunk on a dead model.
        let piece = match ctx
            .ask_quiet(
                &format!(
                    "You translate text into {lang}. Output ONLY the translation, preserving \
                     Markdown structure. Do not add commentary."
                ),
                chunk.clone(),
                Some(0.2),
            )
            .await
        {
            Ok(piece) => piece,
            Err(e) => {
                ctx.note_unread();
                if failures.note(e) {
                    break;
                }
                continue;
            }
        };
        failures.ok();
        out.push_str(piece.trim());
        out.push('\n');
        done = i + 1;
    }
    if out.trim().is_empty() {
        // Nothing survived: surface what the engine actually said ("The local AI
        // (Ollama) isn't running…") rather than the generic line, which sent the
        // user looking for a content problem that wasn't there.
        return Err(failures.nothing_saved());
    }
    // A translation that ended early is a PARTIAL document — whether the user
    // stopped it or the model quit on us. Say so inside the file, so a
    // half-translated note can't be mistaken for the finished one.
    if done < total {
        let why = if ctx.cancelled() {
            format!("Stopped after part {done} of {total}")
        } else {
            format!("The model stopped working after part {done} of {total}")
        };
        out.push_str(&format!(
            "\n\n---\n\n_{why} — the rest of \"{name}\" is not translated._\n"
        ));
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
/// CONTRACT-NOTE (D8 step 4): "web access" in this app is the room's one
/// internet switch (`web_access_enabled`). #research REQUIRES it already on
/// (step 1) and never mutates any web setting, which satisfies "turn web access
/// OFF again if this command temporarily enabled it" trivially: it never enables
/// anything, so it leaves nothing on.
pub(crate) async fn cmd_research(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let question = ctx.args.trim();
    if question.is_empty() {
        return Err("Usage: #research <question>".into());
    }

    // (1) Require the internet switch. If off, tell the user how to turn it on — a
    // saved assistant message, not an error toast, since it is actionable.
    let enabled = ctx
        .state
        .with_room(|room| Ok(crate::commands::web_access_enabled(&room.conn)))?;
    if !enabled {
        return Ok(CommandResult {
            content: "Web access is off in this room. Turn it on in \
                      **Settings → Online features**, then try #research again."
                .into(),
            ..Default::default()
        });
    }

    // (2) Search. The same one search path the agent's web_search uses.
    let _ = ctx.window.emit(
        "ask-step",
        format!("Searching the web for \"{question}\" (leaves this Mac)"),
    );
    let hits = web::search_web(question).await?;
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
    // Every distinct result the search returned, not the first four.
    for hit in hits.iter().filter(|h| seen.insert(h.url.clone())) {
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
        // The room keeps the whole page (it always did); the answer now reads the
        // whole page too, instead of its first 4000 bytes.
        imported.push((meta.name.clone(), text));
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
        // Long pages are read in full and noted down, not cut at 4000 bytes —
        // otherwise the answer cites a source it only half read.
        let digest = ctx.digest(text, &format!("Reading {name}")).await;
        context.push_str(&format!("## Source: {name}\n{digest}\n\n"));
    }
    // Many sources can still exceed one call; fold rather than drop the last few.
    let context = ctx.digest(&context, "Reading the saved sources").await;
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

#[cfg(test)]
mod chunked_pass_tests {
    use super::*;

    const DOWN: &str = "The local AI (Ollama) isn't running — start it and try again.";

    #[test]
    fn a_global_failure_is_reported_with_the_engines_own_message() {
        // Ollama down: every chunk fails the same way and nothing is translated.
        // Telling the user "the model returned nothing to save" points them at a
        // content problem that doesn't exist — the actionable cause is right there
        // in the error the engine already gave.
        let mut f = ChunkFailures::default();
        f.note(DOWN.into());
        f.note(DOWN.into());
        assert_eq!(f.nothing_saved(), DOWN);
    }

    #[test]
    fn a_pass_that_never_failed_keeps_the_generic_message() {
        // The model answered, just with nothing usable — that IS a content
        // problem, and the old wording is the right one.
        assert_eq!(
            ChunkFailures::default().nothing_saved(),
            "The model returned nothing to save."
        );
    }

    #[test]
    fn a_run_of_failures_gives_up_but_one_bad_slice_does_not() {
        // One awkward chunk in the middle of a long document must not abort the
        // run (the best-effort contract), but a wedged engine must not be retried
        // once per chunk at five minutes a go.
        let mut f = ChunkFailures::default();
        for _ in 0..CHUNK_GIVE_UP_AFTER - 1 {
            assert!(!f.note("boom".into()), "a short run is still best-effort");
        }
        f.ok();
        for _ in 0..CHUNK_GIVE_UP_AFTER - 1 {
            assert!(!f.note("boom".into()), "a success resets the run");
        }
        assert!(f.note("boom".into()), "an unbroken run means the engine is gone");
    }
}
