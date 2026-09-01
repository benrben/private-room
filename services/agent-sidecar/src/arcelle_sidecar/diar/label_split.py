"""Word/window split planning for the diarization naming pass."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import TypeVar

from arcelle_sidecar.diar.cluster import (
    AUTO_MAX_SPEAKERS,
    SPLIT_MIN_VOICE_FRAMES,
    cluster_gated,
)
from arcelle_sidecar.diar.embed import VoicePrint
from arcelle_sidecar.diar.windows import span_print
from arcelle_sidecar.rec.meta import RecSegment, RecWord

NamingT = TypeVar("NamingT")
Clusterer = Callable[
    [list[VoicePrint], list[tuple[int, int]], int, int],
    list[int | None],
]
ApplyNames = Callable[
    [list[RecSegment], list[list[int]], list[list[int]], NamingT],
    bool,
]


def _nearest_window_id(
    wins: list[tuple[int, tuple[int, int]]], ids: list[int | None], mid: int
) -> int | None:
    """Return the nearest window's cluster id, keeping the first tie."""
    best_k: int | None = None
    best_dist: int | None = None
    for k, (begin, end) in wins:
        dist = abs((begin + end) // 2 - mid)
        if best_dist is None or dist < best_dist:
            best_dist = dist
            best_k = k
    if best_k is None:
        return None
    return ids[best_k]


def _split_cap(max_speakers: int) -> int:
    return max_speakers if max_speakers != 0 else AUTO_MAX_SPEAKERS


def _segment_windows(
    segments: list[RecSegment],
    wins_for: Callable[[RecSegment], list[tuple[int, int, VoicePrint]]],
) -> list[list[tuple[int, int, VoicePrint]]]:
    return [wins_for(segment) for segment in segments]


def _lane_segment_indexes(
    segments: list[RecSegment],
    seg_wins: list[list[tuple[int, int, VoicePrint]]],
    lane: str,
) -> list[int]:
    return [
        index
        for index, segment in enumerate(segments)
        if segment.source == lane and seg_wins[index]
    ]


def _lane_window_data(
    indexes: list[int],
    seg_wins: list[list[tuple[int, int, VoicePrint]]],
) -> tuple[list[VoicePrint], list[tuple[int, int]], list[int]]:
    prints: list[VoicePrint] = []
    spans: list[tuple[int, int]] = []
    owner: list[int] = []
    for index in indexes:
        for begin, end, voice in seg_wins[index]:
            prints.append(voice)
            spans.append((begin, end))
            owner.append(index)
    return prints, spans, owner


def _segment_window_indexes(owner: list[int], segment_index: int) -> list[int]:
    return [index for index, window_owner in enumerate(owner) if window_owner == segment_index]


def _word_voice_labels(
    words: list[RecWord],
    wins: list[tuple[int, tuple[int, int]]],
    ids: list[int | None],
) -> list[int | None]:
    labels: list[int | None] = []
    last: int | None = None
    for word in words:
        mid = (word.t0 + word.t1) // 2
        best = _nearest_window_id(wins, ids, mid)
        if best is None:
            best = last
        last = best
        labels.append(best)
    return labels


def _first_known_label(labels: list[int | None]) -> int | None:
    for label in labels:
        if label is not None:
            return label
    return None


def _replace_unknown_labels(labels: list[int | None], voice: int) -> list[int | None]:
    return [label if label is not None else voice for label in labels]


def _backfill_unknown_labels(labels: list[int | None]) -> list[int | None]:
    first_known = _first_known_label(labels)
    if first_known is None:
        return labels
    return _replace_unknown_labels(labels, first_known)


def _voice_cuts(labels: list[int | None]) -> list[tuple[int | None, tuple[int, int]]]:
    if not labels:
        return []
    cuts: list[tuple[int | None, tuple[int, int]]] = []
    start = 0
    for index in range(1, len(labels)):
        if labels[index] != labels[start]:
            cuts.append((labels[start], (start, index)))
            start = index
    cuts.append((labels[start], (start, len(labels))))
    return cuts


def _segment_voice_cuts(
    segment: RecSegment,
    owner: list[int],
    segment_index: int,
    spans: list[tuple[int, int]],
    ids: list[int | None],
) -> list[tuple[int | None, tuple[int, int]]]:
    indexes = _segment_window_indexes(owner, segment_index)
    wins = [(index, spans[index]) for index in indexes]
    labels = _word_voice_labels(segment.words, wins, ids)
    return _voice_cuts(_backfill_unknown_labels(labels))


def _plan_lane_splits(
    segments: list[RecSegment],
    seg_wins: list[list[tuple[int, int, VoicePrint]]],
    lane: str,
    cap: int,
    plan: list[list[tuple[int | None, tuple[int, int]]] | None],
    clusterer: Clusterer,
) -> int:
    indexes = _lane_segment_indexes(segments, seg_wins, lane)
    prints, spans, owner = _lane_window_data(indexes, seg_wins)
    if len(prints) < 2:
        return 0
    ids = clusterer(prints, spans, cap, SPLIT_MIN_VOICE_FRAMES)
    for index in indexes:
        plan[index] = _segment_voice_cuts(segments[index], owner, index, spans, ids)
    return _max_cluster_id(ids) + 1


def _max_cluster_id(ids: list[int | None]) -> int:
    max_id = -1
    for cluster_id in ids:
        if cluster_id is not None and cluster_id > max_id:
            max_id = cluster_id
    return max_id


def _split_plan(
    segments: list[RecSegment],
    seg_wins: list[list[tuple[int, int, VoicePrint]]],
    cap: int,
    clusterer: Clusterer,
) -> tuple[list[list[tuple[int | None, tuple[int, int]]] | None], list[int]]:
    plan: list[list[tuple[int | None, tuple[int, int]]] | None] = [None] * len(segments)
    counts = [0, 0]
    for lane_no, lane in enumerate(("mic", "sys")):
        counts[lane_no] = _plan_lane_splits(segments, seg_wins, lane, cap, plan, clusterer)
    return plan, counts


def _piece_start(segment: RecSegment, words: list[RecWord], start: int) -> int:
    return segment.t0 if start == 0 else (words[0].t0 if words else segment.t0)


def _piece_end(segment: RecSegment, words: list[RecWord], end: int) -> int:
    return segment.t1 if end == len(segment.words) else (words[-1].t1 if words else segment.t1)


def _piece_text(segment: RecSegment, words: list[RecWord], many: bool) -> str:
    if not many:
        return segment.text
    parts = [word.w.strip() for word in words]
    return " ".join(part for part in parts if part)


def _piece_voice(
    segment: RecSegment,
    windows: list[tuple[int, int, VoicePrint]],
    start: int,
    end: int,
) -> VoicePrint | None:
    voice = span_print(windows, start, end)
    return segment.voice if voice is None else voice


def _split_piece(
    segment: RecSegment,
    windows: list[tuple[int, int, VoicePrint]],
    start: int,
    end: int,
    many: bool,
) -> RecSegment:
    words = list(segment.words[start:end])
    t0 = _piece_start(segment, words, start)
    t1 = _piece_end(segment, words, end)
    return RecSegment(
        id=str(uuid.uuid4()) if many else segment.id,
        source=segment.source,
        speaker=segment.speaker,
        t0=t0,
        t1=t1,
        text=_piece_text(segment, words, many),
        words=words,
        lang=segment.lang,
        voice=_piece_voice(segment, windows, t0, t1),
    )


def _record_piece_group(
    groups: list[list[list[int]]], lane_no: int, voice: int | None, index: int
) -> None:
    if voice is not None:
        groups[lane_no][voice].append(index)


def _append_split_pieces(
    rebuilt: list[RecSegment],
    groups: list[list[list[int]]],
    lane_no: int,
    segment: RecSegment,
    windows: list[tuple[int, int, VoicePrint]],
    cuts: list[tuple[int | None, tuple[int, int]]],
) -> bool:
    many = len(cuts) > 1
    for voice, (start, end) in cuts:
        _record_piece_group(groups, lane_no, voice, len(rebuilt))
        rebuilt.append(_split_piece(segment, windows, start, end, many))
    return many


def _split_groups(counts: list[int]) -> list[list[list[int]]]:
    return [[[] for _ in range(counts[0])], [[] for _ in range(counts[1])]]


def _rebuild_split_segments(
    segments: list[RecSegment],
    seg_wins: list[list[tuple[int, int, VoicePrint]]],
    plan: list[list[tuple[int | None, tuple[int, int]]] | None],
    counts: list[int],
) -> tuple[list[RecSegment], list[list[list[int]]], bool]:
    rebuilt: list[RecSegment] = []
    groups = _split_groups(counts)
    split_any = False
    for index, segment in enumerate(segments):
        cuts = plan[index]
        if not cuts:
            rebuilt.append(segment)
            continue
        lane_no = 0 if segment.source == "mic" else 1
        if _append_split_pieces(rebuilt, groups, lane_no, segment, seg_wins[index], cuts):
            split_any = True
    return rebuilt, groups, split_any


def split_by_voice(
    segments: list[RecSegment],
    max_speakers: int,
    naming: NamingT,
    wins_for: Callable[[RecSegment], list[tuple[int, int, VoicePrint]]],
    apply_names: ApplyNames[NamingT],
    clusterer: Clusterer = cluster_gated,
) -> bool:
    """Cluster word windows, split phrases, and apply the shared naming pass."""
    seg_wins = _segment_windows(segments, wins_for)
    plan, counts = _split_plan(segments, seg_wins, _split_cap(max_speakers), clusterer)
    rebuilt, groups, split_any = _rebuild_split_segments(segments, seg_wins, plan, counts)
    mic_groups, sys_groups = groups
    renamed = apply_names(rebuilt, mic_groups, sys_groups, naming)
    if split_any or renamed:
        segments[:] = rebuilt
        return True
    return False
