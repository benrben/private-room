//! ADD-27: lightweight ON-LINE speaker separation for the meeting lane.
//!
//! The microphone lane is always "You" — that separation is structural and
//! free. Voices arriving through system audio (everyone else on a Meet/Zoom/
//! Teams call) — and colleagues sharing the microphone — are told apart by a
//! TitaNet-small neural speaker embedding: 192 dims, a 38 MB ONNX bundled
//! with the app like the Whisper weights, run by pure-Rust tract in ~150 ms
//! per phrase on the decode thread. Nothing to install, nothing downloaded.
//! The embedding lives behind this module boundary; the engine only ever
//! sees [`VoicePrint`]s. tract executes THIS model correctly (validated
//! bit-exact against onnxruntime, embedding cosine 1.000000) — a per-graph
//! finding, not a general one; see `titanet.rs` before touching either half.
//!
//! ## How phrases become voices (the production recipe)
//!
//! This follows what every shipping diarizer converged on (pyannote 3.x,
//! VBx/Kaldi, sherpa-onnx), scaled to on-device Rust:
//!
//! 1. **Fixed windows, not whole phrases.** A long phrase's embedding is the
//!    renormalized average of 2 s sub-window embeddings — variable-length
//!    single embeddings smear turns and scatter; every production system
//!    embeds fixed 1.5–3 s windows.
//! 2. **Session centering.** The shared channel (codec → loudspeaker → room
//!    → far mic) adds a common component to every embedding, which inflates
//!    all pairwise similarities and crushes their spread — the reason clean
//!    `say` calibrations fell apart on real Zoom audio, in both directions
//!    (everyone-is-one-voice AND six-speakers-for-two). Subtracting the
//!    session mean (shrunk toward zero on small sessions, where the mean is
//!    itself noise) removes that channel before anything is compared.
//! 3. **One fixed merge bar, centroid linkage.** Agglomerative merging with
//!    a constant calibrated per embedding SPACE — the pyannote/VBx/sherpa
//!    approach. The old per-recording histogram cut (Otsu) is gone: it
//!    presumes a bimodal similarity histogram, and a real meeting's short
//!    noisy phrases smear it unimodal, which is exactly when it mis-cut.
//! 4. **Minimum cluster mass.** A voice that never accumulated ≥ 2 phrases
//!    or ≥ 5 s of speech is not reported; its phrases are absorbed by the
//!    nearest surviving voice (pyannote's `min_cluster_size`). This is the
//!    direct killer of phantom speakers.
//! 5. **Turn continuity.** A Viterbi pass over the time-ordered phrases with
//!    a gap-dependent stay-probability (adjacent phrases < 1 s apart are
//!    usually the same person; distant ones carry no prior) — the cheap
//!    stand-in for VBx's sticky HMM resegmentation.
//!
//! Short phrases still never define a voice ([`VoicePrint::is_strong`]): a
//! sub-second far-mic embedding runs near-coin-flip error rates, so a
//! one-word reply joins the nearest known voice instead of inventing a
//! participant.
//!
//! ## The DSP fallback, and files holding both print generations
//!
//! The previous hand-rolled voiceprint (mean log-mel band deltas + two pitch
//! dims, 19/21 dims — see [`dsp_embed`]) is kept as the silent fallback: if
//! the model file is missing or inference fails, [`embed`] returns the DSP
//! print and recording simply continues. A missing model must never break a
//! recording. Old files hold DSP prints; new phrases append neural ones. The
//! generations share no geometry, so they are never compared: [`cosine`]
//! refuses to mix them, and `lane_voices` clusters only the newest
//! generation present in a lane, leaving other-generation phrases' labels
//! untouched exactly like legacy rows that carry no print at all.
//!
//! Labels improve as the conversation grows — the engine re-clusters every
//! couple of phrases and tells the UI, which is what makes speakers "sort
//! themselves out" while people are still talking, with nobody ever asked
//! how many are in the room.
//!
//! ## Voices the room already knows (cross-recording recognition)
//!
//! Everything above tells voices apart WITHIN one recording. Naming a speaker
//! also saves that voice ([`identity_print`]), so the next recording can put
//! the name back on them instead of starting again at "Speaker 2". The saved
//! print is compared RAW — a stored centroid comes from another day, another
//! microphone and another room, so there is no shared session channel to
//! subtract — and against a bar ([`KNOWN_SAME`]) deliberately above the
//! within-session same-voice invariant: inside a recording a wrong merge is
//! corrected by the next pass, while a wrong name is a real person's name on
//! somebody else's words with nothing downstream to catch it. A voice that
//! matches nobody stays "Speaker N", which is the honest answer.

mod fbank;
mod titanet;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::{RecSegment, RecWord, SAMPLE_RATE};

/// The bundled TitaNet-small speaker-embedding model.
pub const MODEL_FILE: &str = "nemo_en_titanet_small.onnx";

/// Where the engine found the model (a user copy in the app-data models dir
/// wins over the bundled resource, same rule as the Whisper weights). Unset —
/// dev runs and unit tests — falls back to the repo's resources dir.
static MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn set_model_path(path: PathBuf) {
    let _ = MODEL_PATH.set(path);
}

fn model_path() -> PathBuf {
    MODEL_PATH.get().cloned().unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models").join(MODEL_FILE)
    })
}

/// Analysis window for the DSP voiceprint (32 ms) and its hop (16 ms). The
/// hop also defines the unit of [`VoicePrint::voiced_frames`] for BOTH print
/// generations — the evidence gate must not move when the embedding does.
const WIN: usize = 512;
const HOP: usize = 256;
/// Mel-spaced bands between 100 Hz and 4 kHz — where voices differ.
const BANDS: usize = 20;
/// Frames quieter than this contribute nothing (pauses must not dilute a print).
const VOICED_RMS: f32 = 0.004;

// Pitch dims of the DSP fallback print. The F0 search runs over 60–400 Hz;
// the phrase statistic is then clamped to 70–320 Hz — where speech actually
// lives — before encoding.
const F0_MIN_LAG: usize = SAMPLE_RATE / 400;
const F0_MAX_LAG: usize = SAMPLE_RATE / 60;
const F0_CLAMP: (f32, f32) = (70.0, 320.0);
/// A frame's normalized autocorrelation peak must reach this to count as
/// pitched — the shared mic's noise floor stays below it, breathy speech too.
const PITCH_MIN_CORR: f32 = 0.6;
/// Log2-F0 becomes an angle at this many radians per octave, appended as
/// (cos, sin). Steep enough that a few semitones between two speakers scores
/// clearly unlike (~0.6 octave → cos ≈ 0.36) while one speaker's own pitch
/// wobble stays alike (0.15 octave → cos ≈ 0.95). The clamp above keeps the
/// whole arc short of wrapping back to +1.
const PITCH_RAD_PER_OCTAVE: f32 = 2.0;
/// Norm of the two pitch dims relative to the unit-norm band deltas: pitch
/// carries w²/(1+w²) ≈ 26% of the cosine — enough to reopen the shared-mic
/// split, not enough to let a pitch wobble break a monologue apart.
const PITCH_WEIGHT: f32 = 0.6;
/// Pitched frames for the pitch dims to carry full weight (~0.3 s); below
/// that they fade out linearly rather than assert a pitch from a hiss.
const MIN_PITCHED_FRAMES: usize = 20;
/// Voiced frames (16 ms hop) a phrase must carry before it can define a voice
/// — about 1 s of actual speech (sub-second far-field embeddings run near
/// coin-flip error rates). A one-word reply ("Perfect.") has too little
/// evidence to trust: it joins the nearest known voice instead of inventing
/// a participant who was never in the room.
const MIN_NEW_VOICE_FRAMES: usize = 62;

/// Voiced frames before a LIVE phrase may open a brand-new speaker (~2.5 s).
/// diart-style: creation is the costliest online mistake (a phantom is on
/// screen until the next re-cluster), so it takes far more evidence than
/// attachment. [`cluster`] still discovers new voices from shorter (≥ 1 s)
/// phrases at every re-cluster.
const MIN_OPEN_FRAMES: usize = 156;

/// Voiced frames before a live phrase may UPDATE a centroid (~1.5 s) — noisy
/// short evidence must never drag an established voice (diart's rho_update).
const MIN_UPDATE_FRAMES: usize = 94;

/// A voice below BOTH bars after clustering is a phantom: fewer phrases than
/// this…
const MIN_CLUSTER_PHRASES: usize = 2;
/// …and less cumulative voiced speech than this (16 ms frames, ≈ 5 s) — it
/// is absorbed into the nearest surviving voice instead of being reported
/// (pyannote's `min_cluster_size`, scaled to phrase units).
const MIN_CLUSTER_FRAMES: usize = 312;

/// Safety ceiling when the participant count is discovered rather than given
/// (the normal case). Far above a real meeting's distinct voices, so it only
/// ever stops pathological runaway labeling.
const AUTO_MAX_SPEAKERS: usize = 8;

// ---- The sub-window split pass (ADD-28) -----------------------------------
// A phrase is cut at SILENCES, so when someone answers without a pause both
// voices land in ONE phrase — and a phrase carries one label. Measured on
// AMI (2026-08-01): 60% of reference speech sat inside phrases holding two
// or more speakers; no per-phrase labeling can recover that. The split pass
// re-cuts each phrase into fixed sub-windows, clusters THOSE, and breaks the
// phrase wherever consecutive words disagree on the voice.

/// Sub-window size and hop, centiseconds (1.5 s / 0.75 s — the granularity
/// production diarizers embed at; shorter windows measured near-coin-flip).
const SPLIT_WIN_CS: i64 = 150;
const SPLIT_HOP_CS: i64 = 75;

/// Voiced frames (16 ms) a SUB-WINDOW needs to help define a voice (~0.3 s).
/// The phrase gate (~1 s) is unreachable inside a 1.5 s window — under it
/// every window is weak and whole meetings collapse to one voice (measured:
/// 39 of 39 test windows at 1 speaker). This gate exists ONLY for the split
/// pass; phrases keep [`MIN_NEW_VOICE_FRAMES`].
const SPLIT_MIN_VOICE_FRAMES: usize = 20;

/// A COUNT-driven merge must still clear this centered-space similarity.
/// The eigengap count is an estimate, not evidence: unguarded, a Count(1)
/// verdict fused 57 audibly distinct windows without a single voice
/// comparison, and erased real 4th speakers from full meetings. 0.07 sits on
/// the measured plateau (0.07–0.08) where every held-out meeting keeps its
/// true speaker count and nothing over-splits.
const COUNT_FLOOR: f32 = 0.07;

/// The clustering constants of an embedding SPACE: where its same-speaker
/// mass sits once the session channel has been removed. Each print
/// generation carries its own set — one code path, two calibrations.
struct Gates {
    /// The merge bar for SMALL sessions (fewer than 6 voice-defining
    /// phrases), where the eigengap count has nothing to read. Calibrated
    /// high — just under the space's same-voice cohesion floor — because a
    /// too-high bar shatters (recoverable: absorption and the continuity
    /// pass reunite), while a too-low bar merges two people (irreversible).
    split: f32,
    /// Whether [`cluster`] compares in the session-centered space. The
    /// neural space is; the DSP fallback's geometry was only ever measured
    /// raw, and as a missing-model emergency it isn't worth recalibrating.
    center: bool,
    /// The RAW-space same-voice invariant: two clusters whose uncentered
    /// centroids agree this strongly are one person through ANY measured
    /// channel — the collapse pass that protects a solo speaker from the
    /// degenerate centered space a tiny session produces (centering a
    /// session that IS one voice leaves only noise, and the eigengap reads
    /// groups into noise).
    raw_same: f32,
    /// Live label: a phrase attaches to the nearest running centroid at or
    /// above this (raw, uncentered space — live labels are provisional and
    /// corrected by [`cluster`] on the next flush).
    online_same: f32,
    /// Live label: a NEW voice may open only when the phrase is below this
    /// against EVERY known centroid (and long, `MIN_OPEN_FRAMES`).
    online_new: f32,
}

/// The legacy DSP space (fallback when the TitaNet model is missing). Raw
/// clean-audio anchors: one voice's pairs measured 0.86–0.94, different
/// voices 0.30–0.57 — the bar sits in the valley. (Through a heavy device
/// channel this space over-splits; the neural model is the real path.)
const DSP_GATES: Gates =
    Gates { split: 0.65, center: false, raw_same: 0.85, online_same: 0.35, online_new: 0.10 };

/// The TitaNet space, measured in the centered space on real meeting audio
/// (AMI far-field, ground-truth speakers) and the clean/room/far-mic `say`
/// fixtures: the small-session bar sits between the worst same-text
/// cross-voice centroid (+0.33) and every regime's same-voice floor
/// (≥ +0.396).
const NEURAL_GATES: Gates =
    Gates { split: 0.36, center: true, raw_same: 0.69, online_same: 0.40, online_new: 0.20 };

/// Which embedding space a print lives in. The generations share no geometry
/// — a similarity across them is meaningless — so every comparison in this
/// module is gated on this.
fn neural(v: &[f32]) -> bool {
    v.len() == titanet::EMB_DIM
}

fn gates(v: &[f32]) -> &'static Gates {
    if neural(v) {
        &NEURAL_GATES
    } else {
        &DSP_GATES
    }
}

// ---- Cross-recording recognition -----------------------------------------
//
// Deliberately NOT a field of [`Gates`]. A saved voice only ever exists in the
// neural space (see [`identity_print`]), so there is no second calibration to
// carry — and one threshold that cannot be reached from the DSP path states
// that wall better than a DSP number nobody measured.

/// A saved voice is put on a group only when their RAW centroids agree at
/// least this strongly.
///
/// Anchored on [`NEURAL_GATES`]`.raw_same` (0.69) — the measured "one person
/// through ANY channel" invariant, which is exactly the question being asked
/// across recordings — and then raised. Within a session, `raw_same` guards a
/// merge that the next re-cluster re-derives from scratch; nothing re-derives
/// a name from last week. The cost of the two mistakes is not symmetric, so
/// neither is the bar.
///
/// Public so `tests/diar_bench.rs::voice_id_threshold_sweep` sweeps the bar
/// the app actually ships, rather than a copy of it free to drift away.
pub const KNOWN_SAME: f32 = 0.72;

/// How far the best saved voice must beat the runner-up. Two saved voices
/// this close to one group are not two candidates, they are one unanswered
/// question — and "Speaker 2" is the honest answer to it. Also how far a
/// candidate must beat the counter-example the user corrected it with (see
/// [`vetoed`]).
const KNOWN_MARGIN: f32 = 0.04;

/// Total voiced evidence (16 ms frames, ≈ 2.5 s) a voice needs before it can
/// be saved or recognised across recordings — the same bar [`SpeakerBook`]
/// demands to open a new voice live, which is the highest evidence bar in this
/// module. Inside a recording a thin voice is corrected by the next pass;
/// across recordings nothing corrects it.
const MIN_IDENTITY_FRAMES: usize = MIN_OPEN_FRAMES;

/// A voice the room has already been told the name of.
///
/// Held in memory for the length of a recording (the room's table is read
/// once, at start), so recognition costs one dot product per group per pass.
#[derive(Clone, Debug, Default)]
pub struct KnownVoice {
    /// What the user calls this person.
    pub name: String,
    /// Their saved centroid — L2-normalized, neural, and comparable raw.
    pub vec: Vec<f32>,
    /// Voices the user has said are NOT this person: each is the centroid of
    /// a group this name was guessed onto and then corrected. Without them a
    /// wrong match is wrong again in every future recording, because the
    /// correction only ever taught the OTHER name.
    pub rejects: Vec<Vec<f32>>,
}

