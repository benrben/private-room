"""Subtitle (.srt / .vtt) text extraction: the spoken lines of a subtitle
file, without cue numbers or timestamps.

Port of the subtitle section of `src-tauri/src/extraction/data.rs`
(`extract_subtitles`, lines 299-324).

Indexing the raw file made every search for a phrase compete with a wall of
`00:01:23,456 --> 00:01:25,780`, and a model reading a transcript got timing
noise between every line. This strips cue numbers, arrow timestamps, and the
WebVTT `WEBVTT` / `NOTE ...` / `STYLE` lines, leaving only the words that were
actually spoken.

Deliberately NOT ported here: `push_capped`'s `MAX_DERIVED_CHARS` (8 MiB)
cap that the Rust source applies via a shared module-level helper. The task
this module was ported from scoped `extract_subtitles` on its own terms
(join surviving lines, return `None` if blank) with no mention of the cap,
and a subtitle file large enough to hit an 8 MiB derived-text ceiling is not
a case this port needs to defend against on its own -- see the sibling
`arcelle_sidecar.docs.mail` module for a from-scratch reimplementation of
that cap where it *was* in scope. If the cap is later judged to be needed
here too, it should probably graduate to one real shared helper instead of
being copy-pasted a third time.
"""

from __future__ import annotations

_ASCII_DIGITS = frozenset("0123456789")
_SUBTITLE_METADATA_PREFIXES = ("NOTE ", "STYLE")


def _rust_lines(s: str) -> list[str]:
    """Faithful port of Rust's `str::lines()`.

    Splits on `'\\n'`, and strips a trailing `'\\r'` from a piece only when
    that piece was actually terminated by a `'\\n'` -- i.e. it is not the
    last piece, or the whole input ended in `'\\n'`. Deliberately NOT
    Python's `str.splitlines()` (also breaks on a bare `'\\r'` and several
    Unicode line separators Rust's `lines()` ignores) and NOT plain
    `str.split("\\n")` (leaves a stray `'\\r'` attached and yields a phantom
    trailing `""` for input ending in `'\\n'`). Confirmed against `rustc`
    directly: `"a\\r\\nb\\r".lines()` == `["a", "b\\r"]`.
    """
    if s == "":
        return []
    parts = s.split("\n")
    ends_with_newline = s.endswith("\n")
    if ends_with_newline:
        parts = parts[:-1]
    return [
        _without_terminated_carriage_return(
            piece,
            index < len(parts) - 1 or ends_with_newline,
        )
        for index, piece in enumerate(parts)
    ]


def _without_terminated_carriage_return(piece: str, terminated_by_newline: bool) -> str:
    """Strip the CR belonging to a newline terminator, but never a final bare CR."""
    if terminated_by_newline:
        return piece.removesuffix("\r")
    return piece


def _is_subtitle_metadata(line: str) -> bool:
    """Whether a trimmed line is a non-spoken subtitle record."""
    return (
        line in ("", "WEBVTT")
        or "-->" in line
        or line.startswith(_SUBTITLE_METADATA_PREFIXES)
    )


def _is_bare_cue_number(line: str) -> bool:
    """Whether a trimmed line is an ASCII-only cue number."""
    return bool(line) and all(character in _ASCII_DIGITS for character in line)


def _is_discarded_subtitle_line(line: str) -> bool:
    """Whether a trimmed line carries no spoken subtitle text."""
    return _is_subtitle_metadata(line) or _is_bare_cue_number(line)


def extract_subtitles(raw: str) -> str | None:
    """The spoken text of a subtitle file, without cue numbers or timestamps."""
    out: list[str] = []
    for raw_line in _rust_lines(raw):
        line = raw_line.strip()
        if _is_discarded_subtitle_line(line):
            continue
        out.extend((line, "\n"))
    result = "".join(out)
    return result if result.strip() else None
