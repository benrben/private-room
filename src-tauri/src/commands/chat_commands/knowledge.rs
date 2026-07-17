use super::*;

pub(crate) async fn cmd_remember(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let fact = ctx.args.trim();
    if fact.is_empty() {
        return Err("Usage: #remember <fact>".into());
    }
    let fact = clamp_bytes(fact.to_string(), MAX_MEMORY_CONTENT_CHARS);
    ctx.state.with_room(|room| {
        if duplicate_memory(&room.conn, &fact)?.is_some() {
            return Ok(CommandResult {
                content: "That's already in this room's memory.".into(),
                ..Default::default()
            });
        }
        db::add_memory(&room.conn, &fact)?;
        Ok(CommandResult {
            content: format!("Saved to memory:\n\n> {fact}"),
            ..Default::default()
        })
    })
}

pub(crate) async fn cmd_find(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let query = ctx.args.trim();
    if query.is_empty() {
        return Err("Usage: #find <keywords>".into());
    }
    let emb = embed_question(query).await;
    let (chunks, fallback) =
        ctx.state.with_room(|room| retrieve_context(&room.conn, query, emb.as_deref()))?;
    if fallback || chunks.is_empty() {
        return Ok(CommandResult {
            content: format!("No matches found for **{query}**."),
            ..Default::default()
        });
    }
    let mut body = format!("Matches for **{query}**:\n\n");
    let mut sources: Vec<String> = Vec::new();
    for c in chunks.iter().take(MAX_CONTEXT_CHUNKS) {
        let snippet = make_snippet(&c.text, query, 140);
        body.push_str(&format!("- **{}** — {snippet}\n", c.file_name));
        if !sources.contains(&c.file_name) {
            sources.push(c.file_name.clone());
        }
    }
    body.push_str("\n_Click a file below to open it._");
    Ok(CommandResult { content: body, sources, ..Default::default() })
}

