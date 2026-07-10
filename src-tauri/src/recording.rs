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
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::Emitter;

pub const SAMPLE_RATE: usize = 16_000;
/// VAD frame: 30 ms.
const FRAME: usize = 480;
/// Speech starts after this many consecutive voiced frames (150 ms)…
const START_FRAMES: u32 = 5;
/// …and ends after this many unvoiced ones (720 ms) — long enough that a
/// mid-sentence breath doesn't split a phrase.
const END_FRAMES: u32 = 24;
/// Pre-roll kept before the detected start, so the first syllable survives.
const PREROLL: usize = SAMPLE_RATE * 3 / 10;
/// A segment is force-closed at 15 s so partial feedback never lags far and
/// one Whisper call stays comfortably fast on Metal.
const MAX_SEGMENT: usize = SAMPLE_RATE * 15;
/// Re-decode the growing phrase for a live partial roughly this often.
const PARTIAL_EVERY: usize = SAMPLE_RATE * 3 / 2;
/// Auto-flush to the DB every N finished segments (crash safety); pause/stop
/// always flush.
const FLUSH_EVERY_SEGMENTS: usize = 8;
/// Re-cluster the meeting's voices every N new phrases (and on every flush /
/// pause / stop). Cheap — tens of 19-float vectors — and it is what lets a
/// speaker who was provisionally mislabeled get corrected on screen while the
/// conversation is still going.
const RELABEL_EVERY_SEGMENTS: usize = 2;
/// Hard session ceiling (3 h): the mixed timeline lives in memory while
/// recording (~230 MB/h of f32), so a forgotten recorder stops itself.
const MAX_SESSION_SAMPLES: usize = SAMPLE_RATE * 3 * 3600;

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

