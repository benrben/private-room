"""Waveform peaks for the audio viewer.

Ported from ``src-tauri/src/commands/peaks.rs``. This module carries only the
pure, testable pieces of that file: the envelope reduction, the silence
check, the decode-error rewrite, and the cache-key function. The Tauri
command wrapper (``audio_peaks``), ``AppState``, the file-DB lookup and the
in-memory ``PeakCache``/``MAX_CACHED`` eviction are Electron-main-side wiring
(the DB in this rewrite is opened Node-side, not from this sidecar) and are
deliberately left out of this port.

The waveform is drawn from a downsampled envelope computed HERE rather than
by decoding the file in the browser. Decoding the whole file client-side for
a two-hour meeting means roughly a gigabyte of Float32 in the renderer — on a
machine that is simultaneously running a local model. The room already knows
how to decode any container the Mac can read (it is the same path
transcription uses), so it decodes once, reduces to a few thousand buckets,
and hands over a few tens of kilobytes.
"""

from __future__ import annotations

import numpy as np

# How many buckets to compute when the caller doesn't say. ~2000 is more than
# a pane is ever wide in CSS pixels, so the drawing is never under-sampled,
# and it is small enough to cross IPC without thought.
DEFAULT_BUCKETS: int = 2000
MAX_BUCKETS: int = 8000

# The amplitude at or under which an envelope is silence rather than signal.
# `envelope` refuses to normalize below it (dither must not be amplified into
# a fake waveform), so a file that never crosses it draws as a flat lane —
# and that flat lane is what the viewer has to explain.
NOISE_FLOOR: float = 0.01


def envelope(samples: np.ndarray, buckets: int) -> np.ndarray:
    """Reduce mono samples to `buckets` maxima.

    Uses the maximum ABSOLUTE value in each bucket, not the mean: a mean
    envelope of speech is nearly flat, which is exactly the "featureless grey
    sausage" a waveform is supposed not to be.

    Bucket boundaries are computed with the same integer-free walk as the
    Rust source (``start = b*len//buckets``, ``end = (b+1)*len//buckets``,
    ``end = max(end, start+1)``, ``end = min(end, len)``) so the last bucket
    can never run past the array on a length that doesn't divide evenly, and
    a length so short it produces a zero-width bucket still gets one sample.
    """
    samples = np.asarray(samples, dtype=np.float32)
    length = samples.shape[0]
    if length == 0 or buckets == 0:
        return np.empty(0, dtype=np.float32)

    abs_samples = np.abs(samples)
    out = np.empty(buckets, dtype=np.float32)
    for b in range(buckets):
        start = (b * length) // buckets
        end = ((b + 1) * length) // buckets
        end = max(end, start + 1)
        end = min(end, length)
        peak = float(abs_samples[start:end].max())
        out[b] = min(peak, 1.0)

    # Normalize to the loudest moment so a quietly-recorded meeting still
    # fills the lane. A silent file stays silent rather than being amplified
    # into noise. `out` is never empty here (buckets > 0) and every entry is
    # >= 0 (it came from an abs value), so a plain max() matches Rust's
    # `fold(0f32, f32::max)` exactly.
    loudest = float(out.max())
    if loudest > NOISE_FLOOR:
        out = out / loudest
    return out


def is_silent(peaks: np.ndarray) -> bool:
    """Did anything in this envelope get above the floor?

    A normalized envelope peaks at exactly 1.0, so this is only ever true for
    the un-normalized case: a track with no audible content in it.

    An empty envelope returns False — that is the viewer's "no readable
    audio", not a claim about the content, so it must not be reported as
    silence.
    """
    peaks = np.asarray(peaks, dtype=np.float32)
    if peaks.size == 0:
        return False
    loudest = max(0.0, float(peaks.max()))
    return loudest <= NOISE_FLOOR


def describe_decode_error(err: str) -> str:
    """What to show when the decoder refuses a file.

    `avconvert` fails on a video whose audio track is missing AND on one
    whose audio the Mac has no decoder for, and it does not say which — so
    the sentence stops at "none this Mac can read" rather than asserting the
    track isn't there. Every other failure keeps its own words; a generic
    rewrite would throw away the only clue there is.
    """
    if err.startswith("no readable audio track"):
        return "This video has no audio track this Mac can read."
    return err


def cache_key(file_id: str, buckets: int, size: int) -> str:
    """The cache key, and the reason this cache can no longer serve an
    envelope of audio that has since been replaced.

    Keyed on the file id alone, and emptied only when the room closed, the
    waveform after "Continue recording" was the PRE-continuation one: the
    axis stopped at the old length, and every speaker lane, highlight band,
    chapter rule and click-to-seek is positioned as a fraction of the
    ``duration`` that came with it — so all of them pointed at the wrong
    moments. `size` closes that: every path that rewrites a file's bytes
    writes the new size in the same statement, so a rewritten file simply
    misses.

    What it does NOT see: a rewrite to a byte length identical to the old one
    (restoring a version of exactly the same size). The envelope would be
    stale there too — but the timeline it is drawn against has not moved,
    which is the failure this key exists to prevent.
    """
    return f"{file_id}:{buckets}:{size}"