pub(crate) async fn cmd_add_file(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let a = ctx.args.trim();
    if a.is_empty() {
        return Err("Usage: #add-file <name>: <topic>   (or)   #add-file for each <thing>".into());
    }
    // Fan-out: "#add-file for each <thing>" → enumerate from the conversation,
    // then generate + save one file per item.
    let lower = a.to_lowercase();
    if let Some(pos) = lower.find("for each") {
        let subject = a[pos + "for each".len()..].trim().trim_start_matches(':').trim();
        // Enumerate: the one genuinely fuzzy step. MIGRATION Phase 3: the prompt,
        // schema and `parse_string_list` (dedupe + cap 12) live in the sidecar's
        // /knowledge_extract mode:list, which returns the finished `items`. Rust
        // keeps the subject parse, the empty-list error, and the per-item loop.
        let req = serde_json::json!({
            "model": ctx.model,
            "base_url": ollama::resolved_base_url(),
            "mode": "list",
            "subject": subject,
            "conversation": ctx.history,
            "temperature": 0.0,
            "keep_alive": KEEP_ALIVE_WARM,
        });
        let items: Vec<String> = crate::sidecar::sidecar_json("/knowledge_extract", &req)
            .await
            .map_err(|e| e.sentinel(Some(ctx.model)))?["items"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if items.is_empty() {
            return Err(
                "Couldn't find a list to iterate over in this chat. Name the items explicitly, \
                 e.g. #add-file for each: AAPL, MSFT, NVDA."
                    .into(),
            );
        }
        let mut created: Vec<String> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if ctx.cancelled() {
                break;
            }
            let _ = ctx.window.emit(
                "ask-step",
                format!("Creating file for {item} ({}/{})", i + 1, items.len()),
            );
            // MIGRATION Phase 3: the DOC_SYS document-body generation lives in the
            // sidecar's /generate_doc mode:each. Cancellation stays Rust-side (the
            // POST is blocking): a Stop drops the request; an error/stop → empty →
            // skip, matching the old `ask_quiet(...).unwrap_or_default()`.
            let req = serde_json::json!({
                "model": ctx.model,
                "base_url": ollama::resolved_base_url(),
                "mode": "each",
                "item": item,
                "history": ctx.history,
                "temperature": 0.4,
                "keep_alive": KEEP_ALIVE_WARM,
            });
            let body = match crate::sidecar::sidecar_json_cancellable("/generate_doc", &req, &ctx.cancel).await {
                Ok(Some(v)) => v["text"].as_str().unwrap_or_default().to_string(),
                _ => String::new(),
            };
            if body.trim().is_empty() {
                continue;
            }
            let name = html_note_name(item);
            let doc = html_titled_doc(&name, item, &body);
            let guard = ctx.state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { break };
            if let Ok(meta) = create_note(&room.conn, &name, &doc) {
                created.push(meta.name);
            }
        }
        let _ = ctx.window.emit("room-files-changed", ());
        if created.is_empty() {
            return Err("Couldn't create any files — the model returned nothing.".into());
        }
        let list = created.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n");
        return Ok(CommandResult {
            content: format!(
                "Created {} file(s):\n{list}\n\n_Delete any you don't want from the Files list._",
                created.len()
            ),
            sources: created,
            ..Default::default()
        });
    }

    // Single file: optional "name: topic".
    let (name_hint, topic) = match a.split_once(':') {
        Some((n, t)) if !t.trim().is_empty() && n.split_whitespace().count() <= 8 => {
            (Some(n.trim().to_string()), t.trim().to_string())
        }
        _ => (None, a.to_string()),
    };
    let refctx = ctx.state.with_room(|room| Ok(refs_context(&room.conn, ctx.refs, 8000).0))?;
    // MIGRATION Phase 3: the DOC_SYS body generation lives in the sidecar's
    // /generate_doc mode:single (which builds "{context}Write a … document about:
    // {topic}"). Rust keeps refs_context, the empty-body error, and the naming.
    let req = serde_json::json!({
        "model": ctx.model,
        "base_url": ollama::resolved_base_url(),
        "mode": "single",
        "topic": topic,
        "context": refctx,
        "temperature": 0.4,
        "keep_alive": KEEP_ALIVE_WARM,
    });
    let body = match crate::sidecar::sidecar_json_cancellable("/generate_doc", &req, &ctx.cancel).await {
        Ok(Some(v)) => v["text"].as_str().unwrap_or_default().to_string(),
        Ok(None) => String::new(),
        Err(e) => return Err(e.sentinel(Some(ctx.model))),
    };
    if body.trim().is_empty() {
        return Err("The model returned nothing — try rephrasing the topic.".into());
    }
    // ADD-22: default to HTML unless the user named an explicit extension.
    let name = match name_hint {
        Some(h) if !extraction::extension_of(&h).is_empty() => h,
        Some(h) => format!("{h}.html"),
        None => html_note_name(&topic),
    };
    let doc = html_titled_doc(&name, &title_from_name(&name), &body);
    let meta = save_and_open(ctx.window, ctx.state, &name, &note_mime(&name), &doc, "generated")?;
    Ok(CommandResult {
        content: format!("Created **{}** and opened it.", meta.name),
        sources: vec![meta.name],
        ..Default::default()
    })
}

