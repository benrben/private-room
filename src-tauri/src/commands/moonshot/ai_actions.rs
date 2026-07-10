use super::*;

// ---- D5 / D12: studios (flashcards, mind map, podcast script) ---------------

/// One AI action's full definition. The `system`/`default_prompt` are baked in;
/// the frontend never sees `system` — only the six `AiActionDef` fields below.
pub(crate) struct AiActionSpec {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    scope: &'static str, // "file" | "room"
    needs_question: bool, // true only for "research"
    /// ADD-27: true only for "translate" — the modal asks for a target
    /// language, delivered through the same `question` parameter.
    needs_language: bool,
    default_prompt: &'static str,
    system: &'static str,
}

/// The 14 actions, in menu order: 9 file-scope, then 5 room-scope. Order and the
/// scope/needs_question flags are the cross-agent contract with the frontend.
pub(crate) const AI_ACTIONS: &[AiActionSpec] = &[
    // ---- file scope ----
    AiActionSpec {
        id: "summarize",
        title: "Summarize",
        description: "A one-line TL;DR and the key points.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Summarize this material: a one-line TL;DR, then the key points as a short list.",
        system: "You summarize material into a single tight TL;DR line followed by a short list of \
                 its key points. Base everything only on the provided text and add nothing that \
                 isn't there.",
    },
    AiActionSpec {
        id: "analyze",
        title: "Analyze",
        description: "Structure, themes, sentiment, risks, and open questions.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Analyze this material: its structure, main themes, sentiment, risks, and open questions.",
        system: "You analyze material and lay it out under clear markdown sections: Structure, \
                 Themes, Sentiment, Risks, and Open questions. Base everything only on the provided \
                 text.",
    },
    AiActionSpec {
        id: "explain",
        title: "Explain",
        description: "A plain-language walkthrough of the material.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Explain this material in plain language, as if to a smart friend new to the topic.",
        system: "You explain material in plain, jargon-free language — a clear walkthrough a \
                 newcomer can follow, defining any terms the text relies on. Base everything only \
                 on the provided text.",
    },
    AiActionSpec {
        id: "extract",
        title: "Extract",
        description: "Entities, dates, figures, and action items as a table.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Extract the entities, dates, figures, and action items from this material.",
        system: "You extract the key entities, dates, figures, and action items from material and \
                 present them as a single markdown table with columns Type, Detail, and Context. \
                 Base every row only on the provided text — never invent entries.",
    },
    AiActionSpec {
        id: "outline",
        title: "Outline",
        description: "A clean nested outline of the points.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Turn this material into a clean, nested outline of its points.",
        system: "You turn material into a clean, nested markdown outline (bullets and sub-bullets) \
                 that mirrors its structure. Base everything only on the provided text.",
    },
    AiActionSpec {
        id: "rewrite",
        title: "Rewrite",
        description: "A tightened, clearer version.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Rewrite this material into a tighter, clearer version that keeps every point.",
        system: "You rewrite material into a tighter, clearer version that keeps all of its meaning \
                 and points but drops the padding. Base everything only on the provided text and add \
                 no new claims.",
    },
    AiActionSpec {
        id: "qa_pack",
        title: "Q&A pack",
        description: "Study question-and-answer pairs.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Write a set of study question-and-answer pairs covering this material.",
        system: "You write study question-and-answer pairs that test real understanding of the \
                 material. Format each as a bold question line followed by its answer. Base every \
                 pair only on the provided text.",
    },
    AiActionSpec {
        id: "fact_check",
        title: "Fact check",
        description: "Flag claims the material doesn't support.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Fact-check this material and flag any claim it doesn't actually support.",
        system: "You fact-check material against itself: list its main claims and flag any that are \
                 unsupported, internally contradicted, or overstated by the text. Judge only against \
                 the provided material — never outside knowledge. Present the result as a markdown \
                 table with columns Claim, Verdict, and Why.",
    },
    // ADD-27: translate any file (including a recording's transcript) into a
    // user-picked language. The language rides in the `question` parameter.
    AiActionSpec {
        id: "translate",
        title: "Translate",
        description: "Translate the material into any language.",
        scope: "file",
        needs_question: false,
        needs_language: true,
        default_prompt: "Translate this material into the target language, keeping its structure.",
        system: "You are a careful translator. Translate the user's material into the requested \
                 target language. Preserve the document structure (headings, lists, tables) and \
                 the exact meaning and tone; keep any [m:ss] timestamps and speaker names \
                 exactly as they appear in the source. Output only the translation.",
    },
    // ---- room scope ----
    AiActionSpec {
        id: "research",
        title: "Research",
        description: "Answer a question with a cited synthesis of the room.",
        scope: "room",
        needs_question: true,
        needs_language: false,
        default_prompt: "Answer the question using this room, and cite the files you draw on.",
        system: "You answer a specific question by synthesizing across the room's material, citing \
                 the file each point comes from (by its heading). If the material doesn't answer the \
                 question, say so plainly. Base everything only on the provided text.",
    },
    AiActionSpec {
        id: "compare",
        title: "Compare",
        description: "Diff the files side by side.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Compare these files side by side — what they agree on and where they differ.",
        system: "You compare the provided files side by side: what they share, where they differ, \
                 and any outright contradictions. Use a markdown table where it helps. Base \
                 everything only on the provided text.",
    },
    AiActionSpec {
        id: "timeline",
        title: "Timeline",
        description: "A chronology from the dated mentions.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Build a chronological timeline from the dated events mentioned in this material.",
        system: "You build a chronological timeline from the dated events mentioned in the material, \
                 earliest first, as a markdown table with columns Date, Event, and Source. Include \
                 only dates the text actually states. Base everything only on the provided text.",
    },
    AiActionSpec {
        id: "themes",
        title: "Themes",
        description: "Group the material into topic clusters.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Group this material into its main themes, with the points under each.",
        system: "You group material into its main themes or topic clusters, listing the supporting \
                 points under each as a markdown outline. Base everything only on the provided text.",
    },
    AiActionSpec {
        id: "gaps",
        title: "Gaps",
        description: "What's missing given the rest of the room.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Given this room, point out what's missing or still unanswered.",
        system: "You identify gaps: questions the material raises but doesn't answer, and the topics \
                 it would still need to be complete. Be specific and grounded — no generic advice. \
                 Base everything only on the provided text.",
    },
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiActionDef {
    pub id: String,
    pub title: String,
    pub description: String,
    pub scope: String, // "file" | "room"
    pub needs_question: bool, // true only for "research"
    /// ADD-27: the modal shows a target-language picker (true for "translate").
    pub needs_language: bool,
    pub default_prompt: String,
}

/// The catalog of AI actions for the frontend menu — the same list `ai_action`
/// runs, minus the internal system prompts. Order is the contract (8 file, then
/// 5 room), and `needs_question` is true only for `research`.
#[tauri::command]
pub fn ai_action_prompts() -> Vec<AiActionDef> {
    AI_ACTIONS
        .iter()
        .map(|s| AiActionDef {
            id: s.id.into(),
            title: s.title.into(),
            description: s.description.into(),
            scope: s.scope.into(),
            needs_question: s.needs_question,
            needs_language: s.needs_language,
            default_prompt: s.default_prompt.into(),
        })
        .collect()
}

/// Run one AI action over a scope (or explicit @-refs) and save the Markdown
/// result into the room, returning its FileMeta. Mirrors `studio_flashcards`:
/// `refs` win over `scope`, the model-down message is identical, and the same
/// two events fire so the UI opens the new file. `question` is only used by
/// `research`; `instructions` overrides the action's default prompt.
#[tauri::command]
pub async fn ai_action(
    window: tauri::Window,
    state: State<'_, AppState>,
    action: String,
    scope: Option<String>,
    refs: Option<Vec<String>>,
    instructions: Option<String>,
    question: Option<String>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let spec = AI_ACTIONS
        .iter()
        .find(|s| s.id == action)
        .ok_or_else(|| format!("\"{action}\" isn't a known AI action."))?;
    let instr = studio_instruction(instructions, spec.default_prompt);
    let (label, text) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids)?,
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name)?,
        }
    };
    let model = resolve_local_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    let _ = window.emit("ask-step", spec.title);
    // A single-field markdown envelope: the model writes free-form Markdown into
    // one constrained string, so any action (tables, outlines, prose) fits.
    let schema = serde_json::json!({
        "type": "object",
        "properties": { "markdown": {"type": "string"} },
        "required": ["markdown"]
    });
    // Always ground the model in the gathered text; `research` also folds in the
    // user's question.
    let base = format!("Base everything only on this material:\n\n{text}");
    let ask = question.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let user = match ask {
        Some(q) if spec.needs_question => format!("{instr}\n\nQuestion: {q}\n\n{base}"),
        // ADD-27: for "translate" the question field carries the target language.
        Some(q) if spec.needs_language => format!("{instr}\n\nTarget language: {q}\n\n{base}"),
        None if spec.needs_language => {
            return Err("Pick a target language first.".into());
        }
        _ => format!("{instr}\n\n{base}"),
    };
    let messages = vec![
        ollama::ChatMessage::new("system", spec.system),
        ollama::ChatMessage::new("user", user),
    ];
    let raw = ollama::chat_structured(&model, messages, Some(0.3), KEEP_ALIVE_WARM, &schema).await?;
    let content = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| v.get("markdown").and_then(|m| m.as_str()).map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("The model didn't return anything usable — try a different file.")?;
    let name = format!("{} - {}.md", spec.title, safe_scope_name(&label));
    let meta = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::insert_file(&room.conn, &name, "text/markdown", content.as_bytes(), Some(&content), "generated")?
    };
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
}

