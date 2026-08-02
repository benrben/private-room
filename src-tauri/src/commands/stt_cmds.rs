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
        // Nothing to download — but a .part left behind by a download the
        // user quit out of would otherwise sit there for good.
        let _ = std::fs::remove_file(dest.with_extension("bin.part"));
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

/// Delete the downloaded model — and actually give the disk space back.
///
/// whisper.cpp mmaps the weights and the context is kept warm between
/// dictations ([`stt::CTX`]), so unlinking the file while it is still open
/// removed the name and nothing else: the several hundred megabytes stayed
/// held until the app quit. Dropping the warm context first releases the
/// mapping; the next transcription simply reloads (the bundled copy, or
/// nothing, which is the point of deleting it).
///
/// A transcription in flight HOLDS that context — the whole duration of a
/// background file job or a live phrase decode — and the release can only be
/// attempted, never waited for (blocking here would freeze the app). One
/// attempt therefore used to report success while freeing nothing at all, so
/// when the first try loses the race a small watcher finishes the job the
/// moment the decode lets go.
#[tauri::command]
pub fn stt_delete_model(app: tauri::AppHandle) -> Result<(), String> {
    let path = stt_model_path(&app)?;
    free_deleted_model(path.clone());
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    // A download interrupted by quitting leaves a .part behind that nothing
    // ever swept up — 574 MB of nothing in the app's folder. "Free the space"
    // must free that too.
    let _ = std::fs::remove_file(path.with_extension("bin.part"));
    Ok(())
}

