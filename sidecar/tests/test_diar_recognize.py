"""Tests for `arcelle_sidecar.diar.recognize` -- the Python port of the
"Cross-recording recognition" section of
`src-tauri/src/recording/diarize.rs` (lines 258-423): naming a saved voice
across DIFFERENT recordings.

There is no labeled cross-recording voice-identity corpus on this machine
(the Rust source's own doc comments say the same -- the sweep that would
measure this is `#[ignore]`d and unrun, and `KNOWN_SAME` is DERIVED from
`NEURAL_GATES.raw_same`, not independently measured). So this file does not
attempt a stronger validation than the Rust source itself claims: it
validates the ALGORITHM -- bipartite greedy-best-first matching correctness,
ambiguity-margin rejection, and the discriminative veto test -- with
synthetic embeddings built to exact, controlled cosine similarities.

## Synthetic-embedding construction

All test vectors live in a shared 2D plane spanned by the first two of the
192 (`EMB_DIM`) coordinate axes, e0 and e1. A unit vector at angle `theta`
from e0 has an EXACT cosine similarity of `cos(theta)` with e0 -- so placing
a "known voice" or "group centroid" at `vec_at_cos(c)` (angle `acos(c)` from
e0) gives an exactly-controlled cosine similarity `c` against anything else
placed at angle 0. This is what lets every test assert precise, designed-in
similarity values rather than whatever a random vector happens to produce.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from arcelle_sidecar.diar import recognize as rec
from arcelle_sidecar.diar.cluster import MIN_OPEN_FRAMES
from arcelle_sidecar.diar.embed import EMB_DIM, MIN_NEW_VOICE_FRAMES, VoicePrint

# ---- Synthetic-vector helpers ----------------------------------------------


def basis_vec(theta: float, dim: int = EMB_DIM) -> np.ndarray:
    """Unit vector at angle `theta` from e0, in the e0/e1 plane."""
    v = np.zeros(dim, dtype=np.float32)
    v[0] = math.cos(theta)
    v[1] = math.sin(theta)
    return v


def vec_at_cos(cosine: float, dim: int = EMB_DIM) -> np.ndarray:
    """Unit vector whose cosine similarity with `basis_vec(0)` (== e0) is
    exactly `cosine`."""
    theta = math.acos(max(-1.0, min(1.0, cosine)))
    return basis_vec(theta, dim)


E0 = basis_vec(0.0)  # the shared "reference direction" every test compares against


def neural_print(vec: np.ndarray, voiced_frames: int) -> VoicePrint:
    return VoicePrint(vec=vec.astype(np.float32), voiced_frames=voiced_frames)


def dsp_print(dim: int, voiced_frames: int) -> VoicePrint:
    v = np.ones(dim, dtype=np.float32)
    v = v / float(np.sqrt(np.sum(v.astype(np.float64) ** 2)))
    return VoicePrint(vec=v.astype(np.float32), voiced_frames=voiced_frames)


# =============================================================================
# ---- Module constants -- checked verbatim against the Rust source values ---
# =============================================================================


def test_constants_match_rust_source() -> None:
    assert rec.KNOWN_SAME == pytest.approx(0.72)
    assert rec.KNOWN_MARGIN == pytest.approx(0.04)
    assert rec.MIN_IDENTITY_FRAMES == MIN_OPEN_FRAMES == 156


# =============================================================================
# ---- identity_print ---------------------------------------------------------
# =============================================================================


def test_identity_print_empty_list_is_none() -> None:
    assert rec.identity_print([]) is None


def test_identity_print_no_strong_prints_is_none() -> None:
    # Individually below MIN_NEW_VOICE_FRAMES (62): never "strong", so the
    # strong-filter yields nothing to average.
    weak = neural_print(E0, voiced_frames=MIN_NEW_VOICE_FRAMES - 1)
    assert rec.identity_print([weak]) is None


def test_identity_print_single_strong_neural_print_returns_renormalized_vector() -> None:
    p = neural_print(E0, voiced_frames=200)
    out = rec.identity_print([p])
    assert out is not None
    assert np.allclose(np.asarray(out.vec, dtype=np.float64), E0.astype(np.float64), atol=1e-6)
    assert out.voiced_frames == 200


def test_identity_print_ignores_dsp_prints_even_when_strong() -> None:
    # 21-dim DSP print, well above MIN_NEW_VOICE_FRAMES and not silent --
    # "strong" by VoicePrint.is_strong() -- but not neural, so identity_print
    # must still ignore it entirely.
    p = dsp_print(dim=21, voiced_frames=300)
    assert p.is_strong()
    assert rec.identity_print([p]) is None


def test_identity_print_below_min_identity_frames_combined_is_none() -> None:
    # Each print individually clears MIN_NEW_VOICE_FRAMES (62) and is
    # therefore "strong" -- but their combined voiced_frames (140) is still
    # under MIN_IDENTITY_FRAMES (156), the higher cross-recording bar.
    p1 = neural_print(E0, voiced_frames=70)
    p2 = neural_print(E0, voiced_frames=70)
    assert p1.is_strong() and p2.is_strong()
    assert p1.voiced_frames + p2.voiced_frames < rec.MIN_IDENTITY_FRAMES
    assert rec.identity_print([p1, p2]) is None


def test_identity_print_cancelling_prints_return_none() -> None:
    # Two opposite-direction unit vectors, equal weight: their sum is the
    # zero vector -- a mean that defines nothing, even though the combined
    # evidence clears MIN_IDENTITY_FRAMES.
    p1 = neural_print(E0, voiced_frames=100)
    p2 = neural_print(-E0, voiced_frames=100)
    assert p1.voiced_frames + p2.voiced_frames >= rec.MIN_IDENTITY_FRAMES
    assert rec.identity_print([p1, p2]) is None


def test_identity_print_norm_just_above_1e6_floor_survives() -> None:
    # A single strong print whose summed-vector norm sits at 3e-6 -- above
    # the Rust source's literal `1e-6` floor but comfortably below a coarser
    # floor a wrong port might use instead (1e-5, 1e-4). If the port's
    # epsilon were too loose, this near-nothing voice would be wrongly
    # rejected as "cancels out to nothing" when it does not.
    vec = np.zeros(EMB_DIM, dtype=np.float32)
    vec[0] = 3e-6
    p = neural_print(vec, voiced_frames=200)
    assert rec.identity_print([p]) is not None


def test_identity_print_norm_just_below_1e6_floor_is_none() -> None:
    # Symmetric case at 5e-7 -- below the 1e-6 floor but well above a
    # tighter epsilon a wrong port might use instead (1e-9). Confirms the
    # floor is not looser than the Rust source's 1e-6 either.
    vec = np.zeros(EMB_DIM, dtype=np.float32)
    vec[0] = 5e-7
    p = neural_print(vec, voiced_frames=200)
    assert rec.identity_print([p]) is None


# =============================================================================
# ---- raw_similarity ---------------------------------------------------------
# =============================================================================


def test_raw_similarity_none_for_dsp_neural_pair() -> None:
    a = neural_print(E0, voiced_frames=200)
    b = dsp_print(dim=21, voiced_frames=200)
    assert rec.raw_similarity(a, b) is None
    assert rec.raw_similarity(b, a) is None


def test_raw_similarity_none_for_mismatched_lengths() -> None:
    # is_neural(v) is exactly `len(v) == EMB_DIM`, so two prints that are
    # BOTH neural can never have mismatched lengths (both are 192) -- the
    # length check in the Rust source is defensive for that reason. This
    # exercises the only way lengths can actually differ: two DSP-generation
    # prints (19-dim legacy vs. 21-dim current), which also fail the neural
    # gate -- both routes the port takes land on the same `None`.
    a = dsp_print(dim=19, voiced_frames=200)
    b = dsp_print(dim=21, voiced_frames=200)
    assert len(a.vec) != len(b.vec)
    assert rec.raw_similarity(a, b) is None


def test_raw_similarity_real_cosine_for_comparable_neural_prints() -> None:
    a = neural_print(E0, voiced_frames=200)
    b = neural_print(vec_at_cos(0.6), voiced_frames=200)
    sim = rec.raw_similarity(a, b)
    assert sim == pytest.approx(0.6, abs=1e-6)


# =============================================================================
# ---- vetoed ------------------------------------------------------------------
# =============================================================================


def test_vetoed_true_when_closer_to_reject_within_margin() -> None:
    c = neural_print(E0, voiced_frames=200)
    sim = 0.80
    reject = vec_at_cos(0.79)  # 0.79 + KNOWN_MARGIN(0.04) = 0.83 >= 0.80
    k = rec.KnownVoice(name="Impostor", vec=vec_at_cos(sim), rejects=[reject])
    assert rec.vetoed(c, k, sim) is True


def test_vetoed_false_when_clearly_favors_real_match() -> None:
    c = neural_print(E0, voiced_frames=200)
    sim = 0.80
    reject = vec_at_cos(0.30)  # 0.30 + 0.04 = 0.34 < 0.80
    k = rec.KnownVoice(name="Dana", vec=vec_at_cos(sim), rejects=[reject])
    assert rec.vetoed(c, k, sim) is False


def test_vetoed_ignores_rejects_of_different_length() -> None:
    c = neural_print(E0, voiced_frames=200)
    sim = 0.80
    # A mismatched-length reject: even though its content would trigger the
    # veto inequality if it were ever compared, a length mismatch means it
    # is never consulted at all.
    mismatched_reject = np.ones(21, dtype=np.float32)
    k = rec.KnownVoice(name="Dana", vec=vec_at_cos(sim), rejects=[mismatched_reject])
    assert rec.vetoed(c, k, sim) is False


def test_vetoed_exact_boundary_is_inclusive() -> None:
    # The Rust source's inequality is `cosine(&c.vec, r) + KNOWN_MARGIN >=
    # sim` -- inclusive. Construct `sim` to equal
    # `cosine(c, reject) + KNOWN_MARGIN` EXACTLY, by computing it with the
    # same arithmetic `vetoed` itself performs (rather than reconstructing
    # it via acos/cos, which would smuggle in floating-point slack around
    # the boundary and might pass even under a wrong `>`). At this exact
    # boundary, a correct `>=` must veto; a wrong strict `>` would not.
    from arcelle_sidecar.diar.embed import cosine as embed_cosine

    c = neural_print(E0, voiced_frames=200)
    reject = vec_at_cos(0.5)
    reject_cos = embed_cosine(np.asarray(c.vec), reject)
    sim = reject_cos + rec.KNOWN_MARGIN  # exact boundary, by construction

    k = rec.KnownVoice(name="Boundary", rejects=[reject])
    assert rec.vetoed(c, k, sim) is True


# =============================================================================
# ---- recognize_groups --------------------------------------------------------
# =============================================================================


def test_recognize_groups_clean_single_candidate_match() -> None:
    centroid = neural_print(E0, voiced_frames=200)
    known = [rec.KnownVoice(name="Zed", vec=vec_at_cos(0.85))]
    out = rec.recognize_groups([centroid], known, blocked=[])
    assert out == ["Zed"]


def test_recognize_groups_ambiguous_top_two_gets_no_name() -> None:
    centroid = neural_print(E0, voiced_frames=200)
    # 0.80 - 0.77 = 0.03 < KNOWN_MARGIN (0.04): an unanswered question.
    known = [
        rec.KnownVoice(name="Pat", vec=vec_at_cos(0.80)),
        rec.KnownVoice(name="Quinn", vec=vec_at_cos(0.77)),
    ]
    out = rec.recognize_groups([centroid], known, blocked=[])
    assert out == [None]


def test_recognize_groups_below_known_same_never_assigned() -> None:
    centroid = neural_print(E0, voiced_frames=200)
    known = [rec.KnownVoice(name="Low", vec=vec_at_cos(0.70))]  # < KNOWN_SAME (0.72)
    out = rec.recognize_groups([centroid], known, blocked=[])
    assert out == [None]


def test_recognize_groups_blocked_name_never_a_candidate() -> None:
    centroid = neural_print(E0, voiced_frames=200)
    known = [rec.KnownVoice(name="Yael", vec=vec_at_cos(0.85))]
    out = rec.recognize_groups([centroid], known, blocked=["Yael"])
    assert out == [None]


def test_recognize_groups_greedy_claim_only_higher_similarity_group_wins() -> None:
    # Two groups that both plausibly match the SAME known voice: only the
    # higher-similarity group gets the name; the other gets None, even
    # though its own match easily clears KNOWN_SAME on its own. Hold the
    # known voice fixed at e0 and place each GROUP centroid at the desired
    # angle from it (cosine is symmetric, so this is equivalent to placing
    # the known voice at an angle from a fixed group).
    k = rec.KnownVoice(name="Sam", vec=E0)
    g0 = neural_print(vec_at_cos(0.85), voiced_frames=200)  # cos(g0, Sam) = 0.85
    g1 = neural_print(vec_at_cos(0.80), voiced_frames=200)  # cos(g1, Sam) = 0.80

    out = rec.recognize_groups([g0, g1], [k], blocked=[])
    assert out == ["Sam", None]


def test_recognize_groups_three_way_contention_only_highest_wins() -> None:
    # THREE groups all plausibly match the SAME known voice, at three
    # different similarity levels, each with only one candidate (so no
    # per-group ambiguity-margin rejection muddies the result). The groups
    # are fed in DELIBERATELY UNSORTED order (0.80, 0.90, 0.75) -- the
    # per-group scan that builds `pairs` must visit all three before the
    # final claim pass re-sorts by similarity descending; only the single
    # highest-similarity group (g1, 0.90) may win the name, even though
    # g0's (0.80) and g2's (0.75) own matches individually clear
    # KNOWN_SAME just as cleanly.
    k = rec.KnownVoice(name="Sam", vec=E0)
    g0 = neural_print(vec_at_cos(0.80), voiced_frames=200)
    g1 = neural_print(vec_at_cos(0.90), voiced_frames=200)  # highest -- must win
    g2 = neural_print(vec_at_cos(0.75), voiced_frames=200)

    out = rec.recognize_groups([g0, g1, g2], [k], blocked=[])
    assert out == [None, "Sam", None]


def test_recognize_groups_vetoed_candidate_skipped_for_next_best() -> None:
    centroid = neural_print(E0, voiced_frames=200)

    # A would win on raw similarity (0.90) but is vetoed: the candidate is
    # closer to A's own reject (0.91) than to A itself, within KNOWN_MARGIN.
    a = rec.KnownVoice(name="Wrong", vec=vec_at_cos(0.90), rejects=[vec_at_cos(0.91)])
    # B passes cleanly at a lower, but still admissible, similarity.
    b = rec.KnownVoice(name="Right", vec=vec_at_cos(0.78))

    out = rec.recognize_groups([centroid], [a, b], blocked=[])
    assert out == ["Right"]


def test_recognize_groups_vetoed_candidate_with_no_alternative_leaves_group_unnamed() -> None:
    centroid = neural_print(E0, voiced_frames=200)
    a = rec.KnownVoice(name="Wrong", vec=vec_at_cos(0.90), rejects=[vec_at_cos(0.91)])
    out = rec.recognize_groups([centroid], [a], blocked=[])
    assert out == [None]


def test_recognize_groups_skips_non_neural_and_none_centroids() -> None:
    known = [rec.KnownVoice(name="Zed", vec=vec_at_cos(0.85))]
    dsp_centroid = dsp_print(dim=21, voiced_frames=200)
    out = rec.recognize_groups([None, dsp_centroid], known, blocked=[])
    assert out == [None, None]