/// The one print that stands for a voice across recordings: the renormalized
/// mean of every strong print in `prints`.
///
/// Neural prints ONLY, and deliberately so — this is the single print that
/// outlives its recording, and the DSP fallback space shares no geometry with
/// the neural one, so a saved DSP centroid could only ever be compared against
/// something it may not be compared against. A room recorded without the model
/// saves nobody, rather than saving something meaningless.
///
/// `None` when the voice has not been heard for [`MIN_IDENTITY_FRAMES`] of
/// real speech across those prints: a name typed on half a sentence is a fine
/// label for that recording and far too little to recognise anyone by later.
pub fn identity_print(prints: &[&VoicePrint]) -> Option<VoicePrint> {
    let strong: Vec<&VoicePrint> =
        prints.iter().copied().filter(|p| neural(&p.vec) && p.is_strong()).collect();
    let dim = strong.first()?.vec.len();
    let frames: usize = strong.iter().map(|p| p.voiced_frames).sum();
    if frames < MIN_IDENTITY_FRAMES {
        return None;
    }
    let mut mean = vec![0.0f32; dim];
    for p in &strong {
        for (a, b) in mean.iter_mut().zip(&p.vec) {
            *a += b;
        }
    }
    let norm = mean.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < 1e-6 {
        return None; // prints that cancel out define nothing
    }
    mean.iter_mut().for_each(|x| *x /= norm);
    Some(VoicePrint { vec: mean, voiced_frames: frames })
}

/// Put saved voices onto this recording's groups — one name per group, one
/// group per name.
///
/// `centroids[i]` is group i's [`identity_print`] (`None` when the group has
/// too little neural evidence to be recognised at all). `blocked` names are
/// already spoken for by the USER on some other group, and a name the user
/// typed is not a candidate — it is already the answer.
///
/// Greedy best-first over every admissible (group, name) pair, so the
/// strongest agreement in the room is settled first: two people who each sound
/// a little like one saved voice cannot claim it by accident of iteration
/// order. A group whose top two candidates sit within [`KNOWN_MARGIN`] of each
/// other is named by nobody — an ambiguous identity is not an identity.
/// What cross-recording recognition actually compares: the raw similarity of
/// two saved voices, on the same terms [`recognize_groups`] judges them.
/// `None` when the prints are not comparable at all.
///
/// Public for the acceptance bench, which has to measure the very quantity the
/// threshold is set against — a bench that re-implemented the comparison would
/// be certifying its own copy of it.
pub fn raw_similarity(a: &VoicePrint, b: &VoicePrint) -> Option<f32> {
    (neural(&a.vec) && neural(&b.vec) && a.vec.len() == b.vec.len())
        .then(|| cosine(&a.vec, &b.vec))
}

/// Has the user already looked at this voice under this name and said no?
///
/// The test is DISCRIMINATIVE — closer to the counter-example than to the
/// person — rather than "close to the counter-example at all". The two voices
/// a user had to tell apart are, by the nature of the mistake, similar to each
/// other: a flat "anywhere near the thing you rejected" veto would take Dana's
/// own voice down with the impostor's and she would never be recognised
/// again. Correcting one guess must cost exactly that guess.
fn vetoed(c: &VoicePrint, k: &KnownVoice, sim: f32) -> bool {
    k.rejects
        .iter()
        .filter(|r| r.len() == c.vec.len())
        .any(|r| cosine(&c.vec, r) + KNOWN_MARGIN >= sim)
}

pub fn recognize_groups(
    centroids: &[Option<VoicePrint>],
    known: &[KnownVoice],
    blocked: &[String],
) -> Vec<Option<String>> {
    let mut out = vec![None; centroids.len()];
    let mut pairs: Vec<(f32, usize, usize)> = Vec::new();
    for (g, centroid) in centroids.iter().enumerate() {
        let Some(c) = centroid.as_ref().filter(|c| neural(&c.vec)) else { continue };
        let mut scored: Vec<(f32, usize)> = known
            .iter()
            .enumerate()
            .filter(|(_, k)| k.vec.len() == c.vec.len() && neural(&k.vec))
            .filter(|(_, k)| !blocked.iter().any(|b| *b == k.name))
            .map(|(i, k)| (cosine(&c.vec, &k.vec), i))
            .filter(|(sim, _)| *sim >= KNOWN_SAME)
            .filter(|(sim, i)| !vetoed(c, &known[*i], *sim))
            .collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let Some(&(sim, best)) = scored.first() else { continue };
        if scored.get(1).is_some_and(|(next, _)| sim - next < KNOWN_MARGIN) {
            continue; // two people it could be — so it is neither
        }
        pairs.push((sim, g, best));
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut used: BTreeSet<usize> = BTreeSet::new();
    for (_, g, k) in pairs {
        if out[g].is_none() && used.insert(k) {
            out[g] = Some(known[k].name.clone());
        }
    }
    out
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

/// Band-center frequencies, mel-spaced.
fn band_centers() -> [f32; BANDS] {
    let (lo, hi) = (hz_to_mel(100.0), hz_to_mel(4000.0));
    let mut out = [0f32; BANDS];
    for (i, c) in out.iter_mut().enumerate() {
        let mel = lo + (hi - lo) * (i as f32 + 0.5) / BANDS as f32;
        *c = mel_to_hz(mel);
    }
    out
}

/// Single-bin DFT magnitude at `freq` over a Hann-windowed frame — 20 bins ×
/// a few dozen frames per phrase is trivially cheap, so no FFT dep is needed.
fn bin_energy(frame: &[f32], freq: f32) -> f32 {
    let n = frame.len() as f32;
    let w = std::f32::consts::TAU * freq / SAMPLE_RATE as f32;
    let (mut re, mut im) = (0f32, 0f32);
    for (i, s) in frame.iter().enumerate() {
        // Hann window keeps neighboring voices' bands from smearing together.
        let hann = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n).cos();
        let x = s * hann;
        let phase = w * i as f32;
        re += x * phase.cos();
        im -= x * phase.sin();
    }
    (re * re + im * im) / n
}

/// Confident F0 of one frame, by normalized autocorrelation over the 60–400 Hz
/// lag range on the raw (unwindowed) frame. `None` for unpitched frames —
/// noise, fricatives, the room's hum. Among near-tied peaks the shortest lag
/// wins, which corrects the classic octave-down error.
fn frame_f0(frame: &[f32]) -> Option<f32> {
    let n = frame.len();
    let mean = frame.iter().sum::<f32>() / n as f32;
    let x: Vec<f32> = frame.iter().map(|s| s - mean).collect();
    // Prefix sums make each lag's two energy terms O(1); only the dot is O(n).
    let mut sq = vec![0f32; n + 1];
    for i in 0..n {
        sq[i + 1] = sq[i] + x[i] * x[i];
    }
    let hi = F0_MAX_LAG.min(n - 1);
    let mut rs = vec![0f32; hi + 1];
    let (mut best_r, mut best_lag) = (0f32, 0usize);
    for lag in F0_MIN_LAG..=hi {
        let m = n - lag;
        let mut dot = 0f32;
        for i in 0..m {
            dot += x[i] * x[i + lag];
        }
        let r = dot / (sq[m] * (sq[n] - sq[lag])).sqrt().max(1e-9);
        rs[lag] = r;
        if r > best_r {
            best_r = r;
            best_lag = lag;
        }
    }
    if best_r < PITCH_MIN_CORR {
        return None;
    }
    let lag = (F0_MIN_LAG..best_lag).find(|l| rs[*l] >= 0.87 * best_r).unwrap_or(best_lag);
    Some(SAMPLE_RATE as f32 / lag as f32)
}

/// The 2 pitch dims: the phrase's lower-quartile F0 as a point on an arc (so
/// cosine compares pitch by angular distance), scaled by [`PITCH_WEIGHT`] and
/// faded by how much confidently-pitched speech backs it. The lower quartile,
/// not the median: a speaker's pitch FLOOR is a trait, while the middle of
/// the range moves with prosody (Fred's median slid 123 → 105 Hz between two
/// sentences; his lower quartile 110 → 99; every other voice's quartile held
/// within 5%). The bottom decile dips into creak, so the quartile it is.
fn pitch_dims(f0s: &mut Vec<f32>) -> [f32; 2] {
    if f0s.is_empty() {
        return [0.0, 0.0];
    }
    f0s.sort_by(f32::total_cmp);
    let floor = f0s[f0s.len() / 4].clamp(F0_CLAMP.0, F0_CLAMP.1);
    let theta = PITCH_RAD_PER_OCTAVE * (floor / F0_CLAMP.0).log2();
    let pitch_confidence = PITCH_WEIGHT * (f0s.len() as f32 / MIN_PITCHED_FRAMES as f32).min(1.0);
    [pitch_confidence * theta.cos(), pitch_confidence * theta.sin()]
}

/// One phrase's voiceprint plus how much real speech went into it — the
/// vector alone can't say whether it is trustworthy. Stored with its segment
/// so the whole recording can be re-clustered later (including after a
/// pause/resume, or when an old file is reopened).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoicePrint {
    /// L2-normalized, so cosine similarity is a plain dot product. 192 dims
    /// for a TitaNet print; 19 or 21 dims for the DSP prints in older files
    /// (and in fallback prints when the model is unavailable) — [`cosine`]
    /// never compares across that divide. All zeros when the phrase held no
    /// voiced audio at all.
    #[serde(rename = "v")]
    pub vec: Vec<f32>,
    #[serde(rename = "f")]
    pub voiced_frames: usize,
}

impl VoicePrint {
    pub fn is_silent(&self) -> bool {
        self.voiced_frames == 0 || self.vec.iter().all(|x| *x == 0.0)
    }

    /// Enough speech to define a voice rather than merely be labeled with one,
    /// at a caller-chosen evidence scale: whole phrases use
    /// [`MIN_NEW_VOICE_FRAMES`], the split pass's 1.5 s sub-windows use
    /// [`SPLIT_MIN_VOICE_FRAMES`]. THE rule — `cluster_gated` calls this, so
    /// the app and the tests can never be measuring different things.
    pub fn defines_voice(&self, min_frames: usize) -> bool {
        self.voiced_frames >= min_frames && !self.is_silent()
    }

    /// [`Self::defines_voice`] at the phrase scale.
    pub fn is_strong(&self) -> bool {
        self.defines_voice(MIN_NEW_VOICE_FRAMES)
    }
}

/// Voiced 32 ms/16 ms frames in the phrase — the evidence measure behind
/// [`VoicePrint::is_strong`], computed the same way for both generations.
fn count_voiced(samples: &[f32]) -> usize {
    let mut frames = 0usize;
    let mut pos = 0;
    while pos + WIN <= samples.len() {
        let frame = &samples[pos..pos + WIN];
        pos += HOP;
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / WIN as f32).sqrt();
        if rms >= VOICED_RMS {
            frames += 1;
        }
    }
    frames
}

/// The phrase's voiceprint: a TitaNet embedding when the bundled model is
/// available, else the DSP print — silently, because a missing model must
/// never break a recording. Silence embeds to all-zeros, which
/// [`SpeakerBook::assign`] treats as unknown.
pub fn embed(samples: &[f32]) -> VoicePrint {
    embed_at(&model_path(), samples)
}

/// Sub-window for long phrases (2 s, 1 s hop): production diarizers embed
/// fixed 1.5–3 s windows, never whole variable-length phrases — a 15 s
/// phrase's single embedding smears everything it contains, while short
/// fixed windows keep the voice's timbre crisp and are what the model was
/// trained on.
const EMB_WIN: usize = SAMPLE_RATE * 2;
const EMB_HOP: usize = SAMPLE_RATE;

fn embed_at(model: &Path, samples: &[f32]) -> VoicePrint {
    let voiced_frames = count_voiced(samples);
    if voiced_frames == 0 {
        return VoicePrint { vec: vec![0.0; BANDS + 1], voiced_frames: 0 };
    }
    match neural_embed(model, samples) {
        Some(vec) => VoicePrint { vec, voiced_frames },
        None => dsp_embed(samples),
    }
}

/// One neural print for the phrase: the renormalized average of its 2 s
/// window embeddings (windows that are mostly silence are skipped — they
/// embed the room, not the person), or a single whole-phrase embedding when
/// the phrase is short.
fn neural_embed(model: &Path, samples: &[f32]) -> Option<Vec<f32>> {
    if samples.len() <= EMB_WIN + EMB_HOP / 2 {
        return titanet::embed(model, samples);
    }
    let mut acc = vec![0f32; titanet::EMB_DIM];
    let mut n = 0usize;
    let mut pos = 0;
    while pos < samples.len() {
        let end = (pos + EMB_WIN).min(samples.len());
        let win = &samples[pos..end];
        let voiced_enough = count_voiced(win) * HOP >= win.len() / 4;
        if win.len() >= EMB_WIN / 2 && voiced_enough {
            if let Some(e) = titanet::embed(model, win) {
                for (a, b) in acc.iter_mut().zip(&e) {
                    *a += b;
                }
                n += 1;
            }
        }
        if end == samples.len() {
            break;
        }
        pos += EMB_HOP;
    }
    if n == 0 {
        return titanet::embed(model, samples);
    }
    let norm = acc.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
    acc.iter_mut().for_each(|v| *v /= norm);
    Some(acc)
}

/// The fallback DSP voiceprint: band-to-band deltas of the mean log-mel
/// envelope (differencing removes overall loudness and constant spectral
/// tilt, leaving formant shape), then two pitch dims (the phrase's F0 floor
/// on an arc — what reopens the shared-mic split when a common room channel
/// inflates two voices' band-delta similarity; see [`pitch_dims`]).
fn dsp_embed(samples: &[f32]) -> VoicePrint {
    let centers = band_centers();
    let mut means = [0f32; BANDS];
    let mut frames = 0usize;
    let mut f0s = Vec::new();
    let mut pos = 0;
    while pos + WIN <= samples.len() {
        let frame = &samples[pos..pos + WIN];
        pos += HOP;
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / WIN as f32).sqrt();
        if rms < VOICED_RMS {
            continue;
        }
        frames += 1;
        for (b, c) in centers.iter().enumerate() {
            means[b] += (bin_energy(frame, *c) + 1e-9).ln();
        }
        f0s.extend(frame_f0(frame));
    }
    if frames == 0 {
        return VoicePrint { vec: vec![0.0; BANDS + 1], voiced_frames: 0 };
    }
    let nf = frames as f32;
    let env: Vec<f32> = means.iter().map(|m| m / nf).collect();
    let mut v: Vec<f32> = (0..BANDS - 1).map(|i| env[i + 1] - env[i]).collect();
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x /= norm);
    // Band deltas at unit norm, pitch at PITCH_WEIGHT, then the whole vector
    // renormalized so cosine stays a plain dot product.
    v.extend(pitch_dims(&mut f0s));
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x /= norm);
    VoicePrint { vec: v, voiced_frames: frames }
}

/// Plain dot product between same-generation prints (both unit-norm).
/// Across GENERATIONS (neural vs DSP) there is no shared geometry at all, so
/// the answer is a hard 0 — maximally unlike, never merged. Within the DSP
/// generation, a print loaded from a file saved before the pitch dims is 2
/// short; against one the comparison falls back to the shared band-delta
/// prefix, renormalized so an old/new pair of the same voice scores like an
/// old/old pair — resumed recordings lose nothing but the pitch help.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if neural(a) != neural(b) {
        return 0.0;
    }
    if a.len() == b.len() {
        return a.iter().zip(b).map(|(x, y)| x * y).sum();
    }
    let n = a.len().min(b.len());
    let dot: f32 = a[..n].iter().zip(&b[..n]).map(|(x, y)| x * y).sum();
    let na: f32 = a[..n].iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b[..n].iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (na * nb).max(1e-6)
}

// ------------------------------------------------------- global clustering

