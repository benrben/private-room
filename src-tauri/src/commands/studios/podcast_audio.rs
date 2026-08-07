//! Record a podcast script as audio: each host in their own voice, joined into
//! one m4a room file with a seekable transcript.
//!
//! THE PRIVACY SEAM, FIRST, BECAUSE IT IS THE BIGGEST ONE HERE. Speaking sends
//! text to Microsoft's Edge TTS service. The spoken-answer path has always done
//! that one sentence at a time through [`speakable_text`], which refuses when
//! the room's internet switch is off and masks the sentence through the privacy
//! door. THIS path sends an entire episode — every line of a script written FROM
//! the user's own documents — in one go. It goes through exactly the same
//! function, per line, for exactly that reason: a second, looser door on a much
//! larger seam would be the worst possible place to have one.
//!
//! Two consequences the UI is required to state before a build (see
//! `PodcastPanel.tsx`), because both are surprising after the fact:
//!
//!   * with the privacy door on, real names are SPOKEN as their placeholders
//!     ("Person A") — the audio is the redacted text, read aloud; and
//!   * with the room offline, there is no audio at all.
//!
//! WHY m4a AND NOT WAV. A ten-minute mono 24 kHz 16-bit WAV is ~29 MB, and a
//! room file is one SQLite blob. `afconvert` ships with macOS (the same
//! no-ffmpeg doctrine the recorder follows) and turns that into ~5 MB of AAC
//! that `stt::media_kind` already routes to the ordinary audio player.
//!
//! WHY THE TRANSCRIPT MATTERS. The sidecar returns the start offset of every
//! turn, so the file is saved with `[m:ss] Speaker: line` rows — the exact shape
//! `AudioView` already parses. The finished episode is therefore clickable,
//! speaker-labelled and searchable from the moment it lands, with no new viewer.

use super::*;

/// Ceiling on one episode. Each turn is at least one network round-trip, so
/// this is minutes of work either way; past this it is a runaway rather than a
/// podcast. Reported, never silently truncated.
const MAX_PODCAST_TURNS: usize = 400;

/// Render `file_id`'s script to audio and save it in the room.
///
/// Returns the new audio file's metadata. `progress` is called with
/// (done, total) so the job card can name which turn is being recorded.
pub(crate) async fn render_podcast_audio(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    script_file_id: &str,
    cancel: Arc<AtomicBool>,
    room_path: Option<&str>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;

    // Phase 1 (locked): read the script, the cast, and the outbound text.
    let (title, turns, cast) = state.with_room(|room| {
        if room_path.is_some_and(|rp| room.path != rp) {
            return Err("the room this job belongs to was closed".to_string());
        }
        let p = db::get_podcast(&room.conn, script_file_id).ok_or(
            "This file has no podcast script attached. Scripts made before voices \
             existed have to be generated again before they can be recorded.",
        )?;
        if p.turns.is_empty() {
            return Err("This script has no lines to read.".to_string());
        }
        Ok((p.title, p.turns, p.cast))
    })?;

    let capped = turns.len().saturating_sub(MAX_PODCAST_TURNS);
    let turns: Vec<db::PodcastTurn> = turns.into_iter().take(MAX_PODCAST_TURNS).collect();

    // THE DOOR. Every line goes through the same function one spoken sentence
    // does: the room's internet switch, then the privacy redactor. Done per
    // line rather than over the joined script so a refusal names the seam
    // exactly as the speaking path does, and so what is sent is what is stamped
    // into the transcript below.
    let mut outbound: Vec<serde_json::Value> = Vec::with_capacity(turns.len());
    let mut spoken: Vec<String> = Vec::with_capacity(turns.len());
    for t in &turns {
        let text = crate::commands::speech_cmds::speakable_text(state, &t.line)?;
        let host = cast
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(t.speaker.trim()));
        outbound.push(serde_json::json!({
            "text": text,
            "voice": host.map(|h| h.voice.clone()).unwrap_or_default(),
            "rate": host.map(|h| h.rate.clone()).unwrap_or_default(),
            "pitch": host.map(|h| h.pitch.clone()).unwrap_or_default(),
        }));
        // The TRANSCRIPT records what was actually said, which after redaction
        // is not always what the script says. A transcript of the unredacted
        // line beside audio of the redacted one would be the app disagreeing
        // with itself about what left the Mac.
        spoken.push(text);
    }

    crate::cancel::guard_commit(&cancel, "the podcast recording")?;
    let _ = window.emit(
        "studio-step",
        serde_json::json!({
            "step": format!("Recording {} turns — each line is sent to the cloud voice service…", turns.len()),
            "local": false,
        }),
    );

    // Phase 2 (unlocked): the long one. Minutes of network work, so the room
    // lock must not be held — a job that pinned the room for ten minutes would
    // freeze every other operation in the app.
    let resp = crate::sidecar::sidecar_json(
        "/tts/podcast",
        &serde_json::json!({ "turns": outbound, "gap_ms": 420 }),
    )
    .await
    .map_err(|e| e.error)?;
    let wav_b64 = resp
        .get("audio_b64")
        .and_then(|v| v.as_str())
        .ok_or("the voice service returned no audio")?;
    let offsets: Vec<i64> = resp
        .get("offsets_ms")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_b64)
        .map_err(|e| format!("the voice service returned unreadable audio: {e}"))?;

    crate::cancel::guard_commit(&cancel, "the podcast recording")?;
    let _ = window.emit(
        "studio-step",
        serde_json::json!({ "step": "Encoding the episode…", "local": true }),
    );
    let (bytes, mime, ext) = encode_episode(wav)?;

    // The transcript AudioView already knows how to read. Built from the
    // offsets the synthesizer measured, so every row seeks to the exact line.
    let transcript = timed_transcript(&title, &turns, &spoken, &offsets, capped);

    // Phase 3 (locked): the write. Re-pinned and re-guarded immediately before
    // the side effect — a Stop pressed during the long call above must not land
    // a file after the UI has said the run stopped.
    crate::cancel::guard_commit(&cancel, "the podcast recording")?;
    let meta = state.with_room(|room| {
        if room_path.is_some_and(|rp| room.path != rp) {
            return Err("the room this job belongs to was closed".to_string());
        }
        // Re-casting deliberately KEEPS the previous episode (it is a real file
        // the user may be playing), so every take needs its own name. Without
        // this each one was "Title - episode.m4a" and a room ended up with a
        // stack of identically-named files that could only be told apart by
        // opening them — which makes keeping the old one worthless.
        let name = next_take_name(&room.conn, &title, ext);
        let meta = db::insert_file(
            &room.conn,
            &name,
            mime,
            &bytes,
            Some(&transcript),
            "generated",
        )?;
        // Link it to the script, so the panel can say "recorded" and offer to
        // play it rather than offering to record it again.
        db::set_podcast_audio(&room.conn, script_file_id, &meta.id)?;
        Ok(meta)
    })?;
    let _ = window.emit("room-files-changed", ());
    Ok(meta)
}

