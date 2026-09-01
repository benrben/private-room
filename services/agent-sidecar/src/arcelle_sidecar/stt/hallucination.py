"""Whisper hallucination filtering — pure text/byte processing.

Ported from the Rust source `src-tauri/src/stt.rs` (lines ~360-490):
`is_junk_segment`, `STOCK_MAX_CONFIDENCE`, `is_stock_hallucination`, and
`merge_token_words`. No model, no I/O — these functions only ever look at
text/bytes a decode already produced.

Deliberately NOT ported: `segment_mean_p`. It reads live `whisper_rs`
token/segment state (`seg.n_tokens()`, `seg.get_token(j)`,
`tok.token_data().p`) that only exists while a whisper context is decoding —
there is nothing to port here without a live model. Only its doc comment (the
meaning of the `STOCK_MAX_CONFIDENCE` cutoff below) carries over: a caller
that has a mean token probability for a segment should still gate
`is_stock_hallucination()` on `mean_p < STOCK_MAX_CONFIDENCE`, exactly as the
Rust whole-file and live paths do.
"""

from __future__ import annotations

# Below this mean token probability a stock phrase is the model guessing at
# noise, not something anyone said. A real spoken "thank you" scores far
# higher and stays. Shared by the live path and the whole-file path so an
# imported recording, a voice message and a live meeting all strip the same
# invented sentences.
STOCK_MAX_CONFIDENCE: float = 0.5


def is_junk_segment(text: str) -> bool:
    """True for a Whisper "segment" that is noise dressed as text — the
    classic silence hallucinations ("[BLANK_AUDIO]", "(music)", a lone ♪).
    """
    trimmed = text.strip()
    return not trimmed or _is_wrapped_junk(trimmed) or _has_no_alphanumeric(trimmed)


def _is_wrapped_junk(text: str) -> bool:
    return (
        _is_wrapped_by(text, "[", "]")
        or _is_wrapped_by(text, "(", ")")
        or _is_wrapped_by(text, "*", "*")
    )


def _is_wrapped_by(text: str, opening: str, closing: str) -> bool:
    return text.startswith(opening) and text.endswith(closing)


def _has_no_alphanumeric(text: str) -> bool:
    return all(not character.isalnum() for character in text)


def _trim_non_alnum(s: str) -> str:
    """Strip leading/trailing characters that are NOT alphanumeric — mirrors
    Rust's `s.trim_matches(|c: char| !c.is_alphanumeric())`.
    """
    i, j = 0, len(s)
    while i < j and not s[i].isalnum():
        i += 1
    while j > i and not s[j - 1].isalnum():
        j -= 1
    return s[i:j]


def _split_any(s: str, delimiters: str) -> list[str]:
    """Split `s` on any character in `delimiters` — mirrors Rust's
    `str::split([...])` over a char pattern: consecutive delimiters (and a
    leading/trailing delimiter, or an empty input) yield empty strings in the
    result rather than being collapsed.
    """
    delim_set = set(delimiters)
    parts: list[str] = []
    current: list[str] = []
    for ch in s:
        if ch in delim_set:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


# Credit lines match anywhere in the segment.
_CREDIT_MARKS: tuple[str, ...] = (
    "amara.org",
    "subtitles by",
    "captioned by",
    "субтитры",
    "продолжение следует",
    "untertitel",
    "sous-titres",
    "כתוביות",
)

# Stock phrases must BE the sentence (every sentence of the segment).
_STOCK: tuple[str, ...] = (
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
)


def is_stock_hallucination(text: str) -> bool:
    """The classic Whisper hallucinations: phrases the model emits from noise,
    music, or unintelligible speech, in whatever language it drifted into —
    "Thank you." and its cousins, and subtitle/credit lines learned from
    YouTube captions. Only ever consulted TOGETHER with low decode
    confidence: a real spoken "thank you" scores far higher and stays.
    """
    lower = text.lower()
    if any(mark in lower for mark in _CREDIT_MARKS):
        return True

    any_sentence = False
    for sentence in _split_any(lower, ".!?,"):
        t = _trim_non_alnum(sentence.strip())
        if not t:
            continue
        any_sentence = True
        if t not in _STOCK:
            return False
    return any_sentence


def merge_token_words(
    pieces: list[tuple[bytes, int, int]],
) -> list[tuple[str, int, int]]:
    """Assemble (word, t0, t1) triples from raw token pieces of one segment.

    Whisper's BPE freely splits a multi-byte UTF-8 character across two
    tokens (routine in Hebrew/CJK), so decoding per TOKEN yields U+FFFD
    halves. Words must be joined as bytes and decoded per WORD: a piece whose
    bytes begin with a literal space byte opens a new word, and BPE never
    splits a character across a space boundary, so each completed word's
    bytes are whole characters. Timing is first-piece t0 / last-piece t1 per
    word.

    `pieces` are `(raw_utf8_bytes, t0_centiseconds, t1_centiseconds)` per
    whisper TOKEN (not word).
    """
    words: list[list] = []  # each entry: [bytearray, t0, t1]
    for raw_bytes, t0, t1 in pieces:
        _append_token_piece(words, raw_bytes, t0, t1)
    return _decoded_token_words(words)


def _append_token_piece(words: list[list], raw_bytes: bytes, t0: int, t1: int) -> None:
    remaining = _without_trailing_newlines(raw_bytes)
    if _starts_new_token_word(raw_bytes, words):
        words.append([bytearray(remaining), t0, t1])
        return
    last = words[-1]
    last[0].extend(remaining)
    last[2] = t1


def _without_trailing_newlines(raw_bytes: bytes) -> bytes:
    remaining = raw_bytes
    while remaining.endswith(b"\n"):
        remaining = remaining[:-1]
    return remaining


def _starts_new_token_word(raw_bytes: bytes, words: list[list]) -> bool:
    # Check the ORIGINAL bytes, not the newline-trimmed version. This mirrors
    # Rust's `bytes.first()` for newline-only pieces too.
    return raw_bytes[:1] == b" " or not words


def _decoded_token_words(words: list[list]) -> list[tuple[str, int, int]]:

    result: list[tuple[str, int, int]] = []
    for buf, t0, t1 in words:
        # errors="replace" mirrors Rust's from_utf8_lossy fallback on invalid
        # sequences — never raise here.
        w = bytes(buf).decode("utf-8", errors="replace").strip()
        if w:
            result.append((w, t0, t1))
    return result
