"""Global clustering + online speaker assignment for the meeting lane.

Ported from the "global clustering" section of ``diarize.rs`` (lines
692-1347: from the ``center_prints`` session-centering helper through the end
of ``SpeakerBook``). The per-print embedding machinery (``VoicePrint``,
``Gates``, ``cosine``, the print-generation gates) lives in the sibling
``embed.py`` and is imported from there rather than redefined -- see that
module's docstring for the two-generation contract this module also depends
on (neural vs. DSP prints never compare across generations).

## What this module ports

- :func:`center_prints` -- session-mean shrinkage centering (``shrink =
  N/(N+3)``): removes the shared per-session channel (codec, loudspeaker,
  room, mic distance) that otherwise inflates every pairwise similarity.
- :func:`otsu_split` / :func:`dsp_split_threshold` -- the legacy DSP-space
  session-histogram cut, kept verbatim as the fallback rule for that
  ungoverned space.
- :func:`sym_eigenvalues` / :func:`eigen_count` -- NME-SC-style voice
  counting: an affinity graph's Laplacian eigengap, swept over four graph
  sparsities and picked by the lowest "ratio". See :func:`sym_eigenvalues`'s
  docstring for the deliberate eigvalsh-over-hand-rolled-Jacobi choice.
- :class:`Voice` -- a voice being built during agglomerative merging: which
  prints it holds, its duration-weighted vector sum, and the unit centroid
  the whole pipeline compares through (pyannote's centroid-linkage method).
- :func:`cluster` / :func:`cluster_gated` -- the full multi-stage pipeline:
  strong-phrase gating, session centering, one of three stopping rules
  (eigengap COUNT, a fixed similarity BAR, or MERGE_ALL), agglomerative
  merge-nearest-pair, a raw-space same-voice collapse pass, phantom-cluster
  absorption by minimum cluster mass, and a two-round Viterbi
  turn-continuity pass with a gap-dependent transition prior.
- :class:`SpeakerBook` -- the live, online, per-phrase speaker assignment
  used the instant a phrase is transcribed (before the next full re-cluster).

## Constants not (yet) in ``embed.py``

``embed.py``'s docstring is explicit that it deliberately does NOT carry the
clustering/online-assignment constants (``MIN_OPEN_FRAMES``,
``MIN_UPDATE_FRAMES``, ``MIN_CLUSTER_PHRASES``, ``MIN_CLUSTER_FRAMES``,
``AUTO_MAX_SPEAKERS``, ``SPLIT_MIN_VOICE_FRAMES``, ``COUNT_FLOOR``) -- that
module only ever needed ``MIN_NEW_VOICE_FRAMES`` (imported from there below).
They are defined LOCALLY in this file instead, verbatim against
``diarize.rs`` lines 107-297. A future pass may want to hoist these into a
shared constants module; not done here to keep this port a faithful,
single-file mirror of the Rust section it covers.

## Numeric-fidelity note

Rust computes this whole section in ``f32``. This port computes internally
in ``float64`` throughout (session means, voice sums, similarity scores,
Viterbi log-scores) and only ever compares against the SAME thresholds the
Rust uses -- a strictly higher-precision choice in the same spirit
``embed.py``'s own docstring describes for its FFT/accumulator choices, not
a change to any formula, constant, or threshold. The one exception is
:func:`sym_eigenvalues`, which is documented separately below.
"""

from __future__ import annotations

import math
import re

import numpy as np

from .embed import (
    MIN_NEW_VOICE_FRAMES,
    Gates,
    VoicePrint,
    cosine,
    gates_for,
)

__all__ = [
    "MIN_NEW_VOICE_FRAMES",
    "MIN_OPEN_FRAMES",
    "MIN_UPDATE_FRAMES",
    "MIN_CLUSTER_PHRASES",
    "MIN_CLUSTER_FRAMES",
    "AUTO_MAX_SPEAKERS",
    "SPLIT_MIN_VOICE_FRAMES",
    "COUNT_FLOOR",
    "center_prints",
    "otsu_split",
    "dsp_split_threshold",
    "sym_eigenvalues",
    "eigen_count",
    "Voice",
    "cluster",
    "cluster_gated",
    "SpeakerBook",
]

