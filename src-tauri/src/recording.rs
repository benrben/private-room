//! ADD-27: the Recording file — a live recording that transcribes WHILE you
//! speak, entirely on this Mac.
//!
//! One engine thread per live session owns the whole pipeline: PCM arrives
//! from two capture lanes (the WebView microphone via `rec_push_audio`, and
//! the Mac's own system audio via ScreenCaptureKit — that's how a Google
//! Meet/Zoom/Teams call is heard), a small energy VAD cuts speech into
//! segments, and a dedicated decoder thread runs the SAME bundled Whisper
//! engine as dictation (ADD-18) over each segment — partials while a phrase
//! is still being spoken, a final pass with word timestamps when it ends.
//! Everything the UI shows arrives as events; everything durable is flushed
//! into the room DB as an ordinary file row (bytes = WAV, extracted text =
//! the "[m:ss] Speaker: line" transcript the whole app already understands)
//! plus a `recordings` meta row (words/speakers/cuts) for the editor.
//!
//! The audio timeline is contiguous: pausing stops capture, resuming appends
//! — wall-clock gaps are never recorded. All positions are 16 kHz sample
//! indices internally and centiseconds (Whisper's unit) at the API surface.

pub mod diarize;
#[cfg(target_os = "macos")]
pub mod sck;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use tauri::Emitter;

pub const SAMPLE_RATE: usize = 16_000;
/// VAD frame: 32 ms — one Silero window (512 samples @ 16 kHz), so the
/// neural probabilities map one-to-one onto frames.
const FRAME: usize = 512;
/// Speech starts after this many consecutive voiced frames (96 ms)…
const START_FRAMES: u32 = 3;
/// …and ends after this many unvoiced ones (768 ms) — long enough that a
/// mid-sentence breath doesn't split a phrase.
const END_FRAMES: u32 = 24;
/// Pre-roll kept before the detected start, so the first syllable survives
/// even when the opening frames were too soft to trip the detector.
const PREROLL: usize = SAMPLE_RATE / 2;
/// A segment is force-closed near Whisper's native 30 s window; the cut is
/// made at the quietest recent frame (see `DIP_LOOKBACK`), never mid-word at
/// an arbitrary sample.
const MAX_SEGMENT: usize = SAMPLE_RATE * 28;
/// How far back from the forced cut to look for the quietest frame. Speech
/// that ran 28 s without a real pause still dips between words somewhere in
/// its last seconds.
const DIP_LOOKBACK: usize = SAMPLE_RATE * 5;
/// Silero probability that OPENS a phrase (recall-biased: production capture
/// pipelines run 0.3–0.35, not the file-transcription default 0.5)…
const VAD_OPEN: f32 = 0.35;
/// …and the lower bar that KEEPS one open, so brief intra-word dips don't
/// chop a sentence (hysteresis).
const VAD_SUSTAIN: f32 = 0.20;
/// Re-decode the growing phrase for a live partial roughly this often.
const PARTIAL_EVERY: usize = SAMPLE_RATE * 3 / 2;
/// Auto-flush to the DB every N finished segments (crash safety); pause/stop
/// always flush.
const FLUSH_EVERY_SEGMENTS: usize = 8;
/// Re-cluster the meeting's voices every N new phrases (and on every flush /
/// pause / stop). Cheap — cosines over tens of stored 192-float vectors, the
/// model itself is NOT re-run — and it is what lets a speaker who was
/// provisionally mislabeled get corrected on screen while the conversation is
/// still going.
const RELABEL_EVERY_SEGMENTS: usize = 2;
/// Hard session ceiling (3 h): the mixed timeline lives in memory while
/// recording (~230 MB/h of f32), so a forgotten recorder stops itself.
const MAX_SESSION_SAMPLES: usize = SAMPLE_RATE * 3 * 3600;

/// Two phrases are the same sound reaching both lanes when they overlap in
/// time by this much of the shorter one. The lanes segment independently, so
/// their phrase boundaries never line up exactly — half is generous enough to
/// survive that and tight enough that consecutive turns don't collide.
const ECHO_OVERLAP: f32 = 0.5;
/// …and when this fraction of the shorter phrase's words appear in the other.
/// Echo comes back degraded, so an exact match is too much to ask; two people
/// genuinely talking over each other say different words and never reach it.
const ECHO_SAME_TEXT: f32 = 0.6;

// ---------------------------------------------------------------- data model

/// One word with its place on the timeline (centiseconds). `del` marks words
/// removed by the transcript editor — the audio keeps them until export.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecWord {
    pub w: String,
    pub t0: i64,
    pub t1: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub del: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecSegment {
    pub id: String,
    /// "mic" | "sys" — which capture lane heard it.
    pub source: String,
    /// "You" for the microphone, "Speaker N" for clustered meeting voices.
    pub speaker: String,
    pub t0: i64,
    pub t1: i64,
    pub text: String,
    pub words: Vec<RecWord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// The phrase's voiceprint (meeting lane only), kept so the whole
    /// recording can be re-clustered as it grows — and again after a
    /// pause/resume, which is what keeps a returning speaker's number.
    /// Absent on mic phrases and on files recorded before ADD-27.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<diarize::VoicePrint>,
}

/// A span deleted from the transcript. Playback skips it; "export edited
/// copy" cuts it out of the audio for real. Kept separate from the words so
/// the edit is non-destructive and undoable via file versions.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecCut {
    pub t0: i64,
    pub t1: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecMeta {
    pub version: u32,
    pub duration_cs: i64,
    pub segments: Vec<RecSegment>,
    pub cuts: Vec<RecCut>,
    /// How many meeting voices to tell apart. 0 (the default, and what the UI
    /// always sends) means "discover them" — nobody is asked how many people
    /// are in the call. A non-zero value pins the count; older rooms that
    /// stored one keep it.
    #[serde(default)]
    pub max_speakers: u32,
}

impl Default for RecMeta {
    fn default() -> Self {
        Self { version: 1, duration_cs: 0, segments: Vec::new(), cuts: Vec::new(), max_speakers: 0 }
    }
}

pub fn cs_of_samples(samples: usize) -> i64 {
    (samples as i64) * 100 / SAMPLE_RATE as i64
}

pub fn samples_of_cs(cs: i64) -> usize {
    ((cs.max(0) as usize) * SAMPLE_RATE) / 100
}

pub fn format_stamp(cs: i64) -> String {
    let s = (cs / 100).max(0);
    let (h, rem) = (s / 3600, s % 3600);
    let (m, sec) = (rem / 60, rem % 60);
    if h > 0 {
        format!("[{h}:{m:02}:{sec:02}]")
    } else {
        format!("[{m}:{sec:02}]")
    }
}

/// Words, lowercased, punctuation dropped — Whisper punctuates the same sound
/// differently on a clean lane and on its echo.
fn words_of(text: &str) -> std::collections::HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// How much of the shorter phrase's vocabulary the longer one repeats. Uses
/// the smaller set as the denominator (not the union) so a phrase heard whole
/// on one lane and clipped on the other still matches.
fn text_overlap(a: &str, b: &str) -> f32 {
    let (a, b) = (words_of(a), words_of(b));
    let smaller = a.len().min(b.len());
    if smaller == 0 {
        return 0.0;
    }
    a.intersection(&b).count() as f32 / smaller as f32
}

/// Shared time as a fraction of the shorter span (centiseconds).
fn time_overlap(a: (i64, i64), b: (i64, i64)) -> f32 {
    let shared = (a.1.min(b.1) - a.0.max(b.0)).max(0);
    let shorter = (a.1 - a.0).min(b.1 - b.0).max(1);
    shared as f32 / shorter as f32
}

/// The searchable/actionable transcript stored as the file's extracted text —
/// the same "[m:ss] …" contract the audio viewer, RAG index, and every AI
/// action already consume. Deleted words are simply absent from it.
pub fn transcript_text(meta: &RecMeta) -> String {
    let mut out = String::from("(live recording)\n");
    for seg in &meta.segments {
        let text = segment_visible_text(seg);
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!("{} {}: {}\n", format_stamp(seg.t0), seg.speaker, text));
    }
    out
}

/// A segment's text with deleted words removed. Falls back to the raw text
/// when a segment has no word list (partial-only or legacy rows).
pub fn segment_visible_text(seg: &RecSegment) -> String {
    if seg.words.is_empty() {
        return seg.text.trim().to_string();
    }
    let kept: Vec<&str> = seg
        .words
        .iter()
        .filter(|w| !w.del)
        .map(|w| w.w.trim())
        .filter(|w| !w.is_empty())
        .collect();
    kept.join(" ")
}

/// Merge a new cut into the (sorted, disjoint) cut list.
pub fn add_cut(cuts: &mut Vec<RecCut>, new: RecCut) {
    cuts.push(new);
    cuts.sort_by_key(|c| c.t0);
    let mut merged: Vec<RecCut> = Vec::with_capacity(cuts.len());
    for c in cuts.drain(..) {
        match merged.last_mut() {
            Some(last) if c.t0 <= last.t1 => last.t1 = last.t1.max(c.t1),
            _ => merged.push(c),
        }
    }
    *cuts = merged;
}

// ---------------------------------------------------------------- WAV bytes

/// 16 kHz mono 16-bit WAV — the recording file's on-disk shape. Small (about
/// 2 MB/min), universally playable, and exactly what Whisper eats, so resume
/// can reload it without any converter.
pub fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut b = Vec::with_capacity(44 + data_len);
    b.extend(b"RIFF");
    b.extend(((36 + data_len) as u32).to_le_bytes());
    b.extend(b"WAVE");
    b.extend(b"fmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes()); // PCM
    b.extend(1u16.to_le_bytes()); // mono
    b.extend((SAMPLE_RATE as u32).to_le_bytes());
    b.extend((SAMPLE_RATE as u32 * 2).to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend((data_len as u32).to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        b.extend(v.to_le_bytes());
    }
    b
}

/// Parse OUR OWN WAV shape back to f32 (resume / export). Any-channel-count
/// tolerant like stt's parser, but expects 16-bit PCM.
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut channels: usize = 1;
    let mut pos = 12;
    let mut data: Option<(usize, usize)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 4 <= bytes.len() {
            channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap()).max(1) as usize;
        } else if id == b"data" {
            data = Some((body, size.min(bytes.len().saturating_sub(body))));
            break;
        }
        pos = body + size + (size & 1);
    }
    let (start, size) = data.ok_or("WAV has no data chunk")?;
    let frame = 2 * channels;
    let frames = size / frame;
    let mut pcm = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut acc = 0f32;
        for c in 0..channels {
            let off = start + i * frame + c * 2;
            acc += f32::from(i16::from_le_bytes([bytes[off], bytes[off + 1]]));
        }
        pcm.push(acc / channels as f32 / 32768.0);
    }
    Ok(pcm)
}

/// Remove the cut spans from the samples — the "make the edit real" step of
/// export. Cuts are centisecond spans on the same timeline as the samples.
pub fn splice_out(samples: &[f32], cuts: &[RecCut]) -> Vec<f32> {
    let mut out = Vec::with_capacity(samples.len());
    let mut pos = 0usize;
    let mut sorted = cuts.to_vec();
    sorted.sort_by_key(|c| c.t0);
    for c in sorted {
        let a = samples_of_cs(c.t0).min(samples.len());
        let b = samples_of_cs(c.t1).min(samples.len());
        if a > pos {
            out.extend_from_slice(&samples[pos..a]);
        }
        pos = pos.max(b);
    }
    if pos < samples.len() {
        out.extend_from_slice(&samples[pos..]);
    }
    out
}

/// How much cut time (cs) lies strictly before `t` — the timestamp shift an
/// exported (spliced) copy needs.
pub fn cut_shift_before(cuts: &[RecCut], t: i64) -> i64 {
    cuts.iter().map(|c| (c.t1.min(t) - c.t0).max(0)).sum()
}

/// Per-chunk linear resampler to 16 kHz. Chunks are a quarter-second, so the
/// sub-sample phase reset at each boundary is far below anything Whisper (or
/// an ear) notices — not worth carrying fractional state across chunks.
pub fn resample_to_16k(input: &[f32], from: u32) -> Vec<f32> {
    if from == SAMPLE_RATE as u32 || input.is_empty() {
        return input.to_vec();
    }
    let n_out = ((input.len() as u64) * SAMPLE_RATE as u64 / from as u64) as usize;
    let mut out = Vec::with_capacity(n_out);
    let step = from as f64 / SAMPLE_RATE as f64;
    for j in 0..n_out {
        let x = j as f64 * step;
        let i = x as usize;
        let frac = (x - i as f64) as f32;
        let a = input[i.min(input.len() - 1)];
        let b = input[(i + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

// ---------------------------------------------------------------- VAD lane

#[derive(PartialEq, Clone, Copy, Debug)]
pub enum Source {
    Mic = 0,
    Sys = 1,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Mic => "mic",
            Source::Sys => "sys",
        }
    }
}

enum LaneState {
    Idle,
    /// An open phrase: `start` is its absolute sample position, `buf` its
    /// audio (incl. pre-roll), `partial_at` how much was already sent for a
    /// live partial.
    Active { start: usize, buf: Vec<f32>, silent_frames: u32, partial_at: usize },
}

/// Where the engine found the Silero VAD model (`install_vad_model`), same
/// rule as the TitaNet weights. Unset — dev runs and unit tests — falls back
/// to the repo's resources dir; missing file → the energy fallback.
static VAD_MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();

/// whisper.cpp's bundled Silero v5 ggml model (~0.9 MB).
pub const VAD_MODEL_FILE: &str = "ggml-silero-v5.1.2.bin";

pub fn set_vad_model_path(path: PathBuf) {
    let _ = VAD_MODEL_PATH.set(path);
}

fn vad_model_path() -> PathBuf {
    VAD_MODEL_PATH.get().cloned().unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models").join(VAD_MODEL_FILE)
    })
}

/// Warmup context carried between VAD calls (~0.7 s): whisper.cpp resets the
/// Silero LSTM on every `detect_speech`, so each call re-reads a short tail
/// for the state to settle before the fresh frames are judged.
const VAD_TAIL: usize = FRAME * 22;

/// Streaming Silero VAD for one lane — a trained speech detector in place of
/// an RMS threshold, which is what production capture pipelines use because
/// energy gates structurally miss quiet and distant speech.
struct NeuralVad {
    ctx: whisper_rs::WhisperVadContext,
    tail: Vec<f32>,
}

impl NeuralVad {
    fn new() -> Option<Self> {
        let path = vad_model_path();
        if !path.exists() {
            return None;
        }
        let mut params = whisper_rs::WhisperVadContextParams::new();
        params.set_n_threads(2);
        params.set_use_gpu(false);
        whisper_rs::WhisperVadContext::new(path.to_str()?, params)
            .ok()
            .map(|ctx| Self { ctx, tail: Vec::new() })
    }

