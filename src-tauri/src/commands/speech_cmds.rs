use super::*;

/// Per-call synthesis cap. The frontend speaks sentence-sized chunks (its
/// chunker splits long answers), so one call never legitimately needs more.
/// Mirror of the sidecar's tts.MAX_TTS_CHARS.
pub const MAX_SPEAK_CHARS: usize = 1_000;

/// What the room says when the internet switch is off and something tried to
/// speak. Worded for the voice seam specifically — the generic
/// [`WEB_OFF_MESSAGE`] talks about fetching pages, which is not what happened,
/// and the webview matches on "Online features" to say it in its own words.
pub(crate) const SPEECH_OFFLINE_MESSAGE: &str =
    "Reading an answer aloud sends that sentence to an online voice service, and this room's \
     internet switch is off (Settings → Online features). Nothing was sent.";

/// One sentence, redacted, gated on the room's internet switch. Returns the
/// text as it may leave the Mac, or the refusal to show instead.
///
/// THE TWO HOLES THIS CLOSES (audit, 2026-08-02). Spoken answers are the app's
/// only *un-modelled* outbound seam: the sentence goes to Microsoft's Edge
/// neural service, and because the `/tts` body carries no `model`,
/// `inject_policy` never attached the room policy to it. So
///
///   * the master internet switch did not reach it — a room whose Settings read
///     "room stays offline" still sent every spoken sentence out; and
///   * the privacy door did not reach it — real names in an answer left in the
///     clear, while the same sentence typed into a web page (`browse.rs`) or
///     handed to a cloud model was masked.
///
/// The redactor used is [`remote_seam_redactor`], switch-blind for the same
/// reason it is at the connector seam: this destination is unconditionally
/// non-local, so whatever the room's scanner has found is masked before the
/// sentence leaves, whether or not the chat-model door is on. The user hears
/// the placeholder ("Person A") — which is the truth about what left.
pub(crate) fn speakable_text(state: &State<'_, AppState>, text: &str) -> Result<String, String> {
    let online = state.with_room(|room| Ok(web_access_enabled(&room.conn)))?;
    if !online {
        return Err(SPEECH_OFFLINE_MESSAGE.into());
    }
    Ok(redact_for_speech(text))
}

/// The door half of [`speakable_text`], split out so it is testable without a
/// room: the sentence as the voice service may receive it.
pub(crate) fn redact_for_speech(text: &str) -> String {
    match remote_seam_redactor() {
        Some(policy) => {
            let mut report = PrivacyReport::default();
            policy.redactor.redact(text, &mut report)
        }
        // No entity map in this room: nothing to mask mechanically, exactly as
        // at the connector seam. The sentence travels as written.
        None => text.to_string(),
    }
}

/// Length validation, split out for the same reason: the empty/oversize
/// refusals happen before any state is touched and before anything leaves.
fn speak_precheck(text: &str) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("nothing to speak".into());
    }
    if trimmed.chars().count() > MAX_SPEAK_CHARS {
        return Err("text too long to speak in one chunk".into());
    }
    Ok(trimmed)
}

/// The spoken voice: proxy one sentence to the sidecar's `/tts` — Edge
/// neural synthesis, loudness-normalized WAV back as base64 (the same
/// audio-over-IPC shape as `transcribe_audio`, in the other direction).
/// Only the sentence travels — no room name, no history. `voice` selects
/// from the webview's curated multilingual roster; None/empty keeps the
/// sidecar's default (Andrew). A failure (offline, service down) surfaces
/// as an Err the webview maps to skipping that sentence — there is no
/// on-device fallback voice.
///
/// It takes `AppState` (it used to take nothing) because the sentence is
/// outbound room content: see [`speakable_text`] for the switch and the door.
#[tauri::command]
pub async fn speak_text_neural(
    state: State<'_, AppState>,
    text: String,
    voice: Option<String>,
) -> Result<String, String> {
    speak_one(&state, &text, voice, None, None).await
}

/// One sentence through the door and the service — the body both spoken-answer
/// playback and the podcast panel's per-host Preview share.
///
/// `pub(crate)` and shared on purpose. The Preview button speaks a real line of
/// the user's script in a chosen voice, which is the same outbound act as
/// reading an answer aloud; giving it its own path would eventually give it its
/// own (weaker) door, and the one place that must never happen is the seam
/// where room text leaves the Mac.
pub(crate) async fn speak_one(
    state: &State<'_, AppState>,
    text: &str,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
) -> Result<String, String> {
    let trimmed = speak_precheck(text)?;
    let outbound = speakable_text(state, &trimmed)?;
    let mut body = serde_json::json!({ "text": outbound });
    // Each knob is only sent when the caller set it, so an unset one falls to
    // the sidecar's product default rather than to an empty string the service
    // would reject.
    for (key, value) in [("voice", voice), ("rate", rate), ("pitch", pitch)] {
        if let Some(v) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            body[key] = serde_json::Value::String(v);
        }
    }
    let resp = crate::sidecar::sidecar_json("/tts", &body)
        .await
        .map_err(|e| e.error)?;
    resp.get("audio_b64")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "neural voice returned no audio".to_string())
}