/// One capture lane (mic or system audio) with its own little energy VAD.
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
        }
    }

    /// Feed 16 kHz samples; returns any phrases that just closed as
    /// (absolute start sample, audio).
    fn push(&mut self, samples: &[f32]) -> Vec<(usize, Vec<f32>)> {
        let mut closed = Vec::new();
        self.carry.extend_from_slice(samples);
        let mut consumed = 0;
        while self.carry.len() - consumed >= FRAME {
            let frame: Vec<f32> = self.carry[consumed..consumed + FRAME].to_vec();
            consumed += FRAME;
            if let Some(done) = self.frame(&frame) {
                closed.push(done);
            }
        }
        self.carry.drain(..consumed);
        closed
    }

    fn frame(&mut self, frame: &[f32]) -> Option<(usize, Vec<f32>)> {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        self.level = rms.max(self.level * 0.75);
        // The threshold rides the noise floor: a quiet room triggers on soft
        // speech, a fan-heavy one doesn't trigger on the fan.
        let threshold = (self.floor * 3.0).max(0.006);
        let voiced = rms > threshold;
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
            LaneState::Active { start, buf, silent_frames, .. } => {
                buf.extend_from_slice(frame);
                *silent_frames = if voiced { 0 } else { *silent_frames + 1 };
                if *silent_frames >= END_FRAMES || buf.len() >= MAX_SEGMENT {
                    // Trim the silent tail (keep 0.2 s of it as padding).
                    let tail_keep = SAMPLE_RATE / 5;
                    let trim = (*silent_frames as usize * FRAME).saturating_sub(tail_keep);
                    let keep = buf.len().saturating_sub(trim);
                    let audio: Vec<f32> = buf[..keep].to_vec();
                    finished = Some((*start, audio));
                    self.state = LaneState::Idle;
                    self.voiced_run = 0;
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

    /// Close any open phrase unconditionally (pause/stop).
    fn flush_active(&mut self) -> Option<(usize, Vec<f32>)> {
        if let LaneState::Active { start, buf, .. } =
            std::mem::replace(&mut self.state, LaneState::Idle)
        {
            if buf.len() >= SAMPLE_RATE / 2 {
                return Some((start, buf));
            }
        }
        None
    }
}

// ---------------------------------------------------------------- engine

pub enum EngineMsg {
    Audio { source: Source, rate: u32, samples: Vec<f32> },
    /// The ScreenCaptureKit tap came up (or failed) on its helper thread.
    #[cfg(target_os = "macos")]
    SysTap(Result<sck::SysAudioTap, String>),
    SetLiveTranslate(Option<String>),
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
}

impl DecodeJob {
    fn final_job(source: Source, start: usize, samples: Vec<f32>) -> Self {
        Self { kind: JobKind::Final, source, start, samples }
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
    /// Voiceprint of the phrase (system lane only) for speaker clustering.
    emb: Option<diarize::VoicePrint>,
}

/// Cross-thread view of the live session for quick status reads.
pub struct RecShared {
    pub status: Mutex<String>,
    pub duration_cs: AtomicI64,
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

pub fn start_engine<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    cfg: EngineConfig,
) -> EngineHandle {
    let (tx, rx) = mpsc::channel::<EngineMsg>();
    let shared = Arc::new(RecShared {
        status: Mutex::new("recording".to_string()),
        duration_cs: AtomicI64::new(cs_of_samples(cfg.base_samples.len())),
    });

    // The decoder lane: one thread, one Whisper call at a time, results sent
    // back so the engine stays the single owner of ordering and state.
    let (job_tx, job_rx) = mpsc::channel::<DecodeJob>();
    {
        let engine_tx = tx.clone();
        let model = cfg.model_path.clone();
        std::thread::spawn(move || {
            for job in job_rx {
                let offset_cs = cs_of_samples(job.start);
                let segs = crate::stt::transcribe_segments(&model, &job.samples, offset_cs)
                    .unwrap_or_default();
                let emb = (job.source == Source::Sys && job.kind == JobKind::Final)
                    .then(|| diarize::embed(&job.samples));
                let _ = engine_tx.send(EngineMsg::DecodeDone(DecodeOut {
                    kind: job.kind,
                    source: job.source,
                    start: job.start,
                    n_samples: job.samples.len(),
                    segs,
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
    last_level_emit: std::time::Instant,
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
            last_level_emit: std::time::Instant::now(),
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
            EngineMsg::Pause => {
                self.paused = true;
                self.close_open_phrases();
                self.stop_sys_tap();
                self.flush(true);
                *self.shared.status.lock().unwrap() = "paused".into();
                self.emit_state();
            }
            EngineMsg::Resume => {
                self.paused = false;
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
            }
            EngineMsg::DecodeDone(out) => {
                self.decode_busy = false;
                self.integrate(out);
                self.dispatch_next();
            }
        }
        false
    }

    fn ingest(&mut self, source: Source, rate: u32, samples: &[f32]) {
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
        for (start, audio) in closed {
            self.queue_final(source, start, audio);
        }
        self.dispatch_next();
        self.shared
            .duration_cs
            .store(cs_of_samples(self.mixed.len()), Ordering::Relaxed);
    }

    fn tick(&mut self) {
        if self.paused || self.stopping.is_some() {
            return;
        }
        for source in [Source::Mic, Source::Sys] {
            let due = match source {
                Source::Mic => self.mic.partial_due(),
                Source::Sys => self.sys.partial_due(),
            };
            if let Some((start, samples)) = due {
                // Only the newest partial matters; a stale one is dropped
                // rather than queued behind finals.
                self.partial_pending = Some(DecodeJob { kind: JobKind::Partial, source, start, samples });
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
        if let Some(job) = job {
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
            if let Some((start, audio)) = flushed {
                self.queue_final(source, start, audio);
            } else {
                // Nothing left to say on this lane — clear any live ghost.
                self.drop_partial(source);
                self.emit_partial(source, 0, "");
            }
        }
        self.dispatch_next();
    }

    fn integrate(&mut self, out: DecodeOut) {
        match out.kind {
            JobKind::Partial => {
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
                // One VAD phrase → one transcript row: Whisper's sub-segments
                // are merged, keeping the words' own timestamps.
                let mut text = String::new();
                let mut words = Vec::new();
                let mut lang = None;
                for s in &out.segs {
                    if !s.text.trim().is_empty() {
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(s.text.trim());
                    }
                    words.extend(s.words.iter().map(|(w, a, b)| RecWord {
                        w: w.clone(),
                        t0: *a,
                        t1: *b,
                        del: false,
                    }));
                    lang = lang.or_else(|| s.lang.clone());
                }
                // Clear this lane's ghost line even when the phrase decoded
                // to nothing (breath, keyboard clatter).
                if text.trim().is_empty() {
                    self.emit_partial(out.source, cs_of_samples(out.start), "");
                    return;
                }
                let speaker = match out.source {
                    Source::Mic => "You".to_string(),
                    Source::Sys => self.book.assign(out.emb.as_ref()),
                };
                let seg = RecSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: out.source.as_str().into(),
                    speaker,
                    t0: cs_of_samples(out.start),
                    t1: cs_of_samples(out.start + out.n_samples),
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
                    self.flush(false);
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

    /// Persist audio + transcript + meta into the room. Auto-flushes skip the
    /// version snapshot — versioning every few seconds of a live recording
    /// would balloon the room; explicit edits still snapshot (recording_cmds).
    fn flush(&mut self, notify: bool) {
        use tauri::Manager;
        // The transcript about to be written must carry the best labels the
        // recording can support, not the provisional live ones.
        self.relabel_speakers();
        self.meta.duration_cs = cs_of_samples(self.mixed.len());
        let wav = encode_wav(&self.mixed);
        let text = transcript_text(&self.meta);
        let meta_json = serde_json::to_string(&self.meta).unwrap_or_default();
        let wrote = {
            let state = self.app.state::<crate::commands::AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                Some(room) if room.path == self.cfg.room_path => {
                    let _ = crate::db::update_file_content(&room.conn, &self.cfg.file_id, &wav, Some(&text));
                    let _ = crate::db::set_rec_meta(&room.conn, &self.cfg.file_id, &meta_json);
                    true
                }
                // The room closed/switched under a live recording: stop
                // quietly, nothing may be written into a locked room.
                _ => false,
            }
        };
        if !wrote {
            self.emit_error("The room closed — recording stopped.");
            if self.stopping.is_none() {
                self.stopping = Some(mpsc::channel().0);
            }
            return;
        }
        self.segments_since_flush = 0;
        if notify {
            let _ = self.app.emit("room-files-changed", ());
        }
    }

    fn finish(&mut self) {
        self.flush(true);
        *self.shared.status.lock().unwrap() = "saved".into();
        self.emit_state();
        if let Some(done) = self.stopping.take() {
            let _ = done.send(Ok(self.meta.clone()));
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

    fn emit_source(&self, source: &str, status: &str, message: &str) {
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
        if let Ok((out, _)) =
            crate::ollama::chat_stream_tools(&model, messages, None, Some(0.2), None, "5m", |_| {})
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