    /// Speech probability for each FRAME-sized window of `fresh`
    /// (fresh.len() must be a multiple of FRAME). `None` = inference failed.
    fn probs(&mut self, fresh: &[f32]) -> Option<Vec<f32>> {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(fresh);
        let out = self.ctx.detect_speech(&buf).ok().map(|()| {
            let probs = self.ctx.probabilities();
            let n = fresh.len() / FRAME;
            probs[probs.len().saturating_sub(n)..].to_vec()
        });
        let keep = buf.len().min(VAD_TAIL);
        self.tail = buf[buf.len() - keep..].to_vec();
        out.filter(|p| p.len() == fresh.len() / FRAME)
    }
}

/// One capture lane (mic or system audio) with its own voice detector —
/// Silero when the model is present, an adaptive energy gate otherwise.
/// Absolute positions are session-timeline sample indices.
struct Lane {
    /// Every sample ever ingested — the lane's WRITE position on the mixed
    /// timeline. Distinct from `pos`, which only advances per full VAD frame
    /// (the sub-frame carry would otherwise get mixed twice at chunk seams).
    ingested: usize,
    pos: usize,
    carry: Vec<f32>,
    ring: VecDeque<f32>,
    state: LaneState,
    voiced_run: u32,
    /// Adaptive noise floor (EMA of quiet frames' RMS).
    floor: f32,
    /// Peak-decay level for the UI meter.
    level: f32,
    /// Trained voice detector; `None` (model missing or broken) falls back
    /// to the energy gate — a VAD problem must never break a recording.
    vad: Option<NeuralVad>,
}

impl Lane {
    fn new(base: usize) -> Self {
        Self {
            ingested: base,
            pos: base,
            carry: Vec::new(),
            ring: VecDeque::with_capacity(PREROLL),
            state: LaneState::Idle,
            voiced_run: 0,
            floor: 2e-3,
            level: 0.0,
            vad: NeuralVad::new(),
        }
    }

    /// Feed 16 kHz samples; returns any phrases that just closed as
    /// (absolute start sample, audio).
    fn push(&mut self, samples: &[f32]) -> Vec<(usize, Vec<f32>)> {
        let mut closed = Vec::new();
        self.carry.extend_from_slice(samples);
        let n = self.carry.len() / FRAME;
        if n == 0 {
            return closed;
        }
        // One Silero pass over all fresh frames (its LSTM wants a run of
        // audio, not isolated 32 ms slices); per-frame probabilities then
        // drive the same state machine the energy gate does.
        let probs = match self.vad.as_mut() {
            Some(v) => {
                let p = v.probs(&self.carry[..n * FRAME]);
                if p.is_none() {
                    self.vad = None; // broke mid-session: energy from here on
                }
                p
            }
            None => None,
        };
        for k in 0..n {
            let frame: Vec<f32> = self.carry[k * FRAME..(k + 1) * FRAME].to_vec();
            if let Some(done) = self.frame(&frame, probs.as_ref().map(|p| p[k])) {
                closed.push(done);
            }
        }
        self.carry.drain(..n * FRAME);
        closed
    }

    fn frame(&mut self, frame: &[f32], speech_prob: Option<f32>) -> Option<(usize, Vec<f32>)> {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        self.level = rms.max(self.level * 0.75);
        let open = matches!(self.state, LaneState::Active { .. });
        let voiced = match speech_prob {
            // Trained detector, with hysteresis: opening takes real evidence,
            // staying open takes less, so soft intra-word dips don't chop.
            Some(p) => p >= if open { VAD_SUSTAIN } else { VAD_OPEN },
            // Energy fallback. The threshold rides the noise floor: a quiet
            // room triggers on soft speech, a fan-heavy one doesn't trigger
            // on the fan. Both knobs sit LOW on purpose — an absolute RMS
            // floor structurally misses quiet and distant speech, and
            // whisper's own gates catch what noise this lets through.
            None => rms > (self.floor * 2.0).max(0.0015),
        };
        if !voiced {
            self.floor = self.floor * 0.98 + rms * 0.02;
            self.floor = self.floor.max(1e-4);
        }
        let frame_start = self.pos;
        self.pos += frame.len();

        let mut finished: Option<(usize, Vec<f32>)> = None;
        match &mut self.state {
            LaneState::Idle => {
                self.ring.extend(frame.iter().copied());
                while self.ring.len() > PREROLL {
                    self.ring.pop_front();
                }
                if voiced {
                    self.voiced_run += 1;
                    if self.voiced_run >= START_FRAMES {
                        let buf: Vec<f32> = self.ring.drain(..).collect();
                        let start = (frame_start + frame.len()).saturating_sub(buf.len());
                        self.state = LaneState::Active { start, buf, silent_frames: 0, partial_at: 0 };
                        self.voiced_run = 0;
                    }
                } else {
                    self.voiced_run = 0;
                }
            }
            LaneState::Active { start, buf, silent_frames, partial_at } => {
                buf.extend_from_slice(frame);
                *silent_frames = if voiced { 0 } else { *silent_frames + 1 };
                if *silent_frames >= END_FRAMES {
                    // Trim the silent tail (keep 0.2 s of it as padding).
                    let tail_keep = SAMPLE_RATE / 5;
                    let trim = (*silent_frames as usize * FRAME).saturating_sub(tail_keep);
                    let keep = buf.len().saturating_sub(trim);
                    let audio: Vec<f32> = buf[..keep].to_vec();
                    finished = Some((*start, audio));
                    self.state = LaneState::Idle;
                    self.voiced_run = 0;
                } else if buf.len() >= MAX_SEGMENT {
                    // Continuous speech reached the window limit: close at
                    // the QUIETEST recent frame — a between-words dip, not an
                    // arbitrary sample mid-word — and keep the remainder as
                    // the still-open phrase, so not a syllable is lost.
                    let from = buf.len().saturating_sub(DIP_LOOKBACK);
                    let mut best = (f32::MAX, buf.len());
                    let mut i = from;
                    while i + FRAME <= buf.len() {
                        let w = &buf[i..i + FRAME];
                        let r = (w.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt();
                        if r < best.0 {
                            best = (r, i + FRAME / 2);
                        }
                        i += FRAME;
                    }
                    let cut = best.1;
                    let audio: Vec<f32> = buf[..cut].to_vec();
                    finished = Some((*start, audio));
                    let rest: Vec<f32> = buf[cut..].to_vec();
                    *start += cut;
                    *partial_at = rest.len();
                    *buf = rest;
                    *silent_frames = 0;
                }
            }
        }
        finished
    }

    /// A live partial is due when the open phrase has grown enough since the
    /// last one. Returns (absolute start, snapshot of the phrase so far).
    fn partial_due(&mut self) -> Option<(usize, Vec<f32>)> {
        if let LaneState::Active { start, buf, partial_at, .. } = &mut self.state {
            if buf.len().saturating_sub(*partial_at) >= PARTIAL_EVERY {
                *partial_at = buf.len();
                return Some((*start, buf.clone()));
            }
        }
        None
    }

    /// Close any open phrase unconditionally (pause/stop). 0.2 s is the
    /// decoder's own minimum — anything it can decode is kept; a one-word
    /// answer right before pause is real speech.
    fn flush_active(&mut self) -> Option<(usize, Vec<f32>)> {
        if let LaneState::Active { start, buf, .. } =
            std::mem::replace(&mut self.state, LaneState::Idle)
        {
            if buf.len() >= SAMPLE_RATE / 5 {
                return Some((start, buf));
            }
        }
        None
    }
}

// ------------------------------------------------------------ sticky language

/// Sticky-language policy for one capture lane. Pure — no whisper, no I/O.
///
/// Whisper detects the language per VAD phrase, and phrases are short, so a
/// Hebrew meeting occasionally gets a phrase misread as English — which
/// whisper then effectively TRANSLATES, not just mis-transcribes. So the
/// first well-evidenced, CONFIDENT final locks the lane's language and later
/// decodes are forced to it; only consecutive well-evidenced finals that all
/// hear another language re-lock the lane (a genuine language change).
///
/// A wrong lock has a failure mode dissent votes cannot fix: decodes forced
/// to the wrong language come back as low-confidence junk that the caller's
/// gates drop, so those finals never reach `observe`, no dissent accumulates,
/// and the lock would hold forever while the lane silently eats words. The
/// escape is [`LaneLang::note_empty_final`]: enough consecutive dead finals
/// on a locked lane unlock it so it re-detects from scratch.
#[derive(Default, Debug)]
pub struct LaneLang {
    lock: Option<String>,
    /// The disagreeing run: (language heard, consecutive strong finals).
    dissent: Option<(String, u32)>,
    /// Consecutive finals that decoded to nothing while locked.
    empty_streak: u32,
    /// Evidenced finals that agreed with the lock, the lock itself included.
    /// A lock at 1 rests entirely on the final that cast it — if that final
    /// turns out to be the other lane's echo, the lock goes with it.
    lock_votes: u32,
}

impl LaneLang {
    /// Evidence floor — a final shorter than this misdetects too easily to
    /// lock or unlock anything.
    const MIN_WORDS: usize = 4;
    const MIN_DUR_CS: i64 = 200;
    /// A switch vote additionally needs the detector itself to be confident.
    const MIN_SWITCH_PROB: f32 = 0.5;
    const SWITCH_VOTES: u32 = 2;
    /// The FIRST lock needs the detector to be confident too: it has no
    /// dissent history behind it, and a wrong first lock forces every later
    /// phrase through the wrong language. Until a confident final arrives the
    /// lane simply keeps auto-detecting — an unlocked lane never eats words.
    const MIN_LOCK_PROB: f32 = 0.6;
    /// Wrong-lock escape: after this many consecutive dead finals on a locked
    /// lane, drop the lock (see [`LaneLang::note_empty_final`]).
    const EMPTY_FINALS_TO_UNLOCK: u32 = 3;

    /// The language decodes should be forced to (None = still auto-detect).
    pub fn hint(&self) -> Option<&str> {
        self.lock.as_deref()
    }

    /// Feed one accepted final: what the detector heard (language,
    /// confidence), the word count, and the phrase duration in centiseconds.
    /// Junk/empty finals must never reach here — the caller drops them first;
    /// a final with no detection is no information and changes nothing.
    pub fn observe(&mut self, detected: Option<(&str, f32)>, words: usize, dur_cs: i64) {
        let evidenced = words >= Self::MIN_WORDS || dur_cs >= Self::MIN_DUR_CS;
        // Only a final substantial enough to DEFEND the lock ends the
        // dead-final streak. Sub-2s scraps used to reset it, which kept a
        // wrong lock alive forever on a stream of short translated fragments.
        if evidenced {
            self.empty_streak = 0;
        }
        let Some((heard, prob)) = detected else { return };
        if words == 0 {
            return;
        }
        match &self.lock {
            None => {
                if evidenced && prob >= Self::MIN_LOCK_PROB {
                    self.lock = Some(heard.to_string());
                    self.dissent = None;
                    self.lock_votes = 1;
                }
            }
            Some(lock) if lock == heard => {
                self.dissent = None;
                if evidenced {
                    self.lock_votes = self.lock_votes.saturating_add(1);
                }
            }
            Some(_) => {
                if evidenced && prob >= Self::MIN_SWITCH_PROB {
                    let votes = match self.dissent.take() {
                        Some((l, n)) if l == heard => n + 1,
                        _ => 1,
                    };
                    if votes >= Self::SWITCH_VOTES {
                        self.lock = Some(heard.to_string());
                        self.dissent = None;
                        self.lock_votes = 1;
                    } else {
                        self.dissent = Some((heard.to_string(), votes));
                    }
                } else {
                    // A weak or unconfident disagreement is no vote — and it
                    // breaks the run: CONSECUTIVE strong finals are what make
                    // a switch trustworthy.
                    self.dissent = None;
                    // But a short final that CONFIDENTLY sounds like another
                    // language is a scrap the lock barely survived — streak
                    // evidence of a dead lock, same as an empty decode. This
                    // closes the deadlock where every phrase is too short to
                    // vote yet the lane keeps translating them.
                    if prob >= Self::MIN_SWITCH_PROB {
                        self.note_empty_final();
                    }
                }
            }
        }
    }

    /// A final that voted turned out to be the other lane's echo: meeting
    /// audio, not this lane's speaker. Its dissent is retracted — and a lock
    /// resting on that final ALONE (`lock_votes` ≤ 1, no evidenced final has
    /// confirmed it since) falls with it. (The echo can integrate before its
    /// twin, so the vote can't always be avoided — only undone.)
    pub fn retract(&mut self, lang: Option<&str>) {
        self.dissent = None;
        if let (Some(l), Some(lock)) = (lang, self.lock.as_deref()) {
            if l == lock && self.lock_votes <= 1 {
                *self = Self::default();
            }
        }
    }

