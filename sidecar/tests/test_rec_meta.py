"""Tests for `arcelle_sidecar.rec.meta` -- the Python port of the recording
data model + pure helpers (`src-tauri/src/recording.rs` lines 1-350 and
355-598).
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from arcelle_sidecar.diar.embed import VoicePrint
from arcelle_sidecar.rec import meta as m

# ------------------------------------------------------------------ constants


def test_constants_match_rust_source():
    assert m.SAMPLE_RATE == 16_000
    assert m.FRAME == 512
    assert m.START_FRAMES == 3
    assert m.END_FRAMES == 24
    assert m.PREROLL == 8_000
    assert m.MAX_SEGMENT == 16_000 * 28
    assert m.DIP_LOOKBACK == 16_000 * 5
    assert m.VAD_OPEN == pytest.approx(0.35)
    assert m.VAD_SUSTAIN == pytest.approx(0.20)
    assert m.PARTIAL_EVERY == 24_000
    assert m.FLUSH_EVERY_SEGMENTS == 8
    assert m.RELABEL_EVERY_SEGMENTS == 2
    assert m.RELABEL_TIME_BUDGET_MS == 40
    assert m.RELABEL_MAX_SEGMENTS == 64
    assert m.MAX_SESSION_SAMPLES == 16_000 * 3 * 3600
    assert m.RETRANSCRIBE_DECODE_PCT == 92
    assert m.RETRANSCRIBE_STOPPED == "Stopped — the transcript is unchanged."
    assert m.LANE_RESYNC_GAP == 8_000
    assert m.ECHO_OVERLAP == pytest.approx(0.5)
    assert m.ECHO_SAME_TEXT == pytest.approx(0.6)


# ------------------------------------------------------------- cs/samples


def test_cs_of_samples_and_samples_of_cs():
    assert m.cs_of_samples(16_000) == 100
    assert m.cs_of_samples(8_000) == 50
    assert m.cs_of_samples(0) == 0
    assert m.samples_of_cs(100) == 16_000
    assert m.samples_of_cs(50) == 8_000
    # negative cs clamps to 0 samples
    assert m.samples_of_cs(-5) == 0


# ------------------------------------------------------------- format_stamp


def test_format_stamp_sub_minute():
    assert m.format_stamp(0) == "[0:00]"
    assert m.format_stamp(530) == "[0:05]"  # 5.30s -> 5s
    assert m.format_stamp(4200) == "[0:42]"
    assert m.format_stamp(5999) == "[0:59]"  # 59.99s -> floor 59s


def test_format_stamp_minute_only_not_zero_padded():
    # minutes NOT zero-padded when there's no hour component
    assert m.format_stamp(65 * 100) == "[1:05]"
    assert m.format_stamp(9 * 60 * 100 + 5 * 100) == "[9:05]"
    assert m.format_stamp(59 * 60 * 100) == "[59:00]"  # just under an hour, still minute-only format
    assert m.format_stamp((16 * 60 + 15) * 100) == "[16:15]"


def test_format_stamp_hour_scale_zero_padded():
    # hour present -> both minutes and seconds are zero-padded to 2 digits
    assert m.format_stamp(3661 * 100) == "[1:01:01]"
    assert m.format_stamp((2 * 3600 + 5 * 60 + 9) * 100) == "[2:05:09]"
    # hours themselves are never padded
    assert m.format_stamp(10 * 3600 * 100) == "[10:00:00]"


def test_format_stamp_negative_clamps_to_zero():
    assert m.format_stamp(-100) == "[0:00]"
    assert m.format_stamp(-1) == "[0:00]"


# -------------------------------------------------------------- relabel_interval


def test_relabel_interval_clamps_low_end():
    # very small elapsed time still clamps up to RELABEL_EVERY_SEGMENTS
    assert m.relabel_interval(0) == m.RELABEL_EVERY_SEGMENTS
    assert m.relabel_interval(1) == m.RELABEL_EVERY_SEGMENTS


def test_relabel_interval_clamps_high_end():
    assert m.relabel_interval(1_000_000) == m.RELABEL_MAX_SEGMENTS


def test_relabel_interval_ceiling_division_exact_multiple():
    # exact multiple of the budget must NOT round up an extra step
    assert m.relabel_interval(80) == 2  # 80 / 40 == 2.0 exactly
    assert m.relabel_interval(120) == 3  # 120 / 40 == 3.0 exactly
    assert m.relabel_interval(10 * m.RELABEL_TIME_BUDGET_MS) == 10
    # one ms over a multiple DOES round up
    assert m.relabel_interval(81) == 3
    assert m.relabel_interval(10 * m.RELABEL_TIME_BUDGET_MS + 1) == 11


# -------------------------------------------------------------- text/time overlap


def test_text_overlap_basic():
    assert m.text_overlap("hello world", "hello there world") == pytest.approx(1.0)
    assert m.text_overlap("the quick fox", "a slow fox") == pytest.approx(1.0 / 3.0)
    assert m.text_overlap("completely different", "no match here") == pytest.approx(0.0)


def test_text_overlap_uses_smaller_set_as_denominator():
    # {a, b, c} vs {b, c, d, e} -- intersection {b, c}, smaller set size 3.
    assert m.text_overlap("a b c", "b c d e") == pytest.approx(2 / 3)


def test_text_overlap_punctuation_and_case_insensitive():
    assert m.text_overlap("Hello, World!", "hello world") == pytest.approx(1.0)


def test_text_overlap_empty_set_is_zero():
    assert m.text_overlap("", "hello") == 0.0
    assert m.text_overlap("hello", "") == 0.0
    assert m.text_overlap("", "") == 0.0
    assert m.text_overlap("...", "!!!") == 0.0  # tokenizes to nothing


def test_time_overlap_basic():
    assert m.time_overlap((0, 100), (50, 150)) == pytest.approx(50 / 100)
    assert m.time_overlap((0, 100), (0, 100)) == pytest.approx(1.0)


def test_time_overlap_no_overlap_is_zero():
    assert m.time_overlap((0, 100), (200, 300)) == pytest.approx(0.0)
    assert m.time_overlap((0, 5), (10, 15)) == 0.0


def test_time_overlap_zero_duration_span_uses_floor_of_1():
    # shorter = max(1, min(...)) -- a zero-length span still has a denominator of 1
    assert m.time_overlap((0, 0), (0, 100)) == pytest.approx(0.0)
    assert m.time_overlap((10, 10), (0, 100)) == pytest.approx(0.0)
    assert m.time_overlap((0, 0), (0, 0)) == 0.0


# -------------------------------------------------------------- segment_visible_text


def test_segment_visible_text_no_words_falls_back_to_stripped_text():
    seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=100, text="  hello there  ", words=[])
    assert m.segment_visible_text(seg) == "hello there"


def test_segment_visible_text_joins_non_deleted_words():
    words = [
        m.RecWord(w="hello", t0=0, t1=10),
        m.RecWord(w="cruel", t0=10, t1=20, del_=True),
        m.RecWord(w="world", t0=20, t1=30),
    ]
    seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=30, text="hello cruel world", words=words)
    assert m.segment_visible_text(seg) == "hello world"


def test_segment_visible_text_drops_empty_after_strip():
    words = [
        m.RecWord(w="  ", t0=0, t1=5),
        m.RecWord(w="hi", t0=5, t1=10),
    ]
    seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=10, text="  hi", words=words)
    assert m.segment_visible_text(seg) == "hi"


def test_segment_visible_text_all_deleted_is_empty():
    words = [m.RecWord(w="gone", t0=0, t1=10, del_=True)]
    seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=10, text="gone", words=words)
    assert m.segment_visible_text(seg) == ""


# -------------------------------------------------------------- add_cut / cut_shift_before / inside_cut


def test_add_cut_merges_overlapping():
    cuts: list[m.RecCut] = []
    m.add_cut(cuts, m.RecCut(t0=100, t1=200))
    m.add_cut(cuts, m.RecCut(t0=150, t1=300))
    assert cuts == [m.RecCut(t0=100, t1=300)]


def test_add_cut_merges_touching():
    # t0 <= last.t1 merges even when they only TOUCH (no real overlap)
    cuts: list[m.RecCut] = []
    m.add_cut(cuts, m.RecCut(t0=100, t1=200))
    m.add_cut(cuts, m.RecCut(t0=200, t1=250))
    assert cuts == [m.RecCut(t0=100, t1=250)]


def test_add_cut_leaves_disjoint_separate():
    cuts: list[m.RecCut] = []
    m.add_cut(cuts, m.RecCut(t0=100, t1=200))
    m.add_cut(cuts, m.RecCut(t0=300, t1=400))
    assert cuts == [m.RecCut(t0=100, t1=200), m.RecCut(t0=300, t1=400)]


def test_add_cut_out_of_order_insertion_still_sorts_and_merges():
    cuts: list[m.RecCut] = []
    m.add_cut(cuts, m.RecCut(t0=300, t1=400))
    m.add_cut(cuts, m.RecCut(t0=100, t1=200))
    m.add_cut(cuts, m.RecCut(t0=190, t1=310))
    assert cuts == [m.RecCut(t0=100, t1=400)]


def test_add_cut_new_cut_fully_inside_existing_is_absorbed():
    cuts: list[m.RecCut] = []
    m.add_cut(cuts, m.RecCut(t0=0, t1=1000))
    m.add_cut(cuts, m.RecCut(t0=200, t1=300))
    assert cuts == [m.RecCut(t0=0, t1=1000)]


def test_cut_shift_before_multi_cut():
    cuts = [m.RecCut(t0=0, t1=100), m.RecCut(t0=200, t1=300)]
    assert m.cut_shift_before(cuts, 50) == 50  # partway into first cut
    assert m.cut_shift_before(cuts, 150) == 100  # past first cut, before second
    assert m.cut_shift_before(cuts, 250) == 150  # into the second cut
    assert m.cut_shift_before(cuts, 1000) == 200  # past both


def test_cut_shift_before_before_any_cut_is_zero():
    cuts = [m.RecCut(t0=100, t1=200)]
    assert m.cut_shift_before(cuts, 0) == 0


def test_inside_cut_multi_cut():
    cuts = [m.RecCut(t0=0, t1=100), m.RecCut(t0=200, t1=300)]
    assert m.inside_cut(cuts, 50) is True
    assert m.inside_cut(cuts, 150) is False
    assert m.inside_cut(cuts, 250) is True
    assert m.inside_cut(cuts, 100) is False  # t1 is exclusive
    assert m.inside_cut(cuts, 0) is True  # t0 is inclusive
    assert m.inside_cut(cuts, 300) is False


# -------------------------------------------------------------- ReadStamp.of (byte length)


def test_read_stamp_of_uses_utf8_byte_length_not_char_count():
    # Hebrew: each character is 2 bytes in UTF-8.
    hebrew_seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=100, text="שלום", words=[])
    stamp = m.ReadStamp.of([hebrew_seg])
    assert stamp.turns == 1
    assert len("שלום") == 4  # 4 code points
    assert stamp.chars == len("שלום".encode("utf-8")) == 8
    assert stamp.chars != len("שלום")

    # Emoji: astral-plane code point, 4 bytes in UTF-8, 1 Python code point.
    emoji_seg = m.RecSegment(id="2", source="mic", speaker="You", t0=0, t1=100, text="🎉", words=[])
    stamp2 = m.ReadStamp.of([emoji_seg])
    assert len("🎉") == 1
    assert stamp2.chars == 4


def test_read_stamp_of_sums_across_segments():
    segs = [
        m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=10, text="ab", words=[]),
        m.RecSegment(id="2", source="mic", speaker="You", t0=10, t1=20, text="cde", words=[]),
    ]
    stamp = m.ReadStamp.of(segs)
    assert stamp.turns == 2
    assert stamp.chars == 5


# -------------------------------------------------------------- transcript_text


def test_transcript_text_interleaved_chapters_notes_highlights():
    segs = [
        m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=500, text="hello everyone", words=[]),
        m.RecSegment(id="2", source="sys", speaker="Speaker 1", t0=600, t1=1000, text="we ship thursday", words=[]),
        m.RecSegment(id="3", source="mic", speaker="You", t0=1100, t1=1500, text="great, thanks", words=[]),
    ]
    chapters = [m.RecChapter(id="c1", t0=0, title="Kickoff")]
    notes = [
        m.RecNote(id="n1", t0=600, kind=m.NoteKind.DECISION, text="ship Thursday"),
        m.RecNote(id="n2", t0=2000, kind=m.NoteKind.ACTION, text="write the doc", who="Dana"),
    ]
    highlights = [m.RecHighlight(id="h1", t0=600, t1=1000)]  # exactly covers segment 2
    meta = m.RecMeta(
        segments=segs,
        chapters=chapters,
        notes=notes,
        highlights=highlights,
        speaker_names={"Speaker 1": "Dana"},
    )

    text = m.transcript_text(meta)
    lines = text.split("\n")

    assert lines[0] == "(live recording)"
    # chapter flushed before segment 1 (t0=0 <= 0)
    assert "## [0:00] Kickoff" in text
    # segment 1, no mark
    assert "[0:00] You: hello everyone" in text
    # note flushed before segment 2 (t0=600 <= 600), decision has no "(who)"
    assert "[0:06] Decision: ship Thursday" in text
    # segment 2 is display-named via speaker_names, and marked (highlight overlaps)
    assert "* [0:06] Dana: we ship thursday" in text
    # segment 3, unmarked
    assert "[0:11] You: great, thanks" in text
    # trailing note (t0=2000, past every segment) flushed at the end, with "(who)"
    assert "[0:20] Action (Dana): write the doc" in text

    # Order check: chapter header appears before segment 1's line, which
    # appears before the decision note, which appears before segment 2.
    i_chapter = text.index("## [0:00] Kickoff")
    i_seg1 = text.index("[0:00] You: hello everyone")
    i_note1 = text.index("Decision: ship Thursday")
    i_seg2 = text.index("we ship thursday")
    i_seg3 = text.index("great, thanks")
    i_note2 = text.index("Action (Dana): write the doc")
    assert i_chapter < i_seg1 < i_note1 < i_seg2 < i_seg3 < i_note2


def test_transcript_text_chapter_note_anchored_on_empty_segment_is_deferred():
    """A chapter/note anchored at-or-before an EMPTY segment (all its words
    deleted) is deferred -- it is emitted before the next NON-empty segment
    instead, matching the Rust source's actual control flow
    (`segment_visible_text` is checked, and skipped, BEFORE either flush loop
    runs)."""
    seg1 = m.RecSegment(
        id="s1",
        source="mic",
        speaker="You",
        t0=0,
        t1=500,
        text="hello there",
        words=[m.RecWord(w="hello", t0=0, t1=200), m.RecWord(w="there", t0=200, t1=500)],
    )
    # Every word deleted -> segment_visible_text is empty -> skipped whole.
    seg2 = m.RecSegment(
        id="s2",
        source="mic",
        speaker="You",
        t0=600,
        t1=800,
        text="um",
        words=[m.RecWord(w="um", t0=600, t1=800, del_=True)],
    )
    seg3 = m.RecSegment(id="s3", source="sys", speaker="Speaker 1", t0=1000, t1=1500, text="let's ship", words=[])

    meta = m.RecMeta(
        segments=[seg1, seg2, seg3],
        chapters=[
            m.RecChapter(id="c1", t0=0, title="Kickoff"),
            m.RecChapter(id="c2", t0=600, title="Middle"),  # anchored on the empty segment
            m.RecChapter(id="c3", t0=2000, title="Wrap"),  # past the last segment
        ],
        notes=[
            m.RecNote(id="n1", t0=0, kind=m.NoteKind.DECISION, text="ship Thursday"),
            m.RecNote(id="n2", t0=600, kind=m.NoteKind.ACTION, text="send doc", who="Dana"),
            m.RecNote(id="n3", t0=2000, kind=m.NoteKind.POINT, text="wrap point"),
        ],
        highlights=[m.RecHighlight(id="h1", t0=0, t1=300)],  # overlaps seg1 only
        speaker_names={"You": "Ben"},
    )

    expected = (
        "(live recording)\n"
        "\n## [0:00] Kickoff\n"
        "[0:00] Decision: ship Thursday\n"
        "* [0:00] Ben: hello there\n"
        "\n## [0:06] Middle\n"
        "[0:06] Action (Dana): send doc\n"
        "[0:10] Speaker 1: let's ship\n"
        "\n## [0:20] Wrap\n"
        "[0:20] Point: wrap point\n"
    )
    actual = m.transcript_text(meta)
    assert actual == expected

    # And explicitly: the chapter/note anchored on the skipped empty segment
    # is deferred past seg1's line and lands before seg3's, never right
    # after seg1.
    assert actual.index("Middle") > actual.index("hello there")
    assert actual.index("Middle") < actual.index("let's ship")
    assert actual.index("send doc") < actual.index("let's ship")


def test_transcript_text_no_mark_when_highlight_does_not_overlap():
    segs = [m.RecSegment(id="1", source="mic", speaker="You", t0=1000, t1=2000, text="not highlighted", words=[])]
    highlights = [m.RecHighlight(id="h1", t0=0, t1=500)]  # entirely before the segment
    meta = m.RecMeta(segments=segs, highlights=highlights)
    text = m.transcript_text(meta)
    assert "* " not in text
    assert "[0:10] You: not highlighted" in text


def test_transcript_text_deleted_words_are_absent_and_empty_segment_skipped():
    words = [m.RecWord(w="secret", t0=0, t1=10, del_=True)]
    empty_seg = m.RecSegment(id="1", source="mic", speaker="You", t0=0, t1=10, text="secret", words=words)
    real_seg = m.RecSegment(id="2", source="mic", speaker="You", t0=100, t1=200, text="visible text", words=[])
    meta = m.RecMeta(segments=[empty_seg, real_seg])
    text = m.transcript_text(meta)
    assert "secret" not in text
    assert "visible text" in text


def test_transcript_text_zero_point_highlight_edge_case():
    # h.t1 == h.t0 -- the guard treats it as covering [t0, t0+1)
    segs = [m.RecSegment(id="1", source="mic", speaker="You", t0=50, t1=150, text="edge case", words=[])]
    highlights = [m.RecHighlight(id="h1", t0=50, t1=50)]
    meta = m.RecMeta(segments=segs, highlights=highlights)
    text = m.transcript_text(meta)
    assert "* [0:00] You: edge case" in text


def test_transcript_text_skips_segments_with_no_visible_text():
    seg_empty = m.RecSegment(id="a", source="mic", speaker="You", t0=0, t1=100, text="   ", words=[])
    meta = m.RecMeta(segments=[seg_empty])
    assert m.transcript_text(meta) == "(live recording)\n"


# -------------------------------------------------------------- display_speaker


def test_display_speaker_substitution_and_fallback():
    meta = m.RecMeta(speaker_names={"Speaker 1": "Dana"})
    assert meta.display_speaker("Speaker 1") == "Dana"
    assert meta.display_speaker("Speaker 2") == "Speaker 2"  # not in map -> falls back to label


# -------------------------------------------------------------- By / NoteKind enums


def test_by_is_room():
    assert m.By.ROOM.is_room() is True
    assert m.By.YOU.is_room() is False
    assert m.By.ROOM.value == "room"
    assert m.By.YOU.value == "you"


def test_note_kind_values():
    assert m.NoteKind.DECISION.value == "decision"
    assert m.NoteKind.ACTION.value == "action"
    assert m.NoteKind.QUESTION.value == "question"
    assert m.NoteKind.POINT.value == "point"


# -------------------------------------------------------------- JSON round-trip: RecWord


def test_recword_round_trip_without_deleted_omits_del_key():
    w = m.RecWord(w="hello", t0=0, t1=10)
    d = w.to_dict()
    assert "del" not in d
    assert d == {"w": "hello", "t0": 0, "t1": 10}
    w2 = m.RecWord.from_dict(d)
    assert w2 == w
    assert w2.del_ is False


def test_recword_round_trip_with_deleted_includes_del_key():
    w = m.RecWord(w="gone", t0=0, t1=10, del_=True)
    d = w.to_dict()
    assert d["del"] is True
    w2 = m.RecWord.from_dict(d)
    assert w2 == w
    assert w2.del_ is True


def test_recword_from_dict_defaults_del_to_false_when_absent():
    w = m.RecWord.from_dict({"w": "x", "t0": 0, "t1": 1})
    assert w.del_ is False


# -------------------------------------------------------------- JSON round-trip: RecSegment


def test_recsegment_round_trip_no_lang_no_voice():
    seg = m.RecSegment(
        id="s1", source="mic", speaker="You", t0=0, t1=100, text="hello", words=[m.RecWord(w="hello", t0=0, t1=100)]
    )
    d = seg.to_dict()
    assert "lang" not in d
    assert "voice" not in d
    seg2 = m.RecSegment.from_dict(d)
    assert seg2 == seg


def test_recsegment_round_trip_with_lang():
    seg = m.RecSegment(id="s1", source="mic", speaker="You", t0=0, t1=100, text="hi", words=[], lang="en")
    d = seg.to_dict()
    assert d["lang"] == "en"
    seg2 = m.RecSegment.from_dict(d)
    assert seg2.lang == "en"


def test_recsegment_round_trip_with_voice_uses_v_f_shape():
    # Exact-in-binary values so the float32 round trip through JSON is
    # bit-exact, not merely close.
    vp = VoicePrint(vec=np.array([0.5, -0.25, 0.125], dtype=np.float32), voiced_frames=42)
    seg = m.RecSegment(id="s1", source="sys", speaker="Speaker 1", t0=0, t1=100, text="hi", words=[], voice=vp)
    d = seg.to_dict()
    assert set(d["voice"].keys()) == {"v", "f"}
    assert d["voice"]["f"] == 42
    assert d["voice"]["v"] == [0.5, -0.25, 0.125]
    # confirm it is NOT the borrowed dataclass's own field names
    assert "vec" not in d["voice"]
    assert "voiced_frames" not in d["voice"]

    # Fully JSON-serializable (no numpy scalars leaking through).
    reloaded = json.loads(json.dumps(d))

    seg2 = m.RecSegment.from_dict(reloaded)
    assert seg2.voice is not None
    assert isinstance(seg2.voice.vec, np.ndarray)
    assert np.array_equal(seg2.voice.vec, vp.vec)
    assert seg2.voice.voiced_frames == 42
    # Re-serializing the reconstructed object reproduces the same shape -- a
    # straight dataclass `==` on RecSegment is unsafe here (`voice.vec` is a
    # multi-element numpy array, so tuple-equality inside the generated
    # `__eq__` raises "truth value of an array is ambiguous").
    assert seg2.to_dict() == d


def test_recsegment_from_dict_reads_real_on_disk_shape():
    # Simulates a row already on disk in the exact Rust-serialized shape.
    raw = {
        "id": "abc",
        "source": "sys",
        "speaker": "Speaker 2",
        "t0": 500,
        "t1": 900,
        "text": "we ship thursday",
        "words": [{"w": "we", "t0": 500, "t1": 550}, {"w": "ship", "t0": 550, "t1": 600, "del": True}],
        "voice": {"v": [0.5, -0.5], "f": 10},
    }
    seg = m.RecSegment.from_dict(raw)
    assert seg.words[1].del_ is True
    assert seg.voice is not None
    assert seg.voice.voiced_frames == 10
    assert seg.lang is None


def test_recsegment_from_dict_requires_words_key():
    # `words` has NO `#[serde(default)]` on the Rust struct (unlike
    # `lang`/`voice`) -- a real deserialize of JSON missing it fails, and this
    # port mirrors that with a hard KeyError, same as id/source/speaker/t0/t1/text.
    raw = {"id": "s1", "source": "mic", "speaker": "You", "t0": 0, "t1": 100, "text": "hi"}
    with pytest.raises(KeyError):
        m.RecSegment.from_dict(raw)


def _assert_meta_equal(a: m.RecMeta, b: m.RecMeta) -> None:
    """Field-by-field RecMeta equality, in place of `==`.

    `VoicePrint` (borrowed from `diar.embed`, not owned by this module) is a
    plain dataclass with a `numpy.ndarray` field, so its generated `__eq__`
    raises `ValueError: truth value of an array... is ambiguous` on any
    non-empty vector -- comparing two RecSegments (or RecMetas) that carry a
    voiceprint via `==` inherits that crash. This walks every field itself,
    using `np.testing.assert_allclose` only for the one field that needs it.
    """
    assert a.duration_cs == b.duration_cs
    assert len(a.segments) == len(b.segments)
    for sa, sb in zip(a.segments, b.segments):
        assert sa.id == sb.id
        assert sa.source == sb.source
        assert sa.speaker == sb.speaker
        assert sa.t0 == sb.t0
        assert sa.t1 == sb.t1
        assert sa.text == sb.text
        assert sa.words == sb.words
        assert sa.lang == sb.lang
        if sa.voice is None or sb.voice is None:
            assert sa.voice is None and sb.voice is None
        else:
            assert sa.voice.voiced_frames == sb.voice.voiced_frames
            np.testing.assert_allclose(sa.voice.vec, sb.voice.vec)
    assert a.cuts == b.cuts
    assert a.max_speakers == b.max_speakers
    assert a.speaker_names == b.speaker_names
    assert a.recognized == b.recognized
    assert a.chapters == b.chapters
    assert a.highlights == b.highlights
    assert a.notes == b.notes
    assert a.read_of == b.read_of


# -------------------------------------------------------------- JSON round-trip: RecMeta


def test_recmeta_omits_empty_optional_collections():
    meta = m.RecMeta()
    d = meta.to_dict()
    assert "speakerNames" not in d
    assert "recognized" not in d
    assert "chapters" not in d
    assert "highlights" not in d
    assert "notes" not in d
    assert "readOf" not in d
    assert d["maxSpeakers"] == 0  # always present, unlike the skip-if fields


def test_recmeta_speaker_names_and_recognized_serialize_sorted():
    meta = m.RecMeta(
        speaker_names={"Speaker 3": "Zed", "Speaker 1": "Amy", "Speaker 2": "Mo"},
        recognized={"Zed", "Amy", "Mo"},
    )
    d = meta.to_dict()
    # Lexicographic (BTreeMap/BTreeSet order), not insertion order.
    assert list(d["speakerNames"].keys()) == ["Speaker 1", "Speaker 2", "Speaker 3"]
    assert d["recognized"] == ["Amy", "Mo", "Zed"]


def test_recmeta_full_round_trip():
    vp = VoicePrint(vec=np.array([0.25, 0.75], dtype=np.float32), voiced_frames=7)
    segs = [
        m.RecSegment(
            id="s1",
            source="mic",
            speaker="You",
            t0=0,
            t1=100,
            text="hi there",
            words=[m.RecWord(w="hi", t0=0, t1=50), m.RecWord(w="there", t0=50, t1=100, del_=True)],
        ),
        m.RecSegment(
            id="s2",
            source="sys",
            speaker="Speaker 1",
            t0=200,
            t1=400,
            text="ok cool",
            words=[],
            lang="en",
            voice=vp,
        ),
    ]
    meta = m.RecMeta(
        duration_cs=500,
        segments=segs,
        cuts=[m.RecCut(t0=1000, t1=1100), m.RecCut(t0=50, t1=60)],
        max_speakers=2,
        speaker_names={"Speaker 1": "Dana"},
        recognized={"Dana"},
        chapters=[m.RecChapter(id="c1", t0=0, title="Intro", by=m.By.YOU)],
        highlights=[m.RecHighlight(id="h1", t0=0, t1=100)],
        notes=[m.RecNote(id="n1", t0=0, kind=m.NoteKind.ACTION, text="send doc", who="Dana", by=m.By.ROOM)],
        read_of=m.ReadStamp(turns=2, chars=15),
    )

    raw = meta.to_dict()
    blob = json.dumps(raw)  # proves the dict is fully JSON-safe
    reloaded_raw = json.loads(blob)

    # note-by defaults to Room and is always present
    assert raw["notes"][0]["by"] == "room"
    # highlight-by defaults to Room and is always present
    assert raw["highlights"][0]["by"] == "room"
    # chapter-by was explicitly You
    assert raw["chapters"][0]["by"] == "you"

    meta2 = m.RecMeta.from_dict(reloaded_raw)

    # Structural round trip: re-serializing the reconstructed object
    # reproduces the exact same JSON shape.
    assert meta2.to_dict() == raw
    _assert_meta_equal(meta2, meta)

    # and it survives a second trip too (idempotent)
    d2 = meta2.to_dict()
    assert d2 == raw

    assert meta.display_speaker("Speaker 1") == "Dana"
    assert meta.display_speaker("Nobody") == "Nobody"

    assert len(meta2.segments) == 2
    assert meta2.segments[0].lang is None
    assert meta2.segments[0].voice is None
    assert meta2.segments[0].words[1].del_ is True
    assert meta2.segments[1].voice is not None
    assert np.array_equal(meta2.segments[1].voice.vec, vp.vec)
    assert meta2.segments[1].voice.voiced_frames == 7


def test_recmeta_from_dict_defaults_missing_optional_fields():
    minimal = {"durationCs": 0, "segments": [], "cuts": []}
    meta = m.RecMeta.from_dict(minimal)
    assert meta.max_speakers == 0
    assert meta.speaker_names == {}
    assert meta.recognized == set()
    assert meta.chapters == []
    assert meta.highlights == []
    assert meta.notes == []
    assert meta.read_of is None


def test_recmeta_from_dict_requires_duration_segments_cuts():
    # duration_cs/segments/cuts have NO `#[serde(default)]` on the Rust
    # struct -- a real deserialize of JSON missing any of them fails, and
    # this port mirrors that with a hard KeyError rather than silently
    # defaulting.
    with pytest.raises(KeyError):
        m.RecMeta.from_dict({"segments": [], "cuts": []})
    with pytest.raises(KeyError):
        m.RecMeta.from_dict({"durationCs": 0, "cuts": []})
    with pytest.raises(KeyError):
        m.RecMeta.from_dict({"durationCs": 0, "segments": []})
