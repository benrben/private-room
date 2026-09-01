"""The sub-window split pass's two pure per-print functions (ADD-28).

Ported from `src-tauri/src/recording/diarize.rs`:

- lines 170-197 -- the split pass's section-header comment and its
  `SPLIT_WIN_CS`/`SPLIT_HOP_CS` constants (the third constant declared in
  that block, `SPLIT_MIN_VOICE_FRAMES`, already lives in the sibling
  `arcelle_sidecar.diar.cluster` -- see "What this module does NOT need"
  below).
- lines 1658-1714 -- `window_prints` and `span_print` themselves.

A phrase is cut at silences, so when someone answers without a pause both
voices land in ONE phrase -- and a phrase carries one label. The split pass
re-cuts each phrase into fixed sub-windows, clusters those, and breaks the
phrase wherever consecutive words disagree on the voice. Only the two pure,
phrase-local functions that produce and re-merge those sub-window prints
live here:

- `window_prints` -- embed one phrase's audio into fixed 1.5 s windows at a
  0.75 s hop.
- `span_print` -- frames-weighted re-merge of whichever windows overlap an
  arbitrary `[t0, t1)` span (the piece a word-level split produces).

## Deliberately out of scope

The rest of that area of `diarize.rs` -- `lane_voices`, `split_by_voice`,
`relabel`, `apply_names`, and the `Naming` type -- all operate on a
`RecSegment` type that does not exist yet in this migration (it belongs to
the not-yet-built recording engine). None of that is ported here; it is
deferred to whenever `RecSegment` exists on the Python side.

## What this module does NOT need

`SPLIT_MIN_VOICE_FRAMES` -- the sub-window evidence gate the future
`RecSegment`-based driver will need (via `cluster_gated(...,
SPLIT_MIN_VOICE_FRAMES)`) -- already lives in the sibling `cluster.py`
(itself ported verbatim against these same Rust lines). It is intentionally
NOT imported here: neither `window_prints` nor `span_print` gates on a
voice-defining evidence floor -- they only build and re-merge prints, never
decide whether a print is strong enough to define a voice. Importing it here
anyway would be a dead, unused import.

## A necessary deviation: `model_path`

Rust's top-level `embed(samples: &[f32]) -> VoicePrint` (`diarize.rs` line
572) resolves its ONNX model path itself via a process-wide `OnceLock`. The
sibling `embed.py` module is explicit that this path-resolution singleton is
host-app wiring out of scope for the rewrite, so its ported `embed()` takes
`model_path` as an explicit first argument instead. Because `window_prints`
must call that same `embed()` to embed each sub-window, it necessarily grows
a `model_path` parameter beyond the Rust `window_prints(samples, t0_cs)`
shape -- there is no process-wide singleton on the Python side to resolve it
from instead.

## Numeric-fidelity note

Rust computes `span_print`'s accumulation in `f32`. This port accumulates
internally in `float64` (the same higher-precision convention `embed.py` and
`cluster.py` already document for themselves) and casts to `float32` only
where `VoicePrint.vec` is stored -- not a change to any formula, constant, or
threshold: the `1e-6` norm floor and the `/ 2.0` halving are applied exactly
as Rust does.
"""

from __future__ import annotations

import numpy as np

from .embed import SAMPLE_RATE, VoicePrint, embed

__all__ = ["SPLIT_WIN_CS", "SPLIT_HOP_CS", "window_prints", "span_print"]

# Sub-window size and hop, centiseconds (1.5 s / 0.75 s -- the granularity
# production diarizers embed at; shorter windows measured near-coin-flip).
SPLIT_WIN_CS: int = 150
SPLIT_HOP_CS: int = 75


