//! The exact log-mel front end TitaNet was trained with (NeMo's librosa-style
//! fbank), ported from kaldi-native-fbank and validated bit-close against the
//! onnxruntime reference pipeline (max feature diff < 1e-4, embedding cosine
//! 1.000000). Every constant below is part of that contract — 25 ms / 10 ms
//! frames with snip_edges, NO dither, NO DC removal, preemphasis 0.97 applied
//! descending (then x[0] -= 0.97·x[0]), a PERIODIC Hann window (denominator
//! 400), a 512-point power spectrum keeping bins 0..=256, and 80 SLANEY-scale
//! mel triangles over 0–8000 Hz with slaney area normalization, Nyquist bin
//! included. Input is mono 16 kHz f32 in [-1, 1]. Change nothing here without
//! re-running the parity check against onnxruntime.

const SR: f32 = 16000.0;
const WIN: usize = 400; // 25 ms
const SHIFT: usize = 160; // 10 ms
const NFFT: usize = 512;
pub const NBINS: usize = 80;

fn mel_slaney(f: f32) -> f32 {
    if f <= 1000.0 { f * 3.0 / 200.0 } else { 15.0 + 14.545_078_f32 * (f / 1000.0).ln() }
}

fn inv_mel_slaney(m: f32) -> f32 {
    if m <= 15.0 { 200.0 / 3.0 * m } else { 1000.0 * ((m - 15.0) * 0.068_751_777_f32).exp() }
}

/// Sparse triangular filters: (first FFT bin, weights). Slaney-normalized so
/// each triangle integrates to the same area, exactly as librosa builds them.
fn mel_banks() -> Vec<(usize, Vec<f32>)> {
    let fft_bin_width = SR / NFFT as f32;
    let (mlo, mhi) = (mel_slaney(0.0), mel_slaney(SR / 2.0));
    let delta = (mhi - mlo) / (NBINS + 1) as f32;
    (0..NBINS)
        .map(|b| {
            let l = inv_mel_slaney(mlo + b as f32 * delta);
            let c = inv_mel_slaney(mlo + (b + 1) as f32 * delta);
            let r = inv_mel_slaney(mlo + (b + 2) as f32 * delta);
            let mut first = None;
            let mut w = Vec::new();
            // NB: unlike kaldi, the Nyquist bin (index NFFT/2) is included.
            for i in 0..=NFFT / 2 {
                let hz = fft_bin_width * i as f32;
                if hz > l && hz < r {
                    let mut weight = if hz <= c { (hz - l) / (c - l) } else { (r - hz) / (r - c) };
                    weight *= 2.0 / (r - l); // slaney norm
                    if first.is_none() {
                        first = Some(i);
                    }
                    w.push(weight);
                } else if first.is_some() {
                    break;
                }
            }
            (first.expect("empty mel bin"), w)
        })
        .collect()
}

/// Iterative radix-2 complex FFT (N = 512 fixed); power spectrum bins 0..=N/2.
fn power_spectrum(frame: &[f32; NFFT]) -> [f32; NFFT / 2 + 1] {
    let n = NFFT;
    let mut re = [0f64; NFFT];
    let mut im = [0f64; NFFT];
    for i in 0..n {
        re[i] = frame[i] as f64;
    }
    // bit reversal
    let mut j = 0usize;
    for i in 0..n {
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
        let mut m = n >> 1;
        while m >= 1 && j & m != 0 {
            j ^= m;
            m >>= 1;
        }
        j |= m;
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let (ar, ai) = (re[i + k], im[i + k]);
                let (br, bi) = (
                    re[i + k + len / 2] * cr - im[i + k + len / 2] * ci,
                    re[i + k + len / 2] * ci + im[i + k + len / 2] * cr,
                );
                re[i + k] = ar + br;
                im[i + k] = ai + bi;
                re[i + k + len / 2] = ar - br;
                im[i + k + len / 2] = ai - bi;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
    let mut out = [0f32; NFFT / 2 + 1];
    for i in 0..=n / 2 {
        out[i] = (re[i] * re[i] + im[i] * im[i]) as f32;
    }
    out
}

pub struct Fbank {
    banks: Vec<(usize, Vec<f32>)>,
    window: [f32; WIN],
}

impl Fbank {
    pub fn new() -> Self {
        // periodic hann: 0.5 - 0.5 cos(2 pi i / N)
        let a = std::f64::consts::TAU / WIN as f64;
        let mut window = [0f32; WIN];
        for (i, w) in window.iter_mut().enumerate() {
            *w = (0.5 - 0.5 * (a * i as f64).cos()) as f32;
        }
        Self { banks: mel_banks(), window }
    }

    /// (num_frames, flat features num_frames × 80) for a whole utterance.
    pub fn compute(&self, samples: &[f32]) -> (usize, Vec<f32>) {
        let n = samples.len();
        // snip_edges: only frames that fit entirely inside the signal.
        let num_frames = if n < WIN { 0 } else { 1 + (n - WIN) / SHIFT };
        let mut feats = Vec::with_capacity(num_frames * NBINS);
        let mut frame = [0f32; NFFT];
        for f in 0..num_frames {
            frame[..WIN].copy_from_slice(&samples[f * SHIFT..f * SHIFT + WIN]);
            frame[WIN..].fill(0.0);
            // preemphasis 0.97
            for i in (1..WIN).rev() {
                frame[i] -= 0.97 * frame[i - 1];
            }
            frame[0] -= 0.97 * frame[0];
            for i in 0..WIN {
                frame[i] *= self.window[i];
            }
            let ps = power_spectrum(&frame);
            for (first, w) in &self.banks {
                let e: f32 = w.iter().zip(&ps[*first..]).map(|(a, b)| a * b).sum();
                feats.push(e.max(f32::EPSILON).ln());
            }
        }
        (num_frames, feats)
    }
}
