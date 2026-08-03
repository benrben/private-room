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
}

/// The command catalog. Keep in sync with the `run_command` dispatch below.
pub const CHAT_COMMANDS: &[ChatCommandInfo] = &[
    ChatCommandInfo {
        name: "add-file",
        summary: "Write a new note or document — or one per item with \"for each\"",
        usage: "#add-file <name>: <topic>   ·   #add-file for each <thing>",
    },
    ChatCommandInfo {
        name: "remember",
        summary: "Save a fact to the room's permanent memory",
        usage: "#remember <fact>",
    },
    ChatCommandInfo {
        name: "find",
        summary: "Search the room's files for content and list what matches",
        usage: "#find <keywords>",
    },
    ChatCommandInfo {
        name: "highlight",
        summary: "Mark an exact passage in a file so you can see it in the viewer",
        usage: "#highlight <thing> in @file",
    },
    ChatCommandInfo {
        name: "extract",
        summary: "Pull the same fields out of several files into a spreadsheet",
        usage: "#extract <field, field…> from @a @b",
    },
    ChatCommandInfo {
        name: "summarize",
        summary: "Summarize the whole room, or one @file",
        usage: "#summarize   ·   #summarize @file",
    },
    ChatCommandInfo {
        name: "compare",
        summary: "Compare two or more @files side by side",
        usage: "#compare @a @b",
    },
    ChatCommandInfo {
        name: "transcribe",
        summary: "Show the transcript of an @recording",
        usage: "#transcribe @recording",
    },
    ChatCommandInfo {
        name: "minutes",
        summary: "Turn a meeting transcript or notes into timeline-style HTML minutes",
        usage: "#minutes @recording   ·   #minutes @notes.md",
    },
    ChatCommandInfo {
        name: "to-sheet",
        summary: "Turn the table in the last answer into a spreadsheet",
        usage: "#to-sheet",
    },
    ChatCommandInfo {
        name: "translate",
        summary: "Translate an @file into another language",
        usage: "#translate @file to <language>",
    },
    // D8 (the Airlock): search the web, pull each source into the room as an
    // owned offline copy, then answer from those files — so the sources stay
    // even after the network is gone. Requires a web provider in Settings.
    ChatCommandInfo {
        name: "research",
        summary: "Search the web, save each source into the room, then answer offline",
        usage: "#research <question>",
    },
    // Wave 3 (Idea 9): one-click "commit" — a named whole-room checkpoint from
    // the composer, no model call. Rollback stays gated in Settings.
    ChatCommandInfo {
        name: "checkpoint",
        summary: "Save a named checkpoint of the whole room (roll back later in Settings)",
        usage: "#checkpoint   ·   #checkpoint before cleanup",
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
    /// Prior conversation as plain text (oldest-first) — the whole chat since
    /// the last handoff; commands window it when it outgrows one call.
    history: &'a str,
    temperature: Option<f64>,
    cancel: Arc<AtomicBool>,
    /// Owner replacement #4: the run/chat this command's events belong to.
    /// Every `ask-step`/`ask-delta` a command emits goes out through `step`
    /// below, so a `#command` running in one conversation can never paint into
    /// another one the user has since opened.
    pub(crate) turn: crate::turn::TurnId,
    /// Windows of the source a pass could not read (the model errored or timed
    /// out on them). Full ops means the whole source is READ — when a slice of it
    /// wasn't, the reply says so instead of quietly covering less.
    unread: AtomicUsize,
}

/// What a command produces: a chat message plus optional viewer effects.
#[derive(Default)]
pub(crate) struct CommandResult {
    content: String,
    sources: Vec<String>,
    effects: ToolEffects,
}

/// Wall-clock ceiling for a single non-streamed command step (`ask_quiet`).
/// Sized for one full window of source (`CMD_WINDOW_CHARS`) on a slow local
/// model, and still far below the shared 10-minute HTTP timeout, so a stalled
/// model fails fast with a clear message instead of freezing the step chip. A
/// step that does time out counts as an unread window and is reported — it never
/// silently shrinks the coverage.
const COMMAND_STEP_TIMEOUT_SECS: u64 = 300;

/// Longest gap with NO token before a STREAMED step counts as stalled. Prompt
/// processing on a slow local model can take minutes before the first token, so
/// this is deliberately generous — but silence past it is a hang, and without a
/// ceiling the only way out was quitting the app.
const COMMAND_STREAM_IDLE_SECS: u64 = COMMAND_STEP_TIMEOUT_SECS;

/// The cloud-CLI twin of [`COMMAND_STREAM_IDLE_SECS`]. A harness engine
/// (claude-cli / codex-cli) cannot stream: the sidecar hands the CLI's whole
/// reply back as ONE delta at the very end (`llm.generate_stream`, the
/// `is_external_model` branch), so the "silence" clock spans the entire answer
/// and a five-minute ceiling would kill a long but perfectly healthy
/// `#summarize` / `#research` with stall advice that cannot apply. Sized just
/// past the sidecar's own wedged-CLI budget (`external_llm.EXTERNAL_IDLE_SECS`,
/// 900 s) so that error surfaces first and this only catches a stream that never
/// ends at all. API-backed providers (openrouter, `:cloud`) DO stream delta by
/// delta, so they keep the ordinary ceiling.
const COMMAND_STREAM_IDLE_CLI_SECS: u64 = 960;

/// How long a streamed step may go with no token before it counts as stalled,
/// for the engine actually answering.
///
/// Reads the DECLARED record rather than testing the model's name: "cannot
/// stream" is a property of the transport, and `is_cli_engine` was that property
/// spelled as the two engine ids that happened to have it when this was written.
/// A third non-streaming engine would have inherited the five-minute ceiling and
/// killed every long answer with stall advice that does not apply.
fn stream_idle_secs(model: &str) -> u64 {
    if crate::commands::declared_for(model).streaming == crate::commands::Support::No {
        COMMAND_STREAM_IDLE_CLI_SECS
    } else {
        COMMAND_STREAM_IDLE_SECS
    }
}

/// How long Stop waits for the stream to notice the flag by itself (it samples
/// it as each chunk arrives, and then hands back the partial answer it already
/// showed) before we hang up on its behalf. A model that has gone quiet never
/// gets another chunk, which is how Stop came to be ignored entirely.
const COMMAND_STOP_GRACE_MS: u64 = 1_500;

/// What one QUIET command step hands on to the rest of the command.
///
/// Quiet steps are the ones nobody reads before they are used: #translate saves
/// its result as a new FILE, #extract folds it into a table, #compare feeds it
/// to the next step. A thinking model's `<think>…</think>` preamble therefore
/// ends up inside the user's document rather than on screen where they could
/// see what it was. The streamed steps have stripped it since the beginning.
pub(crate) fn quiet_step_text(raw: &str) -> String {
    ollama::strip_think_spans(raw).trim().to_string()
}

/// The watchdog half of [`CmdCtx::ask_streaming`], split out so the Stop and
/// stall paths can be exercised without a window. Drives `fut` while sampling
/// the Stop flag and the gap since the last token; `last_token` and `partial`
/// are the handles the delta callback writes to.
///
/// ADD-7's contract is that Stop ABANDONS the stream but KEEPS the partial
/// (`sidecar::generate_stream` breaks on the flag and returns `Ok(full)`), so
/// hanging up on the stream's behalf hands back the same partial. Returning an
/// error here instead would be turned into an empty message by `run_command`
/// and the text the user watched arrive would vanish from the chat.
async fn watch_stream(
    fut: impl std::future::Future<Output = Result<String, String>>,
    cancel: &AtomicBool,
    last_token: &Mutex<std::time::Instant>,
    partial: &Mutex<String>,
    idle_secs: u64,
    grace_ms: u64,
) -> Result<String, String> {
    tokio::pin!(fut);
    let mut stop_seen: Option<std::time::Instant> = None;
    loop {
        tokio::select! {
            res = &mut fut => return res,
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                if cancel.load(Ordering::SeqCst) {
                    let since = *stop_seen.get_or_insert_with(std::time::Instant::now);
                    if since.elapsed() >= std::time::Duration::from_millis(grace_ms) {
                        return Ok(partial.lock().unwrap().clone());
                    }
                }
                if last_token.lock().unwrap().elapsed()
                    >= std::time::Duration::from_secs(idle_secs)
                {
                    return Err("The model stopped responding. Try a shorter \
                                selection, or switch to a faster model in Settings."
                        .into());
                }
            }
        }
    }
}

