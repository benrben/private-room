"""Session-centering, DSP threshold, and eigengap math for diarization."""

from __future__ import annotations

import math

import numpy as np

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


def _vector_copies(vecs: list[np.ndarray]) -> list[np.ndarray]:
    return [np.array(v, dtype=np.float64, copy=True) for v in vecs]


def _share_dimension(vecs: list[np.ndarray], dim: int) -> bool:
    return all(int(v.shape[0]) == dim for v in vecs)


def _shrunken_mean(vecs: list[np.ndarray], dim: int) -> np.ndarray:
    mean = np.zeros(dim, dtype=np.float64)
    for v in vecs:
        mean += np.asarray(v, dtype=np.float64)
    return mean / len(vecs) * (len(vecs) / (len(vecs) + 3.0))


def _centered_vector(vec: np.ndarray, mean: np.ndarray) -> np.ndarray:
    centered = np.asarray(vec, dtype=np.float64) - mean
    norm = float(np.sqrt(np.sum(centered * centered)))
    if norm < 1e-4:
        return np.array(vec, dtype=np.float64, copy=True)
    return centered / norm


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
    if n < 2:
        return _vector_copies(vecs)
    if not _share_dimension(vecs, dim):
        return _vector_copies(vecs)
    mean = _shrunken_mean(vecs, dim)
    return [_centered_vector(v, mean) for v in vecs]


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


def _single_dsp_threshold(similarity: float) -> float | None:
    return 0.30 if similarity < 0.30 else None


def _readable_dsp_cut(cut: float, gap: float) -> float | None:
    if gap < 0.15 or cut > 0.80:
        return None
    return cut


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
        return _single_dsp_threshold(sims[0])

    arr = np.asarray(sorted(sims), dtype=np.float64)
    best_k = otsu_split(arr)
    cut = float((arr[best_k - 1] + arr[best_k]) / 2.0)
    gap = float(arr[best_k] - arr[best_k - 1])
    return _readable_dsp_cut(cut, gap)


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


def _neighbor_count(n: int, p_frac: float) -> int:
    proposed = _round_half_away_from_zero(n * p_frac)
    return max(1, min(proposed, n - 1))


def _sorted_neighbors(cvecs: list[np.ndarray], source: int) -> list[tuple[float, int]]:
    row: list[tuple[float, int]] = []
    for candidate in range(len(cvecs)):
        if candidate != source:
            row.append((_dot(cvecs[source], cvecs[candidate]), candidate))
    return sorted(row, key=lambda pair: -pair[0])


def _symmetrized_neighbors(cvecs: list[np.ndarray], neighbor_count: int) -> np.ndarray:
    n = len(cvecs)
    sym = np.zeros((n, n), dtype=np.float64)
    for source in range(n):
        for _, target in _sorted_neighbors(cvecs, source)[:neighbor_count]:
            sym[source, target] += 0.5
            sym[target, source] += 0.5
    return sym


def _laplacian_eigenvalues(sym: np.ndarray) -> np.ndarray:
    degree = sym.sum(axis=1)
    return sym_eigenvalues(np.diag(degree) - sym)


def _largest_eigengap(eigenvalues: np.ndarray, cap: int) -> tuple[float, int]:
    largest_gap = -math.inf
    count = 1
    for index in range(min(cap, len(eigenvalues) - 1)):
        gap = float(eigenvalues[index + 1] - eigenvalues[index])
        if gap > largest_gap:
            largest_gap = gap
            count = index + 1
    return largest_gap, count


def _eigen_count_candidate(cvecs: list[np.ndarray], cap: int, p_frac: float) -> tuple[float, int]:
    neighbor_count = _neighbor_count(len(cvecs), p_frac)
    eigenvalues = _laplacian_eigenvalues(_symmetrized_neighbors(cvecs, neighbor_count))
    gap, count = _largest_eigengap(eigenvalues, cap)
    return (neighbor_count / len(cvecs)) / (gap + 1e-6), count


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
        ratio, count = _eigen_count_candidate(cvecs, cap, p_frac)
        if ratio < best_ratio:
            best_ratio = ratio
            best_count = count

    return max(1, min(best_count, cap))


# =============================================================================
# ---- Voice: a cluster being built during agglomerative merging -------------
# =============================================================================
