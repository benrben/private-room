"""Viterbi continuity and re-anchoring for diarization clusters."""

from __future__ import annotations

import math

import numpy as np

from .cluster_math import _dot
from .embed import VoicePrint

def _emission(cvec: list[np.ndarray | None], index: int, unit: np.ndarray) -> float:
    return _dot(cvec[index], unit) / 0.15  # type: ignore[arg-type]


def _transition_logs(previous_span: tuple[int, int], current_span: tuple[int, int], count: int) -> tuple[float, float]:
    gap = current_span[0] - previous_span[1]
    if gap < 150:
        stay = 0.9
    elif gap < 300:
        stay = 0.7
    else:
        stay = 1.0 / count
    switch = max((1.0 - stay) / (count - 1.0), 1e-6)
    return math.log(max(stay, 1e-6)), math.log(switch)


def _initial_viterbi_scores(seq: list[int], cvec: list[np.ndarray | None], units: list[np.ndarray]) -> list[float]:
    return [_emission(cvec, seq[0], unit) for unit in units]


def _advance_viterbi(
    score: list[float], emission: float, stay_log: float, switch_log: float
) -> tuple[list[float], list[int]]:
    count = len(score)
    next_score = [-math.inf] * count
    previous = [0] * count
    for target in range(count):
        for source in range(count):
            transition = stay_log if source == target else switch_log
            candidate = score[source] + transition
            if candidate > next_score[target]:
                next_score[target] = candidate
                previous[target] = source
        next_score[target] += emission[target]
    return next_score, previous


def _last_maximum(score: list[float]) -> int:
    best = 0
    for index in range(1, len(score)):
        if score[index] >= score[best]:
            best = index
    return best


def _backtracked_path(back: list[list[int]], best: int, length: int) -> list[int]:
    path = [best] * length
    for offset in range(length - 1, 0, -1):
        best = back[offset - 1][best]
        path[offset - 1] = best
    return path


def _viterbi_path(
    seq: list[int], spans: list[tuple[int, int]], cvec: list[np.ndarray | None], units: list[np.ndarray]
) -> list[int]:
    score = _initial_viterbi_scores(seq, cvec, units)
    back: list[list[int]] = []
    for offset in range(1, len(seq)):
        stay_log, switch_log = _transition_logs(spans[seq[offset - 1]], spans[seq[offset]], len(units))
        emission = [_emission(cvec, seq[offset], unit) for unit in units]
        score, previous = _advance_viterbi(score, emission, stay_log, switch_log)
        back.append(previous)
    return _backtracked_path(back, _last_maximum(score), len(seq))


def _empty_reanchor_sums(count: int, dimension: int) -> list[np.ndarray]:
    return [np.zeros(dimension, dtype=np.float64) for _ in range(count)]


def _reanchor_mass(
    seq: list[int], assignments: list[int], prints: list[VoicePrint], cvec: list[np.ndarray | None], min_voice_frames: int, count: int, dimension: int
) -> tuple[list[np.ndarray], list[int]]:
    sums = _empty_reanchor_sums(count, dimension)
    mass = [0] * count
    for offset, index in enumerate(seq):
        if not prints[index].defines_voice(min_voice_frames):
            continue
        frames = float(max(prints[index].voiced_frames, 1))
        sums[assignments[offset]] = sums[assignments[offset]] + cvec[index] * frames  # type: ignore[operator]
        mass[assignments[offset]] += prints[index].voiced_frames
    return sums, mass


def _reanchor_units(units: list[np.ndarray], sums: list[np.ndarray], mass: list[int]) -> None:
    for index, vector_sum in enumerate(sums):
        if mass[index] > 0:
            norm = max(float(np.sqrt(np.sum(vector_sum * vector_sum))), 1e-9)
            units[index] = vector_sum / norm


def _reanchor_voice_units(
    seq: list[int], assignments: list[int], prints: list[VoicePrint], cvec: list[np.ndarray | None], units: list[np.ndarray], min_voice_frames: int
) -> None:
    sums, mass = _reanchor_mass(
        seq, assignments, prints, cvec, min_voice_frames, len(units), int(units[0].shape[0])
    )
    _reanchor_units(units, sums, mass)


def _continuity_assignments(
    seq: list[int], spans: list[tuple[int, int]], prints: list[VoicePrint], cvec: list[np.ndarray | None], units: list[np.ndarray], min_voice_frames: int
) -> list[int]:
    if len(units) == 1:
        return [0] * len(seq)
    assignments: list[int] = []
    for _round in range(2):
        path = _viterbi_path(seq, spans, cvec, units)
        changed = path != assignments
        assignments = path
        _reanchor_voice_units(seq, assignments, prints, cvec, units, min_voice_frames)
        if not changed:
            break
    return assignments


def _number_assignments(seq: list[int], assignments: list[int], print_count: int) -> list[int | None]:
    output: list[int | None] = [None] * print_count
    order: list[int] = []
    for offset, index in enumerate(seq):
        voice = assignments[offset]
        if voice not in order:
            order.append(voice)
        output[index] = order.index(voice)
    return output
