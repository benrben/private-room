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

/// Multiset line difference between two texts — how many lines in `after`
/// have no matching line left in `before` (added), and vice versa (removed).
/// Not a real LCS diff (a moved-but-unchanged line counts as one added + one
/// removed), but dependency-free and enough to answer "how much changed" —
/// the point is catching an accidental near-total rewrite, not rendering a
/// diff view (the approval card already shows the full before/after text).
fn line_multiset_diff(before: &str, after: &str) -> (usize, usize) {
    use std::collections::HashMap;
    let mut before_counts: HashMap<&str, i64> = HashMap::new();
    for line in before.lines() {
        *before_counts.entry(line).or_insert(0) += 1;
    }
    let mut after_counts: HashMap<&str, i64> = HashMap::new();
    for line in after.lines() {
        *after_counts.entry(line).or_insert(0) += 1;
    }
    let added: i64 = after_counts
        .iter()
        .map(|(line, &n)| (n - before_counts.get(line).copied().unwrap_or(0)).max(0))
        .sum();
    let removed: i64 = before_counts
        .iter()
        .map(|(line, &n)| (n - after_counts.get(line).copied().unwrap_or(0)).max(0))
        .sum();
    (added as usize, removed as usize)
}

/// E5 (2026-08-04): report what `plan_single_edit`/`plan_batch` computed
/// without ever calling `commit_plans` — the caller is responsible for that
/// split; this only formats. Capped well below `PREVIEW_CLIP` (that clamp is
/// sized for a UI diff card, not a tool result that returns to the model's
/// context on every dry run).
const DRY_RUN_AFTER_CLAMP: usize = 800;

fn dry_run_summary(plans: &[PlannedWrite]) -> String {
    let lines: Vec<String> = plans
        .iter()
        .map(|p| match (&p.new_bytes, &p.rename_to) {
            (Some(_), rename_to) => {
                let method = p.method.map(EditMethod::outcome).unwrap_or("exact");
                let rename_note = rename_to
                    .as_ref()
                    .map(|n| format!(" and rename it to \"{n}\""))
                    .unwrap_or_default();
                format!(
                    "\"{}\": would replace {} occurrence(s) via {method}{rename_note}. Resulting \
                     content would start: \"{}\"",
                    p.real_name,
                    p.count,
                    clamp_bytes(p.after.clone(), DRY_RUN_AFTER_CLAMP)
                )
            }
            (None, Some(new_name)) => {
                format!("\"{}\": would rename to \"{new_name}\". No content change.", p.real_name)
            }
            (None, None) => format!("\"{}\": no change.", p.real_name),
        })
        .collect();
    format!(
        "DRY RUN — nothing was written or renamed. {}",
        lines.join("\n")
    )
}

/// E9 (2026-08-04): `write_file` is a full-document rewrite with no version
/// check — the one path where the model reproducing "most of" a long document
/// instead of all of it looks like plain success. Reports what changed instead
/// of only a character count, and flags a shrink big enough to suggest content
/// was dropped rather than deliberately trimmed.
fn write_file_summary(real_name: &str, before: &str, after: &str, new_chars: usize, clipped: bool) -> String {
    let (added, removed) = line_multiset_diff(before, after);
    let before_len = before.chars().count();
    let delta = new_chars as i64 - before_len as i64;
    let delta_str = if delta >= 0 {
        format!("+{delta} characters")
    } else {
        format!("{delta} characters")
    };
    let partial_note = if clipped {
        " (comparison is based on a partial view — this file is very large)"
    } else {
        ""
    };
    // A large shrink on a substantial file is the failure mode worth flagging;
    // a short file shrinking (e.g. "delete everything but the title") is
    // ordinary and not worth a warning every time.
    let shrink_warning = if !clipped && before_len > 200 && new_chars * 2 < before_len {
        " The new content is under half the size of what was there before — if that wasn't \
         intentional, the rewrite may have dropped content."
    } else {
        ""
    };
    format!(
        "Rewrote \"{real_name}\" ({new_chars} characters, {added} line(s) added, {removed} \
         line(s) removed, {delta_str}){partial_note}.{shrink_warning}"
    )
}

/// D1 (2026-08-04): `list_memories` was the one list tool with NO bound at
/// all — every memory, in full, always. Same cap-plus-honest-count shape as
/// `list_room_files` (CHG-1); a room with hundreds of notes could otherwise
/// crowd out the whole system prompt on a single "what do you remember?"
/// question. Caller has already handled the empty case.
const MAX_LISTED_MEMORIES: usize = 50;

fn format_memory_list(memories: Vec<Memory>) -> String {
    let total = memories.len();
    let mut lines: Vec<String> = memories
        .into_iter()
        .take(MAX_LISTED_MEMORIES)
        .map(|m| match m.category.as_deref() {
            Some(c) => format!("- [{c}] {}", m.content),
            None => format!("- {}", m.content),
        })
        .collect();
    if total > MAX_LISTED_MEMORIES {
        lines.push(format!(
            "…and {} more memories — ask about something more specific to find them.",
            total - MAX_LISTED_MEMORIES
        ));
    }
    lines.join("\n")
}

/// D5 (2026-08-04): `job_status` used to have no way to ask about ONE job —
/// every call dumped up to 8 of them. No tool ever hands the model a job's id
/// today (`start_file_pass` discards it), so the fix has to be self-contained:
/// every listing now shows each job's own SHORT id prefix, and `job_id`
/// accepts either that prefix or the full id from a previous listing. Omit it
/// for the unchanged summary of everything.
const JOB_SHORT_ID_LEN: usize = 8;

fn job_status_reply(jobs: &[db::Job], job_id: Option<&str>) -> String {
    let one_line = |j: &db::Job| -> String {
        // A job the APP stopped is 'paused' too, and reporting only the
        // status would have the assistant tell the user their work is paused
        // as if they had paused it. The row records who actually stopped it;
        // say so.
        let why = j
            .parked_reason
            .as_deref()
            .map(|r| format!(" — {r} Resume picks it up here."))
            .unwrap_or_default();
        let short_id = &j.id[..j.id.len().min(JOB_SHORT_ID_LEN)];
        format!(
            "- [{short_id}] {} — {} ({} of {} steps done){}",
            j.title, j.status, j.cursor, j.total, why
        )
    };

    let Some(query) = job_id.map(str::trim).filter(|q| !q.is_empty()) else {
        return jobs.iter().take(8).map(one_line).collect::<Vec<_>>().join("\n");
    };
    let query_lower = query.to_lowercase();
    let matches: Vec<&db::Job> =
        jobs.iter().filter(|j| j.id.to_lowercase().starts_with(&query_lower)).collect();
    match matches.as_slice() {
        [] => format!(
            "No background job matches id \"{query}\". Call job_status with no arguments to \
             see every job's id."
        ),
        [job] => {
            let why = job
                .parked_reason
                .as_deref()
                .map(|r| format!("\nWhy it's paused: {r} Resume picks it up here."))
                .unwrap_or_default();
            let error = job
                .error
                .as_deref()
                .map(|e| format!("\nError: {e}"))
                .unwrap_or_default();
            format!(
                "[{}] {}\nStatus: {} ({} of {} steps done){why}{error}",
                job.id, job.title, job.status, job.cursor, job.total
            )
        }
        many => format!(
            "\"{query}\" matches {} jobs; be more specific:\n{}",
            many.len(),
            many.iter().map(|j| one_line(j)).collect::<Vec<_>>().join("\n")
        ),
    }
}

/// The spreadsheet grid's column ceiling: columns run A..XFD, so 16 384 of them.
///
/// `parse_a1` owns the row ceiling and the letter-count guard; the column VALUE
/// is the one thing it does not bound, and three letters are enough to name a
/// column no sheet has (`ZZZ` is 18 278).
pub(crate) const MAX_SHEET_COLS: usize = 16_384;