impl CmdCtx<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// One step chip, stamped with this command's run and chat.
    pub(crate) fn step(&self, label: impl Into<String>) {
        self.turn.step(self.window, label);
    }

    /// Record that one window of the source could not be read.
    fn note_unread(&self) {
        self.unread.fetch_add(1, Ordering::SeqCst);
    }

    /// One model call streamed live into the chat (for answers the user reads).
    async fn ask_streaming(&self, system: &str, user: String) -> Result<String, String> {
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        let window = self.window;
        let turn = self.turn.clone();
        // MIGRATION Phase 2a: streamed through the sidecar `/generate_stream`
        // (no tools, no `format`); the per-token `ask-delta` events are unchanged.
        let body = ollama::plain_generate_body(
            self.model,
            &messages,
            self.temperature,
            KEEP_ALIVE_WARM,
        );
        // The sidecar only samples the cancel flag as each chunk arrives, so a
        // model that goes quiet swallows Stop, and one that stalls outright never
        // returns at all. Watch the flag and the gap since the last token
        // alongside the stream; dropping the future closes the connection, which
        // is exactly what the in-stream Stop does.
        let last_token = Arc::new(Mutex::new(std::time::Instant::now()));
        // Mirror of what has streamed so far, so hanging up on Stop's behalf can
        // still hand back the partial the user is looking at (see `watch_stream`).
        let partial = Arc::new(Mutex::new(String::new()));
        let seen = last_token.clone();
        let mirror = partial.clone();
        let fut = crate::sidecar::generate_stream(
            "/generate_stream",
            &body,
            Some(self.cancel.clone()),
            move |d| {
                *seen.lock().unwrap() = std::time::Instant::now();
                mirror.lock().unwrap().push_str(d);
                turn.emit(window, "ask-delta", d);
            },
        );
        watch_stream(
            fut,
            &self.cancel,
            &last_token,
            &partial,
            stream_idle_secs(self.model),
            COMMAND_STOP_GRACE_MS,
        )
        .await
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
        let fut = ollama::generate(
            self.model,
            messages,
            temp,
            KEEP_ALIVE_WARM,
            Some(self.cancel.clone()),
        );
        // A quiet step streams no tokens, so a stalled model would otherwise
        // freeze the command's step chip until the shared 10-minute HTTP
        // timeout. Cap it at a responsive ceiling and surface a clean,
        // actionable error instead of a silent multi-minute wait (the reported
        // #translate "hang"). Dropping `fut` on timeout aborts the request, the
        // same as a Stop.
        match tokio::time::timeout(
            std::time::Duration::from_secs(COMMAND_STEP_TIMEOUT_SECS),
            fut,
        )
        .await
        {
            // A thinking model puts its private reasoning in `<think>…</think>`
            // ahead of the answer, and a quiet step's text is not read by a
            // human before it is used — #translate writes it straight into a NEW
            // FILE, #extract folds it into a table. The streamed steps have
            // stripped it since the beginning; this one funnels every quiet step
            // in every command, so it is the one place to do it.
            Ok(res) => res.map(|text| quiet_step_text(&text)),
            Err(_) => Err("The model took too long to respond. Try a shorter \
                           selection, or switch to a faster model in Settings."
                .into()),
        }
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

    /// The MAP half of a full pass: one quiet call per window of `source`, in
    /// order. `label` names the work in the step chip ("Reading part 3/9"); a
    /// Stop between windows ends the pass with what it already has, and a window
    /// whose call fails contributes nothing instead of aborting the whole run
    /// (one bad slice must not cost the user the other twenty).
    async fn map_windows(
        &self,
        source: &str,
        label: &str,
        system: &str,
        user: impl Fn(&str) -> String,
        temp: Option<f64>,
    ) -> Vec<String> {
        let windows = cmd_windows(source);
        let total = windows.len();
        let mut out = Vec::new();
        for (i, w) in windows.iter().enumerate() {
            if self.cancelled() {
                break;
            }
            if total > 1 {
                self.step(format!("{label} ({}/{})", i + 1, total));
            }
            match self.ask_quiet(system, user(w), temp).await {
                Ok(piece) if !piece.trim().is_empty() => out.push(piece.trim().to_string()),
                // Nothing back for this slice: the source was not fully read, and
                // the user is told so rather than left with a shorter answer.
                _ => self.note_unread(),
            }
        }
        out
    }

    /// The REDUCE half: fold notes down to something one call can hold, by
    /// re-folding while they are still too big. Every round has already seen the
    /// whole source, so this loses detail, never coverage — the opposite of a
    /// clamp, which loses the end of the source outright.
    async fn fold_notes(&self, notes: Vec<String>, label: &str) -> String {
        let mut text = notes.join("\n\n");
        for _ in 0..FOLD_MAX_ROUNDS {
            if text.len() <= CMD_WINDOW_CHARS || self.cancelled() {
                break;
            }
            let before = text.len();
            let round = self
                .map_windows(&text, label, NOTE_SYS, |w| format!("Notes:\n{w}"), Some(0.2))
                .await;
            if round.is_empty() {
                break;
            }
            let joined = round.join("\n\n");
            // A round that didn't shrink won't shrink next time either.
            if joined.len() >= before {
                break;
            }
            text = joined;
        }
        text
    }

    /// The whole of `text`, reduced to what one call can hold WITHOUT dropping
    /// any of it: returned unchanged when it already fits, otherwise notes over
    /// every window, folded. This is the "full ops" replacement for
    /// `clamp_bytes(text, N)`.
    async fn digest(&self, text: &str, label: &str) -> String {
        if text.len() <= CMD_WINDOW_CHARS {
            return text.to_string();
        }
        let notes = self
            .map_windows(text, label, NOTE_SYS, |w| format!("Part of the source:\n{w}"), Some(0.2))
            .await;
        self.fold_notes(notes, label).await
    }
}

