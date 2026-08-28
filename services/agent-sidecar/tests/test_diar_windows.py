"""Tests for `arcelle_sidecar.diar.windows` -- the Python port of the
sub-window split pass's two pure functions (`window_prints`/`span_print`,
`src-tauri/src/recording/diarize.rs` lines 170-197 and 1658-1714).

`window_prints` is exercised with all-SILENT audio (`np.zeros`): `embed_at`
short-circuits to a zero-vector `VoicePrint` the instant `count_voiced`
returns 0, without ever touching the neural/DSP embedders -- so these tests
validate window BOUNDARIES/spans (the whole point of this module) without
needing the bundled ONNX model or macOS `say` fixtures. A deliberately
nonexistent `model_path` is passed throughout: `embed()`/`embed_at()` is
infallible-by-design (see `test_diar_embed.py`'s own
`test_embed_at_missing_model_falls_back_to_dsp`), so a missing model can
never raise here -- it is irrelevant to what these tests check.

`span_print` is a pure numeric re-merge, so its tests construct synthetic
`VoicePrint`s directly rather than going through `embed()` at all.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from arcelle_sidecar.diar.embed import SAMPLE_RATE, VoicePrint
from arcelle_sidecar.diar.windows import (
    SPLIT_HOP_CS,
    SPLIT_WIN_CS,
    span_print,
    window_prints,
)

MODEL_PATH = "/nonexistent/model/path.onnx"


def _samples_for_cs(cs_len: int) -> np.ndarray:
    """`cs_len` centiseconds' worth of silent samples, at exactly the count
    that makes `len(samples) * 100 // SAMPLE_RATE == cs_len` -- content
    doesn't matter for these timing-only tests."""
    n = cs_len * SAMPLE_RATE // 100
    return np.zeros(n, dtype=np.float32)


# --------------------------------------------------------------------------
# window_prints
# --------------------------------------------------------------------------


def test_shorter_than_one_window_covers_the_whole_clip() -> None:
    """1 s of audio (< SPLIT_WIN_CS=150cs=1.5s) still returns exactly one
    window covering what's there, starting at t0_cs and clamped to the
    clip's actual (short) duration -- not SPLIT_WIN_CS."""
    cs_len = 100  # exactly 1 second
    t0_cs = 500
    out = window_prints(_samples_for_cs(cs_len), t0_cs, MODEL_PATH)

    assert len(out) == 1
    b0, e0, p0 = out[0]
    assert b0 == t0_cs
    assert e0 == t0_cs + cs_len
    assert isinstance(p0, VoicePrint)


def test_advances_by_hop_with_absolute_offsets_and_never_exceeds_duration() -> None:
    """Several seconds of audio produce windows advancing by SPLIT_HOP_CS
    each, with the absolute t0_cs offset baked into every span; no window's
    end exceeds the input's actual duration, and the last one is clamped
    (may be shorter than SPLIT_WIN_CS) rather than hopped past."""
    cs_len = 500  # exactly 5 seconds
    t0_cs = 2000
    out = window_prints(_samples_for_cs(cs_len), t0_cs, MODEL_PATH)

    assert len(out) == 6  # hand-derived: hops at 0,75,150,225,300,375
    starts = [b for b, _, _ in out]
    ends = [e for _, e, _ in out]

    for i, b in enumerate(starts):
        assert b == t0_cs + i * SPLIT_HOP_CS
    for i in range(1, len(starts)):
        assert starts[i] - starts[i - 1] == SPLIT_HOP_CS

    assert all(e <= t0_cs + cs_len for e in ends)
    assert ends[-1] == t0_cs + cs_len  # clamped exactly to the real duration

    for b, e in zip(starts[:-1], ends[:-1]):
        assert e - b == SPLIT_WIN_CS  # every window but the last is full-width
    assert ends[-1] - starts[-1] < SPLIT_WIN_CS


def test_early_stop_margin_skips_a_useless_trailing_sliver() -> None:
    """A clip comfortably under the `cs_len - 20` margin emits ZERO windows
    -- a naive `while t < cs_len` (no margin) loop over the same clip WOULD
    emit one useless < 0.2 s sliver window; the port must not."""
    cs_len = 10  # 0.1 s, comfortably under the 20cs/0.2s margin
    out = window_prints(_samples_for_cs(cs_len), t0_cs=0, model_path=MODEL_PATH)
    assert out == []

    def naive_spans(cs_len: int) -> list[tuple[int, int]]:
        """The same loop with the early-stop margin removed (`t < cs_len`
        instead of `t < cs_len - 20`) -- a local reference only, never
        imported by the module under test."""
        spans: list[tuple[int, int]] = []
        t = 0
        while t < cs_len:
            end = min(t + SPLIT_WIN_CS, cs_len)
            spans.append((t, end))
            if end >= cs_len:
                break
            t += SPLIT_HOP_CS
        return spans

    naive = naive_spans(cs_len)
    assert naive == [(0, 10)]  # the useless sliver the naive loop WOULD emit
    assert len(naive) == 1 and len(out) == 0  # the port avoids exactly that


