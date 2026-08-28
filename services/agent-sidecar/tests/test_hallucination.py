"""Tests for `arcelle_sidecar.stt.hallucination`.

The core cases below (`test_stock_max_confidence_constant`,
`test_junk_segments_are_recognized`, `test_stock_hallucinations_are_recognized`,
`test_merge_words_reassembles_utf8_split_across_tokens`,
`test_merge_words_ascii_subwords_and_punctuation`) are DIRECT ports of the real
`#[test]` functions in `src-tauri/src/stt.rs`'s `mod tests` (same names,
same inputs, same expected outputs) — not hand-invented examples. Everything
else is additional edge-case coverage for behavior the Rust doc comments and
source promise but the Rust `#[test]`s don't exercise directly (mismatched
brackets, invalid UTF-8 fallback, multi-piece timing, partial stock-phrase
matches, etc.).

Pure text/byte processing — no model, no I/O, nothing here needs the
downloaded Whisper weights. (`segment_mean_p`, the one function in this
section of stt.rs that DOES need a live model, is deliberately not ported —
see the module docstring in `hallucination.py`.)
"""

from __future__ import annotations

import pytest

from arcelle_sidecar.stt.hallucination import (
    STOCK_MAX_CONFIDENCE,
    is_junk_segment,
    is_stock_hallucination,
    merge_token_words,
)


# ---------------------------------------------------------------------------
# STOCK_MAX_CONFIDENCE
# ---------------------------------------------------------------------------


def test_stock_max_confidence_constant() -> None:
    assert STOCK_MAX_CONFIDENCE == 0.5


# ---------------------------------------------------------------------------
# is_junk_segment
# ---------------------------------------------------------------------------


def test_junk_segments_are_recognized() -> None:
    """Verbatim port of stt.rs `junk_segments_are_recognized`."""
    assert is_junk_segment("[BLANK_AUDIO]")
    assert is_junk_segment("(music)")
    assert is_junk_segment("♪ ♪")
    assert is_junk_segment("   ")
    # A lone "." is what Whisper emits for a near-silent clip — it must be
    # dropped by the import path too, not stored as a real transcript.
    assert is_junk_segment(".")
    assert is_junk_segment(". . .")
    assert not is_junk_segment("Hello there")
    assert not is_junk_segment("שלום")


@pytest.mark.parametrize(
    "text",
    ["", "   ", "\t\n"],
)
def test_is_junk_segment_empty_or_whitespace(text: str) -> None:
    assert is_junk_segment(text) is True


def test_is_junk_segment_star_bracketed() -> None:
    assert is_junk_segment("*laughs*") is True


def test_is_junk_segment_leading_trailing_whitespace_is_trimmed_first() -> None:
    # Trimmed down to "[BLANK_AUDIO]" before the bracket check runs.
    assert is_junk_segment("   [BLANK_AUDIO]   ") is True
    assert is_junk_segment("  Hello there  ") is False


def test_is_junk_segment_mismatched_brackets_not_junk_by_bracket_rule() -> None:
    # Starts with '[' but does not end with ']' -- not "bracketed" by the
    # rule. It also has real letters, so it isn't caught by the
    # all-non-alphanumeric rule either: not junk.
    assert is_junk_segment("[oops") is False
    assert is_junk_segment("[oops still talking") is False
    # But "[--]" starts and ends with brackets AND is all non-alphanumeric
    # inside -- still junk either way.
    assert is_junk_segment("[--]") is True
    # Real text wrapped in brackets is still junk by the bracket rule alone,
    # regardless of what's inside.
    assert is_junk_segment("[Hello]") is True
    # A lone unmatched bracket is not "bracketed" but IS all-non-alphanumeric.
    assert is_junk_segment("[") is True


def test_is_junk_segment_mixed_content_with_punctuation_is_not_junk() -> None:
    assert is_junk_segment("Hello, there!") is False
    assert is_junk_segment("42 is the answer") is False


# ---------------------------------------------------------------------------
# is_stock_hallucination
# ---------------------------------------------------------------------------


def test_stock_hallucinations_are_recognized() -> None:
    """Verbatim port of stt.rs `stock_hallucinations_are_recognized`."""
    assert is_stock_hallucination("Thank you.")
    assert is_stock_hallucination("Thank you. Thank you. Thank you.")
    assert is_stock_hallucination("Thanks for watching!")
    assert is_stock_hallucination("ありがとうございました")
    assert is_stock_hallucination("감사합니다")
    assert is_stock_hallucination("Продолжение следует...")
    assert is_stock_hallucination("תודה רבה")
    assert is_stock_hallucination("Subtitles by the Amara.org community")
    # Real speech that happens to include the words stays real.
    assert not is_stock_hallucination("Thank you for the report, let's move on.")
    assert not is_stock_hallucination("תודה רבה שבאת, טוב להיות פה")
    assert not is_stock_hallucination("I want to thank you all for coming today")
    assert not is_stock_hallucination("")


@pytest.mark.parametrize(
    "text",
    [
        "thank you",
        "thank you very much",
        "thank you so much",
        "thanks for watching",
        "thank you for watching",
        "please subscribe",
        "ありがとうございました",
        "ご視聴ありがとうございました",
        "감사합니다",
        "시청해주셔서 감사합니다",
        "спасибо за просмотр",
        "gracias por ver",
        "תודה רבה",
        "תודה שצפיתם",
    ],
)
def test_is_stock_hallucination_all_stock_phrases_case_insensitive(text: str) -> None:
    assert is_stock_hallucination(text) is True
    assert is_stock_hallucination(text.upper()) is True


