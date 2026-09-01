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

import numpy as np

from .cluster_constants import (
    AUTO_MAX_SPEAKERS as AUTO_MAX_SPEAKERS,
    COUNT_FLOOR as COUNT_FLOOR,
    MIN_CLUSTER_FRAMES as MIN_CLUSTER_FRAMES,
    MIN_CLUSTER_PHRASES as MIN_CLUSTER_PHRASES,
    MIN_OPEN_FRAMES as MIN_OPEN_FRAMES,
    MIN_UPDATE_FRAMES as MIN_UPDATE_FRAMES,
    SPLIT_MIN_VOICE_FRAMES as SPLIT_MIN_VOICE_FRAMES,
)
from .cluster_continuity import (
    _continuity_assignments,
    _number_assignments,
    _transition_logs as _transition_logs,
)
from .cluster_math import (
    _dot,
    center_prints as center_prints,
    dsp_split_threshold as dsp_split_threshold,
    eigen_count as eigen_count,
    otsu_split as otsu_split,
    sym_eigenvalues as sym_eigenvalues,
)
from .embed import (
    MIN_NEW_VOICE_FRAMES,
    Gates,
    VoicePrint,
    gates_for,
)
from .speaker_book import SpeakerBook as SpeakerBook

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

# Subsampling size for the eigengap COUNT decision on large sessions --
# counting doesn't need every phrase, an even subsample keeps the
# eigendecomposition small enough to re-run mid-meeting (the merge itself
# still uses every print).
_COUNT_SAMPLE: int = 120

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


def _strong_print_indices(prints: list[VoicePrint], min_voice_frames: int) -> list[int]:
    return [i for i, print in enumerate(prints) if print.defines_voice(min_voice_frames)]


def _single_voice_assignments(prints: list[VoicePrint]) -> list[int | None]:
    assignments: list[int | None] = [None] * len(prints)
    for index, print in enumerate(prints):
        if not print.is_silent():
            assignments[index] = 0
    return assignments


def _live_print_indices(prints: list[VoicePrint]) -> list[int]:
    return [i for i, print in enumerate(prints) if not print.is_silent()]


def _live_vectors(prints: list[VoicePrint], live: list[int]) -> list[np.ndarray]:
    return [np.asarray(prints[index].vec, dtype=np.float64) for index in live]


def _centered_or_raw_vectors(gates: Gates, vectors: list[np.ndarray]) -> list[np.ndarray]:
    if gates.center:
        return center_prints(vectors)
    return [np.array(vector, copy=True) for vector in vectors]


def _place_vectors(
    print_count: int, live: list[int], vectors: list[np.ndarray]
) -> list[np.ndarray | None]:
    placed: list[np.ndarray | None] = [None] * print_count
    for offset, index in enumerate(live):
        placed[index] = vectors[offset]
    return placed


def _centered_print_vectors(
    prints: list[VoicePrint], live: list[int], gates: Gates
) -> list[np.ndarray | None]:
    vectors = _centered_or_raw_vectors(gates, _live_vectors(prints, live))
    return _place_vectors(len(prints), live, vectors)


def _strong_vectors(cvec: list[np.ndarray | None], strong: list[int]) -> list[np.ndarray]:
    return [cvec[index] for index in strong]  # type: ignore[misc]


def _pair_similarities(vectors: list[np.ndarray]) -> list[float]:
    similarities: list[float] = []
    for first in range(len(vectors)):
        for second in range(first + 1, len(vectors)):
            similarities.append(_dot(vectors[first], vectors[second]))
    return similarities


def _dsp_stop_rule(vectors: list[np.ndarray]) -> tuple[str, float | int]:
    threshold = dsp_split_threshold(_pair_similarities(vectors))
    if threshold is None:
        return "merge_all", 0.0
    return "bar", threshold


def _count_stop_rule(vectors: list[np.ndarray], cap: int) -> tuple[str, float | int]:
    if len(vectors) > _COUNT_SAMPLE:
        step = len(vectors) / _COUNT_SAMPLE
        sampled = [vectors[int(offset * step)] for offset in range(_COUNT_SAMPLE)]
        return "count", eigen_count(sampled, cap)
    return "count", eigen_count(vectors, cap)