/// Validate every cell reference up front so a bad one fails before any write.
///
/// Not cosmetic: a write GROWS the sheet until it reaches the cell, with no
/// bound of its own, so an out-of-grid reference costs blank rows or columns by
/// the thousand for what is always a typo.
fn validate_cell_refs(updates: &[(String, String)]) -> Result<(), String> {
    for (cell, _) in updates {
        let Some((_row, col)) = parse_a1(cell) else {
            return Err(format!("\"{cell}\" is not a cell — use A1 notation like B7."));
        };
        if col >= MAX_SHEET_COLS {
            return Err(format!(
                "\"{cell}\" is outside the spreadsheet grid — a sheet has at most \
                 {MAX_SHEET_COLS} columns, A to XFD. Nothing was changed."
            ));
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
    // PRIV-1: "send real details this once" — set only by the chat valve's
    // confirmed re-ask; absent for every ordinary turn.
    privacy_bypass: Option<bool>,
) -> Result<Message, String> {
    // Wave 3 (Idea 9): don't start a turn while a rollback is swapping the DB —
    // it would save messages that either fail or land against the wrong room.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }

    // ADD-7: register this ask's cancel flag; the guard removes it on return
    // (success, error, or cancel) so `close_room`'s wait can see us finish.
    //
    // Owner replacement #3: the flag is now the ROOT of this run's cancel tree.
    // Nothing about the flag changes for the loops that poll it — but the work
    // this turn starts (a Studio build, a background job) can now be attached to
    // it by run id, so Stop reaches that work too. `cancel_node` must outlive
    // every child it adopts, which it does: it is dropped when `ask` returns.
    let cancel_node = crate::cancel::register_run(&state, &ask_id, "this answer");
    let cancel = cancel_node.flag();
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: ask_id.clone(),
    };
    // Owner replacement #4: the identity every event of this turn carries. The
    // ask id is the frontend's own handle, so the chat has already registered
    // this run and will reject anything that names a different one.
    let turn = crate::turn::TurnId::new(&ask_id, &chat_id);

    // ADD-31: the audit's worst wait was an anonymous "Thinking locally…" for
    // 30+ seconds. Name the two hidden phases: waking the daemon (ADD-29 makes
    // this implicit and slow the first time) and searching the room.
    if !crate::ollama_lifecycle::is_awake(&ollama::resolved_base_url()).await {
        turn.step(&window, "Starting the local AI…");
    }
    turn.step(&window, "Searching your files…");

    // ADD-13: embed the question BEFORE taking the room lock (the Ollama call is
    // async; the lock is not held across it). None on any failure → keyword-only.
    let embedding_question = explicit_skill_request(&question)
        .map(|(_, request)| request)
        .unwrap_or(question.trim());
    let question_embedding = embed_question(embedding_question).await;

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

    // Live-QA 2026-07-23: a PURE "save that as a file" turn is deterministic —
    // content = the previous assistant reply, name = whatever the user said.
    // The 4B model failed this twice (asked for content, then fabricated a
    // different document without calling create_file), so code does it and the
    // model gets no vote — the exact Save-to-room button path. Attachments or
    // transform verbs ("save that translated…") fall through to the engine.
    if attachments.is_empty() && is_pure_save_reference(&question) {
        let prev = state.with_room(|room| db::list_messages(&room.conn, &chat_id))?;
        // `is_failure_notice` is the app's own check for "this assistant row is
        // one of OUR notices, not an answer" — and this path, which turns the
        // previous reply into a FILE, was the one place that never asked it. A
        // turn that failed left the user with a document containing only the
        // error text and the words "Saved your previous answer".
        let prev = prev.iter().rev().find(|m| {
            m.role == "assistant"
                && m.kind.is_none()
                && !m.content.trim().is_empty()
                && !is_failure_notice(&m.content)
        });
        if let Some(prev) = prev {
            use tauri::Manager;
            let name =
                requested_file_name(&question).unwrap_or_else(|| "Saved answer".to_string());
            let content = prev.content.trim_end_matches(" *(stopped)*").to_string();
            let meta = super::files::save_generated_impl(
                &window.app_handle().clone(),
                state.inner(),
                name,
                content,
            )?;
            turn.step(&window, "Saved to the room");
            let text = format!("Saved your previous answer to the room as \"{}\".", meta.name);
            turn.emit(&window, "ask-delta", text.clone());
            let mut fx = ToolEffects::default();
            fx.wrote = true;
            let fx = effects_json(&fx);
            return persist_assistant_reply(&state, &chat_id, text, vec![meta.name.clone()], fx);
        }
    }

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
    effects.vision_chat = chat_model_sees_images(&model).await;

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
        privacy_bypass.unwrap_or(false),
        &turn,
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
                // Was: `vision_model` (Qwen-VL names only), then any external
                // model swapped for `best_default` — which on a cloud room
                // handed the grounding pass to whatever local model happened to
                // be installed, text-only ones included, and got `[]` back. Ask
                // who can really see instead; `None` means nothing can, and the
                // pass is skipped rather than faked.
                if let Some(vmodel) = grounding_pick(&models, &model).await {
                    if let Ok(boxes) =
                        ground_prepared_image(&vmodel, &model, img_bytes, &question, *w, *h).await
                    {
                        if !boxes.is_empty() {
                            effects.boxes = Some(serde_json::json!({
                                "fileId": img_id,
                                "name": img_name,
                                "boxes": boxes,
                            }));
                            turn.step(&window, "Marked the image");
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
    // correction when the answer claims one that didn't. Every engine now runs
    // through the hub and its tools go through our bridge, so every engine has
    // real effects to check against (the old "cloud has no tool effects" carve-
    // out described the CLI's opaque direct path, which no longer exists).
    // Never over a stopped partial.
    if !stopped {
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
        // Owner replacement #3: a Stop that also killed a Studio build or a
        // file pass has to SAY so. Only the tree knows what this run had
        // started, and only nodes that are still live are listed — work that
        // finished before the Stop produced a real artifact and must not be
        // reported as stopped. Written before the marker so the exact
        // `" *(stopped)*"` suffix stays the last thing in the message (the
        // save-that-as-a-file path strips it by that literal).
        let also = cancel_node.stopped_children();
        if !also.is_empty() {
            content.push_str(&format!("\n\n*(Also stopped: {}.)*", also.join(", ")));
        }
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
fn explicit_skill_request(question: &str) -> Option<(&str, &str)> {
    let question = question.trim_start();
    let rest = question.strip_prefix('/')?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let name = &rest[..end];
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return None;
    }
    Some((name, rest[end..].trim()))
}

fn gather_context_and_save_question(
    _window: &tauri::Window,
    state: &State<'_, AppState>,
    chat_id: &str,
    question: &str,
    attachments: &[String],
    question_embedding: Option<&[f32]>,
) -> Result<QuestionContext, String> {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let (explicit_skill_name, effective_question) = match explicit_skill_request(question) {
            Some((name, request)) => (Some(name), request),
            None => (None, question.trim()),
        };

        let explicit_model = model_setting(conn);
        let temperature: Option<f64> = db::get_setting(conn, "temperature")
            .and_then(|s| s.parse().ok());
        let custom_instructions: Option<String> = db::get_setting(conn, "custom_instructions");
        // Wave 1b (idea 12): the user's chosen response register for this room.
        let response_style: Option<String> = db::get_setting(conn, "response_style");
        // D11: the room's chosen persona (room_role). Written by the Settings
        // "Role" section; its instructions are injected into the system prompt
        // below. (Before this it was persisted but never read — the persona had
        // no effect on answers.)
        let room_role: Option<String> = db::get_setting(conn, "room_role");

        let memories: Vec<String> = db::list_memories(conn)?
            .into_iter()
            .map(|m| m.content)
            .collect();

        // Agent Skills progressive disclosure, level 1: only the enabled
        // name+description metadata enters every turn. The model calls
        // read_skill for full instructions, then read_skill_resource as needed.
        // Keeping this in the per-turn user message preserves the stable system
        // prefix (and therefore Ollama's KV cache) when skills change.
        // 2026-07-24: a skill may belong to ONE sub-agent, and `list_skills`
        // (the tool a specialist calls) honours that. This per-turn preamble
        // goes to the MAIN assistant, so it must honour it too — otherwise a
        // skill scoped to, say, `media.transcribe` was still listed to (and
        // openable by) the main assistant on every single turn. An unowned
        // skill is GENERAL and stays visible to everyone.
        let available_skills: Vec<_> = db::list_skills(conn, true)?
            .into_iter()
            .filter(|s| s.agent.trim().is_empty())
            .collect();
        let explicit_skill = match explicit_skill_name {
            Some(name) => {
                let skill = db::find_skill(conn, name)?
                    .ok_or_else(|| format!("No skill named \"{name}\" exists."))?;
                if !skill.enabled {
                    return Err(format!(
                        "The skill \"{name}\" is still a disabled draft. Review and enable it in Skills before using /{name}."
                    ));
                }
                let resources = db::list_skill_resources(conn, &skill.id)?;
                Some((skill, resources))
            }
            None => None,
        };

        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, chat_id, AGENT_HISTORY_MESSAGES as i64)?;
            rows.reverse();
            rows
        };

        let (context_chunks, context_fallback) =
            retrieve_context(conn, effective_question, question_embedding)?;
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
                attached_notes.push(format!("[attached file: {name}]\n{text}"));
                sources.push(name);
            }
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
            "You are the private AI assistant inside \"Arcelle\", a local encrypted \
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
             asked what is on the pad.\n\n\
             Scripts: a .py or .js file in the room can be Run with one click and scheduled. \
             When you create or edit a runnable Python script that imports third-party packages, \
             you MUST declare them inline so they install automatically on Run — the user should \
             never have to pip install anything. Put a PEP-723 block at the very top:\n    \
             # /// script\n    # dependencies = [\"pandas\", \"yfinance\"]\n    # ///\n\
             (a bare `# dependencies = [\"pkg\", ...]` line also works). List every third-party \
             import; the standard library needs no declaration. Do not tell the user to run pip \
             or create a venv — declaring the dependencies is how the install happens. \
             When a script reads or writes room files, refer to each by its EXACT room file name \
             (e.g. open(\"ETF Tracker.csv\")); you MAY also list them under \
             `# room-inputs:` / `# room-outputs:` for clarity, but you do not have to — the runner \
             auto-copies any room file whose name appears in the script and saves back any it \
             modifies in place (every write is versioned and undoable).",
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
                 Their tools are available dynamically through search_mcp_tools and \
                 run_mcp_tool and can reach the internet or other apps. Search before \
                 choosing a connector tool, then pass the returned exact tool id and \
                 arguments to run_mcp_tool. IMPORTANT: when a question needs current or \
                 outside information (weather, news, prices, events) and no built-in tool \
                 covers it, you MUST search and use a connected tool instead of answering \
                 that you lack real-time data. Mention when you did.",
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

        // D11: the room's chosen persona (room_role) rides just before the
        // response-style + custom instructions. Byte-stable (a constant chosen by
        // a setting), so the ADD-22 KV-cache invariant holds; the plain "default"
        // role has empty instructions and injects nothing.
        if let Some(role_id) = &room_role {
            let instructions = role_instructions(role_id);
            if !instructions.trim().is_empty() {
                system.push_str("\n\n");
                system.push_str(instructions.trim());
            }
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
        let has_history = !history.is_empty();
        // The whole conversation, up to the backstop — NOT a window-derived
        // slice. Measured 2026-07-28: cutting here to 49,152 B cost the model
        // 0.44 of the facts it needed (4/4 paired losses), and the sidecar
        // cannot compress back what was already amputated. See
        // `commands::history_budget_bytes`.
        let history_budget = history_budget_bytes(explicit_model.as_deref().unwrap_or(""));
        for (role, content) in compact_history(history, history_budget) {
            chat_messages.push(ollama::ChatMessage::new(&role, content));
        }

        let mut user_content = String::new();
        if !available_skills.is_empty() {
            user_content.push_str(
                "Available Agent Skills (specialized instructions). If one clearly matches the question, call read_skill before doing the work:\n",
            );
            for skill in &available_skills {
                user_content.push_str(&format!("- {}: {}\n", skill.name, skill.description));
            }
            user_content.push('\n');
        }
        if let Some((skill, resources)) = &explicit_skill {
            let tree = if resources.is_empty() {
                "(no bundled resources)".to_string()
            } else {
                resources
                    .iter()
                    .map(|resource| format!("- {} ({})", resource.path, resource.kind))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let instructions = clamp_bytes(skill.instructions.clone(), 20_000);
            user_content.push_str(&format!(
                "Explicitly selected Agent Skill: /{}\n\
                 Follow this skill for the current request. The slash selection overrides automatic skill choice, but never the user's request or safety/privacy rules. Read listed resources with read_skill_resource when the instructions call for them.\n\
                 Description: {}\n\nSkill instructions:\n{}\n\nBundled resources:\n{}\n\n",
                skill.name, skill.description, instructions, tree
            ));
        }
        if !memories.is_empty() {
            // CHG-7 + ADD-22: budget-fitting, question-relevant memories are
            // injected HERE (the always-new user message) rather than the stable
            // system prompt, preserving KV-cache reuse of the system prefix.
            let chosen = select_memories(&memories, effective_question, MAX_MEMORY_INJECT_CHARS);
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
        // Deterministic anaphora hint (see `is_bare_save_reference`): a 4B model
        // sees its own previous reply in the history yet still asks the user to
        // re-provide it. Conditional wording keeps a rare false positive
        // harmless — the model just double-checks what "that" means.
        if has_history && is_bare_save_reference(question) {
            user_content.push_str(
                "(Note: the user's \"that\"/\"this\" refers to earlier content in this \
                 conversation — usually your own previous reply. Save THAT full text \
                 with create_file or write_file now; do not ask the user to re-provide \
                 content that is already above.)\n\n",
            );
        }
        user_content.push_str(&format!("Question: {effective_question}"));

        chat_messages.push(ollama::ChatMessage {
            role: "user".into(),
            content: user_content,
            images: if images.is_empty() { None } else { Some(images) },
            ..Default::default()
        });

        db::insert_message(conn, chat_id, "user", question, &[], None)?;

        // First question names the session.
        let title_source = if effective_question.is_empty() { question } else { effective_question };
        let mut title: String = title_source.chars().take(48).collect();
        if title_source.chars().count() > 48 {
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

/// A selected external engine is the room's primary agent, so its per-turn
/// bridge always includes the room's enabled MCP connectors. The separate
/// advisor-tools setting applies only to a secondary consulted advisor.
/// Whether one connector call's arguments get masked on the way out.
///
/// Two conditions, both required. A LOCAL connector runs on this Mac, so
/// nothing leaves and there is nothing to mask. `unmask_outbound` is the user's
/// explicit "send remote connectors my real values" — without it, masking
/// rewrites the values the call asks ABOUT, so the call fails and the restore
/// on the way back erases the evidence, leaving the agent able to report only
/// that the connector "would not answer".
///
/// It takes the UNMASKING preference, never the auto-approve one. Those were a
/// single flag until 2026-08-03: wanting the second was the only way to get
/// past the first, so anyone who needed a working lookup silently gave up their
/// consent card too. Auto-approve now decides only whether the card appears.
pub(crate) fn masks_outbound_args(remote: bool, unmask_outbound: bool) -> bool {
    remote && !unmask_outbound
}

/// What to tell the agent when the outbound seam actually rewrote something.
///
/// `None` when nothing matched — an empty result must keep reading as empty,
/// and a note about masking that did not happen would be its own fabrication.
///
/// This is the missing half of the 2026-07-24 finding. Masking was made
/// visible on the consent card, but the card is skipped entirely under "run
/// connector tools without asking", and the restore on the way home puts the
/// real names back into whatever came back — so a lookup that returned nothing
/// BECAUSE it asked about `[Person A]` was indistinguishable from a connector
/// that simply had no answer. The count is all that travels: naming the values
/// here would put the very strings the seam just removed back into the
/// model's context.
pub(crate) fn masked_args_note(server: &str, entities_hidden: usize) -> Option<String> {
    if entities_hidden == 0 {
        return None;
    }
    let n = entities_hidden;
    let plural = if n == 1 { "value" } else { "values" };
    Some(format!(
        "\n\n[This room hid {n} protected {plural} in what it sent, so \"{server}\" was asked \
         about placeholders, not the real text. If the answer above is empty or off-target, \
         that is very likely why — tell the user, and that Connectors → \"Send remote \
         connectors real values\" is what would send the real ones.]"
    ))
}

/// The bridge tier for a cloud CLI selected as the ROOM'S OWN engine.
///
/// Owner decision 2026-07-25 ("claude and codex should be able to do same as
/// local"). Before it, this returned `CloudAdvisor { include_mcp: true }`, so a
/// cloud-CLI room was served no job, workflow, script, studio or transcription
/// tools at all — the Main agent's catalog lost `ask_jobs_agent` entirely and
/// live QA saw it substitute a disabled draft SKILL for a requested workflow.
/// The engine-parity doctrine named only four gaps (dictation, `local_generate`,
/// vision boxes, UI tools); jobs were never one of them.
/// `const` so the engine capability table (`commands::capabilities`) can name
/// this function directly in its declarations instead of restating the variant
/// — the tier a non-local engine is served at then has exactly one definition.
pub(crate) const fn primary_cli_scope() -> crate::room_mcp::ToolScope {
    crate::room_mcp::ToolScope::CloudEngine
}

/// Resolve the cloud CLIs that can act as advisors. `ai_status` normally keeps
/// this cache warm; the fallback probe covers headless/background turns that
/// begin before Settings or the model picker has requested status.
pub(crate) async fn detected_advisors(state: &State<'_, AppState>) -> Vec<String> {
    if let Some(cached) = state.external_cache.lock().unwrap().clone() {
        return cached;
    }
    let found = tauri::async_runtime::spawn_blocking(detect_external_blocking)
        .await
        .unwrap_or_default();
    *state.external_cache.lock().unwrap() = Some(found.clone());
    found
}

/// Phase 2 (unlocked): produce the answer. This is deliberately the single place
/// the answer is generated — a cloud CLI (`claude -p`/`codex`) for an external
/// engine, otherwise the local Python/LangGraph sidecar (the SOLE local engine;
/// no native fallback). Everything here awaits, so no room lock may be held
/// across it.
///
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
    advisors_on: bool,
    advisor_tools_on: bool,
    cancel: Arc<AtomicBool>,
    _injected_rowids: &HashSet<i64>,
    // PRIV-1: "send real details this once" — the user confirmed sharing real
    // values for THIS turn only.
    privacy_bypass: bool,
    // Owner replacement #4: the run/chat every event of this turn is stamped with.
    turn: &crate::turn::TurnId,
) -> Result<String, String> {
    // PRIV-1: an explicit bypass is loud — the transcript records that real
    // details were shared this once, whichever engine answers.
    if privacy_bypass && crate::commands::active_policy().is_some() {
        turn.emit(window, "ask-privacy", serde_json::json!({ "bypassed": true }));
    }
    let advisors = if advisors_on {
        detected_advisors(state).await
    } else {
        Vec::new()
    };
    // ENGINE PARITY (2026-07-24): there is ONE chat path. Every engine —
    // local Ollama, `:cloud`, an API provider, and the cloud CLIs (Claude
    // Code / Codex) — answers through the Python agent hub, so the main
    // agent, the domain agents and their roster events are the same code for
    // all of them. A CLI engine used to short-circuit to `run_external` here
    // and drive the room itself as one opaque agent: no plan, no sub-agents,
    // nothing for the agent strip to show. The CLI is now a ChatModel behind
    // that hub (`external_llm.ExternalChatModel`), and `run_via_sidecar`
    // narrows the bridge scope for it so a cloud engine still never receives
    // the UI/screen-driving tools.
    let run = {
        // CHG-5: the cloud engines say so out loud, before anything is sent.
        // The old direct CLI path emitted this; the transparency belongs to the
        // engine choice, not to which code path answers.
        if is_cli_engine(model) {
            turn.step(window, "Asking your cloud AI (content leaves this Mac)");
        }
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
            // Moved, not cloned: `chat_messages` is owned here and never read
            // again, and it carries the whole conversation, the quoted file
            // text and any base64 photos — megabytes duplicated per ask.
            chat_messages,
            temperature,
            effects,
            web_enabled,
            cancel.clone(),
            false, // visible chat turn — emit the ask-* stream events
            privacy_bypass,
            advisors,
            advisor_tools_on,
            Some(turn),
        )
        .await
        {
            // The graph floors an empty answer to DONE_TEXT before it reaches the
            // wire, so `Done("")` here does not mean "the model said nothing" — it
            // means the answer was LOST in transit. Persisting it produced a
            // zero-byte assistant message that read as a finished turn (live QA
            // 2026-07-30). Return `Ok` rather than `Err`, for the same reason the
            // `Failed` arm below does: a tool may already have committed a
            // side-effect, and `ask`'s `?` would discard the merged effects.
            // "nothing was written" was a CLAIM, not a check — and it was false
            // exactly when it mattered. Live QA 2026-07-30 (v0.13.0): a read-only
            // question dispatched two File agents, one edited a source file, the
            // user pressed Stop, and this arm told them nothing had been written
            // while an Undo-edit button sat on screen proving otherwise. That is
            // the precise failure this app's anti-fabrication doctrine exists to
            // prevent, committed by the app's own prose rather than by a model.
            //
            // `effects.wrote` is the deterministic ground truth CHG-10 already
            // maintains for the fabrication gate (set only when a write tool
            // SUCCEEDED), and `run_via_sidecar` merges the bridge's effects into
            // it on every outcome — including this one. So the honest sentence is
            // available; it just was not being read. Same rule as the `Failed`
            // arm below, which has always said "any change shown here was already
            // applied".
            //
            // The third case is the one the owner retested on 2026-08-03: the
            // turn died, "so nothing was written. Please try again." went into
            // the transcript, and a background job from that same turn was still
            // running in the Sidebar. Retrying on that instruction starts the
            // work a second time. `background_work_live` reads the jobs table
            // rather than guessing, and the notice points at it.
            SidecarOutcome::Done(text) if text.trim().is_empty() => Ok(if effects.wrote {
                LOST_REPLY_AFTER_WRITE.to_string()
            } else if background_work_live(state) {
                LOST_REPLY_WITH_JOB.to_string()
            } else {
                LOST_REPLY_CLEAN.to_string()
            }),
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
                // Carry the REASON to the user, not just to a hidden log. The
                // app writes no log of its own, so "the agent sidecar could not
                // start" was, in practice, the whole diagnosis available for a
                // broken Python install, a busy port and a crash on import
                // alike (`sidecar_lifecycle::unavailable` now supplies which).
                eprintln!("agent sidecar unavailable: {reason}");
                Err(format!(
                    "AI engine unavailable — the agent sidecar could not start ({reason})."
                ))
            }
            SidecarOutcome::EngineError(error) => {
                eprintln!("agent model/provider failed: {error}");
                Err(format!("AI provider error — {error}"))
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
            kind: None,
        }),
    }
}

/// ADD-23: the message-row `effects` JSON for this turn's tool effects —
/// `{"boxes": ..?, "annotation": ..?}` — or None when neither fired, so the
/// column stays NULL for plain answers.
pub(crate) fn effects_json(effects: &ToolEffects) -> Option<serde_json::Value> {
    if effects.boxes.is_none()
        && effects.annotation.is_none()
        && effects.edit_outcomes.is_empty()
        && effects.token_usage.is_none()
        && effects.agent_plan.is_none()
    {
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
    // Token-budget bar: this turn's snapshot, same shape as the live
    // `ask-token-usage` event (see sidecar.rs / token_usage.rs).
    if let Some(u) = &effects.token_usage {
        map.insert("usage".into(), u.clone());
    }
    // Agent visibility: the roster that handled this turn, so the transcript
    // keeps showing WHO after the live strip is gone.
    if let Some(p) = &effects.agent_plan {
        map.insert("agents".into(), p.clone());
    }
    Some(serde_json::Value::Object(map))
}

/// One specialist the composer's `*` menu may offer.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct Specialist {
    /// The short key the user types after `*` ("browse").
    pub key: String,
    /// The `ask_*_agent` tool this specialist's domain hangs under.
    pub tool: String,
    /// The WORKER this tag runs (`chat.browse`). One row per agent, not per
    /// domain: the Browser agent is a sibling of the Web agent under
    /// `ask_web_agent` because a 4B picks reliably among no more than six
    /// domain tools — a limit on a MODEL's choice, which is no reason to hide
    /// an agent from a person reading a dropdown (owner report 2026-08-03).
    pub agent: String,
    /// The agent's own label ("Browser agent") — the same words the agent
    /// diagram shows for the node that then lights up.
    pub label: String,
    /// One plain-words noun phrase: what this specialist's area is.
    pub area: String,
    /// The full catalog sentence — what it can actually be asked for.
    pub description: String,
}

/// The specialists THIS room can dispatch to, for the composer's `*` menu
/// (owner feature, 2026-08-03: "ask the specialist agent to run by tag").
///
/// Derived, never listed. The host contributes the two facts only it knows —
/// the room's web setting and the tool names its engine's bridge tier would
/// serve, lanes applied — and the sidecar's own registry turns those into the
/// AGENTS a turn could actually reach (`agents.specialist_roster`, which reads
/// `specialist_workers`: the same mapping a tagged turn is routed by). So a
/// specialist can never appear in this menu and be unreachable when picked,
/// nor be reachable and missing from it.
///
/// Errors rather than returning an empty list when the sidecar cannot be
/// reached: "this room has no specialists" and "we could not find out" are
/// different answers, and the menu says which one it is.
#[tauri::command]
pub async fn list_specialists(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Specialist>, String> {
    let (web_enabled, model) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        (web_access_enabled(&room.conn), model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let model = model.unwrap_or_else(|| best_default(&models));
    let served = crate::room_mcp::room_tool_names(
        &app,
        web_enabled,
        open_room_web_lanes(&state),
        crate::sidecar::bridge_scope_for(&model),
    );
    let body = serde_json::json!({ "web_enabled": web_enabled, "served_names": served });
    let value = crate::sidecar::sidecar_json("/agents", &body)
        .await
        .map_err(|e| e.sentinel(None))?;
    serde_json::from_value(value["agents"].clone())
        .map_err(|e| format!("the specialist list could not be read: {e}"))
}

/// ADD-7: stop a running answer. Sets its cancel flag; a no-op for an unknown
/// id (the ask may have already finished).
///
/// Owner replacement #3: the flag is the root of a TREE, so this stops the
/// studio build / background job / file pass the run started as well — and
/// RETURNS what it stopped. Stop used to report nothing at all, which left the
/// user to infer from a stalled screen whether anything had happened; the
/// report is the only place the app can say "and the flashcards build it had
/// started" truthfully, because only the tree knows.
#[tauri::command]
pub fn cancel_ask(state: State<'_, AppState>, ask_id: String) -> crate::cancel::StopReport {
    // Not an error when unknown — the ask may have already finished. But the two
    // cases look identical from the UI, so the report and the host log both
    // record which it was: a Stop that stopped nothing is the failure mode worth
    // seeing.
    let report = crate::cancel::cancel_id(state.inner(), &ask_id);
    crate::obs::cancel_requested(&ask_id, report.known);
    crate::obs::cancel_subtree(&ask_id, report.stopped.len());
    report
}

/// Token-budget bar / context handoff: summarize the conversation the model
/// currently sees (already truncated at any earlier handoff marker, per
/// `db::recent_messages`) and insert a fresh marker with the recap. Every
/// future turn in this chat then starts its context from that recap — the
/// entire mechanism is `db::recent_messages`'s truncation point, not any
/// separate "compacted" state.
#[tauri::command]
pub async fn handoff_chat(state: State<'_, AppState>, chat_id: String) -> Result<Message, String> {
    // Phase 1 (locked): read what the model would currently see.
    let (explicit_model, temperature, mut history) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open")?;
        let explicit_model = model_setting(&room.conn);
        let temperature: Option<f64> = db::get_setting(&room.conn, "temperature")
            .and_then(|s| s.parse().ok());
        let history = db::recent_messages(&room.conn, &chat_id, MAX_HISTORY_MESSAGES as i64)?;
        (explicit_model, temperature, history)
    };
    if history.is_empty() {
        return Err("Nothing to summarize yet.".into());
    }
    // `recent_messages` is newest-first; the summarizer wants chronological
    // order, same as `ask`'s own history read.
    history.reverse();

    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit_model.unwrap_or_else(|| best_default(&models));

    // The engine's own window, read once and used twice (the budget below and
    // the bar's snapshot at the end). `None` means "not published", and the
    // 128k floor for that case stays here rather than inside the record — a
    // made-up number does not belong in something the app calls a fact.
    let max_context = crate::commands::capabilities_for(&model)
        .await
        .context_window
        .unwrap_or(128_000);

    // FIT THE CONVERSATION TO THE ENGINE BEFORE SENDING IT.
    //
    // This is the one history read with no compaction behind it: every row is
    // flattened into a single prompt for the one-shot `handoff_summary`
    // gateway. Local Ollama still fits that to its window itself, but a
    // `:cloud` model, an OpenRouter provider and a cloud CLI trim NOTHING — so
    // once the row bound went from 12 to 200 a long technical chat could
    // overflow the window and come back as an engine error or an empty summary,
    // precisely when the user pressed the button.
    let total = history.len();
    let history = compact_history(history, handoff_budget_bytes(max_context));
    let messages: Vec<ollama::ChatMessage> = history
        .into_iter()
        .map(|(role, content)| ollama::ChatMessage::new(&role, content))
        .collect();
    // What the recap could NOT cover has to be said, because the marker is a
    // hard cut-off: `db::recent_messages` starts every later turn here, so
    // anything dropped is gone from the model's memory. The transcript above
    // the marker still shows it to the user — this is what tells them to look.
    let uncovered = total.saturating_sub(messages.len());

    // Phase 2 (unlocked): the summarization call — any engine, same as `ask`.
    //
    // The recap BECOMES the model's entire memory of this conversation, because
    // `db::recent_messages` truncates at the marker. Nothing used to check it
    // was real text, so a model that returned nothing — or only a `<think>`
    // span, which `handoff_summary` now strips — silently wiped the context and
    // left a marker with no delete button. An empty recap is a failed handoff,
    // not a handoff.
    let summary = ollama::handoff_summary(&model, messages, temperature).await?;
    if summary.trim().is_empty() {
        return Err(
            "The model returned an empty summary, so the conversation was left \
             untouched. Try again, or switch models in Settings → Model."
                .into(),
        );
    }
    let summary = if uncovered > 0 {
        // No claim about WHY — only what was and was not covered. (Compaction
        // drops whole older turns to fit the window, and also skips
        // viewer-markup payloads, which are UI data rather than conversation.)
        format!(
            "{summary}\n\n_This recap covers the most recent {} of {total} messages in this \
             chat. The earlier ones are still above this marker in the transcript._",
            total - uncovered,
        )
    } else {
        summary
    };

    // Token-budget bar: no LLM "ask" turn happens as part of a handoff, so no
    // `ask-token-usage` event fires on its own — build a snapshot for the new,
    // much smaller post-handoff context now, so the bar can update
    // immediately rather than waiting for a turn that hasn't happened yet.
    // Necessarily an estimate (no real usage exists until the next real turn).
    // `max_context` is the same window the budget above was sized from — read
    // once, at the top, from the engine's capability record.
    let usage_value = crate::token_usage::handoff_usage_value(&summary, max_context);

    // Phase 3 (locked): persist the marker, with that snapshot as its effects.
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("The room closed while summarizing.")?;
    db::insert_handoff_message(&room.conn, &chat_id, &summary, Some(&usage_value))
}

/// The sub-agent ids a skill may be scoped to — the sidecar's worker registry
/// (`agents.py` REGISTRY, every spec with `main=False`), in its order.
///
/// A skill saved against an id no-one has is invisible forever: it is never
/// offered to any specialist and never surfaces to the user. That made a
/// one-character typo an unrecoverable silent failure, so this is now BOTH the
/// `save_skill` enum the model picks from and the value `save_skill` validates
/// against. `sidecar/tests/test_skill_agent_parity.py` pins it to the registry
/// across the language boundary.
pub(crate) const SKILL_AGENT_IDS: &[&str] = &[
    "files.read",
    "scripts.run",
    "chat.web",
    "chat.browse",
    "app.ui",
    "jobs.run",
    "jobs.workflows",
    "skills.use",
    "skills.author",
    "connectors.admin",
    "connectors.use",
    "media.transcribe",
    "media.video",
    "creator.studio",
];

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
    "update_memory",
    "delete_memory",
    "list_skills",
    "read_skill",
    "read_skill_resource",
    "save_skill",
    "write_skill_resource",
    "delete_skill",
    "delete_skill_resource",
    "run_skill_script",
    "list_mcps",
    "read_mcp",
    "save_mcp",
    "delete_mcp",
    "search_mcp_tools",
    "run_mcp_tool",
    "web_search",
    "fetch_page",
    "ui_snapshot",
    "ui_act",
    "view_screenshot",
    "view_media_frame",
    // BROWSE-1: the private browser's tools. Reserved here (like the UI tools)
    // so a connected MCP server can never shadow a `browse_*` arm.
    "browse_open",
    "browse_read",
    "browse_find",
    "browse_snapshot",
    "browse_do",
    "browse_look",
    // BROWSE-2: capture the live page into the room (browse box)…
    "browse_save",
    // …and the download/save tools (web box + browse box).
    "save_link",
    "download_url",
    "download_media",
    "start_file_pass",
    "job_status",
    "list_scripts",
    "run_script",
    "studio_flashcards",
    "studio_mindmap",
    "generate_podcast_script",
    "retranscribe_file",
    "stt_status",
    // Wave 4a (Idea 2): the workflow authoring tools (LocalEngine/ExternalAgent
    // scopes only, never tools_catalog). Reserved so an MCP route can't shadow
    // their exec_tool arms.
    "list_workflows",
    "save_workflow",
    "update_workflow",
    "delete_workflow",
    "run_workflow",
    "test_workflow",
    // Reserved even though they are never in the room bridge's own catalog:
    // an MCP route sanitizing to one of these names would shadow the built-in
    // exec_tool arm and skip the SEC-1b consent gate (e.g. server "consult" +
    // tool "advisor" reaching the cloud-CLI path). Colliding routes rename to
    // `<name>_2` and stay on the gated fallback.
    "local_generate",
    "consult_advisor",
];

/// The Scripts lane (2026-07-24). Same trust class as the job tools: running a
/// script is local compute the user already reaches with one click, and
/// `run_script` keeps its own fingerprint consent gate underneath — a script
/// the agent just wrote is an unapproved fingerprint, so it cannot self-execute
/// new code without the user seeing the card.
pub(crate) fn script_tools_specs() -> Vec<serde_json::Value> {
    serde_json::json!([
        {"type": "function", "function": {"name": "list_scripts",
            "description": "List the runnable .py/.js scripts in this room, with their declared dependencies and whether the user has already approved each one to run.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {"name": "run_script",
            "description": "Run one of this room's scripts now. The user is asked to approve any script whose exact contents they have not approved before — including one you just wrote. Output and any files it writes appear in the Scripts view.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "The script's file name, e.g. etf-report.py"}},
                "required": ["name"]}}}
    ])
    .as_array()
    .cloned()
    .unwrap_or_default()
}

/// The Studio + transcription lanes (2026-07-24). Both product areas had an
/// AgentSpec declared with `available=False` — the tree documented the target
/// shape while the bridge served nothing, so the Main agent could not reach
/// either. These are the tools that are actually AGENT-shaped.
///
/// Deliberately NOT exposed: `transcribe_audio` takes base64 audio bytes from
/// the recorder UI, which an agent has no way to supply, and `rec_retranscribe`
/// drives a live recording session. Re-running transcription on a room FILE is
/// the operation an agent can meaningfully perform, so that is the one offered.
pub(crate) fn studio_tools_specs() -> Vec<serde_json::Value> {
    serde_json::json!([
        {"type": "function", "function": {"name": "studio_flashcards",
            "description": "Build question/answer flashcards from this room's material and save them as a new file. Say what to focus on in instructions.",
            "parameters": {"type": "object", "properties": {
                "instructions": {"type": "string", "description": "What to cover, in the user's words"},
                "refs": {"type": "array", "items": {"type": "string"}, "description": "Optional file names to build from; omit to use the whole room"}}}}},
        {"type": "function", "function": {"name": "studio_mindmap",
            "description": "Build a structured mind map from this room's material and save it as a new file.",
            "parameters": {"type": "object", "properties": {
                "instructions": {"type": "string", "description": "What to map, in the user's words"},
                "refs": {"type": "array", "items": {"type": "string"}, "description": "Optional file names to build from; omit to use the whole room"}}}}},
        {"type": "function", "function": {"name": "generate_podcast_script",
            "description": "Write a two-voice podcast script from this room's material and save it as a new file.",
            "parameters": {"type": "object", "properties": {
                "instructions": {"type": "string", "description": "What the episode should cover"},
                "refs": {"type": "array", "items": {"type": "string"}, "description": "Optional file names to build from; omit to use the whole room"}}}}}
    ])
    .as_array().cloned().unwrap_or_default()
}

/// On-device transcription, for a room file that already exists.
pub(crate) fn transcribe_tools_specs() -> Vec<serde_json::Value> {
    serde_json::json!([
        {"type": "function", "function": {"name": "stt_status",
            "description": "Whether the on-device speech-to-text model is installed and ready. Check this before promising a transcription.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {"name": "retranscribe_file",
            "description": "Transcribe a room audio/video file again on this computer — use when a transcript is missing, in the wrong language, or poor. Nothing is uploaded.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "The file's name in this room"}},
                "required": ["name"]}}}
    ])
    .as_array().cloned().unwrap_or_default()
}

/// Keyword router for WRITE intent. Since 2026-07-23 the write tools are
/// ALWAYS in the catalog (the base system prompt teaches them by name every
/// turn, so withholding the schemas made the prompt and the catalog contradict
/// each other — "I can't save files"); this predicate now feeds only the
/// cosmetic lane label ("Working on your files"). Hebrew hints included: the
/// matchers are plain substring tests, so a Hebrew ask must find Hebrew stems.
pub(crate) fn wants_write_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
        "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
        "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
        "translate", "highlight", "mark ", "annotate", "draft", "generate",
        "move ", "rename", "organize", "organise", "put ", "folder", "sort ", "tidy",
        // Hebrew (substring matchers see no word boundaries, so stems suffice):
        "ערוך", "עריכה", "שנה", "תקן", "עדכן", "כתוב", "צור ", "שמור", "שמרי",
        "מחק", "הוסף", "תרגם", "סמן", "זכור", "תזכור", "רשום", "העבר", "תיקיה",
        "תיקייה", "טיוטה", "קובץ חדש",
    ];
    HINTS.iter().any(|h| q.contains(h))
}

/// 2026-07-23 live QA: a small model WITH the write tools in hand still fumbled
/// "save that as a new file called Summary" — it asked the user for content
/// instead of resolving "that" to its own previous reply (the #1 measured
/// small-model multi-turn failure: misassuming conversation state; see
/// pm-request/small-model-agent-reliability-2026-07-23.md). Detects a short
/// save/record turn whose object is a bare reference ("that", "this", "it",
/// "זה") rather than inline content, so the ask path can inject a
/// deterministic anaphora hint into the always-new user message (NEVER the
/// byte-stable system prompt — ADD-22 KV-cache).
pub(crate) fn is_bare_save_reference(question: &str) -> bool {
    let q = question.to_lowercase();
    // Long turns carry their own content — the reference is not bare.
    if q.chars().count() > 160 {
        return false;
    }
    const VERBS: &[&str] = &[
        "save", "keep ", "record", "write that", "write this", "write it",
        "note that", "note this", "jot", "שמור", "שמרי", "תשמור", "רשום", "רשמי",
    ];
    const REFERENTS: &[&str] = &[
        "that", "this", "it ", " it", "the above", "your answer", "your reply",
        "your summary", "זה", "זאת", "את זה", "התשובה",
    ];
    VERBS.iter().any(|v| q.contains(v)) && REFERENTS.iter().any(|r| q.contains(r))
}

/// The markers that introduce an explicit file name in a save turn.
const NAME_MARKERS: &[&str] = &["called ", "named ", "titled ", "as file ", "בשם "];

/// Case-insensitive substring search returning `(start, end)` BYTE offsets into
/// the ORIGINAL `haystack`.
///
/// `haystack.to_lowercase().find(needle)` is the obvious version and it is
/// subtly wrong: lowercasing is not length-preserving (`İ` is one char and two
/// after `to_lowercase`), so an index found in the lowered copy can point at a
/// different — or invalid — place in the original. Comparing slice by slice
/// keeps every offset native to the string we will actually cut.
fn find_ci(haystack: &str, needle_lower: &str) -> Option<(usize, usize)> {
    let n = needle_lower.chars().count();
    if n == 0 {
        return None;
    }
    let bounds: Vec<usize> = haystack
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(haystack.len()))
        .collect();
    for k in 0..bounds.len().saturating_sub(n) {
        let (start, end) = (bounds[k], bounds[k + n]);
        if haystack[start..end].to_lowercase() == needle_lower {
            return Some((start, end));
        }
    }
    None
}

/// Live-QA round 2 (2026-07-23): the anaphora HINT was not enough — the 4B
/// "saved" by fabricating a fresh document in chat and never calling
/// create_file. For a deterministic intent the model gets no vote: a PURE
/// save-that turn is executed by code — the same path as the Save-to-room
/// button.
///
/// "Pure" is decided by an ALLOW-LIST, not by a list of transform verbs. A
/// blacklist has to enumerate every way a turn could ask for more than a
/// verbatim copy, and it cannot: "save this as a PDF", "save this in a table",
/// "save that with the headings fixed" all named no transform verb, so the
/// bypass fired, wrote the previous reply unchanged, and reported success while
/// silently dropping what the user actually asked for.
///
/// So: strip an explicit "…called X" name, then require every remaining word to
/// be plain save vocabulary. One unrecognised word means the turn is asking for
/// something, and it goes to the model — the pre-existing behaviour, and the
/// safe direction to fail in.
pub(crate) fn is_pure_save_reference(question: &str) -> bool {
    if !is_bare_save_reference(question) {
        return false;
    }
    // The requested NAME is arbitrary user text ("called Q3 revenue notes") and
    // must not be scanned for vocabulary.
    let mut body = question.trim();
    for marker in NAME_MARKERS {
        if let Some((start, _)) = find_ci(body, marker) {
            body = &body[..start];
        }
    }
    // Save verbs, referents, and the filler that legitimately joins them.
    // Deliberately small: growing it is a product decision, and each addition
    // is one more turn the model never sees.
    const ALLOWED: &[&str] = &[
        // verbs
        "save", "saves", "saved", "keep", "store", "record", "write", "jot",
        "note", "put", "add",
        // referents
        "that", "this", "it", "above", "answer", "reply", "response", "message",
        "text", "output", "last", "previous", "your",
        // filler
        "a", "an", "the", "as", "to", "in", "into", "on", "of", "for", "my",
        "our", "please", "down", "here", "just", "new", "file", "files",
        "document", "doc", "note's", "notes", "room", "library", "somewhere",
        // Hebrew equivalents
        "שמור", "שמרי", "תשמור", "רשום", "רשמי", "זה", "זאת", "את", "קובץ",
        "כקובץ", "חדש", "בחדר", "התשובה", "בבקשה", "לקובץ", "אותו",
    ];
    body.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':'))
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .all(|w| ALLOWED.contains(&w.as_str()))
}

