"""Byte-exact text filtering, windowing, and result cleanup for summaries."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

# --- constants (verbatim from summarize.rs / extraction/window.rs) ----------

#: ADD-27: extra reads the model may request per file (summarize.rs MAX_READS).
MAX_READS: int = 4

#: extraction/window.rs — the default/min/max for ONE read window (bytes).
READ_WINDOW_DEFAULT: int = 4_000
READ_WINDOW_MIN: int = 200
READ_WINDOW_MAX: int = 64_000


# --- text windowing (ported from extraction/window.rs, BYTE-exact) ----------
#
# Rust slices the file's extracted text on BYTE offsets (snapped to char
# boundaries), and the char-budget arithmetic counts bytes. To keep a Hebrew or
# other multi-byte file summarized identically, we operate on the UTF-8 bytes and
# report the same byte offsets Rust would.


@dataclass(slots=True)
class TextWindow:
    """One window of a file's text. Offsets are BYTE positions into the filtered
    text, always on char boundaries so decoding can never fail."""

    text: str
    offset: int
    end: int
    total: int
    found: bool

    @property
    def nbytes(self) -> int:
        """UTF-8 byte length of ``text`` (== end - offset); the budget unit."""
        return self.end - self.offset


def _floor_char_boundary(data: bytes, i: int) -> int:
    # Rust is_char_boundary(len) is True, so position len (and 0) is a boundary —
    # only step back off an interior continuation byte (0b10xxxxxx).
    i = min(i, len(data))
    while 0 < i < len(data) and (data[i] & 0xC0) == 0x80:
        i -= 1
    return i


def _ceil_char_boundary(data: bytes, i: int) -> int:
    i = min(i, len(data))
    while i < len(data) and (data[i] & 0xC0) == 0x80:
        i += 1
    return i


def _line_has_minimum_bytes(line: str) -> bool:
    # Rust line.len() is measured in UTF-8 bytes.
    return len(line.encode("utf-8")) >= 40


def _is_wordish_character(character: str, allowed: set[str]) -> bool:
    return character.isalnum() or character.isspace() or character in allowed


def _is_mostly_symbols(line: str) -> bool:
    # Rust chars().count() is Unicode character count, not byte count.
    total = max(len(line), 1)
    allowed = set(".,;:!?'\"()-/&%$€@")
    wordish = sum(_is_wordish_character(character, allowed) for character in line)
    return wordish / total < 0.7


def _has_unbroken_long_word(line: str) -> bool:
    # Rust w.len() is measured in UTF-8 bytes.
    return any(len(word.encode("utf-8")) > 80 for word in line.split())


def _looks_like_noise(line: str) -> bool:
    """window.rs ``looks_like_noise``: a long line that is mostly symbols, or holds
    an unbroken 80+ char run (base64/hex/minified), is junk for a summary."""
    if not _line_has_minimum_bytes(line):
        return False
    return _is_mostly_symbols(line) or _has_unbroken_long_word(line)


def _filter_input_lines(text: str) -> list[str]:
    # Rust iterates str::lines(): split on '\n' but WITHOUT the trailing empty
    # segment a final newline would produce (a trailing '\r' is stripped by the
    # per-line rstrip below, matching Rust's trim_end()).
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _filter_line(
    out: list[str], line: str, prev_line: str, blank_run: int
) -> tuple[str, int]:
    trimmed = line.rstrip()
    if not trimmed.strip():
        blank_run += 1
        if blank_run == 1:
            out.append("")
        return prev_line, blank_run
    if trimmed == prev_line or _looks_like_noise(trimmed):
        return prev_line, 0
    out.append(trimmed)
    return trimmed, 0


def _filtered_text(out: list[str]) -> str:
    # Rust pushes each kept line + '\n' and a single '\n' per blank run, so the
    # result always ends with a trailing newline after the last non-blank line.
    return "".join(line + "\n" if line != "" else "\n" for line in out)


def smart_filter(text: str) -> str:
    """window.rs ``smart_filter``: drop the low-signal lines a big extraction is
    full of (binary/base64 junk, repeated boilerplate, blank runs). Conservative:
    prose, code and tables pass through untouched."""
    out: list[str] = []
    prev_line = ""
    blank_run = 0
    for line in _filter_input_lines(text):
        prev_line, blank_run = _filter_line(out, line, prev_line, blank_run)
    return _filtered_text(out)


def read_window(data: bytes, offset: int, limit: int, find: str | None) -> TextWindow:
    """window.rs ``read_window``: cut one window out of the filtered text bytes.

    ``limit`` is clamped to [MIN, MAX]. ``find`` (trimmed, non-empty) jumps to the
    first ASCII-case-insensitive occurrence at-or-after ``offset``, starting ~200
    bytes early for context; a miss leaves the window at ``offset`` with
    ``found=False`` so the model learns it missed.
    """
    total = len(data)
    limit = max(READ_WINDOW_MIN, min(limit, READ_WINDOW_MAX))
    start = _floor_char_boundary(data, min(offset, total))
    found = False
    needle = (find or "").strip()
    if needle:
        # bytes.lower() lowercases only ASCII, leaving other bytes (and therefore
        # every byte offset) exact — same as Rust to_ascii_lowercase.
        hay = data[start:].lower()
        pos = hay.find(needle.encode("utf-8").lower())
        if pos != -1:
            start = _floor_char_boundary(data, max(0, start + pos - 200))
            found = True
    end = _ceil_char_boundary(data, min(start + limit, total))
    return TextWindow(
        text=data[start:end].decode("utf-8", "replace"),
        offset=start,
        end=end,
        total=total,
        found=found,
    )


# --- reply cleanup (ported from retrieval.rs / summarize.rs / ollama.rs) -----


def strip_markup_blocks(content: str) -> str:
    """retrieval.rs ``strip_markup_blocks``: remove fenced ```boxes / ```annotation
    UI-markup payloads (viewer data, not conversation text)."""
    out = content
    for tag in ("```boxes", "```annotation"):
        while (start := out.find(tag)) != -1:
            after = out[start + len(tag):]
            end = after.find("```")
            out = (out[:start] + after[end + 3:]) if end != -1 else out[:start]
            out = out.strip()
    return out


#: Ceiling for a file's one-line description (summarize.rs ``clean_one_liner``).
ONE_LINER_MAX: int = 200

#: A sentence terminator that really ENDS a sentence — followed by whitespace or
#: the end of the line, so a version number or "e.g." is not mistaken for one.
_SENTENCE_END = re.compile(r"[.!?](?=\s|$)")


def _first_nonempty_line(text: str) -> str:
    for candidate in text.split("\n"):
        line = candidate.strip()
        if line:
            return line
    return ""


def _clean_one_liner_source(raw: str) -> str:
    line = _first_nonempty_line(strip_markup_blocks(raw))
    return line.lstrip("-*#> ").strip()


def _last_usable_sentence_end(head: str) -> int | None:
    ends = [m.end() for m in _SENTENCE_END.finditer(head)]
    # Only take a sentence end that leaves at least half the budget behind —
    # otherwise a stray "1." near the start would truncate the whole description.
    if ends and ends[-1] >= ONE_LINER_MAX // 2:
        return ends[-1]
    return None


def _ellipsis_word_cut(head: str) -> str:
    cut = head.rfind(" ")
    kept = head[:cut] if cut > 0 else head[: ONE_LINER_MAX - 1]
    return kept.rstrip(" ,;:-") + "…"


def _shorten_one_liner(line: str) -> str:
    head = line[:ONE_LINER_MAX]
    sentence_end = _last_usable_sentence_end(head)
    if sentence_end is not None:
        return head[:sentence_end].strip()
    return _ellipsis_word_cut(head)


def clean_one_liner(raw: str) -> str:
    """summarize.rs ``clean_one_liner``: trim a reply down to one clean sentence —
    first non-empty line, list markers stripped, capped at ``ONE_LINER_MAX``.

    An over-long line is cut at the last SENTENCE end that still leaves a real
    description, else at a word boundary with an ellipsis marking the cut. This
    line is what the generated Room summary prints and what the assistant reads
    when it lists the room's files, so a hard slice at exactly 200 characters
    ended it mid-word with nothing showing it had been cut.
    """
    line = _clean_one_liner_source(raw)
    if len(line) <= ONE_LINER_MAX:
        return line
    return _shorten_one_liner(line)


def json_str_field(raw: str, key: str) -> str | None:
    """json.rs ``json_str_field``: the trimmed string at ``key`` of a JSON object,
    or None when the reply isn't JSON / isn't an object / has no string there."""
    try:
        obj = json.loads(raw.strip())
    except (ValueError, TypeError):
        return None
    if isinstance(obj, dict) and isinstance(obj.get(key), str):
        return obj[key].strip()
    return None


# --- the read_text tool + its argument parsing (summarize.rs) ---------------


def read_text_tool() -> list[dict[str, Any]]:
    """summarize.rs ``read_text_tool``: the one tool offered during the gather
    phase — a paged, filtered read over the file's OWN text."""
    return [
        {
            "type": "function",
            "function": {
                "name": "read_text",
                "description": (
                    "Read another part of this file's text. offset picks where to "
                    "start (0 = beginning), limit is how many characters to read "
                    "(200-6000), find jumps to the next place a word or phrase "
                    "appears at or after offset."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "offset": {"type": "integer", "description": "Character position to read from"},
                        "limit": {"type": "integer", "description": "How many characters to read"},
                        "find": {"type": "string", "description": "Optional word or phrase to jump to"},
                    },
                },
            },
        }
    ]


def _num(v: Any) -> int | None:
    """summarize.rs ``read_args::num``: a usize tolerating int/float/str, clamped
    at 0 (a negative float floors to 0, like ``f.max(0.0) as usize``)."""
    if isinstance(v, bool):  # bool is an int subclass — never a coordinate
        return None
    if isinstance(v, int):
        return max(0, v)
    if isinstance(v, float):
        return int(max(0.0, v))
    if isinstance(v, str):
        try:
            return int(v.strip())
        except ValueError:
            return None
    return None


def read_args(args: dict[str, Any]) -> tuple[int, int, str | None]:
    """summarize.rs ``read_args``: (offset, limit, find) out of a read_text call,
    tolerating numbers as strings/floats and a blank ``find``."""
    offset = _num(args.get("offset"))
    offset = offset if offset is not None else 0
    limit = _num(args.get("limit"))
    limit = limit if limit is not None else READ_WINDOW_DEFAULT
    find_raw = args.get("find")
    find = find_raw.strip() if isinstance(find_raw, str) and find_raw.strip() else None
    return offset, limit, find


# --- the model seam ---------------------------------------------------------
#
# One thin async class over the loopback Ollama server. Kept behind a Protocol so
# the orchestration is testable with a scripted fake — no network, no weights.