/// The next unused episode name for this script: `Title - episode.m4a`, then
/// `Title - episode 2.m4a`, and so on.
///
/// The first take carries no number, because "take 1" on the only recording
/// that exists is noise. Numbering starts at the second, which is exactly when
/// telling them apart begins to matter.
///
/// Probes for a free name rather than counting takes: a room where an old
/// episode was trashed, or renamed, must not hand a new file a name something
/// else already answers to.
fn next_take_name(conn: &Connection, title: &str, ext: &str) -> String {
    let base = format!("{} - episode", safe_scope_name(title));
    let first = format!("{base}.{ext}");
    if matches!(db::file_by_exact_name(conn, &first), Ok(None)) {
        return first;
    }
    // Bounded, not `loop`: a hundred takes of one script is already absurd, and
    // an unbounded probe against a table is not worth the one line it saves.
    for n in 2..=99 {
        let candidate = format!("{base} {n}.{ext}");
        if matches!(db::file_by_exact_name(conn, &candidate), Ok(None)) {
            return candidate;
        }
    }
    // Past that, uniqueness still matters more than tidiness — a collision here
    // would put two episodes under one name, which is the bug being fixed.
    let tail = Uuid::new_v4().to_string();
    format!("{base} {}.{ext}", &tail[..8])
}

