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

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from arcelle_sidecar.diar.cluster import (
    AUTO_MAX_SPEAKERS,
    SPLIT_MIN_VOICE_FRAMES,
    cluster,
    cluster_gated,
)
from arcelle_sidecar.diar.embed import VoicePrint, is_neural
from arcelle_sidecar.diar.recognize import KnownVoice, identity_print, recognize_groups
from arcelle_sidecar.diar.windows import span_print
from arcelle_sidecar.rec.meta import RecSegment, RecWord

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
    next_names: dict[str, str] = {}
    for frm, to in moves:
        if frm in names:
            # A later mover in `moves` overwrites an earlier one's target.
            next_names[to] = names[frm]
    moved_from = {frm for frm, _to in moves}
    # Labels no group moved away from keep their name -- unless a mover has
    # already claimed that label, whose name wins (`setdefault` only fills a
    # gap, exactly like Rust's `or_insert_with`).
    for label, name in names.items():
        if label in moved_from:
            continue
        next_names.setdefault(label, name)
    names.clear()
    names.update(next_names)


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

    def group_frames(g: list[int]) -> int:
        total = 0
        for s in g:
            v = segments[s].voice
            total += v.voiced_frames if v is not None else 0
        return total

    # Whoever does most of the talking into this Mac's microphone is its
    # owner. Rust's `max_by_key` returns the LAST maximum on a tie -- `>=`
    # below re-takes the lead on every tie, landing on the last index too.
    you: int | None = None
    best_frames = -1
    for i, g in enumerate(in_room):
        f = group_frames(g)
        if f >= best_frames:
            best_frames = f
            you = i

    # Everyone else is numbered, room and meeting alike -- the transcript
    # reads as one conversation, because it is one.
    others: list[list[int]] = [g for i, g in enumerate(in_room) if i != you]
    others.extend(in_meeting)
    others.sort(key=lambda g: min(g) if g else float("inf"))  # stable, matches Rust's sort_by_key

    # Names are STICKY: each group keeps the number most of its phrases
    # already show on screen whenever it can. Renumbering everyone by first
    # appearance after every re-cluster made a mid-meeting merge shuffle the
    # labels of people who never changed -- which reads as misrecognition.
    taken: list[str] = []
    named: list[tuple[list[int], str]] = []
    for g in others:
        counts: dict[str, int] = {}
        for slot in g:
            label = segments[slot].speaker
            if label.startswith("Speaker ") and label not in taken:
                counts[label] = counts.get(label, 0) + 1
        # Strictly-greater scan: a tie keeps the label heard EARLIEST (counts
        # are in phrase order) -- the one that's been on screen longest. A
        # label backed by a single phrase isn't established, though: keeping
        # it preserves whatever number the live pass happened to mint, so it
        # takes the lowest free number instead.
        leader = _fold_leader(counts)
        if leader is not None and leader[1] >= 2:
            name = leader[0]
        else:
            n = 1
            while True:
                candidate = f"Speaker {n}"
                if candidate not in taken:
                    name = candidate
                    break
                n += 1
        taken.append(name)
        named.append((g, name))
    if you is not None:
        named.append((in_room[you], "You"))

    # What each group was CALLED before this pass -- the label most of its
    # phrases show on screen -- so the user's name for that voice can follow
    # it to whatever label it is about to get.
    moves: list[tuple[str, str]] = []
    for group, name in named:
        counts = {}
        for slot in group:
            label = segments[slot].speaker
            counts[label] = counts.get(label, 0) + 1
        leader = _fold_leader(counts)
        was = leader[0] if leader is not None else None
        # A voice that split in two: only the first piece inherits the name,
        # rather than the same person appearing twice under it.
        if was is not None and was != name and not any(f == was for f, _to in moves):
            moves.append((was, name))
    _move_names(naming.names, moves)
    # A name whose voice left the transcript entirely was just dropped by
    # `_move_names`; a GUESS about it has to go with it, or a stale guess
    # sits in the way of the real one the next pass would make.
    naming.recognized.intersection_update(naming.names.values())

    changed = _recognize(segments, named, naming)
    for group, name in named:
        for slot in group:
            if segments[slot].speaker != name:
                segments[slot].speaker = name
                changed = True
    return changed


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
    typed = [n for n in naming.names.values() if n not in naming.recognized]
    open_idx = [
        i
        for i in range(len(named))
        if named[i][1] != "You"
        and (named[i][1] not in naming.names or naming.names[named[i][1]] in naming.recognized)
    ]
    centroids: list[VoicePrint | None] = []
    for i in open_idx:
        group = named[i][0]
        prints = [segments[s].voice for s in group if segments[s].voice is not None]
        centroids.append(identity_print(prints))

    changed = False
    picks = recognize_groups(centroids, naming.known, typed)
    for i, picked in zip(open_idx, picks):
        label = named[i][1]
        if picked is not None:
            if naming.names.get(label) != picked:
                naming.names[label] = picked
                changed = True
            naming.recognized.add(picked)
        else:
            # Nothing saved matches this voice any more -- a guess the
            # meeting has since talked out of. Withdraw it; "Speaker 3" is
            # true and a stale name is not.
            if label in naming.names:
                gone = naming.names.pop(label)
                naming.recognized.discard(gone)
                changed = True
    return changed


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
    idx = [i for i in range(len(segments)) if segments[i].source == lane and segments[i].voice is not None]
    if any(is_neural(segments[i].voice.vec) for i in idx):  # type: ignore[union-attr]
        idx = [i for i in idx if is_neural(segments[i].voice.vec)]  # type: ignore[union-attr]
    if not idx:
        return []
    prints = [segments[i].voice for i in idx]
    spans = [(segments[i].t0, segments[i].t1) for i in idx]
    ids = cluster(prints, spans, cap)  # type: ignore[arg-type]
    max_id = -1
    for cid in ids:
        if cid is not None and cid > max_id:
            max_id = cid
    groups: list[list[int]] = [[] for _ in range(max_id + 1)]
    for slot, cid in zip(idx, ids):
        if cid is not None:
            groups[cid].append(slot)
    return groups