/// The service's LIVE voice catalog for the Settings picker, proxied from
/// the sidecar's `/tts/voices` — `[{id, gender, locale}]`, passed through
/// verbatim. Dynamic by design (user decision): nothing is bundled, so new
/// service voices appear without an app update; the user vets a voice with
/// Preview, not us. Carries no room data. Offline with no sidecar-side
/// cache surfaces as an Err the webview maps to "list couldn't load".
#[tauri::command]
pub async fn list_neural_voices(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let resp = crate::sidecar::sidecar_json("/tts/voices", &serde_json::json!({}))
        .await
        .map_err(|e| e.error)?;
    let voices = resp
        .get("voices")
        .filter(|v| v.is_array())
        .cloned()
        .ok_or_else(|| "voice catalog returned no voices".to_string())?;
    remember_voice_ids(&state, &voices);
    Ok(voices)
}

/// The room-setting key holding the ids of the last catalog we saw.
pub(crate) const VOICE_CATALOG_KEY: &str = "voice_catalog_ids";
/// How many ids to keep. A cast needs a handful of DISTINCT voices, not a
/// roster — the live catalog is 300+, and the whole list in a settings row
/// would be a kilobyte of string re-parsed on every podcast build.
const VOICE_CATALOG_KEEP: usize = 24;

/// Note the catalog's ids in the room, so a new podcast cast can be seeded with
/// DISTINCT voices without a network round-trip inside the room lock.
///
/// Ids only — no gender, no locale, nothing about the user. Best-effort by
/// design: this is a convenience for seeding, and a room with no cache simply
/// gets hosts with the default voice, which the panel then lets them change.
fn remember_voice_ids(state: &State<'_, AppState>, voices: &serde_json::Value) {
    let ids: Vec<&str> = voices
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("id").and_then(|i| i.as_str()))
        // Multilingual voices first: they read whatever language the script is
        // in, so a Hebrew or Spanish episode is not silently cast in voices
        // that can only pronounce English.
        .filter(|id| id.contains("Multilingual"))
        .chain(
            voices
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(|i| i.as_str()))
                .filter(|id| !id.contains("Multilingual")),
        )
        .take(VOICE_CATALOG_KEEP)
        .collect();
    if ids.is_empty() {
        return;
    }
    let _ = state.with_room(|room| db::set_setting(&room.conn, VOICE_CATALOG_KEY, &ids.join(",")));
}

/// The ids [`remember_voice_ids`] last stored, in order. Empty when the room
/// has never loaded the catalog.
pub(crate) fn cached_voice_ids(conn: &Connection) -> Vec<String> {
    db::get_setting(conn, VOICE_CATALOG_KEY)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Validation seam: empty / oversize are rejected before any sidecar
    /// call, so no server is needed.
    #[test]
    fn speak_precheck_rejects_empty_and_oversize() {
        assert!(speak_precheck("  ").is_err());
        assert!(speak_precheck(&"a".repeat(MAX_SPEAK_CHARS + 1)).is_err());
        assert_eq!(speak_precheck("  hello  ").unwrap(), "hello");
    }

    /// The hole this closes: the spoken sentence goes to Microsoft, and it was
    /// the one outbound seam the door never saw (no `model` in the `/tts` body,
    /// so `inject_policy` skipped it). A real name must not leave in the clear.
    #[test]
    fn a_spoken_sentence_is_masked_before_it_leaves() {
        let _guard = policy_test_lock();
        clear_policy();
        // Door OFF on purpose: this destination is non-local either way, same
        // asymmetry as the remote-connector seam.
        set_policy_for_test(false);
        let spoken = redact_for_speech("Ben Reich signed the lease today.");
        assert_eq!(spoken, "[Person A] signed the lease today.");
        assert!(!spoken.contains("Ben Reich"));

        set_active_policy_for_test();
        assert!(!redact_for_speech("ben reich called").contains("ben reich"));

        // No room / no entity map: nothing to mask, and nothing invented.
        clear_policy();
        assert_eq!(redact_for_speech("Ben Reich called"), "Ben Reich called");
    }
}
