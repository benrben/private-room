"""Tests for `arcelle_sidecar.diar.cluster` -- the Python port of the
"global clustering" section of `src-tauri/src/recording/diarize.rs` (lines
692-1347: `center_prints` through the end of `SpeakerBook`).

There is no labeled meeting-audio corpus on this machine, so a diarization
error-rate gate against real data (the real validation of this algorithm) is
out of scope here -- blocked pending the owner's real data (see project
memory). What IS validated, per the porting brief:

  1. The eigensolver actually used in production (`sym_eigenvalues`, a thin
     wrapper over `numpy.linalg.eigvalsh`) cross-checked against `eigvalsh`
     directly AND against two eigvalsh-independent ground truths (trace =
     sum of eigenvalues, determinant = product of eigenvalues), on random
     symmetric matrices of several sizes -- a real, ground-truth-backed,
     audio-free test. A faithful hand-rolled port of the Rust's cyclic-Jacobi
     sweep (`_jacobi_eigenvalues`, test-only -- never imported by
     `cluster.py`) is ALSO cross-checked against `eigvalsh` directly, per the
     porting brief's "try both if time allows": no disagreement is expected
     or found (eigvalsh is exact; Jacobi only approximates it).
  2. `otsu_split` on constructed bimodal similarity arrays.
  3. `dsp_split_threshold`'s branches: empty, single-value above/below 0.30,
     a genuine gap-and-cut case, a no-valley case, and a valley-but-cut-too-
     high case.
  4. `center_prints`: n < 2 and dimension-mismatch passthrough; the n=2 and
     n=3 shrinkage factors verified against hand-computed expectations; the
     "print at the mean" fallback-to-raw guard.
  5. `eigen_count` on synthetic embeddings: an obviously-2-cluster session
     and an obviously-1-cluster session, plus a degenerate-small-n case that
     must not crash.
  6. `cluster()` end-to-end on synthetic VoicePrint sessions: one direction
     collapses to a single voice (exercising the raw-space same-voice
     collapse pass against the "centering a solo session produces noise"
     failure mode it exists to guard); two well-separated 192-dim groups (the
     neural-gate dimensionality) produce exactly two correctly-grouped,
     correctly-time-ordered voices; short/weak prints are labeled but never
     open a voice of their own; all-silent prints all come back `None`; and
     a session with no strong phrases at all puts everyone who spoke on
     voice 0.
  7. `SpeakerBook`: same-voice attachment, a long different print opening a
     new speaker, a short different print NOT opening one, the "neither
     close enough to attach nor far enough to open" middle-ground branch,
     `with_cap(1)` never opening a second speaker, `seed_labels` continuing
     numbering after the highest existing well-formed "Speaker N" (ignoring
     malformed ones) and clamping to the cap, `room_left`, and a silent/None
     print returning the base label without touching any centroid.

## Reproducibility note

A few tests below use synthetic random embeddings for `eigen_count`/
`cluster`. `eigen_count` (the graph-Laplacian eigengap heuristic) is, by the
Rust module's own comments, "an estimate, not evidence" -- it is genuinely
sensitive to small n and low dimensionality (a KNN-graph fragility, not a
porting bug: the production pipeline never trusts it unguarded either, see
`COUNT_FLOOR` and the two absorption/collapse passes that run after it).
Scenarios below use cluster/point counts and seeds confirmed by hand to be
robust wherever that matters.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from arcelle_sidecar.diar import cluster as dc
from arcelle_sidecar.diar.embed import NEURAL_GATES, VoicePrint


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.sqrt(np.sum(v * v))


# =============================================================================
# ---- constants: verbatim against diarize.rs ---------------------------------
# =============================================================================


def test_constants_match_rust_source() -> None:
    """diarize.rs lines 144-196 -- values this module defines locally
    because embed.py (the sibling embedding-half port) doesn't carry the
    clustering-half constants; see the module docstring's rationale."""
    assert dc.MIN_NEW_VOICE_FRAMES == 62
    assert dc.MIN_OPEN_FRAMES == 156
    assert dc.MIN_UPDATE_FRAMES == 94
    assert dc.MIN_CLUSTER_PHRASES == 2
    assert dc.MIN_CLUSTER_FRAMES == 312
    assert dc.AUTO_MAX_SPEAKERS == 8
    assert dc.SPLIT_MIN_VOICE_FRAMES == 20
    assert dc.COUNT_FLOOR == pytest.approx(0.07)


