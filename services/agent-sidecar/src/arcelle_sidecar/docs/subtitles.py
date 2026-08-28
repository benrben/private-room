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
    n = len(parts)
    lines: list[str] = []
    for i, piece in enumerate(parts):
        terminated_by_newline = i < n - 1 or ends_with_newline
        if terminated_by_newline and piece.endswith("\r"):
            piece = piece[:-1]
        lines.append(piece)
    return lines


def extract_subtitles(raw: str) -> str | None:
    """The spoken text of a subtitle file, without cue numbers or
    timestamps."""
    out: list[str] = []
    for line in _rust_lines(raw):
        line = line.strip()
        if (
            line == ""
            or line == "WEBVTT"
            or "-->" in line
            or line.startswith("NOTE ")
            or line.startswith("STYLE")
            # A bare cue number ("42") carries nothing. Checked against the
            # ASCII digit set specifically (not `str.isdigit()`, which is
            # also true for non-ASCII digit characters Rust's
            # `is_ascii_digit()` would reject), and only ever reached on a
            # non-empty `line` since the `line == ""` check above already
            # short-circuits the empty case -- `all()` over an empty
            # string would otherwise vacuously read as "all digits" too.
            or all(c in _ASCII_DIGITS for c in line)
        ):
            continue
        out.append(line)
        out.append("\n")
    result = "".join(out)
    return result if result.strip() else None
