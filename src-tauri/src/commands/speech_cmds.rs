/// Idea 3: synthesize one sentence/chunk to WAV, returned as base64 (the same
/// audio-over-IPC shape as `transcribe_audio`, in the other direction).
/// Stateless on purpose: no AppState/room access — the text already lives in
/// the webview, and nothing here should be able to touch the room. The whole
/// body lives in `speech::speak_text_b64`; synthesis blocks on AVFoundation's
/// buffer queue, so keep it off the async runtime (pattern: transcribe_audio).
#[tauri::command]
pub async fn speak_text(
    text: String,
    voice_id: Option<String>,
    rate: f32,
    pitch: f32,
    volume: f32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::speech::speak_text_b64(&text, voice_id.as_deref(), rate, pitch, volume)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_speech_voices() -> Result<Vec<crate::speech::VoiceInfo>, String> {
    crate::speech::list_voices()
}

/// Neural spoken voice (the default engine): proxy one sentence to the
/// sidecar's `/tts` — Edge neural synthesis, loudness-normalized WAV back as
/// base64 (the same shape `speak_text` returns, so the webview's decode +
/// archetype DSP chain is engine-agnostic). Stateless like `speak_text`: no
/// AppState, no room access — only the sentence travels. `voice` selects
/// from the webview's curated roster; None/empty keeps the sidecar's
/// default (Andrew). A failure (offline, service down) surfaces as an Err
/// the webview maps to the on-device fallback for that sentence.
#[tauri::command]
pub async fn speak_text_neural(text: String, voice: Option<String>) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("nothing to speak".into());
    }
    if trimmed.chars().count() > crate::speech::MAX_SPEAK_CHARS {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Thin-wrapper check: the command surfaces the core's validation errors
    /// (empty / oversize return before any synthesis, so no run loop needed).
    #[tokio::test]
    async fn speak_text_rejects_empty_and_oversize() {
        assert!(speak_text("".into(), None, 0.5, 1.0, 1.0).await.is_err());
        let long = "a".repeat(crate::speech::MAX_SPEAK_CHARS + 1);
        assert!(speak_text(long, None, 0.5, 1.0, 1.0).await.is_err());
    }

    /// Same validation seam for the neural path — rejected before any
    /// sidecar call, so no server is needed.
    #[tokio::test]
    async fn speak_text_neural_rejects_empty_and_oversize() {
        assert!(speak_text_neural("  ".into(), None).await.is_err());
        let long = "a".repeat(crate::speech::MAX_SPEAK_CHARS + 1);
        assert!(speak_text_neural(long, Some("en-US-AvaMultilingualNeural".into()))
            .await
            .is_err());
    }
}