def test_neural_gates_constants_match_rust() -> None:
    # Verbatim from diarize.rs NEURAL_GATES -- a cheap guard against a silent
    # drift between embed.py and the Rust source.
    assert NEURAL_GATES.split == pytest.approx(0.36)
    assert NEURAL_GATES.center is True
    assert NEURAL_GATES.raw_same == pytest.approx(0.69)
    assert NEURAL_GATES.online_same == pytest.approx(0.40)
    assert NEURAL_GATES.online_new == pytest.approx(0.20)


# =============================================================================
# ---- (1) eigensolver: eigvalsh (production) + hand-rolled Jacobi (test-only
#          cross-validation, per the porting brief's "try both") -------------
# =============================================================================


def _jacobi_eigenvalues(a: np.ndarray) -> np.ndarray:
    """Faithful, line-by-line, TEST-ONLY port of diarize.rs `sym_eigenvalues`
    (lines 781-818): 12 sweeps of cyclic Jacobi rotations over all
    off-diagonal (p, q) pairs, converged early once the off-diagonal mass
    drops below 1e-9. `cluster.py` does NOT import this (it uses
    `numpy.linalg.eigvalsh` directly, see that function's docstring for why)
    -- this exists purely so this test file can confirm the hand-rolled
    approach the Rust took would have agreed, exactly as the porting brief's
    "try both if time allows" suggests. Computed in float64 (Rust: f32); a
    strictly higher-precision choice, not a formula change.
    """
    a = np.array(a, dtype=np.float64, copy=True)
    n = a.shape[0]
    for _sweep in range(12):
        off = 0.0
        for i in range(n):
            for j in range(i + 1, n):
                off += a[i, j] * a[i, j]
        if off < 1e-9:
            break
        for p in range(n):
            for q in range(p + 1, n):
                apq = a[p, q]
                if abs(apq) < 1e-12:
                    continue
                theta = 0.5 * (a[q, q] - a[p, p]) / apq
                sign = 1.0 if theta >= 0.0 else -1.0
                t = sign / (abs(theta) + math.sqrt(theta * theta + 1.0))
                c = 1.0 / math.sqrt(t * t + 1.0)
                s = t * c
                for k in range(n):
                    akp, akq = a[k, p], a[k, q]
                    a[k, p] = c * akp - s * akq
                    a[k, q] = s * akp + c * akq
                for k in range(n):
                    apk, aqk = a[p, k], a[q, k]
                    a[p, k] = c * apk - s * aqk
                    a[q, k] = s * apk + c * aqk
    ev = np.array([a[i, i] for i in range(n)], dtype=np.float64)
    ev.sort()
    return ev


def _random_symmetric(n: int, rng: np.random.Generator) -> np.ndarray:
    m = rng.standard_normal((n, n))
    return (m + m.T) / 2.0


@pytest.mark.parametrize("n", [3, 4, 5, 6, 8, 10, 12])
def test_sym_eigenvalues_matches_eigvalsh_and_ground_truth(n: int) -> None:
    """sym_eigenvalues (what eigen_count actually calls) against eigvalsh
    directly plus two eigvalsh-INDEPENDENT ground truths: sum of eigenvalues
    == trace, product of eigenvalues == determinant. A wrong wrapper that
    still happened to superficially "look like" eigvalsh's output would still
    have to satisfy these."""
    rng = np.random.default_rng(1000 + n)
    for _trial in range(5):
        a = _random_symmetric(n, rng)
        ev = dc.sym_eigenvalues(a)

        assert ev.shape[0] == n
        assert np.all(np.diff(ev) >= -1e-9)  # ascending

        expected = np.linalg.eigvalsh(a)
        np.testing.assert_allclose(ev, expected, rtol=1e-9, atol=1e-9)

        np.testing.assert_allclose(np.sum(ev), np.trace(a), rtol=1e-8, atol=1e-6)
        np.testing.assert_allclose(np.prod(ev), np.linalg.det(a), rtol=1e-6, atol=1e-6)