/// "…called Summary" / "…named Q3 notes" / "…בשם סיכום" → the requested file
/// name, if the save turn carries one.
pub(crate) fn requested_file_name(question: &str) -> Option<String> {
    let q = question.trim();
    for marker in NAME_MARKERS {
        // `find_ci` returns offsets into `q` itself, so the name keeps its own
        // casing and the cut is always on a real char boundary.
        if let Some((_, end)) = find_ci(q, marker) {
            let name = q[end..]
                .trim()
                .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '„'))
                .trim_end_matches(['.', '!', '?'])
                .trim();
            if !name.is_empty() && name.chars().count() <= 80 {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Skill management is a separate, on-demand lane. Reading or changing a skill
/// is uncommon enough that its six CRUD/resource tools should not burden a
/// normal document question, but the word itself is an unambiguous request to
/// expose them.
pub(crate) fn wants_skill_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &["skill", "agent instruction", "מיומנות", "סקיל"];
    HINTS.iter().any(|hint| q.contains(hint))
}

/// Connector management is deliberately local-agent-only and on demand. A
/// normal question about a document must never spend context on the schemas
/// that can configure programs or remote services.
pub(crate) fn wants_mcp_management_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "mcp",
        "connector",
        "connectors",
        "integration",
        "integrations",
        "מחבר",
        "מחברים",
        "אינטגרצ",
    ];
    HINTS.iter().any(|hint| q.contains(hint))
}

/// "open the Room Map" / "switch to the Detail tab" / "generate flashcards"
/// matched none of the base UI hints, so ui_act was never offered and the agent
/// couldn't drive the app at all. App surfaces and navigation verbs:
const APP_NAVIGATION_VERBS: &[&str] = &[
    "open ", "show me", "go to", "switch", "close ", "map", "panel", "tab",
    "studio", "flashcard", "mind map", "mindmap", "podcast", "front page",
    "dashboard", "play", "pause", "image", "photo", "picture",
    // Hebrew navigation/operation verbs and surfaces:
    "לחץ", "לחצי", "פתח", "פתחי", "הצג", "הציגי", "מסך", "צילום מסך", "גלול",
    "כפתור", "סרטון", "וידאו", "תמונה", "סגור", "עבור אל", "תפריט", "לוח",
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
        // Hebrew whole-file / automation intents:
        "כל הקובץ", "הקובץ כולו", "כולו", "את כל", "הכל", "הספר", "יסודי", "מקיף",
        "לעומק", "ברקע", "משימת רקע", "תהליך", "אוטומצ", "אוטומט", "תזמן", "מתוזמן",
        "כל בוקר", "כל יום", "כל שבוע", "פרק אחר פרק", "שורה אחר שורה",
    ];
    HINTS.iter().any(|h| q.contains(h))
}

/// ADD-32: the whole-file pass tool specs. Injected by the sidecar `/run` loop
/// via the room MCP bridge's LocalEngine scope (never via
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
            "description": "Report the progress of background jobs (whole-file passes, room summaries): what is running, paused, finished or failed, and how far along. Each listed job shows a short id in brackets; pass job_id (that short id, or more of it) to see just one job in full detail.",
            "parameters": {"type": "object", "properties": {
                "job_id": {"type": "string", "description": "A job's short id (shown in brackets by a previous job_status call) to see just that one job"}}}}}),
    ]
}

/// Local-only connector administration. The agent can inspect/create/update/
/// remove connector records, but `save_mcp` always leaves a changed connector
/// disabled. Starting a program or reaching a new remote endpoint remains an
/// explicit human approval on the Connectors page.
pub(crate) fn mcp_management_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "list_mcps",
            "description": "List the room's MCP connectors with their enabled state, transport, and live status. Use this to inspect or manage connectors.",
            "parameters": {"type": "object", "properties": {}}}}),
        serde_json::json!({"type": "function", "function": {"name": "read_mcp",
            "description": "Read one connector's configuration for editing. Secret header, environment, and OAuth values are redacted and never shown to the agent.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Connector name"}},
                "required": ["name"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "save_mcp",
            "description": "Create or update one MCP connector configuration. Supply a name plus a standard MCP server config object (command/args for local, or type:url for remote). Do not include headers, env, tokens, or credentials: those stay in Connectors. Every changed connector is saved DISABLED, so the user reviews it and explicitly enables/approves it before anything runs or reaches the network.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Unique connector name (letters, digits, dot, dash, underscore)"},
                "config": {"type": "object", "description": "MCP server configuration, without secrets"}},
                "required": ["name", "config"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "delete_mcp",
            "description": "Remove one MCP connector from this room, including its saved OAuth token. Use only when the user explicitly asks to remove that connector.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Connector name"}},
                "required": ["name"]}}}),
    ]
}

/// The top-level model's optional cloud-advisor tool. The enum is constructed
/// from CLIs actually installed on this Mac, so the model cannot select a
/// provider that cannot run. This spec is attached to a per-turn bridge only;
/// a consulted advisor's own bridge never receives it.
///
/// `None` when no RECOGNISED advisor is installed (2026-07-28). The caller
/// already skips an empty `advisors`, but `advisors` carrying only ids this
/// function does not map — the day a third CLI is added — produced
/// `"enum": []`: a parameter no value can satisfy, on a tool still advertised
/// as callable. Serving nothing is the honest shape.
pub(crate) fn consult_advisor_spec(advisors: &[String]) -> Option<serde_json::Value> {
    let mut names: Vec<&str> = Vec::new();
    if advisors.iter().any(|item| item == "claude-cli") {
        names.push("claude");
    }
    if advisors.iter().any(|item| item == "codex-cli") {
        names.push("codex");
    }
    if names.is_empty() {
        return None;
    }
    Some(serde_json::json!({"type": "function", "function": {
        "name": "consult_advisor",
        "description": "Delegate ONE hard, self-contained subtask to an installed cloud AI advisor (Claude or Codex). It is slow, may cost money, and the question leaves this Mac through the user's cloud account, so use it only when a second model would materially improve the answer. Put the full task and all necessary context in `question`. When advisor room tools are enabled, Claude may also inspect the room through its restricted bridge. Returns the advisor's written answer for use in the final response.",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string", "description": "Complete, self-contained task with all context the advisor needs."},
            "advisor": {"type": "string", "enum": names, "description": "Use codex for coding-heavy work; use claude otherwise."}
        }, "required": ["question"]}
    }}))
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
            "temperature": {"type": "number"}},
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
        Some(m) if runs_on_this_mac(&m) => m,
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
            "description": "Create a new note/document file saved into the room. For a document without a specific format, write the content as simple HTML body markup (<h2>, <p>, <ul>, <table>) and the app saves it as an .html page. Only use another extension (.md, .csv, .txt) if the user asked for it. HTML opens in a network-blocked sandbox, so any page you write — especially a dashboard or anything with charts — MUST be fully self-contained: inline ALL CSS and JavaScript, embed the data as literals in the page (never fetch()/XHR at view time — it is blocked), and draw charts as inline SVG (preferred) or with a charting library whose full source you paste inline. NEVER reference a CDN or any external <script src>/<link href>/remote image — it silently won't load and the chart renders blank. If the data is 'live', snapshot the current numbers into the page.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "edit_file",
            "description": "Change ONE place in ONE file (text, code, notes, csv, html, or docx) by replacing exact text. Copy old_text exactly as it appears — curly quotes/spacing/dashes are matched tolerantly, but old_text must be a UNIQUE spot: a repeat gives an error with the count, then use prefix_context/suffix_context/occurrence/section to narrow it, or all: true to replace every one. On HTML, quote the readable text — it may span inline markup (bold, a link) but never crosses into a different paragraph/heading/list item/table cell. To change several places or files at once, use edit_files. Example: {\"name\": \"notes.md\", \"old_text\": \"Q3 revenue was $4M\", \"new_text\": \"Q3 revenue was $5M\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "old_text": {"type": "string", "description": "Exact text currently in the file"},
                "new_text": {"type": "string", "description": "Text to replace it with"},
                "all": {"type": "boolean", "description": "Replace EVERY occurrence (needs an exact quote; default false)"},
                "prefix_context": {"type": "string", "description": "Exact text right before old_text, to pick one occurrence (exact quote only)"},
                "suffix_context": {"type": "string", "description": "Exact text right after old_text, to pick one occurrence (exact quote only)"},
                "occurrence": {"type": "integer", "description": "Which occurrence to replace, 1-based (exact quote only; not with all)"},
                "section": {"type": "string", "description": "Scope to one heading's section, by its text e.g. \"2026 Outlook\" (html/md only)"},
                "dry_run": {"type": "boolean", "description": "Preview the result without writing anything"}},
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
                        "required": ["name"]}},
                "dry_run": {"type": "boolean", "description": "Preview the results without writing anything"}},
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
        ,{"type": "function", "function": {"name": "update_memory",
            "description": "Correct a memory note that is now wrong or out of date. Identify it by a distinctive phrase from the note itself, not by an id.",
            "parameters": {"type": "object", "properties": {
                "find": {"type": "string", "description": "A distinctive phrase from the note to correct"},
                "content": {"type": "string", "description": "The corrected note, in full"}},
                "required": ["find", "content"]}}}
        ,{"type": "function", "function": {"name": "delete_memory",
            "description": "Forget a memory note the user no longer wants remembered. Identify it by a distinctive phrase from the note itself, not by an id.",
            "parameters": {"type": "object", "properties": {
                "find": {"type": "string", "description": "A distinctive phrase from the note to forget"}},
                "required": ["find"]}}}
        // NOTE: `list_skills` takes an internal `agent` argument that the
        // sidecar injects per worker (`graph.execute_tools` overwrites whatever
        // arrived). It is deliberately NOT advertised: a parameter whose own
        // description says "leave it out" is pure noise in the one schema a
        // small model reads most often, and inviting it to supply a value it is
        // then told to omit is a contradiction. The bridge still accepts the
        // field — this only removes it from the model's view (2026-07-28).
        ,{"type": "function", "function": {"name": "list_skills",
            "description": "List the Agent Skills available to you, including disabled drafts. Call this to see which procedures exist for your domain, then read_skill to load one.",
            "parameters": {"type": "object", "properties": {}}}}
        ,{"type": "function", "function": {"name": "read_skill",
            "description": "Load a skill's full SKILL.md instructions and resource tree. Call this when an available skill's description matches the user's task, before doing the work.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Skill name or id"}},
                "required": ["skill"]}}}
        ,{"type": "function", "function": {"name": "read_skill_resource",
            "description": "Read one text file from a loaded skill, such as references/policy.md or scripts/process.py. Use the relative path listed by read_skill.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Skill name or id"},
                "path": {"type": "string", "description": "Relative resource path"}},
                "required": ["skill", "path"]}}}
        ,{"type": "function", "function": {"name": "save_skill",
            "description": "Create or update a portable Agent Skill. Saves it DISABLED as a draft for human review. Put all trigger conditions in description and concise imperative Markdown in instructions; add reusable resources separately with write_skill_resource. When the user wants a skill based on attached room files, pass their file names in source_files: Arcelle snapshots their readable content under references/source-files/ without making the model repeat the documents.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Lowercase hyphenated name, at most 64 characters"},
                "description": {"type": "string", "description": "What the skill does and exactly when to use it"},
                "instructions": {"type": "string", "description": "The SKILL.md Markdown body"},
                "source_files": {"type": "array", "items": {"type": "string"}, "description": "Optional names of attached/readable room files to bundle as portable reference snapshots (maximum 12)"},
                // A real `enum`, not a list buried in prose (2026-07-28). These
                // are dotted ids a small model reliably fumbles ("file.read"),
                // and the codebase already uses enums where the value set is
                // closed (add_memory.category, ask_agents.agent). Same list
                // validates the call — see SKILL_AGENT_IDS.
                "agent": {"type": "string", "enum": SKILL_AGENT_IDS, "description": "Optional: the sub-agent this procedure belongs to, so only that specialist is offered it — files.read (room files), scripts.run (this room's scripts), chat.web (internet search/fetch), chat.browse (driving web pages in the private browser), app.ui (this app's interface), jobs.run (whole-file passes), jobs.workflows (automation), skills.use (running skills), skills.author (writing skills), connectors.use (connected services), connectors.admin (connector setup), media.transcribe (transcripts), media.video (watching room videos), creator.studio (flashcards, mind maps, podcast scripts). Omit for a skill any agent may use."}},
                "required": ["name", "description", "instructions"]}}}
        ,{"type": "function", "function": {"name": "write_skill_resource",
            "description": "Add or replace a text resource in a skill draft under scripts/, references/, assets/, agents/, or another relative folder. The skill is disabled again for review.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Skill name or id"},
                "path": {"type": "string", "description": "Relative path, e.g. references/schema.md"},
                "content": {"type": "string"}},
                "required": ["skill", "path", "content"]}}}
        ,{"type": "function", "function": {"name": "delete_skill_resource",
            "description": "Delete one bundled resource from a skill. Use only when the user explicitly asks to remove that resource.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Skill name or id"},
                "path": {"type": "string", "description": "Relative resource path"}},
                "required": ["skill", "path"]}}}
        ,{"type": "function", "function": {"name": "delete_skill",
            "description": "Delete an entire Agent Skill and all of its bundled resources. Use only when the user explicitly asks to delete that skill.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Skill name or id"}},
                "required": ["skill"]}}}
        ,{"type": "function", "function": {"name": "run_skill_script",
            "description": "Run an enabled skill's bundled Python or JavaScript helper from scripts/ in an isolated temporary copy of the skill folder. The user must approve the exact script contents first. Optional input is sent on stdin; stdout is returned.",
            "parameters": {"type": "object", "properties": {
                "skill": {"type": "string", "description": "Enabled skill name or id"},
                "path": {"type": "string", "description": "Relative scripts/... .py or .js path"},
                "input": {"type": "string", "description": "Optional text sent to the script on stdin"}},
                "required": ["skill", "path"]}}}
    ]);
    if web_enabled {
        let arr = tools.as_array_mut().unwrap();
        arr.push(serde_json::json!(
            {"type": "function", "function": {"name": "web_search",
                "description": "Search the public web across several engines at once, merged into one relevance ranking. Use for current events or information not in the room. Returns a title, a URL, and which engine found it — NOT the page's text, so call fetch_page on a URL to actually read it.",
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

/// The download/save tool names, which belong to the WEB AGENT's box — the
/// sidecar boxes them on `chat.web` alone (`routing.DOWNLOAD_TOOL_NAMES`).
///
/// They are therefore part of the SEARCH lane, and `WebLanes::blocks` says so.
/// While they were not, turning the Web agent off removed only `web_search` and
/// `fetch_page`: the box still intersected the served catalog, so the sidecar's
/// `worker_reachable` kept the Web agent reachable, the Main agent kept routing
/// internet asks to it, and it could still pull a page, a file or a video off
/// the internet into the room — with Settings claiming the AI has no internet
/// abilities. A switch that leaves three inlets open is a false privacy claim.
pub(crate) const DOWNLOAD_TOOL_NAMES: &[&str] = &["save_link", "download_url", "download_media"];

/// BROWSE-2 (D17): the download/save tools. Web-gated like `fetch_page`, but
/// served only to the engine tiers (`include_browse_tools` class in the room
/// bridge) — downloading into the room is an ACTION, so a merely consulted
/// advisor never sees these.
pub(crate) fn download_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "save_link",
            "description": "Save a web page into this room as a readable Markdown file (title, source URL, readable text). A YouTube link saves the video's transcript instead. Use when the user asks to save, keep or bookmark a link.",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string", "description": "Full http(s) URL"}},
                "required": ["url"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "download_url",
            "description": "Download the file at a URL (PDF, CSV, image, archive, …) into this room. Up to 64 MB arrives immediately; a bigger file continues as a background job — report the job id and track it with job_status. Not for web pages (save_link) or videos on streaming sites (download_media).",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string", "description": "Full http(s) URL of the file"}},
                "required": ["url"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "download_media",
            "description": "Download the video/audio from a media page (YouTube and most video sites) into this room as a background job. Returns the job id — track it with job_status. The file is transcribed automatically after it arrives.",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string", "description": "Full http(s) URL of the video page"}},
                "required": ["url"]}}}),
    ]
}

/// ADD-25: the UI/perception tool specs. Deliberately NOT part of
/// `tools_catalog` — the room MCP bridge is built from `tools_catalog`, so
/// keeping these out means a cloud client on the Leash can never observe or
/// drive this Mac's screen. The guard is structural, exactly like
/// `consult_advisor_spec`. Injected by the sidecar `/run` loop (via the room MCP
/// bridge) only when the deterministic router (`wants_ui_tools`) fires.
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
    /// True when this connector is reached over the network — the outbound
    /// redaction seam masks the room's entities in this tool's args.
    pub(crate) remote: bool,
    /// pub(crate) so the room bridge can advertise the same specs to a
    /// consulted advisor (ADD-21).
    pub(crate) spec: serde_json::Value,
    pub(crate) client: Arc<tokio::sync::Mutex<mcp::Client>>,
}

