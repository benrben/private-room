"""Tests for `arcelle_sidecar.diar.label` -- the Python port of the "naming
brain" section of `src-tauri/src/recording/diarize.rs` (lines 1349-1873):
`Naming`, `relabel`, `_move_names`, `_apply_names`, `_recognize`,
`_lane_voices`, `split_by_voice`.

One test per Rust `#[test]` function that names `relabel`/`apply_names`/
`move_names`/`split_by_voice`/`Naming`/`lane_voices` (grepped exhaustively
across the whole `#[cfg(test)] mod tests` block, diarize.rs lines
1876-3050) -- 13 in total:

- `swapped_labels_swap_their_names`, `a_typed_name_follows_its_voice_when_
  the_label_moves` -- pure logic, no audio, always run.
- `relabel_fixes_meeting_labels_and_finds_you`, `relabel_keeps_established_
  numbers`, `a_barely_seen_label_is_renumbered_compactly`, `a_lone_drifted_
  voice_is_merged_back`, `a_second_person_on_the_mic_is_not_you`, `nobody_
  is_you_when_the_mic_never_spoke` -- real `say(1)` audio through the DSP
  fallback print (`dsp_embed`), no ONNX model needed.
- `mixed_generation_file_relabels_new_prints_and_leaves_old_labels_alone`,
  `relabel_puts_a_saved_name_on_a_returning_voice`, `a_typed_name_outranks_
  every_saved_voice`, `a_guess_the_evidence_no_longer_supports_is_
  withdrawn`, `split_pass_cuts_a_two_voice_phrase` -- real `say(1)` audio
  through the neural (TitaNet) print, gated on the real bundled ONNX model.

## A deliberate, disclosed deviation: `say(1)` clip caching

The Rust source's own `say()` test helper re-synthesizes its fixture line
from scratch on every call (documented, independently, in this project's own
memory as the dominant cost of the Rust diarize test suite: "34 diarize
tests, macOS `say` re-synthesized per call"). This port instead memoizes
`_say(voice, text)` at module scope (`functools.lru_cache`) -- the exact
audio bytes `say -v <voice> -o <path> <text>` produces are a pure function of
its arguments, so caching changes nothing about what is exercised, only how
many times a slow, purely-mechanical subprocess call is repeated across
tests that happen to want the same clip.
"""

from __future__ import annotations

import itertools
import subprocess
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest

from arcelle_sidecar.diar import label
from arcelle_sidecar.diar.embed import (
    BANDS,
    EMB_DIM,
    MIN_NEW_VOICE_FRAMES,
    SAMPLE_RATE,
    VoicePrint,
    dsp_embed,
)
from arcelle_sidecar.diar.embed import embed as embed_fn
from arcelle_sidecar.diar.recognize import KnownVoice, identity_print
from arcelle_sidecar.diar.windows import window_prints
from arcelle_sidecar.media import decode as media_decode
from arcelle_sidecar.rec.meta import RecSegment, RecWord

MODEL_PATH = "/Users/benreich/private-room/apps/desktop/assets/models/nemo_en_titanet_small.onnx"
requires_model = pytest.mark.skipif(
    not Path(MODEL_PATH).exists(),
    reason="real TitaNet ONNX model not present on this machine",
)

_HAS_SAY = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()
requires_say = pytest.mark.skipif(
    not _HAS_SAY, reason="requires macOS say(1)/afconvert(1), not present here"
)

# A conversation: every turn says something different, the way meetings
# actually go -- matches the Rust fixtures verbatim.
LINE_A = "The quarterly launch plan needs review before Friday afternoon."
LINE_B = "I will prepare the release notes and update the website today."
LINE_C = "Let us meet again tomorrow at ten to finalize everything."
LINE_D = "Sounds good, I will send the agenda and the notes tonight."


@lru_cache(maxsize=None)
def _say(voice: str, line: str) -> np.ndarray | None:
    """Decode a macOS `say` voice saying `line` to mono 16 kHz PCM, via the
    sidecar's own decoder. `None` when `say`/the voice is unavailable (the
    caller then skips). See the module docstring for why this is cached."""
    path = Path(tempfile.gettempdir()) / f"diar-label-{voice}-{uuid.uuid4()}.aiff"
    try:
        proc = subprocess.run(
            ["/usr/bin/say", "-v", voice, "-o", str(path), line],
            capture_output=True,
        )
        if proc.returncode != 0 or not path.exists():
            return None
        return media_decode.decode_to_pcm(path, media_decode.MediaKind.AUDIO)
    finally:
        path.unlink(missing_ok=True)