@pytest.mark.parametrize("n", [3, 4, 5, 6, 8, 10, 12])
@pytest.mark.parametrize("seed", [0, 1, 2])
def test_hand_rolled_jacobi_matches_eigvalsh(n: int, seed: int) -> None:
    """Per the porting brief's "try both if time allows": the hand-rolled
    cyclic-Jacobi port genuinely agrees with `numpy.linalg.eigvalsh` on
    random symmetric matrices -- confirming there is no real reason to prefer
    the hand-rolled approach in `cluster.py` itself (see `sym_eigenvalues`'s
    docstring)."""
    rng = np.random.default_rng(seed * 100 + n)
    m = rng.standard_normal((n, n))
    m = (m + m.T) / 2.0
    expected = np.linalg.eigvalsh(m)
    got = _jacobi_eigenvalues(m)
    assert got.shape == expected.shape
    assert np.all(np.diff(got) >= -1e-9)
    np.testing.assert_allclose(got, expected, atol=1e-6, rtol=1e-6)


def test_sym_eigenvalues_empty() -> None:
    assert dc.sym_eigenvalues(np.zeros((0, 0))).shape == (0,)


# =============================================================================
# ---- (2) otsu_split ----------------------------------------------------------
# =============================================================================


def test_otsu_split_finds_bimodal_boundary() -> None:
    low = [0.10, 0.15, 0.12]
    high = [0.80, 0.85, 0.82]
    sims = np.asarray(sorted(low + high), dtype=np.float64)
    k = dc.otsu_split(sims)
    assert k == 3
    assert sims[k - 1] < 0.2
    assert sims[k] > 0.7


def test_otsu_split_uneven_group_sizes() -> None:
    low = [0.2, 0.22, 0.19, 0.21, 0.20]
    high = [0.9, 0.88]
    sims = np.asarray(sorted(low + high), dtype=np.float64)
    k = dc.otsu_split(sims)
    assert k == len(low)


def test_otsu_split_k_in_valid_range() -> None:
    sims = np.array(sorted([0.2, 0.3, 0.35, 0.9, 0.91]))
    k = dc.otsu_split(sims)
    assert 1 <= k < len(sims)


# =============================================================================
# ---- (3) dsp_split_threshold's branches -------------------------------------
# =============================================================================


def test_dsp_split_threshold_empty_is_none() -> None:
    assert dc.dsp_split_threshold([]) is None


def test_dsp_split_threshold_single_value_branches() -> None:
    assert dc.dsp_split_threshold([0.10]) == pytest.approx(0.30)
    assert dc.dsp_split_threshold([0.50]) is None


def test_dsp_split_threshold_genuine_gap_and_cut() -> None:
    # Bimodal sims: sorted [0.1, 0.12, 0.15, 0.8, 0.82, 0.85]. Otsu splits at
    # k=3, cut = (0.15+0.8)/2 = 0.475, gap = 0.65 -- clears both the gap>=0.15
    # and cut<=0.80 bars, so a real threshold comes back.
    sims = [0.1, 0.15, 0.12, 0.8, 0.85, 0.82]
    t = dc.dsp_split_threshold(sims)
    assert t == pytest.approx(0.475)


def test_dsp_split_threshold_no_valley_returns_none() -> None:
    # A tight, unimodal spread: no gap anywhere near 0.15, so the whole
    # session reads as one voice.
    sims = [0.5, 0.55, 0.52, 0.58, 0.53, 0.51, 0.54]
    assert dc.dsp_split_threshold(sims) is None


def test_dsp_split_threshold_valley_but_cut_too_high_returns_none() -> None:
    # A gap exists but sits entirely above the 0.80 ceiling -- the legacy
    # rule refuses to trust a split entirely inside the same-voice cohesion
    # zone.
    sims = [0.83, 0.84, 0.85, 0.98, 0.99]
    assert dc.dsp_split_threshold(sims) is None


# =============================================================================
# ---- (4) center_prints -------------------------------------------------------
# =============================================================================


def test_center_prints_n_under_2_returns_unchanged_copies() -> None:
    v = np.array([0.6, 0.8, 0.0], dtype=np.float32)
    out = dc.center_prints([v])
    assert len(out) == 1
    np.testing.assert_allclose(out[0], v)
    out[0][0] = 999.0
    assert v[0] == 0.6  # a copy, not the same object

    assert dc.center_prints([]) == []


def test_center_prints_dimension_mismatch_returns_unchanged_copies() -> None:
    v0 = np.array([1.0, 0.0], dtype=np.float32)
    v1 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    out = dc.center_prints([v0, v1])
    np.testing.assert_allclose(out[0], v0)
    np.testing.assert_allclose(out[1], v1)


