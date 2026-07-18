use super::*;

/// Case- and whitespace-insensitive form used to verify quotes the model
/// wants to highlight or edit actually exist in a file. Typographic
/// look-alikes (curly quotes, dashes, ligatures) are folded so extracted
/// text and model quotes can meet in the middle.
pub(crate) fn normalize_for_match(s: &str) -> String {
    let mut folded = String::with_capacity(s.len());
    for c in s.to_lowercase().chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' => folded.push('\''),
            '\u{201C}' | '\u{201D}' => folded.push('"'),
            // Hebrew maqaf ־ ≡ hyphen: models type בן-דוד for the file's בן־דוד.
            '\u{2013}' | '\u{2014}' | '\u{05BE}' => folded.push('-'),
            '\u{FB01}' => folded.push_str("fi"),
            '\u{FB02}' => folded.push_str("fl"),
            // Hebrew nikud/cantillation: search chunks are consonantal, file
            // text may be pointed — fold both to consonants so quotes meet.
            c if extraction::is_heb_mark(c) => {}
            _ => folded.push(c),
        }
    }
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build a viewer annotation payload for a file, verifying a text quote appears
/// verbatim in the extracted text (normalization-tolerant, with a space-free
/// fallback for PDFs). Shared by the annotate_file tool and the #highlight
/// workflow so both go through the same ground-truth check. Returns the payload
/// plus a short human description; errs if the quote can't be found or neither a
/// quote nor a cell range was given.
#[allow(clippy::too_many_arguments)]
/// ADD-22: when an exact/normalized annotate quote can't be found (small models
/// paraphrase or drop a word), locate the passage in `extracted` that best
/// matches by word overlap and return it VERBATIM, so the viewer's own matcher
/// can still highlight it. None when nothing is a solid match. The returned
/// string is always a real substring of `extracted` (byte-safe spans), and a
/// strict word-majority is required so we never highlight something unrelated.
pub(crate) fn closest_snippet(extracted: &str, quote: &str) -> Option<String> {
    let q_words: Vec<String> = quote.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect();
    if q_words.len() < 3 {
        return None; // too short to approximate safely
    }
    let h = words_with_byte_spans(extracted);
    if h.is_empty() {
        return None;
    }
    let q_set: std::collections::HashSet<&str> = q_words.iter().map(String::as_str).collect();
    let win = q_words.len();
    let mut best: Option<(usize, usize, usize)> = None; // (score, start_idx, end_idx_excl)
    for w in [win.saturating_sub(2).max(2), win, win + 2] {
        if w > h.len() {
            continue;
        }
        for i in 0..=h.len() - w {
            let score = h[i..i + w].iter().filter(|(_, _, word)| q_set.contains(word.as_str())).count();
            if best.map_or(true, |(bs, _, _)| score > bs) {
                best = Some((score, i, i + w));
            }
        }
    }
    let (score, si, ei) = best?;
    if score * 2 <= win {
        return None; // need a strict majority of the quote's words present
    }
    Some(extracted[h[si].0..h[ei - 1].1].to_string())
}

/// Validate every cell reference up front so a bad one fails before any write.
fn validate_cell_refs(updates: &[(String, String)]) -> Result<(), String> {
    for (cell, _) in updates {
        if parse_a1(cell).is_none() {
            return Err(format!("\"{cell}\" is not a cell — use A1 notation like B7."));
        }
    }
    Ok(())
}

/// Collapse a token to its comparison key: lowercase alphanumerics only.
fn norm(w: &str) -> String {
    w.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// Each whitespace-delimited word of `text` as (byte start, byte end, key),
/// where key is the [`norm`]-alized form; words that normalize to empty (pure
/// punctuation) are dropped. The byte spans land on char boundaries, so slicing
/// `text` with them is UTF-8-safe.
fn words_with_byte_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut words: Vec<(usize, usize, String)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                let w = norm(&text[s..i]);
                if !w.is_empty() {
                    words.push((s, i, w));
                }
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        let w = norm(&text[s..]);
        if !w.is_empty() {
            words.push((s, text.len(), w));
        }
    }
    words
}

pub(crate) fn build_annotation(
    id: &str,
    real_name: &str,
    extracted: Option<&str>,
    quote: &str,
    range: &str,
    page: Option<u64>,
    sheet: Option<&str>,
    note: Option<&str>,
) -> Result<(serde_json::Value, String), String> {
    let quote = quote.trim();
    if !range.is_empty() {
        if !is_a1_range(range) {
            return Err(format!(
                "\"{range}\" is not a cell range — use A1 notation like B7 or B2:D5."
            ));
        }
        let payload = serde_json::json!({
            "fileId": id, "name": real_name, "sheet": sheet,
            "range": range, "note": note,
        });
        Ok((payload, format!("cells {range}")))
    } else if !quote.is_empty() {
        let haystack = normalize_for_match(extracted.unwrap_or_default());
        let needle = normalize_for_match(quote);
        // PDF extraction breaks words unpredictably; fall back to a space-free
        // comparison before rejecting the quote.
        let found = haystack.contains(&needle)
            || haystack.replace(' ', "").contains(&needle.replace(' ', ""));
        // ADD-22: on a miss, don't hard-fail — anchor on the closest real passage
        // so a paraphrased/near quote still highlights (marked approximate).
        let (final_quote, approx) = if found {
            (quote.to_string(), false)
        } else if let Some(snip) = closest_snippet(extracted.unwrap_or_default(), quote) {
            (snip, true)
        } else {
            return Err(format!(
                "Could not find that text in \"{real_name}\". Copy a short snippet exactly as \
                 it appears in the file (use search_room or open_file to see its text first)."
            ));
        };
        let payload = serde_json::json!({
            "fileId": id, "name": real_name, "quote": final_quote,
            "page": page, "note": note, "approx": approx,
        });
        let described = if approx {
            format!("\"{final_quote}\" (closest match)")
        } else {
            format!("\"{final_quote}\"")
        };
        Ok((payload, described))
    } else {
        Err("Provide either exact text to highlight, or a cell range for spreadsheets.".into())
    }
}

// ---------------------------------------------------------------- room lifecycle

#[tauri::command]
pub async fn ask(
    window: tauri::Window,
    state: State<'_, AppState>,
    ask_id: String,
    chat_id: String,
    question: String,
    attachments: Vec<String>,
) -> Result<Message, String> {
    use tauri::Emitter;

    // Wave 3 (Idea 9): don't start a turn while a rollback is swapping the DB —
    // it would save messages that either fail or land against the wrong room.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }

    // ADD-7: register this ask's cancel flag; the guard removes it on return
    // (success, error, or cancel) so `close_room`'s wait can see us finish.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .unwrap()
        .insert(ask_id.clone(), cancel.clone());
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: ask_id.clone(),
    };

    // ADD-31: the audit's worst wait was an anonymous "Thinking locally…" for
    // 30+ seconds. Name the two hidden phases: waking the daemon (ADD-29 makes
    // this implicit and slow the first time) and searching the room.
    if !crate::ollama_lifecycle::is_awake(&ollama::resolved_base_url()).await {
        let _ = window.emit("ask-step", "Starting the local AI…");
    }
    let _ = window.emit("ask-step", "Searching your files…");

    // ADD-13: embed the question BEFORE taking the room lock (the Ollama call is
    // async; the lock is not held across it). None on any failure → keyword-only.
    let question_embedding = embed_question(&question).await;

    // Phase 1 (locked): gather context, save the user message.
    let QuestionContext {
        explicit_model,
        chat_messages,
        sources,
        first_image,
        temperature,
        web_enabled,
        advisors_on,
        advisor_tools_on,
        injected_rowids,
    } = gather_context_and_save_question(
        &window,
        &state,
        &chat_id,
        &question,
        &attachments,
        question_embedding.as_deref(),
    )?;

    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit_model
        .clone()
        .unwrap_or_else(|| best_default(&models));
    // ADD-29 parity: the selected engine drives the app itself — no silent
    // reroute to a local model. Current `:cloud` models emit structured tool
    // calls and honor the `format` grammar (verified on-device), and the
    // `chat_core` inline-tool-call net (ADD-29) recovers any engine that leaks
    // calls as text, so a cloud model runs the same tool loop a local one does.
    // External CLIs (claude-cli/codex-cli) remain a separate subprocess path
    // handled below.

    // CHG-19: the "where is X?" grounding pass is deferred to AFTER the answer
    // (nothing in the reply depends on the boxes), so the warm chat model streams
    // the first token immediately instead of waiting on a vision-model load.
    let mut effects = ToolEffects::default();
    // ADD-25: perception tools attach pixels only when the chat model can
    // read them; otherwise they fall back to a local vision-model description.
    effects.vision_chat = is_vision_chat_model(&model);

    // Phase 2 (unlocked): answer — through a cloud CLI if selected, or the
    // local model with full app-control tools.
    let answer = stream_answer(
        &window,
        &state,
        &model,
        &question,
        chat_messages,
        temperature,
        &mut effects,
        web_enabled,
        advisors_on,
        advisor_tools_on,
        cancel.clone(),
        &injected_rowids,
    )
    .await?;
    let stopped = cancel.load(Ordering::SeqCst);

    // CHG-19 + CHG-17: run the image-grounding pass now, AFTER the answer, and
    // ONLY if the model didn't already mark the image via the mark_image tool
    // (effects.boxes set) and the user didn't stop. This gives fast time-to-
    // first-token and structurally eliminates the redundant second vision pass
    // (chat→vision→chat→vision) that the old pre-answer ordering caused on
    // 16 GB Macs. CHG-18: the trigger now also considers the image's file name.
    if effects.boxes.is_none() && !stopped {
        if let Some((img_id, img_name, img_bytes, w, h)) = &first_image {
            if is_locate_intent(&question, Some(img_name)) {
                let mut vmodel = vision_model(&models, &model);
                if is_external_engine(&vmodel) {
                    vmodel = best_default(&models);
                }
                if !models.is_empty() && !is_external_engine(&vmodel) {
                    let messages = vec![ollama::ChatMessage {
                        role: "user".into(),
                        content: grounding_prompt(&question, *w, *h),
                        images: Some(vec![
                            base64::engine::general_purpose::STANDARD.encode(img_bytes),
                        ]),
                        ..Default::default()
                    }];
                    // HLT-5: short keep_alive for this vision pass on low-RAM Macs.
                    let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &model);
                    if let Ok(raw) =
                        ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &boxes_schema(), Default::default())
                            .await
                    {
                        let boxes = parse_boxes(&raw, *w, *h);
                        if !boxes.is_empty() {
                            effects.boxes = Some(serde_json::json!({
                                "fileId": img_id,
                                "name": img_name,
                                "boxes": boxes,
                            }));
                            let _ = window.emit("ask-step", "Marked the image");
                        }
                    }
                }
            }
        }
    }

    let mut content = answer;
    // CHG-10: deterministic anti-fabrication gate. The prompt asks the model
    // never to claim a change it didn't make; here the runtime KNOWS whether a
    // write/highlight actually happened this turn (effects), so append a plain
    // correction when the local answer claims one that didn't. Local path only
    // (cloud has no tool effects) and never over a stopped partial.
    if !is_external_engine(&model) && !stopped {
        let highlighted = effects.annotation.is_some() || effects.boxes.is_some();
        if claims_unbacked_action(&content, effects.wrote, highlighted) {
            content.push_str(
                "\n\n*(Correction: no file was actually changed this turn — the edit tool did \
                 not run or failed.)*",
            );
        }
    }
    // ADD-7: mark the transcript so it matches what the user watched.
    if stopped {
        content.push_str(" *(stopped)*");
    }
    // ADD-23: viewer effects ride the message's own `effects` column as
    // structured data — the visible answer stays plain prose. (Fenced
    // ```boxes/```annotation blocks in old rooms are still parsed by the UI
    // as a legacy fallback.)
    let effects_value = effects_json(&effects);

    // Phase 3 (locked): save the assistant reply.
    persist_assistant_reply(&state, &chat_id, content, sources, effects_value)
}

/// Everything Phase 1 (the room-locked pass) produces for the rest of `ask`:
/// resolved settings, the assembled chat messages, the source chips shown to the
/// user, the first attached image (held back for the deferred grounding pass),
// ---- Wave 1b (idea 12): response-style presets --------------------------------

/// Canned register paragraphs, tuned for a 4B model: short, imperative, one
/// anchored example each. These are BYTE-STABLE constants (ADD-22): the system
/// prompt only changes when the `response_style` setting changes, exactly like
/// custom instructions, so KV-cache reuse is preserved within a conversation.
const STYLE_TERSE: &str = "Response style: TERSE. Answer in the fewest words that fully \
    answer. Use short sentences or bullets. Use precise technical vocabulary; never \
    simplify terminology. No greetings, no restating the question, no \"Sure\" or \
    \"Great question\", no closing offers like \"Let me know if you need more\". \
    Example — Q: \"When does the lease end?\" A: \"March 31, 2027 (lease.pdf, section 2).\"";
const STYLE_FRIENDLY: &str = "Response style: FRIENDLY. Sound like a helpful colleague: \
    warm, plain everyday words, address the user as \"you\". At most one short warm \
    phrase per answer, then get straight to the point — the answer itself must arrive \
    in the first sentence. After the direct answer, briefly explain the why or the \
    context. Example — Q: \"When does the lease end?\" A: \"Good news — your lease runs \
    until March 31, 2027 (it's in lease.pdf, section 2).\"";
const STYLE_FORMAL: &str = "Response style: FORMAL. Write complete sentences in \
    professional business language. No slang, no contractions, no exclamation marks, \
    no emoji. State findings precisely and cite the file. For multi-part answers, use \
    short headings or numbered points. Example — Q: \"When does the lease end?\" A: \
    \"The lease terminates on 31 March 2027, as stated in Section 2 of lease.pdf.\"";

/// Map the stored `response_style` setting to its preset paragraph. Anything
/// else — `None`, `"default"`, an unknown value — maps to `None`, so absent or
/// unrecognized settings produce a system prompt byte-identical to today's.
pub(crate) fn style_paragraph(style: Option<&str>) -> Option<&'static str> {
    match style {
        Some("terse") => Some(STYLE_TERSE),
        Some("friendly") => Some(STYLE_FRIENDLY),
        Some("formal") => Some(STYLE_FORMAL),
        _ => None,
    }
}

/// The injectable style block: the preset paragraph plus — only when the user
/// ALSO has custom instructions — one precedence sentence (triage rule: free
/// text always wins over the preset). Pure so tests can pin byte-stability.
pub(crate) fn style_block(style: Option<&str>, has_custom_instructions: bool) -> Option<String> {
    let para = style_paragraph(style)?;
    Some(if has_custom_instructions {
        format!(
            "{para} If the user's standing preferences below say otherwise, follow the \
             user's preferences."
        )
    } else {
        para.to_string()
    })
}

