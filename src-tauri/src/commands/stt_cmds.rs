use super::*;

/// Where a *downloaded* Whisper model lives: <app data dir>/models/<MODEL_FILE>.
/// The engine is compiled in; the weights are either bundled in the app (see
/// `bundled_stt_model`) or downloaded here, like Ollama models.
pub(crate) fn stt_model_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join(stt::MODEL_FILE))
}

/// The Whisper model bundled inside the app as a Tauri resource, if this build
/// shipped with it (release DMGs do). Dev/unbundled builds just get a path that
/// doesn't exist.
pub(crate) fn bundled_stt_model(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .resolve(
            format!("models/{}", stt::MODEL_FILE),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .filter(|p| p.exists())
}

/// The model to actually transcribe with: a user-downloaded copy wins (they may
/// have swapped one in), otherwise the copy bundled in the app. whisper.cpp
/// mmaps the file read-only, so the read-only Resources path is used directly —
/// no copy-out needed. `None` only when neither exists (an unbundled build with
/// nothing downloaded yet).
pub(crate) fn stt_effective_model(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(p) = stt_model_path(app) {
        if p.exists() {
            return Some(p);
        }
    }
    bundled_stt_model(app)
}

/// One download at a time; the UI disables the button while this is set.
pub(crate) static STT_DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub installed: bool,
    pub downloading: bool,
    pub size_mb: u64,
}

#[tauri::command]
pub fn stt_status(app: tauri::AppHandle) -> Result<SttStatus, String> {
    Ok(SttStatus {
        // Bundled OR downloaded both count as installed, so a release build
        // (which ships the model) never prompts for a download.
        installed: stt_effective_model(&app).is_some(),
        downloading: STT_DOWNLOADING.load(Ordering::SeqCst),
        size_mb: stt::MODEL_SIZE_MB,
    })
}

