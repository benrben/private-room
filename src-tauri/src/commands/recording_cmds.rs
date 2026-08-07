use super::*;
use crate::recording::{self, EngineMsg, RecCut, RecMeta};

// ADD-27: commands for the live Recording file. One live session at a time
// (one microphone, one system-audio tap); the engine itself lives in
// crate::recording — these commands only create it, feed it mic PCM from the
// WebView, and read/edit the persisted result.

#[derive(Default)]
pub struct RecState {
    pub session: Mutex<Option<LiveSession>>,
    /// Files with a re-transcription in flight. rec_start / rec_delete_range
    /// on them must refuse — a new live session's flush (or an edit) would
    /// silently overwrite the rewrite the moment it lands.
    pub retranscribing: Mutex<std::collections::HashSet<String>>,
}

pub struct LiveSession {
    pub file_id: String,
    pub handle: recording::EngineHandle,
    /// `caffeinate -i` for the session's lifetime: a Mac that idle-sleeps
    /// mid-meeting pauses capture, and nobody touches the machine while
    /// they're in a call. Killed on drop, whichever path drops the session.
    pub awake: Option<std::process::Child>,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        if let Some(child) = &mut self.awake {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The engine can finish WITHOUT a command (3-hour ceiling, room closed under
/// it). Its session entry would then sit stale, telling the next rec_start "a
/// recording is already running" forever — so every reader clears it lazily.
/// Both terminal states count: a session whose final write FAILED is just as
/// over as one that saved, and refusing every later recording would be a
/// second failure on top of the first.
fn clear_finished(session: &mut Option<LiveSession>) {
    if session.as_ref().is_some_and(|l| {
        matches!(l.handle.shared.status.lock().unwrap().as_str(), "saved" | "failed")
    }) {
        *session = None;
    }
}

/// A long recording job's Stop flag (rebuild, translate). Registered in the
/// SAME cancel registry chat's Stop uses (`AppState::cancels`), keyed by the
/// recording's own file id — so `cancel_ask(fileId)` stops one with no new
/// command to invoke, and the two places that already flip every flag in that
/// registry (`close_room`, `teardown_open_room`) stop it too: a rebuild used
/// to keep grinding for minutes against a room that was being torn down, and
/// then fail on the write.
///
/// The entry is removed on every return path, but only when it is still the
/// one THIS job registered. A second long job on the same recording replaces
/// it, and an unconditional remove would then delete the newer job's flag —
/// leaving it unstoppable and the registry claiming work that has finished
/// (every room-busy check in the app reads that map by emptiness).
struct RecStop<'a> {
    state: &'a AppState,
    key: String,
    flag: Arc<AtomicBool>,
}

impl<'a> RecStop<'a> {
    fn register(state: &'a AppState, key: &str) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut m) = state.cancels.lock() {
            m.insert(key.to_string(), flag.clone());
        }
        RecStop { state, key: key.to_string(), flag }
    }

    fn stopped(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

impl Drop for RecStop<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.state.cancels.lock() {
            if m.get(&self.key).is_some_and(|f| Arc::ptr_eq(f, &self.flag)) {
                m.remove(&self.key);
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecStart {
    pub file_id: String,
    pub name: String,
    pub meta: RecMeta,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecLive {
    pub file_id: String,
    pub status: String,
    pub duration_cs: i64,
    /// Durable per-source health, so a viewer mounted after a fast failure
    /// still learns about it: [status, message] for mic and sys.
    pub mic: (String, String),
    pub sys: (String, String),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecFile {
    pub name: String,
    pub meta: RecMeta,
}

/// A file's recording metadata. No row at all is a plain audio file (or a
/// brand-new recording) — an empty meta is the honest answer. A row that
/// cannot be READ is something else entirely, and used to look identical:
/// callers saw an empty transcript, and Resume then wrote that emptiness over
/// the stored one with no version snapshot to undo it. So it is an error.
fn parse_meta(json: Option<String>) -> Result<RecMeta, String> {
    match json {
        None => Ok(RecMeta::default()),
        Some(j) => serde_json::from_str(&j).map_err(|e| {
            format!(
                "This recording's transcript data can't be read ({e}). \
                 Its audio is intact — use History to restore an earlier version, \
                 or rebuild the transcript from the audio."
            )
        }),
    }
}

/// Start recording — either a brand-new recording file or resuming an
/// existing one (its audio continues seamlessly; wall-clock gaps are not
/// recorded). Microphone audio arrives separately via `rec_push_audio`
/// because capture happens in the WebView (its echo cancellation keeps the
/// meeting's speaker output from re-entering the mic lane); system audio is
/// captured natively (ScreenCaptureKit) when `system_audio` is on.
///
/// Nothing about the participants is asked or configured: the meeting's
/// speakers are discovered from their voices as they talk (see `diarize`).
#[tauri::command]
pub fn rec_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    file_id: Option<String>,
    system_audio: bool,
    live_translate: Option<String>,
) -> Result<RecStart, String> {
    // Wave 3 (Idea 9): don't begin a recording while a rollback is swapping.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let Some(model) = stt_effective_model(&app) else {
        return Err("STT_MODEL_MISSING".into());
    };
    let mut session = rec.session.lock().unwrap();
    clear_finished(&mut session);
    if let Some(live) = session.as_ref() {
        return Err(format!(
            "A recording is already running (file {}). Stop it first.",
            live.file_id
        ));
    }
    if file_id.as_ref().is_some_and(|id| rec.retranscribing.lock().unwrap().contains(id)) {
        return Err("This recording is being re-transcribed — wait for it to finish.".into());
    }

    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let live_translate = live_translate.filter(|l| !l.trim().is_empty());

    let (file_id, name, meta, base_samples) = match file_id {
        // Resume an existing recording file where it left off.
        Some(id) => {
            let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
            let meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
            let base = match bytes {
                Some(b) if !b.is_empty() => recording::decode_wav(&b)
                    .map_err(|e| format!("This file can't be continued: {e}"))?,
                _ => Vec::new(),
            };
            (id, name, meta, base)
        }
        // A fresh recording file, timestamp-named like voice notes are.
        None => {
            let stamp: String = room
                .conn
                .query_row("SELECT strftime('%Y-%m-%d %H.%M','now','localtime')", [], |r| r.get(0))
                .unwrap_or_default();
            let name = format!("Recording {stamp}.wav");
            let meta = RecMeta::default(); // max_speakers = 0 → discovered
            let file = db::insert_file(
                &room.conn,
                &name,
                "audio/wav",
                &recording::encode_wav(&[]),
                Some("(live recording)\n"),
                "recording",
            )?;
            db::set_rec_meta(&room.conn, &file.id, &serde_json::to_string(&meta).unwrap_or_default())?;
            (file.id, name, meta, Vec::new())
        }
    };
    let room_path = room.path.clone();
    // The voices this room already knows, read once — a returning speaker is
    // recognised from the first re-cluster instead of being numbered afresh.
    // Best-effort: a failed read means this recording names nobody
    // automatically, which is exactly how it behaved before there was a table.
    let known_voices = db::known_voices(&room.conn).unwrap_or_default();
    drop(guard);

    let handle = recording::start_engine(
        app.clone(),
        recording::EngineConfig {
            file_id: file_id.clone(),
            room_path,
            model_path: model,
            base_samples,
            meta: meta.clone(),
            system_audio,
            live_translate,
            known_voices,
        },
    );
    // QA hook: ARCELLE_QA_SYS_WAV=<16k mono wav> plays that file into
    // the meeting lane at real-time pace — the whole live loop (VAD →
    // streaming Whisper → events → persistence) runs without needing the
    // Screen Recording permission or a real meeting. Dev/QA only; the env
    // var simply doesn't exist in normal runs.
    if let Ok(wav_path) = std::env::var("ARCELLE_QA_SYS_WAV") {
        spawn_qa_sys_feeder(handle.tx.clone(), wav_path);
    }
    let awake = std::process::Command::new("/usr/bin/caffeinate")
        .arg("-i") // prevent idle SYSTEM sleep; the display may still sleep
        .spawn()
        .ok();
    *session = Some(LiveSession { file_id: file_id.clone(), handle, awake });
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(RecStart { file_id, name, meta })
}

/// QA-only (see rec_start): stream a WAV into the system-audio lane at
/// real-time pace, as if a meeting were playing.
fn spawn_qa_sys_feeder(tx: std::sync::mpsc::Sender<EngineMsg>, wav_path: String) {
    std::thread::spawn(move || {
        let Ok(bytes) = std::fs::read(&wav_path) else { return };
        let Ok(samples) = recording::decode_wav(&bytes) else { return };
        let chunk = recording::SAMPLE_RATE / 4; // 250 ms
        for part in samples.chunks(chunk) {
            if tx
                .send(EngineMsg::Audio {
                    source: recording::Source::Sys,
                    rate: recording::SAMPLE_RATE as u32,
                    samples: part.to_vec(),
                })
                .is_err()
            {
                return; // session ended
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}

/// Microphone PCM from the WebView's AudioWorklet: little-endian f32 samples,
/// base64-packed (~250 ms per call). `rate` is the AudioContext's real rate;
/// the engine resamples to 16 kHz.
///
/// `async` on purpose: a synchronous Tauri command runs on the thread that
/// paints the window, and this one fires four times a second for the whole
/// recording. Unpacking audio has no business there.
#[tauri::command]
pub async fn rec_push_audio(
    rec: State<'_, RecState>,
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
    let guard = rec.session.lock().unwrap();
    let live = guard.as_ref().ok_or("No live recording.")?;
    let _ = live.handle.tx.send(EngineMsg::Audio {
        source: recording::Source::Mic,
        rate,
        samples,
    });
    Ok(())
}

#[tauri::command]
pub fn rec_pause(rec: State<'_, RecState>) -> Result<(), String> {
    let guard = rec.session.lock().unwrap();
    let live = guard.as_ref().ok_or("No live recording.")?;
    let _ = live.handle.tx.send(EngineMsg::Pause);
    Ok(())
}

#[tauri::command]
pub fn rec_resume(rec: State<'_, RecState>) -> Result<(), String> {
    let guard = rec.session.lock().unwrap();
    let live = guard.as_ref().ok_or("No live recording.")?;
    let _ = live.handle.tx.send(EngineMsg::Resume);
    Ok(())
}

/// Toggle live translation mid-recording (None turns it off).
#[tauri::command]
pub fn rec_set_live_translate(
    rec: State<'_, RecState>,
    language: Option<String>,
) -> Result<(), String> {
    let guard = rec.session.lock().unwrap();
    let live = guard.as_ref().ok_or("No live recording.")?;
    let _ = live
        .handle
        .tx
        .send(EngineMsg::SetLiveTranslate(language.filter(|l| !l.trim().is_empty())));
    Ok(())
}

/// Toggle live transcription mid-recording. Off: audio keeps recording but no
/// text is decoded (the gap is recoverable later via `rec_retranscribe`).
/// Session-scoped — nothing persists; every rec_start begins ON.
#[tauri::command]
pub fn rec_set_live_stt(rec: State<'_, RecState>, on: bool) -> Result<(), String> {
    let guard = rec.session.lock().unwrap();
    let live = guard.as_ref().ok_or("No live recording.")?;
    let _ = live.handle.tx.send(EngineMsg::SetLiveStt(on));
    Ok(())
}

/// Rebuild a saved recording's whole transcript from its audio with the
/// CURRENT pipeline (recording::retranscribe) — for old recordings saved with
/// corrupted words, a wrong language lock, or older speaker logic, and for
/// gaps recorded with live transcription off. The audio is untouched; the old
/// transcript goes to version history ("Re-transcribed"). Progress arrives as
/// `rec-retranscribe` events {fileId, doneCs, totalCs}, ending at
/// doneCs == totalCs.
///
/// Stoppable: a rebuild of a long meeting runs for many minutes, so it holds a
/// [`RecStop`] flag keyed by the recording's file id — `cancel_ask(fileId)`
/// ends it, and so does closing the room. Nothing is written until it
/// finishes, so a stopped rebuild leaves the transcript exactly as it was.
#[tauri::command]
pub async fn rec_retranscribe(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
) -> Result<RecMeta, String> {
    {
        let mut live = rec.session.lock().unwrap();
        clear_finished(&mut live);
        if live.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
            return Err("Stop the live recording before re-transcribing it.".into());
        }
    }
    if !rec.retranscribing.lock().unwrap().insert(id.clone()) {
        return Err("This recording is already being re-transcribed.".into());
    }
    let stop = RecStop::register(state.inner(), &id);
    let out = rec_retranscribe_inner(&app, &state, id.clone(), stop.flag.clone()).await;
    rec.retranscribing.lock().unwrap().remove(&id);
    out
}

/// Fold the speaker names as they are ON DISK NOW into the ones the rebuild
/// produced (GH #5).
///
/// Only what was typed SINCE the rebuild started may come back. The rest of the
/// stored map is the pre-rebuild one, and the rebuild has already moved every
/// name onto the label its voice ended up with (`diarize::move_names`) — so
/// re-adding `{"Speaker 2": "Dana"}` on top of the rebuilt `{"Speaker 1":
/// "Dana"}` puts one person on two speakers, which is the very symptom GH #5 is
/// about. An entry counts as typed since when the snapshot did not already hold
/// that exact name for that label, and it is added only where the rebuild left
/// the label unnamed: a name the rebuild placed itself is the one that follows
/// the voice.
///
/// Returns the names it brought back. They came from the user's keyboard while
/// the rebuild ran, so the caller can strip them out of the rebuild's GUESSES —
/// a name the user typed is never one the app inferred.
fn merge_typed_since(
    rebuilt: &mut std::collections::BTreeMap<String, String>,
    prior: &std::collections::BTreeMap<String, String>,
    current: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeSet<String> {
    let mut typed = std::collections::BTreeSet::new();
    for (label, name) in current {
        if prior.get(&label) == Some(&name) || rebuilt.contains_key(&label) {
            continue;
        }
        typed.insert(name.clone());
        rebuilt.insert(label, name);
    }
    typed
}

async fn rec_retranscribe_inner(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    id: String,
    stop: Arc<AtomicBool>,
) -> Result<RecMeta, String> {
    use tauri::Emitter;
    // Model resolution exactly like rec_start; the diarize weights ride along.
    let Some(model) = stt_effective_model(app) else {
        return Err("STT_MODEL_MISSING".into());
    };
    recording::install_diarize_model(app);
    recording::install_vad_model(app);

    let (samples, prior, known) = state.with_room(|room| {
        let (_name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        let samples = recording::decode_wav(&bytes.unwrap_or_default())?;
        let prior = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        // A rebuild recognises saved voices exactly as a fresh recording does
        // — it IS the current pipeline over this audio, and half a pipeline
        // would make "re-transcribe" quietly lose people's names.
        Ok((samples, prior, db::known_voices(&room.conn).unwrap_or_default()))
    })?;
    if samples.is_empty() {
        return Err("This recording has no audio yet.".into());
    }

    let progress_app = app.clone();
    let progress_id = id.clone();
    // The names as they were when the rebuild started — the yardstick for
    // spotting a rename typed while it ran (see `merge_typed_since`).
    let prior_names = prior.speaker_names.clone();
    let mut meta = tauri::async_runtime::spawn_blocking(move || {
        recording::retranscribe(
            &model,
            &samples,
            &prior,
            &known,
            |done_cs, total_cs| {
                let _ = progress_app.emit(
                    "rec-retranscribe",
                    serde_json::json!({ "fileId": progress_id, "doneCs": done_cs, "totalCs": total_cs }),
                );
            },
            move || stop.load(Ordering::SeqCst),
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    state.with_room(|room| {
        // A rename that landed WHILE this rebuild was running would otherwise
        // be overwritten by the snapshot it started from — the names typed
        // since are the newest ones, so they win (GH #5).
        if let Ok(current) = parse_meta(db::get_rec_meta(&room.conn, &id)) {
            let typed = merge_typed_since(&mut meta.speaker_names, &prior_names, current.speaker_names);
            // A name typed while the rebuild ran is the user's, so it must not
            // stay listed as something the app guessed: the screen would call
            // their own correction a guess, and the next pass would feel free
            // to withdraw it.
            meta.recognized.retain(|n| !typed.contains(n));
            // …and a guess whose label the rebuild did not mint at all is
            // about nobody in this transcript.
            meta.recognized.retain(|n| meta.speaker_names.values().any(|v| v == n));
        }
        // Same bytes, new transcript — through the single snapshotting write
        // path, so the old transcript stays recoverable via History.
        let bytes = db::get_file_bytes(&room.conn, &id)?.unwrap_or_default();
        let text = recording::transcript_text(&meta);
        store_file_bytes(&room.conn, &id, &bytes, Some(&text), "Re-transcribed")?;
        db::set_rec_meta(&room.conn, &id, &serde_json::to_string(&meta).map_err(|e| e.to_string())?)?;
        Ok(())
    })?;
    let _ = app.emit(
        "rec-retranscribe",
        serde_json::json!({ "fileId": id, "doneCs": meta.duration_cs, "totalCs": meta.duration_cs }),
    );
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// Stop and save. Waits for the tail phrases to finish transcribing and for
/// the whole-recording speaker pass (the engine drains its decoder before
/// flushing), so the returned meta is final.
///
/// There is deliberately NO wall-clock deadline here. The work at the end of
/// a stop grows with the recording's length — a long meeting's speaker pass
/// alone runs for minutes — and the old two-minute cap turned that into
/// "Saving the recording timed out." on recordings that were saving perfectly
/// and finished moments later. The wait ends when the engine answers or when
/// the engine is gone; `rec-save-progress` events name the phase throughout.
#[tauri::command]
pub async fn rec_stop(
    window: tauri::Window,
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
) -> Result<RecMeta, String> {
    let (done_rx, shared, file_id) = {
        let mut guard = rec.session.lock().unwrap();
        let live = guard.take().ok_or("No live recording.")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let _ = live.handle.tx.send(EngineMsg::Stop { done: done_tx });
        (done_rx, live.handle.shared.clone(), live.file_id.clone())
    };
    let meta = tauri::async_runtime::spawn_blocking(move || {
        match done_rx.recv() {
            Ok(result) => result,
            // The engine is gone without answering: it stopped itself first
            // (the 3-hour ceiling, or the room closing under it) and left its
            // verdict behind. Reporting a timeout for a recording that saved
            // fine is exactly what that used to look like.
            Err(_) => shared.outcome.lock().unwrap().clone().unwrap_or_else(|| {
                Err("The recording engine stopped before it could save.".to_string())
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    // The meeting is over and the transcript is durable: read it. Best-effort
    // and deliberately after the save — a stop must never fail because the
    // room could not start reading (no model installed, the queue full, a
    // recording with nothing said in it). The background sweep picks up
    // anything missed here.
    if !meta.segments.is_empty() {
        if let Ok(room_path) = state.with_room(|room| Ok(room.path.clone())) {
            let _ = start_rec_read(&window, &state, &room_path, &file_id).await;
        }
    }
    Ok(meta)
}

/// The live session, if any — lets a reopened view re-attach to a recording
/// that kept running while the user looked at other files.
#[tauri::command]
pub fn rec_live_status(rec: State<'_, RecState>) -> Option<RecLive> {
    let mut guard = rec.session.lock().unwrap();
    clear_finished(&mut guard);
    guard.as_ref().map(|live| {
        let sources = live.handle.shared.sources.lock().unwrap().clone();
        RecLive {
            file_id: live.file_id.clone(),
            status: live.handle.shared.status.lock().unwrap().clone(),
            duration_cs: live.handle.shared.duration_cs.load(std::sync::atomic::Ordering::Relaxed),
            mic: sources[0].clone(),
            sys: sources[1].clone(),
        }
    })
}

/// A recording file's editor payload: name + full meta (segments, words,
/// speakers, cuts).
#[tauri::command]
pub fn rec_get(state: State<'_, AppState>, id: String) -> Result<RecFile, String> {
    state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        Ok(RecFile { name, meta })
    })
}

/// THE one way to change a recording's metadata. Everything that edits a
/// transcript's overlay — a speaker's name, a note, a mark, a chapter — goes
/// through here, live recording or not.
///
/// **The bug this exists for.** `Engine::flush` writes the engine's OWN copy of
/// the meta over the room's row every few phrases. A command that wrote to that
/// row while a recording was running was therefore erased seconds later, in
/// silence. `rec_delete_range` sidesteps this by refusing while live;
/// `rec_set_speaker_name` did not, so renaming a speaker mid-meeting quietly
/// lost the name — which is exactly the moment you know who is talking.
///
/// So: a LIVE recording's meta is edited on the engine thread
/// ([`recording::EngineMsg::EditMeta`]), which owns the authoritative copy and
/// persists it immediately. Anything else is edited in the room directly. Both
/// paths refresh the searchable transcript, so what search and the AI read can
/// never drift from what the screen shows.
///
/// `apply` may refuse (a label nobody carries, a time outside the recording);
/// its error reaches the user unchanged, and nothing is written.
pub(crate) fn edit_rec_meta(
    state: &AppState,
    rec: &RecState,
    id: &str,
    apply: impl FnOnce(&mut RecMeta) -> Result<(), String> + Send + 'static,
) -> Result<RecMeta, String> {
    let live_tx = {
        let mut session = rec.session.lock().unwrap();
        clear_finished(&mut session);
        session.as_ref().filter(|l| l.file_id == id).map(|l| l.handle.tx.clone())
    };
    if let Some(tx) = live_tx {
        let (done, wait) = std::sync::mpsc::channel();
        tx.send(recording::EngineMsg::EditMeta { apply: Box::new(apply), done })
            .map_err(|_| "That recording just stopped — try again.".to_string())?;
        // Bounded: the engine answers between phrases, and a caller blocked
        // forever on a wedged engine is a hung window. The stop/pause split
        // pass is the longest thing that can be in front of us.
        return wait
            .recv_timeout(std::time::Duration::from_secs(20))
            .map_err(|_| "The recording is busy — try again in a moment.".to_string())?;
    }
    state.with_room(|room| {
        let mut meta = parse_meta(db::get_rec_meta(&room.conn, id))?;
        apply(&mut meta)?;
        let text = recording::transcript_text(&meta);
        // The audio is untouched, so this is not a new file version — annotating
        // is not an edit to the recording, and versioning every note would bury
        // the real edits.
        db::set_file_extracted_text(&room.conn, id, &text)?;
        db::set_rec_meta(&room.conn, id, &serde_json::to_string(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
    })
}

/// GH #5: name a speaker after the fact ("Speaker 2" → "Dana").
///
/// Stores an OVERLAY keyed by the machine label rather than rewriting the
/// segments, so re-clustering — which renames labels as a meeting grows — can't
/// destroy the name, and one write renames every line that speaker said. An
/// empty (or whitespace-only) `name` clears it back to the machine label.
///
/// This is also where the room LEARNS a voice: the speaker's voiceprints are
/// folded into the saved-voices table, so the next recording recognises them
/// without being asked again (see `db::voices`). Correcting a name the app
/// guessed teaches both halves of the correction — the right person gains this
/// voice, the wrong one is told it is not theirs.
///
/// Safe to call while a recording is live — through [`edit_rec_meta`], which is
/// what makes that true. It used to say so while writing straight into the room,
/// and the engine's next flush erased the name a few seconds later.
#[tauri::command]
pub fn rec_set_speaker_name(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    speaker: String,
    name: String,
) -> Result<RecMeta, String> {
    set_speaker_name(&state, &rec, &id, &speaker, &name)
}

/// The body of [`rec_set_speaker_name`], against a plain `AppState` — a
/// `State<'_, AppState>` can only be built by a running Tauri app, so the
/// command's refusals (no speaker chosen, a recording with no transcript, a
/// label nobody in the recording has) had no test of their own. The QA
/// stand-in's copy of them did, which is confidence the real code had not
/// earned.
fn set_speaker_name(
    state: &AppState,
    rec: &RecState,
    id: &str,
    speaker: &str,
    name: &str,
) -> Result<RecMeta, String> {
    let speaker = speaker.trim().to_string();
    if speaker.is_empty() {
        return Err("No speaker selected.".into());
    }
    // A name long enough to blow out the transcript prefix is a paste accident.
    let name = name.trim().chars().take(60).collect::<String>();
    // What the app had GUESSED here and has just been corrected on, read out of
    // the edit itself. Teaching the room is DB work and the edit may run on the
    // engine thread, which has no room handle — so the edit reports what it saw
    // and the enrolment happens back here, once, on whichever path ran.
    let corrected: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let seen = corrected.clone();
    let (label, called) = (speaker.clone(), name.clone());
    let meta = edit_rec_meta(state, rec, id, move |meta| {
        if meta.segments.is_empty() {
            return Err("That recording has no transcript yet.".into());
        }
        if !meta.segments.iter().any(|s| s.speaker == label) {
            return Err(format!("Nobody in this recording is labelled \"{label}\"."));
        }
        // What this voice was called a moment ago, and whether the app is the
        // one that said so — the difference between "you are correcting my
        // guess" and "you are changing your own mind", which teach the room
        // opposite things.
        let was = meta.speaker_names.get(&label).cloned();
        let was_guessed = was.as_ref().is_some_and(|w| meta.recognized.contains(w));
        // Naming someone back to their machine label is a removal, not an
        // entry that shadows itself.
        if called.is_empty() || called == label {
            meta.speaker_names.remove(&label);
        } else {
            meta.speaker_names.insert(label.clone(), called.clone());
        }
        // Either way the name on this voice is now the user's own, so it is no
        // longer a guess — and must stop being re-decided by the next pass.
        if let Some(was) = &was {
            meta.recognized.remove(was);
        }
        meta.recognized.remove(&called);
        *seen.lock().unwrap() = was.filter(|_| was_guessed);
        Ok(())
    })?;
    let wrong = corrected.lock().unwrap().clone();
    state.with_room(|room| {
        learn_voice(&room.conn, &meta, &speaker, &name, wrong.as_deref());
        Ok(())
    })?;
    Ok(meta)
}

/// Teach the room this voice, so the NEXT recording knows who it is.
///
/// `label` is the machine label just named, `name` what the user called them
/// (empty clears the name), and `wrong` the name the app had GUESSED here and
/// has just been corrected on, if any.
///
/// Best-effort by design: this is an enhancement to a rename, and a rename that
/// refused to save because a voice could not be learned would be strictly worse
/// than one that quietly learns nothing. Nothing is learned when the voice has
/// too little speech behind it, or came from the DSP fallback — see
/// [`diarize::identity_print`], which is the one place that rule lives.
fn learn_voice(
    conn: &rusqlite::Connection,
    meta: &RecMeta,
    label: &str,
    name: &str,
    wrong: Option<&str>,
) {
    let prints: Vec<&recording::diarize::VoicePrint> = meta
        .segments
        .iter()
        .filter(|s| s.speaker == label)
        .filter_map(|s| s.voice.as_ref())
        .collect();
    let Some(print) = recording::diarize::identity_print(&prints) else { return };
    // The correction first: whatever the user renamed this to, the name they
    // renamed it FROM is now known to be somebody else.
    if let Some(wrong) = wrong.filter(|w| *w != name) {
        let _ = db::reject_voice(conn, wrong, &print);
    }
    if !name.is_empty() {
        let _ = db::enroll_voice(conn, name, &print);
    }
}

/// "Read this recording" / "Read again": have the room read a recording and
/// write its chapters, highlights and notes.
///
/// The same job the room starts by itself when a recording stops — this is the
/// button for the times it did not: no AI model installed then, the room was
/// busy, an old recording the background sweep has not reached, or a transcript
/// you have since corrected and want re-read.
///
/// Returns the job id, so the viewer can follow the progress card.
#[tauri::command]
pub async fn rec_read_start(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let room_path = state.with_room(|room| Ok(room.path.clone()))?;
    start_rec_read(&window, &state, &room_path, &id).await
}

// ---- your own notes, marks and chapters ---------------------------------
//
// Everything here goes through `edit_rec_meta`, so all of it works WHILE a
// recording is running — which is the point. Marking the moment someone says
// the thing that matters is the reason to have a mark button at all, and
// before `EngineMsg::EditMeta` a mark written mid-meeting was erased by the
// engine's next save.
//
// Anything the user writes or edits is `By::You`, and the room's reading pass
// never touches a `By::You` item again.

/// Where in the recording an item may sit. A time past the end is a bug in the
/// caller, not something to store — an item nobody can ever reach is worse
/// than a refusal.
fn at_time(meta: &RecMeta, t0: i64) -> Result<i64, String> {
    if t0 < 0 || (meta.duration_cs > 0 && t0 > meta.duration_cs) {
        return Err("That moment is outside this recording.".into());
    }
    Ok(t0)
}

fn clean(text: &str, cap: usize) -> String {
    text.trim().chars().take(cap).collect()
}

/// Write your own note at a moment. `kind` is decision | action | question |
/// point; anything else is a plain point.
#[tauri::command]
pub fn rec_note_add(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    t0: i64,
    kind: String,
    text: String,
    who: Option<String>,
) -> Result<RecMeta, String> {
    rec_note_add_inner(&state, &rec, &id, t0, &kind, &text, who)
}

/// The body of [`rec_note_add`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_note_add_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    t0: i64,
    kind: &str,
    text: &str,
    who: Option<String>,
) -> Result<RecMeta, String> {
    let text = clean(text, 400);
    if text.is_empty() {
        return Err("A note needs some words.".into());
    }
    let kind = match kind.trim() {
        "decision" => recording::NoteKind::Decision,
        "action" => recording::NoteKind::Action,
        "question" => recording::NoteKind::Question,
        _ => recording::NoteKind::Point,
    };
    let who = who.map(|w| clean(&w, 60)).filter(|w| !w.is_empty());
    edit_rec_meta(state, rec, id, move |meta| {
        let t0 = at_time(meta, t0)?;
        meta.notes.push(recording::RecNote {
            id: uuid::Uuid::new_v4().to_string(),
            t0,
            kind,
            text,
            who,
            by: recording::By::You,
        });
        meta.notes.sort_by_key(|n| n.t0);
        Ok(())
    })
}

/// Retype a note. Correcting one the ROOM wrote makes it yours, so the next
/// reading leaves it alone — the same rule as confirming a recognised speaker.
#[tauri::command]
pub fn rec_note_set(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    note_id: String,
    text: String,
) -> Result<RecMeta, String> {
    rec_note_set_inner(&state, &rec, &id, &note_id, &text)
}

/// The body of [`rec_note_set`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_note_set_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    note_id: &str,
    text: &str,
) -> Result<RecMeta, String> {
    let text = clean(text, 400);
    if text.is_empty() {
        return Err("A note needs some words.".into());
    }
    let note_id = note_id.to_string();
    edit_rec_meta(state, rec, id, move |meta| {
        let note = meta
            .notes
            .iter_mut()
            .find(|n| n.id == note_id)
            .ok_or("That note is no longer in this recording.")?;
        note.text = text;
        note.by = recording::By::You;
        Ok(())
    })
}

/// Name a section, starting at `t0`.
#[tauri::command]
pub fn rec_chapter_add(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    t0: i64,
    title: String,
) -> Result<RecMeta, String> {
    rec_chapter_add_inner(&state, &rec, &id, t0, &title)
}

/// The body of [`rec_chapter_add`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_chapter_add_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    t0: i64,
    title: &str,
) -> Result<RecMeta, String> {
    let title = clean(title, 80);
    if title.is_empty() {
        return Err("A chapter needs a name.".into());
    }
    edit_rec_meta(state, rec, id, move |meta| {
        let t0 = at_time(meta, t0)?;
        meta.chapters.push(recording::RecChapter {
            id: uuid::Uuid::new_v4().to_string(),
            t0,
            title,
            by: recording::By::You,
        });
        meta.chapters.sort_by_key(|c| c.t0);
        Ok(())
    })
}

/// Rename a chapter — and make it yours.
#[tauri::command]
pub fn rec_chapter_set(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    chapter_id: String,
    title: String,
) -> Result<RecMeta, String> {
    rec_chapter_set_inner(&state, &rec, &id, &chapter_id, &title)
}

/// The body of [`rec_chapter_set`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_chapter_set_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    chapter_id: &str,
    title: &str,
) -> Result<RecMeta, String> {
    let title = clean(title, 80);
    if title.is_empty() {
        return Err("A chapter needs a name.".into());
    }
    let chapter_id = chapter_id.to_string();
    edit_rec_meta(state, rec, id, move |meta| {
        let c = meta
            .chapters
            .iter_mut()
            .find(|c| c.id == chapter_id)
            .ok_or("That chapter is no longer in this recording.")?;
        c.title = title;
        c.by = recording::By::You;
        Ok(())
    })
}

/// Mark a span worth coming back to. `t1` before `t0` marks the instant.
#[tauri::command]
pub fn rec_highlight_add(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    t0: i64,
    t1: i64,
) -> Result<RecMeta, String> {
    rec_highlight_add_inner(&state, &rec, &id, t0, t1)
}

/// The body of [`rec_highlight_add`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_highlight_add_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    t0: i64,
    t1: i64,
) -> Result<RecMeta, String> {
    edit_rec_meta(state, rec, id, move |meta| {
        let t0 = at_time(meta, t0)?;
        meta.highlights.push(recording::RecHighlight {
            id: uuid::Uuid::new_v4().to_string(),
            t0,
            t1: t1.max(t0),
            by: recording::By::You,
        });
        meta.highlights.sort_by_key(|h| h.t0);
        Ok(())
    })
}

/// Remove one item. `kind` is "note" | "chapter" | "highlight".
///
/// Deleting one the ROOM wrote is a real removal, not a correction, so the
/// next reading may find it again — which is right: you removed this reading's
/// claim, not the fact that the words are there.
#[tauri::command]
pub fn rec_item_delete(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    kind: String,
    item_id: String,
) -> Result<RecMeta, String> {
    rec_item_delete_inner(&state, &rec, &id, &kind, &item_id)
}

/// The body of [`rec_item_delete`] against a plain `AppState` — the same reason
/// [`set_speaker_name`] has one: a `State<'_, _>` only exists inside a running
/// Tauri app, so a command with no plain body has no test.
fn rec_item_delete_inner(
    state: &AppState,
    rec: &RecState,
    id: &str,
    kind: &str,
    item_id: &str,
) -> Result<RecMeta, String> {
    let (kind, item_id) = (kind.to_string(), item_id.to_string());
    edit_rec_meta(state, rec, id, move |meta| {
        let before = meta.notes.len() + meta.chapters.len() + meta.highlights.len();
        match kind.as_str() {
            "note" => meta.notes.retain(|n| n.id != item_id),
            "chapter" => meta.chapters.retain(|c| c.id != item_id),
            "highlight" => meta.highlights.retain(|h| h.id != item_id),
            other => return Err(format!("Unknown item kind \"{other}\".")),
        }
        if before == meta.notes.len() + meta.chapters.len() + meta.highlights.len() {
            return Err("That item is no longer in this recording.".into());
        }
        Ok(())
    })
}

/// The voices this room can recognise, for Settings.
#[tauri::command]
pub fn voices_list(state: State<'_, AppState>) -> Result<Vec<db::SavedVoice>, String> {
    state.with_room(|room| db::saved_voices(&room.conn))
}

/// Forget a saved voice. Transcripts already written keep the names they show
/// — this is the room forgetting how to recognise someone, not a retraction of
/// what was said.
#[tauri::command]
pub fn voice_forget(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<db::SavedVoice>, String> {
    voice_forget_inner(&state, &name)
}

/// The body of [`voice_forget`] against a plain `AppState`, for the same
/// reason [`set_speaker_name`] has one: a `State<'_, AppState>` can only be
/// built by a running Tauri app, so a command with no plain body has no test.
fn voice_forget_inner(state: &AppState, name: &str) -> Result<Vec<db::SavedVoice>, String> {
    state.with_room(|room| {
        db::forget_voice(&room.conn, name.trim())?;
        db::saved_voices(&room.conn)
    })
}

/// Studio-style transcript editing: delete a time span. The words inside it
/// disappear from the transcript, playback skips it, and "export edited copy"
/// cuts it from the audio for real. Non-destructive (a cut list + word marks);
/// the file version snapshot makes it undoable.
#[tauri::command]
pub fn rec_delete_range(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    t0: i64,
    t1: i64,
) -> Result<RecMeta, String> {
    if t1 <= t0 {
        return Err("Nothing selected.".into());
    }
    {
        let mut live = rec.session.lock().unwrap();
        clear_finished(&mut live);
        if live.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
            return Err("Pause the recording before editing the transcript.".into());
        }
    }
    if rec.retranscribing.lock().unwrap().contains(&id) {
        return Err("This recording is being re-transcribed — wait for it to finish.".into());
    }
    state.with_room(|room| {
        let mut meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        for seg in &mut meta.segments {
            for w in &mut seg.words {
                if w.t0 < t1 && w.t1 > t0 {
                    w.del = true;
                }
            }
            // A segment without word timings (legacy) is dropped wholesale when
            // the cut swallows it.
            if seg.words.is_empty() && seg.t0 >= t0 && seg.t1 <= t1 {
                seg.text.clear();
            }
        }
        recording::add_cut(&mut meta.cuts, RecCut { t0, t1 });
        let bytes = db::get_file_bytes(&room.conn, &id)?.unwrap_or_default();
        let text = recording::transcript_text(&meta);
        store_file_bytes(&room.conn, &id, &bytes, Some(&text), "Edited transcript")?;
        db::set_rec_meta(&room.conn, &id, &serde_json::to_string(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
    })
}

/// Retype the words a selection covers, keeping their place in time.
///
/// The transcript could be EDITED only by deleting — so a misheard name was a
/// choice between leaving it wrong and losing the sentence, and the recording's
/// text is what search, the AI and every export read. Correcting is not
/// deleting: the audio is untouched, no cut is added, and `del` is never set.
///
/// Deliberately confined to ONE phrase. A correction spread across a speaker
/// change has no honest place to put the new words — whose line are they? —
/// and guessing there would put words in somebody's mouth. Split behaviour is
/// therefore refused with a message that says what to do instead.
pub(crate) fn correct_words(
    seg: &mut recording::RecSegment,
    t0: i64,
    t1: i64,
    text: &str,
) -> Result<usize, String> {
    let hit: Vec<usize> = seg
        .words
        .iter()
        .enumerate()
        .filter(|(_, w)| !w.del && w.t0 < t1 && w.t1 > t0)
        .map(|(i, _)| i)
        .collect();
    let (Some(&first), Some(&last)) = (hit.first(), hit.last()) else {
        return Ok(0);
    };
    let span_t0 = seg.words[first].t0;
    let span_t1 = seg.words[last].t1;
    let tokens: Vec<&str> = text.split_whitespace().collect();
    // Timings are spread evenly across the span the old words occupied. It is
    // an approximation and it is stated as one: what it must NOT do is invent a
    // time outside the words that were really said, because playback, the
    // subtitle export and the audio cut all read these numbers.
    let span = (span_t1 - span_t0).max(1);
    let n = tokens.len().max(1) as i64;
    let replacement: Vec<recording::RecWord> = tokens
        .iter()
        .enumerate()
        .map(|(i, w)| recording::RecWord {
            w: (*w).to_string(),
            t0: span_t0 + span * i as i64 / n,
            t1: span_t0 + span * (i as i64 + 1) / n,
            del: false,
        })
        .collect();
    // Splice in place: the words BEFORE and AFTER the selection keep their own
    // timings, including any already marked deleted inside the range's gaps.
    let tail = seg.words.split_off(last + 1);
    seg.words.truncate(first);
    seg.words.extend(replacement);
    seg.words.extend(tail);
    Ok(hit.len())
}

/// Studio-style transcript editing: retype what a selection says.
#[tauri::command]
pub fn rec_correct_range(
    state: State<'_, AppState>,
    rec: State<'_, RecState>,
    id: String,
    t0: i64,
    t1: i64,
    text: String,
) -> Result<RecMeta, String> {
    if t1 <= t0 {
        return Err("Nothing selected.".into());
    }
    // An empty correction is a DELETE, and delete is a different button with a
    // different consequence (it cuts the audio). Never guess which was meant.
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Type the corrected words, or use \"Delete from recording\" to remove them.".into());
    }
    {
        let mut live = rec.session.lock().unwrap();
        clear_finished(&mut live);
        if live.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
            return Err("Pause the recording before editing the transcript.".into());
        }
    }
    if rec.retranscribing.lock().unwrap().contains(&id) {
        return Err("This recording is being re-transcribed — wait for it to finish.".into());
    }
    state.with_room(|room| {
        let mut meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        let touched: Vec<usize> = meta
            .segments
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.words.iter().any(|w| !w.del && w.t0 < t1 && w.t1 > t0)
            })
            .map(|(i, _)| i)
            .collect();
        match touched.as_slice() {
            [] => {
                return Err(
                    "Nothing to correct there — that selection has no word timings. Re-transcribe the recording to get them."
                        .into(),
                )
            }
            [one] => {
                let n = correct_words(&mut meta.segments[*one], t0, t1, &text)?;
                if n == 0 {
                    return Err("Nothing to correct there.".into());
                }
            }
            _ => {
                return Err(
                    "That selection crosses more than one phrase. Correct one phrase at a time — otherwise there is no honest way to say who said the new words."
                        .into(),
                )
            }
        }
        let bytes = db::get_file_bytes(&room.conn, &id)?.unwrap_or_default();
        let text = recording::transcript_text(&meta);
        store_file_bytes(&room.conn, &id, &bytes, Some(&text), "Corrected transcript")?;
        db::set_rec_meta(&room.conn, &id, &serde_json::to_string(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
    })
}

/// Render the edits into a new file: cut spans removed from the audio,
/// timestamps re-flowed, deleted words gone. The original stays untouched.
///
/// The room lock is held only to READ the recording and again to write the
/// copy. Decoding, splicing and re-encoding a multi-hour WAV in between used
/// to happen under that lock, which froze every other thing the room does —
/// files, chat, search — for as long as it took.
#[tauri::command]
pub async fn rec_export_clean(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let (name, bytes, meta) = state.with_room(|room| {
        let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        let meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        Ok((name, bytes, meta))
    })?;
    if meta.cuts.is_empty() && meta.segments.iter().all(|s| s.words.iter().all(|w| !w.del)) {
        return Err("No edits to apply — delete something from the transcript first.".into());
    }
    // Decoding, splicing and re-encoding a multi-hour WAV is minutes of CPU.
    // A synchronous Tauri command runs on the thread that PAINTS the window, so
    // doing it there froze the whole app — not just the room — with no progress
    // and nothing to click. Off the UI thread; the room lock is not held here
    // either (see the doc comment).
    let (spliced, new_meta) = tauri::async_runtime::spawn_blocking(move || {
        let samples = recording::decode_wav(&bytes.unwrap_or_default())?;
        let spliced = recording::splice_out(&samples, &meta.cuts);
        drop(samples);
        let new_meta = reflow_after_cuts(&meta, spliced.len());
        Ok::<_, String>((spliced, new_meta))
    })
    .await
    .map_err(|e| e.to_string())??;

    let stem = name.trim_end_matches(".wav");
    let new_name = format!("{stem} (edited).wav");
    let transcript = recording::transcript_text(&new_meta);
    let wav = recording::encode_wav(&spliced);
    drop(spliced);
    let file = state.with_room(|room| {
        let file = db::insert_file(
            &room.conn,
            &new_name,
            "audio/wav",
            &wav,
            Some(&transcript),
            "recording",
        )?;
        db::set_rec_meta(
            &room.conn,
            &file.id,
            &serde_json::to_string(&new_meta).map_err(|e| e.to_string())?,
        )?;
        Ok(file)
    })?;
    let _ = app.emit("room-files-changed", ());
    Ok(file)
}

/// The surviving transcript, re-flowed onto the timeline the cuts leave behind:
/// deleted words gone, every remaining timestamp pulled back by the length of
/// the cuts before it, empty segments dropped.
pub(crate) fn reflow_after_cuts(meta: &RecMeta, spliced_len: usize) -> RecMeta {
    // Annotations move onto the shortened timeline with the words they point
    // at, and anything that pointed INTO a cut is dropped — the copy no longer
    // contains what it was about. The original keeps everything: cuts are
    // undoable, so un-deleting a span has to bring its notes back with it.
    let shift = |t: i64| t - recording::cut_shift_before(&meta.cuts, t);
    let kept = |t: i64| !recording::inside_cut(&meta.cuts, t);
    let mut new_meta = RecMeta {
        max_speakers: meta.max_speakers,
        duration_cs: recording::cs_of_samples(spliced_len),
        // The edited copy keeps the same speaker labels, so it keeps their
        // names too (GH #5) — otherwise "Dana" silently reverts to "Speaker 2".
        speaker_names: meta.speaker_names.clone(),
        recognized: meta.recognized.clone(),
        read_of: meta.read_of,
        chapters: meta
            .chapters
            .iter()
            .filter(|c| kept(c.t0))
            .map(|c| recording::RecChapter { t0: shift(c.t0), ..c.clone() })
            .collect(),
        highlights: meta
            .highlights
            .iter()
            .filter(|h| kept(h.t0))
            .map(|h| recording::RecHighlight {
                t0: shift(h.t0),
                t1: shift(h.t1),
                ..h.clone()
            })
            .collect(),
        notes: meta
            .notes
            .iter()
            .filter(|n| kept(n.t0))
            .map(|n| recording::RecNote { t0: shift(n.t0), ..n.clone() })
            .collect(),
        ..Default::default()
    };
    for seg in &meta.segments {
        let words: Vec<recording::RecWord> = seg
            .words
            .iter()
            .filter(|w| !w.del)
            .map(|w| recording::RecWord {
                w: w.w.clone(),
                t0: w.t0 - recording::cut_shift_before(&meta.cuts, w.t0),
                t1: w.t1 - recording::cut_shift_before(&meta.cuts, w.t1),
                del: false,
            })
            .collect();
        let text = recording::segment_visible_text(seg);
        if text.is_empty() {
            continue;
        }
        let t0 = words.first().map(|w| w.t0).unwrap_or_else(|| {
            seg.t0 - recording::cut_shift_before(&meta.cuts, seg.t0)
        });
        let t1 = words.last().map(|w| w.t1).unwrap_or_else(|| {
            seg.t1 - recording::cut_shift_before(&meta.cuts, seg.t1)
        });
        new_meta.segments.push(recording::RecSegment {
            id: uuid::Uuid::new_v4().to_string(),
            source: seg.source.clone(),
            speaker: seg.speaker.clone(),
            t0,
            t1,
            text,
            words,
            lang: seg.lang.clone(),
            // Carry the voiceprint over so the exported copy keeps its
            // speakers (and can still be re-clustered if it is resumed).
            voice: seg.voice.clone(),
        });
    }
    new_meta
}

/// Translate the whole transcript into any language on the LOCAL model,
/// saved as a sibling Markdown file with the timestamps and speakers kept
/// (Whisper *-turbo can't translate — see stt.rs — so the LLM does, batch by
/// batch, with `rec-translate-progress` events along the way).
///
/// Stoppable between batches, like the rebuild: a [`RecStop`] flag keyed by the
/// recording's file id, so `cancel_ask(fileId)` (and closing the room) ends a
/// translation that would otherwise hold the local model for many minutes. The
/// document is written only at the end, so stopping leaves no half file behind.
#[tauri::command]
pub async fn rec_translate(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    language: String,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let language = language.trim().to_string();
    if language.is_empty() {
        return Err("Pick a language first.".into());
    }
    let (name, lines) = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let meta = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        let lines: Vec<String> = meta
            .segments
            .iter()
            .filter_map(|seg| {
                let text = recording::segment_visible_text(seg);
                (!text.is_empty()).then(|| {
                    // The user's name for them, when set (GH #5).
                    let who = meta.display_speaker(&seg.speaker);
                    format!("{} {}: {}", recording::format_stamp(seg.t0), who, text)
                })
            })
            .collect();
        Ok((name, lines))
    })?;
    if lines.is_empty() {
        return Err("No transcript to translate yet — record something first.".into());
    }
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;

    const BATCH: usize = 12;
    let total = lines.len().div_ceil(BATCH);
    let mut translated: Vec<String> = Vec::with_capacity(lines.len());
    // Lines the model failed to return a translation for — kept in the
    // original language rather than dropped, and counted so the document can
    // say so instead of quietly being short.
    let mut untranslated = 0usize;
    let stop = RecStop::register(state.inner(), &id);
    for (i, batch) in lines.chunks(BATCH).enumerate() {
        if stop.stopped() {
            return Err("Stopped — no translated file was saved.".into());
        }
        let _ = window.emit(
            "rec-translate-progress",
            serde_json::json!({ "fileId": id, "done": i, "total": total }),
        );
        let numbered = batch.join("\n");
        let prompt = format!(
            "Translate the following transcript lines into {language}. Each line starts with a \
             [m:ss] timestamp and a speaker name — copy that prefix EXACTLY as it is, and \
             translate only the words after the colon. Output exactly {} lines, one per input \
             line, with no numbering, preamble, or explanations.\n\n{numbered}",
            batch.len()
        );
        let messages = vec![ollama::ChatMessage::new("user", prompt)];
        // MIGRATION Phase 2a: non-streamed sidecar `/generate` (no tools, no Stop).
        let out = ollama::generate(
            &model,
            messages,
            Some(0.2),
            KEEP_ALIVE_WARM,
            None,
        )
        .await?;
        let out = strip_think_spans(&out);
        let got: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        // The model broke the one-line-per-line contract by coming up short.
        // Whatever it did not translate keeps its ORIGINAL line: a turn that
        // silently disappears from the translated document is worse than one
        // that appears untranslated, and nothing warned about it before.
        translated.extend(got.iter().map(|s| s.to_string()));
        if got.len() < batch.len() {
            untranslated += batch.len() - got.len();
            translated.extend(batch[got.len()..].iter().cloned());
        }
    }
    let _ = window.emit(
        "rec-translate-progress",
        serde_json::json!({ "fileId": id, "done": total, "total": total }),
    );

    let stem = name.trim_end_matches(".wav");
    let out_name = format!("{stem} — {language}.md");
    let note = if untranslated > 0 {
        format!(
            " {untranslated} line(s) came back untranslated and are kept in the original \
             language — translate the file again to retry them._"
        )
    } else {
        "_".into()
    };
    let content = format!(
        "# {stem} — {language}\n\n_Translated on this Mac from the recording's transcript.{note}\n\n{}\n",
        translated.join("\n\n")
    );
    let meta = state.with_room(|room| {
        let meta = db::insert_file(
            &room.conn,
            &out_name,
            "text/markdown",
            content.as_bytes(),
            Some(&content),
            "generated",
        )?;
        // Room map: this translation was made from THIS recording. The name
        // says so too ("{stem} — {language}.md"), but a name is not evidence —
        // renaming either file would leave the map asserting a link it can no
        // longer check.
        db::set_derived_from(&room.conn, &meta.id, &id)?;
        Ok(meta)
    })?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A recording with no meta row is a plain audio file — empty is the
    /// right answer. A meta row that cannot be READ is damage, and it used to
    /// look identical: the viewer showed "no transcript", and Resume then
    /// wrote that emptiness over the stored one with nothing to undo it.
    #[test]
    fn unreadable_meta_is_an_error_not_an_empty_transcript() {
        assert_eq!(parse_meta(None).expect("no row is not damage").duration_cs, 0);

        let good = r#"{"durationCs":900,"segments":[],"cuts":[],"maxSpeakers":0}"#;
        assert_eq!(parse_meta(Some(good.into())).unwrap().duration_cs, 900);

        for damaged in ["", "{", "not json at all", r#"{"durationCs":"soon"}"#] {
            let err = parse_meta(Some(damaged.into()))
                .expect_err("damaged meta silently became an empty transcript");
            assert!(err.contains("can't be read"), "{err}");
            assert!(err.contains("History"), "the message must say how to get it back: {err}");
        }
    }

    fn names(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs.iter().map(|(l, n)| (l.to_string(), n.to_string())).collect()
    }

    /// No recording is running — so `edit_rec_meta` takes its room path. The
    /// LIVE path needs a real engine thread and is covered by
    /// `recording::tests` instead.
    fn idle() -> RecState {
        RecState::default()
    }

    /// GH #5. The rebuild moved "Dana" from Speaker 2 onto Speaker 1 (that is
    /// where her voice ended up). Merging the stored map back in wholesale put
    /// the old pair back beside the new one, so ONE person showed up as two
    /// named speakers — in the viewer, in the stored transcript, and in every
    /// translated document made from it.
    #[test]
    fn a_rebuild_does_not_re_add_the_pre_rebuild_speaker_name() {
        let mut rebuilt = names(&[("Speaker 1", "Dana")]);
        let prior = names(&[("Speaker 2", "Dana")]);
        // Nobody renamed anything while the rebuild ran: disk == the snapshot.
        merge_typed_since(&mut rebuilt, &prior, prior.clone());
        assert_eq!(
            rebuilt,
            names(&[("Speaker 1", "Dana")]),
            "the pre-rebuild pair came back — Dana is now two speakers"
        );
    }

    /// …but the reason that merge exists still holds: a name typed WHILE the
    /// rebuild was running is newer than the snapshot it started from.
    #[test]
    fn a_rename_typed_during_the_rebuild_survives_it() {
        let mut rebuilt = names(&[("Speaker 1", "Dana")]);
        let prior = names(&[("Speaker 2", "Dana")]);
        let current = names(&[
            ("Speaker 2", "Dana Levi"), // corrected mid-rebuild
            ("Speaker 3", "Yossi"),     // named for the first time mid-rebuild
        ]);
        merge_typed_since(&mut rebuilt, &prior, current);
        assert_eq!(rebuilt.get("Speaker 3").map(String::as_str), Some("Yossi"));
        assert_eq!(rebuilt.get("Speaker 2").map(String::as_str), Some("Dana Levi"));
        // The label the rebuild named itself is the one that followed the
        // voice, so it is not overwritten by the stale map.
        assert_eq!(rebuilt.get("Speaker 1").map(String::as_str), Some("Dana"));
    }

    /// A rebuild or a translation registers its Stop flag in the shared cancel
    /// registry under the recording's file id, so the Stop that already exists
    /// (`cancel_ask`) reaches it and closing the room ends it.
    #[test]
    fn a_long_recording_job_is_stoppable_through_the_shared_registry() {
        let state = AppState::default();
        let id = "rec-1".to_string();
        {
            let stop = RecStop::register(&state, &id);
            assert!(!stop.stopped());
            // What cancel_ask / close_room do to every flag in the registry.
            state.cancels.lock().unwrap().get(&id).expect("not registered").store(true, Ordering::SeqCst);
            assert!(stop.stopped(), "the job never saw the Stop");
        }
        assert!(
            state.cancels.lock().unwrap().is_empty(),
            "a finished job left the room looking busy forever"
        );
    }

    /// Two long jobs on the SAME recording: the first one's guard must not
    /// delete the second one's flag. Unconditional removal would leave the
    /// newer job unstoppable, and — worse — the reverse case leaks an entry,
    /// which every room-busy check (checkpoints, rollback, the summary filler)
    /// reads as work still in flight.
    #[test]
    fn a_finished_job_only_clears_its_own_stop_flag() {
        let state = AppState::default();
        let id = "rec-1".to_string();
        let second = {
            let first = RecStop::register(&state, &id);
            let second = RecStop::register(&state, &id);
            drop(first);
            assert!(
                state.cancels.lock().unwrap().contains_key(&id),
                "the older job's guard unregistered the newer job"
            );
            state.cancels.lock().unwrap().get(&id).unwrap().store(true, Ordering::SeqCst);
            assert!(second.stopped());
            second
        };
        drop(second);
        assert!(state.cancels.lock().unwrap().is_empty(), "the registry leaked an entry");
    }

    fn word(w: &str, t0: i64, t1: i64) -> recording::RecWord {
        recording::RecWord { w: w.to_string(), t0, t1, del: false }
    }

    fn phrase(words: Vec<recording::RecWord>) -> recording::RecSegment {
        let t0 = words.first().map(|w| w.t0).unwrap_or(0);
        let t1 = words.last().map(|w| w.t1).unwrap_or(0);
        recording::RecSegment {
            id: "s1".into(),
            source: "mic".into(),
            speaker: "You".into(),
            t0,
            t1,
            text: words.iter().map(|w| w.w.as_str()).collect::<Vec<_>>().join(" "),
            words,
            lang: None,
            voice: None,
        }
    }

    /// A transcript could be edited only by DELETING, so a misheard name was a
    /// choice between leaving it wrong and losing the sentence. Correcting must
    /// not become a delete by another route: no `del`, no cut, and the
    /// surrounding words keep their own timings.
    #[test]
    fn correcting_words_replaces_the_text_without_touching_the_audio() {
        let mut seg = phrase(vec![
            word("call", 0, 100),
            word("Jozzay", 100, 300),
            word("today", 300, 400),
        ]);
        let n = correct_words(&mut seg, 100, 300, "José Álvarez").unwrap();
        assert_eq!(n, 1, "one word was under the selection");
        let text = recording::segment_visible_text(&seg);
        assert_eq!(text, "call José Álvarez today");
        assert!(seg.words.iter().all(|w| !w.del), "a correction must never cut audio");
        // The new words live inside the span the old one occupied — playback,
        // the .srt export and the audio cut all read these numbers.
        let new_words: Vec<&recording::RecWord> =
            seg.words.iter().filter(|w| w.w != "call" && w.w != "today").collect();
        assert_eq!(new_words.len(), 2);
        assert_eq!(new_words[0].t0, 100);
        assert_eq!(new_words[new_words.len() - 1].t1, 300);
        // ...and the untouched neighbours are exactly where they were.
        let last = seg.words.len() - 1;
        assert_eq!((seg.words[0].w.as_str(), seg.words[0].t0, seg.words[0].t1), ("call", 0, 100));
        assert_eq!(
            (seg.words[last].w.as_str(), seg.words[last].t0, seg.words[last].t1),
            ("today", 300, 400)
        );
    }

    #[test]
    fn a_correction_shorter_than_what_it_replaces_leaves_no_stray_words() {
        let mut seg = phrase(vec![
            word("the", 0, 100),
            word("Jose", 100, 200),
            word("Al", 200, 300),
            word("Varez", 300, 400),
            word("file", 400, 500),
        ]);
        assert_eq!(correct_words(&mut seg, 100, 400, "Álvarez").unwrap(), 3);
        assert_eq!(recording::segment_visible_text(&seg), "the Álvarez file");
        assert_eq!(seg.words.len(), 3, "the replaced run must not leave remnants");
        // A selection that covers nothing is a no-op, never a silent rewrite.
        assert_eq!(correct_words(&mut seg, 9000, 9100, "nope").unwrap(), 0);
        assert_eq!(recording::segment_visible_text(&seg), "the Álvarez file");
    }

    /// An `AppState` holding a room on an in-memory DB, for the command bodies
    /// that only need the room.
    fn room_state(tag: &str) -> (AppState, Connection) {
        let uri = format!("file:{tag}?mode=memory&cache=shared");
        let reader = Connection::open(&uri).unwrap();
        reader.execute_batch(crate::db::SCHEMA).unwrap();
        let conn = Connection::open(&uri).unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn,
            path: uri,
            name: "QA".into(),
            password: "qa-room-pw".into(),
        });
        (state, reader)
    }

    /// GH #5's write path, which had no test of its own — only the QA stand-in
    /// had one, and the stand-in was missing two of these refusals entirely.
    #[test]
    fn naming_a_speaker_refuses_everything_it_cannot_honestly_do() {
        let (state, _reader) = room_state("rec-speaker-names");
        let id = state
            .with_room(|room| {
                Ok(db::insert_file(
                    &room.conn,
                    "call.wav",
                    "audio/wav",
                    b"",
                    Some("(live recording)"),
                    "recording",
                )?
                .id)
            })
            .unwrap();

        // No speaker chosen.
        assert_eq!(
            set_speaker_name(&state, &idle(), &id, "   ", "Dana").unwrap_err(),
            "No speaker selected."
        );
        // A recording with no transcript has nobody to name.
        assert!(set_speaker_name(&state, &idle(), &id, "Speaker 1", "Dana")
            .unwrap_err()
            .contains("no transcript yet"));

        let mut meta = RecMeta { duration_cs: 500, ..Default::default() };
        meta.segments.push(recording::RecSegment {
            speaker: "Speaker 1".into(),
            ..phrase(vec![word("hello", 0, 100)])
        });
        state
            .with_room(|room| {
                db::set_rec_meta(&room.conn, &id, &serde_json::to_string(&meta).unwrap())
            })
            .unwrap();

        // A label nobody in the recording carries.
        assert!(set_speaker_name(&state, &idle(), &id, "Speaker 7", "Dana")
            .unwrap_err()
            .contains("Speaker 7"));

        let named = set_speaker_name(&state, &idle(), &id, "Speaker 1", "  Dana  ").unwrap();
        assert_eq!(named.speaker_names.get("Speaker 1").map(String::as_str), Some("Dana"));
        // Naming someone back to their machine label CLEARS the overlay rather
        // than storing an entry that shadows itself.
        let cleared = set_speaker_name(&state, &idle(), &id, "Speaker 1", "Speaker 1").unwrap();
        assert!(cleared.speaker_names.is_empty());
    }

    /// The edited copy's transcript: cut words gone, everything after a cut
    /// pulled back by its length, and the speaker names carried over (GH #5).
    #[test]
    fn the_edited_copy_reflows_onto_the_shortened_timeline() {
        let mut meta = RecMeta { duration_cs: 600, ..Default::default() };
        meta.speaker_names.insert("Speaker 1".into(), "Dana".into());
        let mut seg = phrase(vec![
            word("keep", 0, 100),
            word("cut", 200, 300),
            word("keep-too", 400, 500),
        ]);
        seg.speaker = "Speaker 1".into();
        seg.words[1].del = true;
        meta.segments.push(seg);
        meta.cuts.push(RecCut { t0: 200, t1: 300 });

        let out = reflow_after_cuts(&meta, recording::SAMPLE_RATE * 5);
        assert_eq!(out.speaker_names.get("Speaker 1").map(String::as_str), Some("Dana"));
        assert_eq!(out.segments.len(), 1);
        let words: Vec<&str> = out.segments[0].words.iter().map(|w| w.w.as_str()).collect();
        assert_eq!(words, ["keep", "keep-too"], "a deleted word survived the export");
        // The surviving word moved back by the 100cs the cut removed before it.
        assert_eq!(out.segments[0].words[1].t0, 300);
        assert_eq!(out.duration_cs, 500, "the copy's length is the SPLICED audio's");
    }

    /// Annotations ride the shortened timeline with the words they point at.
    /// One before a cut (unmoved), one inside it (gone — the copy no longer
    /// contains what it was about), one after it (pulled back by the cut's
    /// length).
    #[test]
    fn the_edited_copy_moves_annotations_and_drops_the_ones_it_cut_out() {
        let mut meta = RecMeta { duration_cs: 600, ..Default::default() };
        let mut seg = phrase(vec![
            word("keep", 0, 100),
            word("cut", 200, 300),
            word("keep-too", 400, 500),
        ]);
        seg.words[1].del = true;
        meta.segments.push(seg);
        meta.cuts.push(RecCut { t0: 200, t1: 300 });

        let note = |t0: i64, text: &str| recording::RecNote {
            id: text.into(),
            t0,
            kind: recording::NoteKind::Decision,
            text: text.into(),
            who: None,
            by: recording::By::Room,
        };
        meta.notes = vec![note(50, "before"), note(250, "inside"), note(450, "after")];
        meta.chapters = vec![recording::RecChapter {
            id: "c".into(),
            t0: 450,
            title: "Second half".into(),
            by: recording::By::Room,
        }];
        meta.highlights = vec![recording::RecHighlight {
            id: "h".into(),
            t0: 400,
            t1: 500,
            by: recording::By::You,
        }];

        let out = reflow_after_cuts(&meta, recording::SAMPLE_RATE * 5);
        let kept: Vec<(&str, i64)> = out.notes.iter().map(|n| (n.text.as_str(), n.t0)).collect();
        assert_eq!(
            kept,
            [("before", 50), ("after", 350)],
            "a note inside the cut survived, or a surviving one did not move"
        );
        assert_eq!(out.chapters[0].t0, 350);
        assert_eq!((out.highlights[0].t0, out.highlights[0].t1), (300, 400));
        // …and the ORIGINAL is untouched: cuts are undoable, so un-deleting a
        // span has to bring its notes back with it.
        assert_eq!(meta.notes.len(), 3);
    }

    /// Your own items, through the one funnel. The refusals matter as much as
    /// the writes: an item at a moment nobody can reach is worse than a "no".
    #[test]
    fn your_own_items_are_yours_and_land_where_you_put_them() {
        let (state, _reader) = room_state("rec-own-items");
        let mut meta = RecMeta { duration_cs: 1000, ..Default::default() };
        meta.segments.push(recording::RecSegment {
            speaker: "Speaker 1".into(),
            ..phrase(vec![word("hello", 0, 100)])
        });
        let id = recording_named(&state, "talk.wav", &meta);
        let idle = idle();

        let out = rec_note_add_inner(&state, &idle, &id, 200, "decision", "Ship it", None).unwrap();
        assert_eq!(out.notes.len(), 1);
        assert_eq!(out.notes[0].by, recording::By::You, "your own note was filed as the room's");
        assert_eq!(out.notes[0].kind, recording::NoteKind::Decision);

        // A moment outside the recording is refused, not stored where nobody
        // can ever reach it.
        assert!(rec_note_add_inner(&state, &idle, &id, 99_999, "point", "nope", None)
            .unwrap_err()
            .contains("outside this recording"));
        assert!(rec_note_add_inner(&state, &idle, &id, -1, "point", "nope", None).is_err());
        assert!(rec_note_add_inner(&state, &idle, &id, 0, "point", "   ", None).is_err());

        // Chapters and marks, sorted by time as they go in.
        rec_chapter_add_inner(&state, &idle, &id, 500, "Later").unwrap();
        let out = rec_chapter_add_inner(&state, &idle, &id, 100, "Earlier").unwrap();
        assert_eq!(
            out.chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["Earlier", "Later"]
        );
        let out = rec_highlight_add_inner(&state, &idle, &id, 300, 100).unwrap();
        assert_eq!((out.highlights[0].t0, out.highlights[0].t1), (300, 300), "a backwards span");
    }

    /// Correcting something the ROOM wrote makes it yours — so the next
    /// reading leaves it alone, which is the same rule as confirming a
    /// recognised speaker name.
    #[test]
    fn correcting_the_rooms_item_makes_it_yours() {
        let (state, _reader) = room_state("rec-correct-items");
        let mut meta = RecMeta { duration_cs: 1000, ..Default::default() };
        meta.segments.push(recording::RecSegment {
            speaker: "Speaker 1".into(),
            ..phrase(vec![word("hello", 0, 100)])
        });
        meta.notes.push(recording::RecNote {
            id: "theirs".into(),
            t0: 100,
            kind: recording::NoteKind::Decision,
            text: "the room's reading".into(),
            who: None,
            by: recording::By::Room,
        });
        meta.chapters.push(recording::RecChapter {
            id: "c1".into(),
            t0: 100,
            title: "Room title".into(),
            by: recording::By::Room,
        });
        let id = recording_named(&state, "talk.wav", &meta);
        let idle = idle();

        let out = rec_note_set_inner(&state, &idle, &id, "theirs", "what was actually said").unwrap();
        assert_eq!(out.notes[0].by, recording::By::You);
        assert_eq!(out.notes[0].text, "what was actually said");

        let out = rec_chapter_set_inner(&state, &idle, &id, "c1", "My title").unwrap();
        assert_eq!(out.chapters[0].by, recording::By::You);

        // Removing something that is already gone is an error, not a silent
        // success — the caller believes the item is there.
        rec_item_delete_inner(&state, &idle, &id, "note", "theirs").unwrap();
        assert!(rec_item_delete_inner(&state, &idle, &id, "note", "theirs").is_err());
        assert!(rec_item_delete_inner(&state, &idle, &id, "nonsense", "c1").is_err());
    }

    /// A strong neural print pointing in a chosen direction — the shape
    /// `identity_print` will accept.
    fn voice_print(dir: usize) -> recording::diarize::VoicePrint {
        let mut vec = vec![0.0f32; 192];
        vec[dir] = 1.0;
        recording::diarize::VoicePrint { vec, voiced_frames: 400 }
    }

    /// A recording of one voice, already labelled, ready to be named.
    fn one_voice_meta(label: &str, dir: usize) -> RecMeta {
        let mut meta = RecMeta { duration_cs: 500, ..Default::default() };
        meta.segments.push(recording::RecSegment {
            speaker: label.into(),
            source: "sys".into(),
            voice: Some(voice_print(dir)),
            ..phrase(vec![word("hello", 0, 100)])
        });
        meta
    }

    fn recording_named(state: &AppState, file: &str, meta: &RecMeta) -> String {
        state
            .with_room(|room| {
                let id = db::insert_file(
                    &room.conn,
                    file,
                    "audio/wav",
                    b"",
                    Some("(live recording)"),
                    "recording",
                )?
                .id;
                db::set_rec_meta(&room.conn, &id, &serde_json::to_string(meta).unwrap())?;
                Ok(id)
            })
            .unwrap()
    }

    /// The whole point of the feature, at the write path: naming a speaker
    /// teaches the ROOM that voice, not just this transcript.
    #[test]
    fn naming_a_speaker_teaches_the_room_their_voice() {
        let (state, _reader) = room_state("rec-learns-voices");
        let id = recording_named(&state, "monday.wav", &one_voice_meta("Speaker 1", 3));

        assert!(
            state.with_room(|r| db::saved_voices(&r.conn)).unwrap().is_empty(),
            "a room knows nobody until it is told"
        );
        set_speaker_name(&state, &idle(), &id, "Speaker 1", "Dana").unwrap();
        let saved = state.with_room(|r| db::saved_voices(&r.conn)).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Dana");
        assert_eq!(saved[0].takes, 1);

        // …and the room can be told to forget again.
        assert!(voice_forget_inner(&state, "Dana").unwrap().is_empty());
    }

    /// A voice with almost nothing behind it is a fine label for THIS
    /// recording and far too little to recognise anyone by later. The name is
    /// still stored; only the identity is withheld.
    #[test]
    fn a_voice_barely_heard_is_named_but_not_learned() {
        let (state, _reader) = room_state("rec-thin-voice");
        let mut meta = one_voice_meta("Speaker 1", 3);
        meta.segments[0].voice.as_mut().unwrap().voiced_frames = 30;
        let id = recording_named(&state, "hallway.wav", &meta);

        let named = set_speaker_name(&state, &idle(), &id, "Speaker 1", "Dana").unwrap();
        assert_eq!(named.speaker_names.get("Speaker 1").map(String::as_str), Some("Dana"));
        assert!(
            state.with_room(|r| db::saved_voices(&r.conn)).unwrap().is_empty(),
            "half a sentence became a permanent identity"
        );
    }

    /// Correcting a guess must teach BOTH halves: the right person gains this
    /// voice, and the wrong one is told it is not theirs — otherwise the same
    /// mistake is made in every future recording, because the correction only
    /// ever taught the other name.
    #[test]
    fn correcting_a_guess_teaches_the_room_both_halves() {
        let (state, _reader) = room_state("rec-corrects-guesses");
        // Monday: Dana is named, so the room learns her voice.
        let monday = recording_named(&state, "monday.wav", &one_voice_meta("Speaker 1", 3));
        set_speaker_name(&state, &idle(), &monday, "Speaker 1", "Dana").unwrap();

        // Tuesday: somebody else turns up and the app guesses Dana.
        let mut meta = one_voice_meta("Speaker 1", 3);
        meta.speaker_names.insert("Speaker 1".into(), "Dana".into());
        meta.recognized.insert("Dana".into());
        let id = recording_named(&state, "tuesday.wav", &meta);

        let out = set_speaker_name(&state, &idle(), &id, "Speaker 1", "Michal").unwrap();
        assert_eq!(out.speaker_names.get("Speaker 1").map(String::as_str), Some("Michal"));
        assert!(out.recognized.is_empty(), "the user's own correction was filed as a guess");

        let saved = state.with_room(|r| db::saved_voices(&r.conn)).unwrap();
        let dana = saved.iter().find(|v| v.name == "Dana");
        assert_eq!(
            dana.map(|v| v.corrections),
            Some(1),
            "the wrong name was never told it was wrong: {saved:?}"
        );
        assert!(saved.iter().any(|v| v.name == "Michal"), "the right name learned nothing");

        // And the correction bites: this voice is no longer offered as Dana.
        let known = state.with_room(|r| db::known_voices(&r.conn)).unwrap();
        let dana = known.iter().find(|k| k.name == "Dana").expect("Dana is still a saved voice");
        assert_eq!(
            recording::diarize::recognize_groups(&[Some(voice_print(3))], &[dana.clone()], &[]),
            vec![None],
        );
    }

    /// A name the user typed is theirs. Clearing it back to the machine label
    /// must not be read as "that was never this person" — nothing was guessed,
    /// so there is nothing to deny.
    #[test]
    fn clearing_a_typed_name_denies_nobody() {
        let (state, _reader) = room_state("rec-clears-names");
        let id = recording_named(&state, "wednesday.wav", &one_voice_meta("Speaker 1", 3));
        set_speaker_name(&state, &idle(), &id, "Speaker 1", "Dana").unwrap();
        set_speaker_name(&state, &idle(), &id, "Speaker 1", "").unwrap();
        let saved = state.with_room(|r| db::saved_voices(&r.conn)).unwrap();
        assert_eq!(saved.iter().find(|v| v.name == "Dana").map(|v| v.corrections), Some(0));
    }

    /// The rebuild's own guesses do not outlive the labels they were made
    /// about, and a name typed while the rebuild ran is never filed as one.
    #[test]
    fn a_rebuild_does_not_call_the_users_own_rename_a_guess() {
        let mut rebuilt = names(&[("Speaker 1", "Dana")]);
        let prior = names(&[]);
        let typed = merge_typed_since(&mut rebuilt, &prior, names(&[("Speaker 2", "Yossi")]));
        assert_eq!(typed.into_iter().collect::<Vec<_>>(), ["Yossi"]);
        assert_eq!(rebuilt.get("Speaker 2").map(String::as_str), Some("Yossi"));
    }
}