def test_early_stop_margin_is_exact_at_the_cs_len_minus_20_boundary() -> None:
    """The margin is `t < cs_len - 20`, a strict inequality: a clip whose
    length is EXACTLY 20 cs over the loop's start (t=0) emits nothing, while
    one cs longer than that emits a window covering the whole clip."""
    at_boundary = window_prints(_samples_for_cs(20), t0_cs=0, model_path=MODEL_PATH)
    assert at_boundary == []  # 0 < 20 - 20 == 0 is False

    just_over = window_prints(_samples_for_cs(21), t0_cs=0, model_path=MODEL_PATH)
    assert len(just_over) == 1  # 0 < 21 - 20 == 1 is True
    b, e, _p = just_over[0]
    assert (b, e) == (0, 21)


# --------------------------------------------------------------------------
# span_print
# --------------------------------------------------------------------------


def test_weighted_merge_matches_hand_computed_value() -> None:
    """Two overlapping windows merge into a renormalized weighted mean, with
    the exact expected `voiced_frames` (the /2.0 halving verified
    numerically against hand-computed weights).

    By hand: window A = ([1, 0], voiced_frames=100, span (0, 100)); window B
    = ([0, 1], voiced_frames=50, span (50, 150)). Requested span (0, 100):
      overlap_A = min(100, 100) - max(0, 0)    = 100
      overlap_B = min(100, 150) - max(0, 50)   = 50
      weight_A  = 100 * 100 / max(100 - 0, 1)  = 100
      weight_B  = 50 * 50 / max(150 - 50, 1)   = 25
      sum       = 100*[1, 0] + 25*[0, 1] = [100, 25]
      norm      = sqrt(100**2 + 25**2)   = sqrt(10625)
      total_weight = 125 -> voiced_frames = int(125 / 2.0) = 62
    """
    a = VoicePrint(vec=np.array([1.0, 0.0], dtype=np.float32), voiced_frames=100)
    b = VoicePrint(vec=np.array([0.0, 1.0], dtype=np.float32), voiced_frames=50)
    wins = [(0, 100, a), (50, 150, b)]

    result = span_print(wins, 0, 100)

    assert result is not None
    norm = math.sqrt(100.0**2 + 25.0**2)
    expected_vec = np.array([100.0 / norm, 25.0 / norm])
    assert result.vec == pytest.approx(expected_vec, abs=1e-6)
    assert result.voiced_frames == 62  # int(125 / 2.0), truncated not rounded


def test_skips_a_mismatched_generation_length_regardless_of_order() -> None:
    """A window whose print has a DIFFERENT vector length than what's
    already accumulated is skipped (not an error, not corrupting the sum) --
    only the length that landed FIRST may ever contribute, mirroring the
    Rust `if sum.len() != p.vec.len() { continue; }` order-dependence in
    both directions."""
    neural = VoicePrint(vec=np.ones(192, dtype=np.float32) / math.sqrt(192), voiced_frames=100)
    dsp = VoicePrint(vec=np.ones(21, dtype=np.float32) / math.sqrt(21), voiced_frames=50)

    # Neural print accepted first -> the DSP-length one is skipped.
    result = span_print([(0, 100, neural), (0, 100, dsp)], 0, 100)
    assert result is not None
    assert result.vec.shape[0] == 192
    assert result.vec == pytest.approx(neural.vec, abs=1e-6)
    assert result.voiced_frames == 50  # int(100 / 2.0): only `neural`'s weight

    # DSP print accepted first -> the neural-length one is skipped instead.
    result2 = span_print([(0, 100, dsp), (0, 100, neural)], 0, 100)
    assert result2 is not None
    assert result2.vec.shape[0] == 21
    assert result2.vec == pytest.approx(dsp.vec, abs=1e-6)
    assert result2.voiced_frames == 25  # int(50 / 2.0): only `dsp`'s weight


def test_returns_none_when_no_window_overlaps_the_span() -> None:
    p = VoicePrint(vec=np.array([1.0, 0.0], dtype=np.float32), voiced_frames=100)
    assert span_print([(0, 100, p)], 200, 300) is None


def test_returns_none_when_every_overlapping_window_is_silent() -> None:
    silent = VoicePrint(vec=np.zeros(2, dtype=np.float32), voiced_frames=100)
    assert silent.is_silent()
    assert span_print([(0, 100, silent)], 0, 100) is None


def test_returns_none_when_merged_vector_norm_is_under_the_floor() -> None:
    """Equal-weight, exactly opposing prints cancel to a near-zero sum,
    which falls under the 1e-6 norm floor."""
    pos = VoicePrint(vec=np.array([1.0, 0.0], dtype=np.float32), voiced_frames=100)
    neg = VoicePrint(vec=np.array([-1.0, 0.0], dtype=np.float32), voiced_frames=100)
    assert span_print([(0, 100, pos), (0, 100, neg)], 0, 100) is None
