"""Tests for `arcelle_sidecar.docs.subtitles` (port of the subtitle section
of `src-tauri/src/extraction/data.rs`: `extract_subtitles`).

Mirrors the Rust `#[cfg(test)]` subtitle cases verbatim:
`subtitles_lose_their_timing_and_keep_their_words`,
`webvtt_headers_and_notes_are_dropped_too`, plus the two blank-input cases
from `unreadable_bytes_read_as_nothing_rather_than_panicking`.
"""

from __future__ import annotations

from arcelle_sidecar.docs.subtitles import extract_subtitles


def test_subtitles_lose_their_timing_and_keep_their_words() -> None:
    srt = (
        "1\n00:00:01,000 --> 00:00:04,000\nGood morning everyone.\n\n"
        "2\n00:00:04,500 --> 00:00:06,000\nLet's begin.\n"
    )
    text = extract_subtitles(srt)
    assert text is not None, "no text"
    assert text.strip() == "Good morning everyone.\nLet's begin."


def test_webvtt_headers_and_notes_are_dropped_too() -> None:
    vtt = "WEBVTT\n\nNOTE recorded live\n\n00:01.000 --> 00:02.000\nHello.\n"
    text = extract_subtitles(vtt)
    assert text is not None, "no text"
    assert text.strip() == "Hello."


def test_blank_or_whitespace_only_input_is_none() -> None:
    assert extract_subtitles("   \n\n") is None


def test_a_number_embedded_in_a_longer_line_is_not_a_bare_cue_number() -> None:
    """Regression: only a line that consists ENTIRELY of ASCII digits is a
    bare cue number. "42 seconds left" contains digits but is not all-digit,
    so -- unlike a lone "42" cue-number line -- it must survive as spoken
    text rather than being mistaken for cue numbering.
    """
    srt = "1\n00:00:01,000 --> 00:00:04,000\n42 seconds left.\n"
    text = extract_subtitles(srt)
    assert text is not None, "no text"
    assert text.strip() == "42 seconds left."