/// Format prior conversation as plain text (oldest-first), markup stripped, for
/// commands that reason over history (#add-file for-each, #to-sheet, #minutes on
/// a discussion). The whole conversation since the last handoff — a command that
/// can't fit it in one call windows it (`cmd_windows`) rather than clamping it.
pub(crate) fn format_history(history: &[(String, String)]) -> String {
    let mut out = String::new();
    for (role, content) in history {
        let content = strip_markup_blocks(content);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("\n[{role}]\n{content}\n"));
    }
    out.trim().to_string()
}

// ---- full ops: a pass per window, never a truncation ----------------------
//
// A `#command` reads its whole source. When the source is bigger than one model
// call can hold, it is split into consecutive windows — every byte lands in
// exactly one window, with a small overlap so nothing straddling a cut is lost
// (`extraction::partition_windows`, the same primitive the exhaustive file pass
// uses) — and the command runs one pass per window, then merges. Truncating
// instead is what silently reduced `#minutes` to the first few minutes of a
// meeting and `#extract` to the first pages of a report.

/// Source bytes per pass. Comfortably inside a small local model's native window
/// once the sidecar fits `num_ctx` to the payload, and large enough that an
/// ordinary document is still a single call — so short sources cost exactly what
/// they cost before.
pub(crate) const CMD_WINDOW_CHARS: usize = 16_000;

