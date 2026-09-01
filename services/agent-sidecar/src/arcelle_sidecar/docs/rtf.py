"""Plain text out of an `.rtf` document.

Port of `extract_rtf` and `skip_rtf_fallback` in `src-tauri/src/extraction.rs`
(lines 576-730), plus this module's own copy of `cp1252_char` from the same
file (lines 550-564) -- kept LOCAL rather than shared, matching the
precedent `docs/legacy.py` already set for its own copy of the same table:
there is no shared Rust-equivalent module on the Python side, so each port
that needs the table carries its own.

RTF is ASCII text with backslash control words, `\\'xx` hex escapes and
brace-delimited groups. Groups whose control word marks them as metadata
(font/colour tables, the stylesheet, document info, embedded
pictures/objects, generator signature, ...) are skipped WHOLE -- otherwise
their font names would land in the search index and the model's context as
prose.

Both non-ASCII text encodings RTF supports -- the `\\'xx` hex byte escape
and the `\\uN` Unicode code-point escape -- are decoded rather than turned
into a space, and that is load-bearing: a reader that turns every
non-ASCII escape into a space reads "Le si\\'e8ge social" as
"Le si ge social" -- the word split in two by a gap that was never in the
original document.

This is a character-by-character state machine, not a regex or a grammar
parser -- ported here as a manual walk over the string's Unicode code
points via `_Cursor`, standing in for Rust's `Peekable<Chars<'_>>` (the
same object is threaded into `_skip_rtf_fallback`, which must consume from
the exact same position the caller's walk is at).
"""

from __future__ import annotations

from collections.abc import Callable

# ------------------------------------------------------------------ cp1252

# Windows-1252 -- the code page `\ansi` RTF means by default, and the one
# Word and TextEdit actually write. 0x00-0x7F is ASCII and 0xA0-0xFF is
# Latin-1 (so the byte IS the code point); only 0x80-0x9F differ, and five
# of those are undefined (0 here means "no character").
#
# This module's OWN copy of `extraction.rs`'s `cp1252_char` 32-entry table
# (lines 550-564) -- NOT imported from `docs/legacy.py`, which keeps an
# identical-in-substance copy for the same stated reason: this module is
# independent and there is nothing on the Python side to share it from.
_CP1252_HIGH: tuple[int, ...] = (
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
    0x2039, 0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013,
    0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
)


def _cp1252_char(b: int) -> str | None:
    if 0x80 <= b < 0xA0:
        code = _CP1252_HIGH[b - 0x80]
        return chr(code) if code != 0 else None
    return chr(b)


# --------------------------------------------------------------- the walk

# Control words whose ENTIRE group (until ITS OWN matching closing brace,
# not any group nested inside it) is metadata, never prose.
_SKIP_GROUPS: frozenset[str] = frozenset(
    (
        "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata",
        "generator", "listtable", "listoverridetable", "rsidtbl", "xmlnstbl", "datastore",
    )
)

# Control words that mark a paragraph/section/page break.
_BREAK_WORDS: frozenset[str] = frozenset(("par", "line", "pard", "sect", "page"))


def _is_ascii_alpha(c: str) -> bool:
    """`char::is_ascii_alphabetic()` -- ASCII only, unlike Python's own
    Unicode-aware `str.isalpha()`."""
    return ("a" <= c <= "z") or ("A" <= c <= "Z")


def _is_ascii_digit(c: str) -> bool:
    return "0" <= c <= "9"


class _Cursor:
    """A minimal `peek`/`next` wrapper over a string's code points -- the
    Python stand-in for Rust's `std::iter::Peekable<std::str::Chars>`,
    which both `extract_rtf` and `skip_rtf_fallback` share and advance in
    lockstep (the fallback consumer must pick up exactly where the main
    walk left off, and hand control back the same way).
    """

    __slots__ = ("_s", "_i", "_n")

    def __init__(self, s: str) -> None:
        self._s = s
        self._i = 0
        self._n = len(s)

    def peek(self) -> str | None:
        return self._s[self._i] if self._i < self._n else None

    def next(self) -> str | None:
        if self._i >= self._n:
            return None
        c = self._s[self._i]
        self._i += 1
        return c


# ---------------------------------------------------------- numeric parsing
#
# The numeric-parameter capture (in the main walk, below) only ever collects
# ASCII digits and an optional '-' in any position -- exactly the alphabet
# Rust's own unsigned/signed integer `FromStr` impls accept for their
# respective types -- so validating against that same alphabet here (rather
# than trusting Python's looser `int()`) keeps a malformed parameter (a '-'
# not in leading position, an empty capture, a magnitude past the target
# type's range) failing to parse in both languages alike.