/// Longest a slimmed property description may be, in CHARACTERS. 100 *bytes*
/// was one clause of English — and about fifty characters of Hebrew, where the
/// clause carrying "this cannot be undone" is usually the second one.
pub(crate) const SCHEMA_DESC_MAX: usize = 150;

/// Longest a slimmed TOOL description may be, in characters.
pub(crate) const SCHEMA_TOOL_DESC_MAX: usize = 300;

/// Longest enum a slimmed schema may advertise. An enum is a CLOSED set: values
/// past the cap are not merely abbreviated, they are unreachable, so this is far
/// more generous than the description budget and truncation is announced.
pub(crate) const SCHEMA_ENUM_MAX: usize = 64;

/// Bookends of the appended enum-truncation note. Stable, and the tail is
/// deliberately distinctive rather than a bare `)` — a legitimate vendor
/// description ending in a parenthesis must not be mistaken for our own note
/// and dismembered. Together they let a second slimming pass recognise its own
/// work, peel it off, and re-derive it instead of clamping it away
/// (see [`slim_schema`]).
const ENUM_NOTE_HEAD: &str = " (showing ";
const ENUM_NOTE_TAIL: &str = "that is not listed)";

/// Clamp text a MODEL reads as a complete sentence, marking the cut.
///
/// Counts CHARACTERS, not bytes, so a Hebrew description gets the same budget
/// as an English one (a byte budget silently halves it) and the cut can never
/// land mid-codepoint.
///
/// Deliberately NOT [`clamp_bytes`], which must stay silent: that one clamps
/// content we STORE (memory notes, extracted text) where an appended ellipsis
/// would be persisted corruption. Here the string is a description shown to the
/// model, and an unmarked cut is worse than a short one — a connector tool
/// documented "Permanently deletes the record. This cannot be undone." arrives
/// as a fragment that reads as the whole truth.
pub(crate) fn clamp_marked(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    // Reserve room for the marker so the result still respects `max` chars.
    let keep = max.saturating_sub(1);
    let cut: String = s.chars().take(keep).collect();
    // Don't leave a dangling separator hanging before the marker.
    let trimmed = cut.trim_end().trim_end_matches([',', ';', ':', '-', '(']);
    format!("{}…", trimmed.trim_end())
}

/// Every built-in tool's advertised `parameters` schema, by name.
///
/// Built once from the SAME spec functions the bridge serves, so
/// [`missing_required_arg`] validates against exactly what the model was told —
/// there is no second copy of the contract to drift.
fn builtin_param_schemas() -> &'static HashMap<String, serde_json::Value> {
    static SCHEMAS: std::sync::OnceLock<HashMap<String, serde_json::Value>> =
        std::sync::OnceLock::new();
    SCHEMAS.get_or_init(|| {
        let mut out = HashMap::new();
        let mut absorb = |specs: Vec<serde_json::Value>| {
            for spec in specs {
                let Some(f) = spec.get("function") else { continue };
                let (Some(name), Some(params)) =
                    (f.get("name").and_then(|n| n.as_str()), f.get("parameters"))
                else {
                    continue;
                };
                out.insert(name.to_string(), params.clone());
            }
        };
        // `web_enabled: true` so web_search/fetch_page are covered too; this is
        // a validation table, not a catalog, so breadth is correct here.
        absorb(
            tools_catalog(true)
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        absorb(ui_tools_specs());
        absorb(browse_tools_specs());
        absorb(job_tools_specs());
        absorb(crate::commands::workflow_tools_specs());
        absorb(script_tools_specs());
        absorb(studio_tools_specs());
        absorb(transcribe_tools_specs());
        absorb(mcp_management_tools_specs());
        absorb(external_agent_tools_specs());
        // The advisor spec's enum is runtime-dependent, but its `required` is
        // not — a static rendering is the right shape for validation.
        absorb(
            consult_advisor_spec(&["claude-cli".to_string(), "codex-cli".to_string()])
                .into_iter()
                .collect(),
        );
        out
    })
}

/// Required params whose EMPTY STRING is a documented, meaningful value.
///
/// `move_file`'s schema says "empty string for the top level" — so `""` is a
/// real instruction there, not a model that forgot an argument, and the blank
/// rule below must not swallow it. Kept as an explicit, greppable list because
/// inferring it from prose ("if the description mentions 'empty'…") would be a
/// guess about English, applied to a write path. Anything added here must
/// genuinely document the empty case in its own parameter description.
const EMPTY_STRING_IS_MEANINGFUL: &[(&str, &str)] = &[("move_file", "folder")];

/// The first advertised-required argument this call failed to supply, if any.
///
/// "Supplied" is type-aware, because an empty value is usually the same failure
/// as an absent one: a blank string resolves to the newest file, an empty array
/// is a no-op batch, and an empty object is not a config. The exception is
/// [`EMPTY_STRING_IS_MEANINGFUL`]. Absent and null are ALWAYS failures, for
/// every parameter, with no exceptions.
///
/// Only TOP-level `required` is enforced — nested item contracts belong to the
/// arm that understands them (`parse_batch_ops` numbers each entry).
///
/// The message follows the house convention (`"<param> is required — <hint>"`,
/// see `edit_match`), and the hint is the parameter's OWN description, so the
/// model is told the same thing the schema told it, in the place where it
/// matters. Unknown tools (connected MCP routes) return `None`: their contracts
/// are the connector's, not ours.
pub(crate) fn missing_required_arg(tool: &str, args: &serde_json::Value) -> Option<String> {
    let schema = builtin_param_schemas().get(tool)?;
    let required = schema.get("required")?.as_array()?;
    let props = schema.get("properties");
    for entry in required {
        let key = entry.as_str()?;
        let empty_ok = EMPTY_STRING_IS_MEANINGFUL.contains(&(tool, key));
        let supplied = match args.get(key) {
            // Absent or null is always a failure, exceptions or not.
            None | Some(serde_json::Value::Null) => false,
            Some(serde_json::Value::String(s)) => empty_ok || !s.trim().is_empty(),
            Some(serde_json::Value::Array(a)) => !a.is_empty(),
            Some(serde_json::Value::Object(o)) => !o.is_empty(),
            // Numbers and booleans are meaningful at any value, including 0.
            Some(_) => true,
        };
        if supplied {
            continue;
        }
        let hint = props
            .and_then(|p| p.get(key))
            .and_then(|p| p.get("description"))
            .and_then(|d| d.as_str())
            .map(|d| format!(" — {d}"))
            .unwrap_or_default();
        return Some(format!(
            "{key} is required{hint}. Nothing was done — call {tool} again with {key} set."
        ));
    }
    None
}