def _any_missing(*clips: np.ndarray | None) -> bool:
    """`any(c is None for c in clips)`, spelled out because `None in
    (arr1, arr2, ...)` raises on numpy arrays (`__eq__` returns an
    elementwise array, which has no unambiguous truth value)."""
    return any(c is None for c in clips)


def nembed(samples: np.ndarray) -> VoicePrint:
    """A neural print for a `say` phrase, failing LOUDLY if the bundled
    model went missing -- otherwise every neural test would silently
    exercise the DSP fallback and prove nothing."""
    p = embed_fn(MODEL_PATH, samples)
    assert len(p.vec) == EMB_DIM, f"TitaNet model missing/broken at {MODEL_PATH}"
    return p


# Distant, monotonically increasing timestamps (10 s apart, across the whole
# test module) -- the turn-continuity prior inside `cluster` stays neutral,
# so these tests measure the naming logic alone, matching the Rust source's
# own `seg()` helper and its module-wide `AtomicI64` clock.
_CLOCK = itertools.count(0, 1000)


def seg(speaker: str, source: str, voice: VoicePrint | None) -> RecSegment:
    t0 = next(_CLOCK)
    return RecSegment(
        id=str(uuid.uuid4()),
        source=source,
        speaker=speaker,
        t0=t0,
        t1=t0 + 300,
        text="hi",
        words=[],
        lang=None,
        voice=voice,
    )


# =============================================================================
# ---- pure logic, no audio ----------------------------------------------------
# =============================================================================


def test_swapped_labels_swap_their_names() -> None:
    """The name map is rebuilt, not edited in place, so two voices trading
    numbers trade their names too instead of one overwriting the other."""
    names = {"Speaker 1": "Ana", "Speaker 2": "Ben", "Speaker 3": "Cy"}
    label._move_names(
        names,
        [("Speaker 1", "Speaker 2"), ("Speaker 2", "Speaker 1")],
    )
    assert names.get("Speaker 1") == "Ben"
    assert names.get("Speaker 2") == "Ana"
    # A label nothing moved away from keeps its name.
    assert names.get("Speaker 3") == "Cy"

    # A voice that left the transcript takes its name with it rather than
    # leaving it for whoever inherits the number.
    gone = {"Speaker 2": "Dana"}
    label._move_names(gone, [("Speaker 2", "You")])
    assert gone == {"You": "Dana"}


def test_a_typed_name_follows_its_voice_when_the_label_moves() -> None:
    """GH #5: a name is attached to a VOICE, not to the label string. When a
    re-cluster moves a group's number, the name the user typed moves with
    it -- it used to stay on the number and land on somebody else's
    lines."""

    def unit(axis: int) -> VoicePrint:
        vec = np.zeros(BANDS - 1, dtype=np.float32)
        vec[axis] = 1.0
        return VoicePrint(vec=vec, voiced_frames=MIN_NEW_VOICE_FRAMES * 2)

    # One voice, mislabeled by the live pass as two: the second half went
    # out under "Speaker 2" and the user named THAT one "Dana".
    segments = [
        seg("Speaker 1", "sys", unit(0)),
        seg("Speaker 2", "sys", unit(0)),
        seg("Speaker 2", "sys", unit(0)),
    ]
    names = {"Speaker 2": "Dana"}
    naming = label.Naming.plain(names, set())
    assert label.relabel(segments, 0, naming), "the split labels were never merged"
    merged = segments[0].speaker
    assert all(s.speaker == merged for s in segments), segments
    assert names.get(merged) == "Dana", f"the name did not follow the voice: {names}"
    assert len(names) == 1, f"a stale entry was left behind: {names}"


# =============================================================================
# ---- adversarial: word-to-window assignment + cross-pass label reuse -------
# Neither needs `say`/the ONNX model: both drive the module's own logic
# (`split_by_voice`'s word-labeling loop; `_apply_names`/`_recognize`'s
# cross-pass bookkeeping) on fully synthetic, deterministic inputs.
# =============================================================================


