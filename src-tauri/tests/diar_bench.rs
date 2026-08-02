//! Diarization acceptance benchmark (ADD-28) — a pass/fail test.
//!
//! Runs the SHIPPING offline pipeline (`recording::retranscribe`, which now
//! includes the sub-window split pass) over a manifest of real recordings
//! with RTTM ground truth, reports DER per row, and FAILS when a row misses
//! the acceptance bar. This is the regression harness for the 2026-08-01
//! split-pass acceptance numbers: 39 AMI two-speaker slices >= 95%
//! split-success, 4 full meetings at 4/4 speakers (data + manifests live in
//! ~/diarization-lab). Printing numbers nobody compared to anything is what
//! it used to do, which meant it could never notice a regression.
//!
//!   PR_BENCH_MANIFEST=…/manifest.tsv   (sid\twav\trttm per line)
//!   PR_BENCH_RESULTS=…/out.jsonl       (one JSON line per row; REWRITTEN
//!                                       each run, never appended to)
//!   PR_BENCH_MAX_DER=…                 (per-row DER ceiling, default 30)
//!   PR_BENCH_ALLOW_SPEAKER_DRIFT=1     (don't fail on a wrong speaker count)
//!   cargo test --release --test diar_bench -- --ignored --nocapture

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

struct Der {
    der: f64,
    miss: f64,
    fa: f64,
    conf: f64,
}

/// Sampled DER at 10 ms with a ±0.25 s collar and the best one-to-one
/// speaker mapping — the same scorer `rec_bench` prints, returning numbers.
fn der(ref_segs: &[(f64, f64, String)], hyp_segs: &[(f64, f64, String)], total_s: f64) -> Der {
    const STEP: f64 = 0.01;
    const COLLAR: f64 = 0.25;
    let names = |segs: &[(f64, f64, String)]| {
        let mut v: Vec<String> = segs.iter().map(|s| s.2.clone()).collect();
        v.sort();
        v.dedup();
        v
    };
    let (ref_names, hyp_names) = (names(ref_segs), names(hyp_segs));
    let n = (total_s / STEP) as usize;
    let mut ref_at = vec![0u32; n];
    let mut collar = vec![false; n];
    for (b, e, s) in ref_segs {
        let id = ref_names.iter().position(|x| x == s).unwrap();
        for t in ((b / STEP) as usize)..((e / STEP) as usize).min(n) {
            ref_at[t] |= 1 << id;
        }
        for edge in [*b, *e] {
            let hi = (((edge + COLLAR) / STEP) as usize).min(n);
            let lo = ((((edge - COLLAR) / STEP).max(0.0)) as usize).min(hi);
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
    let (small, large) =
        (ref_names.len().min(hyp_names.len()), ref_names.len().max(hyp_names.len()));
    let ref_small = ref_names.len() <= hyp_names.len();
    let mut best_map: HashMap<usize, usize> = HashMap::new();
    let mut best_score = 0u64;
    let mut pick = vec![usize::MAX; small];
    #[allow(clippy::too_many_arguments)]
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
        let hyps: Vec<usize> =
            (0..hyp_names.len()).filter(|h| hyp_at[t] & (1 << h) != 0).collect();
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
    Der { der: d(miss + fa + conf), miss: d(miss), fa: d(fa), conf: d(conf) }
}

/// Per-row DER ceiling. The shipped split pass scores far below this on the
/// acceptance set; the bar is here to catch a regression, not to be tight.
const DEFAULT_MAX_DER: f64 = 30.0;

#[test]
#[ignore = "acceptance benchmark; set PR_BENCH_MANIFEST"]
fn bench_manifest() {
    use std::io::Write;
    let manifest = std::env::var("PR_BENCH_MANIFEST").expect("set PR_BENCH_MANIFEST");
    let results = std::env::var("PR_BENCH_RESULTS").expect("set PR_BENCH_RESULTS");
    let max_der: f64 = std::env::var("PR_BENCH_MAX_DER")
        .ok()
        .map(|v| v.parse().expect("PR_BENCH_MAX_DER"))
        .unwrap_or(DEFAULT_MAX_DER);
    let allow_drift = std::env::var("PR_BENCH_ALLOW_SPEAKER_DRIFT").is_ok();
    // Rewritten, not appended to: a results file that accumulates every run
    // makes "the numbers" whatever you last looked at.
    let mut out =
        std::fs::File::create(&results).expect("create PR_BENCH_RESULTS");
    let mut failures: Vec<String> = Vec::new();
    for line in std::fs::read_to_string(&manifest).expect("read manifest").lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        let (sid, wav, rttm) = (f[0], f[1], f[2]);
        let mut pcm = arcelle_lib::stt::decode_to_pcm(
            Path::new(wav),
            arcelle_lib::stt::MediaKind::Audio,
        )
        .expect("decode audio");
        if let Ok(s) = std::env::var("PR_BENCH_SECONDS") {
            let n = (s.parse::<f64>().expect("PR_BENCH_SECONDS") * 16000.0) as usize;
            pcm.truncate(n);
        }
        let total_s = pcm.len() as f64 / 16000.0;
        let meta = arcelle_lib::recording::retranscribe(
            &model(),
            &pcm,
            &arcelle_lib::recording::RecMeta::default(),
            |_, _| {},
            || false, // never stopped: the bench measures a full pass
        )
        .expect("retranscribe");
        let mut refs = parse_rttm(rttm);
        refs.retain(|(b, _, _)| *b < total_s);
        let hyps: Vec<(f64, f64, String)> = meta
            .segments
            .iter()
            .map(|s| (s.t0 as f64 / 100.0, s.t1 as f64 / 100.0, s.speaker.clone()))
            .collect();
        let speakers: std::collections::HashSet<&str> =
            meta.segments.iter().map(|s| s.speaker.as_str()).collect();
        let ref_n: std::collections::HashSet<&str> = refs.iter().map(|r| r.2.as_str()).collect();
        let d = der(&refs, &hyps, total_s);
        let row = format!(
            "{{\"sid\":\"{}\",\"speakers\":{},\"ref_speakers\":{},\"der\":{:.2},\"miss\":{:.2},\"fa\":{:.2},\"conf\":{:.2}}}",
            sid,
            speakers.len(),
            ref_n.len(),
            d.der,
            d.miss,
            d.fa,
            d.conf
        );
        writeln!(out, "{row}").unwrap();
        eprintln!("{row}");
        if d.der > max_der {
            failures.push(format!("{sid}: DER {:.2} > {max_der:.2}", d.der));
        }
        if !allow_drift && speakers.len() != ref_n.len() {
            failures.push(format!(
                "{sid}: found {} speaker(s), ground truth has {}",
                speakers.len(),
                ref_n.len()
            ));
        }
    }
    assert!(failures.is_empty(), "diarization regressed:\n  {}", failures.join("\n  "));
}