@pytest.mark.parametrize(
    "text",
    [
        "amara.org",
        "subtitles by",
        "captioned by",
        "субтитры",
        "продолжение следует",
        "untertitel",
        "sous-titres",
        "כתוביות",
    ],
)
def test_is_stock_hallucination_all_credit_marks_match_anywhere(text: str) -> None:
    assert is_stock_hallucination(text) is True
    assert is_stock_hallucination(f"  {text.upper()} extra junk around it") is True


def test_stock_hallucination_one_non_stock_sentence_wins() -> None:
    # One non-stock sentence anywhere in the segment means False, even
    # though the first sentence is a stock phrase.
    assert not is_stock_hallucination("Thank you. Also, the sky is blue.")


def test_stock_hallucination_all_empty_split_is_false() -> None:
    # An all-empty split (no real content at all) means False, matching
    # Rust's "any" flag starting false.
    assert not is_stock_hallucination("...")
    assert not is_stock_hallucination(" , . ! ? ")


def test_stock_hallucination_repeated_and_multiple_stock_sentences() -> None:
    assert is_stock_hallucination("please subscribe, thank you so much!")
    assert is_stock_hallucination("Thank you! Thanks for watching.")


def test_stock_hallucination_punctuation_edges_are_stripped() -> None:
    # Quotes/punctuation at sentence edges are stripped before the STOCK
    # membership check runs.
    assert is_stock_hallucination('"Please subscribe!"') is True


def test_stock_hallucination_partial_match_is_not_enough() -> None:
    # "thank you" is stock, but "thank you kindly" as a WHOLE sentence is not
    # in the STOCK list -- must equal the sentence exactly, not just contain it.
    assert is_stock_hallucination("Thank you kindly.") is False


# ---------------------------------------------------------------------------
# merge_token_words
# ---------------------------------------------------------------------------


def test_merge_words_reassembles_utf8_split_across_tokens() -> None:
    """Verbatim port of stt.rs `merge_words_reassembles_utf8_split_across_tokens`."""
    # "שלום עולם" with a letter's two UTF-8 bytes split across tokens —
    # exactly how Whisper's BPE tokenizes Hebrew. Per-token decoding would
    # give "�" halves; byte-level assembly must not.
    shalom = "שלום".encode("utf-8")  # 4 letters x 2 bytes
    olam = " עולם".encode("utf-8")  # leading space starts the word

    pieces: list[tuple[bytes, int, int]] = [
        (shalom[:3], 100, 110),  # ש + first byte of the next letter
        (shalom[3:], 110, 120),  # remaining bytes
        (olam[:4], 130, 140),  # " " + start of the next letter
        (olam[4:], 140, 150),  # rest
    ]
    words = merge_token_words(pieces)
    assert words == [("שלום", 100, 120), ("עולם", 130, 150)]
    assert all("�" not in w for w, _, _ in words)


def test_merge_words_ascii_subwords_and_punctuation() -> None:
    """Verbatim port of stt.rs `merge_words_ascii_subwords_and_punctuation`."""

    def p(s: str, t0: int, t1: int) -> tuple[bytes, int, int]:
        return (s.encode("utf-8"), t0, t1)

    pieces = [
        p(" Hel", 0, 5),
        p("lo", 5, 10),
        p(",", 10, 12),  # punctuation glues onto the previous word
        p(" world", 12, 20),
        p("!\n", 20, 22),  # trailing newline stripped
    ]
    assert merge_token_words(pieces) == [
        ("Hello,", 0, 12),
        ("world!", 12, 22),
    ]

    # First piece without a leading space still opens a word; empty pieces
    # (post-trim) produce no words.
    assert merge_token_words([p("Hi", 0, 3), p(" ", 3, 4)]) == [("Hi", 0, 3)]
    assert merge_token_words([]) == []


def test_merge_token_words_empty_input() -> None:
    assert merge_token_words([]) == []


def test_merge_token_words_drops_words_that_are_whitespace_only() -> None:
    pieces = [(b"Hello", 0, 3), (b"   ", 3, 6)]
    # The second "word" trims down to empty and is dropped entirely.
    assert merge_token_words(pieces) == [("Hello", 0, 3)]


def test_merge_token_words_invalid_utf8_falls_back_to_replacement_char() -> None:
    # Invalid UTF-8 bytes must not raise -- they decode via the lossy
    # fallback (Rust's from_utf8_lossy equivalent), producing U+FFFD.
    pieces: list[tuple[bytes, int, int]] = [(b"\xff\xfe", 0, 1)]
    words = merge_token_words(pieces)
    assert len(words) == 1
    word, t0, t1 = words[0]
    assert "�" in word
    assert (t0, t1) == (0, 1)


def test_merge_token_words_emoji_split_across_non_boundary() -> None:
    # A 4-byte emoji (outside the BMP) split at a non-character-boundary byte
    # offset across two "tokens"; the second piece does not start with a
    # space byte, so it must extend the in-progress word.
    emoji = "🎉".encode("utf-8")
    assert len(emoji) == 4
    pieces: list[tuple[bytes, int, int]] = [
        (emoji[:2], 0, 1),
        (emoji[2:], 1, 2),
    ]
    words = merge_token_words(pieces)
    assert words == [("🎉", 0, 2)]


def test_merge_token_words_timing_is_first_t0_and_last_t1() -> None:
    pieces = [(b" abc", 10, 20), (b"def", 20, 30), (b"ghi", 30, 45)]
    assert merge_token_words(pieces) == [("abcdefghi", 10, 45)]