/// Bytes carried from the previous window, so a sentence spanning a cut is seen
/// whole by at least one pass. Merges dedupe what the overlap repeats.
pub(crate) const CMD_WINDOW_OVERLAP: usize = 400;

/// Guard against a fold that never shrinks (a model that echoes its input), NOT
/// a coverage cap: every round already saw the whole source, and the loop also
/// stops the moment a round fails to shrink.
const FOLD_MAX_ROUNDS: usize = 6;

/// System prompt for the map half of a fold: notes on one window that stand in
/// for it completely.
const NOTE_SYS: &str = "You take faithful, dense notes on ONE part of a longer source. Keep every \
                        fact, name, number, date, decision, commitment and telling quote a reader \
                        of the whole source would need — these notes will REPLACE this part later, \
                        so anything you leave out is lost. No preamble, no commentary.";

/// Every window of `text`, in order — exhaustive. A text that already fits is one
/// window, so the single-call path is unchanged.
pub(crate) fn cmd_windows(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if text.len() <= CMD_WINDOW_CHARS {
        return vec![text.to_string()];
    }
    extraction::partition_windows(text, CMD_WINDOW_CHARS, CMD_WINDOW_OVERLAP)
        .into_iter()
        .map(|(s, e)| text[s..e].to_string())
        .collect()
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
        // The WHOLE conversation since the last handoff, not the last 12 turns:
        // a command that reasons over the chat (#minutes on a discussion,
        // #add-file for-each, #to-sheet) must see all of it. `-1` is SQLite's
        // "no limit"; long conversations are windowed at the point of use.
        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, &chat_id, -1)?;
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

    // Wave 3 (Idea 9): #checkpoint is a one-click "commit" — it never calls the
    // model, so short-circuit before the Ollama probe (a checkpoint must work
    // even with the local AI stopped). Rollback stays gated in Settings.
    if command == "checkpoint" {
        let meta = create_checkpoint_core(state.inner(), args.trim(), false)?;
        let content = format!("Saved checkpoint **{}**. Roll back to it in Settings → Checkpoints.", meta.name);
        return persist_assistant_reply(&state, &chat_id, content, Vec::new(), None);
    }

    // Engine parity: `#`-commands honor the room's CHOSEN engine, exactly like
    // chat does — external CLIs route through the sidecar's external backend,
    // `:cloud` rides the proxy, and both wear the visible "leaves this Mac"
    // labels the user accepted when picking that engine. Only a room with no
    // model setting falls back to the best local model. (#extract still
    // compensates for smaller local models with a direct CSV/TSV column read;
    // see tabular_field_rows.)
    let models = ollama::list_models().await.unwrap_or_default();
    let model = match explicit_model {
        Some(m) => m,
        None => {
            if models.is_empty() {
                return Err("No local AI model is installed yet — download one first.".into());
            }
            best_local_default(&models)
        }
    };
    let history_text = format_history(&history);

    let ctx = CmdCtx {
        window: &window,
        state: &state,
        model: &model,
        refs: &refs,
        args: args.trim(),
        history: &history_text,
        temperature,
        cancel: cancel.clone(),
        turn: crate::turn::TurnId::new(&ask_id, &chat_id),
        unread: AtomicUsize::new(0),
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
    // Full ops is a promise about coverage, so a slice the model failed on is
    // stated outright rather than left to look like a complete answer.
    let unread = ctx.unread.load(Ordering::SeqCst);
    if unread > 0 && !stopped {
        content.push_str(&format!(
            "\n\n_Note: {unread} part(s) of the source couldn't be read (the model failed or timed \
             out on them), so they aren't reflected above. Re-run to try them again._"
        ));
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

#[cfg(test)]
mod full_ops_tests {
    use super::*;

    #[test]
    fn short_source_is_a_single_window() {
        // Nothing changes for an ordinary document: one window, one model call.
        let text = "a short meeting transcript";
        assert_eq!(cmd_windows(text), vec![text.to_string()]);
        assert!(cmd_windows("   ").is_empty());
    }

    #[test]
    fn long_source_is_covered_end_to_end() {
        // An hour of transcript: every byte must land in some window, including
        // the last line — the whole point of the change.
        let body = (0..4000)
            .map(|i| format!("[00:{:02}] speaker {i}: line number {i}\n", i % 60))
            .collect::<String>();
        let text = format!("{body}FINAL LINE: the meeting ended.");
        let windows = cmd_windows(&text);
        assert!(windows.len() > 1, "a source this size takes several passes");
        assert!(
            windows.last().unwrap().contains("FINAL LINE"),
            "the end of the source is read, not clamped away"
        );
        // Consecutive coverage: joining the windows reproduces every line.
        let joined = windows.join("");
        for probe in ["line number 0", "line number 1999", "line number 3999"] {
            assert!(joined.contains(probe), "{probe} was dropped");
        }
    }

    #[test]
    fn windows_stay_within_one_pass() {
        let text = "sentence. ".repeat(20_000);
        for w in cmd_windows(&text) {
            // partition_windows may overshoot to a seam; the overlap bounds it.
            assert!(w.len() <= CMD_WINDOW_CHARS + CMD_WINDOW_OVERLAP);
        }
    }
}

#[cfg(test)]
mod quiet_step_tests {
    use super::*;

    /// A thinking model's private monologue must not reach a #command's output.
    ///
    /// The quiet steps are the ones nobody reads first: #translate SAVES its
    /// result as a new file, #extract folds it into a table. Only the streamed
    /// steps were stripping `<think>`, so a reasoning model's preamble was
    /// written into the user's document as if it were the translation.
    #[test]
    fn a_quiet_step_never_carries_the_models_reasoning() {
        assert_eq!(
            quiet_step_text("<think>The user wants French. Careful with the idiom.</think>\nBonjour le monde."),
            "Bonjour le monde."
        );
        // Unterminated: everything after the opening tag is reasoning, and
        // returning it would be worse than returning nothing.
        assert_eq!(quiet_step_text("<think>still thinking about it"), "");
        // Ordinary prose is untouched, whitespace and all.
        assert_eq!(quiet_step_text("  Plain answer.  "), "Plain answer.");
    }
}

#[cfg(test)]
mod stream_watchdog_tests {
    use super::*;

    /// A stream that never finishes on its own — the watchdog has to end it.
    fn never() -> impl std::future::Future<Output = Result<String, String>> {
        std::future::pending()
    }

    #[tokio::test]
    async fn stop_keeps_the_partial_the_user_already_saw() {
        // ADD-7: Stop abandons the stream but KEEPS the text that streamed in.
        // Hanging up on the stream's behalf must honour the same contract —
        // returning an error here made `run_command` save "*(stopped)*" alone.
        let cancel = AtomicBool::new(true);
        let last = Mutex::new(std::time::Instant::now());
        let partial = Mutex::new("half an answer already on screen".to_string());
        let got = watch_stream(never(), &cancel, &last, &partial, 300, 0).await;
        assert_eq!(got, Ok("half an answer already on screen".into()));
    }

    #[tokio::test]
    async fn a_silent_stream_still_gets_hung_up_on() {
        // The other half of the same watchdog: no Stop, no token, past the idle
        // budget — that IS a hang, and it keeps its actionable message.
        let cancel = AtomicBool::new(false);
        let last = Mutex::new(std::time::Instant::now());
        let partial = Mutex::new(String::new());
        let got = watch_stream(never(), &cancel, &last, &partial, 0, 1_500).await;
        assert!(got.unwrap_err().contains("stopped responding"));
    }

    #[test]
    fn a_cloud_cli_is_not_judged_by_a_streaming_clock() {
        // claude-cli / codex-cli emit exactly one delta, at the very end, so the
        // silence clock spans the whole answer: a five-minute ceiling would kill
        // any long #summarize / #research on those engines. The budget has to
        // clear the sidecar's own wedged-CLI cutoff (EXTERNAL_IDLE_SECS = 900).
        for m in ["claude-cli", "codex-cli::gpt-5.6-sol", "claude-cli::opus::high"] {
            assert!(
                stream_idle_secs(m) > 900,
                "{m} would be killed mid-answer at {}s",
                stream_idle_secs(m)
            );
        }
        // Everything else really does stream token by token — including the
        // API-backed providers, which go through the sidecar's provider branch —
        // so silence there IS a stall and keeps the responsive ceiling.
        for m in ["qwen3.5:4b", "minimax-m3:cloud", "openrouter::vendor/model"] {
            assert_eq!(stream_idle_secs(m), COMMAND_STREAM_IDLE_SECS, "{m}");
        }
    }
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