/// and the flags/rowids the answer phase needs.
struct QuestionContext {
    explicit_model: Option<String>,
    chat_messages: Vec<ollama::ChatMessage>,
    sources: Vec<String>,
    first_image: Option<(String, String, Vec<u8>, f64, f64)>,
    temperature: Option<f64>,
    web_enabled: bool,
    advisors_on: bool,
    advisor_tools_on: bool,
    injected_rowids: HashSet<i64>,
}

/// Phase 1 (locked): gather the room's context and save the user's message.
/// Runs entirely under the room mutex and performs NO `.await`, so the guard is
/// never held across a suspension point — the lock discipline `ask` relies on.
fn gather_context_and_save_question(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    chat_id: &str,
    question: &str,
    attachments: &[String],
    question_embedding: Option<&[f32]>,
) -> Result<QuestionContext, String> {
    use tauri::Emitter;
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;

        let explicit_model = model_setting(conn);
        let temperature: Option<f64> = db::get_setting(conn, "temperature")
            .and_then(|s| s.parse().ok());
        let custom_instructions: Option<String> = db::get_setting(conn, "custom_instructions");
        // Wave 1b (idea 12): the user's chosen response register for this room.
        let response_style: Option<String> = db::get_setting(conn, "response_style");

        let memories: Vec<String> = db::list_memories(conn)?
            .into_iter()
            .map(|m| m.content)
            .collect();

        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, chat_id, MAX_HISTORY_MESSAGES as i64)?;
            rows.reverse();
            rows
        };

        let (context_chunks, context_fallback) =
            retrieve_context(conn, question, question_embedding)?;
        // CHG-16: rowids already injected as context, so a search_room repeat
        // of the same question returns the next-best chunks instead of dupes.
        let injected_rowids: HashSet<i64> = if context_fallback {
            HashSet::new()
        } else {
            context_chunks.iter().map(|c| c.rowid).filter(|r| *r >= 0).collect()
        };

        // Attachments: images go to the model as vision input, text files as
        // guaranteed context.
        let mut images: Vec<String> = Vec::new();
        let mut attached_notes: Vec<String> = Vec::new();
        let mut sources: Vec<String> = Vec::new();
        let mut first_image: Option<(String, String, Vec<u8>, f64, f64)> = None;
        // Shared first-come budget so many text attachments can't blow the
        // context window; images are separately capped at MAX_ATTACHED_IMAGES.
        let mut text_budget = MAX_ATTACHED_TEXT_TOTAL;
        let mut skipped_attachments: Vec<String> = Vec::new();
        for file_id in attachments {
            let (name, mime, bytes, text) = match db::get_file_full(conn, file_id) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let mime = mime.unwrap_or_default();
            if extraction::is_image(&mime) {
                if images.len() < MAX_ATTACHED_IMAGES {
                    if let Some(bytes) = bytes {
                        let (prepared, w, h) = prepare_image(&bytes);
                        if first_image.is_none() {
                            first_image =
                                Some((file_id.clone(), name.clone(), prepared.clone(), w, h));
                        }
                        images.push(base64::engine::general_purpose::STANDARD.encode(&prepared));
                        attached_notes.push(format!("(Attached image: {name})"));
                        sources.push(name);
                    }
                }
            } else if let Some(text) = text {
                // Per-file cap of 6000, further limited by the remaining shared
                // budget. A file that gets too small a slice to be useful is
                // skipped entirely so its source chip stays honest.
                let allow = text_budget.min(6000);
                if allow < 200 && text.len() > allow {
                    skipped_attachments.push(name);
                    continue;
                }
                let truncated = text.len() > allow;
                let mut text = clamp_bytes(text, allow);
                text_budget = text_budget.saturating_sub(text.len());
                if truncated {
                    text.push_str("\n… (truncated)");
                    // UX-4: the AI saw only the beginning — say so, by name.
                    // ADD-32: and point at the tool that DOES cover everything.
                    let _ = window.emit(
                        "ask-notice",
                        format!(
                            "Only the beginning of \"{name}\" was included (file is large). \
                             For guaranteed full coverage, ask me to run a full pass over it."
                        ),
                    );
                }
                attached_notes.push(format!("[attached file: {name}]\n{text}"));
                sources.push(name);
            }
        }
        if !skipped_attachments.is_empty() {
            let first = skipped_attachments[0].clone();
            let more = skipped_attachments.len() - 1;
            let tail = if more > 0 {
                format!(" and {more} more attachment(s)")
            } else {
                String::new()
            };
            let _ = window.emit(
                "ask-notice",
                format!(
                    "\"{first}\"{tail} were skipped — too much attached text for one \
                     question; ask about them separately."
                ),
            );
        }

        // Only credit files that genuinely matched the question. On the
        // zero-score fallback the chunks are just "recent content", so they
        // must not appear as source chips (CHG-10). Attachments still count.
        if !context_fallback {
            for chunk in &context_chunks {
                if !sources.contains(&chunk.file_name) {
                    sources.push(chunk.file_name.clone());
                }
            }
        }

        let web_enabled = web_access_enabled(conn);
        // ADD-21: whether the advisor tool may be offered this turn (the final
        // list of installed advisors is resolved after the lock, off-thread),
        // and whether a consulted Claude advisor may reach the room's tools.
        let advisors_on = advisors_enabled(conn);
        let advisor_tools_on = advisors_on && advisor_tools_enabled(conn);

        let mut system = String::from(
            "You are the private AI assistant inside \"Private Room\", a local encrypted \
             workspace. Everything you see stays on this computer. Answer the user's question \
             using the file excerpts provided as context when they are relevant, and mention \
             the file names you drew from. If the room's content does not contain the answer, \
             say so, then answer from general knowledge if you can. Be concise and useful.\n\n\
             You can control the app with your tools: list_room_files, search_room (find \
             content), open_file (show a file to the user in the viewer — it can jump to a \
             page, cell, or text), mark_image (draw boxes on an image), annotate_file \
             (highlight an exact quote or a cell range in a document or spreadsheet so the \
             user sees it), create_file (save a new note/document into the room), edit_file \
             (replace exact text in ONE place in an existing file — text, code, csv, or docx), \
             edit_files (change several places/files, or rename + update references, in ONE \
             atomic step — all succeed or none do), \
             write_file (rewrite a whole text file), set_cells (change a spreadsheet cell by \
             A1 reference like B7), rename_file (rename a file), move_file (move a file into a \
             folder), add_memory (remember something permanently). Use them \
             whenever the user asks you to open, show, mark, find, create, change, rename, move \
             or remember something — then give your answer in plain text. Before editing or annotating, \
             copy text exactly as it appears in the file (search_room shows it verbatim).\n\n\
             CRITICAL — never fabricate an action:\n\
             - To change a file you MUST call edit_file, write_file, or set_cells. NEVER say a \
             file was changed, edited, updated, saved, or fixed unless that tool call returned \
             success in THIS turn. Do not print a diff, a new version, or \"File updated\" from \
             memory — only a real tool result proves a change happened.\n\
             - To highlight or mark a passage you MUST call annotate_file with text copied \
             EXACTLY from the file. If you have not already seen the file's exact text this \
             turn, call open_file or search_room FIRST to read it, then annotate_file with the \
             verbatim quote. Never claim you highlighted, marked, or boxed anything unless \
             annotate_file (or mark_image) returned success this turn — a guessed quote that \
             fails to match is NOT a highlight.\n\
             - If a tool call fails or you cannot find the exact text, say so plainly and stop; \
             do not narrate success you did not achieve.\n\n\
             The room keeps one shared working-notes file named \"Scratch pad.md\": when the \
             user asks to jot, note, write down, or record something temporarily, edit_file or \
             write_file that file instead of making a new file; read it with open_file when \
             asked what is on the pad.",
        );
        if web_enabled {
            system.push_str(
                "\n\nThe user has turned web access ON for this room. You have two more \
                 tools: web_search (find pages) and fetch_page (read one page). \
                 IMPORTANT: for any question about current or recent things — weather, \
                 news, prices, sports, events, anything after your training data — you \
                 MUST call web_search first. Never answer that you lack real-time data: \
                 search instead. Mention that you searched the web in your answer.",
            );
        }

        let connected_mcp: Vec<String> = {
            let mgr = state.mcp.lock().unwrap();
            mgr.servers
                .iter()
                .filter(|s| s.client.is_some() && !s.tools.is_empty())
                .map(|s| s.name.clone())
                .collect()
        };
        if !connected_mcp.is_empty() {
            system.push_str(&format!(
                "\n\nThe user has also connected external tool servers to this room: {}. \
                 Their tools appear alongside the built-in ones and can reach the internet \
                 or other apps. IMPORTANT: when a question needs current or outside \
                 information (weather, news, prices, events) and no built-in tool covers \
                 it, you MUST use one of these tools instead of answering that you lack \
                 real-time data. Mention when you did.",
                connected_mcp.join(", ")
            ));
        }

        // Give the model an inventory so it can answer questions like
        // "what images do we have here?" without excerpts being retrieved.
        // CHG-9: newest-first with a partial-list marker; CHG-23: each file's
        // cached one-liner rides along under a running budget.
        let mut inventory: Vec<(String, String, Option<String>)> =
            db::list_file_inventory(conn)?;
        let inventory_partial = inventory.len() > 100;
        inventory.truncate(100);
        if !inventory.is_empty() {
            system.push_str("\n\nFiles currently stored in this room:\n");
            let mut liner_budget = 3_000usize;
            for (name, mime, summary) in &inventory {
                match summary {
                    Some(s) if liner_budget > 0 && !s.trim().is_empty() => {
                        let liner = clamp_words(s.trim(), 120);
                        liner_budget = liner_budget.saturating_sub(liner.len());
                        system.push_str(&format!("- {name} ({mime}) — {liner}\n"));
                    }
                    _ => system.push_str(&format!("- {name} ({mime})\n")),
                }
            }
            if inventory_partial {
                system.push_str(
                    "This list is partial (the room has more files) — call list_room_files \
                     for the complete list.\n",
                );
            }
            system.push_str(
                "You can see an image's pixels only when the user attaches it to a question \
                 (paperclip); otherwise you still know it exists by name.",
            );
        }

        // Wave 1b (idea 12): the response-style preset rides immediately before
        // the custom instructions. Byte-stable (a constant chosen by a setting),
        // so the ADD-22 KV-cache invariant holds — and when custom text is also
        // present the block itself states that the free text below wins.
        let has_custom = custom_instructions
            .as_deref()
            .is_some_and(|c| !c.trim().is_empty());
        if let Some(block) = style_block(response_style.as_deref(), has_custom) {
            system.push_str("\n\n");
            system.push_str(&block);
        }

        if let Some(custom) = &custom_instructions {
            if !custom.trim().is_empty() {
                system.push_str(
                    "\n\nThe user has set these standing preferences for how you respond:\n",
                );
                system.push_str(custom.trim());
            }
        }

        // ADD-22 (KV-cache): keep the system prompt BYTE-STABLE across a
        // conversation so Ollama reuses the cached prefix (measured elsewhere at
        // 40-65% faster first token). Per-question memory selection therefore
        // moves into the always-new user message below, not the system prompt.
        let mut chat_messages = vec![ollama::ChatMessage::new("system", system)];
        // Recency-weighted history: keep whole recent turns under one global
        // budget, dropping the oldest wholesale rather than cutting each turn
        // to a silently-unterminated 4000-char head (char-safe throughout).
        for (role, content) in compact_history(history, MAX_HISTORY_CHARS) {
            chat_messages.push(ollama::ChatMessage::new(&role, content));
        }

        let mut user_content = String::new();
        if !memories.is_empty() {
            // CHG-7 + ADD-22: budget-fitting, question-relevant memories are
            // injected HERE (the always-new user message) rather than the stable
            // system prompt, preserving KV-cache reuse of the system prefix.
            let chosen = select_memories(&memories, question, MAX_MEMORY_INJECT_CHARS);
            if !chosen.is_empty() {
                user_content.push_str("Notes to remember for this room:\n");
                for m in &chosen {
                    user_content.push_str(&format!("- {m}\n"));
                }
                user_content.push('\n');
            }
        }
        let has_context = !context_chunks.is_empty() || !attached_notes.is_empty();
        if has_context {
            user_content.push_str(if context_fallback && attached_notes.is_empty() {
                "Recently added content (may be unrelated to the question):\n\n"
            } else {
                "Context from files stored in this room:\n\n"
            });
            for note in &attached_notes {
                user_content.push_str(note);
                user_content.push_str("\n\n");
            }
            for chunk in &context_chunks {
                user_content.push_str(&format!("[file: {}]\n{}\n\n", chunk.file_name, chunk.text));
            }
            user_content.push_str("---\n\n");
        }
        user_content.push_str(&format!("Question: {question}"));

        chat_messages.push(ollama::ChatMessage {
            role: "user".into(),
            content: user_content,
            images: if images.is_empty() { None } else { Some(images) },
            ..Default::default()
        });

        db::insert_message(conn, chat_id, "user", question, &[], None)?;

        // First question names the session.
        let mut title: String = question.chars().take(48).collect();
        if question.chars().count() > 48 {
            title.push('…');
        }
        db::set_chat_title_if_new(conn, chat_id, &title)?;

        Ok(QuestionContext {
            explicit_model,
            chat_messages,
            sources,
            first_image,
            temperature,
            web_enabled,
            advisors_on,
            advisor_tools_on,
            injected_rowids,
        })
}

