"""Cross-module smoke test: `arcelle_sidecar.rec.meta` + `arcelle_sidecar.diar.label`
working together on one realistic recording.

Neither module's own unit tests (`tests/test_rec_meta.py`, `tests/test_diar_label.py`)
exercise them TOGETHER on a full, plausible `RecMeta` -- this file builds a
multi-speaker `RecSegment` list by hand (two people sharing a laptop
microphone, two meeting participants heard over the system/meeting lane, each
carrying a real `arcelle_sidecar.diar.embed.VoicePrint`), runs the actual
public entry points a recording session calls (`label.relabel`, then
`label.split_by_voice`), and checks the result renders through
`arcelle_sidecar.rec.meta.transcript_text` into one coherent, correctly
speaker-attributed transcript.

All voiceprints are directly-constructed 192-dim (neural-generation-shaped,
see `embed.is_neural`) unit vectors, one axis per real voice, with small
Gaussian jitter (fixed seed, so the test is fully deterministic) so that
same-speaker phrases are alike but not bit-identical -- no `say(1)`, no ONNX
model, no skip conditions.
"""

from __future__ import annotations

import numpy as np

from arcelle_sidecar.diar import label
from arcelle_sidecar.diar.embed import EMB_DIM, VoicePrint
from arcelle_sidecar.rec.meta import RecMeta, RecSegment, RecWord, transcript_text

# -----------------------------------------------------------------------------
# ---- fixture construction ---------------------------------------------------
# -----------------------------------------------------------------------------


def _voice(axis: int, frames: int, seed: int) -> VoicePrint:
    """A real `VoicePrint`: a 192-dim (neural-shaped) unit vector on `axis`
    plus small fixed-seed jitter off-axis, L2-renormalized -- distinct real
    voices are near-orthogonal, repeated phrases from the same voice are
    alike but not identical, exactly the shape `is_neural`/`cluster` expect.
    """
    rng = np.random.default_rng(seed)
    v = np.zeros(EMB_DIM, dtype=np.float64)
    v[axis] = 1.0
    noise = rng.normal(scale=0.05, size=EMB_DIM)
    noise[axis] = 0.0
    v = v + noise
    v = v / np.sqrt(np.sum(v * v))
    return VoicePrint(vec=v.astype(np.float32), voiced_frames=frames)