# =============================================================================
# ---- Constants missing from embed.py (see module docstring) ----------------
# Ported verbatim from diarize.rs lines 107-297.
# =============================================================================

# Voiced frames before a LIVE phrase may open a brand-new speaker (~2.5 s).
# diart-style: creation is the costliest online mistake (a phantom is on
# screen until the next re-cluster), so it takes far more evidence than
# attachment. `cluster` still discovers new voices from shorter (>= 1 s)
# phrases at every re-cluster.
MIN_OPEN_FRAMES: int = 156

# Voiced frames before a live phrase may UPDATE a centroid (~1.5 s) -- noisy
# short evidence must never drag an established voice (diart's rho_update).
MIN_UPDATE_FRAMES: int = 94

# A voice below BOTH bars after clustering is a phantom: fewer phrases than
# this...
MIN_CLUSTER_PHRASES: int = 2
# ...and less cumulative voiced speech than this (16 ms frames, ~= 5 s) -- it
# is absorbed into the nearest surviving voice instead of being reported
# (pyannote's `min_cluster_size`, scaled to phrase units).
MIN_CLUSTER_FRAMES: int = 312

# Safety ceiling when the participant count is discovered rather than given
# (the normal case). Far above a real meeting's distinct voices, so it only
# ever stops pathological runaway labeling.
AUTO_MAX_SPEAKERS: int = 8

# Voiced frames (16 ms) a SUB-WINDOW needs to help define a voice (~0.3 s).
# The phrase gate (~1 s) is unreachable inside a 1.5 s window. This gate
# exists ONLY for the split pass; whole phrases keep MIN_NEW_VOICE_FRAMES.
SPLIT_MIN_VOICE_FRAMES: int = 20

# A COUNT-driven merge must still clear this centered-space similarity. The
# eigengap count is an estimate, not evidence: 0.07 sits on the measured
# plateau where every held-out meeting keeps its true speaker count and
# nothing over-splits.
COUNT_FLOOR: float = 0.07

# Subsampling size for the eigengap COUNT decision on large sessions --
# counting doesn't need every phrase, an even subsample keeps the
# eigendecomposition small enough to re-run mid-meeting (the merge itself
# still uses every print).
_COUNT_SAMPLE: int = 120

# The four graph sparsities eigen_count sweeps, in the exact order the Rust
# tie-break ("first p_frac wins on an equal ratio") depends on.
_P_FRACS: tuple[float, ...] = (0.05, 0.1, 0.15, 0.25)


def _dot(a: np.ndarray, b: np.ndarray) -> float:
    """Plain dot product in float64 -- the ``dot`` helper diarize.rs shares
    across this whole section."""
    return float(np.dot(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)))


def _round_half_away_from_zero(x: float) -> int:
    """Rust's ``f32::round`` (round-half-AWAY-from-zero), which differs from
    Python's banker's-rounding ``round()`` exactly at ``.5`` boundaries --
    the boundary this function's only caller (:func:`eigen_count`'s ``p``
    computation) can genuinely land on for small ``n``."""
    return math.floor(x + 0.5) if x >= 0 else math.ceil(x - 0.5)


# =============================================================================
# ---- Session centering ------------------------------------------------------
# =============================================================================