/// Phase 2 (unlocked): produce the answer. This is deliberately the single place
/// the answer is generated — a cloud CLI (`claude -p`/`codex`) for an external
/// engine, otherwise the local Python/LangGraph sidecar (the SOLE local engine;
/// no native fallback). Everything here awaits, so no room lock may be held
/// across it.
///
/// MIGRATION Phase 2b: `_advisors_on`/`_advisor_tools_on`/`_injected_rowids` were
/// consumed only by the now-deleted native `agent_loop` path; they are kept in the
/// signature (caller shape unchanged) pending a later plumbing cleanup.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_answer(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    model: &str,
    question: &str,
    chat_messages: Vec<ollama::ChatMessage>,
    temperature: Option<f64>,
    effects: &mut ToolEffects,
    web_enabled: bool,
    _advisors_on: bool,
    _advisor_tools_on: bool,
    cancel: Arc<AtomicBool>,
    _injected_rowids: &HashSet<i64>,
) -> Result<String, String> {
    use tauri::Emitter;
    let run = if is_external_engine(model) {
        // CHG-5: a step chip, not fake live text (nothing streams for cloud).
        let _ = window.emit("ask-step", "Asking your cloud AI (content leaves this Mac)");
        // ADD-20: Claude Code gets the room's tools over a per-ask localhost
        // MCP bridge — same exec_tool dispatch as the local agent, decryption
        // stays in-process, and the bridge dies when this ask returns.
        let bridge = if split_external_model(model).0 == "claude-cli" {
            use tauri::Manager;
            crate::room_mcp::start(
                window.app_handle().clone(),
                web_enabled,
                crate::room_mcp::ToolScope::CloudAdvisor { include_mcp: false },
                None,
                crate::room_mcp::StartOpts::default(),
            )
            .await
            .ok()
        } else {
            None
        };
        let res =
            run_external(model, &chat_messages, Some(cancel.clone()), bridge.as_ref()).await;
        if let Some(b) = &bridge {
            b.stop();
        }
        res
    } else {
        // MIGRATION Phase 2b: the Python/LangGraph sidecar is the app's SOLE local
        // AI engine — EVERY local turn routes through `/run`, including the
        // app-driving/perception turns (the perception tools now hand their
        // captured pixels back over the MCP bridge as `image` content, see
        // `crate::room_mcp`). There is NO native Rust LLM fallback: `Unavailable`
        // (the sidecar failed before any tool ran) surfaces a clear error rather
        // than a silent native path; `Failed` (a tool already committed) keeps the
        // partial so the committed side-effect stays visible. Neither re-runs.
        use crate::sidecar::SidecarOutcome;
        match crate::sidecar::run_via_sidecar(
            window,
            state,
            model,
            question,
            chat_messages.clone(),
            temperature,
            effects,
            web_enabled,
            cancel.clone(),
            false, // visible chat turn — emit the ask-* stream events
        )
        .await
        {
            SidecarOutcome::Done(text) => Ok(text),
            SidecarOutcome::Failed { text, error } => {
                // A tool already committed a side-effect this turn (the write/
                // annotation is now in the room and its effects are merged into
                // `effects`). Returning `Err` here would make `ask`'s `?` discard
                // BOTH the merged viewer effects and the assistant reply — the
                // file would change on disk with no transcript entry and no viewer
                // refresh. Instead return the partial as a normal answer with an
                // in-transcript failure note, so `ask` persists the reply + effects
                // and the viewer updates. We must NOT fall back to the native loop
                // (that would re-run the committed tool and double it).
                let mut out = text;
                if !out.trim().is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(&format!(
                    "*(The agent hit an error and stopped mid-run: {error}. Any change \
                     shown here was already applied.)*"
                ));
                Ok(out)
            }
            SidecarOutcome::Unavailable(reason) => {
                // MIGRATION (no fallback): the Python sidecar is the app's SOLE
                // local AI engine. When it can't start/connect before any tool ran,
                // we surface a clear error — there is NO native Rust LLM path to
                // drop to (the native `agent_loop` is deleted). Log the underlying
                // reason so a broken Python install is debuggable.
                eprintln!("agent sidecar unavailable: {reason}");
                Err("AI engine unavailable — the agent sidecar could not start.".to_string())
            }
        }
    };
    // When the user pressed Stop mid-answer, a raised error is expected —
    // swallow it and keep the partial (ADD-7).
    let stopped = cancel.load(Ordering::SeqCst);
    match run {
        Ok(text) => Ok(text),
        Err(_) if stopped => Ok(String::new()),
        Err(e) => Err(e),
    }
}

/// Phase 3 (locked): save the assistant reply. HLT-7: if the room was locked
/// mid-answer it is already closed — return quietly with the (unsaved) content
/// instead of surfacing "No room is open" to the UI.
pub(crate) fn persist_assistant_reply(
    state: &State<'_, AppState>,
    chat_id: &str,
    content: String,
    sources: Vec<String>,
    effects_value: Option<serde_json::Value>,
) -> Result<Message, String> {
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => db::insert_message(
            &room.conn,
            chat_id,
            "assistant",
            &content,
            &sources,
            effects_value.as_ref(),
        ),
        None => Ok(Message {
            id: String::new(),
            role: "assistant".into(),
            content,
            sources,
            created_at: String::new(),
            effects: effects_value,
        }),
    }
}

/// ADD-23: the message-row `effects` JSON for this turn's tool effects —
/// `{"boxes": ..?, "annotation": ..?}` — or None when neither fired, so the
/// column stays NULL for plain answers.
pub(crate) fn effects_json(effects: &ToolEffects) -> Option<serde_json::Value> {
    if effects.boxes.is_none() && effects.annotation.is_none() && effects.edit_outcomes.is_empty() {
        return None;
    }
    let mut map = serde_json::Map::new();
    if let Some(b) = &effects.boxes {
        map.insert("boxes".into(), b.clone());
    }
    if let Some(a) = &effects.annotation {
        map.insert("annotation".into(), a.clone());
    }
    // Wave 2 (Idea 4): content-free edit outcomes for this turn. The frontend
    // renders nothing from this key — it is telemetry (see edit_match).
    if !effects.edit_outcomes.is_empty() {
        map.insert(
            "edits".into(),
            serde_json::Value::Array(effects.edit_outcomes.clone()),
        );
    }
    Some(serde_json::Value::Object(map))
}

/// ADD-7: stop a running answer. Sets its cancel flag; a no-op for an unknown
/// id (the ask may have already finished).
#[tauri::command]
pub fn cancel_ask(state: State<'_, AppState>, ask_id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&ask_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Every built-in agent tool name — also the reserved set MCP tools may not
/// shadow. Keep in sync with `tools_catalog` and `exec_tool`.
pub(crate) const BUILTIN_TOOL_NAMES: &[&str] = &[
    "list_room_files",
    "search_room",
    "open_file",
    "mark_image",
    "annotate_file",
    "create_file",
    "edit_file",
    "edit_files",
    "write_file",
    "set_cells",
    "rename_file",
    "move_file",
    "add_memory",
    "list_memories",
    "web_search",
    "fetch_page",
    "ui_snapshot",
    "ui_act",
    "view_screenshot",
    "view_media_frame",
    "start_file_pass",
    "job_status",
    // Wave 4a (Idea 2): the workflow authoring tools (LocalEngine/ExternalAgent
    // scopes only, never tools_catalog). Reserved so an MCP route can't shadow
    // their exec_tool arms.
    "list_workflows",
    "save_workflow",
    "update_workflow",
    "run_workflow",
    // Reserved even though they are never in the room bridge's own catalog:
    // an MCP route sanitizing to one of these names would shadow the built-in
    // exec_tool arm and skip the SEC-1b consent gate (e.g. server "consult" +
    // tool "advisor" reaching the cloud-CLI path). Colliding routes rename to
    // `<name>_2` and stay on the gated fallback.
    "local_generate",
    "consult_advisor",
];

/// Keyword router deciding whether to offer the write tools this turn. Erring
/// toward YES is safe (it just restores the fuller catalog); the win is the
/// large class of pure questions ("what does the contract say about X") that
/// contain none of these and get a 5-tool catalog instead of 11.
pub(crate) fn wants_write_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
        "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
        "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
        "translate", "highlight", "mark ", "annotate", "draft", "generate",
        "move ", "rename", "organize", "organise", "put ", "folder", "sort ", "tidy",
    ];
    HINTS.iter().any(|h| q.contains(h))
}

/// "open the Room Map" / "switch to the Detail tab" / "generate flashcards"
/// matched none of the base UI hints, so ui_act was never offered and the agent
/// couldn't drive the app at all. App surfaces and navigation verbs:
const APP_NAVIGATION_VERBS: &[&str] = &[
    "open ", "show me", "go to", "switch", "close ", "map", "panel", "tab",
    "studio", "flashcard", "mind map", "mindmap", "podcast", "front page",
    "dashboard", "play", "pause", "image", "photo", "picture",
];

/// ADD-25: keyword router for the UI/perception tools (ui_snapshot, ui_act,
/// view_screenshot, view_media_frame). Same doctrine as wants_write_tools:
/// deterministic, errs toward YES, and keeps the plain-question catalog short
/// so a 4B model isn't choosing among tools it doesn't need.
pub(crate) fn wants_ui_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "click", "press ", "button", "screenshot", "screen", "scroll", "navigate",
        "menu", "sidebar", "watch", "frame", "video", "look at", "looking at",
        "interface", "use the app", "the app", "type in", "toggle", "what do you see",
        "what am i", "on screen",
    ];
    HINTS.iter().any(|h| q.contains(h)) || APP_NAVIGATION_VERBS.iter().any(|h| q.contains(h))
}

/// ADD-32: keyword router for the whole-file pass tools (start_file_pass,
/// job_status). Same doctrine as the other routers: deterministic, errs toward
/// YES. Fires on whole-file intent ("the entire file", "all of it", "translate
/// the book") and on job talk ("is it done yet?").
pub(crate) fn wants_job_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "whole", "entire", "entirely", "all of", "every ", "everything", "full",
        "fully", "complete", "completely", "cover", "thorough", "in depth",
        "in-depth", "translate", "book", "throughout", "end to end", "cover to cover",
        "start to finish", "page by page", "chapter", "long file", "large file",
        "big file", "deep", "job", "progress", "background", "pass", "digest",
        "no matter", "don't miss", "do not miss", "line by line",
        // Wave 4a: the workflow authoring tools ride the jobs routing flag.
        "workflow", "automate", "automat", "every morning", "every day", "every week",
        "each morning", "each day", "schedule", "recurring", "routine", "pipeline",
    ];
    HINTS.iter().any(|h| q.contains(h))
}

/// ADD-32: the whole-file pass tool specs. Injected by `agent_loop` (never via
/// `tools_catalog`, so the room MCP bridge can't offer them to a cloud client —
/// same structural guard as the UI tools; starting hours of local compute stays
/// a local-agent decision).
pub(crate) fn job_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "start_file_pass",
            "description": "Start a durable BACKGROUND pass that reads an ENTIRE file part by part — every character, no matter how large the file is — and saves the result as a new file in the room. Use it whenever the user wants work covering a whole large file (summarize/analyze/translate it all), instead of answering from excerpts. It is slow (minutes to hours) but survives app restarts; the user sees a live progress card. mode \"merge\" (default) folds notes into one final document; mode \"stitch\" transforms each part and joins them in order (translation, rewriting). After starting it, tell the user it is underway — do not wait for it.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or a distinctive part of it"},
                "instruction": {"type": "string", "description": "What to do across the whole file, e.g. \"summarize thoroughly\", \"translate to French\", \"list every obligation with its section\""},
                "mode": {"type": "string", "enum": ["merge", "stitch"],
                    "description": "merge = one final document distilled from the whole file (default); stitch = transform each part and join them in order"}},
                "required": ["name", "instruction"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "job_status",
            "description": "Report the progress of background jobs (whole-file passes, room summaries): what is running, paused, finished or failed, and how far along.",
            "parameters": {"type": "object", "properties": {}}}}),
    ]
}

/// Wave 1a: tools served ONLY to an external agent on the Leash's full tier
/// (`ToolScope::ExternalAgent`). Never in `tools_catalog` and never routed to
/// the in-room engines — the local model IS the thing `local_generate` runs,
/// and a cloud advisor must not command local compute (same structural guard
/// as the job tools above).
pub(crate) fn external_agent_tools_specs() -> Vec<serde_json::Value> {
    vec![serde_json::json!({"type": "function", "function": {"name": "local_generate",
        "description": "Run one prompt on the user's LOCAL model on this Mac and return its text (or JSON when a schema is given). Slow but private — use it for steps whose content must not leave this machine. For reading a whole huge file use start_file_pass instead.",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "The full, self-contained prompt"},
            "system": {"type": "string", "description": "Optional system instruction"},
            "schema": {"type": "object", "description": "Optional JSON Schema — the reply is constrained to match it"},
            "temperature": {"type": "number"},
            "long": {"type": "boolean", "description": "true to allow a big-context call for large prompts (slower prefill)"}},
            "required": ["prompt"]}}})]
}

/// Wave 1a: the CONTENT subset of the UI/perception specs. `view_media_frame`
/// reads a room video's pixels — room content, like open_file — not the user's
/// screen, so the external tier serves it while ui_snapshot/ui_act/
/// view_screenshot stay LocalEngine-only.
pub(crate) fn media_tools_specs() -> Vec<serde_json::Value> {
    ui_tools_specs()
        .into_iter()
        .filter(|s| s["function"]["name"] == "view_media_frame")
        .collect()
}

/// Wave 1a: the model `local_generate` runs on. The tool PROMISES local
/// execution, so the room's chat model is honored only when it actually runs
/// on this Mac — an external CLI engine or an Ollama `:cloud` proxy is swapped
/// for `best_local_default`, which also refuses `:cloud` picks (unlike
/// `best_default`/`resolve_pass_engine`, whose cloud lane would betray the
/// promise). With nothing local installed it falls back to the default NAME,
/// so the surfaced `MODEL_MISSING:<model>` error tells the agent exactly what
/// to install (open decision 3: error, never a silent cloud fallback).
pub(crate) fn resolve_local_generate_model(explicit: Option<String>, models: &[String]) -> String {
    match explicit {
        Some(m) if !is_external_engine(&m) && !is_cloud_model(&m) => m,
        _ => best_local_default(models),
    }
}