/// CHG-29: strip a third-party JSON Schema down to what the model needs to call
/// the tool, in place. Real MCP servers ship schemas with long descriptions,
/// examples and huge enums that can consume thousands of the 12K-token window.
/// Recursive over objects/arrays.
///
/// This is the ONLY transform between a connector's schema and the model — the
/// slimmed copy is what `mcp_routes` stores, so both the catalog and
/// `search_mcp_tools` serve it and nothing downstream can recover what was cut.
/// That makes every silent loss here a capability the model cannot know it has.
/// So (2026-07-28):
///
/// * enums are capped at [`SCHEMA_ENUM_MAX`], not 16, and a truncated enum SAYS
///   so in its own description. Values past a silent cap were simply
///   unreachable, with nothing in context hinting they existed.
/// * descriptions are clamped with a visible marker (see [`clamp_marked`]).
/// * `default` is KEPT. It tells the model which arguments it may safely omit;
///   dropping it made a well-documented optional look mandatory-but-unexplained
///   and invited invented values.
/// * `additionalProperties` is kept only when it is `false` — one token that
///   stops a small model inventing fields. A permissive object is noise.
/// * the recursion is SCHEMA-AWARE (see [`SCHEMA_MAP_KEYWORDS`]). It used to
///   descend into `properties` as if it were another schema, so a connector
///   argument literally NAMED `title`, `example` or `examples` was deleted
///   while `required` still demanded it — that is every GitHub issue/PR,
///   Notion page, Linear, Jira and Todoist create call.
pub(crate) fn slim_schema(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for k in ["$schema", "title", "examples", "example", "$id", "$comment"] {
                map.remove(k);
            }
            // Keep `additionalProperties: false` (load-bearing), drop the rest.
            if map.get("additionalProperties") != Some(&serde_json::Value::Bool(false)) {
                map.remove("additionalProperties");
            }
            map.retain(|k, _| !k.starts_with("x-"));

            // Peel off a note THIS function appended on an earlier pass before
            // touching the description, remembering the real total. Without
            // this, re-slimming clamps the note off the end (it sits past the
            // budget) while the already-capped enum produces no replacement —
            // the truncation warning would silently evaporate on the second
            // pass. Routes are rebuilt every turn, so "slim twice" must be
            // exactly "slim once".
            let mut prior_total: Option<usize> = None;
            if let Some(serde_json::Value::String(d)) = map.get_mut("description") {
                if d.ends_with(ENUM_NOTE_TAIL) {
                    if let Some(i) = d.rfind(ENUM_NOTE_HEAD) {
                        prior_total = d[i..]
                            .split(" of ")
                            .nth(1)
                            .and_then(|rest| rest.split(' ').next())
                            .and_then(|n| n.parse::<usize>().ok());
                        d.truncate(i);
                    }
                }
            }

            if let Some(serde_json::Value::String(d)) = map.get_mut("description") {
                *d = clamp_marked(std::mem::take(d), SCHEMA_DESC_MAX);
            }

            // Announce a truncated enum in the description, so a model that
            // needs a missing value can ask instead of assuming the list it can
            // see is the whole list.
            let truncated_total = match map.get_mut("enum") {
                Some(serde_json::Value::Array(en)) if en.len() > SCHEMA_ENUM_MAX => {
                    let total = en.len();
                    en.truncate(SCHEMA_ENUM_MAX);
                    Some(total)
                }
                // Already at the cap from a previous pass: keep the note honest
                // by restoring the total it recorded.
                _ => prior_total,
            };
            if let Some(total) = truncated_total {
                let note = format!(
                    "{ENUM_NOTE_HEAD}{SCHEMA_ENUM_MAX} of {total} allowed values \
                     — ask the user if you need one {ENUM_NOTE_TAIL}"
                );
                match map.get_mut("description") {
                    Some(serde_json::Value::String(d)) => d.push_str(&note),
                    _ => {
                        map.insert(
                            "description".into(),
                            serde_json::Value::String(note.trim_start().into()),
                        );
                    }
                }
            }
            for (k, child) in map.iter_mut() {
                // A "map of subschemas" keyword's KEYS are names the connector
                // chose, not JSON-Schema keywords: descend one level further
                // so the stripping above never runs against them.
                if SCHEMA_MAP_KEYWORDS.contains(&k.as_str()) {
                    if let serde_json::Value::Object(children) = child {
                        for (_, sub) in children.iter_mut() {
                            slim_schema(sub);
                        }
                    }
                    continue;
                }
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

/// JSON-Schema keywords whose VALUE is a map of NAME → subschema rather than a
/// subschema itself. [`slim_schema`] must not apply keyword stripping to these
/// containers — their keys are the connector's own argument/definition names.
const SCHEMA_MAP_KEYWORDS: &[&str] = &[
    "properties",
    "patternProperties",
    "dependentSchemas",
    "$defs",
    "definitions",
];

/// Snapshot the connected MCP tools, namespaced `server_tool` and deduped
/// against the built-in tool names and each other. Schemas are still slimmed
/// to remove vendor-only noise, but every enabled connected tool is offered.
pub(crate) fn mcp_routes(state: &State<'_, AppState>) -> Vec<McpRoute> {
    let mut taken: HashSet<String> = BUILTIN_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    // Per-connector tool opt-outs, read before locking `mcp` so we never hold
    // both locks. A disabled tool is skipped entirely.
    let disabled = state
        .with_room(|room| {
            Ok(parse_tool_prefs(
                &db::get_setting(&room.conn, MCP_TOOL_PREFS_KEY).unwrap_or_default(),
            ))
        })
        .unwrap_or_default();
    let mgr = state.mcp.lock().unwrap();
    let mut routes = Vec::new();
    for server in &mgr.servers {
        let Some(client) = &server.client else { continue };
        let off = disabled.get(&server.name);
        for tool in &server.tools {
            // User turned this tool off for this room — it's not offered at all.
            if off.is_some_and(|s| s.contains(&tool.name)) {
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
            // Long descriptions eat the context. Cut with a visible marker —
            // an unmarked slice reads as the whole description, and the clause
            // a connector puts LAST is usually the one warning you the call is
            // irreversible (2026-07-28).
            let description = clamp_marked(tool.description.clone(), SCHEMA_TOOL_DESC_MAX);
            let mut schema = tool.schema.clone();
            slim_schema(&mut schema);
            let mut spec = serde_json::json!({"type": "function", "function": {
                "name": catalog_name,
                "description": description,
                "parameters": schema,
            }});
            if let Some(annotations) = &tool.annotations {
                spec["function"]["annotations"] = annotations.clone();
            }
            taken.insert(catalog_name.clone());
            routes.push(McpRoute {
                catalog_name,
                tool_name: tool.name.clone(),
                server_name: server.name.clone(),
                remote: server.remote,
                spec,
                client: client.clone(),
            });
        }
    }
    routes
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
    /// view_media_frame). The room bridge drains them into a vision user-message
    /// right after the tool result, so the model looks at what it captured.
    pub(crate) pending_images: Vec<String>,
    /// ADD-25: whether the CHAT model can read attached images. Set by the
    /// caller from `chat_model_sees_images` (the engine's own answer, not the
    /// model's name); when false the perception tools return a local
    /// vision-model description instead of attaching pixels.
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
    /// Token-budget bar: this turn's `AskTokenUsage` snapshot (last round wins —
    /// only the latest round's numbers matter, same "last-write-wins" shape as
    /// `boxes`/`annotation` above, not accumulated like `edit_outcomes`). `None`
    /// when no engine on this turn reported anything (sidecar-backed turns
    /// always set it; see external-CLI turns for the exception).
    pub(crate) token_usage: Option<serde_json::Value>,
    /// Dispatch-first agent visibility: the turn's agent roster (the sidecar's
    /// `plan` event body — `[{agent,label,instruction}]`). Persisted under the
    /// `"agents"` effects key so a finished message still shows WHO handled it
    /// (the live strip only exists while the turn streams — live QA 2026-07-23:
    /// a fast local answer flashes it too quickly to read).
    pub(crate) agent_plan: Option<serde_json::Value>,
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
    // Owner replacement #4: the run/chat whose turn dispatched this tool, so a
    // step chip from inside a tool call is owned exactly like the deltas around
    // it. `None` for a persistent bridge, which runs behind no ask.
    turn: Option<&crate::turn::TurnId>,
) -> Result<String, String> {
    use tauri::Emitter;
    let args = &call.arguments;
    // Never trust the model's arguments (2026-07-28). Every arm below reads its
    // arguments with `unwrap_or_default()`, so a missing REQUIRED string arrived
    // as `""` and kept going: `find_file_like_full("")` is
    // `LIKE '%' || '' || '%' … ORDER BY created_at DESC LIMIT 1`, i.e. the
    // newest file in the room. `open_file({})` opened it and `edit_file` with
    // matching text EDITED it — a wrong-target write with no error anywhere.
    //
    // Checked centrally, against each tool's own advertised schema, so the
    // guard cannot drift from what the model was told and every future tool is
    // covered the day it is added.
    if let Some(err) = missing_required_arg(&call.name, args) {
        return Err(err);
    }
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
                rows.join("\n")
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
            // Head AND tail. The head alone made "did my append land?"
            // unanswerable with this tool — the only verb an agent has for
            // reading back a file it just wrote (self-test 2026-08-01, wave 3).
            // Char-safe both ends (the head was once a raw byte slice that
            // panicked on multibyte text).
            let snippet = text
                .map(|t| {
                    let head = clamp_bytes(t.clone(), 1200);
                    match tail_bytes(&t, 600) {
                        "" => format!("\nIt begins:\n{head}"),
                        tail => format!("\nIt begins:\n{head}\n…\nIt ends:\n{tail}"),
                    }
                })
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
            // E3/E4 (2026-08-04): disambiguation refinements. Reject `occurrence`
            // together with `all: true` before any file work — "replace every
            // occurrence" and "replace only the 3rd one" can't both be honored.
            let prefix_context = args["prefix_context"].as_str().map(str::to_string);
            let suffix_context = args["suffix_context"].as_str().map(str::to_string);
            let occurrence = args["occurrence"].as_u64().map(|n| n as usize);
            let section = args["section"].as_str().map(str::to_string);
            if occurrence.is_some() && all {
                return Err(
                    "occurrence and all: true can't both be set — occurrence picks ONE place, \
                     all replaces every place."
                        .into(),
                );
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
                prefix_context,
                suffix_context,
                occurrence,
                section,
            };
            // E5 (2026-08-04): a dry run answers "how many, and what would it
            // look like" without writing anything — it calls the SAME
            // plan_single_edit the real path does, so it can't drift from what
            // actually happens, but never reaches gated_write/commit_plans.
            // Approval is meaningless for a call that never commits.
            if args["dry_run"].as_bool().unwrap_or(false) {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                return match plan_single_edit(&room.conn, &edit) {
                    Ok(plans) => Ok(dry_run_summary(&plans)),
                    Err(e) => Err(e.message),
                };
            }
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
            if args["dry_run"].as_bool().unwrap_or(false) {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                return match plan_batch(&room.conn, &ops) {
                    Ok(plans) => Ok(dry_run_summary(&plans)),
                    Err(msg) => Err(msg),
                };
            }
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
                    Ok(write_file_summary(&p.real_name, &p.before, &p.after, p.count, p.clipped))
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
            // `None` for a missing/`null` value. Only the CELL used to be
            // checked: an absent value stringified to the literal text "null",
            // was written into the sheet, and the turn reported success.
            let value_of = |v: &serde_json::Value| -> Option<String> {
                match v {
                    serde_json::Value::Null => None,
                    serde_json::Value::String(s) => Some(s.clone()),
                    // Models sometimes send numbers/booleans as JSON scalars.
                    other => Some(other.to_string()),
                }
            };
            let missing_value = |cell: &str| {
                format!(
                    "{cell} has no value — pass updates: [{{\"cell\": \"{cell}\", \"value\": \
                     \"…\"}}] (use \"\" to clear a cell). Nothing was changed."
                )
            };
            let mut updates: Vec<(String, String)> = Vec::new();
            if let Some(arr) = args["updates"].as_array() {
                for u in arr {
                    let cell = u["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                    if !cell.is_empty() {
                        let value = value_of(&u["value"]).ok_or_else(|| missing_value(&cell))?;
                        updates.push((cell, value));
                    }
                }
            }
            if updates.is_empty() {
                let cell = args["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                if !cell.is_empty() {
                    let value = value_of(&args["value"]).ok_or_else(|| missing_value(&cell))?;
                    updates.push((cell, value));
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
        // BROWSE-1: the private browser. Dispatched as a block because all six
        // share the takeover check, the page-script transport and the journal;
        // the per-tool bodies live in `commands::browse`.
        name if is_browse_tool(name) => exec_browse(window, name, args, effects, turn).await,
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
            Ok(out)
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
            crate::turn::step_for(turn, window, desc.clone());
            Ok(desc)
        }
        "view_screenshot" => {
            use tauri::Manager;
            // Native whole-window snapshot first (WKWebView takeSnapshot, no
            // permissions); the driver's viewer-pane composite is the fallback
            // (and the only path that can see <video> frames — hardware layers
            // render blank in native snapshots).
            // The main WEBVIEW by label, not `get_webview_window`: once the
            // private browser's child webview exists, that lookup returns None
            // and the native path silently degraded to the driver composite.
            let native: Result<Vec<u8>, String> =
                match crate::main_webview(&window.app_handle()) {
                    Some(wv) => crate::snapshot::capture_png(&wv),
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
            // Caption the frame the driver actually PRESENTED. A seek past the
            // end clamps, and the decoder nudge can advance it, so a caption
            // built from `at` can quietly disagree with the pixels — which is
            // exactly the kind of drift a model then reports as a
            // transcript/video mismatch it cannot explain.
            let shown = v["atSeconds"].as_f64().unwrap_or(at);
            perceive_image(
                effects,
                b64,
                &format!("the frame at {}s of \"{real_name}\"", shown.round() as u64),
            )
            .await
        }
        "web_search" => {
            // PRIV-4: the door restores placeholders in a cloud model's tool
            // arguments so ROOM tools see real values — but this argument does
            // not stay on the Mac, it goes to seven search engines. Mask it back
            // out here, at the seam, and disclose it below.
            let asked = args["query"].as_str().unwrap_or_default();
            let masked = crate::commands::privacy::mask_outbound_web(asked);
            let query = masked.as_ref().map_or(asked, |(q, _)| q.as_str());
            let mask_note = masked
                .as_ref()
                .map(|(_, hidden)| crate::commands::privacy::web_mask_note(*hidden))
                .unwrap_or_default();
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            // CHG-33: serve a recent (<15m) cached result list without touching
            // the network. Catches exact repeats and case/spacing variants — a
            // common small-model failure mode — and avoids deepening any ban.
            let cached = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::get_fresh_web_search(&room.conn, query)
            };
            if let Some(hits) = cached {
                crate::turn::step_for(
                    turn,
                    window,
                    format!("Using recent search results for \"{query}\" (from this Mac's cache)"),
                );
                // BROWSE-3: the cache holds hits now, not rendered text, and the
                // browser's results page shares this row. A search the user ran
                // in the address bar lands here as a free hit — same web, same
                // ranking, whichever of the two asked first.
                return Ok(format!("{}{mask_note}", web::render_hits(&hits)));
            }
            // CHG-33: once the search path has failed outright this turn, don't
            // keep calling it — steer the model to salvage the answer from what it
            // already has. A single blocked ENGINE no longer lands here: it drops
            // out of the fusion silently and the remaining engines still answer,
            // so this now means the whole search failed (sidecar down, timeout).
            if effects.web_search_throttled {
                return Ok("Web search is unavailable right now; answer from what you \
                           already have or from fetched pages — do not search again this turn."
                    .into());
            }
            crate::turn::step_for(
                turn,
                window,
                format!("Searching the web for \"{query}\" (leaves this Mac)"),
            );
            let page = match web::search_web(query).await {
                Ok(p) => p,
                Err(e) => {
                    effects.web_search_throttled = true;
                    return Err(e);
                }
            };
            let hits = &page.hits;
            if hits.is_empty() {
                // "No results found." is a claim about the WEB. When every engine
                // was blocked or rate limited it is a claim about our scrapers,
                // and the model has no way to tell the two apart — so it reports
                // to the user that a subject does not exist online. Say which
                // happened, and never cache a blocked search as an empty one.
                return Ok(if page.failed.is_empty() {
                    format!("No results found.{mask_note}")
                } else {
                    format!(
                        "The search did not run: {} could not be reached (blocked, rate limited \
                         or too slow). This is NOT evidence that nothing exists for this query — \
                         tell the user the search was blocked rather than reporting no results, \
                         and answer from a fetched page or what you already have.",
                        web::join_names(&page.failed)
                    )
                });
            }
            {
                let guard = state.room.lock().unwrap();
                if let Some(room) = guard.as_ref() {
                    let _ = db::put_web_search(&room.conn, query, hits);
                }
            }
            let rendered = match page.blocked_note() {
                Some(note) => format!("{}\n\n{note}", web::render_hits(hits)),
                None => web::render_hits(hits),
            };
            Ok(format!("{rendered}{mask_note}"))
        }
        "fetch_page" => {
            let url = args["url"].as_str().unwrap_or_default();
            // PRIV-4: same seam as web_search, but a URL cannot be masked and
            // still resolve — a masked path or query string just 404s. So this
            // one REFUSES rather than fetching. It is the exfiltration shape
            // that matters: a cloud model that saw "[Person A]" can restore the
            // real name into `https://anywhere/?q=…` and the door would have put
            // it back for it.
            // `outbound_url_hides`, not `mask_outbound_web`: a URL is ENCODED,
            // so "?q=Ben%20Reich" (or "Ben+Reich") carries the real name past a
            // redactor that only reads the raw string.
            if let Some(hidden) = crate::commands::privacy::outbound_url_hides(url) {
                return Ok(format!(
                    "Not fetched: this URL carries {hidden} protected name(s) from this room's \
                     block list, and Cloud privacy is on, so it must not leave this Mac \
                     (Settings → Cloud privacy). Tell the user rather than retrying."
                ));
            }
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
            // D2 (2026-08-04): a cache hit has no live redirect info (it
            // wasn't just fetched); a fresh fetch's `final_url` is only worth
            // mentioning when it actually differs — otherwise every ordinary
            // fetch would carry a pointless "redirected to the same URL" line.
            let (title, text, redirected_to) = if let Some((title, text)) = cached {
                (title, text, None)
            } else {
                crate::turn::step_for(turn, window, format!("Fetching {url} (leaves this Mac)"));
                let web::FetchedPage { title, text, final_url, .. } = web::fetch_page(url).await?;
                {
                    let guard = state.room.lock().unwrap();
                    let room = guard.as_ref().ok_or("No room is open.")?;
                    let _ = db::save_web_page(&room.conn, url, &title, &text);
                }
                let redirected_to = (final_url != url).then_some(final_url);
                (title, text, redirected_to)
            };
            Ok(fetch_page_reply(&title, url, &text, start, redirected_to.as_deref()))
        }
        // BROWSE-2 (D17): the download/save arms. All three re-check the web
        // switch (the catalog gate is advisory; the switch is the law) and end
        // in the one ingestion funnel (D13).
        "save_link" => {
            let url = args["url"].as_str().unwrap_or_default().trim().to_string();
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            crate::turn::step_for(
                turn,
                window,
                format!("Saving {url} into the room (leaves this Mac)"),
            );
            // Through the funnel that also schedules the auto-index and the
            // privacy scan, NOT the bare row write. The redactor's substitution
            // table is built from what the scan found, so a page the assistant
            // saved and never scanned contributes no entities to it — and this
            // is the one save path a cloud call usually follows immediately.
            let handle = {
                use tauri::Manager;
                window.app_handle().clone()
            };
            match crate::commands::files::import_link_and_index(&handle, state, &url).await {
                // `import_link_and_index` emits `room-files-changed` itself.
                Ok(meta) => Ok(format!("Saved \"{}\" into the room.", meta.name)),
                Err(e) if e == "YT_NO_CAPTIONS" => Ok(
                    "This video has no captions to save as a transcript. Use download_media to \
                     download the video itself — it will be transcribed after it arrives."
                        .into(),
                ),
                Err(e) => Err(e),
            }
        }
        "download_url" => {
            use tauri::Manager;
            let url = args["url"].as_str().unwrap_or_default().trim().to_string();
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            crate::turn::step_for(turn, window, format!("Downloading {url} (leaves this Mac)"));
            let app = window.app_handle().clone();
            match web::download_to_temp(&url, web::INLINE_DOWNLOAD_BYTES, None, |_, _| {}).await? {
                web::DownloadOutcome::Done(d) => {
                    let size = d.size_bytes;
                    let meta = import_download(&app, &d.path, &d.file_name, &url)?;
                    Ok(format!(
                        "Downloaded \"{}\" ({:.1} MB) into the room.",
                        meta.name,
                        size as f64 / (1024.0 * 1024.0)
                    ))
                }
                // D18: bigger than the inline cap — promote to a background job
                // instead of failing, and say so.
                web::DownloadOutcome::TooLarge => {
                    let job_id =
                        start_download_job_inner(window, state, &url, DOWNLOAD_ENGINE_FETCH)
                            .await?;
                    Ok(format!(
                        "The file is bigger than {} MB, so it is downloading as background job \
                         {job_id} — track it with job_status.",
                        web::INLINE_DOWNLOAD_BYTES / (1024 * 1024)
                    ))
                }
            }
        }
        "download_media" => {
            let url = args["url"].as_str().unwrap_or_default().trim().to_string();
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            let job_id =
                start_download_job_inner(window, state, &url, DOWNLOAD_ENGINE_MEDIA).await?;
            Ok(format!(
                "Downloading the media as background job {job_id} — track it with job_status. \
                 The file will be transcribed automatically after it arrives."
            ))
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
            // A real "can you see?" pick, not a Qwen-VL name match — so the
            // room's own cloud vision model (or a local build with an unfamiliar
            // name) does the marking instead of being passed over. When nothing
            // can see, say so rather than running a text-only model at pixels
            // and relaying its empty answer as "not in the image".
            let Some(vmodel) = grounding_pick(&models, &chat_model).await else {
                return Ok(format!(
                    "Cannot mark {real_name}: this room's model can't see images, and no vision \
                     model is installed on this Mac. Install one (Settings → AI helpers) or pick \
                     a vision-capable model in Settings → Model."
                ));
            };
            // S1 (2026-08-04): the room's own privacy gateway (`inject_policy`,
            // called by `sidecar_post` underneath `ground_prepared_image`) strips
            // the image before it reaches a non-local model and only COUNTS the
            // strip — the call still proceeds. Every other path that's the right
            // behavior (the text still gets answered); here it's not: grounding
            // with no image returns no boxes, and "no boxes" reads to the user as
            // "could not locate that in this image" — a false claim about their
            // photo instead of a true one about the room's privacy setting. The
            // sidecar's own `/vision_locate` (the viewer's click-to-locate path)
            // already refuses this case up front; this is the same backstop for
            // `ground_prepared_image`, which calls the sidecar's plain `/generate`
            // and has no such check of its own.
            if image_grounding_blocked_by_privacy(&vmodel) {
                return Ok(format!(
                    "Cannot mark {real_name}: this room's privacy door does not let images leave \
                     the Mac, so {vmodel} cannot be shown the picture. Mark images with a model \
                     that runs on this Mac, or turn the door off for this room."
                ));
            }
            let boxes = ground_prepared_image(&vmodel, &chat_model, &prepared, find, w, h).await?;
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
                    // ART-1: this is the one generated write that CANNOT go
                    // through `Artifact`. The pad is get-or-create over any
                    // source, so the funnel's "never version a person's file"
                    // rule would step aside to "Scratch pad (2).md" for a pad the
                    // user made — the exact shadowing this branch exists to
                    // prevent. The funnel's other two guarantees still hold here,
                    // by hand, because the reasons for them do not change:
                    //
                    //   * an empty rewrite is refused. `content` defaults to ""
                    //     when the model omits it, and blanking the shared pad on
                    //     the strength of a missing argument is the app throwing
                    //     the user's notes away and reporting a successful write.
                    //   * the Stop is read before the write, not after.
                    if content.trim().is_empty() {
                        return Err(format!(
                            "Nothing was generated for \"{}\" — it was left as it was. \
                             (An empty pad would look like finished work.)",
                            meta.name
                        ));
                    }
                    if cancel.as_deref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                        return Err(format!(
                            "Stopped before \"{}\" was rewritten — nothing was written to the room.",
                            meta.name
                        ));
                    }
                    store_file_bytes(&room.conn, &meta.id, content.as_bytes(), Some(&content), "AI edit")?;
                    // The pad's History says who rewrote it, like every other
                    // generated state. `store_file_bytes` has already snapshotted
                    // the outgoing head (carrying ITS provenance onto the
                    // version), so this only moves the head's.
                    let prov = db::Provenance {
                        run_id: turn.map(|t| t.run_id().to_string()),
                        tool: Some("create_file".into()),
                        ..Default::default()
                    };
                    db::set_file_provenance(&room.conn, &meta.id, prov.to_json().as_deref())?;
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
                let meta = Artifact::note(SCRATCH_PAD_NAME, &content)
                    .via_tool("create_file")
                    .during_run(turn.map(|t| t.run_id()))
                    .cancel_maybe(cancel.as_deref())
                    .commit(&room.conn)?
                    .meta;
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
            // ART-1: the agent's own write goes through the staging funnel like
            // every other generated artifact. Two consequences the model is told
            // about below: a Stop pressed while it was writing lands BEFORE the
            // commit, and asking for the same document twice versions it instead
            // of leaving two files with the same name.
            let written = Artifact::new(&name, &mime, &content)
                .via_tool("create_file")
                .during_run(turn.map(|t| t.run_id()))
                .cancel_maybe(cancel.as_deref())
                .commit(&room.conn)?;
            let _ = window.emit("room-files-changed", ());
            effects.wrote = true;
            Ok(if written.versioned {
                format!(
                    "\"{}\" already existed — rewrote it instead of creating a duplicate. \
                     The previous version is kept in History.",
                    written.meta.name
                )
            } else {
                format!("Created \"{}\" in the room.", written.meta.name)
            })
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
            Ok(format_memory_list(memories))
        }
        // 2026-07-24: the agent could add a memory but never correct or drop
        // one, so a wrong note it saved was permanent. Both verbs match on the
        // note's TEXT — list_memories never shows ids, and asking a 4B to carry
        // a UUID between two calls is exactly the multi-turn state it fails at.
        "update_memory" | "delete_memory" => {
            let find = args["find"].as_str().unwrap_or_default().trim();
            if find.is_empty() {
                return Ok("Say which note to change, using a phrase from it.".into());
            }
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let hits = db::memories_like(&room.conn, &find.to_lowercase())?;
            match hits.len() {
                0 => Ok(format!("No memory contains \"{find}\". Call list_memories to see them.")),
                1 => {
                    let (id, old) = &hits[0];
                    if call.name == "delete_memory" {
                        // S9: soft-delete, attributed to this tool — "what did
                        // the AI delete" now has an answer, same as the files
                        // trash already gives for `TrashActor::Agent`.
                        db::delete_memory(&room.conn, id, db::TrashActor::Agent("delete_memory"))?;
                        Ok(format!("Forgot: {old}"))
                    } else {
                        let content = args["content"].as_str().unwrap_or_default().trim();
                        if content.is_empty() {
                            return Ok("Give the corrected note in `content`.".into());
                        }
                        if content.chars().count() > MAX_MEMORY_CONTENT_CHARS {
                            return Ok(format!(
                                "Memory too long ({} chars); keep it under {}.",
                                content.chars().count(),
                                MAX_MEMORY_CONTENT_CHARS
                            ));
                        }
                        // update_memory SETs category, so a text-only fix
                        // would silently clear it — carry the existing one.
                        let keep = db::list_memories(&room.conn)?
                            .into_iter()
                            .find(|m| &m.id == id)
                            .and_then(|m| m.category);
                        db::update_memory(&room.conn, id, content, keep.as_deref())?;
                        Ok(format!("Updated. Was: {old}"))
                    }
                }
                // Never guess which note the user meant — name them and stop.
                _ => Ok(format!(
                    "\"{find}\" matches {} notes; be more specific:\n{}",
                    hits.len(),
                    hits.iter().map(|(_, c)| format!("- {c}")).collect::<Vec<_>>().join("\n")
                )),
            }
        }
        "list_scripts" => {
            use tauri::Manager;
            super::agent_list_scripts(window.app_handle(), state)
        }
        "run_script" => super::agent_run_script(window, state, args, cancel.as_ref()).await,
        "studio_flashcards" | "studio_mindmap" | "generate_podcast_script" => {
            use tauri::Manager;
            let app = window.app_handle().clone();
            let st = app.state::<AppState>();
            let spec = match call.name.as_str() {
                "studio_flashcards" => super::flashcards_spec(),
                "studio_mindmap" => super::mindmap_spec(),
                _ => super::podcast_spec(),
            };
            // The schema says `refs` are file NAMES (that is what a model has —
            // it reads names out of list_room_files/search_room), but
            // `gather_files_text` looks every entry up as a file ID and
            // `continue`s on a miss. So an agent-driven studio call that named
            // its source ALWAYS produced an empty blob and the studio blamed the
            // file: "The files you mentioned have no readable text to work
            // with." — on a file whose text open_file prints happily. Every
            // generator, every file; the only calls that worked were the ones
            // that omitted `refs` and fell through to whole-room scope
            // (self-test 2026-08-01, wave 6). Resolve names here, the same way
            // retranscribe_file does, and let an id through untouched for a
            // model that echoes one back.
            let refs: Option<Vec<String>> = match args["refs"].as_array() {
                None => None,
                Some(a) => {
                    let wanted: Vec<String> = a
                        .iter()
                        .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
                        .map(str::to_string)
                        .collect();
                    let guard = state.room.lock().unwrap();
                    let room = guard.as_ref().ok_or("No room is open.")?;
                    let mut ids: Vec<String> = Vec::new();
                    let mut missing: Vec<String> = Vec::new();
                    for want in &wanted {
                        if db::get_file_name(&room.conn, want).is_ok() {
                            ids.push(want.clone()); // already an id
                        } else if let Ok((id, _)) = db::find_file_like(&room.conn, want) {
                            ids.push(id);
                        } else {
                            missing.push(want.clone());
                        }
                    }
                    // Name what didn't resolve instead of silently dropping it —
                    // a studio built from half the sources it was given is the
                    // quiet wrong answer this whole path just produced.
                    if !missing.is_empty() && ids.is_empty() {
                        return Err(format!(
                            "No file matching {} in this room.{}",
                            missing.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(" or "),
                            db::file_names_hint(&room.conn)
                        ));
                    }
                    if ids.is_empty() { None } else { Some(ids) }
                }
            };
            let instructions = args["instructions"].as_str().map(str::to_string);
            // Owner replacement #3: this build is a CHILD of the run that asked
            // for it. It had no cancel flag at all before — Stop ended the
            // answer, the page kept generating, and it saved itself into the
            // room minutes later. `turn` carries the run id the frontend minted,
            // which is the same id `cancel_ask` stops.
            let meta = super::run_studio(
                window,
                &st,
                spec,
                None,
                instructions,
                refs,
                None,
                turn.map(crate::turn::TurnId::run_id),
            )
            .await?;
            Ok(format!("Saved \"{}\" into the room.", meta.name))
        }
        "stt_status" => {
            use tauri::Manager;
            let s = super::stt_status(window.app_handle().clone())?;
            // Report the LANE, not just the model. `retranscribe_file` rides the
            // STT queue and never becomes a durable job, so `job_status` cannot
            // see it — without this the agent starts a re-transcription and has
            // no way to learn it finished, which is exactly what the self-test
            // (2026-08-01, wave 5) had to grade as unverifiable. This is the
            // Transcription agent's free probe, so the check costs no round.
            let lane = match super::stt_progress() {
                (Some(name), 0) => format!(" Transcribing \"{name}\" right now."),
                (Some(name), queued) => {
                    format!(" Transcribing \"{name}\" right now, {queued} more waiting.")
                }
                (None, _) => " Nothing is transcribing right now.".to_string(),
            };
            Ok(if s.installed {
                format!("The on-device speech model is installed and ready.{lane}")
            } else if s.downloading {
                "The on-device speech model is still downloading.".to_string()
            } else {
                format!(
                    "The on-device speech model is not installed ({} MB). The user installs it in Settings.",
                    s.size_mb
                )
            })
        }
        "retranscribe_file" => {
            use tauri::Manager;
            let wanted = args["name"].as_str().unwrap_or_default().trim().to_string();
            if wanted.is_empty() {
                return Err("Say which file to transcribe, by name.".into());
            }
            let (file_id, name) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::find_file_like(&room.conn, &wanted)?
            };
            let app = window.app_handle().clone();
            let st = app.state::<AppState>();
            super::retranscribe_file(app.clone(), st, file_id)?;
            // Name the check, or the model reports a queued job as a finished
            // one. This runs on the STT lane, not the durable job table, so
            // job_status is the WRONG place to look and a model that tries it
            // gets an unrelated list back (self-test 2026-08-01, wave 5).
            Ok(format!(
                "Queued {name} for re-transcription on this computer; nothing is uploaded. \
                 It is not finished yet — call stt_status to see whether the lane is still \
                 busy, and open_file once it is clear. Do not use job_status for this."
            ))
        }
        "list_skills" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let all = db::list_skills(&room.conn, false)?;
            // 2026-07-24: a skill may belong to ONE sub-agent. The bridge is
            // scoped per RUN, not per worker, so the caller's id arrives as an
            // argument the sidecar injects. A skill with no owner is GENERAL
            // and stays visible to everyone (every pre-existing skill).
            let caller = args["agent"].as_str().unwrap_or_default().trim();
            let skills: Vec<_> = all
                .iter()
                .filter(|s| {
                    let owner = s.agent.trim();
                    owner.is_empty() || caller.is_empty() || owner == caller
                })
                .collect();
            if skills.is_empty() {
                return Ok(if all.is_empty() {
                    "No skills are stored in this room yet.".into()
                } else {
                    "No skills are assigned to you yet.".into()
                });
            }
            let lines = skills
                .iter()
                .map(|s| format!(
                    "- {} [{}]{} — {} ({} resources)",
                    s.name,
                    if s.enabled { "enabled" } else { "disabled draft" },
                    if !s.agent.trim().is_empty() && s.agent.trim() == caller { " (yours)" } else { "" },
                    s.description,
                    s.resource_count,
                ))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(clamp_bytes(lines, 12_000))
        }
        "read_skill" => {
            let key = args["skill"].as_str().unwrap_or_default();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let skill = db::find_skill(&room.conn, key)?.ok_or_else(|| format!("No skill named \"{key}\" exists."))?;
            let resources = db::list_skill_resources(&room.conn, &skill.id)?;
            let tree = if resources.is_empty() {
                "(no bundled resources)".to_string()
            } else {
                resources.iter().map(|r| format!("- {} ({})", r.path, r.kind)).collect::<Vec<_>>().join("\n")
            };
            Ok(clamp_bytes(
                format!("# Skill: {}\nStatus: {}\nDescription: {}\n\n{}\n\nBundled resources:\n{}", skill.name, if skill.enabled { "enabled" } else { "disabled draft" }, skill.description, skill.instructions, tree),
                20_000,
            ))
        }
        "read_skill_resource" => {
            let key = args["skill"].as_str().unwrap_or_default();
            let path = normalize_skill_path(args["path"].as_str().unwrap_or_default())?;
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let skill = db::find_skill(&room.conn, key)?.ok_or_else(|| format!("No skill named \"{key}\" exists."))?;
            let resource = db::get_skill_resource(&room.conn, &skill.id, &path)?;
            let text = String::from_utf8(resource.content).map_err(|_| format!("{path} is binary and cannot be loaded as text."))?;
            Ok(clamp_bytes(text, 20_000))
        }
        "save_skill" => agent_save_skill(window, state.inner(), args),
        "write_skill_resource" => agent_write_skill_resource(window, state.inner(), args),
        "delete_skill" => agent_delete_skill(window, state.inner(), args).await,
        "delete_skill_resource" => agent_delete_skill_resource(window, state.inner(), args),
        "run_skill_script" => agent_run_skill_script(window, state.inner(), args).await,
        "list_mcps" => Ok(agent_list_mcps(state.inner())?),
        "read_mcp" => {
            let name = args["name"].as_str().unwrap_or_default();
            Ok(agent_read_mcp(state.inner(), name)?)
        }
        "save_mcp" => agent_save_mcp(window, state.inner(), args),
        "delete_mcp" => agent_delete_mcp(window, state.inner(), args).await,
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
            Ok(job_status_reply(&jobs, args["job_id"].as_str()))
        }
        // Wave 4a (Idea 2): the workflow authoring tools. All logic lives in
        // commands::jobs::workflow; these arms just route args + the agent
        // messages. Drafts require explicit user activation (the review gate).
        "list_workflows" => {
            let name = args["name"].as_str();
            Ok(agent_list_workflows(state.inner(), name)?)
        }
        "save_workflow" => agent_save_workflow(state.inner(), window, args, "agent").await,
        "update_workflow" => agent_update_workflow(state.inner(), window, args).await,
        "delete_workflow" => agent_delete_workflow(state.inner(), window, args).await,
        "run_workflow" => agent_run_workflow(window, state.inner(), args).await,
        "test_workflow" => {
            Ok(agent_test_workflow(window, state.inner(), args).await?)
        }
        // Wave 1a: run one prompt on the LOCAL model for an external agent on
        // the Leash's full tier (only `ToolScope::ExternalAgent` advertises
        // it). Never touches `effects` — the bridge passes a throwaway sink
        // for this scope. Nothing caps the output here: it is
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
            if args["schema"].is_object() {
                ollama::chat_structured(
                    &model,
                    messages,
                    temperature,
                    KEEP_ALIVE_WARM,
                    &args["schema"],
                    ollama::StructuredOpts::default(),
                )
                .await
            } else {
                // The context window is decided by payload-fitted `num_ctx`
                // sidecar-side; the `tier` argument here changes nothing, so
                // the tool no longer offers a `long` switch that did nothing.
                let raw = ollama::generate(
                    &model,
                    messages,
                    temperature,
                    KEEP_ALIVE_WARM,
                    None,
                )
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
            let res = run_external(engine, &msgs, cancel.clone(), bridge, false).await;
            match res {
                // Usage discarded: a nested sub-call inside one turn, already
                // captured as ordinary tool-result char length under the
                // outer turn's "tools" category — not worth a second
                // CLI-invocation's own usage-capture complexity.
                Ok((answer, _usage)) => Ok(format!(
                    "Advisor ({want}) replied:\n\n{}",
                    answer
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
                // PRIV: extend the mechanical redaction door to the OUTBOUND
                // remote seam. A remote connector is a non-local destination, so
                // mask the room's known entities in the args before they leave,
                // and restore them in the result so the model's view stays
                // consistent. Local connectors run on this Mac and are exempt.
                //
                // Connectors → "Send remote connectors real values" is the one
                // exception, and it is deliberate: masking rewrites the VALUES a
                // connector is asked about, so a room whose entity map holds the
                // very things the user wants looked up ("NVDA", "#eng") sent the
                // server `[Person A]` and got nothing back — the call failed, and
                // the restore on the way home hid WHY, so the agent could only
                // report that the connector "would not answer". Turning that
                // preference OFF restores masking. None when the entity map is
                // empty.
                //
                // It is `mcp_outbound_unmask`, NOT `mcp_auto_approve`: since the
                // 2026-08-03 split, being allowed to run unattended says nothing
                // about what the call may carry, and vice versa.
                //
                // Computed BEFORE the consent card on purpose. The card used to
                // be built from the model's raw arguments while the masked copy
                // was what actually left the room, so in a room with protected
                // words the user approved "look up Dana Cohen" and the connector
                // was asked about "[Person A]" — an empty result neither they
                // nor the agent could explain. What is shown is now what is sent,
                // which is also what makes "real values, still ask me" honest.
                //
                // Read PER CONNECTOR since 2026-08-03: "this connector may see
                // real values" is a judgement about one destination, and one
                // remote service being trusted with the room's names says
                // nothing about the next one.
                let unmask_outbound = outbound_unmask_for(state, &route.server_name);
                let seam = if masks_outbound_args(route.remote, unmask_outbound) {
                    crate::commands::remote_seam_redactor()
                } else {
                    None
                };
                // `hidden` is why the report is no longer discarded: with "run
                // connector tools without asking" ON there is no consent card,
                // so masking that actually FIRED had no user-visible trace at
                // all — and the restore on the way home turns the placeholders
                // back, leaving an empty result that looks like the connector
                // failing. See `masked_args_note`.
                let (sent, hidden) = match &seam {
                    Some(p) => {
                        let mut report = crate::commands::PrivacyReport::default();
                        let masked = p.redactor.redact_value(args, &mut report);
                        (masked, report.entities_hidden)
                    }
                    None => (args.clone(), 0),
                };
                // SEC-1b: consent is tied to the moment data actually leaves the
                // room. Ask the user before invoking a connector's tool, unless
                // they chose "always allow" for it earlier this session.
                if !mcp_call_approved(state, window, route, &sent).await {
                    return Ok(format!(
                        "The user declined to run the \"{}\" tool from \"{}\", so it did \
                         not run and nothing left this room. Answer from what you already \
                         have, and tell the user you skipped that connected tool.",
                        route.tool_name, route.server_name
                    ));
                }
                let out = route
                    .client
                    .lock()
                    .await
                    .call_tool(&route.tool_name, &sent)
                    .await?;
                let result = match &seam {
                    Some(p) => p.redactor.restore(&out.text),
                    None => out.text,
                };
                // A connector that answers with a PICTURE (a screenshot tool, a
                // chart renderer, a map) used to have it replaced with
                // "[image content omitted]" — the model was handed a note about
                // an image instead of the image. Route it through the same
                // perception funnel the room's own tools use, which attaches the
                // pixels only to a vision-capable chat model and otherwise has a
                // LOCAL vision model describe them. Nothing new leaves the Mac:
                // the decision about pixels is `perceive_image`'s, unchanged.
                let mut result = result;
                for (i, image) in out.images.into_iter().enumerate() {
                    let caption =
                        format!("image {} from \"{}\"", i + 1, route.tool_name);
                    match perceive_image(effects, image, &caption).await {
                        Ok(note) => result.push_str(&format!("\n\n{note}")),
                        // Honest, and never fatal: the TEXT half of the result is
                        // still good, so say the picture did not make it rather
                        // than failing the whole call.
                        Err(e) => result.push_str(&format!(
                            "\n\n[{caption} could not be attached: {e}]"
                        )),
                    }
                }
                // Appended AFTER the clamp so the one sentence explaining a
                // thin result cannot be the part that gets cut.
                Ok(match masked_args_note(&route.server_name, hidden) {
                    Some(note) => format!("{}{note}", result),
                    None => result,
                })
            }
            None => Err(format!("Unknown tool: {other}")),
        },
    }
}

/// Largest slice of a fetched page handed back in ONE tool result.
///
/// Matches the private browser's own `READ_MAX` (browser/page.js), so the two
/// web-reading tools behave identically — a model that has learned to page
/// through `browse_read` pages through `fetch_page` the same way.
pub(crate) const FETCH_PAGE_WINDOW: usize = 40_000;

/// Format a fetched page's readable text starting at char offset `start`,
/// bounded to one window.
///
/// This USED to return `chars[start..]` — the whole remainder, unbounded —
/// under the rule that "the provider/model is the context authority". Two
/// things make that wrong rather than permissive:
///
/// 1. The tool's own schema already promises the opposite. It tells the model
///    "if the result is truncated, call again with the same url and the start
///    value from the truncation notice", so a pagination protocol was declared,
///    documented, and never implemented — `start` could only ever be supplied
///    by a model guessing.
/// 2. Nothing downstream can undo it. The host applies NO character cap of its
///    own to a tool result (there used to be a `clamp_tool_result` wrapper on
///    ~20 call sites whose whole body was `s` — deleted, audit #223: a name
///    that claims a safety check it does not perform is how this very failure
///    got past review). On a cloud room `budget::trim_messages_to_window`'s
///    Python twin no-ops as well, while compaction's `_split` keeps the NEWEST
///    message whole however big it is. So one `fetch_page` of a heavy site
///    (finance.yahoo.com is ~69 KB of text before any JS runs) went to the
///    provider verbatim and the request was rejected — which the user sees as
///    the Web agent "failing", with no report and no reason.
///
/// The authority argument survives intact: the model still decides how much of
/// the page it wants, one window at a time, and nothing is amputated.
pub(crate) fn fetch_page_window(title: &str, url: &str, text: &str, start: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let start = start.min(total);
    let end = (start + FETCH_PAGE_WINDOW).min(total);
    let header = format!("[{title}] {url}\n\n");
    let body: String = chars[start..end].iter().collect();
    if end < total {
        format!(
            "{header}{body}\n\n… {end} of {total} characters shown — call fetch_page \
             again with the same url and start {end} for the rest."
        )
    } else {
        format!("{header}{body}")
    }
}

/// D2 (2026-08-04): wraps `fetch_page_window` with a redirect note, so a
/// fetch that landed somewhere other than the requested URL isn't invisible.
/// `redirected_to` is `None` for a cache hit (no live redirect info) or a
/// fetch that landed exactly where it was pointed — the common case gets no
/// extra line at all.
pub(crate) fn fetch_page_reply(
    title: &str,
    url: &str,
    text: &str,
    start: usize,
    redirected_to: Option<&str>,
) -> String {
    let windowed = fetch_page_window(title, url, text, start);
    match redirected_to {
        Some(final_url) => format!("(Redirected to {final_url})\n{windowed}"),
        None => windowed,
    }
}

// --------------------------------------------------------------------------- #
// the app's own "this turn produced no answer" notices
//
// Written by Arcelle, not by a model, and persisted as the assistant message —
// which means everything downstream that reasons about "the last answer" will
// happily reason about THESE. Live QA 2026-07-30 (v0.13.0): a stopped run left
// one of them as the reply, the memory suggester read it as an answer, and
// offered to save "The room's revenue is 0." — a number that appears in no file
// in the room, one click from becoming a permanent memory.
//
// Kept as constants with one predicate over them so the wording and the checks
// cannot drift apart; `failure_notices_are_recognised_by_their_own_predicate`
// pins that.
// --------------------------------------------------------------------------- #

/// No answer, and nothing was written — safe to just retry.
pub(crate) const LOST_REPLY_CLEAN: &str =
    "*(The agent finished without producing an answer — the reply was lost before \
     it reached the app, so nothing was written. Please try again.)*";

/// No answer, but a write ALREADY COMMITTED. Never tell the user nothing was
/// written here: `effects.wrote` is the deterministic ground truth and an
/// Undo-edit control is on screen contradicting the claim.
pub(crate) const LOST_REPLY_AFTER_WRITE: &str =
    "*(The agent finished without producing an answer — the reply was lost before \
     it reached the app. A change was already applied to this room before that \
     happened; check the file and undo it if it was not what you wanted.)*";

/// No answer and no write, but durable background work in this room is STILL
/// RUNNING. `LOST_REPLY_CLEAN`'s "Please try again" is an instruction, and on a
/// long turn that started a job it was the wrong one: the answer is safe to
/// re-ask, the job is not safe to start twice. Says only what the jobs table
/// can prove — that work is live in this room, not that this turn started it
/// (nothing links a job row to an ask).
pub(crate) const LOST_REPLY_WITH_JOB: &str =
    "*(The agent finished without producing an answer — the reply was lost before \
     it reached the app, and nothing was written. Background work in this room is \
     still running: check the Jobs list before asking again, so you don't start \
     the same job twice.)*";

/// The mid-run failure note's stable fragment (the rest carries the error text).
pub(crate) const STOPPED_MID_RUN: &str = "hit an error and stopped mid-run";

/// Is durable background work still live in the OPEN room? The jobs table is
/// the deterministic ground truth behind `LOST_REPLY_WITH_JOB` — the same rows
/// the Sidebar draws — so the notice can never describe a job the user cannot
/// go and look at. A failed read is NOT "nothing is running": stay with the
/// plainer notice rather than claiming either way.
pub(crate) fn background_work_live(state: &State<'_, AppState>) -> bool {
    state
        .with_room(|room| db::list_jobs(&room.conn))
        .map(|jobs| {
            jobs.iter()
                .any(|j| j.status == "running" || j.status == "queued")
        })
        .unwrap_or(false)
}

/// Is this assistant message one of Arcelle's own failure notices rather than a
/// real answer? Anything that reads the "last answer" must ask this first.
pub(crate) fn is_failure_notice(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("*(The agent ")
        && (t.contains("the reply was lost before it reached the app")
            || t.contains(STOPPED_MID_RUN))
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

/// The LAST `max` bytes of `s`, never splitting a char. Empty when `s` already
/// fits (the caller has the whole thing and needs no tail).
///
/// Exists so `open_file` can show a file's END. Before this it returned only
/// "It begins:" + the first 1200 bytes, which means an agent appending to a
/// growing file — a log, a running note — had NO way to see whether its write
/// landed, and `verify_claims` has nothing to check against either. The
/// self-test (2026-08-01, wave 3) caught its own append silently missing only
/// because it fell back to `search_room`.
pub(crate) fn tail_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return "";
    }
    let mut cut = s.len() - max;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    &s[cut..]
}

