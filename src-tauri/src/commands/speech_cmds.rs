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
}