// ---- D6: memory suggestion --------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemorySuggestion {
    pub worth: bool,
    pub fact: String,
}

/// D6: after an exchange, judge whether a single durable fact is worth saving to
/// the room's long-term memory. Never writes memory itself (the frontend confirms,
/// then calls the existing `add_memory`). Model down / no exchange → not worth.
#[tauri::command]
pub async fn memory_suggestion(
    state: State<'_, AppState>,
    chat_id: String,
) -> Result<MemorySuggestion, String> {
    let (last_user, last_assistant) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let msgs = db::list_messages(&room.conn, &chat_id)?;
        let u = msgs.iter().rev().find(|m| m.role == "user").map(|m| strip_markup_blocks(&m.content));
        let a =
            msgs.iter().rev().find(|m| m.role == "assistant").map(|m| strip_markup_blocks(&m.content));
        (u, a)
    };
    let (Some(u), Some(a)) = (last_user, last_assistant) else {
        return Ok(MemorySuggestion { worth: false, fact: String::new() });
    };
    let model = match resolve_local_model(&state).await {
        Some(m) => m,
        None => return Ok(MemorySuggestion { worth: false, fact: String::new() }),
    };
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "worth_remembering": {"type": "boolean"},
            "fact": {"type": "string"}
        },
        "required": ["worth_remembering", "fact"]
    });
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You decide whether a single durable fact about the user or their world is worth \
             saving to this room's long-term memory. Only lasting, reusable facts count — not \
             one-off task details or general knowledge. If worth remembering, phrase it as one \
             short standalone sentence.",
        ),
        ollama::ChatMessage::new(
            "user",
            format!(
                "User asked:\n{}\n\nAssistant answered:\n{}",
                clamp_bytes(u, 2000),
                clamp_bytes(a, 2000)
            ),
        ),
    ];
    let raw = ollama::chat_structured(&model, messages, Some(0.2), KEEP_ALIVE_WARM, &schema)
        .await
        .unwrap_or_default();
    let parsed = serde_json::from_str::<serde_json::Value>(raw.trim()).ok();
    let worth = parsed
        .as_ref()
        .and_then(|v| v.get("worth_remembering"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let fact = parsed
        .as_ref()
        .and_then(|v| v.get("fact"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(MemorySuggestion {
        worth: worth && !fact.is_empty(),
        fact,
    })
}

// ---- D7: suggest file metadata ---------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMetaSuggestion {
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
}

/// D7: propose a tidy title, one folder, and a few tags for a file, over the
/// first ~2000 chars of its text. Suggestion only — the frontend applies it via
/// the existing rename/folder/move commands. Model down / no text → echo the
/// current name with an empty folder and no tags.
#[tauri::command]
pub async fn suggest_file_meta(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<FileMetaSuggestion, String> {
    let (current_name, text) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let name = db::get_file_name(&room.conn, &file_id)?;
        let text = db::get_file_extracted_text(&room.conn, &file_id).unwrap_or_default();
        (name, text)
    };
    let echo = || FileMetaSuggestion {
        title: title_from_name(&current_name),
        folder: String::new(),
        tags: Vec::new(),
    };
    if text.trim().is_empty() {
        return Ok(echo());
    }
    let model = match resolve_local_model(&state).await {
        Some(m) => m,
        None => return Ok(echo()),
    };
    let snippet = clamp_bytes(text, 2000);
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "folder": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["title", "folder", "tags"]
    });
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You propose tidy metadata for a document: a short human title, one broad folder name \
             to file it under, and up to five short lowercase tags. Base everything on the text; \
             keep it concise.",
        ),
        ollama::ChatMessage::new(
            "user",
            format!("Current file name: {current_name}\n\nBeginning of the text:\n{snippet}"),
        ),
    ];
    let raw = ollama::chat_structured(&model, messages, Some(0.3), KEEP_ALIVE_WARM, &schema)
        .await
        .unwrap_or_default();
    let Some(v) = serde_json::from_str::<serde_json::Value>(raw.trim()).ok() else {
        return Ok(echo());
    };
    let title = v.get("title").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    let folder = v.get("folder").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    let tags: Vec<String> = v
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase()))
                .filter(|s| !s.is_empty())
                .take(5)
                .collect()
        })
        .unwrap_or_default();
    Ok(FileMetaSuggestion {
        title: if title.is_empty() { title_from_name(&current_name) } else { title },
        folder,
        tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_action_prompts_lists_the_fourteen_actions_with_right_scope() {
        let defs = ai_action_prompts();
        // Exactly the 14 ids, in the contract's menu order.
        let ids: Vec<&str> = defs.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                // file scope
                "summarize", "analyze", "explain", "extract", "outline", "rewrite", "qa_pack",
                "fact_check", "translate", // room scope
                "research", "compare", "timeline", "themes", "gaps",
            ]
        );
        assert_eq!(defs.len(), 14);
        // First 9 are file scope, last 5 are room scope.
        for d in defs.iter().take(9) {
            assert_eq!(d.scope, "file", "{} should be file scope", d.id);
        }
        for d in defs.iter().skip(9) {
            assert_eq!(d.scope, "room", "{} should be room scope", d.id);
        }
        // ADD-27: only `translate` asks for a target language.
        for d in &defs {
            assert_eq!(d.needs_language, d.id == "translate", "{} needs_language", d.id);
        }
        // Only `research` asks a follow-up question, and every action ships a
        // non-empty default prompt.
        for d in &defs {
            assert_eq!(d.needs_question, d.id == "research", "{} needs_question", d.id);
            assert!(!d.default_prompt.trim().is_empty(), "{} needs a default prompt", d.id);
        }
    }
}