/// Would this installed model process the pixels ON THIS MAC?
///
/// The describe pass in [`perceive_image`] promises exactly that, and
/// `is_external_engine` alone does not deliver it: it returns false for Ollama
/// `:cloud` models BY DESIGN (they are served from Ollama's machines, not this
/// one), and a name like `qwen3-vl:235b-cloud` matches every VL pattern we look
/// for. So a Mac with no local VL build but a vision-capable `:cloud` entry
/// installed would have sent decrypted screenshot bytes off the machine on the
/// one path that says they never leave it.
/// Strict on purpose — it is deciding whether decrypted pixels stay on the
/// machine, so anything that merely LOOKS hosted is excluded: Ollama also tags
/// its cloud entries `<size>-cloud` (`gpt-oss:120b-cloud`, `qwen3-vl:235b-cloud`),
/// which `is_cloud_model`'s exact `:cloud` suffix does not catch. The cost of a
/// false exclusion is one honest "install a local vision model"; the cost of a
/// false inclusion is the user's screenshot leaving the Mac.
///
/// The rule itself now lives in the engine capability record
/// (`commands::capabilities::engine_id_of`) and this reads its `local` field —
/// one definition, so the vision pick, the bridge tier, the trust label, the
/// job lanes and the privacy door can no longer disagree about which models run
/// here. THE NAME STAYS: every call site reads as the question it is asking.
///
/// The record answers for the MODEL; `ollama_runs_here` answers for the
/// TRANSPORT. Both must say yes: a room with the Closet override set relays
/// `qwen3.5:4b` to another computer, and the name alone cannot know that.
pub(crate) fn runs_on_this_mac(model: &str) -> bool {
    crate::commands::declared_for(model).local && crate::commands::ollama_runs_here()
}

/// S1 (2026-08-04): would grounding `vmodel` silently see no image, because
/// this room's privacy door strips images before they reach a non-local
/// model? See the `mark_image` call site for the full story.
pub(crate) fn image_grounding_blocked_by_privacy(vmodel: &str) -> bool {
    !runs_on_this_mac(vmodel) && privacy::active_policy().is_some()
}

