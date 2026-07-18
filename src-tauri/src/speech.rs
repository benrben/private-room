//! Idea 3 (Wave 4b): on-device speech synthesis for the room's voice.
//!
//! AVSpeechSynthesizer's write-to-buffer API (`writeUtterance:toBufferCallback:`)
//! rather than `NSTask say -o`: pitch control (`pitchMultiplier`) only exists in
//! the API, the PCM stays in memory end to end (spoken assistant text is room
//! content — nothing decrypted may touch disk), and in-process synthesis avoids
//! a ~100-300 ms subprocess spawn per sentence. Same objc2 completion-handler
//! style as `snapshot.rs`, same cfg-split for non-mac builds.

use serde::Serialize;

/// Per-call synthesis cap. The frontend speaks sentence-sized chunks (its
/// chunker splits long answers), so one call never legitimately needs more.
pub const MAX_SPEAK_CHARS: usize = 1_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub lang: String,
}

/// The whole `speak_text` command body — validation + synthesis + base64 —
/// sync so the caller picks the thread (spawn_blocking in the app; the real
/// main thread in tests/tts_smoke.rs, which must pump the run loop).
pub fn speak_text_b64(
    text: &str,
    voice_id: Option<&str>,
    rate: f32,
    pitch: f32,
    volume: f32,
) -> Result<String, String> {
    use base64::Engine;
    let text = text.trim();
    if text.is_empty() {
        return Err("Nothing to speak.".into());
    }
    if text.chars().count() > MAX_SPEAK_CHARS {
        return Err(format!(
            "Text too long to speak in one call (max {MAX_SPEAK_CHARS} characters)."
        ));
    }
    let wav = synthesize_wav(text, voice_id, rate, pitch, volume)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(wav))
}

/// Encode mono f32 samples as a 16-bit PCM RIFF/WAVE file. Pure and
/// platform-independent, so the header logic is unit-testable everywhere.
pub(crate) fn pcm_f32_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Synthesize `text` to a mono 16-bit WAV, fully in memory.
/// `rate` is AVSpeech's own scale (clamped 0.1–0.7), `pitch` is the
/// pitchMultiplier (0.5–2.0), `volume` 0–1. `voice_id` picks a system voice by
/// identifier; None uses the system default.
///
/// Must NOT be called on the main thread from Tauri (use spawn_blocking): it
/// blocks on an mpsc channel fed by AVFoundation's internal synthesis queue.
#[cfg(target_os = "macos")]
pub fn synthesize_wav(
    text: &str,
    voice_id: Option<&str>,
    rate: f32,
    pitch: f32,
    volume: f32,
) -> Result<Vec<u8>, String> {
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2_avf_audio::{
        AVAudioBuffer, AVAudioPCMBuffer, AVSpeechSynthesisVoice, AVSpeechSynthesizer,
        AVSpeechUtterance,
    };
    use objc2_foundation::NSString;

    if text.trim().is_empty() {
        return Err("Nothing to speak.".into());
    }

    // Each buffer's mono samples + sample rate cross the channel as plain data;
    // nothing ObjC leaves the synthesis callback.
    enum Chunk {
        Samples(Vec<f32>, f64),
        Done,
    }
    let (tx, rx) = mpsc::channel::<Result<Chunk, String>>();

    // SAFETY: all AVSpeech* calls below are plain ObjC message sends on
    // objects this function owns; none have threading requirements beyond
    // "don't block the main run loop", which the spawn_blocking caller upholds.
    let utterance =
        unsafe { AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(text)) };
    unsafe {
        utterance.setRate(rate.clamp(0.1, 0.7));
        utterance.setPitchMultiplier(pitch.clamp(0.5, 2.0));
        utterance.setVolume(volume.clamp(0.0, 1.0));
        if let Some(id) = voice_id {
            if let Some(v) = AVSpeechSynthesisVoice::voiceWithIdentifier(&NSString::from_str(id)) {
                utterance.setVoice(Some(&v));
            }
        }
    }

    let block_tx = tx.clone();
    let handler = RcBlock::new(move |buffer: NonNull<AVAudioBuffer>| {
        let result = (|| -> Result<Chunk, String> {
            // SAFETY: AVFoundation hands the callback a live buffer for the
            // duration of the invocation.
            let buffer: &AVAudioBuffer = unsafe { buffer.as_ref() };
            let pcm = buffer
                .downcast_ref::<AVAudioPCMBuffer>()
                .ok_or("synthesizer delivered a non-PCM buffer")?;
            let frames = unsafe { pcm.frameLength() } as usize;
            // A zero-frameLength buffer is AVFoundation's end-of-utterance signal.
            if frames == 0 {
                return Ok(Chunk::Done);
            }
            let format = unsafe { buffer.format() };
            let sample_rate = unsafe { format.sampleRate() };
            let stride = unsafe { pcm.stride() }.max(1);
            let mut samples = Vec::with_capacity(frames);
            // floatChannelData is nil unless the format is f32 (and likewise
            // int16ChannelData for i16) — try both; channel 0 only (mono out).
            let float_data = unsafe { pcm.floatChannelData() };
            if !float_data.is_null() {
                let ch0 = unsafe { (*float_data).as_ptr() };
                for i in 0..frames {
                    samples.push(unsafe { *ch0.add(i * stride) });
                }
            } else {
                let int_data = unsafe { pcm.int16ChannelData() };
                if int_data.is_null() {
                    return Err("synthesized buffer is neither float32 nor int16 PCM".into());
                }
                let ch0 = unsafe { (*int_data).as_ptr() };
                for i in 0..frames {
                    samples.push(unsafe { *ch0.add(i * stride) } as f32 / 32768.0);
                }
            }
            Ok(Chunk::Samples(samples, sample_rate))
        })();
        let _ = block_tx.send(result);
    });

    // The synthesizer must stay retained until the final (zero-length) buffer
    // has been delivered, or synthesis is aborted mid-utterance.
    let synthesizer = unsafe { AVSpeechSynthesizer::new() };
    unsafe {
        use block2::DynBlock;
        let cb: *mut DynBlock<dyn Fn(NonNull<AVAudioBuffer>)> =
            &*handler as *const DynBlock<_> as *mut DynBlock<_>;
        synthesizer.writeUtterance_toBufferCallback(&utterance, cb);
    }

    // AVFoundation delivers the buffer callback via the MAIN run loop /
    // main dispatch queue (verified empirically: blocking with no pumped main
    // loop never fires; pumping RunLoop.main does; pumping a background
    // thread's own loop does not). In the app this function runs off-main via
    // spawn_blocking while Tauri pumps the main loop, so a plain blocking
    // receive works. Headless (the tts_smoke harness=false test, or
    // `--test-threads=1`) the CALLER is the main thread — pump the loop
    // between polls instead of blocking it, or the callback starves.
    let on_main = objc2::MainThreadMarker::new().is_some();
    let mut all: Vec<f32> = Vec::new();
    let mut sample_rate: u32 = 0;
    let mut done = false;
    // Watchdog: a wedged synthesis must not hang the command forever. The
    // deadline is idle time — it resets whenever a buffer arrives.
    let mut deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !done {
        let received = if on_main {
            use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoop};
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.05, true);
            rx.try_recv().ok()
        } else {
            rx.recv_timeout(Duration::from_millis(100)).ok()
        };
        match received {
            Some(Ok(Chunk::Samples(mut chunk, sr))) => {
                if sample_rate == 0 {
                    sample_rate = sr as u32;
                }
                all.append(&mut chunk);
                deadline = std::time::Instant::now() + Duration::from_secs(30);
            }
            Some(Ok(Chunk::Done)) => done = true,
            Some(Err(e)) => {
                drop(synthesizer);
                return Err(e);
            }
            None => {
                if std::time::Instant::now() >= deadline {
                    drop(synthesizer);
                    return Err("timed out waiting for speech synthesis (30s)".into());
                }
            }
        }
    }
    drop(synthesizer);
    if all.is_empty() || sample_rate == 0 {
        return Err("speech synthesis produced no audio".into());
    }
    Ok(pcm_f32_to_wav(&all, sample_rate))
}