/// Session centering (the cheap 80% of Kaldi's conversation-dependent PCA /
/// VBx's center+whiten): subtract the mean of the session's prints from each
/// print and renormalize. Every phrase in a session shares one channel —
/// codec, loudspeaker, room, mic distance — which adds a common component to
/// every embedding, inflating all pairwise similarities and crushing the
/// spread between voices. That is why constants calibrated on clean audio
/// failed on real Zoom meetings in both directions (all-merged-to-one AND
/// six-speakers-for-two). The mean is SHRUNK toward zero on small sessions
/// (λ = N/(N+3)): with a handful of prints the mean is mostly those voices
/// themselves, and subtracting it whole would erase the very geometry being
/// read (at N=2 it maps any pair to exact opposites).
fn center_prints(vecs: &[&[f32]]) -> Vec<Vec<f32>> {
    let n = vecs.len();
    let dim = vecs.first().map_or(0, |v| v.len());
    if n < 2 || vecs.iter().any(|v| v.len() != dim) {
        return vecs.iter().map(|v| v.to_vec()).collect();
    }
    let mut mean = vec![0f32; dim];
    for v in vecs {
        for (m, x) in mean.iter_mut().zip(*v) {
            *m += x;
        }
    }
    let shrink = n as f32 / (n as f32 + 3.0);
    for m in &mut mean {
        *m = *m / n as f32 * shrink;
    }
    vecs.iter()
        .map(|v| {
            let mut c: Vec<f32> = v.iter().zip(&mean).map(|(a, b)| a - b).collect();
            let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm < 1e-4 {
                return v.to_vec(); // a print AT the mean: centering says nothing
            }
            c.iter_mut().for_each(|x| *x /= norm);
            c
        })
        .collect()
}

/// Otsu's method over sorted pairwise similarities: the split index `k` (in
/// `1..sims.len()`) that maximizes between-class variance. `sims` must already
/// be sorted ascending.
fn otsu_split(sims: &[f32]) -> usize {
    let n = sims.len();
    let total: f32 = sims.iter().sum();
    let (mut best_score, mut best_k) = (f32::MIN, 1usize);
    let mut low_sum = 0.0f32;
    for k in 1..n {
        low_sum += sims[k - 1];
        let (weight_low, weight_high) = (k as f32 / n as f32, (n - k) as f32 / n as f32);
        let low_class_mean = low_sum / k as f32;
        let high_class_mean = (total - low_sum) / (n - k) as f32;
        let score = weight_low * weight_high * (high_class_mean - low_class_mean).powi(2);
        if score > best_score {
            best_score = score;
            best_k = k;
        }
    }
    best_k
}

/// The legacy DSP space's session threshold — the pre-neural rule, kept
/// verbatim for the fallback because that space has NO absolute operating
/// point (clean cross-voice pairs reach 0.57 while device same-voice pairs
/// fall to 0.43): Otsu over the pairwise similarities, believed only when
/// the distribution genuinely breaks (gap ≥ 0.15, cut ≤ 0.80); a lone pair
/// splits below 0.30; no readable valley → one voice.
fn dsp_split_threshold(mut sims: Vec<f32>) -> Option<f32> {
    match sims.len() {
        0 => return None,
        1 => return (sims[0] < 0.30).then_some(0.30),
        _ => {}
    }
    sims.sort_by(f32::total_cmp);
    let best_k = otsu_split(&sims);
    let cut = (sims[best_k - 1] + sims[best_k]) / 2.0;
    let gap = sims[best_k] - sims[best_k - 1];
    if gap < 0.15 || cut > 0.80 {
        return None; // one voice, however varied its sentences
    }
    Some(cut)
}

/// Eigenvalues of a small symmetric matrix (cyclic Jacobi). The affinity
/// graphs this sees stay small (voice-defining phrases only, capped by the
/// caller), so a dependency-free O(n³) solver is plenty.
fn sym_eigenvalues(mut a: Vec<Vec<f32>>) -> Vec<f32> {
    let n = a.len();
    for _sweep in 0..12 {
        let mut off = 0f32;
        for i in 0..n {
            for j in i + 1..n {
                off += a[i][j] * a[i][j];
            }
        }
        if off < 1e-9 {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                if a[p][q].abs() < 1e-12 {
                    continue;
                }
                let theta = 0.5 * (a[q][q] - a[p][p]) / a[p][q];
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
            }
        }
    }
    let mut ev: Vec<f32> = (0..n).map(|i| a[i][i]).collect();
    ev.sort_by(f32::total_cmp);
    ev
}

/// How many voices the session's affinity structure holds (NeMo's NME-SC
/// idea, sized down): binarize each print's strongest links, and read the
/// count from the graph Laplacian's eigengap — near-zero eigenvalues count
/// connected components. This reads GROUP structure, which is what a scalar
/// histogram cut (the old Otsu) fundamentally cannot see: a same-voice link
/// is its print's STRONGEST link in every measured regime even when its
/// absolute similarity varies threefold (clean ≈ 0.8, AMI far-field ≈ 0.25).
fn eigen_count(cvecs: &[&[f32]], cap: usize) -> usize {
    let n = cvecs.len();
    let mut best = (f32::MAX, 1usize); // (nme ratio, count)
    for p_frac in [0.05f32, 0.1, 0.15, 0.25] {
        let p = ((n as f32 * p_frac).round() as usize).clamp(1, n - 1);
        // Top-p neighbors per row, binarized and symmetrized.
        let mut sym = vec![vec![0f32; n]; n];
        for i in 0..n {
            let mut row: Vec<(f32, usize)> = (0..n)
                .filter(|j| *j != i)
                .map(|j| (dot(cvecs[i], cvecs[j]), j))
                .collect();
            row.sort_by(|a, b| b.0.total_cmp(&a.0));
            for (_, j) in row.into_iter().take(p) {
                sym[i][j] += 0.5;
                sym[j][i] += 0.5;
            }
        }
        // Unnormalized Laplacian L = D − S.
        let mut lap = vec![vec![0f32; n]; n];
        for i in 0..n {
            let d: f32 = sym[i].iter().sum();
            for j in 0..n {
                lap[i][j] = if i == j { d - sym[i][j] } else { -sym[i][j] };
            }
        }
        let ev = sym_eigenvalues(lap);
        let upto = cap.min(n - 1);
        let (mut gap, mut count) = (f32::MIN, 1usize);
        for k in 0..upto {
            let g = ev[k + 1] - ev[k];
            if g > gap {
                gap = g;
                count = k + 1;
            }
        }
        let ratio = (p as f32 / n as f32) / (gap + 1e-6);
        if ratio < best.0 {
            best = (ratio, count);
        }
    }
    best.1.clamp(1, cap)
}

/// A voice being built: which prints it holds, its duration-weighted vector
/// sum (centered space) and total voiced frames. The unit centroid is the
/// linkage everything is compared through — pyannote's centroid method.
struct Voice {
    members: Vec<usize>,
    sum: Vec<f32>,
    frames: usize,
}

impl Voice {
    fn seed(i: usize, cvec: &[f32], frames: usize) -> Self {
        let w = (frames.max(1)) as f32;
        Voice { members: vec![i], sum: cvec.iter().map(|x| x * w).collect(), frames }
    }

    fn absorb(&mut self, other: Voice) {
        self.members.extend(other.members);
        for (a, b) in self.sum.iter_mut().zip(&other.sum) {
            *a += b;
        }
        self.frames += other.frames;
    }

    fn unit(&self) -> Vec<f32> {
        let norm = self.sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
        self.sum.iter().map(|x| x / norm).collect()
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Group a recording's phrases into voices — the production recipe (see the
/// module docs): session centering, agglomerative merging under one FIXED
/// per-space bar with centroid linkage, phantom absorption by minimum
/// cluster mass, then a turn-continuity (Viterbi) pass over the timeline.
///
/// `spans` are each print's (t0, t1) centiseconds — the continuity pass
/// needs the gaps between phrases. Strong phrases (≥ ~1 s of speech) define
/// the voices; short ones are assigned but never create or anchor one.
/// Returns a cluster index per input print, numbered by first appearance,
/// or `None` for prints that carry no voice at all.
///
/// Callers must pass prints of ONE generation (`lane_voices` guarantees it);
/// the gates are read from that generation's space.
pub fn cluster(
    prints: &[&VoicePrint],
    spans: &[(i64, i64)],
    max_speakers: usize,
) -> Vec<Option<usize>> {
    cluster_gated(prints, spans, max_speakers, MIN_NEW_VOICE_FRAMES)
}

/// [`cluster`] with the voice-defining evidence bar as a parameter: phrases
/// use [`MIN_NEW_VOICE_FRAMES`], the split pass's 1.5 s sub-windows use
/// [`SPLIT_MIN_VOICE_FRAMES`] — same recipe, two evidence scales.
fn cluster_gated(
    prints: &[&VoicePrint],
    spans: &[(i64, i64)],
    max_speakers: usize,
    min_voice_frames: usize,
) -> Vec<Option<usize>> {
    debug_assert_eq!(prints.len(), spans.len());
    let strong: Vec<usize> =
        (0..prints.len()).filter(|i| prints[*i].defines_voice(min_voice_frames)).collect();
    let mut out = vec![None; prints.len()];
    if strong.is_empty() {
        // Nothing long enough to define a voice: everyone who spoke is one.
        for (i, p) in prints.iter().enumerate() {
            if !p.is_silent() {
                out[i] = Some(0);
            }
        }
        return out;
    }
    let g = gates(&prints[strong[0]].vec);
    let cap = max_speakers.max(1);

    // Centered copies of every non-silent print — weak ones too: they are
    // assigned in the same space, they just never define a voice.
    let live: Vec<usize> = (0..prints.len()).filter(|i| !prints[*i].is_silent()).collect();
    let live_vecs: Vec<&[f32]> = live.iter().map(|i| prints[*i].vec.as_slice()).collect();
    let centered = if g.center {
        center_prints(&live_vecs)
    } else {
        live_vecs.iter().map(|v| v.to_vec()).collect()
    };
    let mut cvec: Vec<Option<&[f32]>> = vec![None; prints.len()];
    for (k, i) in live.iter().enumerate() {
        cvec[*i] = Some(centered[k].as_slice());
    }

    // How many voices to keep. With enough voice-defining phrases the
    // affinity graph's eigengap says how many groups there are; below that
    // there is no structure to read and the small-session bar decides
    // during merging instead (target = 1 keeps merging until the bar stops
    // it).
    let strong_cvecs: Vec<&[f32]> = strong.iter().map(|i| cvec[*i].expect("strong is live")).collect();
    enum Stop {
        /// Merge down to exactly this many voices (eigengap said so).
        Count(usize),
        /// Merge while the best pair is at least this alike.
        Bar(f32),
        /// No structure to read and no valley: one voice.
        MergeAll,
    }
    let stop = if !g.center {
        // The DSP fallback has no absolute operating point; it keeps its
        // proven session rule.
        let mut sims = Vec::new();
        for (a, i) in strong_cvecs.iter().enumerate() {
            for j in &strong_cvecs[a + 1..] {
                sims.push(dot(i, j));
            }
        }
        match dsp_split_threshold(sims) {
            Some(t) => Stop::Bar(t),
            None => Stop::MergeAll,
        }
    } else if strong.len() >= 4 {
        // COUNTING doesn't need every phrase — an even subsample keeps the
        // eigendecomposition small enough to re-run mid-meeting (the merge
        // itself still uses every print).
        const COUNT_SAMPLE: usize = 120;
        if strong_cvecs.len() > COUNT_SAMPLE {
            let step = strong_cvecs.len() as f32 / COUNT_SAMPLE as f32;
            let sampled: Vec<&[f32]> = (0..COUNT_SAMPLE)
                .map(|k| strong_cvecs[(k as f32 * step) as usize])
                .collect();
            Stop::Count(eigen_count(&sampled, cap))
        } else {
            Stop::Count(eigen_count(&strong_cvecs, cap))
        }
    } else {
        Stop::Bar(g.split)
    };

    // Agglomerative merging down to the target (or the bar). The pairwise
    // centroid similarities are cached and only the merged row is
    // recomputed, so a long meeting re-clusters in linear-ish time.
    let mut voices: Vec<Voice> = strong
        .iter()
        .map(|i| Voice::seed(*i, cvec[*i].expect("strong prints are live"), prints[*i].voiced_frames))
        .collect();
    let mut units: Vec<Vec<f32>> = voices.iter().map(Voice::unit).collect();
    let mut sims: Vec<Vec<f32>> = (0..voices.len())
        .map(|a| (0..voices.len()).map(|b| dot(&units[a], &units[b])).collect())
        .collect();
    loop {
        if voices.len() <= 1 {
            break;
        }
        let mut best = (0usize, 0usize, f32::MIN);
        for a in 0..voices.len() {
            for b in a + 1..voices.len() {
                if sims[a][b] > best.2 {
                    best = (a, b, sims[a][b]);
                }
            }
        }
        let (a, b, sim) = best;
        // Past the cap, keep merging the nearest pair regardless.
        let done = voices.len() <= cap
            && match stop {
                // The floor turns the count from an override into a bound:
                // however few voices the eigengap claims, two clusters that
                // do not actually sound alike are never fused.
                Stop::Count(k) => voices.len() <= k.max(1) || sim < COUNT_FLOOR,
                Stop::Bar(bar) => sim < bar,
                Stop::MergeAll => false,
            };
        if done {
            break;
        }
        let moved = voices.remove(b);
        voices[a].absorb(moved);
        units.remove(b);
        sims.remove(b);
        for row in &mut sims {
            row.remove(b);
        }
        units[a] = voices[a].unit();
        for x in 0..voices.len() {
            let s = dot(&units[a], &units[x]);
            sims[a][x] = s;
            sims[x][a] = s;
        }
    }

    // Same-voice collapse (raw space): clusters whose UNCENTERED centroids
    // agree at `raw_same` are one person, whatever the count said — the
    // invariant that held across every measured channel, and the guard for
    // the tiny solo session whose centered space is pure noise.
    loop {
        if voices.len() <= 1 {
            break;
        }
        let raw_units: Vec<Vec<f32>> = voices
            .iter()
            .map(|v| {
                let mut sum = vec![0f32; prints[v.members[0]].vec.len()];
                for m in &v.members {
                    let w = prints[*m].voiced_frames.max(1) as f32;
                    for (a, b) in sum.iter_mut().zip(&prints[*m].vec) {
                        *a += b * w;
                    }
                }
                let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
                sum.iter_mut().for_each(|x| *x /= norm);
                sum
            })
            .collect();
        let mut best = (0usize, 0usize, f32::MIN);
        for a in 0..voices.len() {
            for b in a + 1..voices.len() {
                let s = dot(&raw_units[a], &raw_units[b]);
                if s > best.2 {
                    best = (a, b, s);
                }
            }
        }
        if best.2 < g.raw_same {
            break;
        }
        let moved = voices.remove(best.1);
        voices[best.0].absorb(moved);
        units = voices.iter().map(Voice::unit).collect();
    }

    // Phantom absorption (pyannote's min_cluster_size): a voice that never
    // accumulated real mass is not reported — its phrases go to the nearest
    // voice that did. Only runs while somebody of real mass exists to take
    // them; a session where everyone is brief stays as it clustered. The
    // bars auto-relax away on small sessions (pyannote does the same):
    // with a dozen phrases, one phrase IS meaningful mass, and a session's
    // second voice must not be absorbed for having answered once.
    let (min_phrases, min_frames) = if live.len() < 20 {
        (1, 0)
    } else {
        (MIN_CLUSTER_PHRASES, MIN_CLUSTER_FRAMES)
    };
    // At the sub-window evidence scale a "member" is a 1.5 s window, not a
    // phrase, so the phrase-count clause is meaningless there: three windows
    // (~2 s of speech) would register as a person. Sub-window clusters must
    // carry MIN_CLUSTER_FRAMES of voiced mass, full stop — measured on the
    // 39-slice/4-meeting bench this alone takes split-success 38→39 and
    // mean confusion 4.8→3.7 while leaving every meeting at 4/4 speakers.
    let window_scale = min_voice_frames == SPLIT_MIN_VOICE_FRAMES;
    let is_real = |v: &Voice| {
        if window_scale {
            v.frames >= min_frames.max(MIN_CLUSTER_FRAMES)
        } else {
            v.members.len() >= min_phrases || v.frames >= min_frames
        }
    };
    // The sub-window pass also keeps a hard floor of two voices: absorbing
    // the last alternative would resurrect the merge-everyone bug the split
    // exists to fix, and a solo session loses nothing by keeping a runt.
    let absorb_floor = if window_scale { 2 } else { 1 };
    while voices.len() > absorb_floor {
        let Some(worst) = (0..voices.len())
            .filter(|i| !is_real(&voices[*i]))
            .min_by_key(|i| voices[*i].frames)
        else {
            break;
        };
        if !voices.iter().enumerate().any(|(i, v)| i != worst && is_real(v)) {
            break;
        }
        let unit_w = voices[worst].unit();
        let nearest = (0..voices.len())
            .filter(|i| *i != worst && is_real(&voices[*i]))
            .max_by(|x, y| {
                dot(&unit_w, &units[*x]).total_cmp(&dot(&unit_w, &units[*y]))
            })
            .expect("a real voice exists");
        let moved = voices.remove(worst);
        let nearest = if nearest > worst { nearest - 1 } else { nearest };
        voices[nearest].absorb(moved);
        units = voices.iter().map(Voice::unit).collect();
    }

    // Turn-continuity pass (the cheap stand-in for VBx's sticky HMM): walk
    // the timeline, let each phrase choose the voice it sounds like, with a
    // prior that adjacent phrases (< 1.5 s gap) are usually the same person
    // and distant ones carry no prior at all. Weak phrases get their labels
    // here — nearest voice, tempered by continuity — and can move a
    // misassigned strong phrase back home across two refinement rounds.
    let seq: Vec<usize> = {
        let mut s: Vec<usize> = live.clone();
        s.sort_by_key(|i| spans[*i].0);
        s
    };
    let mut assign: Vec<usize> = Vec::new();
    if voices.len() == 1 {
        assign = vec![0; seq.len()];
    } else {
        for _round in 0..2 {
            let k = voices.len();
            let ln_emit = |i: usize, v: usize| dot(cvec[i].expect("live"), &units[v]) / 0.15;
            // Viterbi over the phrase sequence.
            let mut back: Vec<Vec<usize>> = Vec::with_capacity(seq.len());
            let mut score: Vec<f32> = (0..k).map(|v| ln_emit(seq[0], v)).collect();
            for w in 1..seq.len() {
                let gap = spans[seq[w]].0 - spans[seq[w - 1]].1;
                let stay = if gap < 150 {
                    0.9f32
                } else if gap < 300 {
                    0.7
                } else {
                    1.0 / k as f32
                };
                let switch = ((1.0 - stay) / (k as f32 - 1.0)).max(1e-6);
                let (ln_stay, ln_switch) = (stay.max(1e-6).ln(), switch.ln());
                let mut next = vec![f32::MIN; k];
                let mut from = vec![0usize; k];
                for v in 0..k {
                    for u in 0..k {
                        let t = if u == v { ln_stay } else { ln_switch };
                        let s = score[u] + t;
                        if s > next[v] {
                            next[v] = s;
                            from[v] = u;
                        }
                    }
                    next[v] += ln_emit(seq[w], v);
                }
                score = next;
                back.push(from);
            }
            let mut best = (0..k).max_by(|a, b| score[*a].total_cmp(&score[*b])).unwrap_or(0);
            let mut path = vec![best; seq.len()];
            for w in (1..seq.len()).rev() {
                best = back[w - 1][best];
                path[w - 1] = best;
            }
            let changed = path != assign;
            assign = path;
            // Re-anchor the voices on what the pass decided (strong prints
            // only — weak ones are labeled but never reshape a voice).
            let mut sums: Vec<Vec<f32>> = vec![vec![0f32; units[0].len()]; k];
            let mut mass = vec![0usize; k];
            for (w, i) in seq.iter().enumerate() {
                if !prints[*i].defines_voice(min_voice_frames) {
                    continue;
                }
                let fr = prints[*i].voiced_frames.max(1) as f32;
                for (a, b) in sums[assign[w]].iter_mut().zip(cvec[*i].expect("live")) {
                    *a += b * fr;
                }
                mass[assign[w]] += prints[*i].voiced_frames;
            }
            for v in 0..k {
                if mass[v] > 0 {
                    let norm = sums[v].iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
                    units[v] = sums[v].iter().map(|x| x / norm).collect();
                }
            }
            if !changed {
                break;
            }
        }
    }

    // Number the voices by when each was first heard (voices the continuity
    // pass emptied simply never get a number).
    let mut order: Vec<usize> = Vec::new();
    for (w, i) in seq.iter().enumerate() {
        let v = assign[w];
        if !order.contains(&v) {
            order.push(v);
        }
        out[*i] = Some(order.iter().position(|x| *x == v).expect("just pushed"));
    }
    out
}

/// The **provisional** live label for a phrase, produced the instant it is
/// transcribed: nearest known voice, or a new one when nothing is close and
/// the phrase is long enough to be sure. Deliberately simple and a little
/// conservative — [`cluster`] revisits the whole recording on every flush and
/// corrects these labels with the benefit of everything heard since.
///
/// **The number of participants is discovered, not declared.**
pub struct SpeakerBook {
    /// The most voices this session may name. `AUTO_MAX_SPEAKERS` unless a
    /// caller pins an exact participant count.
    max_speakers: usize,
    /// Speakers already named in a resumed file. New voices are numbered after
    /// them (their centroids are not persisted, so they cannot be re-matched).
    base: usize,
    centroids: Vec<(Vec<f32>, usize)>, // (running centroid, phrase count)
}

impl SpeakerBook {
    /// Discover however many people are in the meeting (the normal case).
    pub fn auto() -> Self {
        Self::with_cap(AUTO_MAX_SPEAKERS)
    }

    /// Pin the participant count — used when a caller genuinely knows it
    /// (e.g. a one-on-one), which collapses stray voices onto the nearest.
    pub fn with_cap(max_speakers: usize) -> Self {
        Self {
            max_speakers: max_speakers.clamp(1, AUTO_MAX_SPEAKERS),
            base: 0,
            centroids: Vec::new(),
        }
    }

    /// On resume, keep numbering after the speakers already in the file. Those
    /// voices can't be re-identified (no persisted centroids), so a returning
    /// speaker may get a fresh number — clearly better than renumbering the
    /// history already on screen.
    pub fn seed_labels(&mut self, segments: &[RecSegment]) {
        self.base = segments
            .iter()
            .filter_map(|s| s.speaker.strip_prefix("Speaker ")?.parse::<usize>().ok())
            .max()
            .unwrap_or(0)
            .min(self.max_speakers.saturating_sub(1));
    }

    /// How many distinct voices this session may still open.
    fn room_left(&self) -> usize {
        self.max_speakers.saturating_sub(self.base).max(1)
    }

    pub fn assign(&mut self, print: Option<&VoicePrint>) -> String {
        let Some(print) = print.filter(|p| !p.is_silent()) else {
            return format!("Speaker {}", self.base + 1);
        };
        let emb = &print.vec;
        let g = gates(emb);
        let best = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, (c, _))| (i, cosine(emb, c)))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        // Opening a NEW voice is the costliest live mistake (a phantom stays
        // on screen until the next re-cluster), so it takes a lot: room under
        // the cap, ~2.5 s of actual speech, and clear distance from EVERY
        // voice already known. Everything else attaches to the nearest voice
        // — provisionally; [`cluster`] re-derives all labels as the meeting
        // grows.
        let may_open = self.centroids.len() < self.room_left()
            && print.voiced_frames >= MIN_OPEN_FRAMES;
        let idx = match best {
            Some((i, sim)) if sim >= g.online_same => i,
            Some((_, sim)) if sim < g.online_new && may_open => {
                self.centroids.push((emb.clone(), 0));
                self.centroids.len() - 1
            }
            Some((i, _)) => i,
            None => {
                self.centroids.push((emb.clone(), 0));
                0
            }
        };
        let (c, n) = &mut self.centroids[idx];
        if *n > 0 && print.voiced_frames >= MIN_UPDATE_FRAMES && c.len() == emb.len() {
            // Running-mean centroid, frozen after enough evidence so one odd
            // phrase can't drag an established voice away. Short phrases are
            // labeled but never reshape a voice (diart's rho_update).
            let w = (*n as f32).min(20.0);
            for (a, b) in c.iter_mut().zip(emb) {
                *a = (*a * w + b) / (w + 1.0);
            }
            let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
            c.iter_mut().for_each(|x| *x /= norm);
        }
        *n += 1;
        format!("Speaker {}", self.base + idx + 1)
    }
}