def center_prints(vecs: list[np.ndarray]) -> list[np.ndarray]:
    """Session-mean shrinkage centering (the cheap 80% of Kaldi's
    conversation-dependent PCA / VBx's center+whiten): subtract the mean of
    the session's prints from each print and renormalize.

    Every phrase in a session shares one channel -- codec, loudspeaker, room,
    mic distance -- which adds a common component to every embedding,
    inflating all pairwise similarities and crushing the spread between
    voices. The mean is SHRUNK toward zero on small sessions (``shrink =
    n/(n+3)``): with a handful of prints the mean is mostly those voices
    themselves, and subtracting it whole would erase the very geometry being
    read (at n=2 it maps any pair to exact opposites).

    Returns copies unchanged (no centering at all) when there are fewer than
    2 prints, or when the prints don't all share one dimensionality.
    """
    n = len(vecs)
    dim = int(vecs[0].shape[0]) if vecs else 0
    if n < 2 or any(int(v.shape[0]) != dim for v in vecs):
        return [np.array(v, dtype=np.float64, copy=True) for v in vecs]

    mean = np.zeros(dim, dtype=np.float64)
    for v in vecs:
        mean += np.asarray(v, dtype=np.float64)
    shrink = n / (n + 3.0)
    mean = mean / n * shrink

    out: list[np.ndarray] = []
    for v in vecs:
        vv = np.asarray(v, dtype=np.float64)
        c = vv - mean
        norm = float(np.sqrt(np.sum(c * c)))
        if norm < 1e-4:
            # A print AT the mean: centering says nothing -- keep it raw.
            out.append(np.array(vv, copy=True))
        else:
            out.append(c / norm)
    return out


# =============================================================================
# ---- The legacy DSP session-histogram rule ----------------------------------
# =============================================================================


def otsu_split(sims: np.ndarray) -> int:
    """Otsu's method over sorted pairwise similarities: the split index ``k``
    (in ``1..len(sims)``) that maximizes between-class variance.

    ``sims`` MUST already be sorted ascending -- this function does not sort
    (matching the Rust contract; the caller, :func:`dsp_split_threshold`,
    sorts before calling).
    """
    n = int(sims.shape[0])
    total = float(np.sum(sims, dtype=np.float64))
    best_score = -math.inf
    best_k = 1
    low_sum = 0.0
    for k in range(1, n):
        low_sum += float(sims[k - 1])
        weight_low = k / n
        weight_high = (n - k) / n
        low_class_mean = low_sum / k
        high_class_mean = (total - low_sum) / (n - k)
        score = weight_low * weight_high * (high_class_mean - low_class_mean) ** 2
        if score > best_score:
            best_score = score
            best_k = k
    return best_k


def dsp_split_threshold(sims: list[float]) -> float | None:
    """The legacy DSP space's session threshold -- the pre-neural rule, kept
    verbatim for the fallback because that space has NO absolute operating
    point: Otsu over the pairwise similarities, believed only when the
    distribution genuinely breaks (gap >= 0.15, cut <= 0.80); a lone pair
    splits below 0.30; no readable valley -> one voice (``None``).
    """
    n = len(sims)
    if n == 0:
        return None
    if n == 1:
        return 0.30 if sims[0] < 0.30 else None

    arr = np.asarray(sorted(sims), dtype=np.float64)
    best_k = otsu_split(arr)
    cut = float((arr[best_k - 1] + arr[best_k]) / 2.0)
    gap = float(arr[best_k] - arr[best_k - 1])
    if gap < 0.15 or cut > 0.80:
        return None  # one voice, however varied its sentences
    return cut


# =============================================================================
# ---- Eigengap voice counting ------------------------------------------------
# =============================================================================


def sym_eigenvalues(a: np.ndarray) -> np.ndarray:
    """Eigenvalues of a small real symmetric matrix, ascending.

    **Chosen implementation: ``numpy.linalg.eigvalsh`` directly, NOT a
    hand-rolled port of the Rust's cyclic-Jacobi sweep.** Rust hand-rolled
    Jacobi (``sym_eigenvalues`` in diarize.rs, 12 sweeps, off-diagonal
    convergence, single/double Givens rotation) ONLY to avoid taking a
    linear-algebra dependency the app didn't otherwise need. That constraint
    doesn't exist here: numpy (and the LAPACK ``dsyevd``/``dsyevr`` routine
    ``eigvalsh`` calls) is already this rewrite's first-order numeric
    dependency. ``eigvalsh`` solves the exact same well-posed problem --
    real symmetric matrix in, real eigenvalues out, ascending order -- to
    machine precision, with no risk of a hand-rolled-in-Python bug (an
    off-by-one sweep count, a wrong rotation sign, ...). Jacobi is only ever
    an *approximation* of what ``eigvalsh`` computes exactly, so there is no
    scenario in which re-deriving it here would be MORE correct.

    ``tests/test_diar_cluster.py`` keeps a faithful hand-rolled port of the
    Rust Jacobi solver ONLY as a cross-validation utility (never imported by
    this module) and checks it agrees with both ``eigvalsh`` and two
    eigvalsh-independent ground truths (trace and determinant identities).
    """
    arr = np.asarray(a, dtype=np.float64)
    n = arr.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.float64)
    return np.linalg.eigvalsh(arr)


