"""Naming/relabel/apply_names/move_names/lane_voices/split_by_voice -- the
Python port of the "naming brain" section of
`src-tauri/src/recording/diarize.rs` (lines 1349-1873): everything that turns
per-lane voice CLUSTERS into on-screen NAMES ("You", sticky "Speaker N",
saved-voice guesses) and writes them onto a recording's segments.

Ported functions/types, one-to-one with the Rust source:

- `Naming` / `Naming.plain` -- lines 1360-1376.
- `relabel` -- lines 1398-1410.
- `_move_names` (Rust `move_names`, private there too) -- lines 1419-1438.
- `_apply_names` (Rust `apply_names`, private) -- lines 1449-1559.
- `_recognize` (Rust `recognize`, private -- the LOCAL orchestrator that
  calls the already-ported `recognize_groups`, not to be confused with it)
  -- lines 1579-1625.
- `_lane_voices` (Rust `lane_voices`, private) -- lines 1635-1656.
- `split_by_voice` -- lines 1728-1873.

The sibling per-print/clustering/recognition machinery already lives in
`embed.py` / `cluster.py` / `recognize.py` / `windows.py` and `RecSegment`/
`RecWord` in `arcelle_sidecar.rec.meta` -- all imported from there rather
than redefined, per the porting brief.

## Deliberate, disclosed deviations from the Rust source

1. **`cosine` and `window_prints` not imported.** Both are named in the
   porting brief's dependency list alongside symbols this module DOES use,
   but grepping the actual ported Rust range (lines 1349-1873) for call
   sites of either finds none: every comparison in this range goes through
   `cluster`/`cluster_gated`/`recognize_groups` (which own their own
   `cosine` calls), and `window_prints` is a *sibling* public function in
   the same Rust source range, not a callee of anything ported here --
   `split_by_voice`'s own signature takes a `wins_for` callback from its
   caller instead (matching the Rust signature exactly: Rust's
   `split_by_voice` never calls `window_prints` either, its caller in
   `recording.rs` does). Importing either unused here would fail this
   repo's own ruff selection (`F` -- pyflakes). Both remain available to
   any caller directly from `embed.py` / `windows.py`.
2. **`split_by_voice`'s untouched-segment "clone".** The Rust source pushes
   `seg.clone()` for every phrase the cut pass leaves alone -- a real,
   independent copy, because Rust's ownership model means nothing else can
   still be holding a reference to the old segment once `*segments =
   rebuilt` replaces the vector. This port instead appends the SAME
   `RecSegment` object into the rebuilt list. This is safe for everything
   this module itself does: untouched segments are, by construction, never
   added to `mic_groups`/`sys_groups` (only pieces produced by the `cuts`
   branch ever are), so `_apply_names`'s final mutation loop -- the only
   thing in this call that ever assigns `.speaker` -- can never reach them.
   It matches the same shallow-sharing level already inherent to the
   split-piece branch's own `words = seg.words[start:end]` (a list slice
   sharing the underlying `RecWord` objects with the original, exactly as
   candidate ports of this module independently arrived at) -- so this
   deviation does not introduce a NEW aliasing risk beyond one already
   present one branch over, it just declines to invent a deeper clone
   utility this module has no other need for.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from arcelle_sidecar.diar.cluster import (
    AUTO_MAX_SPEAKERS,
    cluster,
    cluster_gated,
)
from arcelle_sidecar.diar.embed import VoicePrint, is_neural
from arcelle_sidecar.diar.label_split import (
    _backfill_unknown_labels as _backfill_unknown_labels,
    _nearest_window_id as _nearest_window_id,
    _piece_text as _piece_text,
    _piece_voice as _piece_voice,
    _voice_cuts as _voice_cuts,
    split_by_voice as _split_by_voice,
)
from arcelle_sidecar.diar.recognize import KnownVoice, identity_print, recognize_groups
from arcelle_sidecar.rec.meta import RecSegment

__all__ = [
    "Naming",
    "relabel",
    "split_by_voice",
]


@dataclass
class Naming:
    """Everything a pass needs to put NAMES on the voices it has just sorted
    out: the recording's label -> name overlay, which of those names the
    app guessed from a saved voice rather than the user typing them, and
    the saved voices to guess from.

    `names` and `recognized` are MUTATED IN PLACE by every function in this
    module (matching Rust's `&mut BTreeMap`/`&mut BTreeSet` semantics) --
    callers must pass a real mutable `dict`/`set`, not a copy, and should
    expect their own reference to reflect the final state after a call.

    `recognized` holds NAMES, not labels, deliberately -- see the Rust
    source's own doc comment on `Naming` (lines 1349-1359) for why a name is
    the stable key across re-clusters and a label is not.
    """

    names: dict[str, str]
    recognized: set[str]
    known: list[KnownVoice] = field(default_factory=list)

    @staticmethod
    def plain(names: dict[str, str], recognized: set[str]) -> "Naming":
        """The overlay with no saved voices behind it -- every caller that
        only wants clustering, and every test that is about clustering
        rather than recognition."""
        return Naming(names=names, recognized=recognized, known=[])


def relabel(segments: list[RecSegment], max_speakers: int, naming: Naming) -> bool:
    """Re-label every phrase in `segments` from the whole recording's voices
    (see `cluster`). Phrases from before voiceprints were stored are left
    exactly as they are -- and so are phrases whose prints belong to an older
    embedding generation (see `_lane_voices`). Returns True when a label
    actually moved -- or a name did -- so the caller can tell the UI.

    `segments` is mutated IN PLACE (each `RecSegment.speaker` assigned
    directly), matching Rust's `&mut [RecSegment]` slice semantics -- the
    return value is a bool, but the real "output" is the mutation.
    """
    cap = max_speakers if max_speakers != 0 else AUTO_MAX_SPEAKERS
    in_room = _lane_voices(segments, "mic", cap)
    in_meeting = _lane_voices(segments, "sys", cap)
    # Gate on PHRASES, not voices: a lone voice still needs relabeling when
    # its provisional labels drifted (a resumed file numbers the returning
    # speaker afresh; only this merge folds them back into one).
    phrases = sum(len(g) for g in in_room) + sum(len(g) for g in in_meeting)
    if phrases < 2:
        return False
    return _apply_names(segments, in_room, in_meeting, naming)


def _move_names(names: dict[str, str], moves: list[tuple[str, str]]) -> None:
    """Move the user's names onto the labels their voices now carry.

    `moves` is (the label a group used to show, the label it shows now), one
    entry per group whose label changed. A swap is handled because the new
    map is built from scratch rather than edited in place, and a name whose
    voice vanished from the transcript is dropped rather than left to attach
    itself to whoever inherits the number.

    Mutates `names` in place (clear + update) so a caller's own dict
    reference sees the final state, exactly as Rust's `*names = next;`
    mutates the map behind the caller's `&mut BTreeMap` borrow.
    """
    if not names or not moves:
        return
    next_names = _moved_names(names, moves)
    _keep_unmoved_names(next_names, names, moves)
    names.clear()
    names.update(next_names)


def _moved_names(names: dict[str, str], moves: list[tuple[str, str]]) -> dict[str, str]:
    next_names: dict[str, str] = {}
    for frm, to in moves:
        if frm in names:
            # A later mover in `moves` overwrites an earlier one's target.
            next_names[to] = names[frm]
    return next_names


def _keep_unmoved_names(
    next_names: dict[str, str], names: dict[str, str], moves: list[tuple[str, str]]
) -> None:
    # Labels no group moved away from keep their name -- unless a mover has
    # already claimed that label, whose name wins (`setdefault` only fills a
    # gap, exactly like Rust's `or_insert_with`).
    moved_from = {frm for frm, _to in moves}
    for label, name in names.items():
        if label in moved_from:
            continue
        next_names.setdefault(label, name)


def _fold_leader(counts: dict[str, int]) -> tuple[str, int] | None:
    """Strictly-greater fold over `counts` (insertion order): a tie keeps
    whichever key was encountered FIRST, matching Rust's
    `.fold(None, |best, (l, n)| match best { Some((_, m)) if n <= m => best,
    _ => Some((l, n)) })` exactly -- a new leader is only taken when its
    count is strictly more than the current best."""
    best: tuple[str, int] | None = None
    for label, n in counts.items():
        if best is None or n > best[1]:
            best = (label, n)
    return best


def _group_frames(segments: list[RecSegment], group: list[int]) -> int:
    total = 0
    for slot in group:
        voice = segments[slot].voice
        total += voice.voiced_frames if voice is not None else 0
    return total


def _you_group_index(segments: list[RecSegment], in_room: list[list[int]]) -> int | None:
    """Pick the last group tied for the largest microphone-frame count."""
    you: int | None = None
    best_frames = -1
    for index, group in enumerate(in_room):
        frames = _group_frames(segments, group)
        if frames >= best_frames:
            best_frames = frames
            you = index
    return you


def _group_start(group: list[int]) -> float | int:
    return min(group) if group else float("inf")


def _ordered_other_groups(
    in_room: list[list[int]], in_meeting: list[list[int]], you: int | None
) -> list[list[int]]:
    others = [group for index, group in enumerate(in_room) if index != you]
    others.extend(in_meeting)
    others.sort(key=_group_start)  # stable, matches Rust's sort_by_key
    return others


def _available_speaker_counts(
    segments: list[RecSegment], group: list[int], taken: list[str]
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for slot in group:
        label = segments[slot].speaker
        if label.startswith("Speaker ") and label not in taken:
            counts[label] = counts.get(label, 0) + 1
    return counts


def _next_speaker_name(taken: list[str]) -> str:
    number = 1
    while f"Speaker {number}" in taken:
        number += 1
    return f"Speaker {number}"


def _speaker_name(counts: dict[str, int], taken: list[str]) -> str:
    leader = _fold_leader(counts)
    if leader is not None and leader[1] >= 2:
        return leader[0]
    return _next_speaker_name(taken)


def _named_groups(
    segments: list[RecSegment],
    in_room: list[list[int]],
    in_meeting: list[list[int]],
) -> list[tuple[list[int], str]]:
    # Whoever does most of the talking into this Mac's microphone is its
    # owner. Rust's `max_by_key` returns the LAST maximum on a tie.
    you = _you_group_index(segments, in_room)
    # Everyone else is numbered, room and meeting alike -- the transcript
    # reads as one conversation, because it is one.
    others = _ordered_other_groups(in_room, in_meeting, you)
    taken: list[str] = []
    named: list[tuple[list[int], str]] = []
    for group in others:
        name = _speaker_name(_available_speaker_counts(segments, group, taken), taken)
        taken.append(name)
        named.append((group, name))
    if you is not None:
        named.append((in_room[you], "You"))
    return named


def _group_label_counts(segments: list[RecSegment], group: list[int]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for slot in group:
        label = segments[slot].speaker
        counts[label] = counts.get(label, 0) + 1
    return counts


def _name_move(segments: list[RecSegment], group: list[int], name: str) -> tuple[str, str] | None:
    leader = _fold_leader(_group_label_counts(segments, group))
    if leader is None or leader[0] == name:
        return None
    return leader[0], name


def _append_new_move(moves: list[tuple[str, str]], move: tuple[str, str] | None) -> None:
    """Keep only the first destination when one voice splits into groups."""
    if move is not None and not any(previous == move[0] for previous, _name in moves):
        moves.append(move)


def _name_moves(
    segments: list[RecSegment], named: list[tuple[list[int], str]]
) -> list[tuple[str, str]]:
    moves: list[tuple[str, str]] = []
    for group, name in named:
        _append_new_move(moves, _name_move(segments, group, name))
    return moves


def _write_group_names(segments: list[RecSegment], named: list[tuple[list[int], str]]) -> bool:
    changed = False
    for group, name in named:
        for slot in group:
            if segments[slot].speaker != name:
                segments[slot].speaker = name
                changed = True
    return changed


def _apply_names(
    segments: list[RecSegment],
    in_room: list[list[int]],
    in_meeting: list[list[int]],
    naming: Naming,
) -> bool:
    """Turn per-lane voice GROUPS (segment indices per voice) into on-screen
    names -- "You" for the mic's main talker, sticky "Speaker N" for
    everyone else -- and write them. Shared by `relabel` (phrase groups) and
    `split_by_voice` (sub-window groups): one naming brain, two clusterings.
    """

    # Names are STICKY: each group keeps the number most of its phrases
    # already show on screen whenever it can. Renumbering everyone by first
    # appearance after every re-cluster made a mid-meeting merge shuffle the
    # labels of people who never changed -- which reads as misrecognition.
    named = _named_groups(segments, in_room, in_meeting)

    # What each group was CALLED before this pass -- the label most of its
    # phrases show on screen -- so the user's name for that voice can follow
    # it to whatever label it is about to get.
    moves = _name_moves(segments, named)
    _move_names(naming.names, moves)
    # A name whose voice left the transcript entirely was just dropped by
    # `_move_names`; a GUESS about it has to go with it, or a stale guess
    # sits in the way of the real one the next pass would make.
    naming.recognized.intersection_update(naming.names.values())

    changed = _recognize(segments, named, naming)
    return _write_group_names(segments, named) or changed


def _recognize(
    segments: list[RecSegment],
    named: list[tuple[list[int], str]],
    naming: Naming,
) -> bool:
    """Put the room's saved voices onto this recording's groups, as names in
    the overlay. Returns True when the overlay changed.

    This is the LOCAL orchestrator (Rust's private `recognize`, lines
    1579-1625) -- distinct from the already-ported `recognize_groups`
    (`arcelle_sidecar.diar.recognize`), which it calls.

    * **"You"** -- the microphone's main talker is a POSITION, not an
      identity, and a saved voice does not get to overwrite it.
    * **A label the user named by hand** -- their word is the answer for
      that voice, and it is not up for re-guessing; its name is also
      withheld from every other group.
    """
    if not naming.known:
        return False
    typed = _typed_names(naming)
    open_indexes = _open_recognition_indexes(named, naming)
    centroids = _recognition_centroids(segments, named, open_indexes)
    changed = False
    picks = recognize_groups(centroids, naming.known, typed)
    for index, picked in zip(open_indexes, picks):
        if _apply_recognition_pick(named[index][1], picked, naming):
            changed = True
    return changed


def _typed_names(naming: Naming) -> list[str]:
    return [name for name in naming.names.values() if name not in naming.recognized]


def _recognition_is_open(label: str, naming: Naming) -> bool:
    known_name = naming.names.get(label)
    return label != "You" and (known_name is None or known_name in naming.recognized)


def _open_recognition_indexes(named: list[tuple[list[int], str]], naming: Naming) -> list[int]:
    return [
        index for index, (_group, label) in enumerate(named) if _recognition_is_open(label, naming)
    ]


def _group_centroid(segments: list[RecSegment], group: list[int]) -> VoicePrint | None:
    prints = [segments[slot].voice for slot in group if segments[slot].voice is not None]
    return identity_print(prints)


def _recognition_centroids(
    segments: list[RecSegment],
    named: list[tuple[list[int], str]],
    open_indexes: list[int],
) -> list[VoicePrint | None]:
    return [_group_centroid(segments, named[index][0]) for index in open_indexes]


def _remember_recognized_name(label: str, picked: str, naming: Naming) -> bool:
    changed = naming.names.get(label) != picked
    if changed:
        naming.names[label] = picked
    naming.recognized.add(picked)
    return changed


def _withdraw_recognized_name(label: str, naming: Naming) -> bool:
    if label not in naming.names:
        return False
    gone = naming.names.pop(label)
    naming.recognized.discard(gone)
    return True


def _apply_recognition_pick(label: str, picked: str | None, naming: Naming) -> bool:
    if picked is not None:
        return _remember_recognized_name(label, picked, naming)
    # Nothing saved matches this voice any more -- a guess the meeting has
    # since talked out of. Withdraw it; "Speaker 3" is true and a stale name
    # is not.
    return _withdraw_recognized_name(label, naming)


def _lane_voice_indexes(segments: list[RecSegment], lane: str) -> list[int]:
    return [
        index
        for index, segment in enumerate(segments)
        if segment.source == lane and segment.voice is not None
    ]


def _newest_generation_indexes(segments: list[RecSegment], indexes: list[int]) -> list[int]:
    if not any(is_neural(segments[index].voice.vec) for index in indexes):  # type: ignore[union-attr]
        return indexes
    return [
        index
        for index in indexes
        if is_neural(segments[index].voice.vec)  # type: ignore[union-attr]
    ]


def _max_cluster_id(ids: list[int | None]) -> int:
    max_id = -1
    for cluster_id in ids:
        if cluster_id is not None and cluster_id > max_id:
            max_id = cluster_id
    return max_id


def _cluster_groups(indexes: list[int], ids: list[int | None]) -> list[list[int]]:
    max_id = _max_cluster_id(ids)
    groups: list[list[int]] = [[] for _ in range(max_id + 1)]
    for slot, cluster_id in zip(indexes, ids):
        if cluster_id is not None:
            groups[cluster_id].append(slot)
    return groups


def _cluster_lane_voices(
    segments: list[RecSegment], indexes: list[int], cap: int
) -> list[list[int]]:
    prints = [segments[index].voice for index in indexes]
    spans = [(segments[index].t0, segments[index].t1) for index in indexes]
    ids = cluster(prints, spans, cap)  # type: ignore[arg-type]
    return _cluster_groups(indexes, ids)


def _lane_voices(segments: list[RecSegment], lane: str, cap: int) -> list[list[int]]:
    """One lane's phrases grouped into voices: a list of segment indices per
    voice, numbered by first appearance. Phrases carrying no voice at all
    are dropped.

    A resumed old file mixes print generations, which can't be compared.
    Only the newest generation present in the lane is clustered;
    older-generation phrases keep whatever label they already have, exactly
    like legacy rows with no print. (A silent print is generation-less -- it
    clusters to nothing either way.)
    """
    indexes = _newest_generation_indexes(segments, _lane_voice_indexes(segments, lane))
    if not indexes:
        return []
    return _cluster_lane_voices(segments, indexes, cap)


def split_by_voice(
    segments: list[RecSegment],
    max_speakers: int,
    naming: Naming,
    wins_for: Callable[[RecSegment], list[tuple[int, int, VoicePrint]]],
) -> bool:
    """The offline voice pass (ADD-28), run wherever the full audio is at
    hand (stop, pause, re-transcribe): cluster every phrase's sub-windows,
    give each WORD the voice of its nearest window, and cut phrases wherever
    consecutive words disagree -- so two people answering each other without
    a pause stop sharing one label. The pieces then get their names through
    the same `_apply_names` the phrase path uses.

    `wins_for` supplies a segment's sub-window prints (from the decode-time
    cache, or embedded on the spot from the recording), called once per
    segment and cached. `segments` is REBUILT and its contents replaced in
    place when this returns True (matching Rust's `*segments = rebuilt;`),
    left completely untouched when it returns False.
    """
    return _split_by_voice(
        segments,
        max_speakers,
        naming,
        wins_for,
        _apply_names,
        cluster_gated,
    )
