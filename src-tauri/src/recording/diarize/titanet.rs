//! TitaNet-small speaker embeddings, run by tract-onnx — pure Rust, compiled
//! into the app like Whisper is, nothing to install. tract was validated
//! bit-exact against onnxruntime FOR THIS MODEL (embedding cosine 1.000000);
//! that validation does not transfer to other graphs (tract silently
//! mis-executed CAM++, cosine 0.18 on identical features), so neither the
//! model nor the runtime may be swapped independently.
//!
//! Everything here is infallible-by-`None`: a missing or broken model file
//! must never break a recording, so the caller falls back to the DSP print.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tract_onnx::prelude::*;

use super::fbank::{Fbank, NBINS};

/// TitaNet-small's embedding width.
pub const EMB_DIM: usize = 192;

type Model = Arc<RunnableModel<TypedFact, Box<dyn TypedOp>>>;

/// One optimized plan per model path, loaded once (~46 ms) and shared across
/// threads (`SimplePlan::run` is `&self`). A failed load is cached too — a
/// model missing at session start stays missing; retrying per phrase would
/// just burn the decode thread.
fn model_for(path: &Path) -> Option<Model> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<Model>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if let Some(m) = cache.get(path) {
        return m.clone();
    }
    let loaded = load(path).ok();
    cache.insert(path.to_path_buf(), loaded.clone());
    loaded
}

fn load(path: &Path) -> TractResult<Model> {
    let mut m = tract_onnx::onnx().model_for_path(path)?;
    // Symbolic time axis: one optimized plan serves every phrase length.
    let t = m.symbols.sym("T");
    m.set_input_fact(
        0,
        f32::fact(ShapeFact::from(vec![TDim::from(1), TDim::from(NBINS as i64), TDim::from(t)]))
            .into(),
    )?;
    m.set_input_fact(1, i64::fact(vec![TDim::from(1)]).into())?;
    Ok(m.into_optimized()?.into_runnable()?)
}

/// The phrase's L2-normalized 192-dim speaker embedding, or `None` on any
/// failure (no model at `path`, too little audio, inference error).
pub fn embed(path: &Path, samples: &[f32]) -> Option<Vec<f32>> {
    let model = model_for(path)?;
    static FBANK: OnceLock<Fbank> = OnceLock::new();
    let (t, mut feats) = FBANK.get_or_init(Fbank::new).compute(samples);
    if t < 2 {
        return None; // per-feature normalization needs a distribution
    }
    // per_feature normalization: over time, per mel bin.
    for c in 0..NBINS {
        let col = |r: usize| feats[r * NBINS + c];
        let mean = (0..t).map(col).sum::<f32>() / t as f32;
        let sd = ((0..t).map(|r| (col(r) - mean).powi(2)).sum::<f32>() / t as f32).sqrt();
        let sd = sd.max(f32::EPSILON);
        for r in 0..t {
            feats[r * NBINS + c] = (feats[r * NBINS + c] - mean) / sd;
        }
    }
    // Pad the frame count to a multiple of 16 with zero rows; the "length"
    // input carries the UNPADDED count so the model masks the padding out.
    let tt = t + (16 - t % 16) % 16;
    feats.resize(tt * NBINS, 0.0);
    // transpose (T, 80) -> (1, 80, T)
    let mut x = vec![0f32; NBINS * tt];
    for r in 0..tt {
        for c in 0..NBINS {
            x[c * tt + r] = feats[r * NBINS + c];
        }
    }
    let x = tract_ndarray::Array3::from_shape_vec((1, NBINS, tt), x).ok()?;
    let len = tract_ndarray::Array1::from_vec(vec![t as i64]);
    let out = model.run(tvec!(Tensor::from(x).into(), Tensor::from(len).into())).ok()?;
    // outputs: [logits, embs[1, 192]] — the embedding is output 1.
    let mut e = out.get(1)?.to_plain_array_view::<f32>().ok()?.as_slice()?.to_vec();
    if e.len() != EMB_DIM {
        return None;
    }
    let norm = e.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
    e.iter_mut().for_each(|v| *v /= norm);
    Some(e)
}