/// Download the Whisper model (once, ~574 MB) with `stt-download-progress`
/// events `{got, total, percent}`. Streams to a .part file and renames on
/// success, so a cancelled/failed download never leaves a half model behind.
#[tauri::command]
pub async fn stt_download_model(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let dest = stt_model_path(&app)?;
    if dest.exists() || bundled_stt_model(&app).is_some() {
        return Ok(());
    }
    if STT_DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("The dictation model is already downloading.".into());
    }
    let result: Result<(), String> = async {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let part = dest.with_extension("bin.part");
        let resp = reqwest::get(stt::MODEL_URL)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("download failed: {e}"))?;
        let total = resp.content_length().unwrap_or(stt::MODEL_SIZE_MB * 1024 * 1024);
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut last_pct: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            let pct = got * 100 / total.max(1);
            if pct != last_pct {
                last_pct = pct;
                let _ = window.emit(
                    "stt-download-progress",
                    serde_json::json!({ "got": got, "total": total, "percent": pct }),
                );
            }
        }
        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(dest.with_extension("bin.part"));
    }
    STT_DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn stt_delete_model(app: tauri::AppHandle) -> Result<(), String> {
    let path = stt_model_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Transcribe recorded audio (mic dictation / talk-to-file): base64 bytes in,
/// text out, fully on-device. `STT_MODEL_MISSING` is the sentinel the UI maps
/// to a "download it in Settings" hint, like OLLAMA_DOWN / MODEL_MISSING.
#[tauri::command]
pub async fn transcribe_audio(
    app: tauri::AppHandle,
    data_b64: String,
    ext: String,
    timestamps: bool,
) -> Result<String, String> {
    let Some(model) = stt_effective_model(&app) else {
        return Err("STT_MODEL_MISSING".into());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let kind = stt::media_kind("", &ext).unwrap_or(stt::MediaKind::Audio);
        let pcm = stt::decode_bytes_to_pcm(&bytes, &ext, kind)?;
        stt::transcribe(&model, &pcm, timestamps)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ADD-18: transcribe one imported recording on the STT worker lane — the
/// audio/video twin of `run_ocr_job`. On success the timestamped transcript is
/// stored as the file's extracted text (prefixed so the AI knows provenance),
/// making it searchable/quotable. Failures are silent: the file just keeps
/// having no text, exactly like before this feature.
pub(crate) fn run_stt_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let Some(model) = stt_effective_model(app) else {
        let _ = app.emit("stt-progress", (&job.name, "model-missing"));
        return;
    };
    let Some(kind) = stt::media_kind(&job.mime, &job.ext) else { return };
    let _ = app.emit("stt-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    let text = stt::decode_bytes_to_pcm(&bytes, &job.ext, kind)
        .and_then(|pcm| stt::transcribe(&model, &pcm, true))
        .unwrap_or_default();
    if text.trim().is_empty() {
        let _ = app.emit("stt-progress", (&job.name, "none"));
        return;
    }
    let full_text = format!("(transcribed from recording)\n{text}");
    {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        match guard.as_ref() {
            // Wave 3 (Idea 9): epoch pin — a transcription queued before a
            // rollback must not land in the swapped room (path is unchanged).
            Some(room) if room.path == job.room_path && state.room_epoch() == job.epoch => {
                let _ = db::update_file_content(&room.conn, &job.id, &bytes, Some(&full_text));
            }
            _ => return,
        }
    }
    let _ = app.emit("room-files-changed", ());
    let _ = app.emit("stt-progress", (&job.name, "done"));
    // CHG-22 → Wave 1b (idea 8): newly-transcribed file goes through the
    // debounced auto-index scheduler (which falls back to the quiet filler
    // when the feature is off or the drop is tiny).
    schedule_auto_index(app, job.room_path.clone());
}

/// CHG-22: opportunistically fill cached one-liners (files.ai_summary) in the
/// background so the interactive "Summarize room" collapses to a single reduce
/// call. Single-flight; starts after `delay_secs` so it never races the user's
/// first post-import question (Wave 1b: the auto-index scheduler passes 0 —
/// it has already debounced ~30 s, so stacking the old fixed 45 s on top would
/// make tiny drops look stalled); yields to any streaming answer; uses a short
/// keep-alive so it never pins the model in RAM. All failures are silent —
/// the ADD-30 deep-summary job (`#summarize`) remains the full path.
pub(crate) fn spawn_summary_filler(app: tauri::AppHandle, room_path: String, delay_secs: u64) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    // Single-flight: bail if a filler is already running.
    if state.summary_filler.swap(true, Ordering::SeqCst) {
        return;
    }
    let flag = state.summary_filler.clone();
    // Wave 3 (Idea 9): the epoch at scheduling time — re-checked before every
    // ai_summary write so a rollback drops a filler that was mid-run.
    let epoch = state.room_epoch();
    tauri::async_runtime::spawn(async move {
        // Reset the single-flight flag on every exit path.
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(flag);

        // Let the user's first question take priority.
        if delay_secs > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }

        let models = ollama::list_models().await.unwrap_or_default();
        if models.is_empty() {
            return;
        }
        let (model, still_open) = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                Some(room) if room.path == room_path => {
                    (model_setting(&room.conn).unwrap_or_else(|| best_default(&models)), true)
                }
                _ => (String::new(), false),
            }
        };
        if !still_open {
            return;
        }
        let model = if is_external_engine(&model) {
            best_default(&models)
        } else {
            model
        };

        // One bounded batch, then exit — a fresh import/OCR event re-triggers.
        let batch = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            // Wave 3 (Idea 9): a rollback bumped the epoch — abandon the filler.
            if room.path != room_path || state.room_epoch() != epoch {
                return;
            }
            db::files_missing_summary(&room.conn, MAX_SUMMARY_FILES).unwrap_or_default()
        };
        for (id, name, mime, text) in batch {
            // Yield to any in-flight answer, and stop if the room changed.
            // ADD-27: also load the file's FULL text here (the batch row only
            // carries a probe snippet, so a whole batch never holds 50 large
            // texts in memory at once) — the summarizer pages through it.
            let full = {
                let state = app.state::<AppState>();
                if !state.cancels.lock().unwrap().is_empty() {
                    return;
                }
                let guard = state.room.lock().unwrap();
                match guard.as_ref() {
                    Some(room) if room.path == room_path => {
                        db::get_file_extracted_text(&room.conn, &id)
                    }
                    _ => return,
                }
            }
            .unwrap_or_else(|| text.clone());
            let liner =
                match summarize_one_file(&model, &name, &mime, &full, KEEP_ALIVE_SHORT).await {
                    Ok(l) => l,
                    // Ollama down / model unloaded under pressure → stop quietly.
                    Err(_) => return,
                };
            if liner.is_empty() {
                continue;
            }
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                // Wave 3 (Idea 9): epoch pin — never write a one-liner into a
                // room the rollback swapped out from under this pass.
                Some(room) if room.path == room_path && state.room_epoch() == epoch => {
                    let _ = db::set_file_ai_summary(&room.conn, &id, &liner);
                }
                _ => return,
            }
        }
    });
}