/// ADD-25: hand a captured image (screenshot / video frame) to the model.
/// Vision-capable chat model → queue the pixels; the room bridge attaches them as
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
    // need a *separate* image-capable LOCAL model to describe them. ASK each one
    // whether it can see rather than scanning for known names — a multimodal
    // model whose name matched none of the hard-coded patterns used to be
    // skipped here, and the user was told to install a vision model they already
    // had. Refuse if there's no genuine on-device vision model: a text-only
    // model just parrots the schema back (`{"properties":{"description":{}}}`),
    // and an external engine — or an Ollama `:cloud` entry, which is served from
    // someone else's machine — would leak pixels this path promises never leave
    // the Mac (`runs_on_this_mac`).
    let mut vmodel = None;
    for m in &models {
        if runs_on_this_mac(m) && chat_model_sees_images(m).await {
            vmodel = Some(m.clone());
            break;
        }
    }
    let Some(vmodel) = vmodel else {
        return Err(
            "This room's chat model can't see images, and no model on this Mac can describe them \
             either. Pick a model with the `vision` badge in Settings → Model, or install one."
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
    Ok(format!(
        "Your chat model can't view images, so a local vision model looked at {caption} and \
         reports: {desc}"
    ))
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
    fn unmasking_not_auto_approve_decides_the_outbound_args() {
        // The reported failure: a remote connector asked about values the room's
        // entity map also knows ("NVDA", "#eng") received placeholders and
        // returned nothing, and the restore hid why. The cure is the user's
        // explicit "send real values", and ONLY that — this argument is
        // `mcp_outbound_unmask`, never `mcp_auto_approve`.
        assert!(!masks_outbound_args(true, true));
        // Unmasking off: the mask is back, whatever the consent card is doing.
        assert!(masks_outbound_args(true, false));
        // A local connector never leaves this Mac, either way.
        assert!(!masks_outbound_args(false, false));
        assert!(!masks_outbound_args(false, true));
    }

    #[test]
    fn a_masked_connector_call_says_so_in_its_own_result() {
        // The other half of that failure: under "run connector tools without
        // asking" there is no consent card, and the restore on the way home
        // puts the real names back — so the ONE trace that the call asked about
        // placeholders has to travel with the result, or a thin answer is
        // indistinguishable from a connector with nothing to say.
        let note = masked_args_note("gmail", 2).expect("masking fired, so it is reported");
        assert!(note.contains("hid 2 protected values"));
        assert!(note.contains("gmail"));
        assert!(note.contains("Send remote connectors real values"));
        // Singular reads as English, not "1 values".
        assert!(masked_args_note("gmail", 1).unwrap().contains("hid 1 protected value in"));
        // Nothing matched: empty must keep reading as empty. A note here would
        // invent a cause for a result that simply had none.
        assert!(masked_args_note("gmail", 0).is_none());
    }

    #[test]
    fn the_describe_pass_only_ever_picks_a_model_that_runs_here() {
        let _guard = crate::ollama::base_url_test_lock();
        // `perceive_image` promises the pixels of a screenshot or video frame
        // never leave the Mac. `is_external_engine` alone does not keep that
        // promise: it returns false for Ollama `:cloud` models by design, and a
        // `:cloud` VL entry matches every name pattern the picker looks for.
        assert!(runs_on_this_mac("qwen2.5vl:7b"));
        assert!(runs_on_this_mac("gemma3:12b"));
        // Served from Ollama's machines — the pixels would leave this one. Both
        // spellings count: the bare `:cloud` tag AND the `<size>-cloud` form
        // `is_cloud_model` misses, which is the one a VL name pattern matches.
        assert!(!runs_on_this_mac("minimax-m3:cloud"));
        assert!(!runs_on_this_mac("qwen3-vl:235b-cloud"));
        assert!(!runs_on_this_mac("gpt-oss:120b-cloud"));
        // …as would an external engine.
        assert!(!runs_on_this_mac("claude-cli::opus"));
        assert!(!runs_on_this_mac("openrouter::vendor/vision-agent"));
    }

    /// The Closet (`set_ollama_url`) moves the SAME model to another computer.
    /// Locality used to be read off the model NAME alone, so with a LAN box
    /// configured `qwen3.5:4b` still answered "runs on this Mac" — and every
    /// seam that reads this said so too: the privacy door skipped injection
    /// (real names, whole documents), pixels were handed over, and the trust
    /// chip said "Local only — nothing leaves the device".
    #[test]
    fn a_relayed_ollama_is_not_this_mac_however_local_the_model_name_looks() {
        let _guard = crate::ollama::base_url_test_lock();
        crate::ollama::set_base_url_override(None);
        assert!(runs_on_this_mac("qwen3.5:4b"), "no override: this Mac");

        crate::ollama::set_base_url_override(Some("http://192.168.1.20:11434".into()));
        assert!(
            !runs_on_this_mac("qwen3.5:4b"),
            "the Closet relays this model to another computer"
        );
        // A loopback override is still this Mac — the field is also how people
        // point at a non-default local port.
        crate::ollama::set_base_url_override(Some("http://127.0.0.1:11500".into()));
        assert!(runs_on_this_mac("qwen3.5:4b"));
        crate::ollama::set_base_url_override(None);
    }

    #[test]
    fn primary_cli_scope_is_the_engine_tier_not_the_advisor_tier() {
        // Owner decision 2026-07-25: the room's own cloud CLI is the main
        // agent, so it gets the local tier minus the screen. Sharing the
        // consulted-advisor tier cost it jobs, workflows, scripts, studio and
        // transcription — `ask_jobs_agent` never entered its catalog at all.
        assert_eq!(primary_cli_scope(), crate::room_mcp::ToolScope::CloudEngine);
        // The property the old name pinned — connected MCP always advertised
        // to the room's own engine — is asserted with the rest of the tier in
        // `room_mcp::tests::cloud_engine_matches_the_local_tier_except_the_screen`.
    }

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
        assert!(wants_skill_tools("turn the attached policy into a skill"));
        assert!(wants_mcp_management_tools("show my MCP connectors"));
        assert!(!wants_skill_tools("what does the lease say about pets?"));
        assert!(!wants_mcp_management_tools("what does the lease say about pets?"));
        // …plain informational questions keep the short read-only catalog.
        assert!(!wants_write_tools("what does the lease say about pets?"));
        assert!(!wants_write_tools("who are the parties in this agreement"));
    }

    #[test]
    fn slash_skill_invocation_extracts_the_selected_skill_and_request() {
        assert_eq!(
            explicit_skill_request("/lease-review check the termination clause"),
            Some(("lease-review", "check the termination clause"))
        );
        assert_eq!(
            explicit_skill_request("  /lease-review   check this  "),
            Some(("lease-review", "check this"))
        );
        assert_eq!(explicit_skill_request("/lease-review"), Some(("lease-review", "")));
        assert_eq!(explicit_skill_request("summarize /lease-review"), None);
        assert_eq!(explicit_skill_request("/not_valid do it"), None);
    }

    #[test]
    fn pure_save_references_bypass_the_model() {
        // Live-QA round 2: these must be handled by CODE (Save-to-room path).
        assert!(is_pure_save_reference("save that as a new file called Summary"));
        assert!(is_pure_save_reference("save this to the room"));
        assert!(is_pure_save_reference("שמור את זה כקובץ בשם סיכום"));
        assert!(is_pure_save_reference("keep it as a note"));
        assert!(is_pure_save_reference("Save this, please."));
        // Transform saves still go to the model — real work is required.
        assert!(!is_pure_save_reference("save that translated to Hebrew"));
        assert!(!is_pure_save_reference("save this but shorten it first"));
        assert!(!is_pure_save_reference("save it without the code blocks"));
        // A file NAME must not read as a transform verb — and arbitrary user
        // text in the name must not be scanned for vocabulary at all.
        assert!(is_pure_save_reference("save that as a file called Summary"));
        assert!(is_pure_save_reference(
            "save this as a file called translate the shorter version"
        ));
    }

    #[test]
    fn a_qualified_save_is_the_models_job_not_the_bypasss() {
        // The blacklist's blind spot, and why the predicate is an allow-list
        // now: none of these names a "transform verb", so the bypass fired,
        // wrote the previous reply UNCHANGED, and told the user it had saved
        // what they asked for. Every one must reach the model instead.
        for q in [
            "save this as a PDF",
            "save this in a table format",
            "save that with the headings fixed",
            "save that as bullet points",
            "save it in Hebrew",
            "save this and email it to Dana",
            "save that minus the intro",
        ] {
            assert!(is_bare_save_reference(q), "fixture must be a save turn: {q}");
            assert!(!is_pure_save_reference(q), "silently dropped a qualifier: {q}");
        }
    }

    #[test]
    fn case_insensitive_search_returns_offsets_into_the_original() {
        // `to_lowercase().find()` is the obvious version and it is subtly
        // wrong: lowercasing is not length-preserving, so an index found in the
        // lowered copy can point somewhere else in the original.
        let (start, end) = find_ci("Save that CALLED Summary", "called ").unwrap();
        assert_eq!(&"Save that CALLED Summary"[start..end], "CALLED ");
        assert_eq!(&"Save that CALLED Summary"[end..], "Summary");
        assert_eq!(find_ci("nothing here", "called "), None);
        // A string whose lowercase is LONGER than itself must not shift the cut.
        let tricky = "save that İcalled Report";
        assert!(tricky.to_lowercase().len() > tricky.len());
        if let Some((_, end)) = find_ci(tricky, "called ") {
            assert_eq!(&tricky[end..], "Report");
        }
        assert_eq!(requested_file_name(tricky).as_deref(), Some("Report"));
    }

    #[test]
    fn requested_file_names_are_extracted() {
        assert_eq!(
            requested_file_name("save that as a new file called Summary").as_deref(),
            Some("Summary")
        );
        assert_eq!(
            requested_file_name("keep it, named \"Q3 notes\"").as_deref(),
            Some("Q3 notes")
        );
        assert_eq!(
            requested_file_name("שמור את זה בשם סיכום הפרויקט").as_deref(),
            Some("סיכום הפרויקט")
        );
        assert_eq!(requested_file_name("save that to the room"), None);
    }

    #[test]
    fn bare_save_references_are_detected() {
        // The live-QA failure, verbatim:
        assert!(is_bare_save_reference("save that as a new file called Summary"));
        assert!(is_bare_save_reference("Save this to the room"));
        assert!(is_bare_save_reference("keep it as a note"));
        assert!(is_bare_save_reference("record your answer in a file"));
        assert!(is_bare_save_reference("שמור את זה כקובץ חדש"));
        // Content-carrying or unrelated turns must NOT trigger the hint:
        assert!(!is_bare_save_reference("save the quarterly report file"));
        assert!(!is_bare_save_reference("what does the contract say about rent"));
        let long = format!("save this: {}", "x".repeat(200));
        assert!(!is_bare_save_reference(&long)); // carries its own content
    }

    #[test]
    fn hebrew_questions_fire_the_routers() {
        // 2026-07-23 live QA: the hint lists were English-only substrings, so
        // a Hebrew speaker could never open a lane. (to_lowercase is identity
        // for Hebrew; plain substring matching.)
        assert!(wants_write_tools("שמור את זה כקובץ"));
        assert!(wants_write_tools("ערוך את החוזה"));
        assert!(wants_ui_tools("פתח את הקובץ"));
        assert!(wants_ui_tools("צלם צילום מסך"));
        assert!(wants_job_tools("סכם את כל הספר"));
        assert!(wants_skill_tools("צור מיומנות חדשה"));
        assert!(wants_mcp_management_tools("הצג את המחברים שלי"));
        // A plain Hebrew question opens nothing (the short-catalog win case).
        assert!(!wants_ui_tools("מה שכר הדירה בחוזה?"));
        assert!(!wants_job_tools("מה שכר הדירה בחוזה?"));
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
        // Wave 4a structural guard: the workflow tools are LocalEngine/
        // ExternalAgent-only (served over the bridge, gated by the jobs router) —
        // never in tools_catalog, so a cloud client can never reach them. Each is
        // also reserved in BUILTIN_TOOL_NAMES against MCP shadowing.
        let catalog = tools_catalog(true).to_string();
        let specs = workflow_tools_specs();
        assert_eq!(specs.len(), 6);
        for name in ["list_workflows", "save_workflow", "update_workflow", "delete_workflow", "run_workflow", "test_workflow"] {
            assert!(!catalog.contains(name), "{name} must not be in tools_catalog");
            assert!(BUILTIN_TOOL_NAMES.contains(&name), "{name} must be reserved");
            assert!(specs.iter().any(|s| s["function"]["name"] == name), "{name} spec missing");
        }
    }

    #[test]
    fn connector_management_tools_are_local_only_and_reserved() {
        let specs = mcp_management_tools_specs();
        for name in ["list_mcps", "read_mcp", "save_mcp", "delete_mcp"] {
            assert!(BUILTIN_TOOL_NAMES.contains(&name), "{name} must be reserved");
            assert!(specs.iter().any(|s| s["function"]["name"] == name), "{name} spec missing");
            assert!(!tools_catalog(true).to_string().contains(name), "{name} leaked to base catalog");
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
        // SEC-1b consent gate. `consult_advisor` is added only by a per-turn
        // runtime and `local_generate` only by the external scope, but both ARE
        // exec_tool arms and must remain reserved against MCP shadowing.
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
        for p in ["prompt", "system", "schema", "temperature"] {
            assert!(f["parameters"]["properties"][p].is_object(), "missing param {p}");
        }
        // The `long` switch is gone: it selected a context tier the request builder
        // ignores, so it advertised a capability the app could not deliver.
        assert!(f["parameters"]["properties"]["long"].is_null());
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
        // Token-budget bar: a usage-only turn also flips the column non-null.
        let mut e3 = ToolEffects::default();
        e3.token_usage = Some(serde_json::json!({"total_tokens": 100, "max_context": 8192}));
        let v3 = effects_json(&e3).expect("token usage should produce effects");
        assert_eq!(v3["usage"]["total_tokens"], 100);
        assert!(v3.get("boxes").is_none() && v3.get("edits").is_none());
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
    fn dry_run_is_a_sibling_of_edits_not_nested_inside_it() {
        // A JSON schema literal is easy to mis-nest without a compile error —
        // serde_json::json! only validates syntax, not shape. Pin the actual
        // property paths so a future edit can't silently move `dry_run` inside
        // `edits.items.properties` (where a model would never see it).
        let tools = tools_catalog(false);
        let by_name = |name: &str| -> serde_json::Value {
            tools
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["function"]["name"] == name)
                .unwrap()["function"]["parameters"]
                .clone()
        };
        let edit_file = by_name("edit_file");
        assert!(edit_file["properties"]["dry_run"]["type"] == "boolean");
        let edit_files = by_name("edit_files");
        assert!(edit_files["properties"]["dry_run"]["type"] == "boolean");
        assert!(
            edit_files["properties"]["edits"]["items"]["properties"].get("dry_run").is_none(),
            "dry_run must not be nested inside one array item's own properties"
        );
        assert_eq!(edit_files["required"].as_array().unwrap(), &["edits"]);
    }

    fn planned_edit(real_name: &str, count: usize, method: EditMethod, after: &str) -> PlannedWrite {
        PlannedWrite {
            file_id: "id".into(),
            real_name: real_name.into(),
            new_bytes: Some(after.as_bytes().to_vec()),
            rename_to: None,
            method: Some(method),
            count,
            staleness: None,
            before: String::new(),
            after: after.into(),
            clipped: false,
        }
    }

    fn planned_rename(real_name: &str, new_name: &str) -> PlannedWrite {
        PlannedWrite {
            file_id: "id".into(),
            real_name: real_name.into(),
            new_bytes: None,
            rename_to: Some(new_name.into()),
            method: None,
            count: 0,
            staleness: None,
            before: format!("name: {real_name}"),
            after: format!("name: {new_name}"),
            clipped: false,
        }
    }

    #[test]
    fn dry_run_summary_reports_count_method_and_a_preview_without_claiming_a_write() {
        let plans = vec![planned_edit("notes.md", 2, EditMethod::ExactAll, "the new full text")];
        let msg = dry_run_summary(&plans);
        assert!(msg.starts_with("DRY RUN — nothing was written"), "got: {msg}");
        assert!(msg.contains("notes.md"));
        assert!(msg.contains("2 occurrence(s)"));
        assert!(msg.contains("exact_all"));
        assert!(msg.contains("the new full text"));
    }

    #[test]
    fn dry_run_summary_covers_a_rename_only_plan() {
        let plans = vec![planned_rename("old.md", "new.md")];
        let msg = dry_run_summary(&plans);
        assert!(msg.contains("old.md"));
        assert!(msg.contains("would rename to \"new.md\""));
        assert!(msg.contains("No content change"));
    }

    #[test]
    fn dry_run_summary_lists_every_file_in_a_batch() {
        let plans = vec![
            planned_edit("a.md", 1, EditMethod::Exact, "a's new text"),
            planned_rename("b.md", "c.md"),
        ];
        let msg = dry_run_summary(&plans);
        assert!(msg.contains("a.md"));
        assert!(msg.contains("a's new text"));
        assert!(msg.contains("b.md"));
        assert!(msg.contains("would rename to \"c.md\""));
    }

    #[test]
    fn dry_run_summary_clamps_a_huge_preview() {
        let plans = vec![planned_edit("big.md", 1, EditMethod::Exact, &"x".repeat(50_000))];
        let msg = dry_run_summary(&plans);
        assert!(msg.len() < 2_000, "dry run reply must stay small: {} bytes", msg.len());
    }

    #[test]
    fn image_grounding_is_blocked_only_for_a_nonlocal_model_with_the_door_on() {
        let _guard = privacy::policy_test_lock();
        privacy::clear_policy();

        // Door off (no policy attached): even a cloud model is allowed through
        // here — `active_policy()` returns None, matching every other seam.
        assert!(
            !image_grounding_blocked_by_privacy("minimax-m3:cloud"),
            "door off: this check must defer to the room's actual setting, not assume"
        );

        // Door on: a LOCAL vision model is never blocked — its pixels never
        // left the Mac in the first place.
        privacy::set_policy_for_test(true);
        assert!(!image_grounding_blocked_by_privacy("qwen2.5vl:7b"));

        // Door on + non-local model: THIS is the case that used to silently
        // fall through to `ground_prepared_image`, get no image, find no
        // boxes, and report "could not locate that in this image" — a false
        // claim about the photo instead of a true one about the setting.
        assert!(image_grounding_blocked_by_privacy("minimax-m3:cloud"));
        assert!(image_grounding_blocked_by_privacy("claude-cli::opus"));

        privacy::clear_policy();
    }

    fn job(id: &str, title: &str, status: &str, cursor: i64, total: i64) -> db::Job {
        db::Job {
            id: id.into(),
            kind: "file_pass".into(),
            title: title.into(),
            plan: serde_json::json!({}),
            state: serde_json::json!({}),
            cursor,
            total,
            status: status.into(),
            error: None,
            parent_job_id: None,
            parked_reason: None,
            created_at: "2026-08-04T00:00:00Z".into(),
            updated_at: "2026-08-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn job_status_reply_lists_every_job_with_its_short_id_when_no_filter_is_given() {
        let jobs = vec![
            job("a1b2c3d4-e5f6-0000-0000-000000000000", "Digest", "running", 2, 5),
            job("f9e8d7c6-0000-0000-0000-000000000000", "Translate book", "paused", 1, 10),
        ];
        let out = job_status_reply(&jobs, None);
        assert!(out.contains("[a1b2c3d4] Digest"), "got: {out}");
        assert!(out.contains("[f9e8d7c6] Translate book"), "got: {out}");
    }

    #[test]
    fn job_status_reply_resolves_a_short_id_to_full_detail() {
        let jobs = vec![
            job("a1b2c3d4-e5f6-0000-0000-000000000000", "Digest", "running", 2, 5),
            job("f9e8d7c6-0000-0000-0000-000000000000", "Translate book", "paused", 1, 10),
        ];
        let out = job_status_reply(&jobs, Some("a1b2c3d4"));
        assert!(out.contains("Digest"), "got: {out}");
        assert!(out.contains("2 of 5 steps done"), "got: {out}");
        assert!(!out.contains("Translate book"), "must not include the other job: {out}");
    }

    #[test]
    fn job_status_reply_accepts_the_full_id_too() {
        let jobs = vec![job("a1b2c3d4-e5f6-0000-0000-000000000000", "Digest", "running", 2, 5)];
        let out = job_status_reply(&jobs, Some("a1b2c3d4-e5f6-0000-0000-000000000000"));
        assert!(out.contains("Digest"));
    }

    #[test]
    fn job_status_reply_reports_no_match_rather_than_guessing() {
        let jobs = vec![job("a1b2c3d4-e5f6-0000-0000-000000000000", "Digest", "running", 2, 5)];
        let out = job_status_reply(&jobs, Some("zzzzzzzz"));
        assert!(out.contains("No background job matches"), "got: {out}");
    }

    #[test]
    fn job_status_reply_shows_the_parked_reason_and_error_in_full_detail() {
        let mut j = job("a1b2c3d4-e5f6-0000-0000-000000000000", "Digest", "paused", 2, 5);
        j.parked_reason = Some("The room was locked.".into());
        j.error = Some("MODEL_MISSING:qwen3.5:4b".into());
        let out = job_status_reply(&[j], Some("a1b2c3d4"));
        assert!(out.contains("The room was locked."), "got: {out}");
        assert!(out.contains("MODEL_MISSING:qwen3.5:4b"), "got: {out}");
    }

    fn memory(content: &str, category: Option<&str>) -> Memory {
        Memory {
            id: "id".into(),
            content: content.into(),
            category: category.map(str::to_string),
            created_at: "2026-08-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn format_memory_list_shows_every_note_under_the_cap() {
        let memories = vec![memory("first", None), memory("second", Some("fact"))];
        let out = format_memory_list(memories);
        assert_eq!(out, "- first\n- [fact] second");
    }

    #[test]
    fn format_memory_list_caps_and_reports_the_real_count() {
        let memories: Vec<Memory> = (0..65).map(|i| memory(&format!("note {i}"), None)).collect();
        let out = format_memory_list(memories);
        let lines: Vec<&str> = out.lines().collect();
        // 50 listed + one trailer line.
        assert_eq!(lines.len(), 51);
        assert_eq!(lines[0], "- note 0");
        assert_eq!(lines[49], "- note 49");
        assert!(lines[50].contains("…and 15 more memories"), "got: {}", lines[50]);
        // The cap must never silently drop the trailer's own count.
        assert!(!out.contains("note 50"), "the 51st note must not sneak into the list");
    }

    #[test]
    fn line_multiset_diff_counts_added_and_removed() {
        let before = "one\ntwo\nthree\n";
        let after = "one\ntwo\nfour\nfive\n";
        // "three" removed; "four" and "five" added; "one"/"two" unchanged.
        assert_eq!(line_multiset_diff(before, after), (2, 1));
        assert_eq!(line_multiset_diff("same\n", "same\n"), (0, 0));
        assert_eq!(line_multiset_diff("", "a\nb\n"), (2, 0));
        assert_eq!(line_multiset_diff("a\nb\n", ""), (0, 2));
    }

    #[test]
    fn write_file_summary_reports_added_and_removed_lines() {
        let before = "line one\nline two\nline three\n";
        let after = "line one\nline two\nline three\nline four\n";
        let msg = write_file_summary("notes.md", before, after, after.chars().count(), false);
        assert!(msg.contains("1 line(s) added"), "got: {msg}");
        assert!(msg.contains("0 line(s) removed"), "got: {msg}");
        assert!(msg.contains("+10 characters"), "got: {msg}");
        assert!(!msg.contains("dropped content"), "no shrink here: {msg}");
    }

    #[test]
    fn write_file_summary_flags_a_large_shrink() {
        let before = "x".repeat(1000);
        let after = "short replacement";
        let msg = write_file_summary("notes.md", &before, after, after.chars().count(), false);
        assert!(msg.contains("dropped content"), "got: {msg}");
    }

    #[test]
    fn write_file_summary_does_not_flag_a_small_file_shrinking() {
        // "Delete everything but the title" is an ordinary, deliberate shrink
        // on a short file — not worth a warning every time.
        let before = "Title\nOld body.";
        let after = "Title";
        let msg = write_file_summary("notes.md", before, after, after.chars().count(), false);
        assert!(!msg.contains("dropped content"), "got: {msg}");
    }

    #[test]
    fn write_file_summary_skips_the_shrink_check_on_a_clipped_comparison() {
        // A file too large for the unclipped preview shouldn't get a shrink
        // warning computed against a partial view of the original.
        let before = "x".repeat(1000);
        let after = "short";
        let msg = write_file_summary("notes.md", &before, after, after.chars().count(), true);
        assert!(!msg.contains("dropped content"), "got: {msg}");
        assert!(msg.contains("partial view"), "got: {msg}");
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

    // ------------------------------------------------- the connector seam
    //
    // `slim_schema` is the ONLY transform between a connected MCP server's
    // schema and the model. `mcp_routes` stores the slimmed copy, so both the
    // catalog and `search_mcp_tools` serve it and nothing downstream can
    // recover what was cut — every silent loss here is a capability the model
    // cannot know it has. It shipped with zero tests (2026-07-28); these are
    // that seam's contract.

    #[test]
    fn slim_keeps_a_reasonable_enum_whole() {
        // The common case must be untouched: a 12-value enum is not truncated,
        // and gains no confusing "showing N of M" note.
        let vals: Vec<serde_json::Value> =
            (0..12).map(|i| serde_json::json!(format!("v{i}"))).collect();
        let mut s = serde_json::json!({"type": "object", "properties": {
            "mode": {"type": "string", "enum": vals, "description": "pick one"}
        }});
        slim_schema(&mut s);
        let m = &s["properties"]["mode"];
        assert_eq!(m["enum"].as_array().unwrap().len(), 12);
        assert_eq!(m["description"], "pick one");
    }

    #[test]
    fn slim_announces_a_truncated_enum_instead_of_hiding_it() {
        // An enum is a CLOSED set: a silently dropped value is unreachable AND
        // invisible. Truncation must be stated so the model can ask.
        let vals: Vec<serde_json::Value> =
            (0..200).map(|i| serde_json::json!(format!("v{i}"))).collect();
        let mut s = serde_json::json!({"type": "object", "properties": {
            "region": {"type": "string", "enum": vals, "description": "where"}
        }});
        slim_schema(&mut s);
        let r = &s["properties"]["region"];
        assert_eq!(r["enum"].as_array().unwrap().len(), SCHEMA_ENUM_MAX);
        let d = r["description"].as_str().unwrap();
        assert!(d.starts_with("where"), "original description kept: {d}");
        assert!(d.contains("of 200"), "must name the real total: {d}");
        assert!(d.contains("ask the user"), "must say what to do: {d}");
    }

    #[test]
    fn slim_does_not_dismember_a_vendor_description_that_ends_in_a_paren() {
        // The note-peeling sentinel must be specific enough that ordinary
        // prose ending in a parenthesis survives untouched.
        let mut s = serde_json::json!({
            "description": "Filter results (showing archived items too)"
        });
        slim_schema(&mut s);
        assert_eq!(s["description"], "Filter results (showing archived items too)");
    }

    #[test]
    fn slim_notes_a_truncated_enum_even_with_no_description_to_append_to() {
        let vals: Vec<serde_json::Value> =
            (0..100).map(|i| serde_json::json!(i)).collect();
        let mut s = serde_json::json!({"enum": vals});
        slim_schema(&mut s);
        assert_eq!(s["enum"].as_array().unwrap().len(), SCHEMA_ENUM_MAX);
        assert!(s["description"].as_str().unwrap().contains("of 100"));
    }

    #[test]
    fn slim_marks_a_clamped_description() {
        // The failure this prevents: "Permanently deletes the record. This
        // cannot be undone." cut mid-sentence reads as the whole truth.
        let long = format!("Deletes the record. {}", "x".repeat(400));
        let mut s = serde_json::json!({"properties": {"id": {"description": long}}});
        slim_schema(&mut s);
        let d = s["properties"]["id"]["description"].as_str().unwrap();
        assert!(d.ends_with('…'), "a cut description must say it was cut: {d}");
        assert!(d.chars().count() <= SCHEMA_DESC_MAX, "len {}", d.chars().count());
    }

    #[test]
    fn slim_leaves_a_short_description_completely_alone() {
        let mut s = serde_json::json!({"description": "Send a message."});
        slim_schema(&mut s);
        assert_eq!(s["description"], "Send a message.");
    }

    #[test]
    fn slim_budgets_hebrew_in_characters_not_bytes() {
        // A byte budget silently halves non-Latin text. 120 Hebrew chars are
        // ~240 bytes and must survive a 150-CHAR budget untouched.
        let heb: String = "א".repeat(120);
        let mut s = serde_json::json!({"description": heb.clone()});
        slim_schema(&mut s);
        assert_eq!(s["description"], heb, "Hebrew must not be byte-clamped");
    }

    #[test]
    fn slim_never_splits_a_multibyte_character() {
        // Cutting mid-codepoint is a panic in the byte world; prove the char
        // world is safe at exactly the boundary.
        for n in [149usize, 150, 151, 400] {
            let heb: String = "שלום".repeat(n);
            let mut s = serde_json::json!({"description": heb});
            slim_schema(&mut s);
            let d = s["description"].as_str().unwrap();
            assert!(d.chars().count() <= SCHEMA_DESC_MAX, "n={n} len={}", d.chars().count());
            // Round-tripping proves no codepoint was severed.
            assert_eq!(d, String::from_utf8(d.as_bytes().to_vec()).unwrap());
        }
    }

    #[test]
    fn slim_keeps_default_so_the_model_knows_what_it_may_omit() {
        // Dropping `default` made a well-documented optional look like an
        // unexplained required field, and invited invented values.
        let mut s = serde_json::json!({"properties": {
            "limit": {"type": "integer", "default": 20},
            "region": {"type": "string", "default": "us-east-1"}
        }});
        slim_schema(&mut s);
        assert_eq!(s["properties"]["limit"]["default"], 20);
        assert_eq!(s["properties"]["region"]["default"], "us-east-1");
    }

    #[test]
    fn slim_keeps_additional_properties_false_and_drops_the_permissive_forms() {
        // `false` is one token that stops a small model inventing fields.
        let mut strict = serde_json::json!({"type": "object", "additionalProperties": false});
        slim_schema(&mut strict);
        assert_eq!(strict["additionalProperties"], false);

        let mut loose = serde_json::json!({"type": "object", "additionalProperties": true});
        slim_schema(&mut loose);
        assert!(loose.get("additionalProperties").is_none());

        let mut schema_form =
            serde_json::json!({"type": "object", "additionalProperties": {"type": "string"}});
        slim_schema(&mut schema_form);
        assert!(schema_form.get("additionalProperties").is_none());
    }

    #[test]
    fn slim_still_strips_the_vendor_noise_it_was_written_for() {
        let mut s = serde_json::json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$id": "x", "$comment": "internal",
            "title": "SendMessageRequest",
            "examples": [{"a": 1}], "example": {"a": 1},
            "x-google-enum-descriptions": ["..."],
            "properties": {"a": {"type": "string", "title": "A", "x-vendor": 1}}
        });
        slim_schema(&mut s);
        for k in ["$schema", "$id", "$comment", "title", "examples", "example"] {
            assert!(s.get(k).is_none(), "{k} should be stripped");
        }
        assert!(s.as_object().unwrap().keys().all(|k| !k.starts_with("x-")));
        assert!(s["properties"]["a"].get("title").is_none());
        assert!(s["properties"]["a"].get("x-vendor").is_none());
        assert_eq!(s["properties"]["a"]["type"], "string");
    }

    #[test]
    fn slim_recurses_through_nested_objects_and_arrays() {
        let long = "y".repeat(400);
        let mut s = serde_json::json!({"properties": {"items": {"type": "array", "items": {
            "type": "object", "title": "Item",
            "properties": {"deep": {"description": long, "default": 3}}
        }}}});
        slim_schema(&mut s);
        let deep = &s["properties"]["items"]["items"]["properties"]["deep"];
        assert!(deep["description"].as_str().unwrap().ends_with('…'));
        assert_eq!(deep["default"], 3, "defaults survive at depth");
        assert!(s["properties"]["items"]["items"].get("title").is_none());
    }

    #[test]
    fn slim_never_deletes_an_argument_called_title_example_or_examples() {
        // The recursion used to treat `properties` as another schema, so the
        // keyword strip ran against the connector's own ARGUMENT NAMES. Every
        // GitHub issue/PR, Notion page, Linear, Jira and Todoist create call
        // lost its `title` while `required` still demanded it, so the model
        // either omitted it or invented one.
        let mut s = serde_json::json!({
            "type": "object",
            "title": "CreateIssue",
            "properties": {
                "title": {"type": "string", "description": "Issue title"},
                "example": {"type": "string"},
                "examples": {"type": "array", "items": {"type": "string"}},
                "x-ray": {"type": "string"},
                "body": {"type": "string"}
            },
            "required": ["title", "body"]
        });
        slim_schema(&mut s);
        // The schema's OWN `title` keyword is still vendor noise and goes…
        assert!(s.get("title").is_none());
        // …but the arguments named after keywords survive intact.
        assert_eq!(s["properties"]["title"]["description"], "Issue title");
        for arg in ["title", "example", "examples", "x-ray", "body"] {
            assert!(s["properties"][arg].is_object(), "lost argument {arg}");
        }
        assert_eq!(s["required"], serde_json::json!(["title", "body"]));
    }

    #[test]
    fn slim_treats_defs_and_pattern_properties_as_name_maps_too() {
        let mut s = serde_json::json!({
            "$defs": {"title": {"type": "string", "title": "T"}},
            "patternProperties": {"^x-": {"type": "string", "title": "P"}}
        });
        slim_schema(&mut s);
        // The named entries survive; the keyword INSIDE each one is stripped.
        assert_eq!(s["$defs"]["title"]["type"], "string");
        assert!(s["$defs"]["title"].get("title").is_none());
        assert_eq!(s["patternProperties"]["^x-"]["type"], "string");
        assert!(s["patternProperties"]["^x-"].get("title").is_none());
    }

    #[test]
    fn slim_is_idempotent() {
        // Routes are rebuilt per turn; slimming an already-slim schema must not
        // keep chewing (an ellipsis on an ellipsis, a note on a note).
        let vals: Vec<serde_json::Value> =
            (0..200).map(|i| serde_json::json!(format!("v{i}"))).collect();
        let mut once = serde_json::json!({"properties": {
            "r": {"enum": vals, "description": "z".repeat(400)}
        }});
        slim_schema(&mut once);
        let mut twice = once.clone();
        slim_schema(&mut twice);
        assert_eq!(once, twice, "slimming twice must equal slimming once");
    }

    // ------------------------------------------- required-argument guard
    //
    // Every exec_tool arm reads arguments with `unwrap_or_default()`, so a
    // missing required string used to arrive as `""` and keep going. The file
    // resolver is `LIKE '%' || ?1 || '%' … ORDER BY created_at DESC LIMIT 1`,
    // so `""` matches THE NEWEST FILE IN THE ROOM: `open_file({})` opened it,
    // and `edit_file` with matching text edited it. A wrong-target write, with
    // no error anywhere. Validated centrally against each tool's own schema.

    #[test]
    fn a_missing_required_name_is_refused_not_resolved_to_the_newest_file() {
        let err = missing_required_arg("open_file", &serde_json::json!({})).unwrap();
        assert!(err.contains("name is required"), "got: {err}");
        // The schema's own description becomes the hint the model acts on.
        assert!(err.contains("File name or a distinctive part of it"), "got: {err}");
        assert!(err.contains("Nothing was done"), "got: {err}");
    }

    #[test]
    fn a_blank_or_whitespace_string_counts_as_missing() {
        // `""` is the exact value `unwrap_or_default()` produced, and `"   "`
        // is what a model emits when it knows it is guessing.
        for bad in ["", "   ", "\n\t"] {
            assert!(
                missing_required_arg("open_file", &serde_json::json!({"name": bad})).is_some(),
                "{bad:?} should not count as a supplied name"
            );
        }
        assert!(
            missing_required_arg("open_file", &serde_json::json!({"name": "lease.pdf"})).is_none()
        );
    }

    #[test]
    fn null_is_missing_too() {
        assert!(
            missing_required_arg("open_file", &serde_json::json!({"name": null})).is_some()
        );
    }

    #[test]
    fn the_guard_names_the_first_missing_argument_of_several() {
        let err = missing_required_arg("edit_file", &serde_json::json!({"name": "a.md"})).unwrap();
        assert!(err.contains("old_text is required"), "got: {err}");
        let err2 = missing_required_arg(
            "edit_file",
            &serde_json::json!({"name": "a.md", "old_text": "x"}),
        )
        .unwrap();
        assert!(err2.contains("new_text is required"), "got: {err2}");
        assert!(missing_required_arg(
            "edit_file",
            &serde_json::json!({"name": "a.md", "old_text": "x", "new_text": "y"})
        )
        .is_none());
    }

    #[test]
    fn empty_containers_are_missing_but_zero_and_false_are_not() {
        // An empty array is a no-op batch; an empty object is not a config.
        assert!(missing_required_arg("edit_files", &serde_json::json!({"edits": []})).is_some());
        assert!(
            missing_required_arg("save_mcp", &serde_json::json!({"name": "x", "config": {}}))
                .is_some()
        );
        // ...but a numeric 0 is a real value and must pass. ui_act's `mark` is
        // an integer, and mark 0 is a legitimate control.
        assert!(missing_required_arg(
            "ui_act",
            &serde_json::json!({"mark": 0, "action": "click"})
        )
        .is_none());
    }

    #[test]
    fn well_formed_calls_are_never_blocked() {
        // The guard must be invisible in normal operation.
        for (tool, args) in [
            ("search_room", serde_json::json!({"query": "rent"})),
            ("list_room_files", serde_json::json!({})),
            ("list_memories", serde_json::json!({})),
            ("create_file", serde_json::json!({"name": "a.md", "content": "hi"})),
            ("rename_file", serde_json::json!({"name": "a", "new_name": "b"})),
            // An empty folder string is the DOCUMENTED way to move to the top
            // level, so `move_file` must not be caught by the blank-string rule.
            ("move_file", serde_json::json!({"name": "a", "folder": ""})),
            ("add_memory", serde_json::json!({"content": "likes tea"})),
            ("start_file_pass", serde_json::json!({"name": "b.pdf", "instruction": "sum"})),
            ("web_search", serde_json::json!({"query": "weather"})),
            ("run_script", serde_json::json!({"name": "x.py"})),
            ("save_workflow", serde_json::json!({"name": "w", "definition": {"version": 1}})),
        ] {
            assert!(
                missing_required_arg(tool, &args).is_none(),
                "{tool} wrongly rejected: {:?}",
                missing_required_arg(tool, &args)
            );
        }
    }

    #[test]
    fn an_empty_string_is_honoured_where_the_schema_documents_it() {
        // `move_file`'s own description says "empty string for the top level",
        // so `""` is an instruction, not an omission. Absent or null still is.
        assert!(missing_required_arg(
            "move_file",
            &serde_json::json!({"name": "a.md", "folder": ""})
        )
        .is_none());
        assert!(
            missing_required_arg("move_file", &serde_json::json!({"name": "a.md"})).is_some(),
            "an ABSENT folder is still a failure"
        );
        assert!(
            missing_required_arg(
                "move_file",
                &serde_json::json!({"name": "a.md", "folder": null})
            )
            .is_some(),
            "a NULL folder is still a failure"
        );
    }

    #[test]
    fn the_empty_string_exception_list_stays_honest() {
        // Every entry must name a real tool, a real REQUIRED param of it, and
        // that param must actually document the empty case — otherwise the
        // exception is a silent hole in the guard.
        for (tool, key) in EMPTY_STRING_IS_MEANINGFUL {
            let schema = builtin_param_schemas()
                .get(*tool)
                .unwrap_or_else(|| panic!("{tool} is not a real tool"));
            let required: Vec<&str> = schema["required"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            assert!(required.contains(key), "{tool}.{key} is not a required param");
            let desc = schema["properties"][key]["description"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase();
            assert!(
                desc.contains("empty"),
                "{tool}.{key} claims an empty-string meaning its description \
                 never documents: {desc:?}"
            );
        }
    }

    #[test]
    fn connected_mcp_tools_are_not_our_contract_to_enforce() {
        // A connector's own schema governs its calls; we must not invent one.
        assert!(missing_required_arg("someserver_do_thing", &serde_json::json!({})).is_none());
    }

    #[test]
    fn every_advertised_required_argument_is_actually_enforced() {
        // The sweep: for every built-in tool, dropping each required argument
        // in turn must be refused. This is what makes the guard exhaustive —
        // a tool added tomorrow with a new required field is covered without
        // anyone remembering to write a test.
        for (tool, schema) in builtin_param_schemas() {
            let Some(required) = schema.get("required").and_then(|r| r.as_array()) else {
                continue;
            };
            // A plausible full argument set for this tool, from its own schema.
            let mut full = serde_json::Map::new();
            for entry in required {
                let key = entry.as_str().unwrap();
                let ty = schema
                    .get("properties")
                    .and_then(|p| p.get(key))
                    .and_then(|p| p.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("string");
                full.insert(
                    key.to_string(),
                    match ty {
                        "array" => serde_json::json!([{"placeholder": true}]),
                        "object" => serde_json::json!({"placeholder": true}),
                        "integer" | "number" => serde_json::json!(1),
                        "boolean" => serde_json::json!(true),
                        _ => serde_json::json!("x"),
                    },
                );
            }
            assert!(
                missing_required_arg(tool, &serde_json::Value::Object(full.clone())).is_none(),
                "{tool}: a complete argument set was rejected"
            );
            for entry in required {
                let key = entry.as_str().unwrap();
                let mut missing = full.clone();
                missing.remove(key);
                assert!(
                    missing_required_arg(tool, &serde_json::Value::Object(missing)).is_some(),
                    "{tool}: dropping required `{key}` was NOT refused"
                );
            }
        }
    }

    #[test]
    fn a_cell_reference_past_the_grid_is_refused_before_any_write() {
        // A write GROWS the sheet until it reaches the cell, with no bound of
        // its own: `A5000000` saved five million blank rows and a bigger one
        // took the app down with nothing saved and no message.
        // The grid's own far corner is still writable.
        let ok = [("A1".into(), "x".into()), ("XFD1048576".into(), "y".into())];
        assert!(validate_cell_refs(&ok).is_ok());

        // Nothing past it is, whichever axis overshoots.
        for bad in ["A1048577", "XFE1", "ZZZ1", "A99999999999", "AAAAA1"] {
            assert!(
                validate_cell_refs(&[(bad.into(), "x".into())]).is_err(),
                "{bad} was accepted"
            );
        }
        // The COLUMN ceiling is this function's own: `parse_a1` bounds the row
        // and the letter count, and `XFE`/`ZZZ` pass both while naming a column
        // no sheet has.
        let err = validate_cell_refs(&[("XFE1".into(), "x".into())]).unwrap_err();
        assert!(err.contains("outside the spreadsheet grid"), "{err}");
        assert!(err.contains("Nothing was changed"), "{err}");
        // A non-reference still fails with its own, different message.
        let err = validate_cell_refs(&[("row seven".into(), "x".into())]).unwrap_err();
        assert!(err.contains("is not a cell"), "{err}");
    }

    /// The notices and the predicate that recognises them live in one place so
    /// they cannot drift; this is what holds that. If someone rewords a notice
    /// without updating `is_failure_notice`, the memory suggester silently goes
    /// back to treating "the reply was lost" as an answer worth remembering.
    #[test]
    fn failure_notices_are_recognised_by_their_own_predicate() {
        assert!(is_failure_notice(LOST_REPLY_CLEAN));
        assert!(is_failure_notice(LOST_REPLY_AFTER_WRITE));
        assert!(is_failure_notice(LOST_REPLY_WITH_JOB));
        let mid_run = format!(
            "*(The agent {STOPPED_MID_RUN}: boom. Any change shown here was already applied.)*"
        );
        assert!(is_failure_notice(&mid_run));
        // A real answer is never mistaken for one — including one that merely
        // TALKS about a failed agent.
        assert!(!is_failure_notice("Revenue is $1.2M in one note and $900K in the other."));
        assert!(!is_failure_notice("The agent hit an error and stopped mid-run, apparently."));
        assert!(!is_failure_notice(""));
    }

    /// The half of the pair that was actually false in the field.
    #[test]
    fn the_after_write_notice_never_claims_nothing_was_written() {
        assert!(!LOST_REPLY_AFTER_WRITE.contains("nothing was written"));
        assert!(LOST_REPLY_AFTER_WRITE.contains("already applied"));
        // ...and the clean one still says it, because there it is true.
        assert!(LOST_REPLY_CLEAN.contains("nothing was written"));
    }

    /// The other half, found by the owner's 2026-08-03 retest: "Please try
    /// again" is an INSTRUCTION, and it was handed out unconditionally — with a
    /// background job from the same turn still running behind it. Only the
    /// notice that knows no work is live may issue it.
    #[test]
    fn the_retry_instruction_is_withheld_while_background_work_is_live() {
        assert!(LOST_REPLY_CLEAN.contains("Please try again"));
        assert!(!LOST_REPLY_WITH_JOB.contains("Please try again"));
        assert!(LOST_REPLY_WITH_JOB.contains("still running"));
        assert!(LOST_REPLY_WITH_JOB.contains("Jobs list"));
        // Still true here, and still said: no write committed on this path.
        assert!(LOST_REPLY_WITH_JOB.contains("nothing was written"));
    }

    /// The frontend recovery strip (`markup.ts` `lostReplyNotice`) matches on
    /// these exact fragments to decide when to offer Try again — it cannot
    /// import a Rust constant, so this is the contract between the two.
    #[test]
    fn the_notices_keep_the_fragments_the_chat_ui_matches_on() {
        for notice in [LOST_REPLY_CLEAN, LOST_REPLY_AFTER_WRITE, LOST_REPLY_WITH_JOB] {
            assert!(notice.starts_with("*(The agent "), "{notice}");
            assert!(
                notice.contains("the reply was lost before it reached the app"),
                "{notice}"
            );
        }
    }

    #[test]
    fn clamp_marked_trims_a_dangling_separator_before_the_marker() {
        assert_eq!(clamp_marked("abcd, efg".into(), 6), "abcd…");
        // Already short enough: untouched, no marker.
        assert_eq!(clamp_marked("abc".into(), 6), "abc");
        // Exactly at the budget: untouched.
        assert_eq!(clamp_marked("abcdef".into(), 6), "abcdef");
    }

    /// Live report 2026-07-30: the Web agent failed on finance.yahoo.com every
    /// time. `fetch_page` returned `chars[start..]` — the whole remainder —
    /// while its own schema told the model "if the result is truncated, call
    /// again with the start value from the truncation notice". The protocol was
    /// declared and never implemented, and nothing downstream could undo it on
    /// a cloud room.
    #[test]
    fn a_fetched_page_comes_back_one_window_at_a_time() {
        let text: String = "x".repeat(FETCH_PAGE_WINDOW * 2 + 500);
        let first = fetch_page_window("T", "https://e.com", &text, 0);
        assert!(
            first.chars().count() < FETCH_PAGE_WINDOW + 500,
            "a whole heavy page went out in one tool result: {} chars",
            first.chars().count()
        );
        // The continuation the schema promises, with the offset to resume at.
        assert!(first.contains(&format!("start {FETCH_PAGE_WINDOW}")), "{first:.400}");

        // ...and following it walks to the end, losing nothing.
        let second = fetch_page_window("T", "https://e.com", &text, FETCH_PAGE_WINDOW);
        assert!(second.contains(&format!("start {}", FETCH_PAGE_WINDOW * 2)));
        let last = fetch_page_window("T", "https://e.com", &text, FETCH_PAGE_WINDOW * 2);
        assert!(
            !last.contains("call fetch_page"),
            "the final window still claims there is more: {last:.200}"
        );
    }

    #[test]
    fn a_short_page_is_returned_whole_with_no_truncation_notice() {
        let out = fetch_page_window("Title", "https://e.com", "hello", 0);
        assert_eq!(out, "[Title] https://e.com\n\nhello");
    }

    #[test]
    fn fetch_page_reply_notes_a_redirect_the_model_never_asked_for() {
        let out = fetch_page_reply(
            "Title",
            "https://short.link/x",
            "hello",
            0,
            Some("https://real-site.com/full-article"),
        );
        assert!(out.starts_with("(Redirected to https://real-site.com/full-article)\n"), "{out}");
        assert!(out.contains("hello"));
    }

    #[test]
    fn fetch_page_reply_adds_no_note_for_an_ordinary_fetch_or_a_cache_hit() {
        // No redirect (or a cache hit, which never has redirect info either):
        // identical to fetch_page_window, byte for byte — no pointless noise
        // on the common case.
        let plain = fetch_page_reply("Title", "https://e.com", "hello", 0, None);
        assert_eq!(plain, fetch_page_window("Title", "https://e.com", "hello", 0));
    }

    #[test]
    fn a_start_past_the_end_of_a_page_does_not_panic() {
        let out = fetch_page_window("T", "https://e.com", "short", 9_000);
        assert!(!out.contains("call fetch_page"), "{out}");
    }

    /// The window is measured in CHARS, so a Hebrew page must not be sliced
    /// mid-codepoint — `chars[start..end]` is safe, a byte slice would panic.
    #[test]
    fn a_multibyte_page_is_windowed_on_character_boundaries() {
        let text: String = "שלום ".repeat(FETCH_PAGE_WINDOW);
        let out = fetch_page_window("כותרת", "https://e.co.il", &text, 0);
        assert!(out.contains("שלום"));
        assert!(out.contains(&format!("start {FETCH_PAGE_WINDOW}")));
    }
}
