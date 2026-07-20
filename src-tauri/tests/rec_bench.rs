//! Real-audio benchmark for the recording pipeline — not a pass/fail test.
//!
//! Runs the app's own offline pipeline (`recording::retranscribe`: energy VAD
//! → whisper → per-phrase voiceprints → clustering) over a real meeting WAV
//! and reports what a user would see: the transcript, the speaker count, and
//! — when ground truth is supplied — diarization error rate (DER) and word
//! recall. This exists because synthetic `say` fixtures kept passing while
//! real far-field meeting audio regressed (missed speech, phantom speakers).
//!
//! Usage:
//!   PR_BENCH_WAV=/path/meeting.wav \
//!   PR_BENCH_RTTM=/path/truth.rttm          # optional: DER vs reference
//!   PR_BENCH_REFWORDS=/path/words.tsv       # optional: word<TAB>seconds
//!   PR_BENCH_SECONDS=600                    # optional: trim the audio
//!   PR_BENCH_OUT=/path/transcript.txt       # optional: dump transcript
//!   cargo test --test rec_bench -- --ignored --nocapture

use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn model() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    let downloaded = PathBuf::from(home)
        .join("Library/Application Support/com.benreich.privateroom/models")
        .join(arcelle_lib::stt::MODEL_FILE);
    if downloaded.exists() {
        return downloaded;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/models")
        .join(arcelle_lib::stt::MODEL_FILE)
}

/// "SPEAKER <file> 1 <beg> <dur> <NA> <NA> <name> …" → (start, end, speaker).
fn parse_rttm(path: &str) -> Vec<(f64, f64, String)> {
    let text = std::fs::read_to_string(path).expect("read rttm");
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 8 && f[0] == "SPEAKER" {
            let beg: f64 = f[3].parse().unwrap_or(0.0);
            let dur: f64 = f[4].parse().unwrap_or(0.0);
            out.push((beg, beg + dur, f[7].to_string()));
        }
    }
    out
}