/// Tools the local model can use to drive the app. The web tools appear
/// only when the user enabled a search provider — a disabled capability is
/// one the model cannot even attempt.
pub(crate) fn tools_catalog(web_enabled: bool) -> serde_json::Value {
    let mut tools = serde_json::json!([
        {"type": "function", "function": {"name": "list_room_files",
            "description": "List every file stored in this room with its type and size.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {"name": "search_room",
            "description": "Search all room files for content the excerpts already provided above do not cover. Use 2-4 keywords, not a full sentence. Results are verbatim file text safe to quote in annotate_file. To SHOW the user a passage you found, call open_file with find set to a short quote from these results — you never need a page number.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string"}}, "required": ["query"]}}},
        {"type": "function", "function": {"name": "open_file",
            "description": "Open a file in the app's viewer pane so the user sees it. To jump to a passage, pass find with a short exact quote (copied from search_room results) — the viewer locates the right page itself, in any language; never ask the user for a page number. page/cell also work when known.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or a distinctive part of it"},
                "page": {"type": "integer", "description": "PDF page number to show"},
                "cell": {"type": "string", "description": "Spreadsheet cell to show, like B7"},
                "find": {"type": "string", "description": "Short exact text from the file to locate, scroll to, and show — use this to jump to content found with search_room"}},
                "required": ["name"]}}},
        {"type": "function", "function": {"name": "mark_image",
            "description": "Draw labeled boxes on an image in the room showing where something is.",
            "parameters": {"type": "object", "properties": {
                "image_name": {"type": "string"},
                "find": {"type": "string", "description": "What to locate in the image"}},
                "required": ["image_name", "find"]}}},
        {"type": "function", "function": {"name": "annotate_file",
            "description": "Highlight a spot in a document or spreadsheet so the user sees it marked in the viewer. Quote exact text from the file, or give a cell range for spreadsheets. For images use mark_image instead. Example: {\"name\": \"lease.pdf\", \"text\": \"no pets are allowed\", \"note\": \"pet clause\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "text": {"type": "string", "description": "Short exact quote copied from the file (max ~200 chars)"},
                "page": {"type": "integer", "description": "PDF page the text is on, if known"},
                "sheet": {"type": "string", "description": "Sheet name, for spreadsheets"},
                "range": {"type": "string", "description": "Cell or range to highlight, like B7 or B2:D5"},
                "note": {"type": "string", "description": "Short label explaining the highlight"}},
                "required": ["name"]}}},
        {"type": "function", "function": {"name": "create_file",
            "description": "Create a new note/document file saved into the room. For a document without a specific format, write the content as simple HTML body markup (<h2>, <p>, <ul>, <table>) and the app saves it as an .html page. Only use another extension (.md, .csv, .txt) if the user asked for it.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "edit_file",
            "description": "Change ONE place in ONE file (text, code, notes, csv, or docx) by replacing exact text. Copy old_text exactly as it appears in the file — curly quotes, spacing and dashes are matched tolerantly, but old_text must identify a UNIQUE spot: if it appears more than once you get an error with the count, then either add surrounding text to pick one place or pass all: true to replace every occurrence. To change several places or several files at once, use edit_files. Example: {\"name\": \"notes.md\", \"old_text\": \"Q3 revenue was $4M\", \"new_text\": \"Q3 revenue was $5M\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "old_text": {"type": "string", "description": "Exact text currently in the file"},
                "new_text": {"type": "string", "description": "Text to replace it with"},
                "all": {"type": "boolean", "description": "Replace EVERY occurrence of old_text (default false → the text must appear exactly once)"}},
                "required": ["name", "old_text", "new_text"]}}},
        {"type": "function", "function": {"name": "edit_files",
            "description": "Change several files (or several places in one file) in ONE atomic step: every edit is checked first, then all are applied together — if any single edit can't match, none are applied. Also renames files as part of the same atomic change, so \"rename X and update every reference\" fully lands or fully doesn't. Prefer this over repeated edit_file calls when a change spans files. Example: {\"edits\": [{\"name\": \"a.md\", \"old_text\": \"foo\", \"new_text\": \"bar\"}, {\"name\": \"old.md\", \"new_name\": \"new.md\"}]}",
            "parameters": {"type": "object", "properties": {
                "edits": {"type": "array", "description": "The changes to apply atomically. Each is either an edit {name, old_text, new_text} or a rename {name, new_name}.",
                    "items": {"type": "object", "properties": {
                        "name": {"type": "string", "description": "File name or part of it"},
                        "old_text": {"type": "string", "description": "For an edit: exact text currently in the file"},
                        "new_text": {"type": "string", "description": "For an edit: text to replace it with"},
                        "new_name": {"type": "string", "description": "For a rename: the file's new name"}},
                        "required": ["name"]}}},
                "required": ["edits"]}}},
        {"type": "function", "function": {"name": "write_file",
            "description": "Replace the entire content of an existing text file. For small changes prefer edit_file.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "content": {"type": "string", "description": "The complete new file content"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "set_cells",
            "description": "Set one or more cells in a spreadsheet (.xlsx or .csv). Pass ALL changes in one call via updates.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "updates": {"type": "array", "description": "The cells to change, e.g. [{\"cell\":\"B2\",\"value\":\"120\"},{\"cell\":\"B3\",\"value\":\"95\"}]",
                    "items": {"type": "object", "properties": {
                        "cell": {"type": "string", "description": "Cell in A1 notation, like B7"},
                        "value": {"type": "string", "description": "New value for the cell"}},
                        "required": ["cell", "value"]}},
                "sheet": {"type": "string", "description": "Sheet name (default: first sheet)"}},
                "required": ["name", "updates"]}}},
        {"type": "function", "function": {"name": "rename_file",
            "description": "Rename a file in the room. The extension is kept if you omit it. Example: {\"name\": \"draft.md\", \"new_name\": \"Q3 plan\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Current file name or part of it"},
                "new_name": {"type": "string", "description": "The new name"}},
                "required": ["name", "new_name"]}}},
        {"type": "function", "function": {"name": "move_file",
            "description": "Move a file into a folder (created if it doesn't exist), or to the top level with an empty folder. Example: {\"name\": \"NVDA_Stock_Info.md\", \"folder\": \"stocks\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "folder": {"type": "string", "description": "Destination folder name; empty string for the top level"}},
                "required": ["name", "folder"]}}},
        {"type": "function", "function": {"name": "add_memory",
            "description": "Save a permanent memory note that the assistant will always see in this room.",
            "parameters": {"type": "object", "properties": {
                "content": {"type": "string"},
                "category": {"type": "string", "enum": ["preference", "fact", "project", "instruction"],
                    "description": "What kind of note this is (optional)"}},
                "required": ["content"]}}},
        {"type": "function", "function": {"name": "list_memories",
            "description": "List every memory note saved in this room. Use it when asked what you remember, or when the notes shown in context look incomplete.",
            "parameters": {"type": "object", "properties": {}}}}
    ]);
    if web_enabled {
        let arr = tools.as_array_mut().unwrap();
        arr.push(serde_json::json!(
            {"type": "function", "function": {"name": "web_search",
                "description": "Search the public web. Use for current events or information not in the room. Returns titles, URLs and snippets; fetch a URL with fetch_page for details.",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string", "description": "Short search query"}},
                    "required": ["query"]}}}
        ));
        arr.push(serde_json::json!(
            {"type": "function", "function": {"name": "fetch_page",
                "description": "Fetch one web page by URL and return its readable text. If the result is truncated, call again with the same url and the start value from the truncation notice to read further.",
                "parameters": {"type": "object", "properties": {
                    "url": {"type": "string", "description": "Full http(s) URL"},
                    "start": {"type": "integer", "description": "Character offset to continue reading a long page; use the value from the truncation notice."}},
                    "required": ["url"]}}}
        ));
    }
    tools
}

/// ADD-25: the UI/perception tool specs. Deliberately NOT part of
/// `tools_catalog` — the room MCP bridge is built from `tools_catalog`, so
/// keeping these out means a cloud client on the Leash can never observe or
/// drive this Mac's screen. The guard is structural, exactly like
/// `consult_advisor_spec`. Injected by `agent_loop` only when the
/// deterministic router (`wants_ui_tools`) fires.
pub(crate) fn ui_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "ui_snapshot",
            "description": "List every clickable/typable control currently visible in the app as numbered marks (role, label, region). Call this FIRST when asked to open or use an app surface — the Room Map (the Map toggle), the Memory panel, Studio buttons (Flashcards, Mind map, Podcast script), a viewer tab, or History. Those are app controls, NOT files: never search_room for them. Take a fresh snapshot before each ui_act — marks go stale when the screen changes. Consent-sensitive controls (settings, approvals) are never listed.",
            "parameters": {"type": "object", "properties": {}}}}),
        serde_json::json!({"type": "function", "function": {"name": "ui_act",
            "description": "Operate one control from the latest ui_snapshot by its mark number. The user watches every action. Example: {\"mark\": 12, \"action\": \"click\"}",
            "parameters": {"type": "object", "properties": {
                "mark": {"type": "integer", "description": "Mark number from the latest ui_snapshot"},
                "action": {"type": "string", "enum": ["click", "type", "set", "scroll"],
                    "description": "click a control; type appends text into a field; set replaces the field's text; scroll moves the element's pane (text: \"up\" or \"down\")"},
                "text": {"type": "string", "description": "For type/set: the text. For scroll: \"up\" or \"down\"."}},
                "required": ["mark", "action"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "view_screenshot",
            "description": "Capture what the user currently sees in the app window and look at it. Use when the words in the transcript aren't enough and you need the actual pixels (layout, an open image or PDF page, a chart).",
            "parameters": {"type": "object", "properties": {}}}}),
        serde_json::json!({"type": "function", "function": {"name": "view_media_frame",
            "description": "Grab one frame from a video file in the room at a timestamp and look at it. Pair with the transcript's [m:ss] stamps to inspect the exact moment. Example: {\"name\": \"lecture.mp4\", \"at\": \"12:34\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Video file name or a distinctive part of it"},
                "at": {"type": "string", "description": "Timestamp like \"1:23\" or \"1:02:03\", or plain seconds like \"75\""}},
                "required": ["name", "at"]}}}),
    ]
}

/// A connected MCP tool exposed to the model this turn: its catalog entry
/// plus the client handle to call it with.
pub(crate) struct McpRoute {
    pub(crate) catalog_name: String,
    pub(crate) tool_name: String,
    /// The connector this tool belongs to — shown in the approval prompt and
    /// used as the "always allow" key.
    pub(crate) server_name: String,
    /// pub(crate) so the room bridge can advertise the same specs to a
    /// consulted advisor (ADD-21).
    pub(crate) spec: serde_json::Value,
    pub(crate) client: Arc<tokio::sync::Mutex<mcp::Client>>,
}

/// CHG-29: strip a third-party JSON Schema down to what the model needs to call
/// the tool, in place. Real MCP servers ship schemas with long descriptions,
/// examples and huge enums that can consume thousands of the 12K-token window.
/// Removes non-load-bearing keys, clamps every description to 100 chars, and
/// caps enum arrays at 16 entries. Recursive over objects/arrays.
pub(crate) fn slim_schema(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for k in [
                "$schema",
                "title",
                "examples",
                "example",
                "default",
                "additionalProperties",
                "$id",
                "$comment",
            ] {
                map.remove(k);
            }
            map.retain(|k, _| !k.starts_with("x-"));
            if let Some(serde_json::Value::String(d)) = map.get_mut("description") {
                *d = clamp_bytes(std::mem::take(d), 100);
            }
            if let Some(serde_json::Value::Array(en)) = map.get_mut("enum") {
                en.truncate(16);
            }
            for (_, child) in map.iter_mut() {
                slim_schema(child);
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr.iter_mut() {
                slim_schema(child);
            }
        }
        _ => {}
    }
}

/// Snapshot the connected MCP tools, namespaced `server_tool` and deduped
/// against the built-in tool names and each other. CHG-29: schemas are slimmed
/// and the whole catalog is held under a char budget so a large third-party
/// server can't silently overflow the 4B model's context. Returns the routes
/// plus the names of any tools omitted for budget so the caller can tell the
/// model.
pub(crate) fn mcp_routes(state: &State<'_, AppState>) -> (Vec<McpRoute>, Vec<String>) {
    let mut taken: HashSet<String> = BUILTIN_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    let mgr = state.mcp.lock().unwrap();
    let mut routes = Vec::new();
    let mut omitted: Vec<String> = Vec::new();
    let mut catalog_chars = 0usize;
    for server in &mgr.servers {
        let Some(client) = &server.client else { continue };
        for tool in &server.tools {
            if routes.len() >= MAX_MCP_TOOLS {
                omitted.push(tool.name.clone());
                continue;
            }
            let base = format!(
                "{}_{}",
                mcp::sanitize_tool_name(&server.name),
                mcp::sanitize_tool_name(&tool.name)
            );
            let mut catalog_name = base.clone();
            let mut n = 2;
            while taken.contains(&catalog_name) {
                catalog_name = format!("{base}_{n}");
                n += 1;
            }
            // Long descriptions eat the context; cut at a char boundary.
            let description: String = tool.description.chars().take(300).collect();
            let mut schema = tool.schema.clone();
            slim_schema(&mut schema);
            let spec = serde_json::json!({"type": "function", "function": {
                "name": catalog_name,
                "description": description,
                "parameters": schema,
            }});
            // Whole-catalog budget: stop admitting once the specs get too large.
            let cost = spec.to_string().len();
            if catalog_chars + cost > MAX_MCP_CATALOG_CHARS && !routes.is_empty() {
                omitted.push(tool.name.clone());
                continue;
            }
            catalog_chars += cost;
            taken.insert(catalog_name.clone());
            routes.push(McpRoute {
                catalog_name,
                tool_name: tool.name.clone(),
                server_name: server.name.clone(),
                spec,
                client: client.clone(),
            });
        }
    }
    (routes, omitted)
}

/// Viewer payloads produced by tools during a turn; persisted on the saved
/// assistant message's `effects` column (ADD-23).
#[derive(Default, Clone)]
pub(crate) struct ToolEffects {
    pub(crate) boxes: Option<serde_json::Value>,
    pub(crate) annotation: Option<serde_json::Value>,
    /// CHG-10: set true when a write tool (create/edit/write/set_cells) succeeded
    /// this turn — the deterministic ground truth for the anti-fabrication gate.
    pub(crate) wrote: bool,
    /// CHG-33: set when web_search hit a rate-limit/human-check this turn, so
    /// further searches short-circuit instead of deepening the ban.
    pub(crate) web_search_throttled: bool,
    /// ADD-21: cloud-advisor consults spent this turn, capped at
    /// `MAX_ADVISOR_CALLS`.
    pub(crate) advisor_calls: u8,
    /// ADD-25: base64 PNGs captured this round (view_screenshot /
    /// view_media_frame). agent_loop drains them into a vision user-message
    /// right after the tool result, so the model looks at what it captured.
    pub(crate) pending_images: Vec<String>,
    /// ADD-25: whether the CHAT model can read attached images. Set by the
    /// caller from `is_vision_chat_model`; when false the perception tools
    /// return a local vision-model description instead of attaching pixels.
    pub(crate) vision_chat: bool,
    /// Wave 2 (Idea 4): content-free per-edit outcome records for this turn —
    /// each `{"tool", "outcome", "n", …}`, never `old_text`/`new_text`. Emitted
    /// under the `"edits"` key of the message's `effects` column so failure rates
    /// are measurable per turn. The frontend ignores unknown effects keys.
    pub(crate) edit_outcomes: Vec<serde_json::Value>,
    /// Wave 2 (Idea 6): true only on the run-scoped LocalEngine sink (set by the
    /// bridge's LocalEngine path). The diff-preview "Apply for the rest of this
    /// answer" cadence is meaningful only here — a sink-less cloud/external scope
    /// gets a throwaway `ToolEffects` per call, so it always prompts per edit and
    /// the turn button is hidden (Idea 6 review amendment 2 / second-pass).
    pub(crate) run_scoped: bool,
    /// Wave 2 (Idea 6): set true when the user chose "Apply for the rest of this
    /// answer" on an approval card. Turn-scoped by construction: it rides the
    /// run-scoped sink, which lives exactly one answer.
    pub(crate) edit_approved_this_turn: bool,
}

