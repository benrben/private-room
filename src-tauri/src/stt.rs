//! ADD-18: on-device speech-to-text for recordings, voice notes, and dictation.
//!
//! The Whisper engine (whisper.cpp via `whisper-rs`, Metal on Apple Silicon) is
//! COMPILED INTO the app — nothing to install. Only the model weights download
//! on first use into the app's data dir, exactly like Ollama models: never
//! bundled, one file, deletable from Settings.
//!
//! Decoding uses tools that ship with macOS itself (`afconvert`; `avconvert`
//! for video audio tracks) — no ffmpeg, no Python, no external engine.
//! Best-effort by design, like OCR (ADD-14): any failure returns an Err the
//! caller may ignore, and import falls back to "no text" exactly as before.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Whisper large-v3-turbo, 5-bit quantized: the Hebrew-capable sweet spot
/// (~574 MB download, ~1 GB working set, fast on Metal).
pub const MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
pub const MODEL_SIZE_MB: u64 = 574;

/// What kind of media a file is, for the import-time transcription fallback.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MediaKind {
    Audio,
    Video,
}

/// Files worth transcribing when text extraction came back empty: audio and
/// video containers. Matched by mime first, extension as fallback (uploads
/// sometimes arrive as application/octet-stream).
pub fn media_kind(mime: &str, ext: &str) -> Option<MediaKind> {
    if mime.starts_with("audio/") {
        return Some(MediaKind::Audio);
    }
    if mime.starts_with("video/") {
        return Some(MediaKind::Video);
    }
    match ext {
        "m4a" | "mp3" | "wav" | "aac" | "flac" | "aiff" | "aif" | "caf" | "ogg" | "opus" => {
            Some(MediaKind::Audio)
        }
        "mp4" | "mov" | "m4v" => Some(MediaKind::Video),
        _ => None,
    }
}

// ---------------------------------------------------------------- decoding

/// Decode any audio/video file to mono f32 16 kHz samples using the OS's own
/// converters. Video goes through `avconvert` (audio track → .m4a) first, then
/// everything through `afconvert` (→ 16 kHz LEI16 WAV), then a by-hand WAV
/// parse (any channel count, averaged to mono). Temp files are always removed.
pub fn decode_to_pcm(input: &Path, kind: MediaKind) -> Result<Vec<f32>, String> {
    let tmp = std::env::temp_dir();
    let stamp = uuid::Uuid::new_v4();
    let m4a = tmp.join(format!("pr-stt-{stamp}.m4a"));
    let wav = tmp.join(format!("pr-stt-{stamp}.wav"));

    let audio_src: PathBuf = if kind == MediaKind::Video {
        let out = std::process::Command::new("/usr/bin/avconvert")
            .args(["-p", "PresetAppleM4A", "-s"])
            .arg(input)
            .arg("-o")
            .arg(&m4a)
            .output()
            .map_err(|e| format!("avconvert failed to start: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&m4a);
            return Err(format!(
                "no readable audio track: {}",
                String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
            ));
        }
        m4a.clone()
    } else {
        input.to_path_buf()
    };

    let out = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "WAVE", "-d", "LEI16@16000"])
        .arg(&audio_src)
        .arg(&wav)
        .output();
    let _ = std::fs::remove_file(&m4a); // decrypted content must not linger
    let out = out.map_err(|e| format!("afconvert failed to start: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&wav);
        return Err(format!(
            "audio decode failed: {}",
            String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
        ));
    }

    let pcm = parse_wav_to_mono_f32(&wav);
    let _ = std::fs::remove_file(&wav);
    pcm
}

/// Same as [`decode_to_pcm`] but starting from in-memory bytes (the import
/// path stores encrypted bytes, not files). Writes a temp file with the
/// original extension so the converters can sniff the container, then cleans up.
pub fn decode_bytes_to_pcm(bytes: &[u8], ext: &str, kind: MediaKind) -> Result<Vec<f32>, String> {
    let safe_ext = if ext.is_empty() { "bin" } else { ext };
    let src = std::env::temp_dir().join(format!("pr-stt-src-{}.{safe_ext}", uuid::Uuid::new_v4()));
    std::fs::write(&src, bytes).map_err(|e| e.to_string())?;
    let result = decode_to_pcm(&src, kind);
    let _ = std::fs::remove_file(&src);
    result
}