def eigen_count(cvecs: list[np.ndarray], cap: int) -> int:
    """How many voices the session's affinity structure holds (NeMo's NME-SC
    idea, sized down): binarize each print's strongest links, and read the
    count from the graph Laplacian's eigengap.

    Tries FOUR graph sparsities (``p_frac`` in 0.05/0.1/0.15/0.25 of the
    neighbor count), builds a symmetrized top-p-neighbor binarized graph for
    each, takes the unnormalized Laplacian ``D - S``, finds the largest
    eigengap up to ``cap``, and picks the ``p_frac``/gap combination with the
    LOWEST ``(p/n) / gap`` ratio across all four -- the whole trick is this
    ratio-minimization across sparsities, not any single graph.

    Real callers only ever reach this with ``len(cvecs) >= 4`` (the ``strong
    >= 4`` branch in :func:`cluster_gated` -- below that Rust itself would
    panic on ``n - 1`` underflowing an unsigned index). ``n < 2`` is guarded
    here anyway (returning 1, "nothing to read") purely so a unit test can
    poke this function in isolation without tripping a ZeroDivisionError on
    ``n == 0`` -- a defensive addition with no effect on any real call site.
    """
    n = len(cvecs)
    if n < 2:
        return 1
    best_ratio = math.inf
    best_count = 1
    for p_frac in _P_FRACS:
        p = _round_half_away_from_zero(n * p_frac)
        p = max(1, min(p, n - 1))

        # Top-p neighbors per row, binarized and symmetrized.
        sym = np.zeros((n, n), dtype=np.float64)
        for i in range(n):
            row = sorted(
                ((_dot(cvecs[i], cvecs[j]), j) for j in range(n) if j != i),
                key=lambda t: -t[0],  # stable: ties keep ascending-j order
            )
            for _, j in row[:p]:
                sym[i, j] += 0.5
                sym[j, i] += 0.5

        # Unnormalized Laplacian L = D - S.
        d = sym.sum(axis=1)
        lap = np.diag(d) - sym

        ev = sym_eigenvalues(lap)
        upto = min(cap, n - 1)
        gap = -math.inf
        count = 1
        for k in range(upto):
            g = float(ev[k + 1] - ev[k])
            if g > gap:
                gap = g
                count = k + 1

        ratio = (p / n) / (gap + 1e-6)
        if ratio < best_ratio:
            best_ratio = ratio
            best_count = count

    return max(1, min(best_count, cap))


# =============================================================================
# ---- Voice: a cluster being built during agglomerative merging -------------
# =============================================================================


class Voice:
    """A voice being built: which prints it holds, its duration-weighted
    vector sum (centered space) and total voiced frames. The unit centroid
    is the linkage everything is compared through -- pyannote's centroid
    method."""

    __slots__ = ("members", "sum", "frames")

    def __init__(self, members: list[int], vec_sum: np.ndarray, frames: int) -> None:
        self.members: list[int] = members
        self.sum: np.ndarray = vec_sum
        self.frames: int = frames

    @staticmethod
    def seed(i: int, cvec: np.ndarray, frames: int) -> "Voice":
        w = float(max(frames, 1))
        return Voice([i], np.asarray(cvec, dtype=np.float64) * w, frames)

    def absorb(self, other: "Voice") -> None:
        self.members.extend(other.members)
        self.sum = self.sum + other.sum
        self.frames += other.frames

    def unit(self) -> np.ndarray:
        norm = max(float(np.sqrt(np.sum(self.sum * self.sum))), 1e-9)
        return self.sum / norm