def test_center_prints_shrinkage_factor_hand_computed() -> None:
    # n=2: shrink = 2/5 = 0.4. Hand-computed expected result for v0=[1,0],
    # v1=[0,1]: mean = ([0.5,0.5]) * 0.4 = [0.2,0.2]; centered0 = [0.8,-0.2],
    # renormalized.
    v0 = np.array([1.0, 0.0], dtype=np.float64)
    v1 = np.array([0.0, 1.0], dtype=np.float64)
    n = 2
    shrink = n / (n + 3.0)
    assert shrink == pytest.approx(0.4)

    mean = (v0 + v1) / n * shrink
    expected0 = v0 - mean
    expected0 = expected0 / np.sqrt(np.sum(expected0**2))
    expected1 = v1 - mean
    expected1 = expected1 / np.sqrt(np.sum(expected1**2))

    out = dc.center_prints([v0, v1])
    np.testing.assert_allclose(out[0], expected0, atol=1e-10)
    np.testing.assert_allclose(out[1], expected1, atol=1e-10)
    assert np.linalg.norm(out[0]) == pytest.approx(1.0, abs=1e-9)

    # n=3 case too, checking the shrink value itself against 3/6=0.5.
    v2 = np.array([1.0, 1.0], dtype=np.float64) / math.sqrt(2.0)
    n3 = 3
    shrink3 = n3 / (n3 + 3.0)
    assert shrink3 == pytest.approx(0.5)
    mean3 = (v0 + v1 + v2) / n3 * shrink3
    expected2 = v2 - mean3
    expected2 = expected2 / np.sqrt(np.sum(expected2**2))
    out3 = dc.center_prints([v0, v1, v2])
    np.testing.assert_allclose(out3[2], expected2, atol=1e-10)


def test_center_prints_at_the_mean_returns_raw() -> None:
    """A print AT the session mean (post-shrinkage): its centered vector
    would have ~zero norm, so it must be returned unchanged rather than
    divided by ~zero. Two exactly-zero vectors are trivially both at the
    (zero) mean."""
    v0 = np.zeros(4, dtype=np.float64)
    v1 = np.zeros(4, dtype=np.float64)
    out = dc.center_prints([v0, v1])
    np.testing.assert_allclose(out[0], v0)
    np.testing.assert_allclose(out[1], v1)


# =============================================================================
# ---- (5) eigen_count on synthetic clusters ----------------------------------
# =============================================================================


def _cluster_vectors(
    centers: list[np.ndarray], per_cluster: int, noise: float, rng: np.random.Generator
) -> list[np.ndarray]:
    out: list[np.ndarray] = []
    dim = centers[0].shape[0]
    for c in centers:
        for _ in range(per_cluster):
            v = c + rng.normal(scale=noise, size=dim)
            v = v / np.sqrt(np.sum(v * v))
            out.append(v)
    return out


def test_eigen_count_two_obviously_separated_clusters() -> None:
    # per_cluster=15 (n=30 total): large enough that even the sparsest
    # p_frac=0.05 sweep rounds to p=2 neighbors, avoiding the fragmentation
    # a 1-NN graph is prone to regardless of true cluster count. Verified
    # stable while authoring this test.
    rng = np.random.default_rng(42)
    dim = 10
    c0 = rng.normal(size=dim)
    c0 /= np.linalg.norm(c0)
    c1 = rng.normal(size=dim)
    c1 -= np.dot(c1, c0) * c0  # force near-orthogonality to c0
    c1 /= np.linalg.norm(c1)

    vecs = _cluster_vectors([c0, c1], per_cluster=15, noise=0.03, rng=rng)
    assert dc.eigen_count(vecs, cap=8) == 2


def test_eigen_count_single_cluster() -> None:
    rng = np.random.default_rng(7)
    dim = 10
    c0 = rng.normal(size=dim)
    c0 /= np.linalg.norm(c0)
    vecs = _cluster_vectors([c0], per_cluster=40, noise=0.03, rng=rng)
    assert dc.eigen_count(vecs, cap=8) == 1


def test_eigen_count_degenerate_small_n_does_not_crash() -> None:
    """Real callers only ever reach `eigen_count` with n >= 4 (the `strong >=
    4` branch in `cluster_gated`), but the function must not blow up if
    poked directly with a degenerate input."""
    assert dc.eigen_count([], 8) == 1
    v = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    assert dc.eigen_count([v], 8) == 1