/// WAV → AAC in an MPEG-4 container, via macOS's own `afconvert`.
///
/// Falls back to the WAV when the encoder is unavailable or refuses. A big file
/// that plays is strictly better than no episode at all, and the caller learns
/// which it got from the returned mime/extension rather than from a guess.
fn encode_episode(wav: Vec<u8>) -> Result<(Vec<u8>, &'static str, &'static str), String> {
    let dir = std::env::temp_dir().join(format!("arcelle-podcast-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let src = dir.join("episode.wav");
    let dst = dir.join("episode.m4a");
    let cleanup = |dir: &std::path::Path| {
        let _ = std::fs::remove_dir_all(dir);
    };
    if let Err(e) = std::fs::write(&src, &wav) {
        cleanup(&dir);
        return Err(e.to_string());
    }
    let encoded = std::process::Command::new("/usr/bin/afconvert")
        .args([
            "-f", "m4af", // MPEG-4 audio
            "-d", "aac", // …containing AAC
            "-b", "64000", // plenty for one mono voice; ~5 MB per 10 minutes
            "-s", "3", // VBR-constrained: constant quality, no bitrate spikes
        ])
        .arg(&src)
        .arg(&dst)
        .output();
    let out = match encoded {
        Ok(out) if out.status.success() && dst.exists() => std::fs::read(&dst).ok(),
        _ => None,
    };
    cleanup(&dir);
    match out {
        Some(bytes) if !bytes.is_empty() => Ok((bytes, "audio/mp4", "m4a")),
        // Not an error: the episode exists, it is just larger. Saying so in the
        // file's own extension is more useful than failing a ten-minute build
        // over its container.
        _ => Ok((wav, "audio/wav", "wav")),
    }
}

/// `[m:ss] Speaker: line` rows — the shape `AudioView`'s own parser reads, so
/// the saved episode is clickable and speaker-labelled with no new viewer.
///
/// A leading provenance line, like every other transcript the room writes: a
/// synthetic reading of a script is not a recording of people, and a file that
/// did not say so would eventually be mistaken for one.
fn timed_transcript(
    title: &str,
    turns: &[db::PodcastTurn],
    spoken: &[String],
    offsets: &[i64],
    capped: usize,
) -> String {
    let mut out = format!(
        "Podcast episode \"{title}\" — synthetic voices reading a script generated in this room. \
         Not a recording of people.\n"
    );
    if capped > 0 {
        // A truncated episode must say so IN the artifact. The job card is gone
        // tomorrow; this file is not.
        out.push_str(&format!(
            "Only the first {} turns were recorded — {capped} more were not.\n",
            turns.len()
        ));
    }
    for (i, t) in turns.iter().enumerate() {
        // No offset for this row means the synthesizer and this list disagree
        // about length, which should be impossible (empty turns keep their
        // index). Falling back to 0 would stamp every remaining line at the
        // start; skipping the stamp is honest about not knowing.
        let line = spoken.get(i).map(String::as_str).unwrap_or(&t.line);
        match offsets.get(i) {
            Some(ms) => {
                let secs = (*ms / 1000).max(0);
                out.push_str(&format!(
                    "[{}:{:02}] {}: {}\n",
                    secs / 60,
                    secs % 60,
                    t.speaker,
                    line
                ));
            }
            None => out.push_str(&format!("{}: {}\n", t.speaker, line)),
        }
    }
    out
}

// ---------------------------------------------------------------- commands

/// The script attached to a file, if it has one — its turns, its cast, and the
/// episode already rendered from it.
///
/// `None` rather than an error for a file that is not a podcast: the viewer
/// asks this of whatever is open, so "not a podcast" is the ordinary answer,
/// and it also covers a script page made before this table existed.
#[tauri::command]
pub fn get_podcast(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<Option<db::Podcast>, String> {
    state.with_room(|room| Ok(db::get_podcast(&room.conn, &file_id)))
}

/// Re-cast: the user's choice of voice, name and prosody per host.
///
/// Does not touch a previously rendered episode — see `db::set_podcast_cast`.
/// The turns are re-folded onto the new spelling, because renaming a host has
/// to carry every one of their lines with it or those lines silently fall back
/// to the default voice on the next recording.
#[tauri::command]
pub fn set_podcast_cast(
    state: State<'_, AppState>,
    file_id: String,
    cast: Vec<db::PodcastHost>,
) -> Result<db::Podcast, String> {
    state.with_room(|room| {
        let current = db::get_podcast(&room.conn, &file_id)
            .ok_or("This file has no podcast script attached.")?;
        // A host with no name cannot be joined to a line, so it can only ever
        // silence one. Refused here rather than stored and puzzled over later.
        if cast.iter().any(|h| h.name.trim().is_empty()) {
            return Err("Every host needs a name.".into());
        }
        let mut turns = current.turns.clone();
        // Re-fold BY POSITION: the panel edits the cast in place, so host N's
        // new name belongs to whoever host N used to be. Matching by name would
        // make renaming impossible — the old name no longer appears anywhere.
        let mut renamed = turns.clone();
        for (i, host) in cast.iter().enumerate() {
            if let Some(old) = current.cast.get(i) {
                for t in renamed.iter_mut() {
                    if t.speaker.eq_ignore_ascii_case(old.name.trim()) {
                        t.speaker = host.name.trim().to_string();
                    }
                }
            }
        }
        turns = renamed;
        db::save_podcast(&room.conn, &file_id, &current.title, &turns, &cast)?;
        if let Some(audio) = current.audio_file_id.as_deref() {
            db::set_podcast_audio(&room.conn, &file_id, audio)?;
        }
        db::get_podcast(&room.conn, &file_id).ok_or_else(|| "the script vanished".to_string())
    })
}

/// Speak one host's line as a preview, in that host's own voice.
///
/// Rides `speak_text_neural`'s door exactly like every other spoken sentence —
/// the preview is not a special case, and a room that cannot speak an answer
/// must not be able to speak a preview either.
#[tauri::command]
pub async fn preview_podcast_voice(
    state: State<'_, AppState>,
    text: String,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
) -> Result<String, String> {
    crate::commands::speech_cmds::speak_one(&state, &text, voice, rate, pitch).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_take_of_one_script_gets_its_own_name() {
        // Re-casting KEEPS the previous episode on purpose. Keeping it is only
        // worth anything if you can tell the two apart in the library, and both
        // were called "Ep - episode.m4a".
        let conn = db::open_in_memory_schema();
        assert_eq!(next_take_name(&conn, "Ep", "m4a"), "Ep - episode.m4a");
        db::insert_file(&conn, "Ep - episode.m4a", "audio/mp4", b"\0", None, "generated")
            .unwrap();
        assert_eq!(next_take_name(&conn, "Ep", "m4a"), "Ep - episode 2.m4a");
        db::insert_file(&conn, "Ep - episode 2.m4a", "audio/mp4", b"\0", None, "generated")
            .unwrap();
        assert_eq!(next_take_name(&conn, "Ep", "m4a"), "Ep - episode 3.m4a");
        // A different script is unaffected — the name is per title.
        assert_eq!(next_take_name(&conn, "Other", "m4a"), "Other - episode.m4a");
    }

    fn turns() -> Vec<db::PodcastTurn> {
        vec![
            db::PodcastTurn { speaker: "Ada".into(), line: "Welcome in.".into() },
            db::PodcastTurn { speaker: "Bo".into(), line: "Glad to be here.".into() },
        ]
    }

    #[test]
    fn the_transcript_is_the_shape_the_player_already_parses() {
        // AudioView reads "[m:ss] Name: text" — matching it is what makes the
        // episode seekable and speaker-labelled with no new viewer.
        let spoken: Vec<String> = turns().iter().map(|t| t.line.clone()).collect();
        let out = timed_transcript("Ep 1", &turns(), &spoken, &[0, 65_400], 0);
        assert!(out.contains("[0:00] Ada: Welcome in."));
        assert!(out.contains("[1:05] Bo: Glad to be here."));
        assert!(
            out.starts_with("Podcast episode \"Ep 1\""),
            "the file says what it is: {out}"
        );
        assert!(out.contains("Not a recording of people."));
    }

    #[test]
    fn the_transcript_records_what_was_actually_spoken() {
        // With the privacy door on, the line that LEFT is the redacted one. A
        // transcript of the original beside audio of the placeholder would be
        // the app disagreeing with itself about what left this Mac.
        let spoken = vec!["Person A signed it.".to_string(), "Yes.".to_string()];
        let mut t = turns();
        t[0].line = "Dana Cohen signed it.".into();
        let out = timed_transcript("Ep", &t, &spoken, &[0, 1000], 0);
        assert!(out.contains("Person A signed it."));
        assert!(!out.contains("Dana Cohen"), "the unredacted name is not written down");
    }

    #[test]
    fn a_truncated_episode_says_so_in_the_file_itself() {
        // The job card is gone tomorrow; the file is not.
        let spoken: Vec<String> = turns().iter().map(|t| t.line.clone()).collect();
        let out = timed_transcript("Ep", &turns(), &spoken, &[0, 500], 7);
        assert!(out.contains("7 more were not"), "{out}");
    }

    #[test]
    fn a_missing_offset_drops_the_stamp_rather_than_inventing_one() {
        // Stamping an unknown row at 0:00 would send every click to the start
        // of the episode and look like a broken player.
        let spoken: Vec<String> = turns().iter().map(|t| t.line.clone()).collect();
        let out = timed_transcript("Ep", &turns(), &spoken, &[0], 0);
        assert!(out.contains("[0:00] Ada:"));
        assert!(out.contains("\nBo: Glad to be here."), "unstamped, not stamped 0:00");
    }

    #[test]
    fn encoding_falls_back_to_wav_rather_than_losing_the_episode() {
        // Real afconvert on a real WAV: this is the happy path on any Mac. The
        // assertion is deliberately about the CONTRACT — bytes plus a mime and
        // extension that agree — because a machine without the AAC encoder must
        // still get a playable file, just a bigger one.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + 2000).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2000u32.to_le_bytes());
        wav.extend_from_slice(&vec![0u8; 2000]);

        let (bytes, mime, ext) = encode_episode(wav).unwrap();
        assert!(!bytes.is_empty());
        assert!(
            (mime == "audio/mp4" && ext == "m4a") || (mime == "audio/wav" && ext == "wav"),
            "mime and extension must agree: {mime} / {ext}",
        );
        // Whichever it is, the room's own kind detection has to route it to the
        // audio player — a file the viewer cannot open is not an episode.
        assert_eq!(
            crate::stt::media_kind(mime, ext),
            Some(crate::stt::MediaKind::Audio),
            "the saved episode must open in the audio player",
        );
    }
}