pub(crate) async fn cmd_highlight(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a file with @ — e.g. #highlight the total in @invoice.pdf")?;
    let thing = ctx
        .args
        .trim()
        .trim_end_matches(|c: char| c.is_whitespace())
        .trim_end_matches(" in")
        .trim_end_matches(" on")
        .trim();
    if thing.is_empty() {
        return Err("Say what to highlight — e.g. #highlight the signature in @contract.pdf".into());
    }
    let (real_name, extracted) = ctx.state.with_room(|room| {
        let (name, _mime, _bytes, text) = db::get_file_full(&room.conn, file_id)?;
        Ok((name, text.unwrap_or_default()))
    })?;
    if extracted.trim().is_empty() {
        return Err(format!("\"{real_name}\" has no readable text to highlight."));
    }
    let doc = clamp_bytes(extracted.clone(), 6000);
    let quote = ctx
        .ask_quiet(
            "You locate an exact passage. Output ONLY the shortest verbatim quote from the \
             document that best matches the request — copied character-for-character, with no \
             quotation marks around it and no other words.",
            format!("Request: {thing}\n\nDocument:\n{doc}"),
            Some(0.0),
        )
        .await?;
    let quote = quote.trim().trim_matches('"').trim().to_string();
    if quote.is_empty() {
        return Err(format!("Couldn't find \"{thing}\" in {real_name}."));
    }
    let (payload, described) =
        build_annotation(file_id, &real_name, Some(&extracted), &quote, "", None, None, None)
            .map_err(|_| format!("Couldn't find an exact passage for \"{thing}\" in {real_name}."))?;
    let _ = ctx.window.emit("agent-annotate", &payload);
    let effects = ToolEffects {
        annotation: Some(payload),
        ..Default::default()
    };
    Ok(CommandResult {
        content: format!("Highlighted {described} in **{real_name}**."),
        sources: vec![real_name],
        effects,
    })
}

pub(crate) async fn cmd_extract(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    if ctx.refs.is_empty() {
        return Err("Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf".into());
    }
    // Strip a trailing "from"/"in"/"of" the UI leaves after removing @tokens.
    let fields_str = ctx
        .args
        .trim()
        .trim_end_matches(|c: char| c.is_whitespace())
        .trim_end_matches("from")
        .trim_end_matches("in")
        .trim_end_matches("of")
        .trim();
    let fields: Vec<String> = fields_str
        .split(',')
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if fields.is_empty() {
        return Err("Say which fields to extract — e.g. #extract revenue, CEO from @a @b".into());
    }
    let files: Vec<(String, String)> = ctx.state.with_room(|room| {
        Ok(ctx.refs
            .iter()
            .filter_map(|id| db::get_file_full(&room.conn, id).ok())
            .map(|(name, _m, _b, text)| (name, text.unwrap_or_default()))
            .collect())
    })?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut header = vec!["File".to_string()];
    header.extend(fields.iter().cloned());
    rows.push(header);
    for (i, (name, text)) in files.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx
            .window
            .emit("ask-step", format!("Reading {name} ({}/{})", i + 1, files.len()));
        let doc = clamp_bytes(text.clone(), 6000);
        // MIGRATION Phase 3: the per-field schema, prompt, structured call and
        // "(not found)" defaulting live in the sidecar's /knowledge_extract
        // mode:fields, which returns `values` keyed by every requested field. Rust
        // keeps the 6000-char clamp, the CSV assembly and the ask-step emits. To
        // preserve the old best-effort behavior (a failed structured call became a
        // `(not found)` row rather than aborting the whole run), a sidecar error
        // maps to an all-`(not found)` row for this file.
        let req = serde_json::json!({
            "model": ctx.model,
            "base_url": ollama::resolved_base_url(),
            "mode": "fields",
            "fields": fields,
            "document": doc,
            "temperature": 0.0,
            "keep_alive": KEEP_ALIVE_WARM,
        });
        let values = crate::sidecar::sidecar_json("/knowledge_extract", &req)
            .await
            .ok()
            .map(|v| v["values"].clone())
            .unwrap_or_else(|| serde_json::json!({}));
        let mut row = vec![name.clone()];
        for f in &fields {
            let val = value_str(&values, f);
            row.push(if val.is_empty() { "(not found)".to_string() } else { val });
        }
        rows.push(row);
    }
    let csv = serialize_delim(&rows, ',');
    let meta = save_and_open(ctx.window, ctx.state, "extract.csv", &note_mime("extract.csv"), &csv, "generated")?;
    Ok(CommandResult {
        content: format!(
            "Extracted {} field(s) from {} file(s) into **{}**.",
            fields.len(),
            files.len(),
            meta.name
        ),
        sources: vec![meta.name],
        ..Default::default()
    })
}