    /// Feed one final whose decode came back with no text at all (empty or
    /// fully gated). On an unlocked lane that is just silence/noise and means
    /// nothing. On a LOCKED lane a run of them is the wrong-lock deadlock —
    /// speech in the true language, forced through the wrong one, dies in the
    /// junk/confidence gates and can never cast a dissent vote — so after
    /// [`Self::EMPTY_FINALS_TO_UNLOCK`] consecutive ones the lane resets to
    /// fresh (unlocked, auto-detecting). Worst case the lock was fine and the
    /// run was real noise: the next confident final simply re-locks it.
    pub fn note_empty_final(&mut self) {
        if self.lock.is_none() {
            return;
        }
        self.empty_streak += 1;
        if self.empty_streak >= Self::EMPTY_FINALS_TO_UNLOCK {
            *self = Self::default();
        }
    }
}

// ---------------------------------------------------------------- engine

pub enum EngineMsg {
    Audio { source: Source, rate: u32, samples: Vec<f32> },
    /// The ScreenCaptureKit tap came up (or failed) on its helper thread.
    #[cfg(target_os = "macos")]
    SysTap(Result<sck::SysAudioTap, String>),
    SetLiveTranslate(Option<String>),
    /// Live transcription on/off. Off: audio keeps recording (the lanes still
    /// ingest and mix into the timeline) but nothing is decoded — closed
    /// phrases are dropped, no partials are scheduled, and the ghost lines
    /// clear. Back on: decoding resumes for NEW phrases only; the gap simply
    /// has no transcript (recoverable later via [`retranscribe`]).
    SetLiveStt(bool),
    Pause,
    Resume,
    Stop { done: mpsc::Sender<Result<RecMeta, String>> },
    DecodeDone(DecodeOut),
}

pub struct DecodeJob {
    kind: JobKind,
    source: Source,
    start: usize,
    samples: Vec<f32>,
    /// The lane's sticky language at dispatch time (None = auto-detect).
    lang: Option<String>,
}

impl DecodeJob {
    fn final_job(source: Source, start: usize, samples: Vec<f32>) -> Self {
        Self { kind: JobKind::Final, source, start, samples, lang: None }
    }
}

#[derive(PartialEq, Clone, Copy)]
enum JobKind {
    Partial,
    Final,
}

pub struct DecodeOut {
    kind: JobKind,
    source: Source,
    start: usize,
    n_samples: usize,
    segs: Vec<crate::stt::SegOut>,
    /// What the language detector heard (language, confidence) — the sticky
    /// policy's input, independent of any forced decode language.
    detected: Option<(String, f32)>,
    /// Voiceprint of the phrase (system lane only) for speaker clustering.
    emb: Option<diarize::VoicePrint>,
}

/// Cross-thread view of the live session for quick status reads.
pub struct RecShared {
    pub status: Mutex<String>,
    pub duration_cs: AtomicI64,
    /// Latest per-source health, [mic, sys]: ("on" | "error" | "off", human
    /// message). Kept HERE so `rec_live_status` can answer at any time — the
    /// rec-source events alone are lost on a viewer that mounts after a fast
    /// failure, which is exactly when the user most needs the banner.
    pub sources: Mutex<[(String, String); 2]>,
}

pub struct EngineConfig {
    pub file_id: String,
    pub room_path: String,
    pub model_path: PathBuf,
    /// Prior audio when resuming an existing recording file (else empty).
    pub base_samples: Vec<f32>,
    pub meta: RecMeta,
    pub system_audio: bool,
    pub live_translate: Option<String>,
}

pub struct EngineHandle {
    pub tx: mpsc::Sender<EngineMsg>,
    pub shared: Arc<RecShared>,
}

/// Point diarize at the speaker-embedding model riding beside the Whisper
/// weights: a user copy in the app-data models dir wins, else the bundled
/// resource (the same rule as `stt_effective_model`). Best-effort by design —
/// with no model found, diarize falls back to its DSP print and recording
/// (and re-transcription) still works.
pub fn install_diarize_model<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let found = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("models").join(diarize::MODEL_FILE))
        .filter(|p| p.exists())
        .or_else(|| {
            app.path()
                .resolve(
                    format!("models/{}", diarize::MODEL_FILE),
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|p| p.exists())
        });
    if let Some(path) = found {
        diarize::set_model_path(path);
    }
}

/// Locate the bundled Silero VAD weights, same resolution order as the
/// diarization model. Missing → lanes fall back to the energy gate.
pub fn install_vad_model<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let found = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("models").join(VAD_MODEL_FILE))
        .filter(|p| p.exists())
        .or_else(|| {
            app.path()
                .resolve(
                    format!("models/{VAD_MODEL_FILE}"),
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|p| p.exists())
        });
    if let Some(path) = found {
        set_vad_model_path(path);
    }
}

/// One VAD phrase → one transcript row: Whisper's sub-segments are merged,
/// keeping the words' own timestamps. Returns (text, words, language,
/// mean token probability across the phrase — the bleed detector's signal).
fn merge_phrase(segs: &[crate::stt::SegOut]) -> (String, Vec<RecWord>, Option<String>, f32) {
    let mut text = String::new();
    let mut words = Vec::new();
    let mut lang = None;
    let mut p_sum = 0f32;
    let mut p_n = 0usize;
    for s in segs {
        if !s.text.trim().is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(s.text.trim());
            p_sum += s.mean_p * s.words.len().max(1) as f32;
            p_n += s.words.len().max(1);
        }
        words.extend(s.words.iter().map(|(w, a, b)| RecWord {
            w: w.clone(),
            t0: *a,
            t1: *b,
            del: false,
        }));
        lang = lang.or_else(|| s.lang.clone());
    }
    let mean_p = if p_n > 0 { p_sum / p_n as f32 } else { 0.0 };
    (text, words, lang, mean_p)
}

/// Rebuild a whole recording's transcript from its audio with the CURRENT
/// pipeline — the offline twin of the live engine, for recordings saved with
/// corrupted words, a wrong language lock, or older speaker logic. Blocking;
/// run it on a worker thread.
///
/// The same building blocks, one lane: the VAD chunks the samples into
/// phrases, each final decodes under the [`LaneLang`] sticky policy (Sniff →
/// lock → Watch, same constants), every phrase gets a voiceprint, and one
/// [`diarize::relabel`] at the end derives the speakers from all voices at
/// once. Everything is source "sys": the mixed file has no lane identity left,
/// so nobody becomes "You" — speakers are "Speaker N". `cuts` and
/// `max_speakers` are the ONLY survivors of the old meta: prior studio
/// deletions keep applying to the (unchanged) timeline, and a pinned
/// participant count stays pinned.
///
/// `progress` is called after each decoded phrase with
/// (done centiseconds, total centiseconds), ending at (total, total).
pub fn retranscribe(
    model: &std::path::Path,
    samples: &[f32],
    cuts: Vec<RecCut>,
    max_speakers: u32,
    mut progress: impl FnMut(i64, i64),
) -> RecMeta {
    let total_cs = cs_of_samples(samples.len());
    let mut meta = RecMeta { duration_cs: total_cs, cuts, max_speakers, ..Default::default() };

    // Chunked like live capture so the lane's carry buffer stays small — a
    // 3 h recording must not be copied whole into it.
    let mut lane = Lane::new(0);
    let mut phrases = Vec::new();
    for part in samples.chunks(SAMPLE_RATE) {
        phrases.extend(lane.push(part));
    }
    phrases.extend(lane.flush_active());

    let mut lang = LaneLang::default();
    let mut book = match max_speakers {
        0 => diarize::SpeakerBook::auto(),
        n => diarize::SpeakerBook::with_cap(n as usize),
    };
    for (start, audio) in phrases {
        let (t0, t1) = (cs_of_samples(start), cs_of_samples(start + audio.len()));
        let mode = match lang.hint() {
            Some(l) => crate::stt::LangMode::Watch(l),
            None => crate::stt::LangMode::Sniff,
        };
        let phrase = crate::stt::transcribe_segments(model, &audio, t0, mode).unwrap_or_default();
        let (text, words, seg_lang, _mean_p) = merge_phrase(&phrase.segs);
        if text.trim().is_empty() {
            // Same wrong-lock escape as live: a locked lane whose finals keep
            // decoding to nothing eventually unlocks and re-detects.
            lang.note_empty_final();
            progress(t1, total_cs);
            continue;
        }
        lang.observe(
            phrase.detected.as_ref().map(|(l, p)| (l.as_str(), *p)),
            words.len(),
            t1 - t0,
        );
        let emb = diarize::embed(&audio);
        let speaker = book.assign(Some(&emb));
        meta.segments.push(RecSegment {
            id: uuid::Uuid::new_v4().to_string(),
            source: Source::Sys.as_str().into(),
            speaker,
            t0,
            t1,
            text,
            words,
            lang: seg_lang,
            voice: Some(emb),
        });
        progress(t1, total_cs);
    }
    diarize::relabel(&mut meta.segments, max_speakers as usize);
    // The carried-over cuts are the user's studio deletions. Re-marking the
    // freshly derived words that fall inside them keeps that promise:
    // deleted content must not resurface in the transcript, the search
    // index, or an exported copy just because the words were re-transcribed.
    for seg in &mut meta.segments {
        for w in &mut seg.words {
            if meta.cuts.iter().any(|c| w.t0 < c.t1 && w.t1 > c.t0) {
                w.del = true;
            }
        }
    }
    progress(total_cs, total_cs);
    meta
}

pub fn start_engine<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    cfg: EngineConfig,
) -> EngineHandle {
    let (tx, rx) = mpsc::channel::<EngineMsg>();
    let shared = Arc::new(RecShared {
        status: Mutex::new("recording".to_string()),
        duration_cs: AtomicI64::new(cs_of_samples(cfg.base_samples.len())),
        sources: Mutex::new([("on".into(), String::new()), ("off".into(), String::new())]),
    });

    install_diarize_model(&app);
    install_vad_model(&app);

    // The decoder lane: one thread, one Whisper call at a time, results sent
    // back so the engine stays the single owner of ordering and state.
    let (job_tx, job_rx) = mpsc::channel::<DecodeJob>();
    {
        let engine_tx = tx.clone();
        let model = cfg.model_path.clone();
        std::thread::spawn(move || {
            for job in job_rx {
                let offset_cs = cs_of_samples(job.start);
                // Finals carry a detection report (it is what locks a lane or
                // votes to move it); partials are throwaway and must never
                // pay for the detector — pre-lock ones can fire every 1.5 s
                // for a long time on audio that never earns a lock.
                let mode = match (job.lang.as_deref(), job.kind) {
                    (Some(l), JobKind::Final) => crate::stt::LangMode::Watch(l),
                    (Some(l), JobKind::Partial) => crate::stt::LangMode::Forced(l),
                    (None, JobKind::Final) => crate::stt::LangMode::Sniff,
                    (None, JobKind::Partial) => crate::stt::LangMode::Auto,
                };
                let phrase = crate::stt::transcribe_segments(&model, &job.samples, offset_cs, mode)
                    .unwrap_or_default();
                // Both lanes get a voiceprint: people in the room share the
                // microphone, so "the mic" is not a person.
                let emb = (job.kind == JobKind::Final).then(|| diarize::embed(&job.samples));
                let _ = engine_tx.send(EngineMsg::DecodeDone(DecodeOut {
                    kind: job.kind,
                    source: job.source,
                    start: job.start,
                    n_samples: job.samples.len(),
                    segs: phrase.segs,
                    detected: phrase.detected,
                    emb,
                }));
            }
        });
    }

    let handle = EngineHandle { tx: tx.clone(), shared: shared.clone() };
    std::thread::spawn(move || Engine::new(app, cfg, tx, job_tx, shared, rx).run());
    handle
}

struct Engine<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    cfg: EngineConfig,
    self_tx: mpsc::Sender<EngineMsg>,
    job_tx: mpsc::Sender<DecodeJob>,
    shared: Arc<RecShared>,
    rx: mpsc::Receiver<EngineMsg>,

    mixed: Vec<f32>,
    mic: Lane,
    sys: Lane,
    meta: RecMeta,
    book: diarize::SpeakerBook,
    live_translate: Option<String>,
    /// Live transcription gate (see [`EngineMsg::SetLiveStt`]); ON at start.
    live_stt: bool,
    /// Per-lane sticky language (indexed by `Source as usize`).
    lane_lang: [LaneLang; 2],

    decode_busy: bool,
    final_queue: VecDeque<DecodeJob>,
    partial_pending: Option<DecodeJob>,
    /// Start sample of the newest phrase finalized on each lane (indexed by
    /// `Source as usize`). A partial that comes back from the decoder for a
    /// phrase at or before it is stale and must not be shown.
    last_final_start: [Option<usize>; 2],
    #[cfg(target_os = "macos")]
    sys_tap: Option<sck::SysAudioTap>,
    paused: bool,
    stopping: Option<mpsc::Sender<Result<RecMeta, String>>>,
    segments_since_flush: usize,
    /// Mixed-timeline length at the last flush — the time-based flush trigger
    /// (audio must persist even when no segments land to count).
    flushed_samples: usize,
    last_level_emit: std::time::Instant,
    /// Watchdog: when the last microphone batch arrived. The WebView tap can
    /// die without a sound — worklet error, throttled page, revoked device —
    /// and silence-on-purpose still SENDS frames, so "no pushes" is the
    /// reliable dead-mic signal.
    last_mic_push: std::time::Instant,
    mic_flagged: bool,
}

impl<R: tauri::Runtime> Engine<R> {
    fn new(
        app: tauri::AppHandle<R>,
        mut cfg: EngineConfig,
        self_tx: mpsc::Sender<EngineMsg>,
        job_tx: mpsc::Sender<DecodeJob>,
        shared: Arc<RecShared>,
        rx: mpsc::Receiver<EngineMsg>,
    ) -> Self {
        let mixed = std::mem::take(&mut cfg.base_samples);
        let base = mixed.len();
        let meta = cfg.meta.clone();
        let live_translate = cfg.live_translate.clone();
        // The participant count discovers itself unless a room pinned one.
        let mut book = match meta.max_speakers {
            0 => diarize::SpeakerBook::auto(),
            n => diarize::SpeakerBook::with_cap(n as usize),
        };
        // Re-seed the numbering from prior segments so a resumed meeting keeps
        // naming new voices after the ones it already knows.
        book.seed_labels(&meta.segments);
        Self {
            mixed,
            mic: Lane::new(base),
            sys: Lane::new(base),
            meta,
            book,
            live_translate,
            live_stt: true,
            lane_lang: Default::default(),
            app,
            cfg,
            self_tx,
            job_tx,
            shared,
            rx,
            decode_busy: false,
            final_queue: VecDeque::new(),
            partial_pending: None,
            last_final_start: [None, None],
            #[cfg(target_os = "macos")]
            sys_tap: None,
            paused: false,
            stopping: None,
            segments_since_flush: 0,
            // Resumed base audio is already durable in the stored WAV —
            // checkpoints must cover only samples recorded after resume.
            flushed_samples: base,
            last_level_emit: std::time::Instant::now(),
            last_mic_push: std::time::Instant::now(),
            mic_flagged: false,
        }
    }