def window_prints(
    samples: np.ndarray, t0_cs: int, model_path: str
) -> list[tuple[int, int, VoicePrint]]:
    """One phrase's sub-window prints: fixed 1.5 s windows at a 0.75 s hop,
    each embedded on its own via :func:`embed.embed`. Returned spans are on
    the recording's ABSOLUTE timeline (``t0_cs`` plus each window's offset
    within this phrase).

    Centisecond<->sample-index conversion is truncating integer division at
    every step (Python's ``//`` on non-negative operands matches Rust's
    ``i64``/``usize`` truncation exactly) -- nothing here is ever routed
    through a float.

    The loop condition is ``t < cs_len - 20``, not ``t < cs_len``: a clip
    whose total length is at or under 0.2 s emits NO window at all, rather
    than one useless sub-0.2s trailing sliver. Once a clip is longer than
    that, the window/hop ratio (150 cs window, 75 cs hop) guarantees the
    terminal, cs_len-reaching window is always already well past this
    margin, so in practice it only ever matters for very short clips --
    ported exactly regardless.

    The final window is clamped to ``cs_len`` (it may be shorter than
    :data:`SPLIT_WIN_CS`), and the loop breaks immediately once a window's
    end reaches ``cs_len`` rather than hopping past it.
    """
    samples = np.asarray(samples, dtype=np.float32)
    n = samples.shape[0]
    cs_len = n * 100 // SAMPLE_RATE
    out: list[tuple[int, int, VoicePrint]] = []
    t = 0
    while t < cs_len - 20:
        end = min(t + SPLIT_WIN_CS, cs_len)
        i0 = t * SAMPLE_RATE // 100
        i1 = min(end * SAMPLE_RATE // 100, n)
        if i1 > i0:
            out.append((t0_cs + t, t0_cs + end, embed(model_path, samples[i0:i1])))
        if end >= cs_len:
            break
        t += SPLIT_HOP_CS
    return out


def span_print(
    wins: list[tuple[int, int, VoicePrint]], t0: int, t1: int
) -> VoicePrint | None:
    """Frames-weighted mean of every window overlapping ``[t0, t1)``,
    renormalized -- the print a split piece carries forward.

    For each window ``(b, e, p)``: the overlap is ``min(t1, e) - max(t0,
    b)``; a window is skipped (never erroring) when its overlap is <= 0, when
    its print is :meth:`VoicePrint.is_silent`, or when its print's vector
    length differs from whatever's already accumulated -- print generations
    (neural vs. DSP) are never mixed in one mean, which can genuinely happen
    when a phrase spans a period where the neural model became
    available/unavailable mid-recording. Each contributing window is
    weighted by ``p.voiced_frames * overlap / max(e - b, 1)``.

    Returns ``None`` when nothing accumulated at all, or when the summed
    vector's norm is under ``1e-6`` (e.g. equal-weight opposing windows that
    cancel). Otherwise the merged vector is renormalized and returned with
    ``voiced_frames = int(total_weight / 2.0)`` -- the halving is DELIBERATE:
    at this hop spacing, windows cover the timeline roughly twice over, so
    this approximates that double-counting. It only feeds the evidence gates
    and the who-talks-most mass, which tolerate the approximation; it is
    ported exactly, not "fixed" into something that looks more correct.
    """
    vec_sum: np.ndarray | None = None
    frames = 0.0
    for b, e, p in wins:
        contribution = _span_contribution(b, e, p, t0, t1)
        if contribution is None:
            continue
        vec_sum, frames_added = _add_span_contribution(vec_sum, contribution)
        frames += frames_added
    return _merged_span_print(vec_sum, frames)


def _span_contribution(
    begin: int, end: int, print_: VoicePrint, t0: int, t1: int
) -> tuple[np.ndarray, float] | None:
    overlap = float(min(t1, end) - max(t0, begin))
    if overlap <= 0.0 or print_.is_silent():
        return None
    weight = print_.voiced_frames * overlap / max(end - begin, 1)
    return np.asarray(print_.vec, dtype=np.float64), weight


def _add_span_contribution(
    vec_sum: np.ndarray | None, contribution: tuple[np.ndarray, float]
) -> tuple[np.ndarray, float]:
    vector, weight = contribution
    if vec_sum is None:
        vec_sum = np.zeros(vector.shape[0], dtype=np.float64)
    if vec_sum.shape[0] != vector.shape[0]:
        return vec_sum, 0.0  # never mix print generations in one mean
    return vec_sum + vector * weight, weight


def _merged_span_print(vec_sum: np.ndarray | None, frames: float) -> VoicePrint | None:
    if vec_sum is None:
        return None
    norm = float(np.sqrt(np.sum(vec_sum * vec_sum)))
    if norm < 1e-6:
        return None
    return VoicePrint(vec=(vec_sum / norm).astype(np.float32), voiced_frames=int(frames / 2.0))
