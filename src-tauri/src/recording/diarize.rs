//! ADD-27: lightweight ON-LINE speaker separation for the meeting lane.
//!
//! The microphone lane is always "You" — that separation is structural and
//! free. Voices arriving through system audio (everyone else on a Meet/Zoom/
//! Teams call) are told apart by a small spectral voiceprint, clustered online
//! against a cosine threshold and capped at the room's participant count. No
//! ML model, no download, runs in microseconds — deliberately "good
//! separation", not perfect diarization, and labeled as such in the UI. The
//! embedding lives behind this module boundary so a real speaker-embedding
//! model can replace it without touching the engine.
//!
//! The voiceprint is the phrase's mean log-mel envelope reduced to its
//! *band-to-band deltas*. Differencing removes both overall loudness and any
//! constant spectral tilt (mic, codec, distance), leaving the formant shape —
//! which is what actually tells two voices apart.
//!
//! Pitch is deliberately NOT part of the vector: per-utterance F0 estimates
//! swing up to 20% *within* one speaker (Daniel: 113 → 137 Hz), so folding it
//! in shrank the same/different margin instead of widening it.
//!
//! ## Why the threshold is relative, not a constant
//!
//! Cosine between two phrases depends on *what was said* and on the audio
//! path, not only on who said it. Measured on this machine:
//!
//! | | different speakers | same speaker |
//! |---|---|---|
//! | clean `say` audio, different sentences | 0.30 – 0.57 | 0.86 – 0.94 |
//! | the same material mixed + VAD-trimmed in the engine | 0.05 – 0.13 | 0.43 – 0.79 |
//! | clean audio, both reading the SAME sentence | ~0.84 | — |
//!
//! No fixed gate survives that table. What does survive is the **separation**:
//! inside any one recording, same-speaker pairs sit clearly above
//! different-speaker pairs. So [`cluster`] reads the recording's own
//! similarity distribution, cuts it where the two groups stand furthest apart
//! (Otsu), and groups from there.
//!
//! Labels therefore improve as the conversation grows — the engine re-clusters
//! every couple of phrases and tells the UI, which is what makes speakers
//! "sort themselves out" while people are still talking, with nobody ever
//! asked how many are in the room. The last row of the table is the known
//! weakness; the design answers it by merging rather than inventing a
//! participant (`same_sentence_is_the_hard_case`).

use serde::{Deserialize, Serialize};

use super::{RecSegment, SAMPLE_RATE};

/// Analysis window for the voiceprint (32 ms) and its hop (16 ms).
const WIN: usize = 512;
const HOP: usize = 256;
/// Mel-spaced bands between 100 Hz and 4 kHz — where voices differ.
const BANDS: usize = 20;
/// Frames quieter than this contribute nothing (pauses must not dilute a print).
const VOICED_RMS: f32 = 0.004;
/// Provisional gate for the LIVE label of a phrase, before the recording has
/// enough material to cluster properly. Deliberately loose: a live label is a
/// hint that [`cluster`] corrects on the next flush, and under-splitting reads
/// far better on screen than a parade of phantom speakers.
const ONLINE_SAME: f32 = 0.35;
/// Voiced frames (16 ms hop) a phrase must carry before it can define a voice
/// — about 0.8 s of actual speech. A one-word reply ("Perfect.") has too
/// little spectrum to trust: it joins the nearest known voice instead of
/// inventing a participant who was never in the room.
const MIN_NEW_VOICE_FRAMES: usize = 50;

/// Safety ceiling when the participant count is discovered rather than given
/// (the normal case). Far above a real meeting's distinct voices, so it only
/// ever stops pathological runaway labeling.
const AUTO_MAX_SPEAKERS: usize = 8;

/// The similarity distribution must break at least this wide for [`cluster`]
/// to believe the recording holds more than one voice. Below it, every phrase
/// is one person talking about different things.
const MIN_SPLIT_GAP: f32 = 0.15;