/// Everything a pass needs to put NAMES on the voices it has just sorted out:
/// the recording's label → name overlay, which of those names the app guessed
/// from a saved voice rather than the user typing them, and the saved voices
/// to guess from.
///
/// `recognized` holds NAMES, not labels, deliberately. Re-clustering moves
/// labels constantly (see [`move_names`]), so a guess keyed to a label would
/// be describing a different person by the next pass — while a name is at most
/// one person by construction, which makes it the stable key. What it buys:
/// a guess may be revised or withdrawn as the meeting grows, and a name the
/// user typed never may.
pub struct Naming<'a> {
    pub names: &'a mut BTreeMap<String, String>,
    pub recognized: &'a mut BTreeSet<String>,
    pub known: &'a [KnownVoice],
}

impl<'a> Naming<'a> {
    /// The overlay with no saved voices behind it — every caller that only
    /// wants clustering, and every test that is about clustering rather than
    /// recognition.
    pub fn plain(
        names: &'a mut BTreeMap<String, String>,
        recognized: &'a mut BTreeSet<String>,
    ) -> Self {
        Self { names, recognized, known: &[] }
    }
}

/// Re-label every phrase in `segments` from the whole recording's voices (see
/// [`cluster`]). Phrases from before voiceprints were stored are left exactly
/// as they are — and so are phrases whose prints belong to an older embedding
/// generation (see `lane_voices`). Returns true when a label actually moved —
/// or a name did — so the caller can tell the UI.
///
/// `naming` carries the label → name overlay (GH #5). It is carried WITH the
/// voice: when a group's label changes, the name the user typed changes label
/// with it. Keying the name to a label alone meant that every time the
/// clusterer moved a label, "Dana" appeared on somebody else's lines. It also
/// carries the room's saved voices, which is how a name from a PREVIOUS
/// recording lands on the person who is talking now.
///
/// **A lane is not a person, but it is a wall.** Colleagues in the room share
/// one microphone, so mic phrases must be clustered rather than all called
/// "You". Yet once the microphone's echo of the meeting has been removed
/// (`Engine::echo_of`), the two lanes are physically disjoint: the mic hears
/// only the room, the system lane only the meeting. No voice can span both, so
/// each lane is clustered on its own — which also keeps two similar voices on
/// opposite sides of the wall from being merged into one person.
pub fn relabel(segments: &mut [RecSegment], max_speakers: usize, naming: &mut Naming) -> bool {
    let cap = if max_speakers == 0 { AUTO_MAX_SPEAKERS } else { max_speakers };
    let in_room = lane_voices(segments, "mic", cap);
    let in_meeting = lane_voices(segments, "sys", cap);
    // Gate on PHRASES, not voices: a lone voice still needs relabeling when
    // its provisional labels drifted (a resumed file numbers the returning
    // speaker afresh; only this merge folds them back into one).
    let phrases: usize = in_room.iter().chain(&in_meeting).map(Vec::len).sum();
    if phrases < 2 {
        return false;
    }
    apply_names(segments, &in_room, &in_meeting, naming)
}

/// Move the user's names onto the labels their voices now carry.
///
/// `moves` is (the label a group used to show, the label it shows now), one
/// entry per group whose label changed. A swap is handled because the new map
/// is built from scratch rather than edited in place, and a name whose voice
/// vanished from the transcript is dropped rather than left to attach itself
/// to whoever inherits the number.
fn move_names(names: &mut BTreeMap<String, String>, moves: &[(String, String)]) {
    if names.is_empty() || moves.is_empty() {
        return;
    }
    let mut next: BTreeMap<String, String> = BTreeMap::new();
    for (from, to) in moves {
        if let Some(name) = names.get(from) {
            next.insert(to.clone(), name.clone());
        }
    }
    // Labels no group moved away from keep their name — unless a mover has
    // already claimed that label, whose name wins.
    for (label, name) in names.iter() {
        if moves.iter().any(|(from, _)| from == label) {
            continue;
        }
        next.entry(label.clone()).or_insert_with(|| name.clone());
    }
    *names = next;
}

/// Turn per-lane voice GROUPS (segment indices per voice) into on-screen
/// names — "You" for the mic's main talker, sticky "Speaker N" for everyone
/// else — and write them. Shared by [`relabel`] (phrase groups) and
/// [`split_by_voice`] (sub-window groups): one naming brain, two clusterings.
///
/// The user's typed names travel with the groups (see [`move_names`]), and the
/// room's saved voices are put onto them here (see [`recognize_groups`]) —
/// which is the whole of cross-recording recognition, in the one place that
/// already knows what every voice in this recording is called.
fn apply_names(
    segments: &mut [RecSegment],
    in_room: &[Vec<usize>],
    in_meeting: &[Vec<usize>],
    naming: &mut Naming,
) -> bool {
    // Whoever does most of the talking into this Mac's microphone is its
    // owner. (Not "the mic lane" — the colleague beside them is on it too.)
    let frames = |g: &Vec<usize>| -> usize {
        g.iter().map(|s| segments[*s].voice.as_ref().map_or(0, |v| v.voiced_frames)).sum()
    };
    let you = (0..in_room.len()).max_by_key(|i| frames(&in_room[*i]));

    // Everyone else is numbered, room and meeting alike — the transcript
    // reads as one conversation, because it is one.
    let mut others: Vec<&Vec<usize>> = in_room
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != you)
        .map(|(_, g)| g)
        .chain(in_meeting.iter())
        .collect();
    others.sort_by_key(|g| g.iter().copied().min().unwrap_or(usize::MAX));

    // Names are STICKY: each group keeps the number most of its phrases
    // already show on screen whenever it can. Renumbering everyone by first
    // appearance after every re-cluster made a mid-meeting merge shuffle the
    // labels of people who never changed — which reads as misrecognition.
    let mut taken: Vec<String> = Vec::new();
    let mut named: Vec<(&Vec<usize>, String)> = Vec::new();
    for g in &others {
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for slot in g.iter() {
            let label = segments[*slot].speaker.as_str();
            if label.starts_with("Speaker ") && !taken.iter().any(|t| t == label) {
                match counts.iter_mut().find(|(l, _)| *l == label) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((label, 1)),
                }
            }
        }
        // Strictly-greater scan: a tie keeps the label heard EARLIEST (counts
        // are in phrase order) — the one that's been on screen longest. A
        // label backed by a single phrase isn't established, though: keeping
        // it preserves whatever number the live pass happened to mint
        // ("Speaker 6" in a two-person call), so it takes the lowest free
        // number instead.
        let name = counts
            .iter()
            .fold(None::<(&str, usize)>, |best, (l, n)| match best {
                Some((_, m)) if *n <= m => best,
                _ => Some((l, *n)),
            })
            .filter(|(_, n)| *n >= 2)
            .map(|(l, _)| l.to_string())
            .unwrap_or_else(|| {
                (1..)
                    .map(|n| format!("Speaker {n}"))
                    .find(|c| !taken.iter().any(|t| t == c))
                    .expect("unbounded")
            });
        taken.push(name.clone());
        named.push((*g, name));
    }
    if let Some(you) = you {
        named.push((&in_room[you], "You".to_string()));
    }

    // What each group was CALLED before this pass — the label most of its
    // phrases show on screen — so the user's name for that voice can follow
    // it to whatever label it is about to get.
    let mut moves: Vec<(String, String)> = Vec::new();
    for (group, name) in &named {
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for slot in group.iter() {
            let label = segments[*slot].speaker.as_str();
            match counts.iter_mut().find(|(l, _)| *l == label) {
                Some((_, n)) => *n += 1,
                None => counts.push((label, 1)),
            }
        }
        let was = counts
            .iter()
            .fold(None::<(&str, usize)>, |best, (l, n)| match best {
                Some((_, m)) if *n <= m => best,
                _ => Some((l, *n)),
            })
            .map(|(l, _)| l.to_string());
        // A voice that split in two: only the first piece inherits the name,
        // rather than the same person appearing twice under it.
        if let Some(was) = was.filter(|w| w != name && !moves.iter().any(|(f, _)| f == w)) {
            moves.push((was, name.clone()));
        }
    }
    move_names(naming.names, &moves);
    // A name whose voice left the transcript entirely was just dropped by
    // `move_names`; a GUESS about it has to go with it, or a stale guess sits
    // in the way of the real one the next pass would make.
    naming.recognized.retain(|n| naming.names.values().any(|v| v == n));

    let mut changed = recognize(segments, &named, naming);
    for (group, name) in named {
        for slot in group {
            if segments[*slot].speaker != name {
                segments[*slot].speaker = name.clone();
                changed = true;
            }
        }
    }
    changed
}