pub(crate) async fn exec_tool(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    call: &ollama::ToolCall,
    effects: &mut ToolEffects,
    routes: &[McpRoute],
    injected_rowids: &HashSet<i64>,
    // ADD-21: the ask's cancel flag, so a long consult_advisor child dies on
    // Stop. `None` from callers with nothing to cancel (e.g. the room bridge).
    cancel: Option<Arc<AtomicBool>>,
    // ADD-21: the per-ask advisor bridge (room tools for a Claude advisor),
    // started in `ask` and passed down. `None` disables the room-tools handoff.
    // Threaded in rather than started here to avoid an async-recursion cycle.
    advisor_bridge: Option<&crate::room_mcp::Bridge>,
) -> Result<String, String> {
    use tauri::Emitter;
    let args = &call.arguments;
    match call.name.as_str() {
        "list_room_files" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let all = db::list_files_brief(&room.conn)?;
            let total = all.len();
            // CHG-1: this was the one tool result that bypassed clamping; cap the
            // row count and clamp as a backstop so a file-heavy room can't crowd
            // out the system prompt. CHG-23: show each file's cached one-liner.
            let mut rows: Vec<String> = all
                .into_iter()
                .take(100)
                .map(|(name, mime, size, summary)| match summary {
                    Some(s) if !s.trim().is_empty() => {
                        format!("- {name} ({mime}, {size} bytes) — {}", clamp_words(s.trim(), 120))
                    }
                    _ => format!("- {name} ({mime}, {size} bytes)"),
                })
                .collect();
            if total > 100 {
                rows.push(format!(
                    "…and {} more files — use search_room to find content or open_file by name.",
                    total - 100
                ));
            }
            Ok(if rows.is_empty() {
                "The room has no files.".into()
            } else {
                clamp_tool_result(rows.join("\n"))
            })
        }
        "search_room" => {
            let query = args["query"].as_str().unwrap_or_default();
            // ADD-13: embed the query before locking (async Ollama call); None
            // → keyword-only retrieval.
            let query_embedding = embed_question(query).await;
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // CHG-16: skip chunks already injected into the prompt as context.
            let (chunks, fallback) = retrieve_context_excluding(
                &room.conn,
                query,
                query_embedding.as_deref(),
                injected_rowids,
            )?;
            if fallback {
                return Ok("No matching content found.".into());
            }
            if chunks.is_empty() {
                // Exclusion removed everything → the best matches are the
                // excerpts already shown above.
                return Ok("The best matches are already in the context excerpts above; \
                           try different keywords for anything else."
                    .into());
            }
            Ok(chunks
                .iter()
                .take(4)
                // Char-safe, match-centered excerpt (was a raw byte slice that
                // panicked on multibyte text and poisoned the room mutex).
                .map(|c| format!("[{}]\n{}", c.file_name, excerpt(&c.text, query, 800)))
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
        "open_file" => {
            let name = args["name"].as_str().unwrap_or_default().to_lowercase();
            let page = args["page"].as_u64();
            let cell = args["cell"].as_str().filter(|c| parse_a1(c).is_some());
            let find = args["find"].as_str().filter(|f| !f.trim().is_empty());
            let (id, real_name, text) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::find_file_like_full(&room.conn, &name)?
            };
            // Ground `find` in the file's REAL text before the viewer hunts
            // for it (same ADD-22 net as annotate_file): a model quoting from
            // memory drifts — "בירושלים" for the file's "בירושלם" — and an
            // exact-match viewer then silently stays on page 1. Verify the
            // passage, or swap in the closest real one.
            let (find, approx) = match (find, &text) {
                (Some(f), Some(t)) => {
                    let hay = normalize_for_match(t);
                    let needle = normalize_for_match(f);
                    let found = hay.contains(&needle)
                        || hay.replace(' ', "").contains(&needle.replace(' ', ""));
                    if found {
                        (Some(f.to_string()), false)
                    } else if let Some(snip) = closest_snippet(t, f) {
                        (Some(snip), true)
                    } else {
                        (None, true) // nothing close — open plainly, tell the model
                    }
                }
                (f, _) => (f.map(str::to_string), false),
            };
            let _ = window.emit(
                "agent-open-file",
                serde_json::json!({ "id": id, "page": page, "cell": cell, "find": find }),
            );
            let target = match (page, cell, &find) {
                (Some(p), _, _) => format!(" at page {p}"),
                (_, Some(c), _) => format!(" at cell {c}"),
                (_, _, Some(f)) => format!(" at \"{f}\""),
                _ => String::new(),
            };
            let note = if approx && find.is_some() {
                "\n(The exact text you asked for isn't in the file — jumped to the closest \
                 real passage instead. Quote text verbatim from search_room next time.)"
            } else if approx {
                "\n(That text isn't in this file — opened it from the start. Use search_room \
                 first and copy the passage exactly.)"
            } else {
                ""
            };
            let snippet = text
                // Char-safe prefix (was a raw byte slice that panicked on
                // multibyte text).
                .map(|t| format!("\nIt begins:\n{}", clamp_bytes(t, 1200)))
                .unwrap_or_default();
            Ok(format!("Opened \"{real_name}\" in the viewer{target}.{note}{snippet}"))
        }
        "annotate_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let quote = args["text"].as_str().unwrap_or_default().trim().to_string();
            let page = args["page"].as_u64();
            let sheet = args["sheet"].as_str().map(str::to_string);
            let range = args["range"].as_str().unwrap_or_default().trim().to_uppercase();
            let note = args["note"].as_str().map(str::to_string);
            let (id, real_name, extracted): (String, String, Option<String>) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                let (id, real_name) = db::find_file_like(&room.conn, name)?;
                let extracted = db::get_file_extracted_text(&room.conn, &id);
                (id, real_name, extracted)
            };
            let (payload, described) = build_annotation(
                &id,
                &real_name,
                extracted.as_deref(),
                &quote,
                &range,
                page,
                sheet.as_deref(),
                note.as_deref(),
            )?;
            effects.annotation = Some(payload.clone());
            let _ = window.emit("agent-annotate", &payload);
            Ok(format!(
                "Highlighted {described} in \"{real_name}\" — the user can now see it marked in the viewer."
            ))
        }
        "edit_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let old_text = args["old_text"].as_str().unwrap_or_default();
            let new_text = args["new_text"].as_str().unwrap_or_default();
            // Idea 4: `all` is the escape hatch for a deliberate multi-occurrence
            // replace (schema-visible in tools_catalog so the model can discover it).
            let all = args["all"].as_bool().unwrap_or(false);
            if old_text.is_empty() {
                return Err("old_text is required — copy the exact text to replace.".into());
            }
            // Idea 6: the diff-preview gate wraps this whole edit (compute under the
            // lock, await approval unlocked, re-lock + staleness-check + apply). When
            // the cadence setting is off (default) it applies inside the phase-1 lock,
            // byte-identical to the pre-Wave-2 behavior.
            let edit = PreviewEdit {
                name: name.to_string(),
                old_text: old_text.to_string(),
                new_text: new_text.to_string(),
                all,
            };
            match gated_write("edit_file", "AI edit", state, window, effects, |conn| {
                plan_single_edit(conn, &edit)
            })
            .await
            {
                GateOutcome::Applied(plans) => {
                    let p = &plans[0];
                    effects.edit_outcomes.push(serde_json::json!({
                        "tool": "edit_file",
                        "outcome": p.method.map(EditMethod::outcome).unwrap_or("exact"),
                        "n": p.count
                    }));
                    let base = format!(
                        "Replaced {} occurrence(s) in \"{}\". The user sees the updated file.",
                        p.count, p.real_name
                    );
                    Ok(if p.method == Some(EditMethod::Fuzzy) {
                        format!("Matched your text despite quote/spacing differences. {base}")
                    } else {
                        base
                    })
                }
                GateOutcome::Declined(msg) => Ok(msg),
                GateOutcome::Error(e) => {
                    effects.edit_outcomes.push(serde_json::json!({
                        "tool": "edit_file", "outcome": e.outcome, "n": 0
                    }));
                    Err(e.message)
                }
            }
        }
        "edit_files" => {
            let ops = match parse_batch_ops(args) {
                Ok(o) => o,
                Err(msg) => {
                    effects.edit_outcomes.push(serde_json::json!({
                        "tool": "edit_files", "outcome": "failed"
                    }));
                    return Err(msg);
                }
            };
            let (n_edits, n_renames) = count_batch_ops(&ops);
            let batch_id: String = Uuid::new_v4().to_string().chars().take(8).collect();
            let cause = format!("AI edit (batch {batch_id})");
            match gated_write("edit_files", &cause, state, window, effects, |conn| {
                plan_batch(conn, &ops).map_err(|m| EditError::batch_failure(m))
            })
            .await
            {
                GateOutcome::Applied(plans) => {
                    let total = n_edits + n_renames;
                    effects.edit_outcomes.push(serde_json::json!({
                        "tool": "edit_files", "outcome": "applied",
                        "files": plans.len(), "n": total
                    }));
                    Ok(format!(
                        "Applied {total} change(s) across {} file(s) atomically.",
                        plans.len()
                    ))
                }
                GateOutcome::Declined(msg) => Ok(msg),
                GateOutcome::Error(e) => {
                    effects.edit_outcomes.push(serde_json::json!({
                        "tool": "edit_files", "outcome": e.outcome
                    }));
                    Err(e.message)
                }
            }
        }
        "write_file" => {
            let name = args["name"].as_str().unwrap_or_default().to_string();
            let content = args["content"].as_str().unwrap_or_default().to_string();
            // Idea 6: the diff-preview gate wraps the rewrite (off by default →
            // byte-identical to before).
            match gated_write("write_file", "AI rewrite", state, window, effects, |conn| {
                plan_write_file(conn, &name, &content)
            })
            .await
            {
                GateOutcome::Applied(plans) => {
                    let p = &plans[0];
                    Ok(format!("Rewrote \"{}\" ({} characters).", p.real_name, p.count))
                }
                GateOutcome::Declined(msg) => Ok(msg),
                GateOutcome::Error(e) => Err(e.message),
            }
        }
        "set_cells" => {
            let name = args["name"].as_str().unwrap_or_default().to_string();
            let sheet = args["sheet"].as_str().map(str::to_string);
            // CHG-2: accept a batch of {cell, value} in one call so filling a
            // column doesn't burn one inference round per cell. Fall back to the
            // legacy single top-level cell/value for older prompts.
            let value_of = |v: &serde_json::Value| -> String {
                v.as_str()
                    .map(str::to_string)
                    // Models sometimes send numbers as JSON numbers.
                    .unwrap_or_else(|| v.to_string().trim_matches('"').to_string())
            };
            let mut updates: Vec<(String, String)> = Vec::new();
            if let Some(arr) = args["updates"].as_array() {
                for u in arr {
                    let cell = u["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                    if !cell.is_empty() {
                        updates.push((cell, value_of(&u["value"])));
                    }
                }
            }
            if updates.is_empty() {
                let cell = args["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                if !cell.is_empty() {
                    updates.push((cell, value_of(&args["value"])));
                }
            }
            if updates.is_empty() {
                return Err("No cells given — pass updates: [{cell, value}, …].".into());
            }
            validate_cell_refs(&updates)?;
            let summary = updates
                .iter()
                .map(|(c, v)| format!("{c}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            // Idea 6: gate the cell change too.
            match gated_write("set_cells", "AI cell change", state, window, effects, |conn| {
                plan_set_cells(conn, &name, sheet.as_deref(), &updates)
            })
            .await
            {
                GateOutcome::Applied(plans) => {
                    Ok(format!("Set {summary} in \"{}\".", plans[0].real_name))
                }
                GateOutcome::Declined(msg) => Ok(msg),
                GateOutcome::Error(e) => Err(e.message),
            }
        }
        // ADD-25: the agent↔UI tools. Each is one round-trip through the
        // AgentUi bridge to the live webview driver; the driver enforces the
        // data-agent-blocked consent denylist a second time at act time.
        "ui_snapshot" => {
            use tauri::Manager;
            let ui = window.app_handle().state::<AgentUi>();
            let v = request_ui(window, &ui, "ui_snapshot", serde_json::json!({})).await?;
            let mut out = String::new();
            if let Some(s) = v["summary"].as_str() {
                out.push_str(s);
                out.push('\n');
            }
            for e in v["elements"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                let mark = e["mark"].as_u64().unwrap_or(0);
                let role = e["role"].as_str().unwrap_or("control");
                let label = e["label"].as_str().unwrap_or("");
                let region = e["region"].as_str().unwrap_or("app");
                match e["state"].as_str().filter(|s| !s.is_empty()) {
                    Some(st) => {
                        out.push_str(&format!("[{mark}] {role} \"{label}\" — {region} ({st})\n"))
                    }
                    None => out.push_str(&format!("[{mark}] {role} \"{label}\" — {region}\n")),
                }
            }
            if out.trim().is_empty() {
                return Ok("No interactive controls are visible right now.".into());
            }
            Ok(clamp_tool_result(out))
        }
        "ui_act" => {
            use tauri::Manager;
            let mark = args["mark"]
                .as_u64()
                .ok_or("ui_act needs the mark number of a control from the latest ui_snapshot")?;
            let action = args["action"].as_str().unwrap_or("click");
            let text = args["text"].as_str().unwrap_or("");
            let ui = window.app_handle().state::<AgentUi>();
            let v = request_ui(
                window,
                &ui,
                "ui_act",
                serde_json::json!({ "mark": mark, "action": action, "text": text }),
            )
            .await?;
            let desc = v["description"].as_str().unwrap_or("Done.").to_string();
            // The generic "Operated the app" chip already fired; follow with
            // the precise receipt so the user sees exactly what was touched.
            let _ = window.emit("ask-step", desc.clone());
            Ok(desc)
        }
        "view_screenshot" => {
            use tauri::Manager;
            // Native whole-window snapshot first (WKWebView takeSnapshot, no
            // permissions); the driver's viewer-pane composite is the fallback
            // (and the only path that can see <video> frames — hardware layers
            // render blank in native snapshots).
            let native: Result<Vec<u8>, String> =
                match window.app_handle().get_webview_window("main") {
                    Some(wv) => crate::snapshot::capture_webview_png(&wv),
                    None => Err("The app window is gone.".into()),
                };
            let b64 = match native {
                Ok(png) => downscale_png_b64(&png, 1280)?,
                Err(_) => {
                    let ui = window.app_handle().state::<AgentUi>();
                    let v =
                        request_ui(window, &ui, "view_screenshot", serde_json::json!({})).await?;
                    v["imageB64"]
                        .as_str()
                        .ok_or("The screenshot came back empty.")?
                        .to_string()
                }
            };
            perceive_image(effects, b64, "a screenshot of the app window").await
        }
        "view_media_frame" => {
            use tauri::Manager;
            let name = args["name"].as_str().unwrap_or_default();
            let at = match (&args["at"], args["at"].as_str()) {
                (serde_json::Value::Number(n), _) => n.as_f64().unwrap_or(0.0),
                (_, Some(s)) => parse_timestamp_secs(s)?,
                _ => 0.0,
            };
            let (token, playable, real_name) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                // Resolve the target: the model's name if it matches, else fall
                // back to the room's sole video (the common "look at the video"
                // case where the user is watching the one video they added).
                let (id, real_name) = resolve_video_file(&room.conn, name)?;
                let (fname, mime, bytes, _) = db::get_file_full(&room.conn, &id)?;
                let mime = mime.unwrap_or_default();
                let ext = extraction::extension_of(&fname);
                let playable = playable_media_mime(&mime, &ext, true);
                let streams = window.app_handle().state::<MediaStreams>();
                let token =
                    stage_media_bytes(&streams, bytes.unwrap_or_default(), &playable);
                (token, playable, real_name)
            };
            let ui = window.app_handle().state::<AgentUi>();
            let v = request_ui(
                window,
                &ui,
                "media_frame",
                serde_json::json!({ "token": token, "mime": playable, "seconds": at }),
            )
            .await?;
            let b64 = v["imageB64"]
                .as_str()
                .ok_or("The frame capture came back empty.")?
                .to_string();
            perceive_image(
                effects,
                b64,
                &format!("the frame at {}s of \"{real_name}\"", at.round() as u64),
            )
            .await
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or_default();
            let (provider, _key, endpoint) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                (
                    db::get_setting(&room.conn, "web_provider").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_api_key").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_endpoint").unwrap_or_default(),
                )
            };
            if !matches!(provider.as_str(), "duckduckgo" | "brave" | "searxng") {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            // CHG-33: serve a recent (<15m) cached result list without touching
            // the network. Catches exact repeats and case/spacing variants — a
            // common small-model failure mode — and avoids deepening any ban.
            let cached = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::get_fresh_web_search(&room.conn, &provider, &endpoint, query)
            };
            if let Some(results) = cached {
                let _ = window.emit(
                    "ask-step",
                    format!("Using recent search results for \"{query}\" (from this Mac's cache)"),
                );
                return Ok(clamp_tool_result(results));
            }
            // CHG-33: once throttled this turn, don't hammer the provider — steer
            // the model to salvage the answer from what it already has.
            if effects.web_search_throttled {
                return Ok("Web search is temporarily rate-limited; answer from what you \
                           already have or from fetched pages — do not search again this turn."
                    .into());
            }
            let _ = window.emit(
                "ask-step",
                format!("Searching the web for \"{query}\" (leaves this Mac)"),
            );
            let result = match provider.as_str() {
                "duckduckgo" | "brave" => web::search_duckduckgo(query).await,
                _ => web::search_searxng(&endpoint, query).await,
            };
            let hits = match result {
                Ok(h) => h,
                Err(e) => {
                    let low = e.to_lowercase();
                    if low.contains("rate-limit") || low.contains("human check") {
                        effects.web_search_throttled = true;
                    }
                    return Err(e);
                }
            };
            if hits.is_empty() {
                return Ok("No results found.".into());
            }
            let results = hits
                .iter()
                .enumerate()
                .map(|(i, h)| format!("{}. {}\n   {}\n   {}", i + 1, h.title, h.url, h.snippet))
                .collect::<Vec<_>>()
                .join("\n");
            {
                let guard = state.room.lock().unwrap();
                if let Some(room) = guard.as_ref() {
                    let _ = db::put_web_search(&room.conn, &provider, &endpoint, query, &results);
                }
            }
            Ok(clamp_tool_result(results))
        }
        "fetch_page" => {
            let url = args["url"].as_str().unwrap_or_default();
            // CHG-5/CHG-28: continue reading a long page from a char offset.
            let start = args["start"].as_u64().unwrap_or(0) as usize;
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            // RM-2: serve a fresh (<24h) cached copy without touching the network.
            let cached = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::get_fresh_web_page(&room.conn, url)
            };
            let (title, text) = if let Some(hit) = cached {
                hit
            } else {
                let _ = window.emit("ask-step", format!("Fetching {url} (leaves this Mac)"));
                let (title, text) = web::fetch_page(url).await?;
                {
                    let guard = state.room.lock().unwrap();
                    let room = guard.as_ref().ok_or("No room is open.")?;
                    let _ = db::save_web_page(&room.conn, url, &title, &text);
                }
                (title, text)
            };
            Ok(fetch_page_window(&title, url, &text, start))
        }
        "mark_image" => {
            let image_name = args["image_name"].as_str().unwrap_or_default().to_lowercase();
            let find = args["find"].as_str().unwrap_or_default();
            let (id, real_name, bytes, explicit) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                let (id, real_name, bytes) = db::find_image_like(&room.conn, &image_name)?;
                (id, real_name, bytes, model_setting(&room.conn))
            };
            // CHG-17: if this image was already grounded this turn, don't run a
            // second multi-GB vision pass — reuse the existing boxes.
            if let Some(existing) = &effects.boxes {
                if existing.get("fileId").and_then(|v| v.as_str()) == Some(id.as_str()) {
                    return Ok(format!("The image \"{real_name}\" is already marked."));
                }
            }
            let (prepared, w, h) = prepare_image(&bytes);
            let models = ollama::list_models().await.unwrap_or_default();
            // CHG-20: honor the room's chosen model (like locate_in_image), so
            // vision_keep_alive computes the right keep-alive and grounding uses
            // the user's model when no separate VL model is installed.
            let chat_model = explicit.unwrap_or_else(|| best_default(&models));
            let vmodel = {
                let v = vision_model(&models, &chat_model);
                if is_external_engine(&v) { chat_model.clone() } else { v }
            };
            let messages = vec![ollama::ChatMessage {
                role: "user".into(),
                content: grounding_prompt(find, w, h),
                images: Some(vec![base64::engine::general_purpose::STANDARD.encode(&prepared)]),
                ..Default::default()
            }];
            // HLT-5: short keep_alive on low-RAM machines when vision != chat.
            let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &chat_model);
            let raw =
                ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &boxes_schema(), Default::default()).await?;
            let boxes = parse_boxes(&raw, w, h);
            if boxes.is_empty() {
                return Ok(format!("Could not locate \"{find}\" in {real_name}."));
            }
            effects.boxes = Some(serde_json::json!({
                "fileId": id, "name": real_name, "boxes": boxes,
            }));
            Ok(format!(
                "Marked {} match(es) for \"{find}\" on {real_name}. The marked image will be shown with your reply.",
                boxes.len()
            ))
        }
        "create_file" => {
            let name = args["name"].as_str().unwrap_or("AI note").to_string();
            let content = args["content"].as_str().unwrap_or_default().to_string();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // Wave 1b (idea 10): the canonical scratch pad is get-or-create.
            // Every name resolver returns the NEWEST match, so a duplicate
            // "Scratch pad.md" would silently shadow the real pad (and its
            // notes) for the chip and every future agent edit — redirect a
            // create onto the existing pad as a normal versioned overwrite.
            if is_scratch_pad_name(&name) {
                if let Some(meta) = db::file_by_exact_name(&room.conn, SCRATCH_PAD_NAME)? {
                    store_file_bytes(&room.conn, &meta.id, content.as_bytes(), Some(&content), "AI edit")?;
                    let _ = window.emit("room-files-changed", ());
                    let _ = window.emit("file-updated", &meta.id);
                    effects.wrote = true;
                    return Ok(format!(
                        "\"{}\" already exists — rewrote it instead of creating a duplicate. \
                         The previous notes are kept in History.",
                        meta.name
                    ));
                }
                // No pad yet: create it under the CANONICAL name (never the
                // HTML-defaulted variant), so the chip and prompt line resolve it.
                let meta = db::insert_file(
                    &room.conn,
                    SCRATCH_PAD_NAME,
                    &note_mime(SCRATCH_PAD_NAME),
                    content.as_bytes(),
                    Some(&content),
                    "generated",
                )?;
                let _ = window.emit("room-files-changed", ());
                effects.wrote = true;
                return Ok(format!("Created \"{}\" in the room.", meta.name));
            }
            // ADD-22 (HTML-first): a document with no explicit extension defaults
            // to HTML; body/plain content is wrapped in a styled standalone page
            // (a no-op when the model already returned a full HTML document).
            let name = if extraction::extension_of(&name).is_empty() {
                format!("{name}.html")
            } else {
                name
            };
            let content = if extraction::extension_of(&name) == "html" {
                html_document(&name, &content)
            } else {
                content
            };
            let mime = mime_guess::from_path(&name)
                .first_or(mime_guess::mime::TEXT_PLAIN)
                .essence_str()
                .to_string();
            let meta = db::insert_file(&room.conn, &name, &mime, content.as_bytes(), Some(&content), "generated")?;
            let _ = window.emit("room-files-changed", ());
            effects.wrote = true;
            Ok(format!("Created \"{}\" in the room.", meta.name))
        }
        "rename_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let new_name = args["new_name"].as_str().unwrap_or_default().trim();
            if new_name.is_empty() {
                return Err("new_name is required.".into());
            }
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            // Keep the original extension if the model dropped it.
            let final_name = if extraction::extension_of(new_name).is_empty() {
                let ext = extraction::extension_of(&real_name);
                if ext.is_empty() {
                    new_name.to_string()
                } else {
                    format!("{new_name}.{ext}")
                }
            } else {
                new_name.to_string()
            };
            db::rename_file(&room.conn, &id, &final_name)?;
            let _ = window.emit("room-files-changed", ());
            let _ = window.emit("file-updated", &id);
            effects.wrote = true;
            Ok(format!("Renamed \"{real_name}\" to \"{final_name}\"."))
        }
        "move_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let folder = args["folder"].as_str().unwrap_or_default().trim();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            let to_top = folder.is_empty()
                || ["none", "top", "top level", "root", "/"]
                    .iter()
                    .any(|w| folder.eq_ignore_ascii_case(w));
            let (folder_id, where_to) = if to_top {
                (None, "the top level".to_string())
            } else {
                let folders = db::list_folders(&room.conn)?;
                let fid = match folders.iter().find(|f| f.name.eq_ignore_ascii_case(folder)) {
                    Some(f) => f.id.clone(),
                    None => db::create_folder(&room.conn, folder)?.id,
                };
                (Some(fid), format!("\"{folder}\""))
            };
            db::move_file_to_folder(&room.conn, &id, folder_id.as_deref())?;
            let _ = window.emit("room-files-changed", ());
            effects.wrote = true;
            Ok(format!("Moved \"{real_name}\" to {where_to}."))
        }
        "add_memory" => {
            let raw = args["content"].as_str().unwrap_or_default();
            if raw.chars().count() > MAX_MEMORY_CONTENT_CHARS {
                // Let the model self-correct rather than silently truncating.
                return Ok(format!(
                    "Memory too long ({} chars); save a shorter note under {} characters.",
                    raw.chars().count(),
                    MAX_MEMORY_CONTENT_CHARS
                ));
            }
            let content = raw;
            // Wave 1b (idea 5): optional category. Normalized leniently — a 4B
            // model misspelling the enum degrades to uncategorized, never errors.
            let category = args["category"].as_str().and_then(normalize_category);
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // UX-5: don't store an exact duplicate; tell the model so it stops.
            if duplicate_memory(&room.conn, content)?.is_some() {
                return Ok("Already remembered.".into());
            }
            db::add_memory(&room.conn, content, category)?;
            Ok("Memory saved.".into())
        }
        // Wave 1b (idea 5): read the FULL memory set on demand. The per-question
        // injection is budgeted (MAX_MEMORY_INJECT_CHARS) and can truncate; this
        // keeps every saved note reachable when the injected slice is partial.
        "list_memories" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let memories = db::list_memories(&room.conn)?;
            if memories.is_empty() {
                return Ok("No memories are saved in this room yet.".into());
            }
            let lines: Vec<String> = memories
                .iter()
                .map(|m| match m.category.as_deref() {
                    Some(c) => format!("- [{c}] {}", m.content),
                    None => format!("- {}", m.content),
                })
                .collect();
            Ok(clamp_tool_result(lines.join("\n")))
        }
        // ADD-32: kick off a durable whole-file pass. The heavy lifting is the
        // deterministic job runner's; the agent only starts it and reports.
        "start_file_pass" => {
            let name = args["name"].as_str().unwrap_or_default();
            let instruction = args["instruction"].as_str().unwrap_or_default();
            let mode = args["mode"].as_str().unwrap_or("merge");
            let (_job_id, real_name, parts) =
                begin_file_pass(window, state.inner(), name, instruction, mode).await?;
            Ok(format!(
                "Started a full pass over \"{real_name}\": {parts} part(s) will be read one \
                 after another in the background, and the finished result will be saved into \
                 the room as a new file. The user can watch the live progress card in the \
                 sidebar and stop or resume it any time. Do NOT wait for it or poll job_status \
                 — tell the user it is underway and answer anything else they asked."
            ))
        }
        // ADD-32: report background-job progress in plain words.
        "job_status" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let jobs = db::list_jobs(&room.conn)?;
            if jobs.is_empty() {
                return Ok("There are no background jobs in this room.".into());
            }
            let lines: Vec<String> = jobs
                .iter()
                .take(8)
                .map(|j| {
                    format!(
                        "- {} — {} ({} of {} steps done)",
                        j.title, j.status, j.cursor, j.total
                    )
                })
                .collect();
            Ok(clamp_tool_result(lines.join("\n")))
        }
        // Wave 4a (Idea 2): the workflow authoring tools. All logic lives in
        // commands::jobs::workflow; these arms just route args + the agent
        // messages. Drafts require explicit user activation (the review gate).
        "list_workflows" => {
            let name = args["name"].as_str();
            Ok(clamp_tool_result(agent_list_workflows(state.inner(), name)?))
        }
        "save_workflow" => agent_save_workflow(state.inner(), window, args, "agent").await,
        "update_workflow" => agent_update_workflow(state.inner(), window, args).await,
        "run_workflow" => agent_run_workflow(window, state.inner(), args).await,
        // Wave 1a: run one prompt on the LOCAL model for an external agent on
        // the Leash's full tier (only `ToolScope::ExternalAgent` advertises
        // it). Never touches `effects` — the bridge passes a throwaway sink
        // for this scope. No `clamp_tool_result`: the output is
        // generation-bounded and the external client has a big context.
        "local_generate" => {
            let prompt = args["prompt"].as_str().unwrap_or_default().trim().to_string();
            if prompt.is_empty() {
                return Err("local_generate needs a non-empty `prompt`.".into());
            }
            let explicit = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                model_setting(&room.conn)
            };
            let models = ollama::list_models().await.unwrap_or_default();
            let model = resolve_local_generate_model(explicit, &models);
            let mut messages = Vec::new();
            if let Some(sys) = args["system"].as_str().filter(|s| !s.trim().is_empty()) {
                messages.push(ollama::ChatMessage::new("system", sys));
            }
            messages.push(ollama::ChatMessage::new("user", prompt));
            let temperature = args["temperature"].as_f64();
            // `long` buys the Job-tier window: an external agent's big prompt
            // must not be silently truncated at the interactive chat window.
            let tier = if args["long"].as_bool().unwrap_or(false) {
                ollama::CtxTier::Job
            } else {
                ollama::CtxTier::Chat
            };
            if args["schema"].is_object() {
                ollama::chat_structured(
                    &model,
                    messages,
                    temperature,
                    KEEP_ALIVE_WARM,
                    &args["schema"],
                    ollama::StructuredOpts { tier, cancel: None },
                )
                .await
            } else {
                let raw = ollama::generate(&model, messages, temperature, KEEP_ALIVE_WARM, None, tier)
                    .await?;
                Ok(strip_think_spans(&raw).trim().to_string())
            }
        }
        // ADD-21: delegate a hard subtask to a cloud CLI. Gated: the tool is
        // only in the catalog when the advanced setting is on and a CLI exists,
        // but re-check the budget here so the model can't overspend the user's
        // cloud account by looping.
        "consult_advisor" => {
            if effects.advisor_calls >= MAX_ADVISOR_CALLS {
                return Ok("You have already consulted an advisor this turn. Use that answer, or \
                           answer the user yourself — do not consult again.".into());
            }
            let question = args["question"].as_str().unwrap_or_default().trim().to_string();
            if question.is_empty() {
                return Err("consult_advisor needs a non-empty `question` holding the full, \
                            self-contained task and all context the advisor will need.".into());
            }
            let want = args["advisor"].as_str().unwrap_or("claude");
            let engine = if want == "codex" { "codex-cli" } else { "claude-cli" };
            // Spend the budget before the slow call so a mid-flight retry can't
            // double-spend.
            effects.advisor_calls += 1;
            // The per-ask advisor bridge (started in `ask`, giving the room's
            // tools to the advisor) is claude-only; codex gets a plain pipe.
            // Starting the bridge here would create an async-recursion cycle
            // exec_tool → start → bridge → exec_tool, so it is passed in.
            let bridge = if engine == "claude-cli" { advisor_bridge } else { None };
            let msgs = vec![ollama::ChatMessage::new("user", question)];
            let res = run_external(engine, &msgs, cancel.clone(), bridge).await;
            match res {
                Ok(answer) => Ok(format!(
                    "Advisor ({want}) replied:\n\n{}",
                    clamp_tool_result(answer)
                )),
                // Return Ok so the local model recovers by answering itself,
                // instead of surfacing a raw tool error to the user.
                Err(e) => Ok(format!(
                    "The advisor could not be reached ({e}). Answer the user from what you \
                     already have."
                )),
            }
        }
        other => match routes.iter().find(|r| r.catalog_name == other) {
            Some(route) => {
                // SEC-1b: consent is tied to the moment data actually leaves the
                // room. Ask the user before invoking a connector's tool, unless
                // they chose "always allow" for it earlier this session.
                if !mcp_call_approved(state, window, route, args).await {
                    return Ok(format!(
                        "The user declined to run the \"{}\" tool from \"{}\", so it did \
                         not run and nothing left this room. Answer from what you already \
                         have, and tell the user you skipped that connected tool.",
                        route.tool_name, route.server_name
                    ));
                }
                let result = route
                    .client
                    .lock()
                    .await
                    .call_tool(&route.tool_name, args)
                    .await?;
                Ok(clamp_tool_result(result))
            }
            None => Err(format!("Unknown tool: {other}")),
        },
    }
}