# =============================================================================
# ---- dot() / Voice ------------------------------------------------------------
# =============================================================================


def test_dot_matches_numpy() -> None:
    a = np.array([1.0, 2.0, 3.0])
    b = np.array([4.0, 5.0, 6.0])
    assert dc._dot(a, b) == pytest.approx(float(np.dot(a, b)))


def test_voice_seed_absorb_unit() -> None:
    v1 = dc.Voice.seed(0, np.array([1.0, 0.0]), frames=10)
    v2 = dc.Voice.seed(1, np.array([0.0, 1.0]), frames=30)
    np.testing.assert_allclose(v1.unit(), [1.0, 0.0], atol=1e-6)
    v1.absorb(v2)
    assert v1.members == [0, 1]
    assert v1.frames == 40
    # duration-weighted sum: 10*[1,0] + 30*[0,1] = [10,30], unit = [10,30]/norm
    expected = _unit(np.array([10.0, 30.0]))
    np.testing.assert_allclose(v1.unit(), expected, atol=1e-6)


# =============================================================================
# ---- (6) cluster() end-to-end ------------------------------------------------
# =============================================================================


def _prints_from_vecs(vecs: list[np.ndarray], frames: int = 100) -> list[VoicePrint]:
    return [VoicePrint(vec=v, voiced_frames=frames) for v in vecs]


def _sequential_spans(n: int, gap_cs: int = 200) -> list[tuple[int, int]]:
    spans = []
    t = 0
    for _ in range(n):
        spans.append((t, t + 100))
        t += gap_cs
    return spans


def test_cluster_single_direction_collapses_to_one_voice() -> None:
    """Every print a small perturbation of ONE direction, in 192-dim (the
    neural-gate dimensionality) -- must all land on cluster index 0.

    With only ~9-16 prints, session-mean centering (shrink ~= n/(n+3))
    subtracts almost the whole vector from itself, leaving mostly NOISE in
    the centered space -- exactly the "centering a session that IS one voice
    leaves only noise" failure mode the Rust docs describe. The raw-space
    same-voice collapse pass is what pulls it back together; if that pass
    were missing or wrong, this session would plausibly explode into several
    spurious voices.
    """
    dim = 192
    rng = np.random.default_rng(123)
    direction = _unit(rng.standard_normal(dim))
    r = np.random.default_rng(5)
    vecs = [_unit(direction + 0.05 * r.standard_normal(dim)).astype(np.float32) for _ in range(16)]
    prints = _prints_from_vecs(vecs)
    spans = _sequential_spans(16)
    out = dc.cluster(prints, spans, dc.AUTO_MAX_SPEAKERS)
    assert out == [0] * 16


def test_cluster_two_clearly_separated_groups() -> None:
    """Two clearly separated 192-dim groups of 10 prints each -> exactly two
    distinct cluster indices, correctly grouped by first appearance in time
    (group A first in time -> cluster 0, group B -> cluster 1). >= 20 total
    live prints so the standard (not small-session-relaxed) phantom-
    absorption bars apply."""
    dim = 192
    n_per = 10
    rng = np.random.default_rng(42)
    d1 = _unit(rng.standard_normal(dim))
    d2 = _unit(rng.standard_normal(dim))
    assert abs(float(np.dot(d1, d2))) < 0.3  # genuinely well separated

    r = np.random.default_rng(1042)
    group_a = [_unit(d1 + 0.1 * r.standard_normal(dim)).astype(np.float32) for _ in range(n_per)]
    group_b = [_unit(d2 + 0.1 * r.standard_normal(dim)).astype(np.float32) for _ in range(n_per)]

    prints = _prints_from_vecs(group_a + group_b)
    spans = _sequential_spans(n_per)
    last_t = spans[-1][1] + 1000
    spans += [(last_t + i * 200, last_t + i * 200 + 100) for i in range(n_per)]

    out = dc.cluster(prints, spans, dc.AUTO_MAX_SPEAKERS)
    assert out[:n_per] == [0] * n_per
    assert out[n_per:] == [1] * n_per
    assert len(set(out)) == 2


