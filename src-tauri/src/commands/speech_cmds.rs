/// Per-call synthesis cap. The frontend speaks sentence-sized chunks (its
/// chunker splits long answers), so one call never legitimately needs more.
/// Mirror of the sidecar's tts.MAX_TTS_CHARS.
pub const MAX_SPEAK_CHARS: usize = 1_000;

/// The spoken voice: proxy one sentence to the sidecar's `/tts` — Edge
/// neural synthesis, loudness-normalized WAV back as base64 (the same
/// audio-over-IPC shape as `transcribe_audio`, in the other direction).
/// Stateless on purpose: no AppState, no room access — the text already
/// lives in the webview, and only the sentence travels. `voice` selects
/// from the webview's curated multilingual roster; None/empty keeps the
/// sidecar's default (Andrew). A failure (offline, service down) surfaces
/// as an Err the webview maps to skipping that sentence — there is no
/// on-device fallback voice.
#[tauri::command]
pub async fn speak_text_neural(text: String, voice: Option<String>) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("nothing to speak".into());
    }
    if trimmed.chars().count() > MAX_SPEAK_CHARS {
        return Err("text too long to speak in one chunk".into());
    }
    let mut body = serde_json::json!({ "text": trimmed });
    if let Some(v) = voice.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        body["voice"] = serde_json::Value::String(v);
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
pub async fn list_neural_voices() -> Result<serde_json::Value, String> {
    let resp = crate::sidecar::sidecar_json("/tts/voices", &serde_json::json!({}))
        .await
        .map_err(|e| e.error)?;
    resp.get("voices")
        .filter(|v| v.is_array())
        .cloned()
        .ok_or_else(|| "voice catalog returned no voices".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Validation seam: empty / oversize are rejected before any sidecar
    /// call, so no server is needed.
    #[tokio::test]
    async fn speak_text_neural_rejects_empty_and_oversize() {
        assert!(speak_text_neural("  ".into(), None).await.is_err());
        let long = "a".repeat(MAX_SPEAK_CHARS + 1);
        assert!(speak_text_neural(long, Some("en-US-AvaMultilingualNeural".into()))
            .await
            .is_err());
    }
}