/// A split is only believed when the pairs BELOW the cut are genuinely unlike
/// each other. Two phrases more similar than this are the same person whatever
/// the rest of the distribution looks like — the guard that keeps a monologue
/// whole when its own phrases happen to spread out.
const MAX_SPLIT_CUT: f32 = 0.80;

/// With only one pair there is no distribution to read, so the split falls
/// back to an absolute anchor. Deliberately low: from two phrases alone, only
/// clearly unlike voices are called two people. (Absolute similarity is
/// otherwise untrustworthy — clean audio puts different speakers at 0.30–0.57
/// and one voice at 0.86–0.94, while the same material mixed and VAD-trimmed
/// on device gives 0.05–0.13 and 0.43–0.79.)
const LONE_PAIR_SPLIT: f32 = 0.30;

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

/// One phrase's voiceprint plus how much real speech went into it — the
/// vector alone can't say whether it is trustworthy. Stored with its segment
/// so the whole recording can be re-clustered later (including after a
/// pause/resume, or when an old file is reopened).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoicePrint {
    /// L2-normalized, so cosine similarity is a plain dot product. All zeros
    /// when the phrase held no voiced audio at all.
    #[serde(rename = "v")]
    pub vec: Vec<f32>,
    #[serde(rename = "f")]
    pub voiced_frames: usize,
}

impl VoicePrint {
    pub fn is_silent(&self) -> bool {
        self.voiced_frames == 0 || self.vec.iter().all(|x| *x == 0.0)
    }

    /// Enough speech to define a voice rather than merely be labeled with one.
    pub fn is_strong(&self) -> bool {
        self.voiced_frames >= MIN_NEW_VOICE_FRAMES && !self.is_silent()
    }
}

/// The phrase's voiceprint (see module docs): band-to-band deltas of the mean
/// log-mel envelope. Silence embeds to all-zeros, which [`SpeakerBook::assign`]
/// treats as unknown.
pub fn embed(samples: &[f32]) -> VoicePrint {
    let centers = band_centers();
    let mut means = [0f32; BANDS];
    let mut frames = 0usize;
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
    }
    if frames == 0 {
        return VoicePrint { vec: vec![0.0; BANDS - 1], voiced_frames: 0 };
    }
    let nf = frames as f32;
    let env: Vec<f32> = means.iter().map(|m| m / nf).collect();
    let mut v: Vec<f32> = (0..BANDS - 1).map(|i| env[i + 1] - env[i]).collect();
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x /= norm);
    VoicePrint { vec: v, voiced_frames: frames }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

// ------------------------------------------------------- global clustering

/// Where to cut this recording's similarity distribution, chosen from the
/// distribution itself (see module docs). `None` → one voice, merge all.
///
/// Otsu's method splits the pairwise similarities into the two groups with
/// the greatest separation — "different people" and "same person, other
/// words". Picking the single widest gap is NOT enough: in real recordings
/// the spread *among* one speaker's own phrases (0.43 → 0.76) can exceed the
/// valley between speakers (0.13 → 0.43).
///
/// Two guards then decide whether the split is real. Both are about the shape
/// of the distribution, not absolute similarity, because absolute similarity
/// moves with the audio path — see [`LONE_PAIR_SPLIT`]. What survives both
/// regimes is that two voices leave the groups standing well apart, and that
/// one voice never leaves its own phrases as unlike each other as two people.
fn split_threshold(mut sims: Vec<f32>) -> Option<f32> {
    match sims.len() {
        0 => return None,
        // A lone pair has no distribution to read; the absolute anchor decides.
        1 => return (sims[0] < LONE_PAIR_SPLIT).then_some(LONE_PAIR_SPLIT),
        _ => {}
    }
    sims.sort_by(f32::total_cmp);
    let n = sims.len();
    let total: f32 = sims.iter().sum();
    let (mut best_score, mut best_k) = (f32::MIN, 1usize);
    let mut low_sum = 0.0f32;
    for k in 1..n {
        low_sum += sims[k - 1];
        let (w0, w1) = (k as f32 / n as f32, (n - k) as f32 / n as f32);
        let mu0 = low_sum / k as f32;
        let mu1 = (total - low_sum) / (n - k) as f32;
        // Otsu: maximize between-class variance.
        let score = w0 * w1 * (mu1 - mu0).powi(2);
        if score > best_score {
            best_score = score;
            best_k = k;
        }
    }
    let cut = (sims[best_k - 1] + sims[best_k]) / 2.0;
    let gap = sims[best_k] - sims[best_k - 1];
    if gap < MIN_SPLIT_GAP || cut > MAX_SPLIT_CUT {
        return None; // one voice, however varied its sentences
    }
    Some(cut)
}