def _words(text: str, t0: int, t1: int) -> list[RecWord]:
    """Evenly spaced synthetic word timings across [t0, t1) -- real word
    boundaries don't matter here, only that `segment_visible_text`/
    `transcript_text` have something real to walk."""
    parts = text.split()
    step = max((t1 - t0) // len(parts), 1)
    out: list[RecWord] = []
    for k, w in enumerate(parts):
        wt0 = t0 + k * step
        wt1 = min(wt0 + max(step - 2, 1), t1)
        out.append(RecWord(w=w, t0=wt0, t1=wt1))
    return out


# A plausible meeting: two people sharing one microphone ("You", the Mac's
# owner, and an officemate who occasionally chimes in on the same mic), two
# remote participants heard over the system/meeting lane. Interleaved in
# real conversational order, timestamps 10 s apart so the turn-continuity
# prior inside `cluster` stays neutral (matches the spacing
# `tests/test_diar_label.py` itself uses for the same reason).
_CONVO: list[tuple[str, str, int, int]] = [
    # (source, text, voice axis, voiced frames)
    ("sys", "Let's start the meeting now", 2, 220),  # 0  Participant A
    ("mic", "Thanks everyone for joining today", 0, 300),  # 1  You
    ("sys", "I have prepared the budget report", 3, 200),  # 2  Participant B
    ("mic", "Can you also cover the timeline", 1, 150),  # 3  Officemate
    ("sys", "Sure the budget looks solid this quarter", 2, 220),  # 4  A
    ("mic", "Great let's move to the next topic", 0, 300),  # 5  You
    ("sys", "I will share the slides after this", 3, 200),  # 6  B
    ("mic", "Perfect thanks for that", 0, 300),  # 7  You
    ("sys", "One more thing about vendor contracts", 2, 220),  # 8  A
    ("mic", "I have a question about that", 1, 150),  # 9  Officemate
    ("sys", "Let me pull up the details", 3, 200),  # 10 B
    ("mic", "Take your time no rush", 0, 300),  # 11 You
    ("sys", "Here is the updated contract terms", 2, 220),  # 12 A
    ("mic", "That clarifies it thanks", 1, 150),  # 13 Officemate
    ("sys", "Glad that helped", 3, 200),  # 14 B
    ("mic", "Let's wrap up for today", 0, 300),  # 15 You
]


def _build_segments() -> list[RecSegment]:
    segments: list[RecSegment] = []
    for k, (source, text, axis, frames) in enumerate(_CONVO):
        t0, t1 = k * 1000, k * 1000 + 500
        segments.append(
            RecSegment(
                id=f"seg-{k}",
                source=source,
                # A placeholder provisional label from the (unmodeled) live
                # pass -- deliberately NOT "Speaker N"-shaped, so the first
                # `relabel()` call below is a clean first pass rather than
                # exercising the sticky-numbering machinery those modules'
                # own unit tests already cover.
                speaker="pending",
                t0=t0,
                t1=t1,
                text=text,
                words=_words(text, t0, t1),
                lang="en",
                voice=_voice(axis, frames, seed=k),
            )
        )
    return segments


_YOU_IDX = [i for i, (src, _, ax, _) in enumerate(_CONVO) if src == "mic" and ax == 0]
_OFFICEMATE_IDX = [i for i, (src, _, ax, _) in enumerate(_CONVO) if src == "mic" and ax == 1]
_A_IDX = [i for i, (src, _, ax, _) in enumerate(_CONVO) if src == "sys" and ax == 2]
_B_IDX = [i for i, (src, _, ax, _) in enumerate(_CONVO) if src == "sys" and ax == 3]


def test_relabel_then_split_by_voice_produce_a_coherent_transcript() -> None:
    segments = _build_segments()
    naming = label.Naming.plain({}, set())

    # ---- relabel(): the whole-recording re-cluster ------------------------
    changed = label.relabel(segments, 0, naming)
    assert changed, "the first pass over real provisional labels found nothing to fix"

    you_labels = {segments[i].speaker for i in _YOU_IDX}
    assert you_labels == {"You"}, f"the mic's dominant voice must be called You: {you_labels}"

    officemate_labels = {segments[i].speaker for i in _OFFICEMATE_IDX}
    assert len(officemate_labels) == 1, f"one voice must get one label: {officemate_labels}"
    officemate_label = next(iter(officemate_labels))
    assert officemate_label != "You" and officemate_label.startswith("Speaker "), (
        f"the officemate is not the mic's owner: {officemate_label}"
    )

    a_labels = {segments[i].speaker for i in _A_IDX}
    assert len(a_labels) == 1, f"one voice must get one label: {a_labels}"
    a_label = next(iter(a_labels))
    assert a_label != "You" and a_label.startswith("Speaker "), a_label

    b_labels = {segments[i].speaker for i in _B_IDX}
    assert len(b_labels) == 1, f"one voice must get one label: {b_labels}"
    b_label = next(iter(b_labels))
    assert b_label != "You" and b_label.startswith("Speaker "), b_label

    # Four real, distinct voices must land on four distinct labels -- no two
    # different people sharing one name, and "You" reserved for the mic's
    # owner alone.
    assert len({"You", officemate_label, a_label, b_label}) == 4, (
        f"two different voices collapsed onto one label: You={you_labels}, "
        f"officemate={officemate_label}, A={a_label}, B={b_label}"
    )

    # ---- stable across a second relabel() with no new data ---------------
    speakers_before = [s.speaker for s in segments]
    names_before = dict(naming.names)
    recognized_before = set(naming.recognized)
    changed_again = label.relabel(segments, 0, naming)
    assert not changed_again, "a second pass over unchanged data still moved something"
    assert [s.speaker for s in segments] == speakers_before, "labels drifted on a stable pass"
    assert dict(naming.names) == names_before
    assert set(naming.recognized) == recognized_before

    # ---- split_by_voice(): the offline sub-window pass --------------------
    # One whole-segment window per phrase (the simplest legal `wins_for`,
    # per the module's own docstring on `split_by_voice`'s callback contract)
    # -- enough to drive the pass end to end without needing real sub-window
    # audio.
    def wins_for(seg: RecSegment) -> list[tuple[int, int, VoicePrint]]:
        if seg.voice is None:
            return []
        return [(seg.t0, seg.t1, seg.voice)]

    total_words_before = sum(len(s.words) for s in segments)
    n_segments_before = len(segments)
    result = label.split_by_voice(segments, 0, naming, wins_for)
    assert isinstance(result, bool)
    # A single window per phrase can never disagree with itself, so no
    # phrase is actually cut in two -- the pass still has to run cleanly
    # end-to-end and must not lose or duplicate anything.
    assert len(segments) == n_segments_before
    assert sum(len(s.words) for s in segments) == total_words_before

    # ---- the resulting RecMeta reads as one coherent transcript -----------
    meta = RecMeta(duration_cs=16_000, segments=segments, cuts=[])
    text = transcript_text(meta)
    assert text.startswith("(live recording)\n")

    # Every phrase's own words appear, attributed to the label that phrase
    # ended up with (re-read from `segments`, in case split_by_voice's
    # `_apply_names` pass renamed anyone the second time around).
    for seg in segments:
        who = meta.display_speaker(seg.speaker)
        assert f"{who}: {seg.text}" in text, (
            f"segment {seg.id!r} ({seg.text!r} by {who!r}) is missing from the transcript:\n{text}"
        )

    # Each real voice's phrases are all attributed to ONE label in the final
    # transcript too (the split pass must not have fragmented a voice across
    # multiple names).
    for idx_group, label_desc in (
        (_YOU_IDX, "You"),
        (_OFFICEMATE_IDX, "officemate"),
        (_A_IDX, "participant A"),
        (_B_IDX, "participant B"),
    ):
        labels_now = {segments[i].speaker for i in idx_group}
        assert len(labels_now) == 1, f"{label_desc}'s phrases split across labels: {labels_now}"

    assert transcript_text(meta) == text, "transcript_text must be a pure read of RecMeta"