# ------------------------------------------------------------ the split pass


def _nearest_window_id(
    wins: list[tuple[int, tuple[int, int]]], ids: list[int | None], mid: int
) -> int | None:
    """The cluster id of whichever window's center sits nearest `mid` (ties
    keep the FIRST window in `wins`'s order, matching Rust's
    `Iterator::min_by_key`, which returns the first minimum); `None` when
    `wins` is empty."""
    best_k: int | None = None
    best_dist: int | None = None
    for k, (b, e) in wins:
        dist = abs((b + e) // 2 - mid)
        if best_dist is None or dist < best_dist:
            best_dist = dist
            best_k = k
    if best_k is None:
        return None
    return ids[best_k]


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
    cap = max_speakers if max_speakers != 0 else AUTO_MAX_SPEAKERS
    seg_wins: list[list[tuple[int, int, VoicePrint]]] = [wins_for(s) for s in segments]

    # plan[i]: the pieces segment i becomes -- (lane voice, (start, end)
    # word range) -- or None/[] to keep it untouched (legacy rows,
    # window-less phrases).
    plan: list[list[tuple[int | None, tuple[int, int]]] | None] = [None] * len(segments)
    lane_voice_count = [0, 0]
    for lane_no, lane in enumerate(("mic", "sys")):
        idx = [i for i in range(len(segments)) if segments[i].source == lane and seg_wins[i]]
        prints: list[VoicePrint] = []
        spans: list[tuple[int, int]] = []
        owner: list[int] = []
        for i in idx:
            for b, e, p in seg_wins[i]:
                prints.append(p)
                spans.append((b, e))
                owner.append(i)
        if len(prints) < 2:
            continue
        ids = cluster_gated(prints, spans, cap, SPLIT_MIN_VOICE_FRAMES)
        max_id = -1
        for cid in ids:
            if cid is not None and cid > max_id:
                max_id = cid
        lane_voice_count[lane_no] = max_id + 1

        for i in idx:
            wins = [(k, spans[k]) for k in range(len(prints)) if owner[k] == i]
            seg = segments[i]
            # Each word takes the voice of the window whose center is
            # nearest; unknowns (silence, weak windows) never cut a turn --
            # they ride with the voice already speaking.
            labels: list[int | None] = []
            last: int | None = None
            for w in seg.words:
                mid = (w.t0 + w.t1) // 2
                best = _nearest_window_id(wins, ids, mid)
                if best is None:
                    best = last
                last = best
                labels.append(best)
            first_known = next((label for label in labels if label is not None), None)
            if first_known is not None:
                labels = [label if label is not None else first_known for label in labels]

            cuts: list[tuple[int | None, tuple[int, int]]] = []
            start = 0
            for w in range(1, len(labels)):
                if labels[w] != labels[start]:
                    cuts.append((labels[start], (start, w)))
                    start = w
            if labels:
                cuts.append((labels[start], (start, len(labels))))
            plan[i] = cuts

    # Rebuild the transcript: a multi-voice phrase becomes its pieces --
    # words, timings, text and prints all follow the cut.
    rebuilt: list[RecSegment] = []
    groups: list[list[list[int]]] = [
        [[] for _ in range(lane_voice_count[0])],
        [[] for _ in range(lane_voice_count[1])],
    ]
    split_any = False
    for i, seg in enumerate(segments):
        lane_no = 0 if seg.source == "mic" else 1
        cuts = plan[i]
        if cuts:  # non-empty -- Rust's `Some(cuts) if !cuts.is_empty()`
            many = len(cuts) > 1
            split_any = split_any or many
            for voice, (start, end) in cuts:
                words: list[RecWord] = list(seg.words[start:end])
                t0 = seg.t0 if start == 0 else (words[0].t0 if words else seg.t0)
                t1 = seg.t1 if end == len(seg.words) else (words[-1].t1 if words else seg.t1)
                if many:
                    parts = [w.w.strip() for w in words]
                    text = " ".join(p for p in parts if p)
                else:
                    text = seg.text
                piece_print = span_print(seg_wins[i], t0, t1)
                if piece_print is None:
                    piece_print = seg.voice
                if voice is not None:
                    groups[lane_no][voice].append(len(rebuilt))
                rebuilt.append(
                    RecSegment(
                        id=str(uuid.uuid4()) if many else seg.id,
                        source=seg.source,
                        speaker=seg.speaker,
                        t0=t0,
                        t1=t1,
                        text=text,
                        words=words,
                        lang=seg.lang,
                        voice=piece_print,
                    )
                )
        else:
            # See module docstring's "untouched-segment clone" deviation.
            rebuilt.append(seg)

    mic_groups, sys_groups = groups
    renamed = _apply_names(rebuilt, mic_groups, sys_groups, naming)
    if split_any or renamed:
        segments[:] = rebuilt
        return True
    return False
