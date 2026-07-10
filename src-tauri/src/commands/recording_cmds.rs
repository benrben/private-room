use super::*;
use crate::recording::{self, EngineMsg, RecCut, RecMeta};

// ADD-27: commands for the live Recording file. One live session at a time
// (one microphone, one system-audio tap); the engine itself lives in
// crate::recording — these commands only create it, feed it mic PCM from the
// WebView, and read/edit the persisted result.

#[derive(Default)]
pub struct RecState {
    pub session: Mutex<Option<LiveSession>>,
}

pub struct LiveSession {
    pub file_id: String,
    pub handle: recording::EngineHandle,
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecFile {
    pub name: String,
    pub meta: RecMeta,
}

fn parse_meta(json: Option<String>) -> RecMeta {
    json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default()
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
    let Some(model) = stt_effective_model(&app) else {
        return Err("STT_MODEL_MISSING".into());
    };
    let mut session = rec.session.lock().unwrap();
    if let Some(live) = session.as_ref() {
        return Err(format!(
            "A recording is already running (file {}). Stop it first.",
            live.file_id
        ));
    }

    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let live_translate = live_translate.filter(|l| !l.trim().is_empty());

    let (file_id, name, meta, base_samples) = match file_id {
        // Resume an existing recording file where it left off.
        Some(id) => {
            let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
            let meta = parse_meta(db::get_rec_meta(&room.conn, &id));
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
    // QA hook: PRIVATE_ROOM_QA_SYS_WAV=<16k mono wav> plays that file into
    // the meeting lane at real-time pace — the whole live loop (VAD →
    // streaming Whisper → events → persistence) runs without needing the
    // Screen Recording permission or a real meeting. Dev/QA only; the env
    // var simply doesn't exist in normal runs.
    if let Ok(wav_path) = std::env::var("PRIVATE_ROOM_QA_SYS_WAV") {
        spawn_qa_sys_feeder(handle.tx.clone(), wav_path);
    }
    *session = Some(LiveSession { file_id: file_id.clone(), handle });
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
#[tauri::command]
pub fn rec_push_audio(
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

/// Stop and save. Waits for the tail phrases to finish transcribing (the
/// engine drains its decoder before flushing), so the returned meta is final.
#[tauri::command]
pub async fn rec_stop(rec: State<'_, RecState>) -> Result<RecMeta, String> {
    let done_rx = {
        let mut guard = rec.session.lock().unwrap();
        let live = guard.take().ok_or("No live recording.")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let _ = live.handle.tx.send(EngineMsg::Stop { done: done_tx });
        done_rx
    };
    tauri::async_runtime::spawn_blocking(move || {
        done_rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|_| "Saving the recording timed out.".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The live session, if any — lets a reopened view re-attach to a recording
/// that kept running while the user looked at other files.
#[tauri::command]
pub fn rec_live_status(rec: State<'_, RecState>) -> Option<RecLive> {
    let guard = rec.session.lock().unwrap();
    guard.as_ref().map(|live| RecLive {
        file_id: live.file_id.clone(),
        status: live.handle.shared.status.lock().unwrap().clone(),
        duration_cs: live.handle.shared.duration_cs.load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// A recording file's editor payload: name + full meta (segments, words,
/// speakers, cuts).
#[tauri::command]
pub fn rec_get(state: State<'_, AppState>, id: String) -> Result<RecFile, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let name = db::get_file_name(&room.conn, &id)?;
    let meta = parse_meta(db::get_rec_meta(&room.conn, &id));
    Ok(RecFile { name, meta })
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
        let live = rec.session.lock().unwrap();
        if live.as_ref().map(|l| l.file_id == id).unwrap_or(false) {
            return Err("Pause the recording before editing the transcript.".into());
        }
    }
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let mut meta = parse_meta(db::get_rec_meta(&room.conn, &id));
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
}

/// Render the edits into a new file: cut spans removed from the audio,
/// timestamps re-flowed, deleted words gone. The original stays untouched.
#[tauri::command]
pub fn rec_export_clean(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
    let meta = parse_meta(db::get_rec_meta(&room.conn, &id));
    if meta.cuts.is_empty() && meta.segments.iter().all(|s| s.words.iter().all(|w| !w.del)) {
        return Err("No edits to apply — delete something from the transcript first.".into());
    }
    let samples = recording::decode_wav(&bytes.unwrap_or_default())?;
    let spliced = recording::splice_out(&samples, &meta.cuts);

    // Re-flow the surviving segments onto the shortened timeline.
    let mut new_meta = RecMeta {
        max_speakers: meta.max_speakers,
        duration_cs: recording::cs_of_samples(spliced.len()),
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

    let stem = name.trim_end_matches(".wav");
    let new_name = format!("{stem} (edited).wav");
    let transcript = recording::transcript_text(&new_meta);
    let file = db::insert_file(
        &room.conn,
        &new_name,
        "audio/wav",
        &recording::encode_wav(&spliced),
        Some(&transcript),
        "recording",
    )?;
    db::set_rec_meta(&room.conn, &file.id, &serde_json::to_string(&new_meta).map_err(|e| e.to_string())?)?;
    let _ = app.emit("room-files-changed", ());
    Ok(file)
}

/// Translate the whole transcript into any language on the LOCAL model,
/// saved as a sibling Markdown file with the timestamps and speakers kept
/// (Whisper *-turbo can't translate — see stt.rs — so the LLM does, batch by
/// batch, with `rec-translate-progress` events along the way).
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
    let (name, lines) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let name = db::get_file_name(&room.conn, &id)?;
        let meta = parse_meta(db::get_rec_meta(&room.conn, &id));
        let lines: Vec<String> = meta
            .segments
            .iter()
            .filter_map(|seg| {
                let text = recording::segment_visible_text(seg);
                (!text.is_empty()).then(|| {
                    format!("{} {}: {}", recording::format_stamp(seg.t0), seg.speaker, text)
                })
            })
            .collect();
        (name, lines)
    };
    if lines.is_empty() {
        return Err("No transcript to translate yet — record something first.".into());
    }
    let model = resolve_local_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;

    const BATCH: usize = 12;
    let total = lines.len().div_ceil(BATCH);
    let mut translated: Vec<String> = Vec::with_capacity(lines.len());
    for (i, batch) in lines.chunks(BATCH).enumerate() {
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
        let (out, _) =
            ollama::chat_stream_tools(&model, messages, None, Some(0.2), None, KEEP_ALIVE_WARM, |_| {})
                .await?;
        let out = strip_think_spans(&out);
        let got: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if got.len() == batch.len() {
            translated.extend(got.iter().map(|s| s.to_string()));
        } else {
            // The model broke the line contract — keep whatever it said, the
            // words matter more than the shape.
            translated.extend(got.iter().map(|s| s.to_string()));
        }
    }
    let _ = window.emit(
        "rec-translate-progress",
        serde_json::json!({ "fileId": id, "done": total, "total": total }),
    );

    let stem = name.trim_end_matches(".wav");
    let out_name = format!("{stem} — {language}.md");
    let content = format!(
        "# {stem} — {language}\n\n_Translated on this Mac from the recording's transcript._\n\n{}\n",
        translated.join("\n\n")
    );
    let meta = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::insert_file(&room.conn, &out_name, "text/markdown", content.as_bytes(), Some(&content), "generated")?
    };
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
}