/// Minimal RIFF/WAVE reader for exactly what afconvert emits (PCM 16-bit LE,
/// 16 kHz, any channel count): walk chunks to `fmt `/`data`, average channels
/// to mono, scale to f32 in [-1, 1].
fn parse_wav_to_mono_f32(path: &Path) -> Result<Vec<f32>, String> {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| e.to_string())?;
    if buf.len() < 44 || &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut channels: usize = 1;
    let mut pos = 12;
    let mut data: Option<(usize, usize)> = None;
    while pos + 8 <= buf.len() {
        let id = &buf[pos..pos + 4];
        let size = u32::from_le_bytes(buf[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 4 <= buf.len() {
            channels = u16::from_le_bytes(buf[body + 2..body + 4].try_into().unwrap()) as usize;
            channels = channels.max(1);
        } else if id == b"data" {
            data = Some((body, size.min(buf.len().saturating_sub(body))));
            break;
        }
        pos = body + size + (size & 1); // chunks are word-aligned
    }
    let (start, size) = data.ok_or("WAV has no data chunk")?;
    let frame = 2 * channels;
    let frames = size / frame;
    let mut pcm = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut acc = 0f32;
        for c in 0..channels {
            let off = start + i * frame + c * 2;
            let s = i16::from_le_bytes([buf[off], buf[off + 1]]);
            acc += f32::from(s);
        }
        pcm.push(acc / (channels as f32) / 32768.0);
    }
    Ok(pcm)
}

// ---------------------------------------------------------------- engine

/// One warm Whisper context, keyed by model path. whisper.cpp mmaps the
/// weights, so keeping it loaded costs address space, not resident RAM the OS
/// can't reclaim — and saves the multi-second reload on every dictation.
static CTX: Mutex<Option<(String, whisper_rs::WhisperContext)>> = Mutex::new(None);

fn format_ts(centis: i64) -> String {
    let s = (centis / 100).max(0);
    let (h, rem) = (s / 3600, s % 3600);
    let (m, sec) = (rem / 60, rem % 60);
    if h > 0 {
        format!("[{h}:{m:02}:{sec:02}]")
    } else {
        format!("[{m}:{sec:02}]")
    }
}

/// Transcribe mono 16 kHz samples. Language is auto-detected (Hebrew included).
/// With `timestamps`, each Whisper segment becomes a "[m:ss] …" line — the
/// contract the audio viewer's clickable transcript reads. Blocking and heavy:
/// callers run it on a background thread, never the UI or an async executor.
///
/// Deliberately NO translate task here: the shipped model is a *-turbo
/// distilled Whisper, which was not trained on translation and silently emits
/// near-source text when asked (alfred's `_whisper_can_translate` finding).
/// Translation runs in the dictation-shaping LLM stage instead (commands.rs).
pub fn transcribe(model_path: &Path, pcm: &[f32], timestamps: bool) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    if pcm.len() < 1600 {
        return Ok(String::new()); // < 0.1s of audio: nothing to hear
    }
    let key = model_path.to_string_lossy().into_owned();
    let mut guard = CTX.lock().map_err(|_| "stt context poisoned")?;
    if guard.as_ref().map(|(k, _)| k.as_str()) != Some(key.as_str()) {
        let ctx = WhisperContext::new_with_params(&key, WhisperContextParameters::default())
            .map_err(|e| format!("model load failed: {e}"))?;
        *guard = Some((key, ctx));
    }
    let (_, ctx) = guard.as_ref().expect("just set");

    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);

    state.full(params, pcm).map_err(|e| format!("transcription failed: {e}"))?;

    let n = state.full_n_segments();
    let mut lines: Vec<String> = Vec::new();
    for i in 0..n {
        let Some(seg) = state.get_segment(i) else { continue };
        let text = seg.to_str_lossy().map_err(|e| e.to_string())?.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if timestamps {
            // start_timestamp() is in centiseconds (10 ms units).
            lines.push(format!("{} {text}", format_ts(seg.start_timestamp())));
        } else {
            lines.push(text);
        }
    }
    Ok(if timestamps { lines.join("\n") } else { lines.join(" ") })
}

// ------------------------------------------------- live segments (ADD-27)

/// One decoded phrase for the live-recording engine: absolute centisecond
/// span, text, and word-level timing for the transcript editor.
#[derive(Default, Clone, Debug)]
pub struct SegOut {
    pub t0: i64,
    pub t1: i64,
    pub text: String,
    /// (word, t0, t1) — absolute centiseconds like t0/t1 above.
    pub words: Vec<(String, i64, i64)>,
    pub lang: Option<String>,
}