/// CHG-5/CHG-28: format one window of a fetched page's readable text starting at
/// char offset `start`. When more text remains, the truncation notice tells the
/// model the exact `start` to pass to keep reading (served from cache — no new
/// network). Char-safe throughout.
pub(crate) fn fetch_page_window(title: &str, url: &str, text: &str, start: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let start = start.min(total);
    let header = format!("[{title}] {url}\n\n");
    // Leave room for the header within the per-result char budget.
    let window = MAX_TOOL_RESULT_CHARS.saturating_sub(header.chars().count() + 120);
    let end = (start + window).min(total);
    let body: String = chars[start..end].iter().collect();
    let mut out = format!("{header}{body}");
    if end < total {
        out.push_str(&format!(
            "\n… truncated at char {end} of {total}. To keep reading, call fetch_page again \
             with the same url and start={end} (instant, served from cache)."
        ));
    }
    out
}

/// Clamp at a char boundary — external tool output can be multibyte.
pub(crate) fn clamp_tool_result(s: String) -> String {
    if s.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return s;
    }
    let mut cut: String = s.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    cut.push_str("\n… (truncated)");
    cut
}

/// Largest byte index <= `max` that is a char boundary. Stable-Rust stand-in
/// for the nightly `str::floor_char_boundary`. Used everywhere text is clipped
/// by a byte budget, so a multibyte char straddling the limit never panics.
pub(crate) fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// Truncate a string to at most `max` bytes without ever splitting a char.
/// Returns the (possibly unchanged) string; appends nothing.
pub(crate) fn clamp_bytes(mut s: String, max: usize) -> String {
    if s.len() > max {
        s.truncate(floor_boundary(&s, max));
    }
    s
}