    fn run(mut self) {
        if self.cfg.system_audio {
            self.start_sys_tap();
        }
        self.emit_state();
        loop {
            match self.rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(msg) => {
                    if self.handle(msg) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            self.tick();
            if self.stopping.is_some()
                && !self.decode_busy
                && self.final_queue.is_empty()
                && self.partial_pending.is_none()
            {
                self.finish();
                break;
            }
        }
    }

    fn handle(&mut self, msg: EngineMsg) -> bool {
        match msg {
            EngineMsg::Audio { source, rate, samples } => {
                if !self.paused && self.stopping.is_none() {
                    self.ingest(source, rate, &samples);
                }
            }
            #[cfg(target_os = "macos")]
            EngineMsg::SysTap(result) => match result {
                Ok(tap) => {
                    if self.stopping.is_some() || self.paused {
                        tap.stop();
                    } else {
                        self.sys_tap = Some(tap);
                        self.emit_source("sys", "on", "");
                    }
                }
                Err(e) => self.emit_source("sys", "error", &e),
            },
            EngineMsg::SetLiveTranslate(lang) => self.live_translate = lang,
            EngineMsg::SetLiveStt(on) => {
                self.live_stt = on;
                if !on {
                    // The open phrases are abandoned (their audio already sits
                    // on the mixed timeline), so turning back on decodes NEW
                    // phrases only — and the ghost lines leave the screen now.
                    self.partial_pending = None;
                    let _ = self.mic.flush_active();
                    let _ = self.sys.flush_active();
                    for source in [Source::Mic, Source::Sys] {
                        self.emit_partial(source, 0, "");
                    }
                }
            }
            EngineMsg::Pause => {
                self.paused = true;
                self.close_open_phrases();
                // Force-closing can truncate a phrase into an empty final;
                // "consecutive dead finals" must not span a pause.
                for lane in &mut self.lane_lang {
                    lane.empty_streak = 0;
                }
                self.stop_sys_tap();
                let _ = self.flush(true);
                *self.shared.status.lock().unwrap() = "paused".into();
                self.emit_state();
            }
            EngineMsg::Resume => {
                self.paused = false;
                self.last_mic_push = std::time::Instant::now();
                if self.cfg.system_audio {
                    self.start_sys_tap();
                }
                *self.shared.status.lock().unwrap() = "recording".into();
                self.emit_state();
            }
            EngineMsg::Stop { done } => {
                self.close_open_phrases();
                self.stop_sys_tap();
                self.partial_pending = None;
                self.stopping = Some(done);
                *self.shared.status.lock().unwrap() = "saving".into();
                self.emit_state();
                // Make the audio bytes durable NOW, before the transcript tail
                // finishes decoding: a checkpoint append is cheap, and it lets
                // the UI truthfully say "your audio is saved" the moment Stop
                // is pressed instead of after a possibly-long decode drain.
                let _ = self.flush(false);
                self.emit_save_progress("transcribing");
            }
            EngineMsg::DecodeDone(out) => {
                self.decode_busy = false;
                self.integrate(out);
                self.dispatch_next();
                if self.stopping.is_some() {
                    self.emit_save_progress("transcribing");
                }
            }
        }
        false
    }

    fn ingest(&mut self, source: Source, rate: u32, samples: &[f32]) {
        if source == Source::Mic {
            self.last_mic_push = std::time::Instant::now();
            if self.mic_flagged {
                self.mic_flagged = false;
                self.emit_source("mic", "on", "");
            }
        }
        let samples = resample_to_16k(samples, rate);
        // Mix into the shared timeline at the lane's own position: both lanes
        // started together, so lane-local position IS the timeline position.
        let at = {
            let lane = match source {
                Source::Mic => &mut self.mic,
                Source::Sys => &mut self.sys,
            };
            let at = lane.ingested;
            lane.ingested += samples.len();
            at
        };
        let need = at + samples.len();
        if need > MAX_SESSION_SAMPLES {
            self.emit_error("Recording reached the 3-hour session limit — stopping.");
            let _ = self.self_tx.send(EngineMsg::Stop { done: mpsc::channel().0 });
            return;
        }
        if self.mixed.len() < need {
            self.mixed.resize(need, 0.0);
        }
        for (i, s) in samples.iter().enumerate() {
            self.mixed[at + i] += *s;
        }
        let closed = match source {
            Source::Mic => self.mic.push(&samples),
            Source::Sys => self.sys.push(&samples),
        };
        if self.live_stt {
            for (start, audio) in closed {
                self.queue_final(source, start, audio);
            }
        }
        self.dispatch_next();
        self.shared
            .duration_cs
            .store(cs_of_samples(self.mixed.len()), Ordering::Relaxed);
        // Crash safety cannot depend on segments existing: with live STT off
        // (or a silent room) no segment ever lands, and the segment-count
        // flush would leave hours of audio only in memory.
        if self.mixed.len().saturating_sub(self.flushed_samples) >= SAMPLE_RATE * 60 {
            let _ = self.flush(false);
        }
    }

    fn tick(&mut self) {
        if self.paused || self.stopping.is_some() {
            return;
        }
        // Mic frames arrive ~4x/s while the tap lives (even muted or silent
        // — disabled tracks still deliver zeros). Six seconds of nothing
        // means the tap is dead, not quiet.
        if !self.mic_flagged && self.last_mic_push.elapsed().as_secs() >= 6 {
            self.mic_flagged = true;
            self.emit_source(
                "mic",
                "error",
                "The microphone stopped sending audio — the Mac's audio keeps recording. \
                 Pause and resume to reconnect the microphone.",
            );
        }
        if self.live_stt {
            for source in [Source::Mic, Source::Sys] {
                let due = match source {
                    Source::Mic => self.mic.partial_due(),
                    Source::Sys => self.sys.partial_due(),
                };
                if let Some((start, samples)) = due {
                    // Only the newest partial matters; a stale one is dropped
                    // rather than queued behind finals.
                    self.partial_pending =
                        Some(DecodeJob { kind: JobKind::Partial, source, start, samples, lang: None });
                }
            }
        }
        self.dispatch_next();
        if self.last_level_emit.elapsed().as_millis() >= 200 {
            self.last_level_emit = std::time::Instant::now();
            let _ = self.app.emit(
                "rec-level",
                serde_json::json!({
                    "fileId": self.cfg.file_id,
                    "mic": self.mic.level,
                    "sys": self.sys.level,
                    "durationCs": cs_of_samples(self.mixed.len()),
                }),
            );
            self.mic.level *= 0.5;
            self.sys.level *= 0.5;
        }
    }

    /// Queue a closed phrase for its final decode, and retire the lane's live
    /// partial: the phrase it belonged to is over, so decoding that snapshot
    /// now would re-emit a "still speaking…" ghost line *after* the real
    /// transcript row for the same words. Finals also outrank partials in
    /// `dispatch_next`, which is exactly how a pending partial could outlive
    /// its phrase.
    fn queue_final(&mut self, source: Source, start: usize, audio: Vec<f32>) {
        self.drop_partial(source);
        self.last_final_start[source as usize] = Some(start);
        self.final_queue.push_back(DecodeJob::final_job(source, start, audio));
    }

    fn drop_partial(&mut self, source: Source) {
        if self.partial_pending.as_ref().is_some_and(|p| p.source == source) {
            self.partial_pending = None;
        }
    }

    fn dispatch_next(&mut self) {
        if self.decode_busy {
            return;
        }
        let job = self
            .final_queue
            .pop_front()
            .or_else(|| self.partial_pending.take());
        if let Some(mut job) = job {
            // Stamp the sticky language at DISPATCH, not enqueue: a queued
            // final must feel the lock the previous final just established.
            job.lang = self.lane_lang[job.source as usize].hint().map(str::to_string);
            self.decode_busy = true;
            let _ = self.job_tx.send(job);
        }
    }

    fn close_open_phrases(&mut self) {
        for source in [Source::Mic, Source::Sys] {
            let flushed = match source {
                Source::Mic => self.mic.flush_active(),
                Source::Sys => self.sys.flush_active(),
            };
            match flushed {
                Some((start, audio)) if self.live_stt => self.queue_final(source, start, audio),
                _ => {
                    // Nothing left to say on this lane (or live transcription
                    // is off) — clear any live ghost.
                    self.drop_partial(source);
                    self.emit_partial(source, 0, "");
                }
            }
        }
        self.dispatch_next();
    }

    fn integrate(&mut self, out: DecodeOut) {
        match out.kind {
            JobKind::Partial => {
                // A partial that was already in the decoder when live STT was
                // switched off would repaint the ghost line that switch just
                // cleared — and nothing else would ever clear it again.
                if !self.live_stt {
                    return;
                }
                // A partial that was already in the decoder when its phrase
                // closed describes words the transcript now shows for real.
                if self.last_final_start[out.source as usize].is_some_and(|s| out.start <= s) {
                    return;
                }
                let text = out
                    .segs
                    .iter()
                    .map(|s| s.text.trim())
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                self.emit_partial(out.source, cs_of_samples(out.start), &text);
            }
            JobKind::Final => {
                let (text, words, lang, mean_p) = merge_phrase(&out.segs);
                // Clear this lane's ghost line even when the phrase decoded
                // to nothing (breath, keyboard clatter). A locked lane whose
                // finals keep dying here may be locked WRONG — real speech
                // forced through the wrong language gets gated — so the
                // policy counts these and eventually unlocks itself.
                if text.trim().is_empty() {
                    self.emit_partial(out.source, cs_of_samples(out.start), "");
                    self.lane_lang[out.source as usize].note_empty_final();
                    return;
                }
                let (t0, t1) = (cs_of_samples(out.start), cs_of_samples(out.start + out.n_samples));
                // The microphone hears the Mac's speakers. When a mic phrase
                // coincides with meeting speech and decodes THIS badly, it is
                // the meeting's echo mangled by the room — the degraded-echo
                // case `echo_of` can't catch, because garbled echo shares no
                // words with what the system lane heard cleanly ("Thank you."
                // over and over is Whisper guessing at mush). Real mic speech
                // during crosstalk decodes far more confidently and stays.
                if out.source == Source::Mic
                    && mean_p < 0.35
                    && self.overlaps_sys_speech(t0, t1)
                {
                    self.emit_partial(out.source, t0, "");
                    return;
                }
                // The microphone also hears the meeting through the speakers.
                // Same words, same moment, other lane: one utterance, not two.
                // The system lane wins — it cannot hear the room, so whatever
                // reaches it is what the computer actually played.
                if let Some(twin) = self.echo_of(out.source, t0, t1, &text) {
                    if out.source == Source::Mic {
                        self.emit_partial(out.source, t0, "");
                        return;
                    }
                    let echoed = self.meta.segments.remove(twin);
                    self.emit_drop(&echoed.id);
                    // The dropped row was meeting audio, not the room: any
                    // language vote it cast on the mic lane was pollution.
                    self.lane_lang[Source::Mic as usize].retract(echoed.lang.as_deref());
                }
                // Only a final that actually enters the transcript votes on
                // the lane's sticky language — junk and echoes never do.
                self.lane_lang[out.source as usize].observe(
                    out.detected.as_ref().map(|(l, p)| (l.as_str(), *p)),
                    words.len(),
                    t1 - t0,
                );
                // Provisional only: `relabel` re-derives every label, including
                // this one, from all the voices heard so far.
                let speaker = match out.source {
                    Source::Mic => "You".to_string(),
                    Source::Sys => self.book.assign(out.emb.as_ref()),
                };
                let seg = RecSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: out.source.as_str().into(),
                    speaker,
                    t0,
                    t1,
                    text,
                    words,
                    lang,
                    voice: out.emb,
                };
                // Keep the transcript ordered by time even when a slow mic
                // phrase lands after a quick system one.
                let at = self
                    .meta
                    .segments
                    .iter()
                    .rposition(|s| s.t0 <= seg.t0)
                    .map(|i| i + 1)
                    .unwrap_or(0);
                self.meta.segments.insert(at, seg.clone());
                let _ = self.app.emit(
                    "rec-segment",
                    serde_json::json!({ "fileId": self.cfg.file_id, "segment": seg }),
                );
                if let Some(lang) = self.live_translate.clone() {
                    spawn_live_translation(self.app.clone(), self.cfg.file_id.clone(), seg, lang);
                }
                self.segments_since_flush += 1;
                // Re-cluster from time to time so the speakers sort themselves
                // out *during* the conversation, not only at the end.
                if self.segments_since_flush >= RELABEL_EVERY_SEGMENTS {
                    self.relabel_speakers();
                }
                if self.segments_since_flush >= FLUSH_EVERY_SEGMENTS {
                    let _ = self.flush(false);
                }
            }
        }
    }

    /// Re-derive every meeting speaker from the whole recording's voices and,
    /// when a label moved, tell the UI so the transcript on screen corrects
    /// itself mid-conversation.
    fn relabel_speakers(&mut self) {
        if !diarize::relabel(&mut self.meta.segments, self.meta.max_speakers as usize) {
            return;
        }
        let labels: Vec<_> = self
            .meta
            .segments
            .iter()
            .map(|s| serde_json::json!({ "id": s.id, "speaker": s.speaker }))
            .collect();
        let _ = self.app.emit(
            "rec-relabel",
            serde_json::json!({ "fileId": self.cfg.file_id, "labels": labels }),
        );
    }