/// True for a Whisper "segment" that is noise dressed as text — the classic
/// silence hallucinations ("[BLANK_AUDIO]", "(music)", a lone ♪).
fn is_junk_segment(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    let bracketed = (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
        || (t.starts_with('*') && t.ends_with('*'));
    bracketed || t.chars().all(|c| !c.is_alphanumeric())
}

/// Transcribe one live phrase (mono 16 kHz) with word timestamps, shifting
/// everything by `offset_cs` so timestamps are absolute on the recording's
/// timeline. Same warm context as [`transcribe`]; equally blocking — the
/// recording engine calls it from its dedicated decoder thread only.
pub fn transcribe_segments(
    model_path: &Path,
    pcm: &[f32],
    offset_cs: i64,
) -> Result<Vec<SegOut>, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    if pcm.len() < 3200 {
        return Ok(Vec::new()); // < 0.2 s: nothing decodable
    }
    let key = model_path.to_string_lossy().into_owned();
    let mut guard = CTX.lock().map_err(|_| "stt context poisoned")?;
    if guard.as_ref().map(|(k, _)| k.as_str()) != Some(key.as_str()) {
        let ctx = WhisperContext::new_with_params(&key, WhisperContextParameters::default())
            .map_err(|e| format!("model load failed: {e}"))?;
        *guard = Some((key, ctx));
    }
    let (_, ctx) = guard.as_ref().expect("just set");

    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(true);
    params.set_suppress_blank(true);
    // Each phrase stands alone; carrying context across them makes the model
    // repeat the previous phrase over silence.
    params.set_no_context(true);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);

    state.full(params, pcm).map_err(|e| format!("transcription failed: {e}"))?;

    let lang = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_string);
    let n = state.full_n_segments();
    let mut out: Vec<SegOut> = Vec::new();
    for i in 0..n {
        let Some(seg) = state.get_segment(i) else { continue };
        let text = seg.to_str_lossy().map_err(|e| e.to_string())?.trim().to_string();
        // Silence hallucination gates: whisper's own no-speech signal, junk
        // shapes, and rock-bottom token confidence.
        if is_junk_segment(&text) || seg.no_speech_probability() > 0.75 {
            continue;
        }
        let mut words: Vec<(String, i64, i64)> = Vec::new();
        let mut p_sum = 0f32;
        let mut p_n = 0usize;
        for j in 0..seg.n_tokens() {
            let Some(tok) = seg.get_token(j) else { continue };
            let Ok(piece) = tok.to_str_lossy() else { continue };
            // Specials like "[_BEG_]" / "<|endoftext|>" carry no words.
            if piece.starts_with("[_") || piece.starts_with("<|") {
                continue;
            }
            let data = tok.token_data();
            p_sum += data.p;
            p_n += 1;
            let t0 = offset_cs + data.t0.max(0);
            let t1 = offset_cs + data.t1.max(data.t0.max(0));
            // A leading space starts a new word; anything else glues onto the
            // previous token (sub-word pieces, punctuation, CJK/Hebrew glyphs).
            let starts_word = piece.starts_with(' ') || words.is_empty();
            if starts_word {
                let w = piece.trim().to_string();
                if !w.is_empty() {
                    words.push((w, t0, t1));
                }
            } else if let Some(last) = words.last_mut() {
                last.0.push_str(piece.trim_end_matches('\n'));
                last.2 = t1;
            }
        }
        if p_n > 0 && p_sum / (p_n as f32) < 0.30 {
            continue; // the model is guessing — worse than staying silent
        }
        out.push(SegOut {
            t0: offset_cs + seg.start_timestamp().max(0),
            t1: offset_cs + seg.end_timestamp().max(0),
            text,
            words,
            lang: lang.clone(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_kinds() {
        assert_eq!(media_kind("audio/mpeg", "mp3"), Some(MediaKind::Audio));
        assert_eq!(media_kind("application/octet-stream", "m4a"), Some(MediaKind::Audio));
        assert_eq!(media_kind("video/mp4", "mp4"), Some(MediaKind::Video));
        assert_eq!(media_kind("application/pdf", "pdf"), None);
        assert_eq!(media_kind("image/png", "png"), None);
    }

    #[test]
    fn timestamp_format() {
        assert_eq!(format_ts(0), "[0:00]");
        assert_eq!(format_ts(6_590), "[1:05]"); // 65.9s, centiseconds
        assert_eq!(format_ts(75_400), "[12:34]");
        assert_eq!(format_ts(360_000 + 75_400), "[1:12:34]");
        assert_eq!(format_ts(-300), "[0:00]");
    }

    /// The model for on-device tests: the user-downloaded copy if present,
    /// else the repo's bundled-resource copy (what release DMGs ship).
    fn test_model() -> std::path::PathBuf {
        let home = std::env::var("HOME").unwrap();
        let downloaded = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.benreich.privateroom/models")
            .join(MODEL_FILE);
        if downloaded.exists() {
            return downloaded;
        }
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/models")
            .join(MODEL_FILE)
    }

    /// Full pipeline against the real model: macOS `say` synthesizes speech,
    /// decode_to_pcm converts it, Whisper transcribes it. Needs the downloaded
    /// model, so it's ignored in CI: `cargo test --lib stt -- --ignored`.
    #[test]
    #[ignore = "needs the downloaded model (Settings → Download voice model)"]
    fn e2e_say_roundtrip() {
        let model = test_model();
        assert!(model.exists(), "download the model first (Settings)");
        let aiff = std::env::temp_dir().join("pr-stt-e2e.aiff");
        let ok = std::process::Command::new("say")
            .args(["-o"])
            .arg(&aiff)
            .arg("The quick brown fox jumps over the lazy dog.")
            .status()
            .unwrap()
            .success();
        assert!(ok, "say(1) failed");
        let pcm = decode_to_pcm(&aiff, MediaKind::Audio).unwrap();
        let _ = std::fs::remove_file(&aiff);
        assert!(pcm.len() > 16000, "decoded under a second of audio");
        let text = transcribe(&model, &pcm, true).unwrap().to_lowercase();
        assert!(
            text.contains("quick brown fox"),
            "unexpected transcript: {text}"
        );
        assert!(text.starts_with("[0:00]"), "missing timestamp: {text}");
    }

    #[test]
    fn junk_segments_are_recognized() {
        assert!(is_junk_segment("[BLANK_AUDIO]"));
        assert!(is_junk_segment("(music)"));
        assert!(is_junk_segment("♪ ♪"));
        assert!(is_junk_segment("   "));
        assert!(!is_junk_segment("Hello there"));
        assert!(!is_junk_segment("שלום"));
    }

    /// Live-segment pipeline against the real model, like e2e_say_roundtrip:
    /// `cargo test --lib stt -- --ignored`.
    #[test]
    #[ignore = "needs the downloaded model (Settings → Download voice model)"]
    fn e2e_segments_with_words() {
        let model = test_model();
        assert!(model.exists(), "download the model first (Settings)");
        let aiff = std::env::temp_dir().join("pr-stt-e2e-seg.aiff");
        assert!(std::process::Command::new("say")
            .args(["-o"])
            .arg(&aiff)
            .arg("The quick brown fox jumps over the lazy dog.")
            .status()
            .unwrap()
            .success());
        let pcm = decode_to_pcm(&aiff, MediaKind::Audio).unwrap();
        let _ = std::fs::remove_file(&aiff);
        let segs = transcribe_segments(&model, &pcm, 500).unwrap();
        assert!(!segs.is_empty(), "no segments");
        let all = segs.iter().map(|s| s.text.as_str()).collect::<String>().to_lowercase();
        assert!(all.contains("quick brown fox"), "{all}");
        let words: Vec<_> = segs.iter().flat_map(|s| s.words.iter()).collect();
        assert!(words.len() >= 6, "expected word-level timing, got {words:?}");
        // Timestamps carry the offset and are monotonic.
        assert!(words.first().unwrap().1 >= 500);
        assert!(words.windows(2).all(|w| w[0].1 <= w[1].1));
    }

    #[test]
    fn wav_parse_mono_and_stereo() {
        // Hand-built 16-bit WAV: header + fmt + data. Stereo pair averages.
        fn wav(channels: u16, samples: &[i16]) -> Vec<u8> {
            let data_len = samples.len() * 2;
            let mut b = Vec::new();
            b.extend(b"RIFF");
            b.extend(((36 + data_len) as u32).to_le_bytes());
            b.extend(b"WAVE");
            b.extend(b"fmt ");
            b.extend(16u32.to_le_bytes());
            b.extend(1u16.to_le_bytes()); // PCM
            b.extend(channels.to_le_bytes());
            b.extend(16000u32.to_le_bytes());
            b.extend((16000u32 * 2 * u32::from(channels)).to_le_bytes());
            b.extend((2 * channels).to_le_bytes());
            b.extend(16u16.to_le_bytes());
            b.extend(b"data");
            b.extend((data_len as u32).to_le_bytes());
            for s in samples {
                b.extend(s.to_le_bytes());
            }
            b
        }
        let dir = std::env::temp_dir();
        let mono = dir.join("pr-stt-test-mono.wav");
        std::fs::write(&mono, wav(1, &[16384, -16384])).unwrap();
        let pcm = parse_wav_to_mono_f32(&mono).unwrap();
        std::fs::remove_file(&mono).unwrap();
        assert_eq!(pcm.len(), 2);
        assert!((pcm[0] - 0.5).abs() < 1e-3 && (pcm[1] + 0.5).abs() < 1e-3);

        let st = dir.join("pr-stt-test-stereo.wav");
        std::fs::write(&st, wav(2, &[16384, 0, -16384, 0])).unwrap();
        let pcm = parse_wav_to_mono_f32(&st).unwrap();
        std::fs::remove_file(&st).unwrap();
        assert_eq!(pcm.len(), 2);
        assert!((pcm[0] - 0.25).abs() < 1e-3 && (pcm[1] + 0.25).abs() < 1e-3);
    }
}