/// ADD-25: hand a captured image (screenshot / video frame) to the model.
/// Vision-capable chat model → queue the pixels; agent_loop attaches them as
/// a user message right after this tool result. Text-only chat model → a
/// LOCAL vision model describes the image and the description IS the result,
/// so every model tier gets perception without any pixels leaving the Mac.
pub(crate) async fn perceive_image(
    effects: &mut ToolEffects,
    image_b64: String,
    caption: &str,
) -> Result<String, String> {
    if effects.vision_chat {
        effects.pending_images.push(image_b64);
        return Ok(format!(
            "Captured {caption}. The image is attached to your context — look at it before \
             answering."
        ));
    }
    let models = ollama::list_models().await.unwrap_or_default();
    if models.is_empty() {
        return Err("No local model is available to look at the image.".into());
    }
    // This path only runs when the chat model itself can't read pixels, so we
    // need a *separate* image-capable LOCAL model to describe them. Prefer a
    // dedicated grounding VL model; otherwise any local vision-capable chat
    // model (qwen3.5, gemma3, llava…). Refuse if there's no genuine on-device
    // vision model: a text-only model just parrots the schema back
    // (`{"properties":{"description":{}}}`), and an external engine would leak
    // pixels this path promises never leave the Mac.
    let vmodel = models
        .iter()
        .find(|m| m.contains("qwen2.5vl") || m.contains("qwen2.5-vl") || m.contains("qwen3-vl"))
        .or_else(|| {
            models
                .iter()
                .find(|m| !is_external_engine(m) && is_vision_chat_model(m))
        })
        .cloned();
    let Some(vmodel) = vmodel else {
        return Err(
            "This room's chat model can't see images, and no local vision model is installed to \
             describe them. Install one — for example `ollama pull qwen2.5vl:3b` — then try again."
                .into(),
        );
    };
    let messages = vec![ollama::ChatMessage {
        role: "user".into(),
        content: format!(
            "This image is {caption}. Describe it precisely and concisely — visible text, \
             labels, values, and anything unusual — so an assistant that cannot see it can act \
             on your description."
        ),
        images: Some(vec![image_b64]),
        ..Default::default()
    }];
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"description": {"type": "string"}},
        "required": ["description"]
    });
    // The describe pass may load a second model; release it quickly on
    // low-RAM Macs (chat model unknown here, so "" never matches == warm).
    let keep = vision_keep_alive(total_ram_bytes(), &vmodel, "");
    let raw = ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &schema, Default::default()).await?;
    let desc = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v["description"].as_str().map(str::to_string))
        .unwrap_or(raw);
    Ok(clamp_tool_result(format!(
        "Your chat model can't view images, so a local vision model looked at {caption} and \
         reports: {desc}"
    )))
}