/// Average-linkage similarity between two clusters of prints.
fn linkage(a: &[usize], b: &[usize], prints: &[&VoicePrint]) -> f32 {
    let mut sum = 0.0;
    for i in a {
        for j in b {
            sum += cosine(&prints[*i].vec, &prints[*j].vec);
        }
    }
    sum / (a.len() * b.len()) as f32
}

/// Group a whole recording's phrases into voices, using only the recording's
/// own similarity structure — no absolute threshold, no participant count.
///
/// Strong phrases (≥ ~0.8 s of speech) define the voices by agglomerative
/// average-linkage merging down to the distribution's widest gap; short
/// phrases are then attached to whichever voice they sound most like, without
/// ever creating one. Returns a cluster index per input print, numbered by
/// first appearance, or `None` for prints that carry no voice at all.
pub fn cluster(prints: &[&VoicePrint], max_speakers: usize) -> Vec<Option<usize>> {
    let strong: Vec<usize> = (0..prints.len()).filter(|i| prints[*i].is_strong()).collect();
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

    let pair_sims: Vec<f32> = strong
        .iter()
        .enumerate()
        .flat_map(|(a, i)| {
            strong[a + 1..]
                .iter()
                .map(|j| cosine(&prints[*i].vec, &prints[*j].vec))
                .collect::<Vec<_>>()
        })
        .collect();
    let threshold = split_threshold(pair_sims);

    // Every strong phrase starts as its own voice; merge the closest pair
    // while they are closer than the cut (None → one voice: merge all).
    let mut clusters: Vec<Vec<usize>> = strong.iter().map(|i| vec![*i]).collect();
    loop {
        if clusters.len() == 1 {
            break;
        }
        let mut best: Option<(usize, usize, f32)> = None;
        for a in 0..clusters.len() {
            for b in a + 1..clusters.len() {
                let sim = linkage(&clusters[a], &clusters[b], prints);
                if best.map_or(true, |(_, _, s)| sim > s) {
                    best = Some((a, b, sim));
                }
            }
        }
        let Some((a, b, sim)) = best else { break };
        let over_cap = clusters.len() > max_speakers.max(1);
        // Past the cap, keep merging the nearest pair regardless of the cut.
        match threshold {
            Some(t) if sim < t && !over_cap => break,
            None | Some(_) => {}
        }
        let moved = clusters.remove(b);
        clusters[a].extend(moved);
    }

    // Number the voices by when each was first heard.
    clusters.sort_by_key(|c| c.iter().copied().min().unwrap_or(usize::MAX));
    for (id, members) in clusters.iter().enumerate() {
        for i in members {
            out[*i] = Some(id);
        }
    }

    // Short phrases join the voice they sound most like — never make a new one.
    for (i, p) in prints.iter().enumerate() {
        if out[i].is_some() || p.is_silent() {
            continue;
        }
        out[i] = clusters
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                linkage(&[i], a, prints).total_cmp(&linkage(&[i], b, prints))
            })
            .map(|(id, _)| id);
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
        let best = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, (c, _))| (i, cosine(emb, c)))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        // A new voice needs both room under the cap and enough speech.
        let may_open = self.centroids.len() < self.room_left() && print.is_strong();
        let idx = match best {
            Some((i, sim)) if sim >= ONLINE_SAME => i,
            _ if may_open => {
                self.centroids.push((emb.clone(), 0));
                self.centroids.len() - 1
            }
            // Too short to trust, or the cap is reached: the nearest known
            // voice wins; with no voices yet, this phrase starts the first.
            Some((i, _)) => i,
            None => {
                self.centroids.push((emb.clone(), 0));
                0
            }
        };
        let (c, n) = &mut self.centroids[idx];
        if *n > 0 && print.is_strong() {
            // Running-mean centroid, frozen after enough evidence so one odd
            // phrase can't drag an established voice away. Short phrases are
            // labeled but never reshape a voice.
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

/// Re-label every meeting phrase in `segments` from the whole recording's
/// voices (see [`cluster`]). Mic phrases ("You") and phrases from before
/// voiceprints were stored are left exactly as they are. Returns true when a
/// label actually moved, so the caller can tell the UI.
pub fn relabel(segments: &mut [RecSegment], max_speakers: usize) -> bool {
    let idx: Vec<usize> = (0..segments.len())
        .filter(|i| segments[*i].source == "sys" && segments[*i].voice.is_some())
        .collect();
    if idx.len() < 2 {
        return false;
    }
    let prints: Vec<&VoicePrint> =
        idx.iter().map(|i| segments[*i].voice.as_ref().expect("filtered")).collect();
    let cap = if max_speakers == 0 { AUTO_MAX_SPEAKERS } else { max_speakers };
    let ids = cluster(&prints, cap);
    let mut changed = false;
    for (slot, id) in idx.iter().zip(ids) {
        let Some(id) = id else { continue };
        let name = format!("Speaker {}", id + 1);
        if segments[*slot].speaker != name {
            segments[*slot].speaker = name;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    // A conversation: every turn says something different, the way meetings
    // actually go. (Two people reading the SAME sentence is the one case this
    // representation struggles with — see `same_sentence_is_the_hard_case`.)
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

    fn seg(speaker: &str, source: &str, voice: Option<VoicePrint>) -> RecSegment {
        RecSegment {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.into(),
            speaker: speaker.into(),
            t0: 0,
            t1: 1,
            text: "hi".into(),
            words: vec![],
            lang: None,
            voice,
        }
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
            prints.push((embed(&a), embed(&b)));
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
        let prints = [embed(&sam1), embed(&dan1), embed(&sam2), embed(&dan2)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, AUTO_MAX_SPEAKERS);
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
        let prints = [embed(&a), embed(&b), embed(&c)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, AUTO_MAX_SPEAKERS);
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
        let short = embed(&perfect);
        assert!(!short.is_strong(), "a one-word reply must not be able to define a voice");

        let prints = [embed(&sam1), embed(&dan1), short, embed(&sam2)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        let ids = cluster(&refs, AUTO_MAX_SPEAKERS);
        assert_eq!(
            ids,
            vec![Some(0), Some(1), Some(0), Some(0)],
            "the meeting had two people; clustering said otherwise"
        );
    }

    /// The documented weakness, pinned so it can't regress silently: two
    /// different people uttering the SAME sentence look alike to a spectral
    /// voiceprint. The design's answer is to under-split (merge) rather than
    /// invent a participant — a wrong name on a line beats a fake attendee.
    #[test]
    fn same_sentence_is_the_hard_case() {
        let (Some(sam), Some(dan)) = (say("Samantha", LINE_A), say("Daniel", LINE_A)) else {
            return;
        };
        let sim = cosine(&embed(&sam).vec, &embed(&dan).vec);
        assert!(
            sim > LONE_PAIR_SPLIT,
            "identical sentences from two voices scored {sim} — if this ever drops below \
             {LONE_PAIR_SPLIT}, the merge-instead-of-invent tradeoff can be revisited"
        );
    }

    /// An explicit cap still collapses extra voices (one-on-one recordings).
    #[test]
    fn explicit_cap_prevents_speaker_inflation() {
        let (Some(sam), Some(dan)) = (say("Samantha", LINE_A), say("Daniel", LINE_B)) else {
            return;
        };
        let prints = [embed(&sam), embed(&dan)];
        let refs: Vec<&VoicePrint> = prints.iter().collect();
        assert_eq!(cluster(&refs, 1), vec![Some(0), Some(0)], "capped at one participant");

        let mut book = SpeakerBook::with_cap(1);
        assert_eq!(book.assign(Some(&embed(&sam))), "Speaker 1");
        assert_eq!(book.assign(Some(&embed(&dan))), "Speaker 1");
    }

    /// `relabel` rewrites provisional labels in place, leaves "You" and
    /// pre-ADD-27 segments alone, and reports whether anything moved.
    #[test]
    fn relabel_fixes_meeting_labels_and_spares_the_mic() {
        let Some(sam) = say("Samantha", LINE_A) else { return };
        let Some(dan) = say("Daniel", LINE_B) else { return };
        let Some(sam2) = say("Samantha", LINE_C) else { return };
        let mut segments = vec![
            seg("Speaker 1", "sys", Some(embed(&sam))),
            seg("You", "mic", None),
            seg("Speaker 2", "sys", Some(embed(&dan))),
            // What the live pass got wrong: a third voice that never existed.
            seg("Speaker 3", "sys", Some(embed(&sam2))),
            seg("Speaker 9", "sys", None), // legacy row, no voiceprint
        ];
        assert!(relabel(&mut segments, 0), "expected a correction");
        assert_eq!(segments[0].speaker, "Speaker 1");
        assert_eq!(segments[1].speaker, "You", "mic phrase must stay 'You'");
        assert_eq!(segments[2].speaker, "Speaker 2");
        assert_eq!(segments[3].speaker, "Speaker 1", "phantom speaker survived");
        assert_eq!(segments[4].speaker, "Speaker 9", "legacy segment must be left alone");
        // Idempotent: a second pass changes nothing.
        assert!(!relabel(&mut segments, 0));
    }

    #[test]
    fn silence_embeds_to_zero_and_gets_default_label() {
        let e = embed(&vec![0.0f32; SAMPLE_RATE]);
        assert!(e.is_silent());
        let mut book = SpeakerBook::auto();
        assert_eq!(book.assign(Some(&e)), "Speaker 1");
        assert_eq!(book.assign(None), "Speaker 1");
        // A silent print belongs to no voice at all.
        assert_eq!(cluster(&[&e], AUTO_MAX_SPEAKERS), vec![None]);
    }

    /// The distribution-driven cut, checked against both measured regimes
    /// (see the table in the module docs).
    #[test]
    fn split_threshold_reads_the_distribution() {
        // On-device, two people: different voices ≤ 0.13, same voice 0.43–0.79.
        // The widest SINGLE gap here is 0.430→0.758 — inside one speaker —
        // which is exactly why this is not a max-gap rule.
        let t = split_threshold(vec![0.055, 0.081, 0.126, 0.430, 0.758, 0.785]).unwrap();
        assert!((0.126..0.430).contains(&t), "cut {t} fell outside the valley");

        // Clean audio, two people: everything shifts up, the cut follows.
        let t = split_threshold(vec![0.2966, 0.3779, 0.5037, 0.5748, 0.8634, 0.9408]).unwrap();
        assert!((0.5748..0.8634).contains(&t), "cut {t} fell outside the valley");

        // One voice, varied sentences: pairs stay too alike for any cut.
        assert_eq!(split_threshold(vec![0.83, 0.86, 0.88]), None);
        // Even a wide gap can't split when both groups are clearly one person.
        assert_eq!(split_threshold(vec![0.81, 0.82, 0.99]), None);

        // A lone pair has no distribution — fall back to the absolute anchor.
        assert_eq!(split_threshold(vec![0.10]), Some(LONE_PAIR_SPLIT));
        assert_eq!(split_threshold(vec![0.75]), None);
        assert_eq!(split_threshold(vec![]), None);
    }

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
}