_U32_MAX = (1 << 32) - 1
_USIZE_MAX = (1 << 64) - 1  # `usize` on the 64-bit Mac target == u64.
_I64_MIN = -(1 << 63)
_I64_MAX = (1 << 63) - 1


def _parse_unsigned(num: str, max_value: int) -> int | None:
    """Mirrors Rust's unsigned integer `FromStr` (`u32`, `usize`) as used
    for `\\ansicpgN` / `\\ucN`: digits only, no sign at all -- a captured
    parameter containing '-' (only a *negative* `\\u` parameter ever puts
    one there) fails to parse as an unsigned integer, exactly as it would
    in Rust.
    """
    if not num or not num.isdigit():
        return None
    n = int(num)
    return n if n <= max_value else None


def _parse_i64(num: str) -> int | None:
    """Mirrors Rust's `i64::from_str`, used for `\\uN`'s parameter: an
    optional single LEADING '-', then one or more digits, and nothing else
    -- so a capture like `12-34` (the digit-loop's grammar allows '-' in any
    position, not just first) fails to parse here exactly as
    `"12-34".parse::<i64>()` errors in Rust.
    """
    digits = _signed_digits(num)
    if digits is None or not digits.isdigit():
        return None
    n = int(num)
    return n if _I64_MIN <= n <= _I64_MAX else None


def _signed_digits(num: str) -> str | None:
    if not num:
        return None
    return num[1:] if num[0] == "-" else num


_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def _parse_hex_byte(s: str) -> int | None:
    """Mirrors `u8::from_str_radix(s, 16)` for a `\\'xx` hex escape.

    Verified empirically against `rustc` (`u8` is unsigned, so its integer
    parser strips a single LEADING '+' unconditionally but never strips a
    '-' -- that branch is guarded on the type being signed): `"+8"` parses
    to `8`, but `"-8"`, `" 8"` (or any embedded whitespace) and a bare
    `"+"` all fail. A naive `int(s, 16)` would get every one of those
    wrong -- Python's `int()` accepts a leading `-`, strips surrounding
    whitespace, and would even hand back a *negative* int for `"-8"`
    (crashing the caller's `chr()`).
    """
    digits = _unsigned_hex_digits(s)
    if digits is None:
        return None
    if any(c not in _HEX_DIGITS for c in digits):
        return None
    return int(digits, 16)


def _unsigned_hex_digits(s: str) -> str | None:
    if not s or s == "+":
        return None
    return s[1:] if s[0] == "+" else s


def _rtf_u_char(cp: int) -> str | None:
    """Mirrors `u32::try_from(cp).ok().and_then(char::from_u32)`: `cp` must
    fit an unsigned 32-bit integer, and then be a valid Unicode scalar value
    (<= U+10FFFF, excluding the surrogate range U+D800-U+DFFF that Rust's
    `char` can never hold but a raw Python `str` index technically could).
    """
    if cp < 0 or cp > 0xFFFFFFFF:
        return None
    if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
        return None
    return chr(cp)


def _skip_rtf_fallback(cur: _Cursor, count: int) -> None:
    """Consume the `count` characters of ANSI fallback text that follow a
    `\\uN` escape (for readers that can't do Unicode) -- swallowed whether
    or not the escape sits inside a currently-skipped group, since fallback
    text is never document prose either way.

    Per fallback "character": a `\\'xx` hex escape or a whole control word
    each count as exactly ONE, a single non-alphabetic escape (`\\~`, `\\_`,
    ...) also counts as ONE, and a bare literal character counts as ONE too
    -- a group-boundary brace (or running out of input) ends the run EARLY,
    however many are still owed, leaving the brace itself for the caller.
    """
    for _ in range(count):
        if _fallback_ends_here(cur):
            return
        _skip_one_fallback_character(cur)


def _fallback_ends_here(cur: _Cursor) -> bool:
    p = cur.peek()
    return p is None or p in ("{", "}")


def _skip_one_fallback_character(cur: _Cursor) -> None:
    if cur.peek() != "\\":
        cur.next()
        return
    cur.next()
    _skip_fallback_escape(cur)


def _skip_fallback_escape(cur: _Cursor) -> None:
    q = cur.peek()
    if q is None:
        return
    if q == "'":
        _skip_fallback_hex_escape(cur)
        return
    if _is_ascii_alpha(q):
        _skip_fallback_control_word(cur)
        return
    cur.next()


def _skip_fallback_hex_escape(cur: _Cursor) -> None:
    cur.next()  # the quote
    cur.next()  # hex digit 1 (may be None at EOF; harmless)
    cur.next()  # hex digit 2