/// ADD-25: resolve the video a `view_media_frame` call means. First honor the
/// model's `name` (if it matches a real file); when that name is generic
/// ("the video") or missing, fall back to the room's sole video file — the
/// common case where the user is watching the one video they added. Returns
/// (file_id, display_name) or an Err string the model can relay.
pub(crate) fn resolve_video_file(
    conn: &Connection,
    name: &str,
) -> Result<(String, String), String> {
    let is_video = |mime: &str, fname: &str| {
        stt::media_kind(mime, &extraction::extension_of(fname)) == Some(stt::MediaKind::Video)
    };
    // A concrete name that resolves to a real file wins — but only if it's a
    // video; a matched non-video is a clear, relayable error.
    if !name.trim().is_empty() {
        if let Ok((id, real_name)) = db::find_file_like(conn, name) {
            let (fname, mime, _, _) = db::get_file_full(conn, &id)?;
            let mime = mime.unwrap_or_default();
            if is_video(&mime, &fname) {
                return Ok((id, real_name));
            }
            if stt::media_kind(&mime, &extraction::extension_of(&fname)).is_some() {
                return Err(format!(
                    "\"{real_name}\" is audio-only — there is no frame to look at; read its \
                     transcript instead."
                ));
            }
            return Err(format!(
                "\"{real_name}\" isn't a video — view_media_frame only works on video files."
            ));
        }
    }
    // No usable name → the sole video in the room, if there is exactly one.
    let videos: Vec<FileMeta> = db::list_files(conn)?
        .into_iter()
        .filter(|f| is_video(&f.mime_type, &f.name))
        .collect();
    match videos.as_slice() {
        [only] => Ok((only.id.clone(), only.name.clone())),
        [] => Err("There are no video files in this room to look at.".into()),
        many => Err(format!(
            "There are several videos — say which one: {}.",
            many.iter().map(|f| f.name.clone()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// ADD-25: shrink a captured PNG to at most `max_w` pixels wide (aspect kept)
/// and return it base64-encoded. Retina window snapshots are ~3000px wide —
/// far past what a 4-8B vision model can use, and slow to encode as context.
pub(crate) fn downscale_png_b64(png: &[u8], max_w: u32) -> Result<String, String> {
    let img = image::load_from_memory(png)
        .map_err(|e| format!("couldn't decode the snapshot: {e}"))?;
    let img = if img.width() > max_w {
        img.resize(max_w, u32::MAX, image::imageops::FilterType::CatmullRom)
    } else {
        img
    };
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't re-encode the snapshot: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

/// ADD-25: "1:23" / "1:02:03" / "75" / "75.5" → seconds. The tool accepts the
/// same [m:ss] stamps the transcripts carry, so the model can quote them back.
pub(crate) fn parse_timestamp_secs(s: &str) -> Result<f64, String> {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    if s.is_empty() {
        return Err("Give a timestamp like \"1:23\" or seconds like \"75\".".into());
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() > 3 {
        return Err(format!("\"{s}\" is not a timestamp (use h:mm:ss, m:ss, or seconds)."));
    }
    let mut secs = 0.0;
    for p in &parts {
        let v: f64 = p
            .trim()
            .parse()
            .map_err(|_| format!("\"{s}\" is not a timestamp (use h:mm:ss, m:ss, or seconds)."))?;
        secs = secs * 60.0 + v;
    }
    Ok(secs.max(0.0))
}

/// Clip a string to `max` chars at a trailing word boundary when possible,
/// for one-line inventory descriptions. Never splits a char.
pub(crate) fn clamp_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    if let Some(sp) = out.rfind(char::is_whitespace) {
        if sp > max / 2 {
            out.truncate(sp);
        }
    }
    out.push('…');
    out
}

/// ADD-13 fix: a char-safe, whitespace-preserving excerpt centered on the
/// first case-insensitive match of `query` (falling back to the first query
/// word, then the text start). Unlike `make_snippet` this keeps the original
/// whitespace, so quotes returned by search_room stay verbatim-copyable for
/// edit_file / annotate_file. Never slices a char (fixes the byte-index panic
/// that poisoned the room mutex).
pub(crate) fn excerpt(text: &str, query: &str, max_chars: usize) -> String {
    let lower = text.to_lowercase();
    let find = |n: &str| -> Option<usize> {
        let n = n.trim().to_lowercase();
        if n.is_empty() {
            None
        } else {
            lower.find(&n)
        }
    };
    let chars: Vec<char> = text.chars().collect();
    let Some(byte) = find(query).or_else(|| query.split_whitespace().find_map(find)) else {
        // No match: char-safe prefix.
        let mut out: String = chars.iter().take(max_chars).collect();
        if chars.len() > max_chars {
            out.push('…');
        }
        return out;
    };
    let char_pos = text[..byte].chars().count();
    let radius = max_chars / 2;
    let start = char_pos.saturating_sub(radius);
    let end = (start + max_chars).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// CHG-10: conservative check for a first-person/passive past-tense claim that a
/// file was changed or a passage highlighted, used only to append a correction
/// when the runtime knows no such effect occurred (`wrote`/`highlighted`). Skips
/// negated and conditional phrasings, and ignores fenced code/diff blocks, so a
/// false correction (its own trust failure) is unlikely. Returns true only when
/// there is a claim AND the corresponding effect is missing.
pub(crate) fn claims_unbacked_action(text: &str, wrote: bool, highlighted: bool) -> bool {
    // Drop fenced blocks (diffs, code, viewer markup) before scanning prose.
    let mut prose = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            prose.push_str(line);
            prose.push('\n');
        }
    }
    let lower = prose.to_lowercase();
    // Verb phrases that assert an action already happened.
    const WRITE_CLAIMS: &[&str] = &[
        "i've updated",
        "i have updated",
        "i've edited",
        "i have edited",
        "i've changed",
        "i have changed",
        "i've saved",
        "i have saved",
        "i've fixed",
        "i have fixed",
        "i've rewritten",
        "i've rewrote",
        "i updated the",
        "i edited the",
        "i changed the",
        "i saved the",
        "i fixed the",
        "i've created",
        "i created the",
        "i set ",
        "file has been updated",
        "file was updated",
        "file has been saved",
        "file was saved",
        "file has been changed",
        "the file is updated",
    ];
    const HL_CLAIMS: &[&str] = &[
        "i've highlighted",
        "i have highlighted",
        "i highlighted the",
        "i've marked",
        "i marked the",
        "i've boxed",
        "i boxed the",
        "i've circled",
    ];
    // A crude negation guard: skip a claim if "not"/"n't"/"unable"/"couldn't"
    // appears in the same line as the matched phrase.
    let has_claim = |claims: &[&str]| -> bool {
        for c in claims {
            let mut from = 0;
            while let Some(pos) = lower[from..].find(c) {
                let abs = from + pos;
                let line_start = lower[..abs].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = lower[abs..].find('\n').map(|i| abs + i).unwrap_or(lower.len());
                let line = &lower[line_start..line_end];
                let negated = ["not ", "n't", "unable", "cannot", "can't", "could not", "couldn't", "would ", "if "]
                    .iter()
                    .any(|n| line.contains(n));
                if !negated {
                    return true;
                }
                from = line_end;
            }
        }
        false
    };
    (!wrote && has_claim(WRITE_CLAIMS)) || (!highlighted && has_claim(HL_CLAIMS))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fabrication_gate_flags_only_unbacked_claims() {
        assert!(claims_unbacked_action("I've updated the file.", false, false));
        // Backed by a real write → no correction.
        assert!(!claims_unbacked_action("I've updated the file.", true, false));
        // Negated / conditional phrasing must not trigger.
        assert!(!claims_unbacked_action("I have not changed the file.", false, false));
        assert!(!claims_unbacked_action(
            "I could edit the file if you want.",
            false,
            false
        ));
        // Highlight claim needs a highlight effect.
        assert!(claims_unbacked_action("I highlighted the total.", false, false));
        assert!(!claims_unbacked_action("I highlighted the total.", false, true));
    }

    #[test]
    fn excerpt_is_char_safe_and_centered() {
        // Multibyte string longer than the window must not panic and should
        // center on the match.
        let text = "café ".repeat(400); // multibyte, > 800 bytes
        let ex = excerpt(&text, "café", 800);
        assert!(ex.chars().count() <= 802); // window + ellipses
        // A curly-quote string clipped mid-window is fine.
        let s = "“smart quotes” ".repeat(100);
        let _ = excerpt(&s, "missing", 800);
    }

    #[test]
    fn normalizes_for_quote_matching() {
        let doc = normalize_for_match("The  Fee is\n 5%  of total.");
        assert!(doc.contains(&normalize_for_match("fee is 5%")));
        // A consonantal quote (from search chunks) must match pointed file
        // text — nikud/cantillation fold away on both sides.
        let pointed = normalize_for_match("דִּבְרֵי קֹהֶלֶת בֶּן־דָּוִד");
        assert!(pointed.contains(&normalize_for_match("קהלת")));
        // Maqaf ≡ hyphen: a model typing בן-דוד must match the file's בן־דוד.
        assert!(pointed.contains(&normalize_for_match("בן-דוד")));
    }

    #[test]
    fn build_annotation_verifies_quote_verbatim() {
        let text = "The lease permits one cat but no dogs.";
        // A verbatim (normalization-tolerant) quote succeeds.
        let (payload, described) =
            build_annotation("id1", "lease.pdf", Some(text), "one cat", "", None, None, None)
                .unwrap();
        assert_eq!(described, "\"one cat\"");
        assert_eq!(payload["quote"], "one cat");
        // A quote not present is rejected (the anti-fabrication gate).
        assert!(
            build_annotation("id1", "lease.pdf", Some(text), "three cats", "", None, None, None)
                .is_err()
        );
        // A cell range needs no text.
        let (p, d) =
            build_annotation("id2", "budget.xlsx", None, "", "B2:D5", None, None, None).unwrap();
        assert_eq!(d, "cells B2:D5");
        assert_eq!(p["range"], "B2:D5");
    }

    #[test]
    fn wants_write_tools_routes_by_intent() {
        // Edit/create/highlight intents open the write tools…
        assert!(wants_write_tools("please fix the typo in the contract"));
        assert!(wants_write_tools("Create a summary note"));
        assert!(wants_write_tools("highlight the pet clause"));
        assert!(wants_write_tools("translate this to French"));
        // …plain informational questions keep the short read-only catalog.
        assert!(!wants_write_tools("what does the lease say about pets?"));
        assert!(!wants_write_tools("who are the parties in this agreement"));
    }

    #[test]
    fn wants_ui_tools_routes_operate_intents() {
        // Operate-the-app intents open the UI/perception tools…
        assert!(wants_ui_tools("click the Save button"));
        assert!(wants_ui_tools("take a screenshot of the chart"));
        assert!(wants_ui_tools("scroll down in the sidebar"));
        assert!(wants_ui_tools("what do you see on screen?"));
        assert!(wants_ui_tools("look at the video at 2:15"));
        // QA regression: these natural phrasings matched no hint, so ui_act was
        // never offered and the agent couldn't drive the app.
        assert!(wants_ui_tools("open the Room Map"));
        assert!(wants_ui_tools("open the Memory panel"));
        assert!(wants_ui_tools("switch the budget spreadsheet to the Detail tab"));
        assert!(wants_ui_tools("generate flashcards from the clean code pdf"));
        assert!(wants_ui_tools("mark the main subject in photo.jpg"));
        // …a plain document question does not.
        assert!(!wants_ui_tools("summarize the contract"));
        assert!(!wants_ui_tools("who signed this agreement"));
    }

    #[test]
    fn wants_job_tools_routes_whole_file_intents() {
        // Whole-file work opens the pass tools…
        assert!(wants_job_tools("summarize the entire book"));
        assert!(wants_job_tools("translate the whole contract to French"));
        assert!(wants_job_tools("go through all of it, don't miss anything"));
        assert!(wants_job_tools("read it cover to cover"));
        assert!(wants_job_tools("is the background job done yet?"));
        // …a pointed question about one clause does not.
        assert!(!wants_job_tools("what does the lease say about pets?"));
        assert!(!wants_job_tools("who signed this agreement"));
    }

    #[test]
    fn job_tools_never_leak_into_the_room_bridge_catalog() {
        // ADD-32 structural guard, same as the UI tools: the pass tools must
        // NOT be in tools_catalog (which builds the room MCP bridge) — only
        // injected into the local agent loop. A cloud client must not be able
        // to start hours of local compute.
        let catalog = tools_catalog(true).to_string();
        for name in ["start_file_pass", "job_status"] {
            assert!(!catalog.contains(name), "{name} must not be in tools_catalog");
        }
        assert_eq!(job_tools_specs().len(), 2);
    }

    #[test]
    fn workflow_tools_never_leak_into_the_room_bridge_catalog() {
        // Wave 4a structural guard: the four workflow tools are LocalEngine/
        // ExternalAgent-only (served over the bridge, gated by the jobs router) —
        // never in tools_catalog, so a cloud client can never reach them. Each is
        // also reserved in BUILTIN_TOOL_NAMES against MCP shadowing.
        let catalog = tools_catalog(true).to_string();
        let specs = workflow_tools_specs();
        assert_eq!(specs.len(), 4);
        for name in ["list_workflows", "save_workflow", "update_workflow", "run_workflow"] {
            assert!(!catalog.contains(name), "{name} must not be in tools_catalog");
            assert!(BUILTIN_TOOL_NAMES.contains(&name), "{name} must be reserved");
            assert!(specs.iter().any(|s| s["function"]["name"] == name), "{name} spec missing");
        }
    }

    #[test]
    fn wants_job_tools_routes_workflow_intents() {
        // Wave 4a: the workflow keywords ride the jobs routing flag.
        assert!(wants_job_tools("make me a workflow that summarizes new files every morning"));
        assert!(wants_job_tools("automate a weekly review"));
        assert!(wants_job_tools("set up a recurring pipeline"));
        assert!(wants_job_tools("run the morning digest workflow"));
    }

    #[test]
    fn exec_tool_arms_are_reserved_against_mcp_shadowing() {
        // Every exec_tool arm that dispatches to a built-in (not the `other =>`
        // MCP fallback) must be in BUILTIN_TOOL_NAMES, or a connected MCP server
        // whose sanitized name collides could shadow the built-in and skip the
        // SEC-1b consent gate. `consult_advisor` and `local_generate` are never
        // in any bridge catalog but ARE exec_tool arms, so they are the two that
        // the plain leak guards above don't already cover.
        for name in ["consult_advisor", "local_generate"] {
            assert!(
                BUILTIN_TOOL_NAMES.contains(&name),
                "{name} is an exec_tool arm but not reserved — an MCP route could shadow it"
            );
        }
    }

    #[test]
    fn external_agent_tools_never_leak_into_the_room_bridge_catalog() {
        // Wave 1a structural guard, same as the job/UI tools: local_generate
        // is NOT in tools_catalog — only the bridge's ExternalAgent scope
        // advertises it, so no in-room engine or cloud advisor ever sees it.
        assert!(!tools_catalog(true).to_string().contains("local_generate"));
        let specs = external_agent_tools_specs();
        assert_eq!(specs.len(), 1);
        let f = &specs[0]["function"];
        assert_eq!(f["name"], "local_generate");
        assert_eq!(f["parameters"]["required"], serde_json::json!(["prompt"]));
        for p in ["prompt", "system", "schema", "temperature", "long"] {
            assert!(f["parameters"]["properties"][p].is_object(), "missing param {p}");
        }
        // The content-perception subset is exactly view_media_frame.
        let media = media_tools_specs();
        assert_eq!(media.len(), 1);
        assert_eq!(media[0]["function"]["name"], "view_media_frame");
    }

    #[test]
    fn local_generate_never_resolves_to_a_cloud_model() {
        // Wave 1a amendment: the tool promises LOCAL execution. A :cloud chat
        // model, an external CLI engine, and a :cloud-first install must all
        // land on a genuinely local model — resolve_pass_engine's cloud lane
        // is deliberately NOT the template here.
        let models = vec![
            "minimax-m3:cloud".to_string(),
            "nomic-embed-text:latest".to_string(),
            "qwen3.5:9b".to_string(),
        ];
        assert_eq!(
            resolve_local_generate_model(Some("minimax-m3:cloud".into()), &models),
            "qwen3.5:9b"
        );
        assert_eq!(
            resolve_local_generate_model(Some("claude-cli::opus".into()), &models),
            "qwen3.5:9b"
        );
        // An explicit local pick is honored.
        assert_eq!(
            resolve_local_generate_model(Some("qwen3.5:9b".into()), &models),
            "qwen3.5:9b"
        );
        assert_eq!(resolve_local_generate_model(None, &models), "qwen3.5:9b");
        // Nothing local installed → the default NAME, so Ollama surfaces a
        // clear MODEL_MISSING instead of silently running on the cloud.
        let no_local = vec!["minimax-m3:cloud".to_string()];
        assert_eq!(resolve_local_generate_model(None, &no_local), DEFAULT_MODEL);
    }

    #[test]
    fn ui_tools_never_leak_into_the_room_bridge_catalog() {
        // ADD-25 structural guard: the UI/perception tools must NOT be in
        // tools_catalog (which builds the room MCP bridge) — only injected
        // into the local agent loop. A regression here would hand a cloud
        // client the user's screen.
        let catalog = tools_catalog(true).to_string();
        for name in ["ui_snapshot", "ui_act", "view_screenshot", "view_media_frame"] {
            assert!(!catalog.contains(name), "{name} must not be in tools_catalog");
        }
        // But they ARE offered by the dedicated spec builder.
        let specs = ui_tools_specs();
        assert_eq!(specs.len(), 4);
    }

    #[test]
    fn style_paragraph_maps_known_styles() {
        // Wave 1b (idea 12): each register maps to its constant…
        assert!(style_paragraph(Some("terse")).unwrap().starts_with("Response style: TERSE."));
        assert!(style_paragraph(Some("friendly")).unwrap().starts_with("Response style: FRIENDLY."));
        assert!(style_paragraph(Some("formal")).unwrap().starts_with("Response style: FORMAL."));
        // …and the audited register halves are present: terse keeps "technical",
        // friendly keeps "explanatory", formal keeps "structured".
        assert!(style_paragraph(Some("terse")).unwrap().contains("precise technical vocabulary"));
        assert!(style_paragraph(Some("friendly")).unwrap().contains("briefly explain the why"));
        assert!(style_paragraph(Some("formal")).unwrap().contains("short headings or numbered points"));
    }

    #[test]
    fn style_paragraph_none_for_default_and_unknown() {
        // Byte-stability guard: absent/default/unknown values inject NOTHING,
        // so those rooms' system prompts stay byte-identical to today's.
        assert!(style_paragraph(None).is_none());
        assert!(style_paragraph(Some("default")).is_none());
        assert!(style_paragraph(Some("")).is_none());
        assert!(style_paragraph(Some("TERSE")).is_none(), "stored values are exact, not folded");
        assert!(style_paragraph(Some("shakespearean")).is_none());
    }

    #[test]
    fn style_block_appends_precedence_sentence_only_with_custom_text() {
        // Free text wins (triage rule): the sentence appears exactly when
        // custom instructions ride below the preset.
        let plain = style_block(Some("terse"), false).unwrap();
        assert_eq!(plain, STYLE_TERSE);
        let with_custom = style_block(Some("terse"), true).unwrap();
        assert!(with_custom.starts_with(STYLE_TERSE));
        assert!(with_custom.ends_with("follow the user's preferences."));
        // No preset → nothing, regardless of custom text.
        assert!(style_block(None, true).is_none());
    }

    #[test]
    fn list_memories_rides_the_base_catalog() {
        // Wave 1b (idea 5): the read-back tool is part of tools_catalog (served
        // to every scope like list_room_files) and carries no parameters; the
        // add_memory spec gained the optional category enum.
        let catalog = tools_catalog(false).to_string();
        assert!(catalog.contains("\"list_memories\""));
        assert!(catalog.contains("\"category\""));
        assert!(BUILTIN_TOOL_NAMES.contains(&"list_memories"));
    }

    #[test]
    fn effects_json_is_none_until_a_tool_draws() {
        let mut e = ToolEffects::default();
        assert!(effects_json(&e).is_none(), "plain answer → NULL effects column");
        e.annotation = Some(serde_json::json!({"fileId": "x", "quote": "hi"}));
        let v = effects_json(&e).expect("annotation should produce effects");
        assert!(v["annotation"].is_object());
        assert!(v.get("boxes").is_none());
        // Wave 2 (Idea 4): an edit-only turn also flips the column non-null, under
        // the content-free "edits" key.
        let mut e2 = ToolEffects::default();
        e2.edit_outcomes.push(serde_json::json!({"tool": "edit_file", "outcome": "fuzzy", "n": 1}));
        let v2 = effects_json(&e2).expect("edit outcomes should produce effects");
        assert!(v2["edits"].is_array());
        assert_eq!(v2["edits"][0]["outcome"], "fuzzy");
        assert!(v2.get("boxes").is_none() && v2.get("annotation").is_none());
    }

    #[test]
    fn edit_files_is_served_over_the_bridge_catalog() {
        // Idea 7: unlike the job/UI tools, edit_files MUST be in tools_catalog so
        // the sidecar and Leash clients can call it — and its name is reserved
        // against MCP shadowing.
        let catalog = tools_catalog(false).to_string();
        assert!(catalog.contains("\"edit_files\""));
        assert!(BUILTIN_TOOL_NAMES.contains(&"edit_files"));
        // Idea 4: the `all` escape hatch is schema-visible, not just prose.
        assert!(catalog.contains("\"all\""));
    }

    #[test]
    fn timestamp_parsing_matches_transcript_stamps() {
        assert_eq!(parse_timestamp_secs("75"), Ok(75.0));
        assert_eq!(parse_timestamp_secs("1:15"), Ok(75.0));
        assert_eq!(parse_timestamp_secs("1:02:03"), Ok(3723.0));
        assert_eq!(parse_timestamp_secs("[12:34]"), Ok(754.0)); // the [m:ss] the UI prints
        assert!(parse_timestamp_secs("1:2:3:4").is_err());
        assert!(parse_timestamp_secs("abc").is_err());
        assert!(parse_timestamp_secs("").is_err());
    }

    #[test]
    fn closest_snippet_anchors_paraphrase_verbatim() {
        let text = "The quarterly revenue was four million dollars this year.";
        // A paraphrased quote still finds the real passage, returned verbatim.
        let snip = closest_snippet(text, "quarterly revenue was five million").unwrap();
        assert!(text.contains(&snip), "must be a real substring: {snip}");
        assert!(snip.to_lowercase().contains("quarterly revenue was"));
        // Unrelated text has no close passage, and short quotes are never guessed.
        assert!(closest_snippet(text, "the weather is sunny today outside").is_none());
        assert!(closest_snippet(text, "big money").is_none());
    }

    #[test]
    fn build_annotation_falls_back_to_closest_passage() {
        let text = "Payment is due within thirty days of receipt of invoice.";
        // A quote that isn't verbatim (drops "is", "thirty"→"30") still anchors,
        // flagged approximate — turning a hard failure into a soft success.
        let (payload, described) = build_annotation(
            "id",
            "terms.txt",
            Some(text),
            "payment due within 30 days",
            "",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(payload["approx"], true);
        assert!(described.contains("closest match"), "got: {described}");
        let q = payload["quote"].as_str().unwrap();
        assert!(text.contains(q), "highlighted quote must be verbatim: {q}");
    }

}
