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
fn merge_typed_since(
    rebuilt: &mut std::collections::BTreeMap<String, String>,
    prior: &std::collections::BTreeMap<String, String>,
    current: std::collections::BTreeMap<String, String>,
) {
    for (label, name) in current {
        if prior.get(&label) == Some(&name) || rebuilt.contains_key(&label) {
            continue;
        }
        rebuilt.insert(label, name);
    }
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

    let (samples, prior) = state.with_room(|room| {
        let (_name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        let samples = recording::decode_wav(&bytes.unwrap_or_default())?;
        let prior = parse_meta(db::get_rec_meta(&room.conn, &id))?;
        Ok((samples, prior))
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
            merge_typed_since(&mut meta.speaker_names, &prior_names, current.speaker_names);
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
pub async fn rec_stop(rec: State<'_, RecState>) -> Result<RecMeta, String> {
    let (done_rx, shared) = {
        let mut guard = rec.session.lock().unwrap();
        let live = guard.take().ok_or("No live recording.")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let _ = live.handle.tx.send(EngineMsg::Stop { done: done_tx });
        (done_rx, live.handle.shared.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?
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

/// GH #5: name a speaker after the fact ("Speaker 2" → "Dana").
///
/// Stores an OVERLAY keyed by the machine label rather than rewriting the
/// segments, so re-clustering — which renames labels as a meeting grows — can't
/// destroy the name, and one write renames every line that speaker said. An
/// empty (or whitespace-only) `name` clears it back to the machine label.
///
/// Safe to call while a recording is live: only the name map is touched, and
/// the engine never reads it. The stored transcript text is refreshed so search
/// and the AI see the same names the screen does.
#[tauri::command]
pub fn rec_set_speaker_name(
    state: State<'_, AppState>,
    id: String,
    speaker: String,
    name: String,
) -> Result<RecMeta, String> {
    set_speaker_name(&state, &id, &speaker, &name)
}

/// The body of [`rec_set_speaker_name`], against a plain `AppState` — a
/// `State<'_, AppState>` can only be built by a running Tauri app, so the
/// command's refusals (no speaker chosen, a recording with no transcript, a
/// label nobody in the recording has) had no test of their own. The QA
/// stand-in's copy of them did, which is confidence the real code had not
/// earned.
fn set_speaker_name(
    state: &AppState,
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
    state.with_room(|room| {
        let mut meta = parse_meta(db::get_rec_meta(&room.conn, id))?;
        if meta.segments.is_empty() {
            return Err("That recording has no transcript yet.".into());
        }
        if !meta.segments.iter().any(|s| s.speaker == speaker) {
            return Err(format!("Nobody in this recording is labelled \"{speaker}\"."));
        }
        // Naming someone back to their machine label is a removal, not an
        // entry that shadows itself.
        if name.is_empty() || name == speaker {
            meta.speaker_names.remove(&speaker);
        } else {
            meta.speaker_names.insert(speaker, name);
        }
        let text = recording::transcript_text(&meta);
        // Rewrite the searchable transcript in place. The audio is untouched,
        // so this is not a new file version — renaming is not an edit to the
        // recording, and versioning every rename would bury the real edits.
        db::set_file_extracted_text(&room.conn, id, &text)?;
        db::set_rec_meta(&room.conn, id, &serde_json::to_string(&meta).map_err(|e| e.to_string())?)?;
        Ok(meta)
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
    let mut new_meta = RecMeta {
        max_speakers: meta.max_speakers,
        duration_cs: recording::cs_of_samples(spliced_len),
        // The edited copy keeps the same speaker labels, so it keeps their
        // names too (GH #5) — otherwise "Dana" silently reverts to "Speaker 2".
        speaker_names: meta.speaker_names.clone(),
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
            set_speaker_name(&state, &id, "   ", "Dana").unwrap_err(),
            "No speaker selected."
        );
        // A recording with no transcript has nobody to name.
        assert!(set_speaker_name(&state, &id, "Speaker 1", "Dana")
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
        assert!(set_speaker_name(&state, &id, "Speaker 7", "Dana")
            .unwrap_err()
            .contains("Speaker 7"));

        let named = set_speaker_name(&state, &id, "Speaker 1", "  Dana  ").unwrap();
        assert_eq!(named.speaker_names.get("Speaker 1").map(String::as_str), Some("Dana"));
        // Naming someone back to their machine label CLEARS the overlay rather
        // than storing an entry that shadows itself.
        let cleared = set_speaker_name(&state, &id, "Speaker 1", "Speaker 1").unwrap();
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
}