/// The installed system voices, for the Settings picker.
#[cfg(target_os = "macos")]
pub fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    use objc2_avf_audio::AVSpeechSynthesisVoice;
    let voices = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    let mut out = Vec::with_capacity(voices.len());
    for v in &voices {
        out.push(VoiceInfo {
            id: unsafe { v.identifier() }.to_string(),
            name: unsafe { v.name() }.to_string(),
            lang: unsafe { v.language() }.to_string(),
        });
    }
    Ok(out)
}

#[cfg(not(target_os = "macos"))]
pub fn synthesize_wav(
    _text: &str,
    _voice_id: Option<&str>,
    _rate: f32,
    _pitch: f32,
    _volume: f32,
) -> Result<Vec<u8>, String> {
    Err("Speech synthesis is only available on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
pub fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    Err("Speech synthesis is only available on macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_roundtrip() {
        let samples = [0.0f32, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0];
        let wav = pcm_f32_to_wav(&samples, 22_050);
        assert_eq!(wav.len(), 44 + samples.len() * 2);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()),
            36 + samples.len() as u32 * 2
        );
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1); // PCM
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1); // mono
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 22_050);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 44_100); // byte rate
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16); // bits
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()),
            samples.len() as u32 * 2
        );
        // Sample encoding: silence, half scale, clamped full scale.
        let s = |i: usize| i16::from_le_bytes(wav[44 + i * 2..46 + i * 2].try_into().unwrap());
        assert_eq!(s(0), 0);
        assert_eq!(s(1), 16383);
        assert_eq!(s(2), -16383);
        assert_eq!(s(3), 32767);
        assert_eq!(s(4), -32767);
        assert_eq!(s(5), 32767); // out-of-range input clamps, never wraps
        assert_eq!(s(6), -32767);
    }

    #[test]
    fn rejects_empty_text() {
        assert!(synthesize_wav("", None, 0.5, 1.0, 1.0).is_err());
        assert!(synthesize_wav("   \n", None, 0.5, 1.0, 1.0).is_err());
        assert!(speak_text_b64("", None, 0.5, 1.0, 1.0).is_err());
    }

    #[test]
    fn rejects_oversize_text() {
        let long = "a".repeat(MAX_SPEAK_CHARS + 1);
        assert!(speak_text_b64(&long, None, 0.5, 1.0, 1.0).is_err());
    }

    // NOTE: actual-synthesis assertions (non-empty PCM, plausible header) live
    // in tests/tts_smoke.rs, NOT here: the buffer callback rides the main run
    // loop and libtest always runs `#[test]`s on worker threads (even with
    // --test-threads=1), where nothing pumps it. tts_smoke is harness=false
    // and owns the real main thread. The archetype preview WAVs
    // (scripts/tts_preview.sh) render through the same binary's --preview mode.

    #[test]
    #[cfg(target_os = "macos")]
    fn list_voices_nonempty() {
        let voices = list_voices().unwrap();
        assert!(!voices.is_empty());
        let v = &voices[0];
        assert!(!v.id.is_empty() && !v.name.is_empty() && !v.lang.is_empty());
    }
}