def test_cluster_short_weak_prints_never_open_their_own_cluster() -> None:
    """A weak print (voiced_frames below MIN_NEW_VOICE_FRAMES) near neither
    established direction is assigned to an existing cluster, never a third
    one of its own."""
    dim = 192
    n_per = 10
    rng = np.random.default_rng(42)
    d1 = _unit(rng.standard_normal(dim))
    d2 = _unit(rng.standard_normal(dim))
    d3 = _unit(rng.standard_normal(dim))  # a third, unrelated direction

    r = np.random.default_rng(1042)
    group_a = [_unit(d1 + 0.1 * r.standard_normal(dim)).astype(np.float32) for _ in range(n_per)]
    group_b = [_unit(d2 + 0.1 * r.standard_normal(dim)).astype(np.float32) for _ in range(n_per)]
    weak = _unit(d3 + 0.1 * np.random.default_rng(99).standard_normal(dim)).astype(np.float32)

    prints = _prints_from_vecs(group_a + group_b)
    assert dc.MIN_NEW_VOICE_FRAMES > 20
    prints.append(VoicePrint(vec=weak, voiced_frames=20))  # weak: below the gate

    spans = _sequential_spans(n_per)
    last_t = spans[-1][1] + 1000
    spans += [(last_t + i * 200, last_t + i * 200 + 100) for i in range(n_per)]
    spans.append((spans[-1][1] + 1000, spans[-1][1] + 1030))

    out = dc.cluster(prints, spans, dc.AUTO_MAX_SPEAKERS)
    assert len(out) == len(prints)
    assert out[-1] is not None  # assigned...
    assert len(set(x for x in out if x is not None)) == 2  # ...but no 3rd cluster


def test_cluster_all_silent_prints_are_all_none() -> None:
    prints = [VoicePrint(vec=np.zeros(192, dtype=np.float32), voiced_frames=0) for _ in range(4)]
    spans = _sequential_spans(4)
    out = dc.cluster(prints, spans, dc.AUTO_MAX_SPEAKERS)
    assert out == [None, None, None, None]


def test_cluster_no_strong_prints_everyone_who_spoke_is_one() -> None:
    """Below MIN_NEW_VOICE_FRAMES for every print: nobody defines a voice, so
    every non-silent phrase is cluster 0."""
    dim = 192
    rng = np.random.default_rng(9)
    vecs = [_unit(rng.standard_normal(dim)).astype(np.float32) for _ in range(5)]
    prints = _prints_from_vecs(vecs, frames=dc.MIN_NEW_VOICE_FRAMES - 1)
    spans = _sequential_spans(5)
    out = dc.cluster(prints, spans, dc.AUTO_MAX_SPEAKERS)
    assert out == [0, 0, 0, 0, 0]


# =============================================================================
# ---- (7) SpeakerBook ---------------------------------------------------------
# =============================================================================


def test_speaker_book_same_speaker_stays_speaker_1() -> None:
    dim = 192
    rng = np.random.default_rng(3)
    direction = _unit(rng.standard_normal(dim))
    r = np.random.default_rng(7)
    book = dc.SpeakerBook.auto()
    labels = []
    for _ in range(6):
        v = _unit(direction + 0.05 * r.standard_normal(dim)).astype(np.float32)
        labels.append(book.assign(VoicePrint(vec=v, voiced_frames=100)))
    assert labels == ["Speaker 1"] * 6


def test_speaker_book_long_different_print_opens_speaker_2() -> None:
    dim = 192
    rng = np.random.default_rng(3)
    d1 = _unit(rng.standard_normal(dim))
    d2 = _unit(rng.standard_normal(dim))
    assert abs(float(np.dot(d1, d2))) < NEURAL_GATES.online_new  # genuinely far apart

    r = np.random.default_rng(7)
    book = dc.SpeakerBook.auto()
    for _ in range(5):
        v = _unit(d1 + 0.05 * r.standard_normal(dim)).astype(np.float32)
        book.assign(VoicePrint(vec=v, voiced_frames=100))

    v2 = _unit(d2 + 0.05 * r.standard_normal(dim)).astype(np.float32)
    label = book.assign(VoicePrint(vec=v2, voiced_frames=dc.MIN_OPEN_FRAMES))
    assert label == "Speaker 2"