def _centered_stop_rule(
    gates: Gates, strong: list[int], vectors: list[np.ndarray], cap: int
) -> tuple[str, float | int]:
    if len(strong) >= 4:
        return _count_stop_rule(vectors, cap)
    return "bar", gates.split


def _stop_rule(
    gates: Gates, strong: list[int], vectors: list[np.ndarray], cap: int
) -> tuple[str, float | int]:
    if gates.center:
        return _centered_stop_rule(gates, strong, vectors, cap)
    return _dsp_stop_rule(vectors)


def _seed_voices(
    prints: list[VoicePrint], strong: list[int], cvec: list[np.ndarray | None]
) -> list[Voice]:
    return [
        Voice.seed(index, cvec[index], prints[index].voiced_frames)  # type: ignore[arg-type]
        for index in strong
    ]


def _voice_units(voices: list[Voice]) -> list[np.ndarray]:
    return [voice.unit() for voice in voices]


def _unit_similarity_matrix(units: list[np.ndarray]) -> list[list[float]]:
    return [[_dot(units[first], units[second]) for second in range(len(units))] for first in range(len(units))]


def _nearest_cached_pair(similarities: list[list[float]]) -> tuple[int, int, float]:
    best_first, best_second, best_similarity = 0, 0, -math.inf
    for first in range(len(similarities)):
        for second in range(first + 1, len(similarities)):
            if similarities[first][second] > best_similarity:
                best_first, best_second, best_similarity = first, second, similarities[first][second]
    return best_first, best_second, best_similarity


def _should_stop_merging(
    voice_count: int, cap: int, stop_kind: str, stop_value: float | int, similarity: float
) -> bool:
    if voice_count > cap:
        return False
    if stop_kind == "count":
        return voice_count <= max(int(stop_value), 1) or similarity < COUNT_FLOOR
    if stop_kind == "bar":
        return similarity < float(stop_value)
    return False


def _merge_cached_pair(
    voices: list[Voice], units: list[np.ndarray], similarities: list[list[float]], first: int, second: int
) -> None:
    voices[first].absorb(voices.pop(second))
    units.pop(second)
    similarities.pop(second)
    for row in similarities:
        row.pop(second)
    units[first] = voices[first].unit()
    for index in range(len(voices)):
        similarity = _dot(units[first], units[index])
        similarities[first][index] = similarity
        similarities[index][first] = similarity


def _merge_to_stop_rule(
    voices: list[Voice], units: list[np.ndarray], stop_kind: str, stop_value: float | int, cap: int
) -> None:
    similarities = _unit_similarity_matrix(units)
    while True:
        if len(voices) <= 1:
            return
        first, second, similarity = _nearest_cached_pair(similarities)
        if _should_stop_merging(len(voices), cap, stop_kind, stop_value, similarity):
            return
        _merge_cached_pair(voices, units, similarities, first, second)


def _raw_voice_unit(voice: Voice, prints: list[VoicePrint]) -> np.ndarray:
    dimension = int(np.asarray(prints[voice.members[0]].vec).shape[0])
    vector_sum = np.zeros(dimension, dtype=np.float64)
    for member in voice.members:
        weight = float(max(prints[member].voiced_frames, 1))
        vector_sum = vector_sum + np.asarray(prints[member].vec, dtype=np.float64) * weight
    norm = max(float(np.sqrt(np.sum(vector_sum * vector_sum))), 1e-9)
    return vector_sum / norm


def _raw_voice_units(voices: list[Voice], prints: list[VoicePrint]) -> list[np.ndarray]:
    return [_raw_voice_unit(voice, prints) for voice in voices]


def _nearest_raw_pair(units: list[np.ndarray]) -> tuple[int, int, float]:
    best_first, best_second, best_similarity = 0, 0, -math.inf
    for first in range(len(units)):
        for second in range(first + 1, len(units)):
            similarity = _dot(units[first], units[second])
            if similarity > best_similarity:
                best_first, best_second, best_similarity = first, second, similarity
    return best_first, best_second, best_similarity