    /// Persist into the room. `full` (pause/stop) assembles and writes the
    /// real WAV and clears the audio checkpoints; a periodic save instead
    /// APPENDS only the samples since the last save as a raw-PCM checkpoint
    /// (`rec_chunks`) — rewriting an hour-long recording's whole WAV every
    /// minute meant ~115 MB re-encrypted per flush. A crash between full
    /// writes is recovered from the checkpoints when the room next opens.
    /// Auto-flushes skip the version snapshot — versioning every few seconds
    /// of a live recording would balloon the room; explicit edits still
    /// snapshot (recording_cmds).
    fn flush(&mut self, full: bool) -> bool {
        use tauri::Manager;
        // The transcript about to be written must carry the best labels the
        // recording can support, not the provisional live ones.
        self.relabel_speakers();
        self.meta.duration_cs = cs_of_samples(self.mixed.len());
        let text = transcript_text(&self.meta);
        let meta_json = serde_json::to_string(&self.meta).unwrap_or_default();
        let wrote = {
            let state = self.app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                Some(room) if room.path == self.cfg.room_path => {
                    // Audio first, then transcript, then meta: a failure
                    // between steps leaves a previous consistent pair
                    // readable, and the next flush retries the whole tail.
                    let audio = if full {
                        let wav = encode_wav(&self.mixed);
                        crate::db::update_file_content(
                            &room.conn,
                            &self.cfg.file_id,
                            &wav,
                            Some(&text),
                        )
                        .and_then(|_| crate::db::clear_rec_chunks(&room.conn, &self.cfg.file_id))
                    } else {
                        crate::db::append_rec_chunk(
                            &room.conn,
                            &self.cfg.file_id,
                            &self.mixed[self.flushed_samples..],
                        )
                        .and_then(|_| {
                            crate::db::set_file_extracted_text(
                                &room.conn,
                                &self.cfg.file_id,
                                &text,
                            )
                        })
                    };
                    audio
                        .and_then(|_| crate::db::set_rec_meta(&room.conn, &self.cfg.file_id, &meta_json))
                        .map_err(Some)
                }
                // The room closed/switched under a live recording: stop
                // quietly, nothing may be written into a locked room.
                _ => Err(None),
            }
        };
        match wrote {
            Ok(()) => {}
            Err(Some(db_err)) => {
                // Disk full, deleted row, encryption trouble — the audio is
                // NOT durable. Say so loudly, keep the un-flushed range
                // marked dirty (flushed_samples stays put) so the next flush
                // retries the whole tail, and keep recording in memory.
                self.emit_error(&format!(
                    "Saving the recording failed ({db_err}) — retrying; do not close the room."
                ));
                return false;
            }
            Err(None) => {
                self.emit_error("The room closed — recording stopped.");
                if self.stopping.is_none() {
                    self.stopping = Some(mpsc::channel().0);
                }
                return false;
            }
        }
        self.segments_since_flush = 0;
        self.flushed_samples = self.mixed.len();
        if full {
            let _ = self.app.emit("room-files-changed", ());
        }
        true
    }

    fn finish(&mut self) {
        self.emit_save_progress("writing");
        let saved = self.flush(true);
        *self.shared.status.lock().unwrap() = "saved".into();
        self.emit_state();
        if let Some(done) = self.stopping.take() {
            // A failed final write must fail the STOP, not smile through it.
            let _ = done.send(if saved {
                Ok(self.meta.clone())
            } else {
                Err("The recording could not be saved into the room.".into())
            });
        }
    }

    fn start_sys_tap(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let engine_tx = self.self_tx.clone();
            let audio_tx = self.self_tx.clone();
            std::thread::spawn(move || {
                let result = sck::SysAudioTap::start(Box::new(move |samples: &[f32]| {
                    let _ = audio_tx.send(EngineMsg::Audio {
                        source: Source::Sys,
                        rate: SAMPLE_RATE as u32,
                        samples: samples.to_vec(),
                    });
                }));
                let _ = engine_tx.send(EngineMsg::SysTap(result));
            });
        }
    }

    fn stop_sys_tap(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(tap) = self.sys_tap.take() {
            tap.stop();
        }
    }

    /// The lane's live "still speaking…" line. An empty `text` clears it.
    /// Index of the phrase the other lane already captured for this same
    /// sound, if any. Newest-first, since an echo lands beside its original.
    /// The time-overlap guard is what rules out a sentence merely repeated
    /// later, so the scan needs no window of its own.
    fn echo_of(&self, source: Source, t0: i64, t1: i64, text: &str) -> Option<usize> {
        let other = match source {
            Source::Mic => "sys",
            Source::Sys => "mic",
        };
        self.meta
            .segments
            .iter()
            .enumerate()
            .rev()
            .find(|(_, s)| {
                s.source == other
                    && time_overlap((s.t0, s.t1), (t0, t1)) >= ECHO_OVERLAP
                    && text_overlap(&s.text, text) >= ECHO_SAME_TEXT
            })
            .map(|(i, _)| i)
    }

    /// A row already on screen turned out to be the other lane's echo.
    /// Was the system lane carrying speech anywhere inside [t0, t1]? Checks
    /// finished sys segments (newest first) AND the sys lane's still-open
    /// phrase — during a long monologue the overlapping sys phrase hasn't
    /// closed yet, which is exactly when the mic's mangled echo arrives.
    fn overlaps_sys_speech(&self, t0: i64, t1: i64) -> bool {
        if let LaneState::Active { start, buf, .. } = &self.sys.state {
            let (s0, s1) = (cs_of_samples(*start), cs_of_samples(start + buf.len()));
            if time_overlap((t0, t1), (s0, s1)) > 0.0 {
                return true;
            }
        }
        self.meta
            .segments
            .iter()
            .rev()
            .take(50)
            .filter(|s| s.source == Source::Sys.as_str())
            .any(|s| time_overlap((t0, t1), (s.t0, s.t1)) >= 0.3)
    }

    fn emit_drop(&self, id: &str) {
        let _ = self.app.emit(
            "rec-segment-drop",
            serde_json::json!({ "fileId": self.cfg.file_id, "id": id }),
        );
    }

    fn emit_partial(&self, source: Source, t0: i64, text: &str) {
        let _ = self.app.emit(
            "rec-partial",
            serde_json::json!({
                "fileId": self.cfg.file_id,
                "source": source.as_str(),
                "t0": t0,
                "text": text,
            }),
        );
    }

    fn emit_state(&self) {
        let status = self.shared.status.lock().unwrap().clone();
        let _ = self.app.emit(
            "rec-state",
            serde_json::json!({
                "fileId": self.cfg.file_id,
                "status": status,
                "durationCs": cs_of_samples(self.mixed.len()),
            }),
        );
    }

    /// Progress of the stop→saved drain, so the UI can name the phase instead
    /// of sitting on one static "Saving…" line. `remaining` counts the phrase
    /// decodes still queued; the audio itself is already durable (the Stop
    /// handler checkpoints it before the first emit).
    fn emit_save_progress(&self, stage: &str) {
        let remaining = self.final_queue.len() + usize::from(self.decode_busy);
        let _ = self.app.emit(
            "rec-save-progress",
            serde_json::json!({
                "fileId": self.cfg.file_id,
                "stage": stage,
                "remaining": remaining,
            }),
        );
    }

    fn emit_source(&self, source: &str, status: &str, message: &str) {
        // Durable first, event second: a viewer that mounts later reads the
        // health from rec_live_status instead of having missed the event.
        {
            let mut sources = self.shared.sources.lock().unwrap();
            let slot = if source == "mic" { 0 } else { 1 };
            sources[slot] = (status.to_string(), message.to_string());
        }
        let _ = self.app.emit(
            "rec-source",
            serde_json::json!({
                "fileId": self.cfg.file_id,
                "source": source,
                "status": status,
                "message": message,
            }),
        );
    }

    fn emit_error(&self, message: &str) {
        let _ = self
            .app
            .emit("rec-error", serde_json::json!({ "fileId": self.cfg.file_id, "message": message }));
    }
}