# =============================================================================
# ---- cluster() / cluster_gated(): the full pipeline -------------------------
# =============================================================================


def cluster(
    prints: list[VoicePrint],
    spans: list[tuple[int, int]],
    max_speakers: int,
) -> list[int | None]:
    """Group a recording's phrases into voices -- the production recipe:
    session centering, agglomerative merging under one FIXED per-space bar
    (or an eigengap-discovered count) with centroid linkage, a raw-space
    same-voice collapse, phantom absorption by minimum cluster mass, then a
    turn-continuity (Viterbi) pass over the timeline.

    ``spans`` are each print's (t0, t1) centiseconds -- the continuity pass
    needs the gaps between phrases. Strong phrases (>= ~1 s of speech) define
    the voices; short ones are assigned but never create or anchor one.
    Returns a cluster index per input print, numbered by first appearance, or
    ``None`` for prints that carry no voice at all.

    Callers must pass prints of ONE generation; the gates are read from that
    generation's space.
    """
    return cluster_gated(prints, spans, max_speakers, MIN_NEW_VOICE_FRAMES)


def cluster_gated(
    prints: list[VoicePrint],
    spans: list[tuple[int, int]],
    max_speakers: int,
    min_voice_frames: int,
) -> list[int | None]:
    """:func:`cluster` with the voice-defining evidence bar as a parameter:
    whole phrases use ``MIN_NEW_VOICE_FRAMES``, the split pass's 1.5 s
    sub-windows use ``SPLIT_MIN_VOICE_FRAMES`` -- same recipe, two evidence
    scales."""
    assert len(prints) == len(spans)
    n_prints = len(prints)
    strong: list[int] = [i for i in range(n_prints) if prints[i].defines_voice(min_voice_frames)]
    out: list[int | None] = [None] * n_prints

    if not strong:
        # Nothing long enough to define a voice: everyone who spoke is one.
        for i, p in enumerate(prints):
            if not p.is_silent():
                out[i] = 0
        return out

    g: Gates = gates_for(prints[strong[0]].vec)
    cap = max(max_speakers, 1)

    # Centered copies of every non-silent print -- weak ones too: they are
    # assigned in the same space, they just never define a voice.
    live: list[int] = [i for i in range(n_prints) if not prints[i].is_silent()]
    live_vecs = [np.asarray(prints[i].vec, dtype=np.float64) for i in live]
    if g.center:
        centered = center_prints(live_vecs)
    else:
        centered = [np.array(v, copy=True) for v in live_vecs]
    cvec: list[np.ndarray | None] = [None] * n_prints
    for k, i in enumerate(live):
        cvec[i] = centered[k]

    strong_cvecs = [cvec[i] for i in strong]  # type: ignore[misc]  # strong subset of live

    # How many voices to keep.
    stop_kind: str
    stop_value: float | int
    if not g.center:
        # The DSP fallback has no absolute operating point; it keeps its
        # proven session rule.
        sims: list[float] = []
        for a in range(len(strong_cvecs)):
            for b in range(a + 1, len(strong_cvecs)):
                sims.append(_dot(strong_cvecs[a], strong_cvecs[b]))
        threshold = dsp_split_threshold(sims)
        if threshold is not None:
            stop_kind, stop_value = "bar", threshold
        else:
            stop_kind, stop_value = "merge_all", 0.0
    elif len(strong) >= 4:
        # COUNTING doesn't need every phrase -- an even subsample keeps the
        # eigendecomposition small enough to re-run mid-meeting (the merge
        # itself still uses every print).
        if len(strong_cvecs) > _COUNT_SAMPLE:
            step = len(strong_cvecs) / _COUNT_SAMPLE
            sampled = [strong_cvecs[int(k * step)] for k in range(_COUNT_SAMPLE)]
            stop_kind, stop_value = "count", eigen_count(sampled, cap)
        else:
            stop_kind, stop_value = "count", eigen_count(strong_cvecs, cap)
    else:
        stop_kind, stop_value = "bar", g.split

    # Agglomerative merging down to the target (or the bar). The pairwise
    # centroid similarities are cached and only the merged row is
    # recomputed.
    voices: list[Voice] = [
        Voice.seed(i, cvec[i], prints[i].voiced_frames) for i in strong  # type: ignore[arg-type]
    ]
    units: list[np.ndarray] = [v.unit() for v in voices]
    sims_m: list[list[float]] = [
        [_dot(units[a], units[b]) for b in range(len(voices))] for a in range(len(voices))
    ]

    while True:
        if len(voices) <= 1:
            break
        best_a, best_b, best_sim = 0, 0, -math.inf
        for a in range(len(voices)):
            for b in range(a + 1, len(voices)):
                if sims_m[a][b] > best_sim:
                    best_a, best_b, best_sim = a, b, sims_m[a][b]
        a, b, sim = best_a, best_b, best_sim

        done = False
        if len(voices) <= cap:
            if stop_kind == "count":
                k_target = int(stop_value)
                # The floor turns the count from an override into a bound:
                # however few voices the eigengap claims, two clusters that
                # do not actually sound alike are never fused.
                done = len(voices) <= max(k_target, 1) or sim < COUNT_FLOOR
            elif stop_kind == "bar":
                done = sim < float(stop_value)
            else:  # merge_all
                done = False
        if done:
            break

        moved = voices.pop(b)
        voices[a].absorb(moved)
        units.pop(b)
        sims_m.pop(b)
        for row in sims_m:
            row.pop(b)
        units[a] = voices[a].unit()
        for x in range(len(voices)):
            s = _dot(units[a], units[x])
            sims_m[a][x] = s
            sims_m[x][a] = s

    # Same-voice collapse (raw space): clusters whose UNCENTERED centroids
    # agree at `raw_same` are one person, whatever the count said.
    while True:
        if len(voices) <= 1:
            break
        raw_units: list[np.ndarray] = []
        for v in voices:
            dim = int(np.asarray(prints[v.members[0]].vec).shape[0])
            s = np.zeros(dim, dtype=np.float64)
            for m in v.members:
                w = float(max(prints[m].voiced_frames, 1))
                s = s + np.asarray(prints[m].vec, dtype=np.float64) * w
            norm = max(float(np.sqrt(np.sum(s * s))), 1e-9)
            raw_units.append(s / norm)

        best_a, best_b, best_sim = 0, 0, -math.inf
        for a in range(len(voices)):
            for b in range(a + 1, len(voices)):
                s = _dot(raw_units[a], raw_units[b])
                if s > best_sim:
                    best_a, best_b, best_sim = a, b, s

        if best_sim < g.raw_same:
            break
        moved = voices.pop(best_b)
        voices[best_a].absorb(moved)
        units = [v.unit() for v in voices]

    # Phantom absorption (pyannote's min_cluster_size): a voice that never
    # accumulated real mass is not reported -- its phrases go to the nearest
    # voice that did.
    if len(live) < 20:
        min_phrases, min_frames = 1, 0
    else:
        min_phrases, min_frames = MIN_CLUSTER_PHRASES, MIN_CLUSTER_FRAMES

    window_scale = min_voice_frames == SPLIT_MIN_VOICE_FRAMES

    def is_real(v: Voice) -> bool:
        if window_scale:
            return v.frames >= max(min_frames, MIN_CLUSTER_FRAMES)
        return len(v.members) >= min_phrases or v.frames >= min_frames

    absorb_floor = 2 if window_scale else 1
    while len(voices) > absorb_floor:
        candidates = [i for i in range(len(voices)) if not is_real(voices[i])]
        if not candidates:
            break
        # Rust's `min_by_key`: first minimum wins on ties -- Python's min()
        # already does this.
        worst = min(candidates, key=lambda i: voices[i].frames)
        if not any(i != worst and is_real(voices[i]) for i in range(len(voices))):
            break
        unit_w = voices[worst].unit()
        # Rust's `max_by`: LAST maximum wins on ties -- replicate with `>=`.
        nearest = -1
        best_val = -math.inf
        for i in range(len(voices)):
            if i == worst or not is_real(voices[i]):
                continue
            v = _dot(unit_w, units[i])
            if v >= best_val:
                best_val = v
                nearest = i
        moved = voices.pop(worst)
        if nearest > worst:
            nearest -= 1
        voices[nearest].absorb(moved)
        units = [v.unit() for v in voices]

    # Turn-continuity pass (the cheap stand-in for VBx's sticky HMM): walk
    # the timeline, let each phrase choose the voice it sounds like, with a
    # prior that adjacent phrases (< 1.5 s gap) are usually the same person
    # and distant ones carry no prior at all.
    seq = sorted(live, key=lambda i: spans[i][0])
    assign: list[int] = []
    if len(voices) == 1:
        assign = [0] * len(seq)
    else:
        for _round in range(2):
            k = len(voices)

            def ln_emit(i: int, v_idx: int) -> float:
                return _dot(cvec[i], units[v_idx]) / 0.15  # type: ignore[arg-type]

            back: list[list[int]] = []
            score = [ln_emit(seq[0], v) for v in range(k)]
            for w in range(1, len(seq)):
                gap = spans[seq[w]][0] - spans[seq[w - 1]][1]
                if gap < 150:
                    stay = 0.9
                elif gap < 300:
                    stay = 0.7
                else:
                    stay = 1.0 / k
                switch = max((1.0 - stay) / (k - 1.0), 1e-6)
                ln_stay = math.log(max(stay, 1e-6))
                ln_switch = math.log(switch)

                next_score = [-math.inf] * k
                frm = [0] * k
                for v in range(k):
                    for u in range(k):
                        t = ln_stay if u == v else ln_switch
                        s = score[u] + t
                        if s > next_score[v]:
                            next_score[v] = s
                            frm[v] = u
                    next_score[v] += ln_emit(seq[w], v)
                score = next_score
                back.append(frm)

            # Rust's `max_by`: LAST maximum wins on ties.
            best = 0
            for v in range(1, k):
                if score[v] >= score[best]:
                    best = v
            path = [best] * len(seq)
            for w in range(len(seq) - 1, 0, -1):
                best = back[w - 1][best]
                path[w - 1] = best

            changed = path != assign
            assign = path

            # Re-anchor the voices on what the pass decided (strong prints
            # only -- weak ones are labeled but never reshape a voice).
            dim = int(units[0].shape[0])
            sums = [np.zeros(dim, dtype=np.float64) for _ in range(k)]
            mass = [0] * k
            for w, i in enumerate(seq):
                if not prints[i].defines_voice(min_voice_frames):
                    continue
                fr = float(max(prints[i].voiced_frames, 1))
                sums[assign[w]] = sums[assign[w]] + cvec[i] * fr  # type: ignore[operator]
                mass[assign[w]] += prints[i].voiced_frames
            for v in range(k):
                if mass[v] > 0:
                    norm = max(float(np.sqrt(np.sum(sums[v] * sums[v]))), 1e-9)
                    units[v] = sums[v] / norm

            if not changed:
                break

    # Number the voices by when each was first heard (voices the continuity
    # pass emptied simply never get a number).
    order: list[int] = []
    for w, i in enumerate(seq):
        v = assign[w]
        if v not in order:
            order.append(v)
        out[i] = order.index(v)
    return out


