use super::*;

/// How many files one `#add-file for each …` may create.
///
/// The fan-out has no preview and no undo: the model's list becomes one
/// generated file per entry, and removing them is a per-file job in the Files
/// list. Uncapped, a conversation that happens to contain a long list (a pasted
/// table, a CSV) filled the room. Generous enough that a real "one per client"
/// ask still completes in one go, small enough that a runaway list is a nuisance
/// rather than a cleanup session — and what is left out is always named.
pub(crate) const MAX_FAN_OUT_FILES: usize = 25;

/// The fan-out list, cut to [`MAX_FAN_OUT_FILES`], plus HOW MANY were left out.
///
/// The count is returned rather than dropped so the answer can say what it did
/// not do — "Created 25 files" for a list of 90 is a true sentence that reads
/// as a complete one.
fn cap_fan_out(items: Vec<String>) -> (Vec<String>, usize) {
    let over = items.len().saturating_sub(MAX_FAN_OUT_FILES);
    (items.into_iter().take(MAX_FAN_OUT_FILES).collect(), over)
}

pub(crate) async fn cmd_remember(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let fact = ctx.args.trim();
    if fact.is_empty() {
        return Err("Usage: #remember <fact>".into());
    }
    // Saved verbatim: a fact worth remembering isn't worth silently cutting at
    // 500 characters. (Settings → Memory still applies its own editor limit.)
    let fact = fact.to_string();
    ctx.state.with_room(|room| {
        if duplicate_memory(&room.conn, &fact)?.is_some() {
            return Ok(CommandResult {
                content: "That's already in this room's memory.".into(),
                ..Default::default()
            });
        }
        // #remember stays uncategorized (Wave 1b: categories are optional).
        db::add_memory(&room.conn, &fact, None)?;
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
    // #find is a search result list the user reads, not prompt context — show
    // every match, not the top 6 that a model's context window can afford.
    let emb_ref = emb.as_deref();
    let (chunks, fallback) = ctx
        .state
        .with_room(|room| retrieve_context_limited(&room.conn, query, emb_ref, &HashSet::new(), None))?;
    if fallback || chunks.is_empty() {
        return Ok(CommandResult {
            content: format!("No matches found for **{query}**."),
            ..Default::default()
        });
    }
    let mut body = format!("Matches for **{query}** ({}):\n\n", chunks.len());
    let mut sources: Vec<String> = Vec::new();
    for c in chunks.iter() {
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
        // Full ops: reduce the conversation ONCE, up front. It was attached whole
        // to the enumeration call and then again to every per-file call — twenty
        // files meant twenty copies of the chat, and on a small local model the
        // instruction fell out of the window behind it. A chat that already fits
        // one call is passed through untouched, so the common case is unchanged.
        let history = ctx.digest(ctx.history, "Reading the conversation").await;
        // Enumerate: the one genuinely fuzzy step. MIGRATION Phase 3: the prompt,
        // schema and `parse_string_list` (dedupe, no cap — a 20-item list makes 20
        // files) live in the sidecar's /knowledge_extract mode:list, which returns
        // the finished `items`. Rust keeps the subject parse, the empty-list
        // error, and the per-item loop.
        let req = serde_json::json!({
            "model": ctx.model,
            "base_url": ollama::resolved_base_url(),
            "mode": "list",
            "subject": subject,
            "conversation": history,
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
        // A cap, because there is no undo and no preview: the model's list goes
        // straight to one generated file per entry, and the only way back is
        // deleting them one at a time. A conversation that mentions a hundred
        // things (a table, a pasted CSV) used to produce a hundred files. What
        // is NOT created is named below rather than silently dropped.
        let (items, over) = cap_fan_out(items);
        let mut created: Vec<String> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if ctx.cancelled() {
                break;
            }
            ctx.step(
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
                "history": history,
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
            // ART-1: `created` must only ever name files that really landed, so
            // it is fed from the committed meta — a staged write that failed
            // validation or lost a cancel race adds nothing to the list.
            if let Ok(w) = Artifact::note(&name, &doc)
                .by("#add-file")
                .during_run(Some(ctx.turn.run_id()))
                .cancel_with(&ctx.cancel)
                .commit(&room.conn)
            {
                created.push(w.meta.name);
            }
        }
        let _ = ctx.window.emit("room-files-changed", ());
        if created.is_empty() {
            return Err("Couldn't create any files — the model returned nothing.".into());
        }
        let list = created.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n");
        // Empty must read as empty, and a cut list must read as cut: the run
        // stopping at the cap is not the same as the conversation having had
        // exactly that many items in it.
        let capped = if over > 0 {
            format!(
                "\n\nStopped at {MAX_FAN_OUT_FILES} files — {over} more were named. \
                 Ask again naming the ones you still want."
            )
        } else {
            String::new()
        };
        return Ok(CommandResult {
            content: format!(
                "Created {} file(s):\n{list}{capped}\n\n_Delete any you don't want from the Files list._",
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
    // Whole pinned files as the brief; digested (not clamped) if they outgrow one
    // call, so a document written "from @source.pdf" reflects all of it.
    let refctx = ctx.state.with_room(|room| Ok(refs_context(&room.conn, ctx.refs).0))?;
    let refctx = ctx.digest(&refctx, "Reading the pinned files").await;
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
    // ART-1: staged, cancel-checked at the write, and versioned when the same
    // document is asked for twice.
    let written = save_and_open(
        ctx.window,
        ctx.state,
        Artifact::new(&name, &note_mime(&name), &doc)
            .by("#add-file")
            .during_run(Some(ctx.turn.run_id()))
            .from_files(ctx.refs)
            .cancel_with(&ctx.cancel),
    )?;
    let meta = written.meta;
    Ok(CommandResult {
        content: if written.versioned {
            format!(
                "Rewrote **{}** and opened it — the previous version is in History.",
                meta.name
            )
        } else {
            format!("Created **{}** and opened it.", meta.name)
        },
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
    // Full ops: search the WHOLE document, one window at a time, stopping at the
    // first window that yields a quote the file actually contains. A passage past
    // the old 6000-byte clamp — page 3 of anything — used to be unfindable.
    const QUOTE_SYS: &str =
        "You locate an exact passage. Output ONLY the shortest verbatim quote from the \
         document that best matches the request — copied character-for-character, with no \
         quotation marks around it and no other words. If this part of the document does not \
         contain the requested thing, output nothing at all.";
    let windows = cmd_windows(&extracted);
    let total = windows.len();
    let mut found: Option<(serde_json::Value, String)> = None;
    for (i, w) in windows.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        if total > 1 {
            ctx.step(format!("Looking for it ({}/{})", i + 1, total));
        }
        let Ok(quote) = ctx
            .ask_quiet(QUOTE_SYS, format!("Request: {thing}\n\nDocument:\n{w}"), Some(0.0))
            .await
        else {
            ctx.note_unread();
            continue;
        };
        let quote = quote.trim().trim_matches('"').trim().to_string();
        if quote.is_empty() {
            continue;
        }
        // The annotation is built against the FULL text, so a quote found in a
        // later window still resolves to its real position in the file.
        if let Ok(hit) =
            build_annotation(file_id, &real_name, Some(&extracted), &quote, "", None, None, None)
        {
            found = Some(hit);
            break;
        }
    }
    let (payload, described) =
        found.ok_or_else(|| format!("Couldn't find an exact passage for \"{thing}\" in {real_name}."))?;
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

/// Deterministic column extraction for a CSV/TSV file: if EVERY requested field
/// names a column header (case-insensitively), return one output row per data
/// row holding just those columns — no model call at all. A small local model
/// can't reliably pull columns from a table via the per-field string schema (it
/// hands back `(not found)` for every field), whereas a direct column read is
/// exact, instant, and gives the user the per-row sheet they expect. Returns
/// `None` for a non-tabular file, or when any requested field doesn't match a
/// header, so the caller falls back to the model-based scalar path.
fn tabular_field_rows(name: &str, text: &str, fields: &[String]) -> Option<Vec<Vec<String>>> {
    let delim = match extraction::extension_of(name).as_str() {
        "csv" => ',',
        "tsv" => '\t',
        _ => return None,
    };
    let table = parse_delim(text, delim);
    let header = table.first()?;
    let norm = |s: &str| s.trim().to_lowercase();
    // Resolve each requested field to a header column; bail to the model path if
    // any is absent (the fields may be computed values, not column names).
    let cols: Vec<usize> = fields
        .iter()
        .map(|f| header.iter().position(|h| norm(h) == norm(f)))
        .collect::<Option<Vec<usize>>>()?;
    let rows = table
        .iter()
        .skip(1)
        .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
        .map(|r| cols.iter().map(|&c| r.get(c).cloned().unwrap_or_default()).collect())
        .collect();
    Some(rows)
}

/// Strip the trailing "from"/"in"/"of" the UI leaves behind after removing the
/// @tokens — but only as a WHOLE WORD. `trim_end_matches` matches the bare
/// letters anywhere at the end, which turned the last requested field "margin"
/// into "marg", "origin" into "orig" and "proof" into "pro", so the sheet came
/// back with a mangled column the model could never fill.
fn strip_trailing_preposition(args: &str) -> &str {
    let s = args.trim_end();
    for word in ["from", "in", "of"] {
        if let Some(rest) = s.strip_suffix(word) {
            if rest.is_empty() || rest.ends_with(char::is_whitespace) {
                return rest.trim_end();
            }
        }
    }
    s
}

pub(crate) async fn cmd_extract(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    if ctx.refs.is_empty() {
        return Err("Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf".into());
    }
    let fields_str = strip_trailing_preposition(ctx.args.trim());
    let fields: Vec<String> = fields_str
        .split(',')
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if fields.is_empty() {
        return Err("Say which fields to extract — e.g. #extract revenue, CEO from @a @b".into());
    }
    let files = ctx.state.with_room(|room| Ok(refs_files(&room.conn, ctx.refs)))?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut header = vec!["File".to_string()];
    header.extend(fields.iter().cloned());
    rows.push(header);
    for (i, (name, text)) in files.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        ctx.step(format!("Reading {name} ({}/{})", i + 1, files.len()));
        // A CSV/TSV whose columns match the requested fields is read directly —
        // exact, instant, per-row, and model-free (a local model can't pull
        // table columns via the field schema; see tabular_field_rows).
        if let Some(data_rows) = tabular_field_rows(name, text, &fields) {
            for data_row in data_rows {
                let mut row = vec![name.clone()];
                row.extend(data_row);
                rows.push(row);
            }
            continue;
        }
        // MIGRATION Phase 3: the per-field schema, prompt, structured call and
        // "(not found)" defaulting live in the sidecar's /knowledge_extract
        // mode:fields, which returns `values` keyed by every requested field. Rust
        // keeps the windowing, the CSV assembly and the ask-step emits. To
        // preserve the old best-effort behavior (a failed structured call became a
        // `(not found)` row rather than aborting the whole run), a sidecar error
        // maps to an all-`(not found)` row for this file.
        //
        // Full ops: read the whole file, window by window, keeping the first real
        // value found for each field and stopping as soon as every field is
        // answered. A figure on page 9 used to be "(not found)" because only the
        // first 6000 bytes were ever shown to the model.
        let windows = cmd_windows(text);
        let total = windows.len();
        let mut found: HashMap<String, String> = HashMap::new();
        for (w_i, doc) in windows.iter().enumerate() {
            if ctx.cancelled() || found.len() == fields.len() {
                break;
            }
            if total > 1 {
                ctx.step(
                    format!("Reading {name} — part {}/{} ({}/{})", w_i + 1, total, i + 1, files.len()),
                );
            }
            // Only ask for what is still missing, so later windows get a smaller,
            // sharper question instead of re-deriving what page 1 already gave.
            let missing: Vec<String> =
                fields.iter().filter(|f| !found.contains_key(*f)).cloned().collect();
            let req = serde_json::json!({
                "model": ctx.model,
                "base_url": ollama::resolved_base_url(),
                "mode": "fields",
                "fields": missing,
                "document": doc,
                "temperature": 0.0,
                "keep_alive": KEEP_ALIVE_WARM,
            });
            let values = match crate::sidecar::sidecar_json("/knowledge_extract", &req).await {
                Ok(v) => v["values"].clone(),
                // This window went unread — a field it held reads as "(not found)"
                // unless a later window has it, so say so rather than imply the
                // whole file was searched.
                Err(_) => {
                    ctx.note_unread();
                    serde_json::json!({})
                }
            };
            for f in &missing {
                let val = value_str(&values, f);
                let val = val.trim();
                if !val.is_empty() && !val.eq_ignore_ascii_case("(not found)") {
                    found.insert(f.clone(), val.to_string());
                }
            }
        }
        let mut row = vec![name.clone()];
        for f in &fields {
            row.push(found.remove(f).unwrap_or_else(|| "(not found)".to_string()));
        }
        rows.push(row);
    }
    let csv = serialize_delim(&rows, ',');
    let meta = save_and_open(
        ctx.window,
        ctx.state,
        Artifact::new("extract.csv", &note_mime("extract.csv"), &csv)
            .by("#extract")
            .during_run(Some(ctx.turn.run_id()))
            .from_files(ctx.refs)
            .cancel_with(&ctx.cancel),
    )?
    .meta;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn tabular_field_rows_reads_matching_columns_per_row() {
        let csv = "product,category,units_sold,unit_price,revenue\n\
                   Widget A,Gadgets,120,19.99,2398.80\n\
                   Widget B,Gadgets,80,29.99,2399.20\n";
        // Case-insensitive header match, requested out of source order.
        let rows = tabular_field_rows("sales.csv", csv, &s(&["Product", "revenue"])).unwrap();
        assert_eq!(rows, vec![s(&["Widget A", "2398.80"]), s(&["Widget B", "2399.20"])]);
    }

    #[test]
    fn tabular_field_rows_bails_when_a_field_is_not_a_column() {
        let csv = "product,revenue\nWidget A,2398.80\n";
        // "total profit" isn't a header → None → caller uses the model path.
        assert!(tabular_field_rows("sales.csv", csv, &s(&["product", "total profit"])).is_none());
    }

    #[test]
    fn tabular_field_rows_only_for_tabular_extensions() {
        let csv = "product,revenue\nWidget A,2398.80\n";
        // Same content, non-tabular extension → not treated as a table.
        assert!(tabular_field_rows("notes.md", csv, &s(&["product", "revenue"])).is_none());
    }

    #[test]
    fn trailing_preposition_only_strips_a_whole_word() {
        // The UI leaves the preposition behind after removing the @tokens.
        assert_eq!(strip_trailing_preposition("revenue, CEO from"), "revenue, CEO");
        assert_eq!(strip_trailing_preposition("revenue in "), "revenue");
        assert_eq!(strip_trailing_preposition("share of"), "share");
        // …but a field that merely ENDS in those letters keeps them.
        assert_eq!(strip_trailing_preposition("gross margin"), "gross margin");
        assert_eq!(strip_trailing_preposition("country of origin"), "country of origin");
        assert_eq!(strip_trailing_preposition("burden of proof"), "burden of proof");
        // Nothing but the preposition leaves nothing (the caller then errors).
        assert_eq!(strip_trailing_preposition("from"), "");
    }

    /// `#add-file for each …` writes one generated file per item with no
    /// preview and no undo, so an unbounded list (a pasted table, a CSV) filled
    /// the room and left a per-file cleanup. The cut is bounded AND counted —
    /// a silent truncation would read as "that was the whole list".
    #[test]
    fn the_fan_out_is_capped_and_says_what_it_left_out() {
        let small: Vec<String> = (0..3).map(|i| format!("item {i}")).collect();
        let (kept, over) = cap_fan_out(small.clone());
        assert_eq!(kept, small, "a short list is untouched");
        assert_eq!(over, 0, "nothing was left out, so nothing may be claimed");

        let long: Vec<String> = (0..90).map(|i| format!("item {i}")).collect();
        let (kept, over) = cap_fan_out(long);
        assert_eq!(kept.len(), MAX_FAN_OUT_FILES);
        assert_eq!(over, 90 - MAX_FAN_OUT_FILES);
        // The kept ones are the FIRST ones, in the model's own order.
        assert_eq!(kept[0], "item 0");

        // Exactly at the cap is not "over".
        let exact: Vec<String> = (0..MAX_FAN_OUT_FILES).map(|i| format!("i{i}")).collect();
        assert_eq!(cap_fan_out(exact).1, 0);
    }

    #[test]
    fn tabular_field_rows_handles_tsv_and_quoted_commas() {
        let tsv = "name\tnote\nAcme\t\"a, b, c\"\n";
        let rows = tabular_field_rows("data.tsv", tsv, &s(&["note", "name"])).unwrap();
        assert_eq!(rows, vec![s(&["a, b, c", "Acme"])]);
    }
}