def test_speaker_book_short_different_print_does_not_open_new_speaker() -> None:
    dim = 192
    rng = np.random.default_rng(3)
    d1 = _unit(rng.standard_normal(dim))
    d2 = _unit(rng.standard_normal(dim))
    assert abs(float(np.dot(d1, d2))) < NEURAL_GATES.online_new

    r = np.random.default_rng(7)
    book = dc.SpeakerBook.auto()
    for _ in range(5):
        v = _unit(d1 + 0.05 * r.standard_normal(dim)).astype(np.float32)
        book.assign(VoicePrint(vec=v, voiced_frames=100))

    v2 = _unit(d2 + 0.05 * r.standard_normal(dim)).astype(np.float32)
    label = book.assign(VoicePrint(vec=v2, voiced_frames=dc.MIN_OPEN_FRAMES - 1))
    assert label == "Speaker 1"  # too short to open a new speaker: attaches
    assert len(book.centroids) == 1


def test_speaker_book_online_new_requires_below_gate_against_best() -> None:
    """A print that's neither close enough to attach outright (>= online_same)
    nor far enough to justify opening a new voice (< online_new) attaches to
    the nearest instead -- the "Some((i, _)) => i" middle-ground branch."""
    book = dc.SpeakerBook.auto()
    v_a = np.array([1.0, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    # Cosine with v_a is 0.6 (between DSP_GATES.online_new=0.10 and
    # DSP_GATES.online_same=0.35): neither attaches outright nor opens.
    v_mid = np.array([0.6, 0.8, 0.0, 0.0, 0.0], dtype=np.float32)

    label1 = book.assign(VoicePrint(vec=v_a, voiced_frames=80))
    assert label1 == "Speaker 1"
    label2 = book.assign(VoicePrint(vec=v_mid, voiced_frames=1000))
    assert label2 == "Speaker 1"
    assert len(book.centroids) == 1


def test_speaker_book_with_cap_1_never_opens_second_speaker() -> None:
    dim = 192
    rng = np.random.default_rng(3)
    d1 = _unit(rng.standard_normal(dim))
    d2 = _unit(rng.standard_normal(dim))

    r = np.random.default_rng(7)
    book = dc.SpeakerBook.with_cap(1)
    for _ in range(3):
        v = _unit(d1 + 0.05 * r.standard_normal(dim)).astype(np.float32)
        assert book.assign(VoicePrint(vec=v, voiced_frames=100)) == "Speaker 1"

    # A LONG, wildly-different print still must not open Speaker 2: cap=1.
    v2 = _unit(d2 + 0.05 * r.standard_normal(dim)).astype(np.float32)
    assert book.assign(VoicePrint(vec=v2, voiced_frames=dc.MIN_OPEN_FRAMES + 200)) == "Speaker 1"
    assert len(book.centroids) == 1


def test_speaker_book_seed_labels_continues_after_highest_existing() -> None:
    book = dc.SpeakerBook.auto()
    book.seed_labels(["Speaker 1", "Speaker 3", "Speaker 2"])
    assert book.base == 3
    assert book.room_left() == dc.AUTO_MAX_SPEAKERS - 3

    dim = 192
    rng = np.random.default_rng(11)
    v = _unit(rng.standard_normal(dim)).astype(np.float32)
    label = book.assign(VoicePrint(vec=v, voiced_frames=dc.MIN_OPEN_FRAMES))
    # First voice this book has ever seen -> idx 0 -> base + 0 + 1 = 4.
    assert label == "Speaker 4"


def test_speaker_book_seed_labels_ignores_malformed_labels() -> None:
    book = dc.SpeakerBook.auto()
    book.seed_labels(["Speaker 5", "You", "speaker 9", "Speaker abc", "Speaker 3x", "Speaker "])
    assert book.base == 5  # only the well-formed "Speaker 5" counts


def test_speaker_book_seed_labels_clamps_to_cap() -> None:
    book = dc.SpeakerBook.with_cap(3)
    book.seed_labels(["Speaker 99"])
    assert book.base == 2  # clamped to max_speakers - 1
    assert book.room_left() == 1


def test_speaker_book_room_left() -> None:
    book = dc.SpeakerBook.with_cap(4)
    assert book.room_left() == 4
    book.seed_labels(["Speaker 2"])
    assert book.base == 2
    assert book.room_left() == 2


def test_speaker_book_assign_silent_print_returns_base_plus_1_label() -> None:
    book = dc.SpeakerBook.auto()
    assert book.assign(None) == "Speaker 1"
    assert book.assign(VoicePrint(vec=np.zeros(192, dtype=np.float32), voiced_frames=0)) == "Speaker 1"
    assert len(book.centroids) == 0  # a silent/None print never opens a voice