/// How long the watcher keeps offering to release a deleted model's mapping.
/// Long enough for the transcription that holds it (a long import decodes for
/// minutes), and it gives up rather than living forever.
const FREE_MODEL_TRIES: usize = 300;
const FREE_MODEL_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// Give a deleted model's mmap back — now if the context is free, otherwise as
/// soon as the transcription holding it finishes. Returns immediately either
/// way: this runs on a command thread, and waiting for a decode would freeze
/// the app for as long as the file is long.
fn free_deleted_model(path: std::path::PathBuf) {
    if stt::unload_model(&path) {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..FREE_MODEL_TRIES {
            std::thread::sleep(FREE_MODEL_EVERY);
            // Downloaded again in the meantime: that mapping is wanted, and
            // dropping it would only cost the next transcription a reload.
            if path.exists() || stt::unload_model(&path) {
                return;
            }
        }
    });
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
/// making it searchable/quotable. The file keeps having no text when anything
/// goes wrong, exactly like before this feature — but a file macOS could not
/// DECODE reports "failed", not "none": a container the converters can't open
/// is not a silent recording, and telling the user it probably was left them
/// with no hint that converting the file would fix it.
pub(crate) fn run_stt_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let Some(model) = stt_effective_model(app) else {
        let _ = app.emit("stt-progress", (&job.name, "model-missing"));
        return;
    };
    let Some(kind) = stt::media_kind(&job.mime, &job.ext) else { return };
    let _ = app.emit("stt-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    let text = match stt::decode_bytes_to_pcm(&bytes, &job.ext, kind)
        .and_then(|pcm| stt::transcribe(&model, &pcm, true))
    {
        Ok(text) => text,
        Err(why) => {
            let _ = app.emit("stt-progress", (&job.name, format!("failed: {why}")));
            return;
        }
    };
    if text.trim().is_empty() {
        let _ = app.emit("stt-progress", (&job.name, "none".to_string()));
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
    schedule_privacy_scan(app.clone());
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
        // Engine parity: the filler honors the room's chosen engine — an
        // external CLI runs through the sidecar's external backend.

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

// ------------------------------------------------- streaming dictation (Metal wave)
// The mic's PCM streams into a worker thread WHILE the user speaks, and the
// rolling transcript streams back as `dict-partial` events — the wait that
// used to start at Stop now overlaps the speaking. Deliberately NOT the
// ADD-27 recording engine: dictation must never create a Recording file,
// touch diarization, or take the room lock. The final text is still one
// whole-utterance decode at Stop — identical quality to the old batch path.

/// One in-flight streaming dictation (the composer/journal/file/memory mics
/// share one microphone, so one session). Commands only send messages; the
/// worker owns the audio.
#[derive(Default)]
pub struct DictState {
    pub session: Mutex<Option<DictSession>>,
}

pub struct DictSession {
    tx: std::sync::mpsc::Sender<DictMsg>,
}

enum DictMsg {
    Audio { rate: u32, samples: Vec<f32> },
    Stop { done: std::sync::mpsc::Sender<Result<String, String>> },
}

/// ~0.7 s of fresh audio between partial repaints: short enough to feel live,
/// long enough that each repaint (a whole-buffer redecode — the partial IS
/// the full text so far) outpaces the microphone on Metal. When a decode
/// falls behind, the drain loop below simply skips to the newest audio.
const DICT_PARTIAL_STEP_SECS: f64 = 0.7;

/// How much fresh audio to require before the next preview repaint.
///
/// Each repaint re-decodes the dictation FROM THE START, so its cost grows
/// with how long the person has been speaking. At a fixed 0.7 s step a
/// minutes-long dictation spends every spare cycle redecoding, the Mac runs
/// hot, and the preview falls further and further behind anyway. Requiring at
/// least as much new audio as the last decode consumed holds the decoder to
/// roughly half the machine: the preview updates less often as the dictation
/// grows, but it stops losing ground. The final text is unaffected — that is
/// one whole-utterance decode at Stop.
fn dict_partial_step(rate: u32, last_decode: std::time::Duration) -> usize {
    let base = (rate as f64 * DICT_PARTIAL_STEP_SECS) as usize;
    base.max((rate as f64 * last_decode.as_secs_f64()) as usize)
}
/// Leak guard, not a UX limit: audio past this is dropped (10 min of speech
/// in one dictation is a stuck mic, not a user).
const DICT_MAX_SECS: usize = 600;

#[tauri::command]
pub fn dict_start(app: tauri::AppHandle, dict: State<'_, DictState>) -> Result<(), String> {
    let Some(model) = stt_effective_model(&app) else {
        return Err("STT_MODEL_MISSING".into());
    };
    let (tx, rx) = std::sync::mpsc::channel();
    // Replacing a stale session drops its sender; that worker sees the
    // disconnect and exits on its own.
    *dict.session.lock().unwrap() = Some(DictSession { tx });
    std::thread::spawn(move || dict_worker(app, model, rx));
    Ok(())
}

/// Same wire format as `rec_push_audio`: ~250 ms of little-endian f32 mic
/// samples, base64-packed, at the AudioContext's native rate. `async` for the
/// same reason: unpacking audio four times a second does not belong on the
/// thread that paints the window.
#[tauri::command]
pub async fn dict_push_audio(
    dict: State<'_, DictState>,
    rate: u32,
    data_b64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let guard = dict.session.lock().unwrap();
    let session = guard.as_ref().ok_or("No dictation in progress.")?;
    let _ = session.tx.send(DictMsg::Audio { rate, samples });
    Ok(())
}

/// Close the session and return the final whole-utterance transcript (may be
/// empty — the caller shows "No speech detected"). The frontend AWAITS its
/// last audio push before invoking this, so Stop is ordered after the final
/// samples on the worker's channel and the last word is never clipped.
#[tauri::command]
pub async fn dict_stop(dict: State<'_, DictState>) -> Result<String, String> {
    let done_rx = {
        let mut guard = dict.session.lock().unwrap();
        let session = guard.take().ok_or("No dictation in progress.")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        session
            .tx
            .send(DictMsg::Stop { done: done_tx })
            .map_err(|_| "The dictation engine stopped unexpectedly.".to_string())?;
        done_rx
    };
    tauri::async_runtime::spawn_blocking(move || {
        done_rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|_| "Transcribing the dictation timed out.".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abandon the session without a final decode (setup failed mid-way).
#[tauri::command]
pub fn dict_cancel(dict: State<'_, DictState>) -> Result<(), String> {
    dict.session.lock().unwrap().take();
    Ok(())
}

fn dict_worker<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    model: std::path::PathBuf,
    rx: std::sync::mpsc::Receiver<DictMsg>,
) {
    use tauri::Emitter;
    let mut native: Vec<f32> = Vec::new(); // at the tap's native rate
    let mut rate: u32 = 16000;
    let mut decoded_len = 0usize;
    let mut last_text = String::new();
    // How long the previous preview decode took — the budget for the next one
    // (see `dict_partial_step`).
    let mut last_decode = std::time::Duration::ZERO;
    let finalize = |native: &[f32], rate: u32,
                    done: std::sync::mpsc::Sender<Result<String, String>>| {
        let pcm = recording::resample_to_16k(native, rate);
        let _ = done.send(stt::transcribe(&model, &pcm, false));
    };
    loop {
        match rx.recv() {
            Ok(DictMsg::Audio { rate: r, samples }) => {
                rate = r;
                if native.len() < rate as usize * DICT_MAX_SECS {
                    native.extend(samples);
                }
                // Drain everything already queued before deciding to decode —
                // a partial that took longer than 250 ms must not make the
                // loop fall ever further behind the microphone.
                loop {
                    match rx.try_recv() {
                        Ok(DictMsg::Audio { rate: r, samples }) => {
                            rate = r;
                            if native.len() < rate as usize * DICT_MAX_SECS {
                                native.extend(samples);
                            }
                        }
                        Ok(DictMsg::Stop { done }) => {
                            finalize(&native, rate, done);
                            return;
                        }
                        Err(_) => break,
                    }
                }
                let step = dict_partial_step(rate, last_decode);
                if native.len() - decoded_len >= step {
                    decoded_len = native.len();
                    let pcm = recording::resample_to_16k(&native, rate);
                    let began = std::time::Instant::now();
                    // Partial failures are cosmetic — the final decode at
                    // Stop is the one that must not lose words.
                    let decoded = stt::transcribe(&model, &pcm, false);
                    last_decode = began.elapsed();
                    if let Ok(text) = decoded {
                        if text != last_text {
                            last_text = text.clone();
                            let _ = app.emit("dict-partial", text);
                        }
                    }
                }
            }
            Ok(DictMsg::Stop { done }) => {
                finalize(&native, rate, done);
                return;
            }
            Err(_) => return, // session replaced or cancelled
        }
    }
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
    // cloud engine, whatever the chat model is set to. That is the Settings
    // screen's explicit promise, so it is the ONE deliberate exception to
    // engine parity: external CLIs AND `:cloud` proxies are both swapped for
    // a genuinely local model (the old check missed `:cloud`, silently
    // shipping dictated words to Ollama's servers).
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
            .unwrap_or_else(|| best_local_default(&models))
    };
    if is_external_engine(&model) || is_cloud_model(&model) {
        model = best_local_default(&models);
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


#[cfg(test)]
mod tests {
    use super::*;

    /// Each preview repaint re-decodes the dictation from the start, so its
    /// cost grows with how long someone has been speaking. A fixed step meant
    /// a minutes-long dictation spent every cycle redecoding, the Mac ran hot,
    /// and the preview fell further and further behind anyway.
    #[test]
    fn the_dictation_preview_step_grows_with_what_a_decode_costs() {
        use std::time::Duration;
        let rate = 48_000u32;
        let base = (rate as f64 * DICT_PARTIAL_STEP_SECS) as usize;
        // A decode that outruns the microphone keeps the lively fixed step.
        assert_eq!(dict_partial_step(rate, Duration::ZERO), base);
        assert_eq!(dict_partial_step(rate, Duration::from_millis(100)), base);
        // Once a decode costs more than the step, it buys itself that much
        // fresh audio — roughly half the machine, never more.
        assert_eq!(dict_partial_step(rate, Duration::from_secs(3)), rate as usize * 3);
        assert!(dict_partial_step(rate, Duration::from_secs(30)) > dict_partial_step(rate, Duration::from_secs(3)));
    }

    /// The streaming dictation worker end-to-end against the real model:
    /// audio chunks in → at least one `dict-partial` while "speaking" → the
    /// final whole-utterance transcript at Stop. Ignored like stt.rs's e2e
    /// tests: `cargo test --lib stt_cmds -- --ignored`.
    #[test]
    #[ignore = "needs the downloaded model (Settings → Download voice model)"]
    fn e2e_dict_worker_partials_then_final() {
        use tauri::Listener;
        let home = std::env::var("HOME").unwrap();
        let downloaded = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.benreich.privateroom/models")
            .join(stt::MODEL_FILE);
        let model = if downloaded.exists() {
            downloaded
        } else {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/models")
                .join(stt::MODEL_FILE)
        };
        assert!(model.exists(), "download the model first (Settings)");

        let aiff = std::env::temp_dir()
            .join(format!("pr-dict-e2e-{}.aiff", uuid::Uuid::new_v4()));
        assert!(std::process::Command::new("say")
            .args(["-o"])
            .arg(&aiff)
            .arg("The quick brown fox jumps over the lazy dog.")
            .status()
            .unwrap()
            .success());
        let pcm = stt::decode_to_pcm(&aiff, stt::MediaKind::Audio).unwrap();
        let _ = std::fs::remove_file(&aiff);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (partial_tx, partial_rx) = std::sync::mpsc::channel::<String>();
        app.listen("dict-partial", move |event| {
            // The payload is the JSON-encoded partial string.
            if let Ok(text) = serde_json::from_str::<String>(event.payload()) {
                let _ = partial_tx.send(text);
            }
        });

        let (tx, rx) = std::sync::mpsc::channel();
        let handle = {
            let app = app.handle().clone();
            let model = model.clone();
            std::thread::spawn(move || dict_worker(app, model, rx))
        };
        // ~250 ms chunks at 16 kHz, like the tap pushes (already 16k mono, so
        // resample_to_16k is an identity pass).
        for chunk in pcm.chunks(4000) {
            tx.send(DictMsg::Audio { rate: 16000, samples: chunk.to_vec() }).unwrap();
        }
        // A partial must arrive while the "speaking" is still open (generous
        // window: a cold context loads the model first).
        let partial = partial_rx
            .recv_timeout(std::time::Duration::from_secs(90))
            .expect("no dict-partial arrived");
        assert!(
            partial.to_lowercase().contains("quick brown fox"),
            "unexpected partial: {partial}"
        );

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        tx.send(DictMsg::Stop { done: done_tx }).unwrap();
        let final_text = done_rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .expect("worker never finalized")
            .expect("final transcribe failed");
        assert!(
            final_text.to_lowercase().contains("quick brown fox"),
            "unexpected final: {final_text}"
        );
        handle.join().unwrap();
        stt::unload_ctx();
    }
}
