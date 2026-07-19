use super::*;

// ---- D5 / D12: studios (flashcards, mind map, podcast script) ---------------

/// One AI action's full definition. The `default_prompt` is baked in; the frontend
/// sees only the `AiActionDef` fields below. MIGRATION Phase 3: the per-action
/// system prompt now lives in the sidecar's /ai_action prompt table (keyed by `id`).
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
    },
    AiActionSpec {
        id: "analyze",
        title: "Analyze",
        description: "Structure, themes, sentiment, risks, and open questions.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Analyze this material: its structure, main themes, sentiment, risks, and open questions.",
    },
    AiActionSpec {
        id: "explain",
        title: "Explain",
        description: "A plain-language walkthrough of the material.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Explain this material in plain language, as if to a smart friend new to the topic.",
    },
    AiActionSpec {
        id: "extract",
        title: "Extract",
        description: "Entities, dates, figures, and action items as a table.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Extract the entities, dates, figures, and action items from this material.",
    },
    AiActionSpec {
        id: "outline",
        title: "Outline",
        description: "A clean nested outline of the points.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Turn this material into a clean, nested outline of its points.",
    },
    AiActionSpec {
        id: "rewrite",
        title: "Rewrite",
        description: "A tightened, clearer version.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Rewrite this material into a tighter, clearer version that keeps every point.",
    },
    AiActionSpec {
        id: "qa_pack",
        title: "Q&A pack",
        description: "Study question-and-answer pairs.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Write a set of study question-and-answer pairs covering this material.",
    },
    AiActionSpec {
        id: "fact_check",
        title: "Fact check",
        description: "Flag claims the material doesn't support.",
        scope: "file",
        needs_question: false,
        needs_language: false,
        default_prompt: "Fact-check this material and flag any claim it doesn't actually support.",
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
    },
    AiActionSpec {
        id: "compare",
        title: "Compare",
        description: "Diff the files side by side.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Compare these files side by side — what they agree on and where they differ.",
    },
    AiActionSpec {
        id: "timeline",
        title: "Timeline",
        description: "A chronology from the dated mentions.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Build a chronological timeline from the dated events mentioned in this material.",
    },
    AiActionSpec {
        id: "themes",
        title: "Themes",
        description: "Group the material into topic clusters.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Group this material into its main themes, with the points under each.",
    },
    AiActionSpec {
        id: "gaps",
        title: "Gaps",
        description: "What's missing given the rest of the room.",
        scope: "room",
        needs_question: false,
        needs_language: false,
        default_prompt: "Given this room, point out what's missing or still unanswered.",
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
    let (label, text) = state.with_room(|room| {
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids),
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name),
        }
    })?;
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    let _ = window.emit("ask-step", spec.title);
    // MIGRATION Phase 3: the 14-action prompt table (system prompts), the
    // user-message assembly (grounding + research's `question`/translate's target
    // language), the schema, the model call and the markdown extraction all live in
    // the sidecar's /ai_action. Rust keeps the DB gather, model resolution, the
    // `ask-step` emit, and the save (filename uses `spec.title`, which stays here).
    // `instr` is the resolved-or-default prompt; the endpoint takes it verbatim.
    let body = serde_json::json!({
        "model": model,
        "action": spec.id,
        "text": text,
        "instructions": instr,
        "question": question,
        "base_url": ollama::resolved_base_url(),
    });
    // NEEDS_LANGUAGE / EMPTY_RESULT / UNKNOWN_ACTION carry the exact toast string as
    // `error` — surface it verbatim (a new branch, not the "Local AI error" wrapper),
    // preserving the current `Err(String)` surfaces; any real engine failure maps to
    // the usual OLLAMA_DOWN / MODEL_MISSING:<model> sentinel.
    let v = crate::sidecar::sidecar_json("/ai_action", &body)
        .await
        .map_err(|e| match e.code.as_str() {
            "UNKNOWN_ACTION" | "NEEDS_LANGUAGE" | "EMPTY_RESULT" => e.error.clone(),
            _ => e.sentinel(Some(&model)),
        })?;
    let content = v["markdown"].as_str().unwrap_or_default().to_string();
    let name = format!("{} - {}.md", spec.title, safe_scope_name(&label));
    save_and_open(&window, &state, &name, "text/markdown", &content, "generated")
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
    let (last_user, last_assistant) = state.with_room(|room| {
        let msgs = db::list_messages(&room.conn, &chat_id)?;
        let u = msgs.iter().rev().find(|m| m.role == "user").map(|m| strip_markup_blocks(&m.content));
        let a =
            msgs.iter().rev().find(|m| m.role == "assistant").map(|m| strip_markup_blocks(&m.content));
        Ok((u, a))
    })?;
    let (Some(u), Some(a)) = (last_user, last_assistant) else {
        return Ok(MemorySuggestion { worth: false, fact: String::new() });
    };
    let model = match resolve_structured_model(&state).await {
        Some(m) => m,
        None => return Ok(MemorySuggestion { worth: false, fact: String::new() }),
    };
    // MIGRATION Phase 3: the prompt, schema, model call and the "worth only if the
    // model flagged it AND wrote a non-empty fact" rule live in the sidecar's
    // /memory_suggestion (which also clamps each text to 2000 bytes for the prompt).
    // Rust keeps the DB read + the message-absence short-circuit above. Like the old
    // `chat_structured(...).unwrap_or_default()`, an engine failure degrades to
    // not-worth rather than surfacing an error.
    let body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "user_text": u,
        "assistant_text": a,
    });
    match crate::sidecar::sidecar_json("/memory_suggestion", &body).await {
        Ok(v) => Ok(MemorySuggestion {
            worth: v["worth"].as_bool().unwrap_or(false),
            fact: v["fact"].as_str().unwrap_or_default().to_string(),
        }),
        Err(_) => Ok(MemorySuggestion { worth: false, fact: String::new() }),
    }
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
    let (current_name, text) = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &file_id)?;
        let text = db::get_file_extracted_text(&room.conn, &file_id).unwrap_or_default();
        Ok((name, text))
    })?;
    let echo = || FileMetaSuggestion {
        title: title_from_name(&current_name),
        folder: String::new(),
        tags: Vec::new(),
    };
    // A rename/file-under proposal is only as good as the text behind it. A
    // failed or trivial extraction (a damaged PDF, an HTML error page saved
    // as one) yields a few stray words — proposing metadata from that reads
    // as nonsense ("Page Not Found in error_pages"), so stay quiet instead.
    if text.trim().chars().count() < 80 {
        return Ok(echo());
    }
    let model = match resolve_structured_model(&state).await {
        Some(m) => m,
        None => return Ok(echo()),
    };
    // MIGRATION Phase 3: the prompt, schema, model call, the empty-title →
    // title_from_name fallback and the tag lowercasing/cap all live in the
    // sidecar's /suggest_file_meta (which clamps the text to 2000 bytes itself).
    // Rust keeps the DB read + the <80-char short-circuit above. Like the old
    // `unwrap_or_default()`, any engine failure degrades to the echo.
    let body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "current_name": current_name,
        "text": text,
    });
    match crate::sidecar::sidecar_json("/suggest_file_meta", &body).await {
        Ok(v) => Ok(FileMetaSuggestion {
            title: v["title"].as_str().unwrap_or_default().to_string(),
            folder: v["folder"].as_str().unwrap_or_default().to_string(),
            tags: v["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
                .unwrap_or_default(),
        }),
        Err(_) => Ok(echo()),
    }
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
