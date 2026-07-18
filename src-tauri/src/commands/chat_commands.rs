use super::*;

mod knowledge;
mod generate;

pub(crate) use knowledge::*;
pub(crate) use generate::*;

/// One entry in the command catalog, surfaced to the UI for autocomplete/help.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandInfo {
    pub name: &'static str,
    pub summary: &'static str,
    pub usage: &'static str,
    /// True when the command works on @-pinned files.
    pub needs_refs: bool,
}

/// The command catalog. Keep in sync with the `run_command` dispatch below.
pub const CHAT_COMMANDS: &[ChatCommandInfo] = &[
    ChatCommandInfo {
        name: "add-file",
        summary: "Write a new note or document — or one per item with \"for each\"",
        usage: "#add-file <name>: <topic>   ·   #add-file for each <thing>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "remember",
        summary: "Save a fact to the room's permanent memory",
        usage: "#remember <fact>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "find",
        summary: "Search the room's files for content and list what matches",
        usage: "#find <keywords>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "highlight",
        summary: "Mark an exact passage in a file so you can see it in the viewer",
        usage: "#highlight <thing> in @file",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "extract",
        summary: "Pull the same fields out of several files into a spreadsheet",
        usage: "#extract <field, field…> from @a @b",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "summarize",
        summary: "Summarize the whole room, or one @file",
        usage: "#summarize   ·   #summarize @file",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "compare",
        summary: "Compare two or more @files side by side",
        usage: "#compare @a @b",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "transcribe",
        summary: "Show the transcript of an @recording",
        usage: "#transcribe @recording",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "minutes",
        summary: "Turn a meeting transcript or notes into timeline-style HTML minutes",
        usage: "#minutes @recording   ·   #minutes @notes.md",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "to-sheet",
        summary: "Turn the table in the last answer into a spreadsheet",
        usage: "#to-sheet",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "translate",
        summary: "Translate an @file into another language",
        usage: "#translate @file to <language>",
        needs_refs: true,
    },
    // D8 (the Airlock): search the web, pull each source into the room as an
    // owned offline copy, then answer from those files — so the sources stay
    // even after the network is gone. Requires a web provider in Settings.
    ChatCommandInfo {
        name: "research",
        summary: "Search the web, save each source into the room, then answer offline",
        usage: "#research <question>",
        needs_refs: false,
    },
];

/// The catalog, for the frontend autocomplete and help.
#[tauri::command]
pub fn list_chat_commands() -> Vec<ChatCommandInfo> {
    CHAT_COMMANDS.to_vec()
}

/// Everything a command workflow needs. Passed by reference to keep signatures
/// small.
pub(crate) struct CmdCtx<'a> {
    window: &'a tauri::Window,
    state: &'a State<'a, AppState>,
    model: &'a str,
    /// @-pinned file ids (resolved in the UI before send).
    refs: &'a [String],
    /// Text after the command word, with @tokens already stripped by the UI.
    args: &'a str,
    /// Prior conversation as plain text (oldest-first), already budget-clamped.
    history: &'a str,
    temperature: Option<f64>,
    cancel: Arc<AtomicBool>,
}

/// What a command produces: a chat message plus optional viewer effects.
#[derive(Default)]
pub(crate) struct CommandResult {
    content: String,
    sources: Vec<String>,
    effects: ToolEffects,
}

impl CmdCtx<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// One model call streamed live into the chat (for answers the user reads).
    async fn ask_streaming(&self, system: &str, user: String) -> Result<String, String> {
        use tauri::Emitter;
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        let window = self.window;
        // MIGRATION Phase 2a: streamed through the sidecar `/generate_stream`
        // (no tools, no `format`); the per-token `ask-delta` events are unchanged.
        let body = ollama::plain_generate_body(
            self.model,
            &messages,
            self.temperature,
            KEEP_ALIVE_WARM,
            ollama::CtxTier::Chat,
        );
        let out = crate::sidecar::generate_stream(
            "/generate_stream",
            &body,
            Some(self.cancel.clone()),
            |d| {
                let _ = window.emit("ask-delta", d);
            },
        )
        .await?;
        Ok(out)
    }

    /// One model call whose output is NOT shown as chat (it becomes a file, a
    /// quote, or a parsed list), so it isn't streamed.
    async fn ask_quiet(&self, system: &str, user: String, temp: Option<f64>) -> Result<String, String> {
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        // MIGRATION Phase 2a: non-streamed sidecar `/generate` (no tools); the
        // Stop flag still abandons a long quiet step promptly.
        ollama::generate(
            self.model,
            messages,
            temp,
            KEEP_ALIVE_WARM,
            Some(self.cancel.clone()),
            ollama::CtxTier::Chat,
        )
        .await
    }

    /// ADD-22: like `ask_quiet`, but the reply is CONSTRAINED to `schema` via
    /// Ollama `format`. For steps whose output is machine-read (a list, a table
    /// of fields), so the model can't hand back prose to salvage-parse.
    async fn ask_structured(
        &self,
        system: &str,
        user: String,
        temp: Option<f64>,
        schema: &serde_json::Value,
    ) -> Result<String, String> {
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        ollama::chat_structured(
            self.model,
            messages,
            temp,
            KEEP_ALIVE_WARM,
            schema,
            Default::default(),
        )
        .await
    }
}