def test_split_by_voice_backfills_leading_silence_to_the_first_known_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A phrase that opens with a silent stretch (nobody has started talking
    yet) has no window ID for its first few words at all -- `cluster_gated`
    never assigns silent sub-windows to any voice. Rust's own fallback chain
    is `.and_then(...).or(last)`, and for the very FIRST words `last` is
    still `None` too, so those words stay `None` through the per-word loop
    and only get resolved by the trailing `labels.iter().flatten().next()`
    backfill -- which must pick the voice of the first word that DID
    resolve, not a hardcoded id (0, or whichever id sorts lowest/highest).

    `cluster_gated` is stubbed so the window IDs are exact and adversarially
    chosen (5 then 7, neither 0 nor 1) -- if the backfill silently defaulted
    to a hardcoded id, or filled with the LAST-known voice instead of the
    first, the words would land in the wrong piece (or an extra, wrong cut
    would appear where none should)."""
    words = [RecWord(w=f"w{k}", t0=k * 20, t1=k * 20 + 15) for k in range(10)]
    segments = [
        RecSegment(
            id="lead-in",
            source="sys",
            speaker="Speaker 1",
            t0=0,
            t1=200,
            text="silence then two voices",
            words=words,
            lang=None,
            voice=VoicePrint(vec=np.zeros(2, dtype=np.float32), voiced_frames=0),
        )
    ]

    # Window 0 (0-50cs, center 25) is silence: no one has started talking.
    # Window 1 (50-125cs, center 87) is the first REAL voice heard, id 5.
    # Window 2 (125-200cs, center 162) is a second, later voice, id 7.
    silent = VoicePrint(vec=np.zeros(2, dtype=np.float32), voiced_frames=0)
    voice_a = VoicePrint(vec=np.array([1.0, 0.0], dtype=np.float32), voiced_frames=50)
    voice_b = VoicePrint(vec=np.array([0.0, 1.0], dtype=np.float32), voiced_frames=50)
    windows = [(0, 50, silent), (50, 125, voice_a), (125, 200, voice_b)]

    def wins_for(_seg: RecSegment) -> list[tuple[int, int, VoicePrint]]:
        return windows

    def fake_cluster_gated(
        prints: list[VoicePrint], spans: list[tuple[int, int]], cap: int, min_voice_frames: int
    ) -> list[int | None]:
        assert len(prints) == 3, "the stub must see exactly this phrase's 3 windows"
        return [None, 5, 7]  # the silent window never gets an id at all

    monkeypatch.setattr(label, "cluster_gated", fake_cluster_gated)

    naming = label.Naming.plain({}, set())
    changed = label.split_by_voice(segments, 0, naming, wins_for)

    assert changed, "the voice change went undetected"
    assert len(segments) == 2, f"expected exactly one cut, got {len(segments)} piece(s)"
    # Words 0-2 sit in the silent lead-in and must backfill to id 5 (the
    # FIRST voice actually heard), joining words 3-5 which land on window 1
    # (id 5) on their own merits -- NOT to id 7 (the later, second voice),
    # and NOT split off into their own third piece.
    assert [w.w for w in segments[0].words] == [f"w{k}" for k in range(6)], (
        f"the silent lead-in's words did not backfill to the first known voice: "
        f"{[w.w for w in segments[0].words]}"
    )
    assert [w.w for w in segments[1].words] == [f"w{k}" for k in range(6, 10)]
    assert segments[0].speaker != segments[1].speaker, "the pieces share one label"
    assert sum(len(s.words) for s in segments) == 10, "words lost or duplicated by the cut"


def test_a_freed_label_reused_by_a_different_voice_does_not_inherit_a_stale_guess() -> None:
    """Across two passes sharing one `Naming` -- exactly how a real session
    calls `relabel`/`split_by_voice` repeatedly as more of the meeting is
    heard: a label carrying a saved-voice GUESS gets freed (its voice's
    phrases are gone from what this pass sees) and a completely different,
    unrelated voice's phrases land on that same now-free label (plausible on
    a real session: the live SpeakerBook's own numbering has no memory of
    what a label used to mean, so a freshly-discovered voice can land on a
    just-vacated number by coincidence).

    The guess must not silently ride the LABEL onto its new occupant --
    `_recognize` re-decides every label from scratch every pass, INCLUDING
    ones that already show a name, which is exactly what has to fire here
    since `_move_names` alone does nothing when nobody's own current label
    actually changed (both groups keep the same label they already had)."""

    def axis_print(axis: int, frames: int = MIN_NEW_VOICE_FRAMES * 4) -> VoicePrint:
        vec = np.zeros(EMB_DIM, dtype=np.float32)
        vec[axis] = 1.0
        return VoicePrint(vec=vec, voiced_frames=frames)

    dana_known = KnownVoice(name="Dana", vec=axis_print(0).vec.copy(), rejects=[])
    naming = label.Naming(names={}, recognized=set(), known=[dana_known])

    # Pass 1, both lanes: "You" on the mic, voice A (== Dana's saved
    # centroid) and voice B (nobody known) in the meeting. Groups are
    # hand-built (segment-index lists) rather than routed through `cluster`,
    # so this test is only about the naming brain, not the clusterer's own
    # numerics (covered elsewhere).
    you1 = seg("You", "mic", None)
    a1 = seg("Speaker 1", "sys", axis_print(0))
    b1 = seg("Speaker 2", "sys", axis_print(1))
    pass1 = [you1, a1, b1]
    assert label._apply_names(pass1, [[0]], [[1], [2]], naming)
    a_label = a1.speaker
    assert naming.names.get(a_label) == "Dana", f"the room's own voice went unrecognized: {naming.names}"
    assert "Dana" in naming.recognized

    # Pass 2: A is gone from what this pass sees; B is still there, still
    # under the label this module gave it last pass; a brand-new, unrelated
    # voice C is freshly heard under A's now-free label.
    you2 = seg("You", "mic", None)
    c1 = seg(a_label, "sys", axis_print(2))
    pass2 = [you2, c1, b1]
    label._apply_names(pass2, [[0]], [[1], [2]], naming)

    assert naming.names.get(c1.speaker) != "Dana", (
        f"a stranger's phrase inherited Dana's stale guess via the recycled label: {naming.names}"
    )
    assert "Dana" not in naming.recognized, "the withdrawn guess was not cleared from `recognized`"


# =============================================================================
# ---- real audio, DSP fallback print (no ONNX model needed) -----------------
# =============================================================================


@requires_say
def test_relabel_fixes_meeting_labels_and_finds_you() -> None:
    """`relabel` rewrites provisional labels in place, names the
    mic-dominant voice "You", leaves pre-ADD-27 segments alone, and reports
    whether anything moved."""
    sam = _say("Samantha", LINE_A)
    dan = _say("Daniel", LINE_B)
    sam2 = _say("Samantha", LINE_C)
    dan2 = _say("Daniel", LINE_D)
    if _any_missing(sam, dan, sam2, dan2):
        pytest.skip("say synthesis failed")

    segments = [
        seg("Speaker 1", "sys", dsp_embed(sam)),
        # The person at the Mac, heard twice on the microphone.
        seg("You", "mic", dsp_embed(dan)),
        # What the live pass got wrong: a third voice that never existed.
        seg("Speaker 3", "sys", dsp_embed(sam2)),
        seg("You", "mic", dsp_embed(dan2)),
        seg("Speaker 9", "sys", None),  # legacy row, no voiceprint
    ]
    assert label.relabel(segments, 0, label.Naming.plain({}, set())), "expected a correction"
    assert segments[0].speaker == "Speaker 1"
    assert segments[1].speaker == "You", "the mic-dominant voice is you"
    assert segments[2].speaker == "Speaker 1", "phantom speaker survived"
    assert segments[3].speaker == "You"
    assert segments[4].speaker == "Speaker 9", "legacy segment must be left alone"
    # Idempotent: a second pass changes nothing.
    assert not label.relabel(segments, 0, label.Naming.plain({}, set()))


@requires_say
def test_relabel_keeps_established_numbers() -> None:
    """A re-cluster must not renumber people who never changed. First-
    appearance numbering used to shuffle every label whenever the
    clustering shifted mid-meeting -- which read as misrecognition."""
    sam = _say("Samantha", LINE_A)
    dan = _say("Daniel", LINE_B)
    sam2 = _say("Samantha", LINE_C)
    if _any_missing(sam, dan, sam2):
        pytest.skip("say synthesis failed")

    # On screen for minutes already, in the opposite of first-appearance
    # order (a live pass can produce this).
    segments = [
        seg("Speaker 2", "sys", dsp_embed(sam)),
        seg("Speaker 1", "sys", dsp_embed(dan)),
        seg("Speaker 2", "sys", dsp_embed(sam2)),
    ]
    assert not label.relabel(segments, 0, label.Naming.plain({}, set())), (
        "nothing moved, so nothing may change"
    )
    assert segments[0].speaker == "Speaker 2"
    assert segments[1].speaker == "Speaker 1"
    assert segments[2].speaker == "Speaker 2"


@requires_say
def test_a_barely_seen_label_is_renumbered_compactly() -> None:
    """A label backed by a single phrase keeps whatever number the live
    pass minted ("Speaker 6" in a two-person call, after phantom voices
    came and went). It isn't established -- it takes the lowest free
    number."""
    sam = _say("Samantha", LINE_A)
    sam2 = _say("Samantha", LINE_C)
    dan = _say("Daniel", LINE_B)
    if _any_missing(sam, sam2, dan):
        pytest.skip("say synthesis failed")

    segments = [
        seg("Speaker 1", "sys", dsp_embed(sam)),
        seg("Speaker 1", "sys", dsp_embed(sam2)),
        seg("Speaker 6", "sys", dsp_embed(dan)),
    ]
    label.relabel(segments, 0, label.Naming.plain({}, set()))
    assert segments[0].speaker == "Speaker 1"
    assert segments[1].speaker == "Speaker 1"
    assert segments[2].speaker == "Speaker 2", "the stray high number must compact"


@requires_say
def test_a_lone_drifted_voice_is_merged_back() -> None:
    """One remote speaker whose live labels drifted (a resumed file numbers
    a returning voice afresh) must be folded back into one -- a lone voice
    still needs relabeling."""
    sam = _say("Samantha", LINE_A)
    sam2 = _say("Samantha", LINE_C)
    sam3 = _say("Samantha", LINE_D)
    if _any_missing(sam, sam2, sam3):
        pytest.skip("say synthesis failed")

    segments = [
        seg("Speaker 1", "sys", dsp_embed(sam)),
        seg("Speaker 1", "sys", dsp_embed(sam2)),
        seg("Speaker 2", "sys", dsp_embed(sam3)),  # the resume's fresh number
    ]
    assert label.relabel(segments, 0, label.Naming.plain({}, set())), (
        "the drifted label was never corrected"
    )
    assert all(s.speaker == "Speaker 1" for s in segments), segments


@requires_say
def test_a_second_person_on_the_mic_is_not_you() -> None:
    """The bug this fixes: a colleague sitting next to you shares your
    microphone, and used to be labeled "You" for it."""
    dan = _say("Daniel", LINE_A)
    dan2 = _say("Daniel", LINE_C)
    sam = _say("Samantha", LINE_B)
    if _any_missing(dan, dan2, sam):
        pytest.skip("say synthesis failed")

    segments = [
        seg("You", "mic", dsp_embed(dan)),
        seg("You", "mic", dsp_embed(sam)),  # in the room, not at the Mac
        seg("You", "mic", dsp_embed(dan2)),
    ]
    assert label.relabel(segments, 0, label.Naming.plain({}, set())), (
        "the room's second voice went unnoticed"
    )
    assert segments[0].speaker == "You", "most of the mic's speech is yours"
    assert segments[1].speaker == "Speaker 1"
    assert segments[2].speaker == "You"


@requires_say
def test_nobody_is_you_when_the_mic_never_spoke() -> None:
    """Recording a meeting you never speak in: every voice arrives on the
    system lane, so none of them is "You"."""
    sam = _say("Samantha", LINE_A)
    dan = _say("Daniel", LINE_B)
    sam2 = _say("Samantha", LINE_C)
    if _any_missing(sam, dan, sam2):
        pytest.skip("say synthesis failed")

    segments = [
        seg("x", "sys", dsp_embed(sam)),
        seg("x", "sys", dsp_embed(dan)),
        seg("x", "sys", dsp_embed(sam2)),
    ]
    label.relabel(segments, 0, label.Naming.plain({}, set()))
    assert all(s.speaker != "You" for s in segments), (
        "a voice the microphone never heard was called 'You'"
    )
    assert segments[0].speaker == "Speaker 1"
    assert segments[1].speaker == "Speaker 2"
    assert segments[2].speaker == "Speaker 1"


# =============================================================================
# ---- real audio, neural (TitaNet) print -------------------------------------
# =============================================================================


@requires_say
@requires_model
def test_mixed_generation_file_relabels_new_prints_and_leaves_old_labels_alone() -> None:
    """A resumed pre-TitaNet file: DSP prints from the old session, neural
    prints from the new one. Only the new generation is re-clustered (the
    drifted new label folds back); the old rows' labels are untouched,
    exactly like rows with no print at all."""
    sam = _say("Samantha", LINE_A)
    dan = _say("Daniel", LINE_B)
    sam2 = _say("Samantha", LINE_C)
    if _any_missing(sam, dan, sam2):
        pytest.skip("say synthesis failed")

    segments = [
        seg("Speaker 4", "sys", dsp_embed(sam)),
        seg("Speaker 5", "sys", dsp_embed(dan)),
        seg("Speaker 1", "sys", nembed(sam)),
        seg("Speaker 2", "sys", nembed(dan)),
        # What the live pass got wrong after the resume: a third voice.
        seg("Speaker 3", "sys", nembed(sam2)),
    ]
    assert label.relabel(segments, 0, label.Naming.plain({}, set())), (
        "the drifted new label was never corrected"
    )
    assert segments[0].speaker == "Speaker 4", "old-generation label must not move"
    assert segments[1].speaker == "Speaker 5", "old-generation label must not move"
    assert segments[2].speaker == "Speaker 1"
    assert segments[3].speaker == "Speaker 2"
    assert segments[4].speaker == "Speaker 1", "same voice as segment 2"


@requires_say
@requires_model
def test_relabel_puts_a_saved_name_on_a_returning_voice() -> None:
    """End to end through the naming brain: a voice the room knows arrives
    in a new recording and gets her name, as a GUESS -- while the mic's
    owner stays "You", because that is a position and not an identity."""
    sam = _say("Samantha", LINE_A)
    sam2 = _say("Samantha", LINE_C)
    dan = _say("Daniel", LINE_B)
    dan2 = _say("Daniel", LINE_D)
    if _any_missing(sam, sam2, dan, dan2):
        pytest.skip("say synthesis failed")

    # What a previous recording would have saved for her.
    hers = identity_print([nembed(sam), nembed(sam2)])
    assert hers is not None, "enough speech"
    known = [KnownVoice(name="Dana", vec=hers.vec, rejects=[])]

    segments = [
        seg("Speaker 1", "sys", nembed(sam)),
        seg("Speaker 2", "sys", nembed(dan)),
        seg("Speaker 1", "sys", nembed(sam2)),
        seg("Speaker 2", "sys", nembed(dan2)),
        seg("You", "mic", nembed(sam)),
    ]
    names: dict[str, str] = {}
    recognized: set[str] = set()
    naming = label.Naming(names=names, recognized=recognized, known=known)
    label.relabel(segments, 0, naming)

    her_label = segments[0].speaker
    assert names.get(her_label) == "Dana", (
        f"the room had heard this voice before and did not say so: {names}"
    )
    assert "Dana" in recognized, "a guess must be marked as one"
    assert segments[4].speaker == "You", "the microphone's owner is a position, not a name"
    assert not (any(n == "Dana" for n in names.values()) and len(names) > 1), (
        f"Dana was put on two speakers: {names}"
    )


@requires_say
@requires_model
def test_a_typed_name_outranks_every_saved_voice() -> None:
    """The user's word is final. A name they typed is never re-guessed,
    never withdrawn, and never handed to anyone else."""
    sam = _say("Samantha", LINE_A)
    sam2 = _say("Samantha", LINE_C)
    dan = _say("Daniel", LINE_B)
    if _any_missing(sam, sam2, dan):
        pytest.skip("say synthesis failed")

    hers = identity_print([nembed(sam), nembed(sam2)])
    assert hers is not None, "enough speech"
    known = [KnownVoice(name="Dana", vec=hers.vec, rejects=[])]

    segments = [
        seg("Speaker 1", "sys", nembed(sam)),
        seg("Speaker 1", "sys", nembed(sam2)),
        seg("Speaker 2", "sys", nembed(dan)),
    ]
    # The user has already said who this is, and it is not Dana.
    names = {"Speaker 1": "Michal"}
    recognized: set[str] = set()
    naming = label.Naming(names=names, recognized=recognized, known=known)
    label.relabel(segments, 0, naming)
    assert names.get(segments[0].speaker) == "Michal"
    assert not recognized, "the user's own name was recorded as a guess"
    assert not any(n == "Dana" for n in names.values()), "a saved voice overrode a typed name"


@requires_say
@requires_model
def test_a_guess_the_evidence_no_longer_supports_is_withdrawn() -> None:
    """A guess is provisional by construction: when the evidence stops
    supporting it, it goes. Leaving a stale name on screen -- indistinct
    from one the user typed -- is the failure this feature has to avoid."""
    sam = _say("Samantha", LINE_A)
    sam2 = _say("Samantha", LINE_C)
    dan = _say("Daniel", LINE_B)
    if _any_missing(sam, sam2, dan):
        pytest.skip("say synthesis failed")

    stranger = identity_print([nembed(dan)])
    assert stranger is not None, "one long phrase is enough to define one"
    known = [KnownVoice(name="Nobody", vec=stranger.vec, rejects=[])]

    segments = [
        seg("Speaker 1", "sys", nembed(sam)),
        seg("Speaker 1", "sys", nembed(sam2)),
    ]
    # A guess made on evidence that has since moved on.
    names = {"Speaker 1": "Nobody"}
    recognized = {"Nobody"}
    naming = label.Naming(names=names, recognized=recognized, known=known)
    label.relabel(segments, 0, naming)
    assert not names, f"a name nothing supports stayed on screen: {names}"
    assert not recognized


@requires_say
@requires_model
def test_split_pass_cuts_a_two_voice_phrase() -> None:
    """ADD-28: two people answering each other with NO pause land in ONE
    phrase, and a phrase carries one label -- the split pass must cut the
    phrase at the voice change, keep the words with their halves, and give
    the halves different speakers."""
    a = _say("Samantha", LINE_A)
    a2 = _say("Samantha", LINE_C)
    b = _say("Daniel", LINE_B)
    b2 = _say("Daniel", LINE_D)
    if _any_missing(a, a2, b, b2):
        pytest.skip("say synthesis failed")

    audio = np.concatenate([a, a2])
    cut_cs = len(audio) * 100 // SAMPLE_RATE
    audio = np.concatenate([audio, b, b2])
    total_cs = len(audio) * 100 // SAMPLE_RATE

    # Synthetic words every 40 cs: the split must land them correctly
    # without any help from real word timings.
    n_words = total_cs // 40
    words = [RecWord(w=f"w{k}", t0=k * 40, t1=k * 40 + 35) for k in range(n_words)]
    segments = [
        RecSegment(
            id="one",
            source="sys",
            speaker="Speaker 1",
            t0=0,
            t1=total_cs,
            text="two people, one phrase",
            words=words,
            lang=None,
            voice=nembed(audio),
        )
    ]

    def wins_for(s: RecSegment) -> list[tuple[int, int, VoicePrint]]:
        i0 = max(s.t0, 0) * (SAMPLE_RATE // 100)
        i1 = min(max(s.t1, 0) * (SAMPLE_RATE // 100), len(audio))
        return window_prints(audio[i0:i1], s.t0, MODEL_PATH)

    naming = label.Naming.plain({}, set())
    changed = label.split_by_voice(segments, 0, naming, wins_for)
    assert changed, "the split pass saw a two-voice phrase and did nothing"
    assert len(segments) >= 2, f"phrase not split: {len(segments)} piece(s)"
    assert sum(len(s.words) for s in segments) == n_words, (
        "words lost or duplicated by the cut"
    )
    first = segments[0]
    last = segments[-1]
    assert first.speaker != last.speaker, "the pieces share one label"
    # The cut nearest the true voice change must land within one window.
    boundary = min((s.t1 for s in segments[:-1]), key=lambda t: abs(t - cut_cs))
    assert abs(boundary - cut_cs) <= 150, f"cut at {boundary}cs, true voice change at {cut_cs}cs"