/// Sampled DER at 10 ms resolution with a ±0.25 s collar around reference
/// boundaries, using the best one-to-one speaker mapping (exhaustive over the
/// smaller side — meeting-scale counts only).
fn der(
    ref_segs: &[(f64, f64, String)],
    hyp_segs: &[(f64, f64, String)],
    total_s: f64,
) -> String {
    const STEP: f64 = 0.01;
    const COLLAR: f64 = 0.25;
    let ref_names: Vec<String> = {
        let mut v: Vec<String> = ref_segs.iter().map(|s| s.2.clone()).collect();
        v.sort();
        v.dedup();
        v
    };
    let hyp_names: Vec<String> = {
        let mut v: Vec<String> = hyp_segs.iter().map(|s| s.2.clone()).collect();
        v.sort();
        v.dedup();
        v
    };
    let n = (total_s / STEP) as usize;
    // Active speakers per step (bitmask, ≤ 32 names each side is plenty).
    let mut ref_at = vec![0u32; n];
    let mut collar = vec![false; n];
    for (b, e, s) in ref_segs {
        let id = ref_names.iter().position(|x| x == s).unwrap();
        for t in ((b / STEP) as usize)..((e / STEP) as usize).min(n) {
            ref_at[t] |= 1 << id;
        }
        for edge in [*b, *e] {
            let lo = (((edge - COLLAR) / STEP).max(0.0)) as usize;
            let hi = (((edge + COLLAR) / STEP) as usize).min(n);
            collar[lo..hi].iter_mut().for_each(|c| *c = true);
        }
    }
    let mut hyp_at = vec![0u32; n];
    for (b, e, s) in hyp_segs {
        let id = hyp_names.iter().position(|x| x == s).unwrap();
        for t in ((b / STEP) as usize)..((e / STEP) as usize).min(n) {
            hyp_at[t] |= 1 << id;
        }
    }
    // Overlap matrix (scored region only) for the mapping search.
    let mut ov = vec![vec![0u64; hyp_names.len()]; ref_names.len()];
    for t in 0..n {
        if collar[t] {
            continue;
        }
        for (r, row) in ov.iter_mut().enumerate() {
            if ref_at[t] & (1 << r) == 0 {
                continue;
            }
            for (h, cell) in row.iter_mut().enumerate() {
                if hyp_at[t] & (1 << h) != 0 {
                    *cell += 1;
                }
            }
        }
    }
    // Best injective map hyp→ref (or ref→hyp, whichever is smaller).
    let (small, large) = (
        ref_names.len().min(hyp_names.len()),
        ref_names.len().max(hyp_names.len()),
    );
    let ref_small = ref_names.len() <= hyp_names.len();
    let mut best_map: HashMap<usize, usize> = HashMap::new(); // hyp -> ref
    let mut best_score = 0u64;
    let mut pick = vec![usize::MAX; small];
    fn search(
        i: usize,
        small: usize,
        large: usize,
        ref_small: bool,
        ov: &[Vec<u64>],
        used: &mut Vec<bool>,
        pick: &mut Vec<usize>,
        best_score: &mut u64,
        best_map: &mut HashMap<usize, usize>,
    ) {
        if i == small {
            let mut score = 0;
            for (s, &l) in pick.iter().enumerate() {
                if l == usize::MAX {
                    continue;
                }
                score += if ref_small { ov[s][l] } else { ov[l][s] };
            }
            if score > *best_score {
                *best_score = score;
                best_map.clear();
                for (s, &l) in pick.iter().enumerate() {
                    if l == usize::MAX {
                        continue;
                    }
                    let (r, h) = if ref_small { (s, l) } else { (l, s) };
                    best_map.insert(h, r);
                }
            }
            return;
        }
        for l in 0..=large {
            // `large` = leave unmapped
            if l < large {
                if used[l] {
                    continue;
                }
                used[l] = true;
            }
            pick[i] = if l < large { l } else { usize::MAX };
            search(i + 1, small, large, ref_small, ov, used, pick, best_score, best_map);
            if l < large {
                used[l] = false;
            }
        }
    }
    let mut used = vec![false; large];
    search(0, small, large, ref_small, &ov, &mut used, &mut pick, &mut best_score, &mut best_map);

    let (mut scored, mut miss, mut fa, mut conf) = (0u64, 0u64, 0u64, 0u64);
    for t in 0..n {
        if collar[t] {
            continue;
        }
        let refs = (0..ref_names.len()).filter(|r| ref_at[t] & (1 << r) != 0).count() as i64;
        let hyps: Vec<usize> = (0..hyp_names.len()).filter(|h| hyp_at[t] & (1 << h) != 0).collect();
        scored += refs.max(0) as u64;
        let mapped_hits = hyps
            .iter()
            .filter(|h| best_map.get(h).is_some_and(|r| ref_at[t] & (1 << r) != 0))
            .count() as i64;
        let hyp_n = hyps.len() as i64;
        miss += (refs - hyp_n).max(0) as u64;
        fa += (hyp_n - refs).max(0) as u64;
        conf += (refs.min(hyp_n) - mapped_hits).max(0) as u64;
    }
    let d = |x: u64| x as f64 / scored.max(1) as f64 * 100.0;
    format!(
        "DER {:.1}%  (miss {:.1}%  false-alarm {:.1}%  confusion {:.1}%)  ref-speech {:.0}s\n  map: {}",
        d(miss + fa + conf),
        d(miss),
        d(fa),
        d(conf),
        scored as f64 * STEP,
        best_map
            .iter()
            .map(|(h, r)| format!("{}→{}", hyp_names[*h], ref_names[*r]))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn norm_word(w: &str) -> String {
    w.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Measure the neural embedding space on REAL meeting audio with known
/// speakers: embed ground-truth solo spans (and 2 s sub-windows of them) and
/// print same-speaker vs different-speaker cosine percentiles. This is the
/// calibration the synthetic `say` fixtures could never give.
///
///   PR_CAL_WAV=/path/meeting.wav PR_CAL_SOLO=/path/solo.tsv \
///   cargo test --test rec_bench calibrate_embeddings -- --ignored --nocapture
#[test]
#[ignore = "manual embedding calibration on real audio"]
fn calibrate_embeddings() {
    let wav = std::env::var("PR_CAL_WAV").expect("set PR_CAL_WAV");
    let solo = std::env::var("PR_CAL_SOLO").expect("set PR_CAL_SOLO (spk\\tstart\\tend)");
    let pcm = arcelle_lib::stt::decode_to_pcm(
        Path::new(&wav),
        arcelle_lib::stt::MediaKind::Audio,
    )
    .expect("decode audio");

    // Point the diarizer at the repo's bundled model (no Tauri resource
    // resolution in an integration test).
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/models")
        .join(arcelle_lib::recording::diarize::MODEL_FILE);
    assert!(model.exists(), "bundled TitaNet missing: {model:?}");
    arcelle_lib::recording::diarize::set_model_path(model);

    let mut spans: Vec<(String, f64, f64)> = Vec::new();
    for line in std::fs::read_to_string(&solo).unwrap().lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() == 3 {
            spans.push((f[0].into(), f[1].parse().unwrap(), f[2].parse().unwrap()));
        }
    }

    // One embedding per 2 s sub-window (matching phrase-scale prints), plus
    // one per whole span (matching long phrases).
    let mut prints: Vec<(String, Vec<f32>)> = Vec::new();
    for (spk, b, e) in &spans {
        let (b_i, e_i) = ((b * 16000.0) as usize, ((e * 16000.0) as usize).min(pcm.len()));
        let span = &pcm[b_i..e_i];
        let mut windows: Vec<&[f32]> = span.chunks(32000).filter(|c| c.len() >= 24000).collect();
        if windows.is_empty() {
            windows.push(span);
        }
        for w in windows {
            let p = arcelle_lib::recording::diarize::embed(w);
            if p.vec.len() > 30 {
                // neural print only — DSP fallback would poison the stats
                prints.push((spk.clone(), p.vec));
            }
        }
    }
    eprintln!("{} embeddings from {} solo spans", prints.len(), spans.len());

    let cos = |a: &[f32], b: &[f32]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
    // Session-centered copies (the space cluster() actually compares in):
    // shrunken mean subtraction + renormalize, mirroring diarize's centering.
    let dim = prints[0].1.len();
    let mut mean = vec![0f32; dim];
    for (_, v) in &prints {
        for (m, x) in mean.iter_mut().zip(v) {
            *m += x;
        }
    }
    let shrink = prints.len() as f32 / (prints.len() as f32 + 3.0);
    for m in &mut mean {
        *m = *m / prints.len() as f32 * shrink;
    }
    let centered: Vec<Vec<f32>> = prints
        .iter()
        .map(|(_, v)| {
            let mut c: Vec<f32> = v.iter().zip(&mean).map(|(a, b)| a - b).collect();
            let n = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            c.iter_mut().for_each(|x| *x /= n);
            c
        })
        .collect();

    let (mut same, mut diff, mut same_c, mut diff_c) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for i in 0..prints.len() {
        for j in i + 1..prints.len() {
            let r = cos(&prints[i].1, &prints[j].1);
            let c = cos(&centered[i], &centered[j]);
            if prints[i].0 == prints[j].0 {
                same.push(r);
                same_c.push(c);
            } else {
                diff.push(r);
                diff_c.push(c);
            }
        }
    }
    let pct = |v: &mut Vec<f32>, p: f64| -> f32 {
        v.sort_by(f32::total_cmp);
        v[((v.len() - 1) as f64 * p) as usize]
    };
    for (name, v) in [
        ("same-speaker raw     ", &mut same),
        ("same-speaker centered", &mut same_c),
        ("diff-speaker raw     ", &mut diff),
        ("diff-speaker centered", &mut diff_c),
    ] {
        let n = v.len();
        eprintln!(
            "{name}: n={n}  p5 {:+.3}  p25 {:+.3}  p50 {:+.3}  p75 {:+.3}  p95 {:+.3}",
            pct(v, 0.05),
            pct(v, 0.25),
            pct(v, 0.50),
            pct(v, 0.75),
            pct(v, 0.95)
        );
    }
}

#[test]
#[ignore = "manual real-audio benchmark; set PR_BENCH_WAV"]
fn bench_real_wav() {
    let wav = std::env::var("PR_BENCH_WAV").expect("set PR_BENCH_WAV=/path/audio");
    let mut pcm = arcelle_lib::stt::decode_to_pcm(
        Path::new(&wav),
        arcelle_lib::stt::MediaKind::Audio,
    )
    .expect("decode audio");
    if let Ok(s) = std::env::var("PR_BENCH_SECONDS") {
        let n = (s.parse::<f64>().unwrap() * 16000.0) as usize;
        pcm.truncate(n);
    }
    let total_s = pcm.len() as f64 / 16000.0;
    eprintln!("audio: {:.0}s  ({})", total_s, wav);

    let t = std::time::Instant::now();
    let meta = arcelle_lib::recording::retranscribe(&model(), &pcm, Vec::new(), 0, |_, _| {});
    eprintln!("pipeline took {:.0}s ({:.1}x realtime)", t.elapsed().as_secs_f64(), total_s / t.elapsed().as_secs_f64());

    // ---- what the user sees
    let mut per_speaker: HashMap<String, f64> = HashMap::new();
    let mut dump = String::new();
    for s in &meta.segments {
        *per_speaker.entry(s.speaker.clone()).or_default() += (s.t1 - s.t0) as f64 / 100.0;
        dump.push_str(&format!(
            "[{:7.1}s-{:7.1}s] {:10}  {}\n",
            s.t0 as f64 / 100.0,
            s.t1 as f64 / 100.0,
            s.speaker,
            s.text
        ));
    }
    if let Ok(out) = std::env::var("PR_BENCH_OUT") {
        std::fs::write(&out, &dump).unwrap();
        eprintln!("transcript → {out}");
    }
    let n_words: usize = meta.segments.iter().map(|s| s.words.len()).sum();
    let speech_s: f64 = meta.segments.iter().map(|s| (s.t1 - s.t0) as f64 / 100.0).sum();
    eprintln!(
        "segments {}  words {}  speech {:.0}s of {:.0}s audio",
        meta.segments.len(),
        n_words,
        speech_s,
        total_s
    );
    let mut speakers: Vec<(&String, &f64)> = per_speaker.iter().collect();
    speakers.sort_by(|a, b| b.1.total_cmp(a.1));
    eprintln!("speakers: {}", speakers.len());
    for (name, secs) in &speakers {
        eprintln!("  {:10}  {:6.0}s", name, secs);
    }

    // ---- DER vs reference RTTM
    if let Ok(rttm) = std::env::var("PR_BENCH_RTTM") {
        let mut refs = parse_rttm(&rttm);
        refs.retain(|(b, _, _)| *b < total_s);
        let hyps: Vec<(f64, f64, String)> = meta
            .segments
            .iter()
            .map(|s| (s.t0 as f64 / 100.0, s.t1 as f64 / 100.0, s.speaker.clone()))
            .collect();
        let ref_n: std::collections::HashSet<&str> = refs.iter().map(|r| r.2.as_str()).collect();
        eprintln!("reference speakers: {}", ref_n.len());
        eprintln!("{}", der(&refs, &hyps, total_s));
    }

    // ---- word recall vs reference words (word<TAB>seconds per line)
    if let Ok(path) = std::env::var("PR_BENCH_REFWORDS") {
        let text = std::fs::read_to_string(&path).unwrap();
        let mut refs: Vec<(String, f64)> = Vec::new();
        for line in text.lines() {
            if let Some((w, t)) = line.split_once('\t') {
                let w = norm_word(w);
                if !w.is_empty() {
                    if let Ok(t) = t.parse::<f64>() {
                        if t < total_s {
                            refs.push((w, t));
                        }
                    }
                }
            }
        }
        let hyp: Vec<(String, f64)> = meta
            .segments
            .iter()
            .flat_map(|s| s.words.iter())
            .map(|w| (norm_word(&w.w), w.t0 as f64 / 100.0))
            .filter(|(w, _)| !w.is_empty())
            .collect();
        const WIN: f64 = 5.0;
        let mut hyp_by_word: HashMap<&str, Vec<f64>> = HashMap::new();
        for (w, t) in &hyp {
            hyp_by_word.entry(w).or_default().push(*t);
        }
        let recalled = refs
            .iter()
            .filter(|(w, t)| {
                hyp_by_word
                    .get(w.as_str())
                    .is_some_and(|ts| ts.iter().any(|ht| (ht - t).abs() <= WIN))
            })
            .count();
        let mut ref_by_word: HashMap<&str, Vec<f64>> = HashMap::new();
        for (w, t) in &refs {
            ref_by_word.entry(w).or_default().push(*t);
        }
        let precise = hyp
            .iter()
            .filter(|(w, t)| {
                ref_by_word
                    .get(w.as_str())
                    .is_some_and(|ts| ts.iter().any(|rt| (rt - t).abs() <= WIN))
            })
            .count();
        eprintln!(
            "word recall {:.1}% ({} of {} reference words)   precision {:.1}% ({} of {} emitted words)",
            recalled as f64 / refs.len().max(1) as f64 * 100.0,
            recalled,
            refs.len(),
            precise as f64 / hyp.len().max(1) as f64 * 100.0,
            precise,
            hyp.len()
        );
    }
}
