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
    if not num:
        return None
    digits = num[1:] if num[0] == "-" else num
    if not digits or not digits.isdigit():
        return None
    n = int(num)
    return n if _I64_MIN <= n <= _I64_MAX else None


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
    if not s or s == "+":
        return None
    digits = s[1:] if s[0] == "+" else s
    if not digits or any(c not in _HEX_DIGITS for c in digits):
        return None
    return int(digits, 16)


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
        p = cur.peek()
        if p == "\\":
            cur.next()
            q = cur.peek()
            if q is None:
                return
            if q == "'":
                cur.next()  # the quote
                cur.next()  # hex digit 1 (may be None at EOF; harmless)
                cur.next()  # hex digit 2
            elif not _is_ascii_alpha(q):
                cur.next()
            else:
                # A whole control word: name, then digits/'-', then one
                # optional delimiter space.
                while True:
                    r = cur.peek()
                    if r is not None and _is_ascii_alpha(r):
                        cur.next()
                    else:
                        break
                while True:
                    r = cur.peek()
                    if r is not None and (_is_ascii_digit(r) or r == "-"):
                        cur.next()
                    else:
                        break
                if cur.peek() == " ":
                    cur.next()
        elif p is None or p in ("{", "}"):
            return
        else:
            cur.next()


def extract_rtf(rtf: str) -> str | None:
    """Plain text out of an RTF document, or `None` if the result is blank
    (whitespace-only or empty) once every control structure is stripped.
    """
    cur = _Cursor(rtf)
    out: list[str] = []
    depth = 0
    # Depth of the group currently being skipped, if any. `None` means "not
    # currently inside a skipped group".
    skipping: int | None = None
    # `\ansicpg N` -- the code page `\'xx` bytes are written in. Absent
    # means the `\ansi` default, 1252. Anything else is left as a space
    # rather than guessed at: the wrong letters would be worse in the
    # index than a gap.
    codepage = 1252
    # `\ucN` -- how many characters of ANSI fallback follow each `\uN`
    # escape for readers that can't do Unicode. Default 1 per the spec.
    uc = 1

    while True:
        c = cur.next()
        if c is None:
            break

        if c == "{":
            depth += 1
            continue

        if c == "}":
            # Only OUR OWN depth being closed clears the skip flag -- a
            # nested group closing (while already skipping a shallower
            # one) must not accidentally un-skip early.
            if skipping == depth:
                skipping = None
            depth = max(depth - 1, 0)
            continue

        if c == "\\":
            nxt = cur.peek()
            if nxt is None:
                # A lone trailing backslash with nothing after it.
                break

            if nxt == "'":
                cur.next()
                hex_chars: list[str] = []
                for _ in range(2):
                    h = cur.next()
                    if h is None:
                        break
                    hex_chars.append(h)
                b = _parse_hex_byte("".join(hex_chars))
                if b is not None and skipping is None:
                    if b < 0x80:
                        decoded: str | None = chr(b)
                    elif codepage == 1252:
                        decoded = _cp1252_char(b)
                    else:
                        decoded = None
                    # A space still keeps the word boundary for a code
                    # page we can't decode.
                    out.append(decoded if decoded is not None else " ")
                continue

            if not _is_ascii_alpha(nxt):
                # An escaped literal: \\ \{ \} and friends -- only those
                # three specific characters are ever emitted.
                cur.next()
                if skipping is None and nxt in ("\\", "{", "}"):
                    out.append(nxt)
                continue

            word_chars: list[str] = []
            while True:
                p = cur.peek()
                if p is not None and _is_ascii_alpha(p):
                    cur.next()
                    word_chars.append(p)
                else:
                    break
            word = "".join(word_chars)

            # A numeric parameter, then one optional space delimiter.
            num_chars: list[str] = []
            while True:
                p = cur.peek()
                if p is not None and (_is_ascii_digit(p) or p == "-"):
                    cur.next()
                    num_chars.append(p)
                else:
                    break
            num = "".join(num_chars)
            if cur.peek() == " ":
                cur.next()

            if word == "ansicpg":
                parsed = _parse_unsigned(num, _U32_MAX)
                codepage = parsed if parsed is not None else 1252
                continue

            if word == "uc":
                # Clamped: real documents use 0, 1 or 2, and a crafted
                # oversized count would otherwise swallow the rest of a
                # group.
                parsed = _parse_unsigned(num, _USIZE_MAX)
                uc = min(parsed if parsed is not None else 1, 16)
                continue

            if word == "u":
                # The fallback characters are swallowed whether or not we
                # are inside a skipped group -- they are not text.
                _skip_rtf_fallback(cur, uc)
                if skipping is None:
                    n = _parse_i64(num)
                    if n is not None:
                        # A negative parameter is the code unit written as
                        # a signed 16-bit integer.
                        cp = n + 65536 if n < 0 else n
                        ch = _rtf_u_char(cp)
                        if ch is not None:
                            out.append(ch)
                continue

            if skipping is not None:
                continue
            if word in _SKIP_GROUPS:
                skipping = depth
            elif word in _BREAK_WORDS:
                out.append("\n")
            elif word == "tab":
                out.append(" ")
            # Every other unrecognized control word: no output, no state
            # change.
            continue

        if c in ("\r", "\n"):
            # A literal line ending in the raw RTF source itself is always
            # dropped, regardless of skip state.
            continue

        if skipping is None:
            out.append(c)

    result = "".join(out)
    return result if result.strip() else None