/// Put the room's saved voices onto this recording's groups, as names in the
/// overlay. Returns true when the overlay changed.
///
/// `named` is every group with the label it is about to carry. Two groups are
/// out of scope by construction:
///
/// * **"You"** — the microphone's main talker is a POSITION, not an identity,
///   and it is the one label the user never has to be told. A saved voice does
///   not get to overwrite it.
/// * **A label the user named by hand** — their word is the answer for that
///   voice, and it is not up for re-guessing. Its name is also withheld from
///   every other group, so the same person cannot appear twice.
///
/// Every other group is re-decided from scratch on every pass, guess included:
/// a name put on two phrases of evidence should be withdrawn when twenty more
/// phrases disagree with it, and leaving it there — visibly a name, indistinct
/// from one that was typed — is the failure mode this whole feature has to
/// avoid.
fn recognize(segments: &[RecSegment], named: &[(&Vec<usize>, String)], naming: &mut Naming) -> bool {
    if naming.known.is_empty() {
        return false;
    }
    let typed: Vec<String> = naming
        .names
        .values()
        .filter(|n| !naming.recognized.contains(*n))
        .cloned()
        .collect();
    let open: Vec<usize> = (0..named.len())
        .filter(|i| named[*i].1 != "You")
        .filter(|i| naming.names.get(&named[*i].1).is_none_or(|n| naming.recognized.contains(n)))
        .collect();
    let centroids: Vec<Option<VoicePrint>> = open
        .iter()
        .map(|i| {
            let prints: Vec<&VoicePrint> =
                named[*i].0.iter().filter_map(|s| segments[*s].voice.as_ref()).collect();
            identity_print(&prints)
        })
        .collect();

    let mut changed = false;
    for (i, picked) in open.iter().zip(recognize_groups(&centroids, naming.known, &typed)) {
        let label = &named[*i].1;
        match picked {
            Some(person) => {
                if naming.names.get(label) != Some(&person) {
                    naming.names.insert(label.clone(), person.clone());
                    changed = true;
                }
                naming.recognized.insert(person);
            }
            // Nothing saved matches this voice any more — a guess the meeting
            // has since talked out of. Withdraw it; "Speaker 3" is true and a
            // stale name is not.
            None => {
                if let Some(gone) = naming.names.remove(label) {
                    naming.recognized.remove(&gone);
                    changed = true;
                }
            }
        }
    }
    changed
}

/// One lane's phrases grouped into voices: a list of segment indices per voice,
/// numbered by first appearance. Phrases carrying no voice at all are dropped.
///
/// A resumed old file mixes print generations, which can't be compared. Only
/// the newest generation present in the lane is clustered; older-generation
/// phrases keep whatever label they already have, exactly like legacy rows
/// with no print. (A silent print is generation-less — it clusters to nothing
/// either way.)
fn lane_voices(segments: &[RecSegment], lane: &str, cap: usize) -> Vec<Vec<usize>> {
    let mut idx: Vec<usize> = (0..segments.len())
        .filter(|i| segments[*i].source == lane && segments[*i].voice.is_some())
        .collect();
    let print = |i: &usize| segments[*i].voice.as_ref().expect("filtered");
    if idx.iter().any(|i| neural(&print(i).vec)) {
        idx.retain(|i| neural(&print(i).vec));
    }
    if idx.is_empty() {
        return Vec::new();
    }
    let prints: Vec<&VoicePrint> = idx.iter().map(print).collect();
    let spans: Vec<(i64, i64)> = idx.iter().map(|i| (segments[*i].t0, segments[*i].t1)).collect();
    let ids = cluster(&prints, &spans, cap);
    let mut groups = vec![Vec::new(); ids.iter().flatten().max().map_or(0, |m| m + 1)];
    for (slot, id) in idx.iter().zip(ids) {
        if let Some(id) = id {
            groups[id].push(*slot);
        }
    }
    groups
}

// ------------------------------------------------------------ the split pass

/// One phrase's sub-window prints: fixed 1.5 s windows at a 0.75 s hop, each
/// embedded on its own, spans on the recording's absolute timeline. Computed
/// on the decode thread while the phrase's audio is in hand, so the stop-time
/// split pays only for clustering.
pub fn window_prints(samples: &[f32], t0_cs: i64) -> Vec<(i64, i64, VoicePrint)> {
    let cs_len = samples.len() as i64 * 100 / SAMPLE_RATE as i64;
    let mut out = Vec::new();
    let mut t = 0i64;
    while t < cs_len - 20 {
        let end = (t + SPLIT_WIN_CS).min(cs_len);
        let i0 = (t * SAMPLE_RATE as i64 / 100) as usize;
        let i1 = ((end * SAMPLE_RATE as i64 / 100) as usize).min(samples.len());
        if i1 > i0 {
            out.push((t0_cs + t, t0_cs + end, embed(&samples[i0..i1])));
        }
        if end >= cs_len {
            break;
        }
        t += SPLIT_HOP_CS;
    }
    out
}

/// Frames-weighted mean of the windows overlapping `[t0, t1)`, renormalized —
/// the print a split piece carries forward. `voiced_frames` is approximated
/// from window overlap (windows cover the timeline twice at this hop, hence
/// the halving); it only feeds the evidence gates and the who-talks-most
/// mass, which tolerate that.
fn span_print(wins: &[(i64, i64, VoicePrint)], t0: i64, t1: i64) -> Option<VoicePrint> {
    let mut sum: Vec<f32> = Vec::new();
    let mut frames = 0f32;
    for (b, e, p) in wins {
        let ov = (t1.min(*e) - t0.max(*b)) as f32;
        if ov <= 0.0 || p.is_silent() {
            continue;
        }
        if sum.is_empty() {
            sum = vec![0.0; p.vec.len()];
        }
        if sum.len() != p.vec.len() {
            continue; // never mix print generations in one mean
        }
        let w = p.voiced_frames as f32 * ov / (*e - *b).max(1) as f32;
        for (a, x) in sum.iter_mut().zip(&p.vec) {
            *a += x * w;
        }
        frames += w;
    }
    let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
    if sum.is_empty() || norm < 1e-6 {
        return None;
    }
    sum.iter_mut().for_each(|x| *x /= norm);
    Some(VoicePrint { vec: sum, voiced_frames: (frames / 2.0) as usize })
}