// ------------------------------------------------------- dictation shaping (ADD-18)
// Ported from alfred's proven dictation pipeline (voicebridge.py): the same
// battle-tested prompt texts, combined into ONE local-model call. Two findings
// inherited from alfred: (1) whisper *-turbo models silently cannot translate,
// so translation happens HERE via the LLM, never in the Whisper step; (2) on
// any LLM failure the raw transcript must survive — callers fall back to it.
// Cloud engines are never used for shaping: dictated words stay on this Mac.

pub(crate) const DICT_TRANSLATE: &str = "Translate it into fluent, natural English. If it is \
already English, keep it unchanged. Preserve meaning and tone.";

pub(crate) const DICT_REWRITE: &str = "Clean up this raw voice transcription: remove filler \
words (um, uh, like), false starts, and repetitions; fix grammar, spelling, and \
punctuation; preserve the speaker's meaning, intent, and tone. Do not add new \
information and do not answer any question contained in the text.";

pub(crate) const DICT_TAIL: &str = "Output ONLY the resulting text, with no preamble, labels, \
explanations, or surrounding quotes.";

/// alfred's Prompt Optimizer — a standalone rewrite instruction (replaces the
/// cleanup instruction instead of extending it).
pub(crate) const DICT_PROMPT_OPTIMIZER: &str = "You are a prompt optimizer. Given any user \
input, automatically rewrite it into a clear, effective prompt. Never ask \
follow-up questions — infer everything from the input alone and preserve the \
user's full original intent (every requirement, entity, constraint, and nuance \
must survive the rewrite; never add goals they didn't imply).\n\nINTERNAL STEPS \
(do not show these):\n1. Deconstruct: extract the core intent, key entities, \
context, output requirements, and constraints.\n2. Develop: silently classify \
the request type and apply the fitting approach (creative → multi-perspective; \
technical → constraint-based precision; educational → clear structure and \
examples; complex → step-by-step framing). Add a role/expertise framing and \
logical structure where it helps.\n3. Auto-detect level: SHORT for simple \
requests (a tight one-paragraph prompt), DETAILED for complex ones (role, \
context, task breakdown, output format).\n\nOUTPUT:\nReturn only the rewritten \
prompt — no preamble, no explanation of changes, no questions.";