/// How many web results the Airlock pulls into the room per #research run.
pub(crate) const RESEARCH_SOURCES: usize = 4;

/// Format prior conversation as plain text (oldest-first), markup stripped and
/// budget-clamped, for commands that reason over history (#add-file for-each,
/// #to-sheet).
pub(crate) fn format_history(history: &[(String, String)], budget: usize) -> String {
    let mut out = String::new();
    for (role, content) in history {
        let content = strip_markup_blocks(content);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("\n[{role}]\n{content}\n"));
    }
    clamp_bytes(out.trim().to_string(), budget)
}

/// Run a prebuilt "#name" workflow. Mirrors `ask`'s cancel/save boilerplate but
/// dispatches to a fixed pipeline instead of the agent loop. Commands always use
/// a LOCAL model (they make several small calls; cloud would leak content and
/// can't stream the pipeline).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_command(
    window: tauri::Window,
    state: State<'_, AppState>,
    ask_id: String,
    chat_id: String,
    command: String,
    args: String,
    refs: Vec<String>,
    raw: String,
) -> Result<Message, String> {
    if !CHAT_COMMANDS.iter().any(|c| c.name == command) {
        return Err(format!("Unknown command #{command}."));
    }

    // ADD-7: register a cancel flag so Stop/Lock works, like ask.
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

    // Phase 1 (locked): read history + settings, save the user's typed line.
    let (explicit_model, history, temperature) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let temperature: Option<f64> = db::get_setting(conn, "temperature").and_then(|s| s.parse().ok());
        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, &chat_id, MAX_HISTORY_MESSAGES as i64)?;
            rows.reverse();
            rows
        };
        db::insert_message(conn, &chat_id, "user", &raw, &[], None)?;
        let mut title: String = raw.chars().take(48).collect();
        if raw.chars().count() > 48 {
            title.push('…');
        }
        db::set_chat_title_if_new(conn, &chat_id, &title)?;
        (model_setting(conn), history, temperature)
    };

    let models = ollama::list_models().await.unwrap_or_default();
    if models.is_empty() {
        return Err("No local AI model is installed yet — download one first.".into());
    }
    let mut model = explicit_model.unwrap_or_else(|| best_default(&models));
    if is_external_engine(&model) {
        model = best_default(&models);
    }
    let history_text = format_history(&history, 8000);

    let ctx = CmdCtx {
        window: &window,
        state: &state,
        model: &model,
        refs: &refs,
        args: args.trim(),
        history: &history_text,
        temperature,
        cancel: cancel.clone(),
    };

    let result = match command.as_str() {
        "remember" => cmd_remember(&ctx).await,
        "find" => cmd_find(&ctx).await,
        "add-file" => cmd_add_file(&ctx).await,
        "highlight" => cmd_highlight(&ctx).await,
        "extract" => cmd_extract(&ctx).await,
        "summarize" => cmd_summarize(&ctx).await,
        "compare" => cmd_compare(&ctx).await,
        "transcribe" => cmd_transcribe(&ctx).await,
        "minutes" => cmd_minutes(&ctx).await,
        "to-sheet" => cmd_to_sheet(&ctx).await,
        "translate" => cmd_translate(&ctx).await,
        "research" => cmd_research(&ctx).await,
        _ => Err(format!("Unknown command #{command}.")),
    };

    let stopped = cancel.load(Ordering::SeqCst);
    let res = match result {
        Ok(r) => r,
        Err(_) if stopped => CommandResult::default(),
        Err(e) => return Err(e),
    };

    let mut content = res.content;
    if stopped {
        content.push_str(" *(stopped)*");
    }
    if content.trim().is_empty() {
        content = "Done.".into();
    }
    // ADD-23: viewer effects ride the `effects` column, not fenced markup.
    let effects_value = effects_json(&res.effects);

    // Phase 3 (locked): save the assistant reply (HLT-7: room may have closed) —
    // same persistence seam as `ask`.
    persist_assistant_reply(&state, &chat_id, content, res.sources, effects_value)
}

// ================================================================= moonshot (Section D)
// New room capabilities layered on the helpers above: model guidance (D1/D2),
// the room graph (D3), the front page (D4), study/podcast studios (D5/D12),
// memory & meta suggestions (D6/D7), the persistent room server / Leash (D9),
// the remote-Ollama Closet (D10), and the roles catalog (D11). Every command
// degrades gracefully — an empty/partial result, never a panic — when no room is
// open or the local model is unreachable.
//
// CONTRACT-NOTE (D): these call `db::set_meta(conn,&str,&str) -> Result<(),String>`
// (DB track adds it; only `get_meta` exists today), `ollama::resolved_base_url`/
// `set_base_url_override` (OLLAMA track — present), and `web::fetch_readable`
// (WEB track — present). Return structs serialize `camelCase` to match every
// existing struct in this file; the api.ts (G) wrappers mirror that.