def _collapse_raw_matches(voices: list[Voice], units: list[np.ndarray], prints: list[VoicePrint], gates: Gates) -> None:
    while len(voices) > 1:
        first, second, similarity = _nearest_raw_pair(_raw_voice_units(voices, prints))
        if similarity < gates.raw_same:
            return
        voices[first].absorb(voices.pop(second))
        units[:] = _voice_units(voices)


def _minimum_cluster_mass(live_count: int) -> tuple[int, int]:
    if live_count < 20:
        return 1, 0
    return MIN_CLUSTER_PHRASES, MIN_CLUSTER_FRAMES


def _is_real_voice(voice: Voice, window_scale: bool, min_phrases: int, min_frames: int) -> bool:
    if window_scale:
        return voice.frames >= max(min_frames, MIN_CLUSTER_FRAMES)
    return len(voice.members) >= min_phrases or voice.frames >= min_frames


def _unreal_voice_indices(
    voices: list[Voice], window_scale: bool, min_phrases: int, min_frames: int
) -> list[int]:
    return [
        index
        for index, voice in enumerate(voices)
        if not _is_real_voice(voice, window_scale, min_phrases, min_frames)
    ]


def _has_real_alternative(
    voices: list[Voice], worst: int, window_scale: bool, min_phrases: int, min_frames: int
) -> bool:
    for index, voice in enumerate(voices):
        if index != worst:
            if _is_real_voice(voice, window_scale, min_phrases, min_frames):
                return True
    return False


def _nearest_real_voice(
    voices: list[Voice], units: list[np.ndarray], worst: int, window_scale: bool, min_phrases: int, min_frames: int
) -> int:
    nearest = -1
    best_similarity = -math.inf
    worst_unit = voices[worst].unit()
    for index, voice in enumerate(voices):
        if index == worst or not _is_real_voice(voice, window_scale, min_phrases, min_frames):
            continue
        similarity = _dot(worst_unit, units[index])
        if similarity >= best_similarity:
            best_similarity = similarity
            nearest = index
    return nearest


def _phantom_absorb_floor(window_scale: bool) -> int:
    return 2 if window_scale else 1


def _absorb_phantom_voices(
    voices: list[Voice], units: list[np.ndarray], live_count: int, min_voice_frames: int
) -> None:
    min_phrases, min_frames = _minimum_cluster_mass(live_count)
    window_scale = min_voice_frames == SPLIT_MIN_VOICE_FRAMES
    absorb_floor = _phantom_absorb_floor(window_scale)
    while len(voices) > absorb_floor:
        candidates = _unreal_voice_indices(voices, window_scale, min_phrases, min_frames)
        if not candidates:
            return
        worst = min(candidates, key=lambda index: voices[index].frames)
        if not _has_real_alternative(voices, worst, window_scale, min_phrases, min_frames):
            return
        nearest = _nearest_real_voice(voices, units, worst, window_scale, min_phrases, min_frames)
        moved = voices.pop(worst)
        if nearest > worst:
            nearest -= 1
        voices[nearest].absorb(moved)
        units[:] = _voice_units(voices)


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
    strong = _strong_print_indices(prints, min_voice_frames)
    if not strong:
        return _single_voice_assignments(prints)
    gates = gates_for(prints[strong[0]].vec)
    cap = max(max_speakers, 1)
    live = _live_print_indices(prints)
    cvec = _centered_print_vectors(prints, live, gates)
    strong_vectors = _strong_vectors(cvec, strong)
    stop_kind, stop_value = _stop_rule(gates, strong, strong_vectors, cap)
    voices = _seed_voices(prints, strong, cvec)
    units = _voice_units(voices)
    _merge_to_stop_rule(voices, units, stop_kind, stop_value, cap)
    _collapse_raw_matches(voices, units, prints, gates)
    _absorb_phantom_voices(voices, units, len(live), min_voice_frames)
    sequence = sorted(live, key=lambda index: spans[index][0])
    assignments = _continuity_assignments(sequence, spans, prints, cvec, units, min_voice_frames)
    return _number_assignments(sequence, assignments, len(prints))


# =============================================================================
# ---- SpeakerBook: live, online per-phrase speaker assignment ---------------
# =============================================================================
