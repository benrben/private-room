//! Idea 3: headless smoke test for the speech-synthesis core.
//!
//! `harness = false` on purpose: AVSpeechSynthesizer's write-to-buffer
//! callback is delivered via the MAIN run loop, so the synthesis call must
//! own the real main thread (where `speech::synthesize_wav` pumps the loop
//! while it waits). The libtest harness runs every `#[test]` on a worker
//! thread — even with --test-threads=1 — and the callback starves there.
//!
//! `cargo test --test tts_smoke -- --preview` instead renders one WAV per
//! archetype's synthesis-side params to /tmp/pr-tts-*.wav for sound-design
//! listening (scripts/tts_preview.sh plays them).

fn main() {
    #[cfg(target_os = "macos")]
    {
        if std::env::args().any(|a| a == "--preview") {
            write_preview_wavs();
        } else {
            smoke();
        }
    }
    #[cfg(not(target_os = "macos"))]
    println!("tts_smoke skipped — speech synthesis is macOS-only");
}

#[cfg(target_os = "macos")]
fn smoke() {
    use base64::Engine;

    // The full command body: validation + synthesis + base64.
    let b64 =
        private_room_lib::speech::speak_text_b64("Hello from the room", None, 0.5, 1.0, 1.0)
            .expect("synthesis failed");
    let wav = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("command output must be valid base64");

    // Plausible WAV: RIFF/WAVE magic, sane sample rate, >0.2s of audio.
    assert!(wav.len() > 44, "expected audio past the 44-byte header");
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
    let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize;
    assert!((8_000..=48_000).contains(&rate), "sample rate {rate}");
    assert_eq!(wav.len(), 44 + data_len);
    let seconds = (data_len / 2) as f64 / rate as f64;
    assert!(seconds > 0.2, "expected >0.2s of audio, got {seconds:.3}s");
    println!("tts_smoke ok — {seconds:.2}s of audio at {rate} Hz");
}

/// One WAV per archetype's synthesis params (pitch/rate/volume — the DSP
/// half runs in the webview; Settings → Spoken voice → Preview covers that).
/// Values mirror ARCHETYPE_DEFAULTS in src/workspace/voice.ts.
#[cfg(target_os = "macos")]
fn write_preview_wavs() {
    let phrase = "I have read every page you keep in this room.";
    for (name, rate, pitch, volume) in [
        ("demon", 0.45, 0.5, 1.0),
        ("ghost", 0.4, 1.15, 0.85),
        ("wraith", 0.38, 1.3, 0.8),
        ("ancient", 0.42, 0.8, 1.0),
    ] {
        let wav = private_room_lib::speech::synthesize_wav(phrase, None, rate, pitch, volume)
            .expect("synthesis failed");
        let path = format!("/tmp/pr-tts-{name}.wav");
        std::fs::write(&path, wav).expect("write failed");
        println!("wrote {path}");
    }
}