/// Translate one fresh segment on the LOCAL model and ship it to the UI —
/// fire-and-forget: live translation is a lens over the transcript, never a
/// gate on it. (The durable, whole-file translation is `rec_translate`.)
fn spawn_live_translation<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    file_id: String,
    seg: RecSegment,
    lang: String,
) {
    tauri::async_runtime::spawn(async move {
        let models = match crate::ollama::list_models().await {
            Ok(m) if !m.is_empty() => m,
            _ => return,
        };
        let model = crate::commands::best_local_default(&models);
        let prompt = format!(
            "Translate this into {lang}. Output ONLY the translation, nothing else.\n\n{}",
            seg.text
        );
        let messages = vec![crate::ollama::ChatMessage::new("user", prompt)];
        // MIGRATION Phase 2a: non-streamed sidecar `/generate` (no tools, no Stop).
        if let Ok(out) = crate::ollama::generate(
            &model,
            messages,
            Some(0.2),
            "5m",
            None,
            crate::ollama::CtxTier::Chat,
        )
        .await
        {
            let text = crate::commands::strip_think_spans(&out).trim().to_string();
            if !text.is_empty() {
                let _ = app.emit(
                    "rec-live-translation",
                    serde_json::json!({ "fileId": file_id, "segId": seg.id, "text": text }),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The microphone hears the meeting through the speakers, degraded and
    /// punctuated differently — that is still one utterance, not two.
    #[test]
    fn echo_is_recognized_across_lanes() {
        let clean = "Let's move the launch to Friday.";
        assert!(text_overlap(clean, "let's move the launch to friday") > ECHO_SAME_TEXT);
        assert!(text_overlap(clean, "Let's move the launch") > ECHO_SAME_TEXT, "clipped echo");
        // Two people genuinely talking over each other say different things.
        assert!(text_overlap(clean, "I agree with that plan.") < ECHO_SAME_TEXT);
        assert_eq!(text_overlap(clean, ""), 0.0);

        // Lanes segment independently, so their boundaries never align.
        assert!(time_overlap((100, 400), (120, 430)) > ECHO_OVERLAP);
        // Consecutive turns touch but do not overlap.
        assert!(time_overlap((100, 400), (400, 700)) < ECHO_OVERLAP);
        // The same sentence said again, a minute later, is not an echo.
        assert_eq!(time_overlap((100, 400), (6100, 6400)), 0.0);
        // A short phrase fully inside a long one still counts as contained.
        assert_eq!(time_overlap((100, 900), (300, 400)), 1.0);
    }

    // ------------------------------------------------ sticky-language policy

    /// A well-evidenced final: long enough on both axes, confident detector.
    fn strong(lane: &mut LaneLang, lang: &str) {
        lane.observe(Some((lang, 0.9)), 8, 400);
    }

    #[test]
    fn lane_lang_locks_on_first_evidenced_final() {
        let mut lane = LaneLang::default();
        assert_eq!(lane.hint(), None, "a fresh lane auto-detects");
        strong(&mut lane, "he");
        assert_eq!(lane.hint(), Some("he"));

        // Word count alone is enough…
        let mut by_words = LaneLang::default();
        by_words.observe(Some(("he", 0.9)), LaneLang::MIN_WORDS, 50);
        assert_eq!(by_words.hint(), Some("he"));
        // …and so is duration alone (one long word).
        let mut by_dur = LaneLang::default();
        by_dur.observe(Some(("he", 0.9)), 1, LaneLang::MIN_DUR_CS);
        assert_eq!(by_dur.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_weak_final_does_not_lock() {
        let mut lane = LaneLang::default();
        // Short and quick — exactly the phrase whisper misdetects.
        lane.observe(Some(("en", 0.9)), 2, 80);
        assert_eq!(lane.hint(), None, "a two-word blip must not set the lock");
        strong(&mut lane, "he");
        assert_eq!(lane.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_unconfident_first_detection_does_not_lock() {
        let mut lane = LaneLang::default();
        // Long enough on both axes, but the detector itself is guessing.
        lane.observe(Some(("en", LaneLang::MIN_LOCK_PROB - 0.05)), 8, 400);
        assert_eq!(lane.hint(), None, "an unconfident detection must not set the lock");
        // The lane keeps auto-detecting until a confident final arrives…
        lane.observe(Some(("he", LaneLang::MIN_LOCK_PROB)), 8, 400);
        assert_eq!(lane.hint(), Some("he"), "…which locks it");
    }

    #[test]
    fn lane_lang_three_empty_finals_unlock_a_locked_lane() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "en"); // e.g. one English opener in a Hebrew meeting
        for _ in 0..LaneLang::EMPTY_FINALS_TO_UNLOCK - 1 {
            lane.note_empty_final();
            assert_eq!(lane.hint(), Some("en"), "the lock survives a short dead run");
        }
        lane.note_empty_final();
        assert_eq!(lane.hint(), None, "a locked lane eating every final must re-detect");
        // And the fresh lane locks onto what it now actually hears.
        strong(&mut lane, "he");
        assert_eq!(lane.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_accepted_final_resets_the_empty_streak() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        lane.note_empty_final();
        lane.note_empty_final();
        strong(&mut lane, "he"); // the lock is producing words again
        lane.note_empty_final();
        lane.note_empty_final();
        assert_eq!(lane.hint(), Some("he"), "non-consecutive dead finals must not add up");
        // Even a final with no usable detection proves the lock decodes words.
        lane.observe(None, 8, 400);
        lane.note_empty_final();
        lane.note_empty_final();
        assert_eq!(lane.hint(), Some("he"));
        lane.note_empty_final();
        assert_eq!(lane.hint(), None);
    }

    /// The reviewer's residual deadlock: a wrong lock fed nothing but short
    /// phrases. Scraps can't vote, but confident other-language scraps now
    /// count toward the dead-final streak — and agreeing scraps no longer
    /// reset it, so a dead lock can't be kept alive by fragments.
    #[test]
    fn lane_lang_short_confident_dissents_unlock_a_dead_lock() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "en"); // wrong lock: the meeting is Hebrew
        for _ in 0..LaneLang::EMPTY_FINALS_TO_UNLOCK {
            // 2 translated words, 1.2 s — too short to vote, clearly Hebrew.
            lane.observe(Some(("he", 0.8)), 2, 120);
        }
        assert_eq!(lane.hint(), None, "all-short speech must still escape a wrong lock");

        // Agreeing scraps are neutral: they neither defend nor kill a lock.
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        lane.note_empty_final();
        lane.note_empty_final();
        lane.observe(Some(("he", 0.9)), 2, 120); // "כן." — a scrap, agreeing
        lane.note_empty_final();
        assert_eq!(lane.hint(), None, "a scrap must not reset the dead-final streak");
    }

    /// An echo that single-handedly locked the mic lane must take its lock
    /// with it when the sys twin unmasks it; a lock confirmed by any other
    /// evidenced final stays.
    #[test]
    fn lane_lang_echo_retraction_undoes_a_lone_lock() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "en"); // the echo's vote — nothing else supports it
        lane.retract(Some("en"));
        assert_eq!(lane.hint(), None, "a lock resting on the echo alone must fall");

        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "he"); // the room's own speech confirmed it
        lane.retract(Some("he"));
        assert_eq!(lane.hint(), Some("he"), "a confirmed lock survives one retraction");
        // Retracting a language that isn't the lock never touches it.
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        lane.retract(Some("en"));
        assert_eq!(lane.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_empty_finals_on_an_unlocked_lane_mean_nothing() {
        let mut lane = LaneLang::default();
        for _ in 0..10 {
            lane.note_empty_final(); // silence and noise before anyone speaks
        }
        assert_eq!(lane.hint(), None);
        strong(&mut lane, "he");
        assert_eq!(lane.hint(), Some("he"), "the dead run must not poison the first lock");
        lane.note_empty_final();
        assert_eq!(lane.hint(), Some("he"), "pre-lock dead finals must not count post-lock");
    }

    #[test]
    fn lane_lang_single_misdetection_is_absorbed() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        // One confident, well-evidenced English final: still not believed.
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("he"));
        // Agreeing speech resumes; a later lone misdetection starts over.
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_two_consecutive_strong_finals_switch() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("en"), "a genuine change re-locks");
    }

    #[test]
    fn lane_lang_agreement_breaks_a_dissent_run() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        strong(&mut lane, "he"); // back to the locked language
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("he"), "non-consecutive votes must not add up");
    }

    #[test]
    fn lane_lang_weak_or_unconfident_disagreement_is_no_vote() {
        // Confident but short: no vote, and it breaks the run.
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        lane.observe(Some(("en", 0.9)), 2, 80);
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("he"));
        // Long but unconfident: same.
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        lane.observe(Some(("en", 0.2)), 8, 400);
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("he"));
    }

    #[test]
    fn lane_lang_dissent_votes_must_agree_with_each_other() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        strong(&mut lane, "fr"); // a different stranger restarts the count
        assert_eq!(lane.hint(), Some("he"));
        strong(&mut lane, "fr");
        assert_eq!(lane.hint(), Some("fr"));
    }

    #[test]
    fn lane_lang_empty_or_undetected_finals_change_nothing() {
        let mut lane = LaneLang::default();
        strong(&mut lane, "he");
        strong(&mut lane, "en");
        // No detection / no words: no information — the run survives it
        // (the engine never even calls observe for junk finals).
        lane.observe(None, 8, 400);
        lane.observe(Some(("en", 0.9)), 0, 400);
        assert_eq!(lane.hint(), Some("he"));
        strong(&mut lane, "en");
        assert_eq!(lane.hint(), Some("en"));

        // And on a fresh lane they must not lock anything.
        let mut fresh = LaneLang::default();
        fresh.observe(None, 8, 400);
        fresh.observe(Some(("he", 0.9)), 0, 400);
        assert_eq!(fresh.hint(), None);
    }

    #[test]
    fn lane_lang_lanes_are_independent() {
        let mut mic = LaneLang::default();
        let mut sys = LaneLang::default();
        strong(&mut mic, "he");
        assert_eq!(mic.hint(), Some("he"));
        assert_eq!(sys.hint(), None, "the other lane is untouched");
        strong(&mut sys, "en");
        assert_eq!(mic.hint(), Some("he"));
        assert_eq!(sys.hint(), Some("en"));
    }

    #[test]
    fn wav_roundtrip_preserves_samples() {
        let samples: Vec<f32> = (0..1600).map(|i| ((i as f32) / 100.0).sin() * 0.5).collect();
        let wav = encode_wav(&samples);
        let back = decode_wav(&wav).unwrap();
        assert_eq!(back.len(), samples.len());
        for (a, b) in samples.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
    }

    #[test]
    fn splice_removes_cut_spans_and_shift_adds_up() {
        // 3 s of audio, cut out [1.0 s, 2.0 s).
        let samples: Vec<f32> = (0..SAMPLE_RATE * 3).map(|i| i as f32).collect();
        let cuts = vec![RecCut { t0: 100, t1: 200 }];
        let out = splice_out(&samples, &cuts);
        assert_eq!(out.len(), SAMPLE_RATE * 2);
        assert_eq!(out[SAMPLE_RATE - 1], (SAMPLE_RATE - 1) as f32);
        assert_eq!(out[SAMPLE_RATE], (2 * SAMPLE_RATE) as f32); // jumped the cut
        assert_eq!(cut_shift_before(&cuts, 50), 0);
        assert_eq!(cut_shift_before(&cuts, 150), 50);
        assert_eq!(cut_shift_before(&cuts, 250), 100);
    }

    #[test]
    fn cuts_merge_overlaps() {
        let mut cuts = vec![RecCut { t0: 100, t1: 200 }];
        add_cut(&mut cuts, RecCut { t0: 150, t1: 300 });
        add_cut(&mut cuts, RecCut { t0: 500, t1: 600 });
        assert_eq!(cuts, vec![RecCut { t0: 100, t1: 300 }, RecCut { t0: 500, t1: 600 }]);
    }

    #[test]
    fn vad_finds_a_burst_between_silences() {
        let mut lane = Lane::new(0);
        // A pure tone isn't speech — Silero rightly ignores it. This test
        // exercises the open/close STATE MACHINE, so it runs the energy path.
        lane.vad = None;
        let mut audio = vec![0.0f32; SAMPLE_RATE]; // 1 s silence
        // 1 s of loud 440 Hz tone…
        audio.extend((0..SAMPLE_RATE).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * 0.3));
        // …then 1.5 s silence so the segment closes.
        audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]);
        let mut closed = Vec::new();
        for chunk in audio.chunks(1600) {
            closed.extend(lane.push(chunk));
        }
        assert_eq!(closed.len(), 1, "exactly one phrase");
        let (start, samples) = &closed[0];
        // Started near the 1 s mark (within the pre-roll window)…
        assert!(*start >= SAMPLE_RATE - PREROLL && *start <= SAMPLE_RATE + FRAME * START_FRAMES as usize);
        // …and roughly 1 s long (+ pre-roll + up-to-hangover tail).
        assert!(samples.len() >= SAMPLE_RATE / 2 && samples.len() <= SAMPLE_RATE * 2, "{}", samples.len());
    }

    #[test]
    fn resample_lengths_and_endpoints() {
        let input: Vec<f32> = (0..4800).map(|i| i as f32).collect(); // 100 ms @ 48 k
        let out = resample_to_16k(&input, 48000);
        assert_eq!(out.len(), 1600);
        assert_eq!(out[0], 0.0);
        assert!((out[1] - 3.0).abs() < 1e-4);
        assert_eq!(resample_to_16k(&input, 16000).len(), input.len());
    }

    /// The downloaded Whisper model, else the one bundled in the repo.
    fn test_model() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let downloaded = PathBuf::from(home)
            .join("Library/Application Support/com.benreich.privateroom/models")
            .join(crate::stt::MODEL_FILE);
        if downloaded.exists() {
            return Some(downloaded);
        }
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/models")
            .join(crate::stt::MODEL_FILE);
        bundled.exists().then_some(bundled)
    }

    /// Synthesized speech → mono 16 kHz f32, through the app's own decoder.
    fn say_pcm(voice: &str, line: &str) -> Option<Vec<f32>> {
        let aiff = std::env::temp_dir().join(format!("pr-rec-{}.aiff", uuid::Uuid::new_v4()));
        let ok = std::process::Command::new("say")
            .args(["-v", voice, "-o"])
            .arg(&aiff)
            .arg(line)
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
        let pcm = crate::stt::decode_to_pcm(&aiff, crate::stt::MediaKind::Audio).ok();
        let _ = std::fs::remove_file(&aiff);
        pcm
    }

    /// The whole live loop, headless: a real room DB, a mock Tauri app, real
    /// Whisper, and `say`-synthesized speech pushed through the meeting lane.
    /// Proves VAD → streaming decode → speaker labeling → persistence without
    /// any UI or TCC permission. Heavy (loads the 574 MB model):
    /// `cargo test --lib recording -- --ignored`.
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_live_engine_transcribes_and_persists() {
        use tauri::Manager;

        let model = test_model().expect("whisper model not found for the e2e test");
        let speech = say_pcm("Samantha", "The quick brown fox jumps over the lazy dog.").unwrap();

        // A real (SQLCipher) room with one recording file row.
        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-e2e-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn,
            "QA recording.wav",
            "audio/wav",
            &encode_wav(&[]),
            Some("(live recording)\n"),
            "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(
            &conn,
            &file.id,
            &serde_json::to_string(&RecMeta::default()).unwrap(),
        )
        .unwrap();

        // A mock app that carries the open room, exactly like the real one.
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );

        // Feed: half a second of room tone, the phrase, then enough silence
        // for the VAD to close it. Chunked like real capture callbacks.
        let mut audio = vec![0.0f32; SAMPLE_RATE / 2];
        audio.extend_from_slice(&speech);
        audio.extend(vec![0.0f32; SAMPLE_RATE * 2]);
        let total = audio.len();
        for chunk in audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(180))
            .expect("engine never finished")
            .expect("engine reported an error");

        // The phrase came through, with words and a meeting-speaker label.
        assert!(!meta.segments.is_empty(), "no segments decoded");
        let all = meta
            .segments
            .iter()
            .map(|s| s.text.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(all.contains("quick brown fox"), "transcript was: {all}");
        assert!(meta.segments.iter().any(|s| !s.words.is_empty()), "no word timings");
        assert_eq!(meta.segments[0].speaker, "Speaker 1");
        // One voice spoke, so exactly one speaker may exist — and the
        // voiceprint rides along so the file can be re-clustered on resume.
        let speakers: std::collections::HashSet<_> =
            meta.segments.iter().map(|s| s.speaker.as_str()).collect();
        assert_eq!(speakers.len(), 1, "one voice became {speakers:?}");
        assert!(meta.segments.iter().all(|s| s.voice.is_some()), "voiceprint not persisted");
        assert_eq!(meta.max_speakers, 0, "participant count must stay auto-discovered");
        assert_eq!(meta.duration_cs, cs_of_samples(total));

        // And it all landed in the room file, reopenable with the password.
        let conn2 = crate::db::open_room(&room_path, "qa").unwrap();
        let (_, _, bytes, text) = crate::db::get_file_full(&conn2, &file.id).unwrap();
        let wav = bytes.expect("no audio bytes persisted");
        assert_eq!(decode_wav(&wav).unwrap().len(), total);
        let text = text.expect("no transcript persisted");
        assert!(text.to_lowercase().contains("quick brown fox"), "stored transcript: {text}");
        assert!(text.contains("Speaker 1:"), "speaker missing in transcript: {text}");
        let stored: RecMeta =
            serde_json::from_str(&crate::db::get_rec_meta(&conn2, &file.id).unwrap()).unwrap();
        assert_eq!(stored.segments.len(), meta.segments.len());
        drop(conn2);
        let _ = std::fs::remove_file(&room_path);
    }

    /// The on-device QA scenario, headless and reproducible: a two-person
    /// meeting (two macOS voices, one of them answering with a single word)
    /// streamed through the real engine. It must transcribe every turn and
    /// discover exactly TWO speakers — no phantom third, nobody asked how
    /// many people were in the room. This is the regression that on-device
    /// QA caught twice.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_two_voice_meeting_discovers_two_speakers() {
        use tauri::Manager;

        let Some(model) = test_model() else { return };
        // A conversation: Samantha, Daniel, then Samantha again — including
        // the one-word reply that used to invent a speaker.
        let turns = [
            ("Samantha", "Hello team, let's review the quarterly launch plan."),
            ("Daniel", "Sounds great. I will prepare the release notes tonight."),
            ("Samantha", "Perfect."),
            ("Samantha", "Let us meet again tomorrow to finalize everything."),
        ];
        let mut audio: Vec<f32> = vec![0.0; SAMPLE_RATE / 2];
        for (voice, line) in turns {
            let Some(pcm) = say_pcm(voice, line) else { return };
            audio.extend_from_slice(&pcm);
            audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]); // gap closes the phrase
        }
        audio.extend(vec![0.0f32; SAMPLE_RATE]);

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-mtg-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Meeting.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        for chunk in audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .expect("engine never finished")
            .expect("engine reported an error");

        let all = meta.segments.iter().map(|s| s.text.to_lowercase()).collect::<Vec<_>>().join(" | ");
        assert!(all.contains("launch plan"), "missing turn 1: {all}");
        assert!(all.contains("release notes"), "missing turn 2: {all}");
        assert!(all.contains("tomorrow"), "missing turn 4: {all}");

        let speakers: std::collections::BTreeSet<_> =
            meta.segments.iter().map(|s| s.speaker.as_str()).collect();
        assert_eq!(
            speakers,
            ["Speaker 1", "Speaker 2"].into_iter().collect(),
            "a two-person meeting produced {speakers:?} — transcript was: {all}"
        );
        // Samantha opened and closed the meeting; Daniel is the other voice.
        assert_eq!(meta.segments[0].speaker, "Speaker 1");
        assert_eq!(meta.segments.last().unwrap().speaker, "Speaker 1");
        assert!(
            meta.segments.iter().any(|s| s.speaker == "Speaker 2" && s.text.to_lowercase().contains("release notes")),
            "the second voice was not separated: {all}"
        );
        let _ = std::fs::remove_file(&room_path);
    }

    /// The user-visible Hebrew bug: per-phrase auto-detection let one short
    /// phrase be misread as English — and whisper then TRANSLATES it. With
    /// the sticky lane language, a Hebrew meeting must come out Hebrew on
    /// every row: lang "he" and Hebrew script, no Latin-only segment.
    /// Skips when the Carmit voice isn't installed.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_hebrew_meeting_stays_hebrew() {
        use tauri::Manager;

        let Some(model) = test_model() else { return };
        // A long opener locks the lane, then the short replies that used to
        // flip into English, then more full sentences.
        let turns = [
            "שלום לכולם, אני רוצה להתחיל את הפגישה של היום בסקירה של התוכנית.",
            "בסדר גמור.",
            "נעבור עכשיו על התקציב לרבעון הבא ונחליט מה הכי חשוב לנו.",
            "תודה רבה.",
        ];
        let mut audio: Vec<f32> = vec![0.0; SAMPLE_RATE / 2];
        for line in turns {
            let Some(pcm) = say_pcm("Carmit", line) else {
                eprintln!("skipping: `say -v Carmit` unavailable");
                return;
            };
            audio.extend_from_slice(&pcm);
            audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]); // gap closes the phrase
        }
        audio.extend(vec![0.0f32; SAMPLE_RATE]);

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-heb-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Meeting.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        for chunk in audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .expect("engine never finished")
            .expect("engine reported an error");

        let shown = meta
            .segments
            .iter()
            .map(|s| format!("{:?}: {}", s.lang, s.text))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(meta.segments.len() >= 2, "too few segments decoded:\n{shown}");
        let hebrew = |t: &str| t.chars().any(|c| ('א'..='ת').contains(&c));
        for seg in &meta.segments {
            assert_eq!(
                seg.lang.as_deref(),
                Some("he"),
                "a phrase escaped the sticky language:\n{shown}"
            );
            assert!(
                hebrew(&seg.text),
                "a segment came out without Hebrew script (translated?):\n{shown}"
            );
        }
        let _ = std::fs::remove_file(&room_path);
    }

    /// Wrong-first-lock recovery: one English opener locks the lane "en",
    /// then the meeting is Hebrew. The old policy could hold that lock
    /// forever — Hebrew forced through "en" decodes to junk, the junk gates
    /// drop it, dropped finals never vote, and the lane silently eats every
    /// word. The engine must RECOVER: transition phrases may come out wrong
    /// or missing, but once the first Hebrew segment lands, every later
    /// Hebrew utterance must produce a Hebrew segment.
    /// Skips when the Carmit voice isn't installed.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_wrong_first_lock_recovers() {
        use tauri::Manager;

        let Some(model) = test_model() else { return };
        let Some(opener) =
            say_pcm("Samantha", "Good morning everyone, let's begin with a quick status update.")
        else {
            return;
        };
        let turns_he = [
            "שלום לכולם, אני רוצה להתחיל את הפגישה של היום בסקירה מלאה של התוכנית שלנו.",
            "נעבור עכשיו על התקציב לרבעון הבא ונחליט מה הכי חשוב לנו להשיג השנה.",
            "אני חושבת שאנחנו צריכים להשקיע יותר בפיתוח המוצר ופחות בשיווק.",
            "בואו נסכם את המשימות של כל אחד ונקבע פגישת המשך לשבוע הבא.",
            "תודה רבה לכולם על ההשתתפות, נתראה שוב מחר בבוקר.",
        ];
        let mut audio: Vec<f32> = vec![0.0; SAMPLE_RATE / 2];
        audio.extend_from_slice(&opener);
        audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]);
        // Where each Hebrew utterance sits on the timeline (sample spans), so
        // "did this utterance produce a segment?" is checkable by overlap.
        let mut he_spans: Vec<(usize, usize)> = Vec::new();
        for line in turns_he {
            let Some(pcm) = say_pcm("Carmit", line) else {
                eprintln!("skipping: `say -v Carmit` unavailable");
                return;
            };
            he_spans.push((audio.len(), audio.len() + pcm.len()));
            audio.extend_from_slice(&pcm);
            audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]); // gap closes the phrase
        }
        audio.extend(vec![0.0f32; SAMPLE_RATE]);

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-relock-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Meeting.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        for chunk in audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .expect("engine never finished")
            .expect("engine reported an error");

        let shown = meta
            .segments
            .iter()
            .map(|s| format!("[{}-{}] {:?}: {}", s.t0, s.t1, s.lang, s.text))
            .collect::<Vec<_>>()
            .join("\n");
        let hebrew = |t: &str| t.chars().any(|c| ('א'..='ת').contains(&c));
        let is_he = |s: &&RecSegment| s.lang.as_deref() == Some("he") && hebrew(&s.text);

        // The lane recovered at all…
        let recovery_t0 = meta
            .segments
            .iter()
            .find(|s| is_he(s))
            .unwrap_or_else(|| panic!("the lane never recovered to Hebrew:\n{shown}"))
            .t0;
        // …and the tail of the meeting is Hebrew again.
        let last = meta.segments.last().unwrap();
        assert!(is_he(&last), "the meeting did not END in Hebrew:\n{shown}");

        // The transition may cost phrases, but only the transition: the
        // wrong lock dies after EMPTY_FINALS_TO_UNLOCK dead finals (or two
        // dissent votes), so recovery must land within the first 4 Hebrew
        // utterances — and every utterance from the recovery on must have
        // produced a Hebrew segment. That is the "silently eating words
        // forever" regression this test pins.
        let recovered_by = cs_of_samples(he_spans[3].0);
        assert!(
            recovery_t0 <= recovered_by,
            "recovery took more than the transition allowance (first Hebrew row at {recovery_t0}cs, needed by {recovered_by}cs):\n{shown}"
        );
        for (i, (s0, s1)) in he_spans.iter().enumerate() {
            let (t0, t1) = (cs_of_samples(*s0), cs_of_samples(*s1));
            if t1 <= recovery_t0 {
                continue; // a transition phrase — allowed to be lost
            }
            assert!(
                meta.segments
                    .iter()
                    .filter(is_he)
                    .any(|s| time_overlap((s.t0, s.t1), (t0, t1)) > 0.5),
                "Hebrew utterance {i} ({t0}-{t1}cs) after recovery left no segment:\n{shown}"
            );
        }
        let _ = std::fs::remove_file(&room_path);
    }

    /// The two faults on-device QA found in a real meeting:
    ///
    /// 1. the microphone hears the meeting through the speakers, so every
    ///    remote turn was transcribed **twice**;
    /// 2. everything on the microphone was labeled "You", even the colleague
    ///    sitting in the room.
    ///
    /// Both lanes run here: the meeting arrives on `Sys` and bleeds back into
    /// `Mic` attenuated and slightly late, while two people share the mic.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_speaker_bleed_is_deduped_and_the_room_is_diarized() {
        use tauri::Manager;

        let Some(model) = test_model() else { return };
        // Remote, over the meeting: Samantha. In the room: Daniel at the Mac,
        // and Karen beside him — both on the one microphone.
        let Some(remote) = say_pcm("Samantha", "Hello team, let's review the quarterly launch plan.")
        else {
            return;
        };
        let Some(you) = say_pcm("Daniel", "Sounds great. I will prepare the release notes tonight.")
        else {
            return;
        };
        let Some(you2) = say_pcm("Daniel", "Let us meet again tomorrow to finalize everything.")
        else {
            return;
        };
        let Some(beside) = say_pcm("Karen", "I would rather push the whole thing to next week.")
        else {
            return;
        };

        let gap = |n: usize| vec![0.0f32; SAMPLE_RATE * n / 2];
        // The meeting lane: only the remote voice, then silence while the
        // room talks (nothing the computer plays, nothing captured).
        let mut sys = gap(1);
        sys.extend_from_slice(&remote);
        let sys_tail = sys.len();
        sys.extend(vec![0.0f32; SAMPLE_RATE * 12]);

        // The mic lane: the speakers' bleed of the remote voice — quieter and
        // ~30 ms late — then the two people actually in the room.
        let mut mic = gap(1);
        mic.extend(vec![0.0f32; 480]); // the speaker→mic path, one VAD frame
        mic.extend(remote.iter().map(|s| s * 0.45));
        mic.extend(vec![0.0f32; sys_tail.saturating_sub(mic.len()) + SAMPLE_RATE * 3 / 2]);
        for turn in [&you, &beside, &you2] {
            mic.extend_from_slice(turn);
            mic.extend(gap(3)); // closes the phrase
        }
        mic.extend(vec![0.0f32; SAMPLE_RATE]);

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-bleed-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Meeting.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        // Interleaved, the way two live capture callbacks actually arrive.
        let mut sys_chunks = sys.chunks(4000);
        let mut mic_chunks = mic.chunks(4000);
        loop {
            let (s, m) = (sys_chunks.next(), mic_chunks.next());
            if s.is_none() && m.is_none() {
                break;
            }
            for (source, chunk) in [(Source::Sys, s), (Source::Mic, m)] {
                if let Some(chunk) = chunk {
                    handle
                        .tx
                        .send(EngineMsg::Audio {
                            source,
                            rate: SAMPLE_RATE as u32,
                            samples: chunk.to_vec(),
                        })
                        .unwrap();
                }
            }
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .expect("engine never finished")
            .expect("engine reported an error");

        let rows = |m: &RecMeta| {
            m.segments
                .iter()
                .map(|s| format!("{}/{}: {}", s.source, s.speaker, s.text))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let shown = rows(&meta);

        // 1. The remote turn is in the transcript exactly ONCE, on the lane
        //    that truly heard it — the microphone's copy was the room's echo.
        let launch: Vec<_> =
            meta.segments.iter().filter(|s| s.text.to_lowercase().contains("launch plan")).collect();
        assert_eq!(launch.len(), 1, "the meeting audio was transcribed twice:\n{shown}");
        assert_eq!(launch[0].source, "sys", "the echo won over the real capture:\n{shown}");

        // 2. The mic is not a person. Daniel holds the Mac; Karen does not.
        let speaker_of = |needle: &str| {
            meta.segments
                .iter()
                .find(|s| s.text.to_lowercase().contains(needle))
                .map(|s| s.speaker.clone())
                .unwrap_or_else(|| panic!("'{needle}' never transcribed:\n{shown}"))
        };
        assert_eq!(speaker_of("release notes"), "You", "the Mac's owner:\n{shown}");
        assert_eq!(speaker_of("tomorrow"), "You", "same voice, second turn:\n{shown}");
        assert_ne!(
            speaker_of("next week"),
            "You",
            "the colleague sharing the microphone was called 'You':\n{shown}"
        );
        assert_ne!(speaker_of("launch plan"), "You", "the remote voice is not you:\n{shown}");
        // Three real voices, and the meeting's is not confused with the room's.
        assert_ne!(speaker_of("next week"), speaker_of("launch plan"), "room vs meeting:\n{shown}");
        let _ = std::fs::remove_file(&room_path);
    }

    /// The live-STT gate, fast: with live transcription off the engine keeps
    /// growing the mixed timeline but never dispatches a decode; back on, the
    /// next NEW phrase decodes. No Whisper involved — the engine is driven
    /// directly and the decode queue is observed from outside.
    #[test]
    fn live_stt_off_keeps_audio_but_never_decodes() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<DecodeJob>();
        let shared = Arc::new(RecShared {
            status: Mutex::new("recording".into()),
            duration_cs: AtomicI64::new(0),
            sources: Mutex::new([("on".into(), String::new()), ("off".into(), String::new())]),
        });
        let mut eng = Engine::new(
            app.handle().clone(),
            EngineConfig {
                file_id: "f".into(),
                room_path: String::new(),
                model_path: PathBuf::from("/nonexistent-model.bin"),
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
            tx,
            job_tx,
            shared,
            rx,
        );

        // A tone isn't speech for Silero; this test drives the queueing
        // logic, so the lane runs the energy path.
        eng.sys.vad = None;

        // A burst the VAD closes into one phrase (as in vad_finds_a_burst…).
        let mut burst = vec![0.0f32; SAMPLE_RATE / 2];
        burst.extend(
            (0..SAMPLE_RATE)
                .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * 0.3),
        );
        burst.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]);

        // Turning off drops any pending partial…
        eng.partial_pending = Some(DecodeJob {
            kind: JobKind::Partial,
            source: Source::Sys,
            start: 0,
            samples: Vec::new(),
            lang: None,
        });
        eng.handle(EngineMsg::SetLiveStt(false));
        assert!(eng.partial_pending.is_none(), "the pending partial must be dropped");

        // …and while off, phrases close without ever reaching the decoder,
        // yet the audio timeline keeps growing.
        eng.ingest(Source::Sys, SAMPLE_RATE as u32, &burst);
        assert!(job_rx.try_recv().is_err(), "a decode was dispatched while live STT was off");
        assert!(!eng.decode_busy && eng.final_queue.is_empty());
        assert_eq!(eng.mixed.len(), burst.len(), "audio must keep recording while live STT is off");

        // Back on: the next (NEW) phrase decodes.
        eng.handle(EngineMsg::SetLiveStt(true));
        eng.ingest(Source::Sys, SAMPLE_RATE as u32, &burst);
        let job = job_rx.try_recv().expect("a new phrase must decode once live STT is back on");
        assert!(job.start >= burst.len(), "the decoded phrase must start AFTER re-enabling");
        assert_eq!(eng.mixed.len(), burst.len() * 2);
    }

    /// The degraded-echo rule: a mic phrase that coincides with meeting
    /// speech and decodes with rock-bottom confidence is the Mac's speakers
    /// heard through the room ("Thank you." over and over) — dropped. The
    /// same phrase decoded CONFIDENTLY is a real person talking over the
    /// meeting — kept. And away from meeting speech, even a low-confidence
    /// phrase is kept: low confidence alone never deletes.
    #[test]
    fn degraded_mic_echo_of_meeting_speech_is_dropped() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let (job_tx, _job_rx) = mpsc::channel::<DecodeJob>();
        let shared = Arc::new(RecShared {
            status: Mutex::new("recording".into()),
            duration_cs: AtomicI64::new(0),
            sources: Mutex::new([("on".into(), String::new()), ("off".into(), String::new())]),
        });
        let mut eng = Engine::new(
            app.handle().clone(),
            EngineConfig {
                file_id: "f".into(),
                room_path: String::new(),
                model_path: PathBuf::from("/nonexistent-model.bin"),
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: true,
                live_translate: None,
            },
            tx,
            job_tx,
            shared,
            rx,
        );

        // A finished meeting phrase sits on the timeline at [0 s, 20 s].
        eng.meta.segments.push(RecSegment {
            id: "sys-1".into(),
            source: Source::Sys.as_str().into(),
            speaker: "Speaker 1".into(),
            t0: 0,
            t1: 2000,
            text: "דברים חשובים על המדינה".into(),
            words: vec![],
            lang: Some("he".into()),
            voice: None,
        });

        let mic_final = |mean_p: f32, start: usize| {
            let t0 = cs_of_samples(start);
            DecodeOut {
                kind: JobKind::Final,
                source: Source::Mic,
                start,
                n_samples: SAMPLE_RATE * 2,
                segs: vec![crate::stt::SegOut {
                    t0,
                    t1: t0 + 200,
                    text: "Thank you.".into(),
                    words: vec![("Thank".into(), t0, t0 + 100), ("you.".into(), t0 + 100, t0 + 200)],
                    lang: Some("en".into()),
                    mean_p,
                }],
                detected: None,
                emb: None,
            }
        };

        // Garbage-confidence phrase inside the meeting speech: dropped.
        eng.integrate(mic_final(0.2, SAMPLE_RATE * 5));
        assert_eq!(eng.meta.segments.len(), 1, "degraded echo was stored");

        // Confident phrase at the same spot (real crosstalk): kept.
        eng.integrate(mic_final(0.8, SAMPLE_RATE * 5));
        assert_eq!(eng.meta.segments.len(), 2, "confident mic speech was dropped");

        // Low confidence but NO meeting speech anywhere near: kept.
        eng.integrate(mic_final(0.2, SAMPLE_RATE * 60));
        assert_eq!(eng.meta.segments.len(), 3, "low confidence alone must never delete");
    }

    /// Periodic saves must APPEND audio checkpoints, not rewrite the whole
    /// WAV; pause/stop assemble the real WAV once and clear them; and a
    /// crash between full writes is recovered from the checkpoints. Silence
    /// only — the VAD never opens, so no Whisper is needed.
    #[test]
    fn periodic_flush_checkpoints_audio_and_stop_assembles_it() {
        use tauri::Manager;

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-chunks-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Long.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: PathBuf::from("/nonexistent-model.bin"),
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        // 61 s of silence: crosses the time-flush threshold exactly once.
        let total = SAMPLE_RATE * 61;
        for chunk in vec![0.0f32; total].chunks(SAMPLE_RATE) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        // Give the engine thread a moment to drain, then inspect the room.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let chunked = loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let state = app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().unwrap();
            let n: i64 = room
                .conn
                .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&file.id], |r| {
                    r.get(0)
                })
                .unwrap();
            let bytes = crate::db::get_file_bytes(&room.conn, &file.id).unwrap().unwrap();
            if n > 0 {
                // The periodic save checkpointed audio WITHOUT rewriting the
                // (still empty) WAV.
                assert!(decode_wav(&bytes).unwrap().is_empty(), "periodic save rewrote the WAV");
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
        };
        assert!(chunked, "no audio checkpoint was appended by the time-based flush");

        // Crash-recovery path: reassemble WAV + tail from the checkpoints.
        {
            let state = app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().unwrap();
            let recovered = crate::db::recover_rec_chunks(&room.conn).unwrap();
            assert_eq!(recovered, 1);
            let bytes = crate::db::get_file_bytes(&room.conn, &file.id).unwrap().unwrap();
            assert!(
                decode_wav(&bytes).unwrap().len() >= SAMPLE_RATE * 60,
                "recovery must splice the checkpointed minute back"
            );
            let n: i64 = room
                .conn
                .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&file.id], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(n, 0, "recovery must clear the checkpoints");
        }

        // Stop: the full WAV lands and the checkpoints stay clear.
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        done_rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap().unwrap();
        let conn2 = crate::db::open_room(&room_path, "qa").unwrap();
        let bytes = crate::db::get_file_bytes(&conn2, &file.id).unwrap().unwrap();
        assert_eq!(decode_wav(&bytes).unwrap().len(), total, "stop must write the whole timeline");
        let n: i64 = conn2
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&file.id], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        drop(conn2);
        let _ = std::fs::remove_file(&room_path);
    }

    /// Resuming a recording preloads the stored WAV into the timeline; the
    /// periodic checkpoints must cover ONLY the audio recorded after the
    /// resume, or crash recovery splices the base onto itself and every
    /// prior minute plays twice.
    #[test]
    fn resumed_recording_checkpoints_only_new_audio() {
        use tauri::Manager;

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-resume-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        // The prior session left 5 s of audio durably in the stored WAV.
        let base = vec![0.0f32; SAMPLE_RATE * 5];
        let file = crate::db::insert_file(
            &conn, "Long.wav", "audio/wav", &encode_wav(&base), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: PathBuf::from("/nonexistent-model.bin"),
                base_samples: base.clone(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        // 61 s of NEW silence: crosses the time-flush threshold exactly once.
        let total = SAMPLE_RATE * 61;
        for chunk in vec![0.0f32; total].chunks(SAMPLE_RATE) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let chunked = loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let state = app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().unwrap();
            let n: i64 = room
                .conn
                .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&file.id], |r| {
                    r.get(0)
                })
                .unwrap();
            if n > 0 {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
        };
        assert!(chunked, "no audio checkpoint was appended by the time-based flush");

        // Crash before pause/stop: recovery must yield base + tail, never
        // base + base + tail.
        {
            let state = app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().unwrap();
            crate::db::recover_rec_chunks(&room.conn).unwrap();
            let bytes = crate::db::get_file_bytes(&room.conn, &file.id).unwrap().unwrap();
            let len = decode_wav(&bytes).unwrap().len();
            assert!(
                len >= base.len() + SAMPLE_RATE * 60,
                "recovery lost the checkpointed tail ({len} samples)"
            );
            assert!(
                len <= base.len() + total,
                "recovery duplicated the resumed base audio ({len} samples)"
            );
        }

        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let _ = done_rx.recv_timeout(std::time::Duration::from_secs(30));
        let _ = std::fs::remove_file(&room_path);
    }

    /// The on-device failure of 2026-07-11: the mic hears the meeting
    /// through the SPEAKERS AND THE ROOM — reflections, noise, a lowpass —
    /// so its echo decodes not to the meeting's words (which `echo_of`
    /// would dedup) but to garbage ("Thank you." over and over, in random
    /// languages). None of that may reach the transcript, while a real
    /// person speaking into the mic between remote turns must still be
    /// heard. `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_degraded_speaker_bleed_never_becomes_garbage() {
        use tauri::Manager;

        // The room: three early reflections, a fixed noise floor, a gentle
        // lowpass (the diarize fixtures' channel, inlined).
        fn room(x: &[f32], gain: f32) -> Vec<f32> {
            let scaled: Vec<f32> = x.iter().map(|s| s * gain).collect();
            let n = scaled.len();
            let mut y = vec![0f32; n];
            for i in 0..n {
                let mut v = scaled[i];
                if i >= 400 {
                    v += 0.5 * scaled[i - 400];
                }
                if i >= 1600 {
                    v += 0.3 * scaled[i - 1600];
                }
                if i >= 3200 {
                    v += 0.15 * scaled[i - 3200];
                }
                y[i] = v;
            }
            let mut state: u32 = 0x1234_5678;
            for v in y.iter_mut() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let r = (state >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
                *v += r * 0.036;
            }
            let mut prev = 0f32;
            for v in y.iter_mut() {
                prev += 0.75 * (*v - prev);
                *v = prev;
            }
            y
        }

        let Some(model) = test_model() else { return };
        let Some(remote) = say_pcm("Samantha", "Hello team, let's review the quarterly launch plan and the release schedule for next month.")
        else {
            return;
        };
        let Some(you) = say_pcm("Daniel", "Sounds great. I will prepare the release notes tonight.")
        else {
            return;
        };

        let gap = |n: usize| vec![0.0f32; SAMPLE_RATE * n / 2];
        // Sys: the remote voice, then silence while the room answers.
        let mut sys = gap(1);
        sys.extend_from_slice(&remote);
        let sys_tail = sys.len();
        sys.extend(vec![0.0f32; SAMPLE_RATE * 8]);

        // Mic: the ROOM-DEGRADED bleed of the remote voice, then a real
        // person answering into the mic.
        let mut mic = gap(1);
        mic.extend(vec![0.0f32; 512]); // speaker→mic path, one frame late
        mic.extend(room(&remote, 0.35));
        mic.extend(vec![0.0f32; sys_tail.saturating_sub(mic.len()) + SAMPLE_RATE * 3 / 2]);
        mic.extend_from_slice(&you);
        mic.extend(gap(4));

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-degraded-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Meeting.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );
        let mut sys_chunks = sys.chunks(4000);
        let mut mic_chunks = mic.chunks(4000);
        loop {
            let (sc, mc) = (sys_chunks.next(), mic_chunks.next());
            if sc.is_none() && mc.is_none() {
                break;
            }
            for (source, chunk) in [(Source::Sys, sc), (Source::Mic, mc)] {
                if let Some(chunk) = chunk {
                    handle
                        .tx
                        .send(EngineMsg::Audio {
                            source,
                            rate: SAMPLE_RATE as u32,
                            samples: chunk.to_vec(),
                        })
                        .unwrap();
                }
            }
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .expect("engine never finished")
            .expect("engine reported an error");

        let shown: String = meta
            .segments
            .iter()
            .map(|s| format!("[{}-{}] {} ({}): {}\n", s.t0, s.t1, s.speaker, s.source, s.text))
            .collect();

        // The remote turn is transcribed ONCE, on the system lane.
        let remote_end = cs_of_samples(sys_tail);
        let mic_during_remote: Vec<_> = meta
            .segments
            .iter()
            .filter(|s| s.source == "mic" && s.t0 < remote_end)
            .collect();
        assert!(
            mic_during_remote.is_empty(),
            "the degraded speaker bleed produced mic rows during the remote turn:\n{shown}"
        );
        // No stock hallucination anywhere.
        assert!(
            !meta.segments.iter().any(|s| {
                let t = s.text.to_lowercase();
                t.contains("thank you") || t.contains("thanks for watching")
            }),
            "hallucinated text reached the transcript:\n{shown}"
        );
        // The real person in the room still gets heard.
        let all = meta
            .segments
            .iter()
            .filter(|s| s.source == "mic")
            .map(|s| s.text.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            all.contains("release notes"),
            "the real mic speaker was lost:\n{shown}"
        );

        drop(app);
        let _ = std::fs::remove_file(&room_path);
    }

    /// The live-STT toggle end-to-end: speech pushed while transcription is
    /// off leaves NO transcript (but the audio keeps growing), and speech
    /// after re-enabling is transcribed again.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_live_stt_toggle_gates_transcription_not_audio() {
        use tauri::Manager;

        let Some(model) = test_model() else { return };
        let Some(off_speech) = say_pcm("Samantha", "The quick brown fox jumps over the lazy dog.")
        else {
            return;
        };
        let Some(on_speech) =
            say_pcm("Samantha", "Hello team, let's review the quarterly launch plan.")
        else {
            return;
        };

        let room_path = std::env::temp_dir()
            .join(format!("pr-rec-stt-{}.roomai", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let conn = crate::db::create_room(&room_path, "qa", "QA").unwrap();
        let file = crate::db::insert_file(
            &conn, "Toggle.wav", "audio/wav", &encode_wav(&[]), Some("(live recording)\n"), "recording",
        )
        .unwrap();
        crate::db::set_rec_meta(&conn, &file.id, &serde_json::to_string(&RecMeta::default()).unwrap())
            .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = crate::commands::AppState::default();
        *state.room.lock().unwrap() = Some(crate::commands::Room {
            conn,
            path: room_path.clone(),
            name: "QA".into(),
            password: "qa".into(),
        });
        app.manage(state);

        let handle = start_engine(
            app.handle().clone(),
            EngineConfig {
                file_id: file.id.clone(),
                room_path: room_path.clone(),
                model_path: model,
                base_samples: Vec::new(),
                meta: RecMeta::default(),
                system_audio: false,
                live_translate: None,
            },
        );

        // Off: the phrase plays and closes (the trailing silence outlasts the
        // VAD hangover), so its drop happens entirely while STT is off.
        handle.tx.send(EngineMsg::SetLiveStt(false)).unwrap();
        let mut off_audio = vec![0.0f32; SAMPLE_RATE / 2];
        off_audio.extend_from_slice(&off_speech);
        off_audio.extend(vec![0.0f32; SAMPLE_RATE * 2]);
        for chunk in off_audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }

        // On again: a NEW phrase must be transcribed.
        handle.tx.send(EngineMsg::SetLiveStt(true)).unwrap();
        let mut on_audio = on_speech.clone();
        on_audio.extend(vec![0.0f32; SAMPLE_RATE * 2]);
        for chunk in on_audio.chunks(4000) {
            handle
                .tx
                .send(EngineMsg::Audio {
                    source: Source::Sys,
                    rate: SAMPLE_RATE as u32,
                    samples: chunk.to_vec(),
                })
                .unwrap();
        }
        let (done_tx, done_rx) = mpsc::channel();
        handle.tx.send(EngineMsg::Stop { done: done_tx }).unwrap();
        let meta = done_rx
            .recv_timeout(std::time::Duration::from_secs(180))
            .expect("engine never finished")
            .expect("engine reported an error");

        let all = meta
            .segments
            .iter()
            .map(|s| s.text.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            !all.contains("quick brown fox"),
            "speech was transcribed while live STT was off: {all}"
        );
        assert!(
            all.contains("launch plan"),
            "speech after re-enabling was not transcribed: {all}"
        );
        // The silent gap has no transcript, but the WAV kept growing.
        assert_eq!(
            meta.duration_cs,
            cs_of_samples(off_audio.len() + on_audio.len()),
            "audio must keep recording while live STT is off"
        );
        let _ = std::fs::remove_file(&room_path);
    }

    /// Re-transcribe rebuilds a ruined transcript from the audio alone: a
    /// two-voice conversation whose meta was corrupted must come back with
    /// both turns, ≥2 discovered speakers (none of them "You"), word timings,
    /// the duration preserved, and the old studio cuts passed through.
    /// `cargo test --lib recording -- --ignored`
    #[test]
    #[ignore = "runs the real Whisper model end-to-end"]
    fn e2e_retranscribe_rebuilds_a_corrupted_transcript() {
        let Some(model) = test_model() else { return };
        let turns = [
            ("Samantha", "Hello team, let's review the quarterly launch plan."),
            ("Daniel", "Sounds great. I will prepare the release notes tonight."),
        ];
        let mut audio: Vec<f32> = vec![0.0; SAMPLE_RATE / 2];
        for (voice, line) in turns {
            let Some(pcm) = say_pcm(voice, line) else { return };
            audio.extend_from_slice(&pcm);
            audio.extend(vec![0.0f32; SAMPLE_RATE * 3 / 2]); // gap closes the phrase
        }

        // The room file's old meta is ruined — corrupted words, wrong lane,
        // wrong language. Only its cuts and participant count may survive.
        let old = RecMeta {
            version: 1,
            duration_cs: cs_of_samples(audio.len()),
            segments: vec![RecSegment {
                id: "junk".into(),
                source: "mic".into(),
                speaker: "You".into(),
                t0: 0,
                t1: 50,
                text: "\u{fffd}\u{fffd}\u{fffd}".into(),
                words: vec![RecWord { w: "\u{fffd}".into(), t0: 0, t1: 50, del: false }],
                lang: Some("en".into()),
                voice: None,
            }],
            cuts: vec![RecCut { t0: 10, t1: 20 }],
            max_speakers: 0,
        };

        let mut ticks: Vec<(i64, i64)> = Vec::new();
        let meta = retranscribe(&model, &audio, old.cuts.clone(), old.max_speakers, |d, t| {
            ticks.push((d, t));
        });

        let shown = meta
            .segments
            .iter()
            .map(|s| format!("{}/{}: {}", s.source, s.speaker, s.text))
            .collect::<Vec<_>>()
            .join("\n");
        let all = shown.to_lowercase();
        assert!(all.contains("launch plan"), "missing turn 1:\n{shown}");
        assert!(all.contains("release notes"), "missing turn 2:\n{shown}");
        assert!(!shown.contains('\u{fffd}'), "old corrupted text survived:\n{shown}");

        let speakers: std::collections::BTreeSet<_> =
            meta.segments.iter().map(|s| s.speaker.as_str()).collect();
        assert!(speakers.len() >= 2, "two voices became {speakers:?}:\n{shown}");
        assert!(
            speakers.iter().all(|s| s.starts_with("Speaker ")),
            "the mixed file has no lane identity — nobody may become 'You': {speakers:?}"
        );
        assert!(meta.segments.iter().all(|s| s.source == "sys"), "{shown}");
        assert!(meta.segments.iter().any(|s| !s.words.is_empty()), "no word timings:\n{shown}");
        assert!(meta.segments.iter().all(|s| s.voice.is_some()), "voiceprints not kept");

        assert_eq!(meta.duration_cs, cs_of_samples(audio.len()), "duration must be preserved");
        assert_eq!(meta.cuts, old.cuts, "studio cuts must pass through");
        assert_eq!(meta.max_speakers, old.max_speakers);

        assert_eq!(ticks.last(), Some(&(meta.duration_cs, meta.duration_cs)));
        assert!(
            ticks.windows(2).all(|w| w[0].0 <= w[1].0 && w[0].1 == w[1].1),
            "progress must be monotone over a fixed total: {ticks:?}"
        );
    }

    #[test]
    fn transcript_skips_deleted_words() {
        let meta = RecMeta {
            segments: vec![RecSegment {
                id: "a".into(),
                source: "mic".into(),
                speaker: "You".into(),
                t0: 0,
                t1: 300,
                text: "hello cruel world".into(),
                words: vec![
                    RecWord { w: "hello".into(), t0: 0, t1: 80, del: false },
                    RecWord { w: "cruel".into(), t0: 80, t1: 200, del: true },
                    RecWord { w: "world".into(), t0: 200, t1: 300, del: false },
                ],
                lang: None,
                voice: None,
            }],
            ..Default::default()
        };
        let text = transcript_text(&meta);
        assert!(text.contains("[0:00] You: hello world"), "{text}");
        assert!(!text.contains("cruel"));
    }
}