/// The offline voice pass (ADD-28), run wherever the full audio is at hand
/// (stop, pause, re-transcribe): cluster every phrase's sub-windows, give
/// each WORD the voice of its nearest window, and cut phrases wherever
/// consecutive words disagree — so two people answering each other without a
/// pause stop sharing one label. The pieces then get their names through the
/// same [`apply_names`] the phrase path uses.
///
/// `wins_for` supplies a segment's sub-window prints (from the decode-time
/// cache, or embedded on the spot from the recording). `names` is the user's
/// label → name overlay, carried with the voices exactly as in [`relabel`].
/// Lanes stay walls, as in [`relabel`]. Returns true when the transcript
/// changed.
pub fn split_by_voice(
    segments: &mut Vec<RecSegment>,
    max_speakers: usize,
    naming: &mut Naming,
    mut wins_for: impl FnMut(&RecSegment) -> Vec<(i64, i64, VoicePrint)>,
) -> bool {
    let cap = if max_speakers == 0 { AUTO_MAX_SPEAKERS } else { max_speakers };
    let seg_wins: Vec<Vec<(i64, i64, VoicePrint)>> =
        segments.iter().map(|s| wins_for(s)).collect();

    // plan[i]: the pieces segment i becomes — (lane voice, word range) — or
    // None to keep it untouched (legacy rows, window-less phrases).
    let mut plan: Vec<Option<Vec<(Option<usize>, std::ops::Range<usize>)>>> =
        vec![None; segments.len()];
    let mut lane_voice_count = [0usize; 2];
    for (lane_no, lane) in ["mic", "sys"].into_iter().enumerate() {
        let idx: Vec<usize> = (0..segments.len())
            .filter(|i| segments[*i].source == lane && !seg_wins[*i].is_empty())
            .collect();
        let mut prints: Vec<&VoicePrint> = Vec::new();
        let mut spans: Vec<(i64, i64)> = Vec::new();
        let mut owner: Vec<usize> = Vec::new();
        for i in &idx {
            for (b, e, p) in &seg_wins[*i] {
                prints.push(p);
                spans.push((*b, *e));
                owner.push(*i);
            }
        }
        if prints.len() < 2 {
            continue;
        }
        let ids = cluster_gated(&prints, &spans, cap, SPLIT_MIN_VOICE_FRAMES);
        lane_voice_count[lane_no] =
            ids.iter().flatten().copied().max().map_or(0, |m| m + 1);
        for i in &idx {
            let wins: Vec<(usize, (i64, i64))> = (0..prints.len())
                .filter(|k| owner[*k] == *i)
                .map(|k| (k, spans[k]))
                .collect();
            let seg = &segments[*i];
            // Each word takes the voice of the window whose center is
            // nearest; unknowns (silence, weak windows) never cut a turn —
            // they ride with the voice already speaking.
            let mut labels: Vec<Option<usize>> = Vec::with_capacity(seg.words.len());
            let mut last: Option<usize> = None;
            for w in &seg.words {
                let mid = (w.t0 + w.t1) / 2;
                let best = wins
                    .iter()
                    .min_by_key(|(_, (b, e))| ((b + e) / 2 - mid).abs())
                    .and_then(|(k, _)| ids[*k])
                    .or(last);
                last = best;
                labels.push(best);
            }
            if let Some(first) = labels.iter().flatten().next().copied() {
                for l in labels.iter_mut() {
                    if l.is_none() {
                        *l = Some(first);
                    }
                }
            }
            let mut cuts: Vec<(Option<usize>, std::ops::Range<usize>)> = Vec::new();
            let mut start = 0usize;
            for w in 1..labels.len() {
                if labels[w] != labels[start] {
                    cuts.push((labels[start], start..w));
                    start = w;
                }
            }
            if !labels.is_empty() {
                cuts.push((labels[start], start..labels.len()));
            }
            plan[*i] = Some(cuts);
        }
    }

    // Rebuild the transcript: a multi-voice phrase becomes its pieces —
    // words, timings, text and prints all follow the cut.
    let mut rebuilt: Vec<RecSegment> = Vec::new();
    let mut groups: [Vec<Vec<usize>>; 2] = [
        (0..lane_voice_count[0]).map(|_| Vec::new()).collect(),
        (0..lane_voice_count[1]).map(|_| Vec::new()).collect(),
    ];
    let mut split_any = false;
    for (i, seg) in segments.iter().enumerate() {
        let lane_no = usize::from(seg.source != "mic");
        match &plan[i] {
            Some(cuts) if !cuts.is_empty() => {
                let many = cuts.len() > 1;
                split_any |= many;
                for (voice, range) in cuts {
                    let words: Vec<RecWord> = seg.words[range.clone()].to_vec();
                    let t0 = if range.start == 0 {
                        seg.t0
                    } else {
                        words.first().map_or(seg.t0, |w| w.t0)
                    };
                    let t1 = if range.end == seg.words.len() {
                        seg.t1
                    } else {
                        words.last().map_or(seg.t1, |w| w.t1)
                    };
                    let text = if many {
                        words
                            .iter()
                            .map(|w| w.w.trim())
                            .filter(|w| !w.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ")
                    } else {
                        seg.text.clone()
                    };
                    let print = span_print(&seg_wins[i], t0, t1).or_else(|| seg.voice.clone());
                    if let Some(v) = voice {
                        groups[lane_no][*v].push(rebuilt.len());
                    }
                    rebuilt.push(RecSegment {
                        id: if many {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            seg.id.clone()
                        },
                        source: seg.source.clone(),
                        speaker: seg.speaker.clone(),
                        t0,
                        t1,
                        text,
                        words,
                        lang: seg.lang.clone(),
                        voice: print,
                    });
                }
            }
            _ => rebuilt.push(seg.clone()),
        }
    }
    let [mic_groups, sys_groups] = groups;
    let renamed = apply_names(&mut rebuilt, &mic_groups, &sys_groups, naming);
    if split_any || renamed {
        *segments = rebuilt;
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Distant synthetic spans (5 s gaps): the turn-continuity prior stays
    /// neutral, so a test measures clustering alone.
    fn spans_for(n: usize) -> Vec<(i64, i64)> {
        (0..n as i64).map(|i| (i * 1000, i * 1000 + 500)).collect()
    }

    // A conversation: every turn says something different, the way meetings
    // actually go. (Two people reading the SAME sentence is the one case the
    // DSP representation struggles with — see `same_sentence_is_the_hard_case`.)
    const LINE_A: &str = "The quarterly launch plan needs review before Friday afternoon.";
    const LINE_B: &str = "I will prepare the release notes and update the website today.";
    const LINE_C: &str = "Let us meet again tomorrow at ten to finalize everything.";
    const LINE_D: &str = "Sounds good, I will send the agenda and the notes tonight.";

    /// Decode a macOS `say` voice saying `line` to mono 16 kHz, via the app's
    /// own decoder. None when `say`/the voice is unavailable (test then skips).
    /// The temp path is unique per call — these tests run in parallel and
    /// `say` fails (-54) if two of them open the same output file.
    fn say(voice: &str, line: &str) -> Option<Vec<f32>> {
        let path = std::env::temp_dir()
            .join(format!("pr-diarize-{voice}-{}.aiff", uuid::Uuid::new_v4()));
        let ok = std::process::Command::new("say")
            .args(["-v", voice, "-o"])
            .arg(&path)
            .arg(line)
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
        let pcm = crate::stt::decode_to_pcm(&path, crate::stt::MediaKind::Audio).ok();
        let _ = std::fs::remove_file(&path);
        pcm
    }

    /// A shared room + microphone channel, simulated deterministically: three
    /// early reflections, a fixed low-level noise floor (~-35 dBFS, LCG), and
    /// a gentle one-pole lowpass. Every voice in the room passes through this
    /// SAME coloring — the regime that used to glue mic-lane voices together.
    fn room_channel(x: &[f32]) -> Vec<f32> {
        let n = x.len();
        let mut y = vec![0f32; n];
        for i in 0..n {
            let mut s = x[i];
            if i >= 400 {
                s += 0.5 * x[i - 400];
            }
            if i >= 1600 {
                s += 0.3 * x[i - 1600];
            }
            if i >= 3200 {
                s += 0.15 * x[i - 3200];
            }
            y[i] = s;
        }
        let mut state: u32 = 0x1234_5678;
        for v in y.iter_mut() {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let r = (state >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
            *v += r * 0.036; // ~-35 dBFS uniform noise
        }
        let mut prev = 0f32;
        for v in y.iter_mut() {
            prev += 0.75 * (*v - prev);
            *v = prev;
        }
        y
    }

    /// Harsher variant: the speaker sits across the room from the laptop mic,
    /// so the voice arrives quiet relative to the fixed noise floor and the
    /// reflections are stronger. `gain` scales the dry voice.
    fn far_mic_channel(x: &[f32], gain: f32) -> Vec<f32> {
        let scaled: Vec<f32> = x.iter().map(|s| s * gain).collect();
        room_channel(&scaled)
    }

    // ---------------------------------------------- the neural (shipping) path

    /// A neural print for a `say` phrase, failing LOUDLY if the bundled model
    /// went missing — otherwise every neural test would silently exercise the
    /// DSP fallback and prove nothing.
    fn nembed(samples: &[f32]) -> VoicePrint {
        let p = embed(samples);
        assert_eq!(
            p.vec.len(),
            titanet::EMB_DIM,
            "TitaNet model missing/broken at {:?}",
            model_path()
        );
        p
    }

    /// ADD-28: two people answering each other with NO pause land in ONE
    /// phrase, and a phrase carries one label — the split pass must cut the
    /// phrase at the voice change, keep the words with their halves, and
    /// give the halves different speakers.
    #[test]
    fn split_pass_cuts_a_two_voice_phrase() {
        let Some(a) = say("Samantha", LINE_A) else { return };
        let Some(a2) = say("Samantha", LINE_C) else { return };
        let Some(b) = say("Daniel", LINE_B) else { return };
        let Some(b2) = say("Daniel", LINE_D) else { return };
        let mut audio = a;
        audio.extend(&a2);
        let cut_cs = (audio.len() * 100 / SAMPLE_RATE) as i64;
        audio.extend(&b);
        audio.extend(&b2);
        let total_cs = (audio.len() * 100 / SAMPLE_RATE) as i64;

        // Synthetic words every 40 cs: the split must land them correctly
        // without any help from real word timings.
        let words: Vec<RecWord> = (0..total_cs / 40)
            .map(|k| RecWord { w: format!("w{k}"), t0: k * 40, t1: k * 40 + 35, del: false })
            .collect();
        let n_words = words.len();
        let mut segments = vec![RecSegment {
            id: "one".into(),
            source: "sys".into(),
            speaker: "Speaker 1".into(),
            t0: 0,
            t1: total_cs,
            text: "two people, one phrase".into(),
            words,
            lang: None,
            voice: Some(nembed(&audio)),
        }];
        let changed = split_by_voice(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new()), |seg| {
            let i0 = seg.t0.max(0) as usize * (SAMPLE_RATE / 100);
            let i1 = (seg.t1.max(0) as usize * (SAMPLE_RATE / 100)).min(audio.len());
            window_prints(&audio[i0..i1], seg.t0)
        });
        assert!(changed, "the split pass saw a two-voice phrase and did nothing");
        assert!(segments.len() >= 2, "phrase not split: {} piece(s)", segments.len());
        assert_eq!(
            segments.iter().map(|s| s.words.len()).sum::<usize>(),
            n_words,
            "words lost or duplicated by the cut"
        );
        let first = &segments[0];
        let last = &segments[segments.len() - 1];
        assert_ne!(first.speaker, last.speaker, "the pieces share one label");
        // The cut nearest the true voice change must land within one window.
        let boundary = segments[..segments.len() - 1]
            .iter()
            .map(|s| s.t1)
            .min_by_key(|t| (t - cut_cs).abs())
            .expect("at least one cut");
        assert!(
            (boundary - cut_cs).abs() <= 150,
            "cut at {boundary}cs, true voice change at {cut_cs}cs"
        );
    }

    /// The condition the DSP print could never pass, now REQUIRED: two women
    /// through the identical far room+mic channel (same-gender, so no pitch
    /// help; same channel coloring, low gain) split 2–2 — while one woman
    /// through that same channel stays a single voice however varied her
    /// sentences.
    #[test]
    fn neural_female_pair_through_one_shared_far_mic_splits_but_one_voice_does_not() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(kar1) = say("Karen", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(kar2) = say("Karen", LINE_D) else { return };
        let prints: Vec<VoicePrint> =
            [&sam1, &kar1, &sam2, &kar2].iter().map(|x| nembed(&far_mic_channel(x, 0.3))).collect();
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0), Some(1), Some(0), Some(1)],
            "two women on one far mic were not told apart"
        );

        let Some(sam3) = say("Samantha", LINE_B) else { return };
        let Some(sam4) = say("Samantha", LINE_D) else { return };
        let solo: Vec<VoicePrint> =
            [&sam1, &sam2, &sam3, &sam4].iter().map(|x| nembed(&far_mic_channel(x, 0.3))).collect();
        let refs: Vec<&VoicePrint> = solo.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0); 4],
            "one person on one far mic was split in two"
        );
    }

    /// A MEETING: five people, three sentences each. Many voices smear the
    /// pairwise-similarity distribution into a continuum, Otsu finds no
    /// valley, and the old fallback ("no valley → one voice") collapsed the
    /// whole room into one speaker — on-device QA saw "two people, then
    /// everyone becomes one, overriding the labels". The absolute
    /// `same_floor` is what holds the room apart.
    #[test]
    fn neural_five_person_meeting_does_not_collapse() {
        let voices = ["Samantha", "Daniel", "Karen", "Fred", "Moira"];
        let lines = [LINE_A, LINE_B, LINE_C];
        let mut prints: Vec<VoicePrint> = Vec::new();
        for v in voices {
            for l in lines {
                let Some(pcm) = say(v, l) else { return };
                prints.push(nembed(&pcm));
            }
        }
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS);
        let found: std::collections::BTreeSet<_> = ids.iter().flatten().collect();
        assert_eq!(found.len(), 5, "five clean voices must stay five: {ids:?}");
        // …and each person's three sentences stay one person.
        for (v, chunk) in ids.chunks(3).enumerate() {
            assert!(
                chunk.iter().all(|c| *c == chunk[0]),
                "voice {} was split across clusters: {ids:?}",
                voices[v]
            );
        }
    }

    /// Calibration printout for `NEURAL_GATES.split` (run by hand):
    /// same/different-speaker centroid similarities in the session-centered
    /// space, for the same regimes the regression fixtures pin. Read next to
    /// the AMI numbers from `rec_bench::calibrate_embeddings`.
    /// `cargo test --lib print_fixture_similarities -- --ignored --nocapture`
    #[test]
    #[ignore = "manual calibration printout"]
    fn print_fixture_similarities() {
        let regimes: [(&str, Box<dyn Fn(&[f32]) -> Vec<f32>>); 3] = [
            ("clean", Box::new(|x: &[f32]| x.to_vec())),
            ("room", Box::new(|x: &[f32]| room_channel(x))),
            ("far-mic", Box::new(|x: &[f32]| far_mic_channel(x, 0.3))),
        ];
        let voices = ["Samantha", "Daniel", "Karen", "Fred", "Moira"];
        let lines = [LINE_A, LINE_B, LINE_C];
        for (name, channel) in regimes {
            let mut owner: Vec<usize> = Vec::new();
            let mut prints: Vec<VoicePrint> = Vec::new();
            for (v, voice) in voices.iter().enumerate() {
                for l in lines {
                    let Some(pcm) = say(voice, l) else { return };
                    prints.push(nembed(&channel(&pcm)));
                    owner.push(v);
                }
            }
            let vecs: Vec<&[f32]> = prints.iter().map(|p| p.vec.as_slice()).collect();
            let centered = center_prints(&vecs);
            let (mut same_r, mut diff_r, mut same_c, mut diff_c) =
                (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for i in 0..prints.len() {
                for j in i + 1..prints.len() {
                    let r = cosine(&prints[i].vec, &prints[j].vec);
                    let c: f32 = centered[i].iter().zip(&centered[j]).map(|(a, b)| a * b).sum();
                    if owner[i] == owner[j] {
                        same_r.push(r);
                        same_c.push(c);
                    } else {
                        diff_r.push(r);
                        diff_c.push(c);
                    }
                }
            }
            let stats = |v: &mut Vec<f32>| {
                v.sort_by(f32::total_cmp);
                (v[0], v[v.len() / 2], v[v.len() - 1])
            };
            let (a, b, c) = stats(&mut same_r);
            eprintln!("{name:8} same raw       min {a:+.3} med {b:+.3} max {c:+.3}");
            let (a, b, c) = stats(&mut same_c);
            eprintln!("{name:8} same centered  min {a:+.3} med {b:+.3} max {c:+.3}");
            let (a, b, c) = stats(&mut diff_r);
            eprintln!("{name:8} diff raw       min {a:+.3} med {b:+.3} max {c:+.3}");
            let (a, b, c) = stats(&mut diff_c);
            eprintln!("{name:8} diff centered  min {a:+.3} med {b:+.3} max {c:+.3}");
            // Per-voice-pair CENTROID similarities (what the merge loop
            // actually compares once each voice has consolidated).
            let centroid = |v: usize| -> Vec<f32> {
                let mut c = vec![0f32; centered[0].len()];
                let mut n = 0f32;
                for (k, o) in owner.iter().enumerate() {
                    if *o == v {
                        for (a, b) in c.iter_mut().zip(&centered[k]) {
                            *a += b;
                        }
                        n += 1.0;
                    }
                }
                let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
                c.iter_mut().for_each(|x| *x /= norm);
                let _ = n;
                c
            };
            for v in 0..voices.len() {
                for w in v + 1..voices.len() {
                    let s: f32 =
                        centroid(v).iter().zip(&centroid(w)).map(|(a, b)| a * b).sum();
                    if s > 0.0 {
                        eprintln!("{name:8}   centroid {} vs {}: {s:+.3}", voices[v], voices[w]);
                    }
                }
            }
        }
    }

    /// Diagnostic (run by hand): where does the five-person fixture's merge
    /// bar land, and which pairs sit near it?
    #[test]
    #[ignore = "manual diagnostic"]
    fn debug_five_person_bar() {
        let voices = ["Samantha", "Daniel", "Karen", "Fred", "Moira"];
        let lines = [LINE_A, LINE_B, LINE_C];
        let mut prints: Vec<VoicePrint> = Vec::new();
        let mut owner: Vec<usize> = Vec::new();
        for (v, voice) in voices.iter().enumerate() {
            for l in lines {
                let Some(pcm) = say(voice, l) else { return };
                prints.push(nembed(&pcm));
                owner.push(v);
            }
        }
        let vecs: Vec<&[f32]> = prints.iter().map(|p| p.vec.as_slice()).collect();
        let centered = center_prints(&vecs);
        let mut sims = Vec::new();
        let mut labeled: Vec<(f32, usize, usize)> = Vec::new();
        for i in 0..prints.len() {
            for j in i + 1..prints.len() {
                let s: f32 = centered[i].iter().zip(&centered[j]).map(|(a, b)| a * b).sum();
                sims.push(s);
                labeled.push((s, owner[i], owner[j]));
            }
        }
        let refs: Vec<&[f32]> = centered.iter().map(|v| v.as_slice()).collect();
        eprintln!("eigen_count = {}", eigen_count(&refs, AUTO_MAX_SPEAKERS));
        let _ = sims;

        // The 4-print far-mic pair fixture, exactly as its test builds it.
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(kar1) = say("Karen", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(kar2) = say("Karen", LINE_D) else { return };
        let pair: Vec<VoicePrint> =
            [&sam1, &kar1, &sam2, &kar2].iter().map(|x| nembed(&far_mic_channel(x, 0.3))).collect();
        let names = ["sam1", "kar1", "sam2", "kar2"];
        let pv: Vec<&[f32]> = pair.iter().map(|p| p.vec.as_slice()).collect();
        let pc = center_prints(&pv);
        for i in 0..4 {
            for j in i + 1..4 {
                let c: f32 = pc[i].iter().zip(&pc[j]).map(|(a, b)| a * b).sum();
                eprintln!("pair fixture  {} vs {}: {c:+.3}", names[i], names[j]);
            }
        }
        let pr: Vec<&[f32]> = pc.iter().map(|v| v.as_slice()).collect();
        eprintln!("pair eigen_count = {}", eigen_count(&pr, AUTO_MAX_SPEAKERS));
        labeled.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (s, a, b) in labeled.iter().take(40) {
            let kind = if a == b { "SAME" } else { "diff" };
            eprintln!("  {s:+.3}  {kind}  {} vs {}", voices[*a], voices[*b]);
        }
    }

    /// A one-word reply must attach to a known voice and never define one —
    /// the attach-only design survives the embedding swap because the
    /// evidence gate (voiced frames) did not move.
    #[test]
    fn neural_short_reply_attaches_and_never_creates_a_voice() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(dan1) = say("Daniel", LINE_B) else { return };
        let Some(perfect) = say("Samantha", "Perfect.") else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let short = nembed(&perfect);
        assert!(!short.is_strong(), "a one-word reply must not be able to define a voice");

        let prints = [nembed(&sam1), nembed(&dan1), short, nembed(&sam2)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0), Some(1), Some(0), Some(0)],
            "the meeting had two people; clustering said otherwise"
        );
    }

    /// A resumed pre-TitaNet file: DSP prints from the old session, neural
    /// prints from the new one. Only the new generation is re-clustered (the
    /// drifted new label folds back); the old rows' labels are untouched,
    /// exactly like rows with no print at all.
    #[test]
    fn mixed_generation_file_relabels_new_prints_and_leaves_old_labels_alone() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let mut segments = vec![
            seg("Speaker 4", "sys", Some(dsp_embed(&sam))),
            seg("Speaker 5", "sys", Some(dsp_embed(&dan))),
            seg("Speaker 1", "sys", Some(nembed(&sam))),
            seg("Speaker 2", "sys", Some(nembed(&dan))),
            // What the live pass got wrong after the resume: a third voice.
            seg("Speaker 3", "sys", Some(nembed(&sam2))),
        ];
        assert!(relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())), "the drifted new label was never corrected");
        assert_eq!(segments[0].speaker, "Speaker 4", "old-generation label must not move");
        assert_eq!(segments[1].speaker, "Speaker 5", "old-generation label must not move");
        assert_eq!(segments[2].speaker, "Speaker 1");
        assert_eq!(segments[3].speaker, "Speaker 2");
        assert_eq!(segments[4].speaker, "Speaker 1", "same voice as segment 2");
    }

    /// The fallback that keeps recording alive without the model: a bogus
    /// model path must yield the DSP print, silently, and that print must
    /// still be strong enough to count as voice evidence.
    #[test]
    fn model_missing_falls_back_to_the_dsp_print() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let bogus = std::env::temp_dir().join("pr-no-such-dir").join(MODEL_FILE);
        let p = embed_at(&bogus, &sam);
        let d = dsp_embed(&sam);
        assert_eq!(p.vec.len(), BANDS + 1, "fallback must be the DSP print");
        assert_eq!(p.vec, d.vec);
        assert_eq!(p.voiced_frames, d.voiced_frames);
        assert!(p.is_strong(), "the fallback print must still be usable evidence");
    }

    // ------------------------------------------ the DSP (fallback) generation
    //
    // These tests pin the fallback embedding and the DSP gates — old files
    // hold these prints forever, and any session without the model produces
    // them. They are the pre-TitaNet suite, pointed at `dsp_embed`.

    /// Two people through the identical room+mic channel (both quiet next to
    /// the shared noise floor — where the band deltas alone collapse and the
    /// mic lane used to stay one "You"): the pitch dims must reopen the split.
    /// And one person through that same channel must stay whole.
    #[test]
    fn two_voices_through_one_shared_mic_split_but_one_does_not() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(dan1) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan2) = say("Daniel", LINE_D) else { return };
        let prints: Vec<VoicePrint> = [&sam1, &dan1, &sam2, &dan2]
            .iter()
            .map(|x| dsp_embed(&far_mic_channel(x, 0.3)))
            .collect();
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0), Some(1), Some(0), Some(1)],
            "two people on one mic were not told apart"
        );

        let Some(sam3) = say("Samantha", LINE_B) else { return };
        let Some(sam4) = say("Samantha", LINE_D) else { return };
        let solo: Vec<VoicePrint> = [&sam1, &sam2, &sam3, &sam4]
            .iter()
            .map(|x| dsp_embed(&far_mic_channel(x, 0.3)))
            .collect();
        let refs: Vec<&VoicePrint> = solo.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0); 4],
            "one person on one mic was split in two"
        );
    }

    /// The harder version: two women through the one shared channel. Their
    /// pitches sit close, so this split must come from the band deltas — the
    /// pitch dims must not smear it shut.
    #[test]
    fn female_female_pair_through_one_shared_mic_splits() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(kar1) = say("Karen", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(kar2) = say("Karen", LINE_D) else { return };
        let prints: Vec<VoicePrint> = [&sam1, &kar1, &sam2, &kar2]
            .iter()
            .map(|x| dsp_embed(&far_mic_channel(x, 0.3)))
            .collect();
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(
            cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0), Some(1), Some(0), Some(1)],
            "two women on one mic were not told apart"
        );
    }

    /// A recording saved before the pitch dims holds 19-dim prints; resuming
    /// it (without the model) mixes them with 21-dim ones. Mixed-length DSP
    /// cosine must fall back to the band deltas and the mix must still
    /// cluster by voice, not by vintage.
    #[test]
    fn old_19_dim_prints_from_saved_files_still_cluster() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(dan1) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let new_prints = [dsp_embed(&sam1), dsp_embed(&dan1), dsp_embed(&sam2)];
        assert_eq!(new_prints[0].vec.len(), BANDS + 1);
        // What the old embed wrote: the same band deltas at unit norm.
        let old = |p: &VoicePrint| {
            let mut v = p.vec[..BANDS - 1].to_vec();
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
            v.iter_mut().for_each(|x| *x /= norm);
            VoicePrint { vec: v, voiced_frames: p.voiced_frames }
        };
        let (old_sam, old_dan) = (old(&new_prints[0]), old(&new_prints[1]));

        let same = cosine(&old_sam.vec, &new_prints[2].vec);
        let diff = cosine(&old_dan.vec, &new_prints[2].vec);
        assert!(same.is_finite() && diff.is_finite());
        assert!((-1.01..=1.01).contains(&same), "mixed-length cosine left [-1, 1]: {same}");
        assert!(same > diff, "old-vs-new same voice {same} under different voice {diff}");
        // Old-vs-new same-voice must score like old-vs-old, not systematically
        // lower — a deflated cross-generation score would split one voice in
        // two at the moment the file was resumed.
        let old_old = cosine(&old_sam.vec, &old(&new_prints[2]).vec);
        assert!((same - old_old).abs() < 1e-3, "resume deflated {old_old} to {same}");

        let mixed = [&old_sam, &new_prints[1], &new_prints[2]];
        assert_eq!(
            cluster(&mixed, &spans_for(mixed.len()), AUTO_MAX_SPEAKERS),
            vec![Some(0), Some(1), Some(0)],
            "a resumed old recording clustered by file vintage, not by voice"
        );
    }

    fn seg(speaker: &str, source: &str, voice: Option<VoicePrint>) -> RecSegment {
        // Distant timestamps (10 s apart, monotonic across the whole test
        // binary): the turn-continuity prior stays neutral, so these tests
        // measure clustering alone.
        static CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
        let t0 = CLOCK.fetch_add(1000, std::sync::atomic::Ordering::Relaxed);
        RecSegment {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.into(),
            speaker: speaker.into(),
            t0,
            t1: t0 + 300,
            text: "hi".into(),
            words: vec![],
            lang: None,
            voice,
        }
    }

    // ------------------------------------------- saved voices, across files
    //
    // The mechanism, on synthetic prints. The question these CANNOT answer —
    // does a real person's voice clear [`KNOWN_SAME`] from one recording to
    // the next, and does somebody else's stay under it — is measured on real
    // audio by `tests/diar_bench.rs::cross_recording_recognition`, which
    // sweeps the threshold and reports the false-accept rate. A rule with no
    // measurement behind it is a guess with a constant's name.

    /// Build an L2-normalized print `frames` long out of a direction vector.
    fn known_print(dir: &[f32], frames: usize) -> VoicePrint {
        let mut vec = vec![0.0f32; titanet::EMB_DIM];
        vec[..dir.len()].copy_from_slice(dir);
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        vec.iter_mut().for_each(|x| *x /= norm);
        VoicePrint { vec, voiced_frames: frames }
    }

    /// A print that sits `sim` away from `base` (cosine), in a direction
    /// nothing else in these tests uses.
    fn near(base: &VoicePrint, sim: f32) -> VoicePrint {
        let mut vec = base.vec.clone();
        let off = (1.0 - sim * sim).sqrt();
        vec.iter_mut().for_each(|x| *x *= sim);
        vec[titanet::EMB_DIM - 1] += off;
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        vec.iter_mut().for_each(|x| *x /= norm);
        VoicePrint { vec, voiced_frames: base.voiced_frames }
    }

    /// The one print that outlives a recording. Neural-only, and only once
    /// there is real speech behind it — a name typed on half a sentence is a
    /// fine label for that recording and far too little to recognise anyone by
    /// next week.
    #[test]
    fn a_voice_is_only_saved_once_there_is_enough_of_it() {
        let strong = known_print(&[1.0, 0.2], MIN_IDENTITY_FRAMES);
        assert!(identity_print(&[&strong]).is_some());

        let thin = known_print(&[1.0, 0.2], MIN_NEW_VOICE_FRAMES);
        assert!(
            identity_print(&[&thin]).is_none(),
            "a voice heard for a second became a permanent identity"
        );
        // …but the same second, five times over, is enough.
        let many: Vec<&VoicePrint> = (0..5).map(|_| &thin).collect();
        let built = identity_print(&many).expect("five strong phrases are evidence");
        assert_eq!(built.voiced_frames, MIN_NEW_VOICE_FRAMES * 5);

        // The generation wall: a DSP print can never become a saved voice,
        // because there is nothing it could ever be compared against.
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let dsp = dsp_embed(&sam);
        assert!(dsp.is_strong() && dsp.voiced_frames >= MIN_IDENTITY_FRAMES);
        assert!(identity_print(&[&dsp]).is_none(), "a DSP print was saved as an identity");
    }

    /// Recognition, and the three ways it must decline: too far, too close to
    /// call, and already spoken for.
    #[test]
    fn a_saved_voice_lands_only_when_it_is_unambiguous() {
        let dana = known_print(&[1.0, 0.0, 0.0], MIN_IDENTITY_FRAMES);
        let yossi = known_print(&[0.0, 1.0, 0.0], MIN_IDENTITY_FRAMES);
        let known = vec![
            KnownVoice { name: "Dana".into(), vec: dana.vec.clone(), rejects: vec![] },
            KnownVoice { name: "Yossi".into(), vec: yossi.vec.clone(), rejects: vec![] },
        ];

        // Her voice, a little different from the day it was saved.
        let hers = near(&dana, 0.80);
        assert_eq!(
            recognize_groups(&[Some(hers.clone())], &known, &[]),
            vec![Some("Dana".to_string())]
        );

        // A stranger. Above zero, nowhere near her.
        assert_eq!(recognize_groups(&[Some(near(&dana, 0.55))], &known, &[]), vec![None]);

        // A group with too little speech is not judged at all.
        assert_eq!(recognize_groups(&[None], &known, &[]), vec![None]);

        // The user already typed "Dana" on somebody else in this recording,
        // so she is not on offer — one person cannot be two speakers.
        assert_eq!(recognize_groups(&[Some(hers)], &known, &["Dana".to_string()]), vec![None]);

        // Two saved voices equally close is not two candidates, it is one
        // unanswered question. Built as the exact midpoint of the pair, so
        // the tie is a property of the fixture and not of the arithmetic.
        let twin = near(&dana, 0.90);
        let known_pair = [
            known[0].clone(),
            KnownVoice { name: "Twin".into(), vec: twin.vec.clone(), rejects: vec![] },
        ];
        let mut mid: Vec<f32> = dana.vec.iter().zip(&twin.vec).map(|(a, b)| a + b).collect();
        let norm = mid.iter().map(|x| x * x).sum::<f32>().sqrt();
        mid.iter_mut().for_each(|x| *x /= norm);
        let ambiguous = VoicePrint { vec: mid, voiced_frames: MIN_IDENTITY_FRAMES };
        assert!(cosine(&ambiguous.vec, &dana.vec) > KNOWN_SAME, "the fixture must clear the bar");
        assert_eq!(
            recognize_groups(&[Some(ambiguous)], &known_pair, &[]),
            vec![None],
            "the app picked one of two people it could not tell apart"
        );
    }

    /// One name, one group. Two people who both sound a bit like a saved
    /// voice must not take turns claiming it — the strongest agreement in the
    /// room settles first and the other is left as "Speaker N".
    #[test]
    fn one_saved_voice_cannot_be_two_people_in_the_same_recording() {
        let dana = known_print(&[1.0, 0.0, 0.0], MIN_IDENTITY_FRAMES);
        let known =
            vec![KnownVoice { name: "Dana".into(), vec: dana.vec.clone(), rejects: vec![] }];
        let weaker = near(&dana, 0.76);
        let stronger = near(&dana, 0.93);
        assert_eq!(
            recognize_groups(&[Some(weaker), Some(stronger)], &known, &[]),
            vec![None, Some("Dana".to_string())],
        );
    }

    /// A correction has to stick. Telling the room "that is not Dana" once
    /// must not leave it making the same claim in every future recording.
    #[test]
    fn a_corrected_guess_is_not_offered_again() {
        let dana = known_print(&[1.0, 0.0, 0.0], MIN_IDENTITY_FRAMES);
        let mistaken = near(&dana, 0.85);
        let known = vec![KnownVoice {
            name: "Dana".into(),
            vec: dana.vec.clone(),
            rejects: vec![mistaken.vec.clone()],
        }];
        assert_eq!(recognize_groups(&[Some(mistaken)], &known, &[]), vec![None]);
        // Dana herself is still Dana — the correction was about one voice,
        // not about the name.
        assert_eq!(
            recognize_groups(&[Some(near(&dana, 0.99))], &known, &[]),
            vec![Some("Dana".to_string())]
        );
    }

    /// End to end through the naming brain: a voice the room knows arrives in
    /// a new recording and gets her name, as a GUESS — while the mic's owner
    /// stays "You", because that is a position and not an identity.
    #[test]
    fn relabel_puts_a_saved_name_on_a_returning_voice() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(dan2) = say("Daniel", LINE_D) else { return };

        // What a previous recording would have saved for her.
        let hers = identity_print(&[&nembed(&sam), &nembed(&sam2)]).expect("enough speech");
        let known = vec![KnownVoice { name: "Dana".into(), vec: hers.vec, rejects: vec![] }];

        let mut segments = vec![
            seg("Speaker 1", "sys", Some(nembed(&sam))),
            seg("Speaker 2", "sys", Some(nembed(&dan))),
            seg("Speaker 1", "sys", Some(nembed(&sam2))),
            seg("Speaker 2", "sys", Some(nembed(&dan2))),
            seg("You", "mic", Some(nembed(&sam))),
        ];
        let (mut names, mut recognized) = (BTreeMap::new(), BTreeSet::new());
        relabel(&mut segments, 0, &mut Naming { names: &mut names, recognized: &mut recognized, known: &known });

        let her_label = &segments[0].speaker;
        assert_eq!(
            names.get(her_label).map(String::as_str),
            Some("Dana"),
            "the room had heard this voice before and did not say so: {names:?}"
        );
        assert!(recognized.contains("Dana"), "a guess must be marked as one");
        assert_eq!(segments[4].speaker, "You", "the microphone's owner is a position, not a name");
        assert!(
            !names.values().any(|n| n == "Dana" && names.len() > 1),
            "Dana was put on two speakers: {names:?}"
        );
    }

    /// The user's word is final. A name they typed is never re-guessed, never
    /// withdrawn, and never handed to anyone else.
    #[test]
    fn a_typed_name_outranks_every_saved_voice() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let hers = identity_print(&[&nembed(&sam), &nembed(&sam2)]).expect("enough speech");
        let known = vec![KnownVoice { name: "Dana".into(), vec: hers.vec, rejects: vec![] }];

        let mut segments = vec![
            seg("Speaker 1", "sys", Some(nembed(&sam))),
            seg("Speaker 1", "sys", Some(nembed(&sam2))),
            seg("Speaker 2", "sys", Some(nembed(&dan))),
        ];
        // The user has already said who this is, and it is not Dana.
        let mut names = BTreeMap::from([("Speaker 1".to_string(), "Michal".to_string())]);
        let mut recognized = BTreeSet::new();
        relabel(&mut segments, 0, &mut Naming { names: &mut names, recognized: &mut recognized, known: &known });
        assert_eq!(names.get(&segments[0].speaker).map(String::as_str), Some("Michal"));
        assert!(recognized.is_empty(), "the user's own name was recorded as a guess");
        assert!(!names.values().any(|n| n == "Dana"), "a saved voice overrode a typed name");
    }

    /// A guess is provisional by construction: when the evidence stops
    /// supporting it, it goes. Leaving a stale name on screen — indistinct
    /// from one the user typed — is the failure this feature has to avoid.
    #[test]
    fn a_guess_the_evidence_no_longer_supports_is_withdrawn() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let stranger =
            identity_print(&[&nembed(&dan)]).expect("one long phrase is enough to define one");
        let known = vec![KnownVoice { name: "Nobody".into(), vec: stranger.vec, rejects: vec![] }];

        let mut segments = vec![
            seg("Speaker 1", "sys", Some(nembed(&sam))),
            seg("Speaker 1", "sys", Some(nembed(&sam2))),
        ];
        // A guess made on evidence that has since moved on.
        let mut names = BTreeMap::from([("Speaker 1".to_string(), "Nobody".to_string())]);
        let mut recognized = BTreeSet::from(["Nobody".to_string()]);
        relabel(&mut segments, 0, &mut Naming { names: &mut names, recognized: &mut recognized, known: &known });
        assert!(names.is_empty(), "a name nothing supports stayed on screen: {names:?}");
        assert!(recognized.is_empty());
    }

    /// The property the whole feature rests on, stated the way the code
    /// actually relies on it: within one recording, same-speaker pairs sit
    /// clearly ABOVE different-speaker pairs. (The absolute values move with
    /// the words spoken — which is exactly why the threshold is relative.)
    #[test]
    fn same_voice_scores_above_different_voices() {
        let voices = ["Samantha", "Daniel", "Karen", "Fred", "Moira"];
        let mut prints = Vec::new();
        for v in voices {
            let (Some(a), Some(b)) = (say(v, LINE_A), say(v, LINE_B)) else {
                eprintln!("skipping: `say -v {v}` unavailable");
                return;
            };
            prints.push((dsp_embed(&a), dsp_embed(&b)));
        }
        let mut worst_same = f32::MAX;
        let mut best_diff = f32::MIN;
        for (i, (a1, b1)) in prints.iter().enumerate() {
            worst_same = worst_same.min(cosine(&a1.vec, &b1.vec));
            for (j, (a2, b2)) in prints.iter().enumerate() {
                if i == j {
                    continue;
                }
                for x in [a1, b1] {
                    for y in [a2, b2] {
                        best_diff = best_diff.max(cosine(&x.vec, &y.vec));
                    }
                }
            }
        }
        assert!(worst_same > best_diff, "same {worst_same} did not beat different {best_diff}");
    }

    /// A two-person conversation, nothing declared: `cluster` finds exactly
    /// two voices, numbered by first appearance — the meeting counts its own
    /// participants.
    #[test]
    fn cluster_discovers_two_real_voices_without_being_told() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(dan1) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan2) = say("Daniel", LINE_D) else { return };
        let prints = [dsp_embed(&sam1), dsp_embed(&dan1), dsp_embed(&sam2), dsp_embed(&dan2)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS);
        assert_eq!(ids, vec![Some(0), Some(1), Some(0), Some(1)], "wrong voice grouping");
    }

    /// One person talking is one speaker, however varied the sentences. The
    /// spread among their own phrases is wide (0.43–0.79 on device), so a
    /// naive widest-gap rule would cut a monologue in half here.
    #[test]
    fn cluster_keeps_a_single_speaker_whole() {
        let Some(a) = say("Samantha", LINE_A) else { return };
        let Some(b) = say("Samantha", LINE_B) else { return };
        let Some(c) = say("Samantha", LINE_C) else { return };
        let prints = [dsp_embed(&a), dsp_embed(&b), dsp_embed(&c)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS);
        assert_eq!(ids, vec![Some(0), Some(0), Some(0)], "split one voice into several");
    }

    /// The on-device QA regressions, both at once: a one-word reply
    /// ("Perfect.") and a later sentence from a speaker already heard must
    /// NOT become phantom participants. Both produced a "Speaker 3" in a
    /// two-person meeting before this design.
    #[test]
    fn short_reply_and_second_sentence_never_invent_speakers() {
        let Some(sam1) = say("Samantha", LINE_A) else { return };
        let Some(dan1) = say("Daniel", LINE_B) else { return };
        let Some(perfect) = say("Samantha", "Perfect.") else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let short = dsp_embed(&perfect);
        assert!(!short.is_strong(), "a one-word reply must not be able to define a voice");

        let prints = [dsp_embed(&sam1), dsp_embed(&dan1), short, dsp_embed(&sam2)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, &spans_for(refs.len()), AUTO_MAX_SPEAKERS);
        assert_eq!(
            ids,
            vec![Some(0), Some(1), Some(0), Some(0)],
            "the meeting had two people; clustering said otherwise"
        );
    }

    /// Historically the DSP fallback's weakness: two people uttering the
    /// SAME sentence looked alike to a spectral voiceprint. The pitch dims
    /// fixed that — an F/M same-sentence pair now measures ≈ 0.41, well
    /// under the split bar. Pinned so the fallback's ability to tell two
    /// voices apart on identical text can't silently regress.
    #[test]
    fn same_sentence_is_the_hard_case() {
        let (Some(sam), Some(dan)) = (say("Samantha", LINE_A), say("Daniel", LINE_A)) else {
            return;
        };
        let sim = cosine(&dsp_embed(&sam).vec, &dsp_embed(&dan).vec);
        let anchor = DSP_GATES.split;
        assert!(
            sim < anchor,
            "identical sentences from two voices scored {sim} — at or above the split bar \
             {anchor} the DSP fallback would merge two people again"
        );
    }

    /// An explicit cap still collapses extra voices (one-on-one recordings).
    #[test]
    fn explicit_cap_prevents_speaker_inflation() {
        let (Some(sam), Some(dan)) = (say("Samantha", LINE_A), say("Daniel", LINE_B)) else {
            return;
        };
        let prints = [dsp_embed(&sam), dsp_embed(&dan)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(cluster(&refs, &spans_for(refs.len()), 1), vec![Some(0), Some(0)], "capped at one participant");

        let mut book = SpeakerBook::with_cap(1);
        assert_eq!(book.assign(Some(&dsp_embed(&sam))), "Speaker 1");
        assert_eq!(book.assign(Some(&dsp_embed(&dan))), "Speaker 1");
    }

    /// `relabel` rewrites provisional labels in place, names the mic-dominant
    /// voice "You", leaves pre-ADD-27 segments alone, and reports whether
    /// anything moved.
    #[test]
    fn relabel_fixes_meeting_labels_and_finds_you() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan2) = say("Daniel", LINE_D) else { return };
        let mut segments = vec![
            seg("Speaker 1", "sys", Some(dsp_embed(&sam))),
            // The person at the Mac, heard twice on the microphone.
            seg("You", "mic", Some(dsp_embed(&dan))),
            // What the live pass got wrong: a third voice that never existed.
            seg("Speaker 3", "sys", Some(dsp_embed(&sam2))),
            seg("You", "mic", Some(dsp_embed(&dan2))),
            seg("Speaker 9", "sys", None), // legacy row, no voiceprint
        ];
        assert!(relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())), "expected a correction");
        assert_eq!(segments[0].speaker, "Speaker 1");
        assert_eq!(segments[1].speaker, "You", "the mic-dominant voice is you");
        assert_eq!(segments[2].speaker, "Speaker 1", "phantom speaker survived");
        assert_eq!(segments[3].speaker, "You");
        assert_eq!(segments[4].speaker, "Speaker 9", "legacy segment must be left alone");
        // Idempotent: a second pass changes nothing.
        assert!(!relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())));
    }

    /// A re-cluster must not renumber people who never changed. First-
    /// appearance numbering used to shuffle every label whenever the
    /// clustering shifted mid-meeting — which read as misrecognition.
    #[test]
    fn relabel_keeps_established_numbers() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        // On screen for minutes already, in the opposite of first-appearance
        // order (a live pass can produce this).
        let mut segments = vec![
            seg("Speaker 2", "sys", Some(dsp_embed(&sam))),
            seg("Speaker 1", "sys", Some(dsp_embed(&dan))),
            seg("Speaker 2", "sys", Some(dsp_embed(&sam2))),
        ];
        assert!(!relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())), "nothing moved, so nothing may change");
        assert_eq!(segments[0].speaker, "Speaker 2");
        assert_eq!(segments[1].speaker, "Speaker 1");
        assert_eq!(segments[2].speaker, "Speaker 2");
    }

    /// A label backed by a single phrase keeps whatever number the live pass
    /// minted ("Speaker 6" in a two-person call, after phantom voices came
    /// and went). It isn't established — it takes the lowest free number.
    #[test]
    fn a_barely_seen_label_is_renumbered_compactly() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let mut segments = vec![
            seg("Speaker 1", "sys", Some(dsp_embed(&sam))),
            seg("Speaker 1", "sys", Some(dsp_embed(&sam2))),
            seg("Speaker 6", "sys", Some(dsp_embed(&dan))),
        ];
        relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new()));
        assert_eq!(segments[0].speaker, "Speaker 1");
        assert_eq!(segments[1].speaker, "Speaker 1");
        assert_eq!(segments[2].speaker, "Speaker 2", "the stray high number must compact");
    }

    /// One remote speaker whose live labels drifted (a resumed file numbers a
    /// returning voice afresh) must be folded back into one — a lone voice
    /// still needs relabeling.
    #[test]
    fn a_lone_drifted_voice_is_merged_back() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let Some(sam3) = say("Samantha", LINE_D) else { return };
        let mut segments = vec![
            seg("Speaker 1", "sys", Some(dsp_embed(&sam))),
            seg("Speaker 1", "sys", Some(dsp_embed(&sam2))),
            seg("Speaker 2", "sys", Some(dsp_embed(&sam3))), // the resume's fresh number
        ];
        assert!(relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())), "the drifted label was never corrected");
        assert!(segments.iter().all(|s| s.speaker == "Speaker 1"), "{segments:?}");
    }

    /// The bug this fixes: a colleague sitting next to you shares your
    /// microphone, and used to be labeled "You" for it.
    #[test]
    fn a_second_person_on_the_mic_is_not_you() {
        let Some(dan) = say("Daniel", LINE_A) else { return };
        let Some(dan2) = say("Daniel", LINE_C) else { return };
        let Some(sam) = say("Samantha", LINE_B) else { return };
        let mut segments = vec![
            seg("You", "mic", Some(dsp_embed(&dan))),
            seg("You", "mic", Some(dsp_embed(&sam))), // in the room, not at the Mac
            seg("You", "mic", Some(dsp_embed(&dan2))),
        ];
        assert!(relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new())), "the room's second voice went unnoticed");
        assert_eq!(segments[0].speaker, "You", "most of the mic's speech is yours");
        assert_eq!(segments[1].speaker, "Speaker 1");
        assert_eq!(segments[2].speaker, "You");
    }

    /// Recording a meeting you never speak in: every voice arrives on the
    /// system lane, so none of them is "You".
    #[test]
    fn nobody_is_you_when_the_mic_never_spoke() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let mut segments = vec![
            seg("x", "sys", Some(dsp_embed(&sam))),
            seg("x", "sys", Some(dsp_embed(&dan))),
            seg("x", "sys", Some(dsp_embed(&sam2))),
        ];
        relabel(&mut segments, 0, &mut Naming::plain(&mut BTreeMap::new(), &mut BTreeSet::new()));
        assert!(
            segments.iter().all(|s| s.speaker != "You"),
            "a voice the microphone never heard was called 'You'",
        );
        assert_eq!(segments[0].speaker, "Speaker 1");
        assert_eq!(segments[1].speaker, "Speaker 2");
        assert_eq!(segments[2].speaker, "Speaker 1");
    }

    /// GH #5: a name is attached to a VOICE, not to the label string. When a
    /// re-cluster moves a group's number, the name the user typed moves with
    /// it — it used to stay on the number and land on somebody else's lines.
    #[test]
    fn a_typed_name_follows_its_voice_when_the_label_moves() {
        let unit = |axis: usize| {
            let mut vec = vec![0.0f32; BANDS - 1];
            vec[axis] = 1.0;
            VoicePrint { vec, voiced_frames: MIN_NEW_VOICE_FRAMES * 2 }
        };
        // One voice, mislabeled by the live pass as two: the second half went
        // out under "Speaker 2" and the user named THAT one "Dana".
        let mut segments = vec![
            seg("Speaker 1", "sys", Some(unit(0))),
            seg("Speaker 2", "sys", Some(unit(0))),
            seg("Speaker 2", "sys", Some(unit(0))),
        ];
        let mut names = BTreeMap::from([("Speaker 2".to_string(), "Dana".to_string())]);
        assert!(relabel(&mut segments, 0, &mut Naming::plain(&mut names, &mut BTreeSet::new())), "the split labels were never merged");
        let merged = segments[0].speaker.clone();
        assert!(segments.iter().all(|s| s.speaker == merged), "{segments:?}");
        assert_eq!(
            names.get(merged.as_str()).map(String::as_str),
            Some("Dana"),
            "the name did not follow the voice: {names:?}",
        );
        assert_eq!(names.len(), 1, "a stale entry was left behind: {names:?}");
    }

    /// The name map is rebuilt, not edited in place, so two voices trading
    /// numbers trade their names too instead of one overwriting the other.
    #[test]
    fn swapped_labels_swap_their_names() {
        let mut names = BTreeMap::from([
            ("Speaker 1".to_string(), "Ana".to_string()),
            ("Speaker 2".to_string(), "Ben".to_string()),
            ("Speaker 3".to_string(), "Cy".to_string()),
        ]);
        move_names(
            &mut names,
            &[
                ("Speaker 1".to_string(), "Speaker 2".to_string()),
                ("Speaker 2".to_string(), "Speaker 1".to_string()),
            ],
        );
        assert_eq!(names.get("Speaker 1").map(String::as_str), Some("Ben"));
        assert_eq!(names.get("Speaker 2").map(String::as_str), Some("Ana"));
        // A label nothing moved away from keeps its name.
        assert_eq!(names.get("Speaker 3").map(String::as_str), Some("Cy"));

        // A voice that left the transcript takes its name with it rather than
        // leaving it for whoever inherits the number.
        let mut gone = BTreeMap::from([("Speaker 2".to_string(), "Dana".to_string())]);
        move_names(&mut gone, &[("Speaker 2".to_string(), "You".to_string())]);
        assert_eq!(gone, BTreeMap::from([("You".to_string(), "Dana".to_string())]));
    }

    #[test]
    fn silence_embeds_to_zero_and_gets_default_label() {
        // The real entry point: silence never reaches the model at all.
        let e = embed(&vec![0.0f32; SAMPLE_RATE]);
        assert!(e.is_silent());
        let mut book = SpeakerBook::auto();
        assert_eq!(book.assign(Some(&e)), "Speaker 1");
        assert_eq!(book.assign(None), "Speaker 1");
        // A silent print belongs to no voice at all.
        assert_eq!(cluster(&[&e], &spans_for(1), AUTO_MAX_SPEAKERS), vec![None]);
    }

    /// The distribution-driven cut, checked against both measured DSP regimes
    /// (see the gate docs) with the DSP gates.
    
    /// A resumed recording keeps numbering after the speakers already shown,
    /// for segments whose voiceprints predate ADD-27 and can't be re-clustered.
    #[test]
    fn resume_numbers_after_known_speakers() {
        let mut book = SpeakerBook::auto();
        book.seed_labels(&[
            seg("Speaker 1", "sys", None),
            seg("Speaker 2", "sys", None),
            seg("You", "mic", None),
        ]);
        let mut vec = vec![0.0f32; BANDS - 1];
        vec[0] = 1.0;
        let print = VoicePrint { vec, voiced_frames: MIN_NEW_VOICE_FRAMES };
        assert_eq!(book.assign(Some(&print)), "Speaker 3");
        // The same voice again keeps its new number.
        assert_eq!(book.assign(Some(&print)), "Speaker 3");
    }

    /// At the sub-window scale, a cluster of a few windows (~2 s of speech)
    /// must not register as its own speaker — it joins an existing voice —
    /// while the two real voices stay apart (the floor-of-two guard).
    #[test]
    fn window_scale_phantom_is_absorbed() {
        let unit = |axis: usize, frames: usize| {
            let mut vec = vec![0.0f32; BANDS - 1];
            vec[axis] = 1.0;
            VoicePrint { vec, voiced_frames: frames }
        };
        let mut prints: Vec<VoicePrint> = Vec::new();
        for _ in 0..30 {
            prints.push(unit(0, 70)); // voice A: plenty of mass
        }
        for _ in 0..25 {
            prints.push(unit(1, 70)); // voice B: plenty of mass
        }
        for _ in 0..3 {
            prints.push(unit(2, 65)); // distinct but tiny: 195 frames < bar
        }
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let spans: Vec<(i64, i64)> =
            (0..prints.len()).map(|i| (i as i64 * 75, i as i64 * 75 + 150)).collect();
        let ids = cluster_gated(&refs, &spans, 8, SPLIT_MIN_VOICE_FRAMES);
        let a = ids[0].expect("voice A labeled");
        let b = ids[35].expect("voice B labeled");
        assert_ne!(a, b, "the two real voices merged");
        for id in &ids[..30] {
            assert_eq!(*id, Some(a), "voice A fragmented");
        }
        for id in &ids[30..55] {
            assert_eq!(*id, Some(b), "voice B fragmented");
        }
        for id in &ids[55..] {
            let got = id.expect("phantom windows labeled");
            assert!(got == a || got == b, "tiny cluster founded speaker {got}");
        }
    }

    /// The evidence bar the clusterer applies IS `VoicePrint::defines_voice`,
    /// at whichever scale the pass runs on — there is no second, hand-written
    /// copy of the rule that could drift away from the one under test.
    #[test]
    fn defines_voice_is_the_bar_the_clusterer_uses() {
        let print = |frames: usize| {
            let mut vec = vec![0.0f32; BANDS - 1];
            vec[0] = 1.0;
            VoicePrint { vec, voiced_frames: frames }
        };
        // Between the two scales: a sub-window may define a voice, a phrase
        // that short may not.
        let middling = print(SPLIT_MIN_VOICE_FRAMES + 1);
        assert!(middling.defines_voice(SPLIT_MIN_VOICE_FRAMES));
        assert!(!middling.defines_voice(MIN_NEW_VOICE_FRAMES));
        assert!(!middling.is_strong(), "is_strong is the phrase scale");
        assert!(print(MIN_NEW_VOICE_FRAMES).is_strong());
        // Silence never defines a voice, however many frames it claims.
        let silent = VoicePrint { vec: vec![0.0f32; BANDS - 1], voiced_frames: 10_000 };
        assert!(!silent.defines_voice(1));

        // And the clusterer agrees: with only sub-bar prints there is nothing
        // to found a voice on, so everyone who spoke collapses onto one.
        let prints = vec![middling.clone(), middling.clone(), print(SPLIT_MIN_VOICE_FRAMES)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let spans: Vec<(i64, i64)> =
            (0..prints.len()).map(|i| (i as i64 * 300, i as i64 * 300 + 200)).collect();
        assert_eq!(
            cluster_gated(&refs, &spans, 8, MIN_NEW_VOICE_FRAMES),
            vec![Some(0), Some(0), Some(0)]
        );
    }
}