def _skip_fallback_control_word(cur: _Cursor) -> None:
    _consume_while(cur, _is_ascii_alpha)
    _consume_while(cur, _is_control_parameter_character)
    if cur.peek() == " ":
        cur.next()


def _is_control_parameter_character(c: str) -> bool:
    return _is_ascii_digit(c) or c == "-"


def _consume_while(cur: _Cursor, accepts: Callable[[str], bool]) -> None:
    while (c := cur.peek()) is not None and accepts(c):
        cur.next()


class _RtfExtractor:
    """The stateful walk behind :func:`extract_rtf`."""

    def __init__(self, rtf: str) -> None:
        self.cur = _Cursor(rtf)
        self.out: list[str] = []
        self.depth = 0
        self.skipping: int | None = None
        self.codepage = 1252
        self.uc = 1

    def extract(self) -> str | None:
        while (c := self.cur.next()) is not None:
            self._consume(c)
        result = "".join(self.out)
        return result if result.strip() else None

    def _consume(self, c: str) -> None:
        if c == "{":
            self.depth += 1
            return
        if c == "}":
            self._close_group()
            return
        if c == "\\":
            self._consume_escape()
            return
        self._consume_literal(c)

    def _consume_literal(self, c: str) -> None:
        if c in ("\r", "\n"):
            return
        if self.skipping is None:
            self.out.append(c)

    def _close_group(self) -> None:
        if self.skipping == self.depth:
            self.skipping = None
        self.depth = max(self.depth - 1, 0)

    def _consume_escape(self) -> None:
        nxt = self.cur.peek()
        if nxt is None:
            return
        if nxt == "'":
            self._consume_hex_escape()
            return
        if not _is_ascii_alpha(nxt):
            self._consume_symbol_escape(nxt)
            return
        word, num = self._read_control_word()
        self._consume_control_word(word, num)

    def _consume_hex_escape(self) -> None:
        self.cur.next()
        b = _parse_hex_byte(self._read_hex_characters())
        if b is None or self.skipping is not None:
            return
        self.out.append(self._decode_hex_byte(b))

    def _read_hex_characters(self) -> str:
        chars: list[str] = []
        for _ in range(2):
            char = self.cur.next()
            if char is None:
                break
            chars.append(char)
        return "".join(chars)

    def _decode_hex_byte(self, b: int) -> str:
        if b < 0x80:
            return chr(b)
        if self.codepage != 1252:
            return " "
        decoded = _cp1252_char(b)
        return decoded if decoded is not None else " "

    def _consume_symbol_escape(self, nxt: str) -> None:
        self.cur.next()
        if self.skipping is not None:
            return
        if nxt in ("\\", "{", "}"):
            self.out.append(nxt)

    def _read_control_word(self) -> tuple[str, str]:
        word = _read_while(self.cur, _is_ascii_alpha)
        num = _read_while(self.cur, _is_control_parameter_character)
        if self.cur.peek() == " ":
            self.cur.next()
        return word, num

    def _consume_control_word(self, word: str, num: str) -> None:
        if self._consume_encoding_setting(word, num):
            return
        if self._consume_unicode_escape(word, num):
            return
        self._consume_text_control_word(word)

    def _consume_encoding_setting(self, word: str, num: str) -> bool:
        if word == "ansicpg":
            parsed = _parse_unsigned(num, _U32_MAX)
            self.codepage = parsed if parsed is not None else 1252
            return True
        if word == "uc":
            parsed = _parse_unsigned(num, _USIZE_MAX)
            self.uc = min(parsed if parsed is not None else 1, 16)
            return True
        return False

    def _consume_unicode_escape(self, word: str, num: str) -> bool:
        if word != "u":
            return False
        _skip_rtf_fallback(self.cur, self.uc)
        if self.skipping is None:
            self._append_unicode_character(num)
        return True

    def _append_unicode_character(self, num: str) -> None:
        n = _parse_i64(num)
        if n is None:
            return
        cp = n + 65536 if n < 0 else n
        char = _rtf_u_char(cp)
        if char is not None:
            self.out.append(char)

    def _consume_text_control_word(self, word: str) -> None:
        if self.skipping is not None:
            return
        if word in _SKIP_GROUPS:
            self.skipping = self.depth
            return
        if word in _BREAK_WORDS:
            self.out.append("\n")
            return
        if word == "tab":
            self.out.append(" ")


def _read_while(cur: _Cursor, accepts: Callable[[str], bool]) -> str:
    chars: list[str] = []
    while (char := cur.peek()) is not None and accepts(char):
        cur.next()
        chars.append(char)
    return "".join(chars)


def extract_rtf(rtf: str) -> str | None:
    """Plain text out of an RTF document, or `None` if it has no prose."""
    return _RtfExtractor(rtf).extract()