# =============================================================================
# ---- SpeakerBook: live, online per-phrase speaker assignment ---------------
# =============================================================================


class SpeakerBook:
    """The **provisional** live label for a phrase, produced the instant it
    is transcribed: nearest known voice, or a new one when nothing is close
    and the phrase is long enough to be sure. Deliberately simple and a
    little conservative -- :func:`cluster` revisits the whole recording on
    every flush and corrects these labels with the benefit of everything
    heard since.

    **The number of participants is discovered, not declared.**
    """

    def __init__(self, max_speakers: int = AUTO_MAX_SPEAKERS) -> None:
        self.max_speakers: int = max(1, min(max_speakers, AUTO_MAX_SPEAKERS))
        # Speakers already named in a resumed file. New voices are numbered
        # after them (their centroids are not persisted, so they cannot be
        # re-matched).
        self.base: int = 0
        # (running centroid, phrase count) per opened voice.
        self.centroids: list[list] = []

    @classmethod
    def auto(cls) -> "SpeakerBook":
        """Discover however many people are in the meeting (the normal
        case)."""
        return cls(AUTO_MAX_SPEAKERS)

    @classmethod
    def with_cap(cls, max_speakers: int) -> "SpeakerBook":
        """Pin the participant count -- used when a caller genuinely knows
        it (e.g. a one-on-one), which collapses stray voices onto the
        nearest."""
        return cls(max_speakers)

    def seed_labels(self, existing_speaker_labels: list[str]) -> None:
        """On resume, keep numbering after the speakers already in the
        file. Those voices can't be re-identified (no persisted centroids),
        so a returning speaker may get a fresh number.

        Ported without depending on a ``RecSegment`` type (that model
        doesn't exist yet in this migration): takes plain "Speaker N"-shaped
        label strings instead of Rust's slice of ``RecSegment``, extracting
        the same max-N-plus-one base logic. Rust's
        ``s.speaker.strip_prefix("Speaker ")?.parse::<usize>().ok()``
        requires the ENTIRE remainder after the prefix to be a bare
        non-negative integer (no sign, no whitespace) -- mirrored here with
        a strict ``^[0-9]+$`` match rather than Python's more permissive
        ``str.isdigit()`` (which also accepts non-ASCII digit characters
        Rust's parser would reject).
        """
        best = 0
        for label in existing_speaker_labels:
            if not label.startswith("Speaker "):
                continue
            rest = label[len("Speaker ") :]
            if re.fullmatch(r"[0-9]+", rest):
                n = int(rest)
                if n > best:
                    best = n
        self.base = min(best, self.max_speakers - 1)

    def room_left(self) -> int:
        """How many distinct voices this session may still open."""
        return max(self.max_speakers - self.base, 1)

    def assign(self, print: VoicePrint | None) -> str:  # noqa: A002 - matches Rust field name
        if print is None or print.is_silent():
            return f"Speaker {self.base + 1}"

        emb = np.asarray(print.vec, dtype=np.float64)
        g = gates_for(emb)

        # Rust's `max_by`: LAST maximum wins on ties.
        best: tuple[int, float] | None = None
        for i, (c, _n) in enumerate(self.centroids):
            sim = cosine(emb, c)
            if best is None or sim >= best[1]:
                best = (i, sim)

        # Opening a NEW voice is the costliest live mistake, so it takes a
        # lot: room under the cap, ~2.5 s of actual speech, and clear
        # distance from EVERY voice already known (checked via the best/
        # highest similarity, which is equivalent to checking every one).
        may_open = len(self.centroids) < self.room_left() and print.voiced_frames >= MIN_OPEN_FRAMES

        if best is not None:
            i, sim = best
            if sim >= g.online_same:
                idx = i
            elif sim < g.online_new and may_open:
                self.centroids.append([np.array(emb, copy=True), 0])
                idx = len(self.centroids) - 1
            else:
                idx = i
        else:
            self.centroids.append([np.array(emb, copy=True), 0])
            idx = 0

        c, cnt = self.centroids[idx]
        if cnt > 0 and print.voiced_frames >= MIN_UPDATE_FRAMES and len(c) == len(emb):
            # Running-mean centroid, frozen after enough evidence so one odd
            # phrase can't drag an established voice away (diart's
            # rho_update).
            w = float(min(cnt, 20))
            c = (c * w + emb) / (w + 1.0)
            norm = max(float(np.sqrt(np.sum(c * c))), 1e-6)
            c = c / norm
        self.centroids[idx] = [c, cnt + 1]

        return f"Speaker {self.base + idx + 1}"