/// Intent guidance appended to the cleanup instruction (alfred's BUILTIN_MODES).
/// Returns (guidance, replaces_cleanup).
pub(crate) fn dict_mode_guidance(mode: &str) -> Option<(&'static str, bool)> {
    match mode {
        "raw" => Some(("", false)), // cleanup only
        "email" => Some((
            "Shape it as the body of a clear, courteous email. Do not invent a \
             subject line, greeting, or signature unless they were dictated.",
            false,
        )),
        "message" => Some(("Shape it as a concise, natural chat/Slack message.", false)),
        "commit" => Some((
            "Shape it as a git commit message: a short imperative summary line \
             (<=72 chars), then a blank line, then bullet points if warranted.",
            false,
        )),
        "notes" => Some((
            "Shape it as clean, organized notes (short paragraphs or bullets).",
            false,
        )),
        "prompt" => Some((DICT_PROMPT_OPTIMIZER, true)),
        _ => None,
    }
}

/// Post-process dictated text on the LOCAL model: optional translate-to-English
/// plus an optional intent rewrite, as one combined prompt (alfred's
/// build_combined_prompt shape). `mode="off"` + translate=false returns the
/// text unchanged without any model call.
#[tauri::command]
pub async fn shape_text(
    state: State<'_, AppState>,
    text: String,
    translate: bool,
    mode: String,
) -> Result<String, String> {
    // ADD-22: build the shaping steps WITHOUT translate — translate runs as its
    // own pass first, because one instruction at a time is far more reliable for
    // a small model than translate+cleanup+shape crammed into one prompt.
    let mut shape_steps: Vec<&str> = Vec::new();
    match dict_mode_guidance(&mode) {
        Some((guidance, true)) => shape_steps.push(guidance),
        Some(("", false)) => shape_steps.push(DICT_REWRITE),
        Some((guidance, false)) => {
            shape_steps.push(DICT_REWRITE);
            shape_steps.push(guidance);
        }
        None => {} // "off" or unknown: no rewrite stage
    }
    if !translate && shape_steps.is_empty() {
        return Ok(text);
    }

    // Shaping always runs on a LOCAL model — dictated words never go to a
    // cloud engine, whatever the chat model is set to.
    let models = ollama::list_models()
        .await
        .map_err(|_| "The local AI (Ollama) isn't running — raw transcript kept.".to_string())?;
    if models.is_empty() {
        return Err("No local AI model is installed — raw transcript kept.".into());
    }
    let mut model = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| model_setting(&room.conn))
            .unwrap_or_else(|| best_default(&models))
    };
    if is_external_engine(&model) {
        model = best_default(&models);
    }

    // Pass 1: translate on its own. A failure/empty result keeps the prior text.
    let mut text = text;
    if translate {
        if let Ok(t) = run_dict_pass(&model, &[DICT_TRANSLATE], &text).await {
            let t = t.trim();
            if !t.is_empty() {
                text = t.to_string();
            }
        }
    }
    // Pass 2: cleanup + optional mode shaping (or the prompt optimizer).
    if shape_steps.is_empty() {
        return Ok(text);
    }
    let shaped = run_dict_pass(&model, &shape_steps, &text).await?;
    let shaped = shaped.trim().to_string();
    // Resilience (alfred): never lose the words — empty output → prior text.
    Ok(if shaped.is_empty() { text } else { shaped })
}

/// ADD-22: one dictation-shaping model call. A single instruction gets a plain
/// prompt; multiple instructions keep the numbered "operations in order" shape.
pub(crate) async fn run_dict_pass(model: &str, steps: &[&str], text: &str) -> Result<String, String> {
    let prompt = if steps.len() == 1 {
        format!("{}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}", steps[0])
    } else {
        let numbered = steps
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {s}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "You are a text post-processor. Apply the following operations to the \
             INPUT TEXT, in order:\n{numbered}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}"
        )
    };
    let messages = vec![ollama::ChatMessage {
        role: "user".into(),
        content: prompt,
        ..Default::default()
    }];
    // MIGRATION Phase 2a: non-streamed sidecar `/generate` (no tools, no Stop).
    ollama::generate(model, messages, Some(0.2), "5m", None, ollama::CtxTier::Chat).await
}

// ---------------------------------------------------------------- Touch ID (ADD-11)

