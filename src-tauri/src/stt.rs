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
        // Drop silence hallucinations the same way the live path does — a near-
        // silent clip otherwise decodes to a lone "." or "[BLANK_AUDIO]" and gets
        // stored as a real (misleading) transcript. An all-junk clip → "".
        if is_junk_segment(&text) {
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
    /// What the phrase was actually decoded as (the forced language when one
    /// was forced) — this is what persists on the segment.
    pub lang: Option<String>,
    /// Mean token probability — how sure the model was of THIS text. Callers
    /// use it to tell degraded-echo garbage from real speech; it never
    /// deletes anything here on its own.
    pub mean_p: f32,
}

/// How a live phrase's language is chosen. Whisper's per-phrase detection is
/// the whole bug: a short Hebrew phrase misread as English isn't transcribed
/// badly, it comes back TRANSLATED. The engine's sticky-language policy
/// (recording::LaneLang) picks the mode; this is its whisper side.
#[derive(Clone, Copy, Debug)]
pub enum LangMode<'a> {
    /// Let whisper detect the phrase's language and report nothing — pre-lock
    /// live partials, which are throwaway. The detector must NOT run here: a
    /// partial fires every ~1.5 s on the one decode worker, and a lane can
    /// stay unlocked for a long time (music, low-confidence audio).
    Auto,
    /// Auto decode PLUS a confidence-bearing detection report
    /// (`whisper_lang_auto_detect` on the mel the decode left behind, one
    /// extra encoder pass) — pre-lock finals, whose report earns the lock.
    Sniff,
    /// Force the decode to this language and skip detection — locked-lane
    /// partials.
    Forced(&'a str),
    /// Force the decode to this language but ALSO report what the audio
    /// sounds like, so the caller can spot a genuine language change.
    Watch(&'a str),
}

/// A whole decoded phrase plus what the language detector heard.
#[derive(Default, Debug)]
pub struct PhraseOut {
    pub segs: Vec<SegOut>,
    /// Top detected language and its probability — the detector's own answer
    /// (`lang_detect` over the phrase's mel), independent of the language the
    /// decode ran in. Forced: absent.
    pub detected: Option<(String, f32)>,
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

/// The classic Whisper hallucinations: phrases the model emits from noise,
/// music, or unintelligible speech, in whatever language it drifted into —
/// "Thank you." and its cousins, and subtitle/credit lines learned from
/// YouTube captions. Only ever consulted TOGETHER with low decode
/// confidence: a real spoken "thank you" scores far higher and stays.
fn is_stock_hallucination(text: &str) -> bool {
    // Credit lines match anywhere in the segment.
    const CREDIT_MARKS: [&str; 8] = [
        "amara.org",
        "subtitles by",
        "captioned by",
        "субтитры",
        "продолжение следует",
        "untertitel",
        "sous-titres",
        "כתוביות",
    ];
    // Stock phrases must BE the sentence (every sentence of the segment).
    const STOCK: [&str; 14] = [
        "thank you",
        "thank you very much",
        "thank you so much",
        "thanks for watching",
        "thank you for watching",
        "please subscribe",
        "ありがとうございました",
        "ご視聴ありがとうございました",
        "감사합니다",
        "시청해주셔서 감사합니다",
        "спасибо за просмотр",
        "gracias por ver",
        "תודה רבה",
        "תודה שצפיתם",
    ];
    let lower = text.to_lowercase();
    if CREDIT_MARKS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    let mut any = false;
    for sentence in lower.split(['.', '!', '?', ',']) {
        let t = sentence.trim().trim_matches(|c: char| !c.is_alphanumeric());
        if t.is_empty() {
            continue;
        }
        any = true;
        if !STOCK.contains(&t) {
            return false;
        }
    }
    any
}

/// Assemble (word, t0, t1) triples from raw token pieces of one segment.
///
/// Whisper's BPE freely splits a multi-byte UTF-8 character across two tokens
/// (routine in Hebrew/CJK), so decoding per TOKEN yields U+FFFD halves. Words
/// must be joined as bytes and decoded per WORD: a piece whose bytes begin
/// with b' ' opens a new word, and BPE never splits a character across a
/// space boundary, so each completed word's bytes are whole characters.
/// Timing is first-piece t0 / last-piece t1 per word.
fn merge_token_words(pieces: &[(Vec<u8>, i64, i64)]) -> Vec<(String, i64, i64)> {
    let mut words: Vec<(Vec<u8>, i64, i64)> = Vec::new();
    for (bytes, t0, t1) in pieces {
        let mut b = bytes.as_slice();
        while b.last() == Some(&b'\n') {
            b = &b[..b.len() - 1];
        }
        if bytes.first() == Some(&b' ') || words.is_empty() {
            words.push((b.to_vec(), *t0, *t1));
        } else if let Some(last) = words.last_mut() {
            last.0.extend_from_slice(b);
            last.2 = *t1;
        }
    }
    words
        .into_iter()
        .filter_map(|(bytes, t0, t1)| {
            let w = String::from_utf8(bytes)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
            let w = w.trim().to_string();
            (!w.is_empty()).then_some((w, t0, t1))
        })
        .collect()
}

/// Transcribe one live phrase (mono 16 kHz) with word timestamps, shifting
/// everything by `offset_cs` so timestamps are absolute on the recording's
/// timeline. Same warm context as [`transcribe`]; equally blocking — the
/// recording engine calls it from its dedicated decoder thread only.
pub fn transcribe_segments(
    model_path: &Path,
    pcm: &[f32],
    offset_cs: i64,
    mode: LangMode<'_>,
) -> Result<PhraseOut, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    if pcm.len() < 3200 {
        return Ok(PhraseOut::default()); // < 0.2 s: nothing decodable
    }
    let key = model_path.to_string_lossy().into_owned();
    let mut guard = CTX.lock().map_err(|_| "stt context poisoned")?;
    if guard.as_ref().map(|(k, _)| k.as_str()) != Some(key.as_str()) {
        let ctx = WhisperContext::new_with_params(&key, WhisperContextParameters::default())
            .map_err(|e| format!("model load failed: {e}"))?;
        *guard = Some((key, ctx));
    }
    let (_, ctx) = guard.as_ref().expect("just set");

    let forced = match mode {
        LangMode::Auto | LangMode::Sniff => None,
        LangMode::Forced(l) | LangMode::Watch(l) => Some(l),
    };
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    // Finals (Sniff/Watch) decode with beam search — the reference quality
    // setting (openai/faster-whisper default beam 5), barely slower on Metal.
    // Partials (Auto/Forced) stay greedy: they are repainted every ~1.5 s, so
    // latency wins; best_of=5 still lets whisper.cpp's temperature fallback
    // sample candidates when a hard phrase makes the greedy pick fail.
    let strategy = match mode {
        LangMode::Sniff | LangMode::Watch(_) => SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        },
        LangMode::Auto | LangMode::Forced(_) => SamplingStrategy::Greedy { best_of: 5 },
    };
    let mut params = FullParams::new(strategy);
    params.set_language(Some(forced.unwrap_or("auto")));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(true);
    params.set_suppress_blank(true);
    // Never emit music/sound-effect token spans (♪, bracketed noise) as words.
    params.set_suppress_nst(true);
    // Each phrase stands alone; carrying context across them makes the model
    // repeat the previous phrase over silence.
    params.set_no_context(true);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);

    state.full(params, pcm).map_err(|e| format!("transcription failed: {e}"))?;

    // full_lang_id is the language the decode ran in — the forced one when
    // one was forced — which is exactly what each segment must persist.
    let lang = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_string);
    let n = state.full_n_segments();
    let mut out: Vec<SegOut> = Vec::new();
    for i in 0..n {
        let Some(seg) = state.get_segment(i) else { continue };
        let text = seg.to_str_lossy().map_err(|e| e.to_string())?.trim().to_string();
        if is_junk_segment(&text) {
            continue;
        }
        // RAW bytes per token, never per-token strings: BPE splits multi-byte
        // characters across tokens, and lossy-decoding each half yields "�".
        let mut pieces: Vec<(Vec<u8>, i64, i64)> = Vec::new();
        let mut plog_sum = 0f32;
        let mut p_sum = 0f32;
        let mut plog_n = 0usize;
        for j in 0..seg.n_tokens() {
            let Some(tok) = seg.get_token(j) else { continue };
            let Ok(bytes) = tok.to_bytes() else { continue };
            // Specials like "[_BEG_]" / "<|endoftext|>" carry no words.
            if bytes.starts_with(b"[_") || bytes.starts_with(b"<|") {
                continue;
            }
            let data = tok.token_data();
            plog_sum += data.plog;
            p_sum += data.p;
            plog_n += 1;
            let t0 = offset_cs + data.t0.max(0);
            let t1 = offset_cs + data.t1.max(data.t0.max(0));
            pieces.push((bytes.to_vec(), t0, t1));
        }
        let words = merge_token_words(&pieces);
        let mean_p = if plog_n > 0 { p_sum / plog_n as f32 } else { 0.0 };
        // A stock hallucination the model itself wasn't sure about is noise
        // dressed as text. A REAL "thank you" decodes confidently and stays —
        // this pair of conditions is what the old unconditional confidence
        // floor got wrong in both directions.
        if is_stock_hallucination(&text) && mean_p < 0.5 {
            continue;
        }
        // The REFERENCE silence rule (openai / faster-whisper / whisper.cpp
        // all agree): text is dropped only when the model says "probably no
        // speech here" AND the decode is low-confidence — both together.
        // Low confidence alone is NOT a reason to delete: hard audio —
        // accented, far-mic, compressed — decodes correct words at low
        // probability, and deleting them punches holes in real speech. The
        // old mean-p floors (0.30 short / 0.18 long) did exactly that on
        // real-world meetings and are gone on purpose.
        if plog_n > 0 {
            let avg_logprob = plog_sum / plog_n as f32;
            if seg.no_speech_probability() > 0.6 && avg_logprob < -1.0 {
                continue;
            }
        }
        out.push(SegOut {
            t0: offset_cs + seg.start_timestamp().max(0),
            t1: offset_cs + seg.end_timestamp().max(0),
            text,
            words,
            lang: lang.clone(),
            mean_p,
        });
    }
    let detected = match mode {
        LangMode::Forced(_) | LangMode::Auto => None,
        // The state still holds this phrase's mel from full(), so
        // lang_detect only re-runs the encoder plus one token to answer
        // "what does this audio sound like?". Watch: the forced decode above
        // never asked. Sniff: the auto decode DID pick a language, but
        // exposes no confidence on that path — reporting it as 1.0 (as this
        // used to) let one confidently-wrong first phrase lock a lane's
        // sticky language with no gate at all. Best-effort: a detect failure
        // just reports nothing, which the sticky policy treats as no vote.
        LangMode::Sniff | LangMode::Watch(_) => {
            state.lang_detect(0, threads as usize).ok().and_then(|(id, probs)| {
                whisper_rs::get_lang_str(id)
                    .map(|l| (l.to_string(), probs.get(id as usize).copied().unwrap_or(0.0)))
            })
        }
    };
    Ok(PhraseOut { segs: out, detected })
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
    fn merge_words_reassembles_utf8_split_across_tokens() {
        // "שלום עולם" with a letter's two UTF-8 bytes split across tokens —
        // exactly how Whisper's BPE tokenizes Hebrew. Per-token decoding
        // would give "�" halves; byte-level assembly must not.
        let shalom = "שלום".as_bytes(); // 4 letters × 2 bytes
        let olam = " עולם".as_bytes(); // leading space starts the word
        let pieces = vec![
            (shalom[..3].to_vec(), 100, 110), // ש + first byte of ל
            (shalom[3..].to_vec(), 110, 120), // second byte of ל + ום
            (olam[..4].to_vec(), 130, 140),   // " ע" + first byte of ו
            (olam[4..].to_vec(), 140, 150),   // rest
        ];
        let words = merge_token_words(&pieces);
        assert_eq!(
            words,
            vec![("שלום".to_string(), 100, 120), ("עולם".to_string(), 130, 150)]
        );
        assert!(words.iter().all(|(w, _, _)| !w.contains('\u{FFFD}')));
    }

    #[test]
    fn merge_words_ascii_subwords_and_punctuation() {
        let p = |s: &str, t0, t1| (s.as_bytes().to_vec(), t0, t1);
        let pieces = vec![
            p(" Hel", 0, 5),
            p("lo", 5, 10),
            p(",", 10, 12), // punctuation glues onto the previous word
            p(" world", 12, 20),
            p("!\n", 20, 22), // trailing newline stripped
        ];
        assert_eq!(
            merge_token_words(&pieces),
            vec![("Hello,".to_string(), 0, 12), ("world!".to_string(), 12, 22)]
        );
        // First piece without a leading space still opens a word; empty
        // pieces produce no words.
        assert_eq!(
            merge_token_words(&[p("Hi", 0, 3), p(" ", 3, 4)]),
            vec![("Hi".to_string(), 0, 3)]
        );
        assert!(merge_token_words(&[]).is_empty());
    }

    #[test]
    fn junk_segments_are_recognized() {
        assert!(is_junk_segment("[BLANK_AUDIO]"));
        assert!(is_junk_segment("(music)"));
        assert!(is_junk_segment("♪ ♪"));
        assert!(is_junk_segment("   "));
        // A lone "." is what Whisper emits for a near-silent clip — it must be
        // dropped by the import path too, not stored as a real transcript.
        assert!(is_junk_segment("."));
        assert!(is_junk_segment(". . ."));
        assert!(!is_junk_segment("Hello there"));
        assert!(!is_junk_segment("שלום"));
    }

    /// The stock-hallucination list matches Whisper's noise phrases — even
    /// repeated into one segment, and in every language it drifts into — but
    /// never real sentences that merely CONTAIN a thank-you.
    #[test]
    fn stock_hallucinations_are_recognized() {
        assert!(is_stock_hallucination("Thank you."));
        assert!(is_stock_hallucination("Thank you. Thank you. Thank you."));
        assert!(is_stock_hallucination("Thanks for watching!"));
        assert!(is_stock_hallucination("ありがとうございました"));
        assert!(is_stock_hallucination("감사합니다"));
        assert!(is_stock_hallucination("Продолжение следует..."));
        assert!(is_stock_hallucination("תודה רבה"));
        assert!(is_stock_hallucination("Subtitles by the Amara.org community"));
        // Real speech that happens to include the words stays real.
        assert!(!is_stock_hallucination("Thank you for the report, let's move on."));
        assert!(!is_stock_hallucination("תודה רבה שבאת, טוב להיות פה"));
        assert!(!is_stock_hallucination("I want to thank you all for coming today"));
        assert!(!is_stock_hallucination(""));
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
        let segs = transcribe_segments(&model, &pcm, 500, LangMode::Auto).unwrap().segs;
        assert!(!segs.is_empty(), "no segments");
        let all = segs.iter().map(|s| s.text.as_str()).collect::<String>().to_lowercase();
        assert!(all.contains("quick brown fox"), "{all}");
        let words: Vec<_> = segs.iter().flat_map(|s| s.words.iter()).collect();
        assert!(words.len() >= 6, "expected word-level timing, got {words:?}");
        // Timestamps carry the offset and are monotonic.
        assert!(words.first().unwrap().1 >= 500);
        assert!(words.windows(2).all(|w| w[0].1 <= w[1].1));
    }

    /// Hebrew word-level round trip against the real model: every emitted
    /// word must be valid UTF-8 with no replacement characters. Skips when
    /// the Carmit (Hebrew) voice isn't installed, like diarize's say() tests.
    #[test]
    #[ignore = "needs the downloaded model (Settings → Download voice model)"]
    fn e2e_hebrew_words_no_mojibake() {
        let model = test_model();
        assert!(model.exists(), "download the model first (Settings)");
        let aiff = std::env::temp_dir()
            .join(format!("pr-stt-e2e-heb-{}.aiff", uuid::Uuid::new_v4()));
        let ok = std::process::Command::new("say")
            .args(["-v", "Carmit", "-o"])
            .arg(&aiff)
            .arg("שלום עולם, מה שלומך היום?")
            .status()
            .ok()
            .filter(|s| s.success());
        let Some(_) = ok else {
            eprintln!("skipping: `say -v Carmit` unavailable");
            return;
        };
        let pcm = decode_to_pcm(&aiff, MediaKind::Audio).unwrap();
        let _ = std::fs::remove_file(&aiff);
        let segs = transcribe_segments(&model, &pcm, 0, LangMode::Auto).unwrap().segs;
        assert!(!segs.is_empty(), "no segments");
        let words: Vec<_> =
            segs.iter().flat_map(|s| s.words.iter().map(|w| w.0.clone())).collect();
        assert!(!words.is_empty(), "no words: {segs:?}");
        for w in &words {
            assert!(!w.contains('\u{FFFD}'), "corrupted word {w:?} in {words:?}");
        }
        // The transcript really is Hebrew, not an empty/latin hallucination.
        assert!(
            words.iter().any(|w| w.chars().any(|c| ('א'..='ת').contains(&c))),
            "no Hebrew letters in {words:?}"
        );
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
