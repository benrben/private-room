use super::*;

pub(crate) async fn cmd_remember(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let fact = ctx.args.trim();
    if fact.is_empty() {
        return Err("Usage: #remember <fact>".into());
    }
    let fact = clamp_bytes(fact.to_string(), MAX_MEMORY_CONTENT_CHARS);
    let guard = ctx.state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
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
}

pub(crate) async fn cmd_find(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let query = ctx.args.trim();
    if query.is_empty() {
        return Err("Usage: #find <keywords>".into());
    }
    let emb = embed_question(query).await;
    let guard = ctx.state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (chunks, fallback) = retrieve_context(&room.conn, query, emb.as_deref())?;
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
        // Enumerate: the one genuinely fuzzy step gets the model, forced to a
        // list. ADD-22: the array shape is guaranteed by `format`, so the model
        // can only return strings; parse_string_list just dedupes and caps.
        let items = parse_string_list(
            &ctx.ask_structured(
                "You extract a list of short names from a conversation.",
                format!(
                    "From the conversation below, list the {subject} as short names (max 12). \
                     If there are none, return an empty array.\n\nConversation:\n{}",
                    ctx.history
                ),
                Some(0.0),
                &serde_json::json!({"type": "array", "items": {"type": "string"}}),
            )
            .await?,
        );
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
            let body = ctx
                .ask_quiet(
                    DOC_SYS,
                    format!(
                        "Write a concise, useful note about \"{item}\", grounded in this \
                         conversation where relevant:\n\n{}",
                        ctx.history
                    ),
                    Some(0.4),
                )
                .await
                .unwrap_or_default();
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
    let refctx = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        refs_context(&room.conn, ctx.refs, 8000).0
    };
    let body = ctx
        .ask_quiet(
            DOC_SYS,
            format!("{refctx}Write a well-structured document about: {topic}"),
            Some(0.4),
        )
        .await?;
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
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, &name, &doc)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
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
    let (real_name, extracted) = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _mime, _bytes, text) = db::get_file_full(&room.conn, file_id)?;
        (name, text.unwrap_or_default())
    };
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
    let files: Vec<(String, String)> = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        ctx.refs
            .iter()
            .filter_map(|id| db::get_file_full(&room.conn, id).ok())
            .map(|(name, _m, _b, text)| (name, text.unwrap_or_default()))
            .collect()
    };
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
        let field_lines = fields.join("\n");
        // ADD-22: one string property per requested field, so the reply is a
        // guaranteed JSON object keyed exactly by the field names — no more
        // hoping the model honors a "Field: value" line format.
        let mut props = serde_json::Map::new();
        for f in &fields {
            props.insert(f.clone(), serde_json::json!({"type": "string"}));
        }
        let schema = serde_json::json!({
            "type": "object",
            "properties": props,
            "required": fields,
        });
        let reply = ctx
            .ask_structured(
                "You extract specific fields from a document. Fill each field with its value \
                 copied from the document, or \"(not found)\" if it is absent.",
                format!("Fields:\n{field_lines}\n\nDocument:\n{doc}"),
                Some(0.0),
                &schema,
            )
            .await
            .unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(reply.trim()).unwrap_or_else(|_| serde_json::json!({}));
        let mut row = vec![name.clone()];
        for f in &fields {
            let val = parsed
                .get(f)
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("(not found)")
                .to_string();
            row.push(val);
        }
        rows.push(row);
    }
    let csv = serialize_delim(&rows, ',');
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, "extract.csv", &csv)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
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
