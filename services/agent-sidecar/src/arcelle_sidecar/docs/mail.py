"""Saved mail (.eml) text extraction: headers worth indexing plus the
readable body of a message.

Port of the mail section of `src-tauri/src/extraction/data.rs`
(`extract_eml`, `split_headers`, `unfold`, `header`, `eml_body_text`,
`mime_boundary`, `decode_transfer`, `decode_quoted_printable`,
`decode_base64_text`, `decode_mime_words`), plus a local copy of the
`push_capped`/`MAX_DERIVED_CHARS` bound from lines 1-35 of that file.

Handles the two transfer encodings that actually appear in saved mail
(quoted-printable and base64) and prefers the `text/plain` alternative of a
multipart message, falling back to stripping the HTML one. Without this an
.eml indexed as either nothing or as raw MIME -- base64 blobs and all.

Built on the FINAL sibling `arcelle_sidecar.docs.html` module's `strip_html`
rather than redefining it.

------------------------------------------------------------- Rust's `.lines()`

Several functions here process a header or body text line by line the way
Rust's `str::lines()` does: split on "\\n", and strip a trailing "\\r" from a
piece ONLY when that piece was actually terminated by a "\\n" (i.e. it is not
the last piece, or the input as a whole ended in "\\n"). A bare "\\r" that is
the very last byte of the input, with no following "\\n", is NOT a line
terminator in Rust and is left in place. This was confirmed directly against
`rustc` (not assumed from the docs): `"a\\r\\nb\\r".lines()` collects to
`["a", "b\\r"]` -- the trailing `\\r` on the unterminated last line survives.
A naive "strip a trailing \\r off every split piece" implementation gets this
last case wrong (see the module-level note below), which is why `_rust_lines`
tracks per-piece termination explicitly rather than stripping unconditionally.
`_rust_lines` is shared by `_unfold` (over the raw, possibly-CRLF header
block) and `_decode_quoted_printable` (whose soft-line-break detection
depends on a trailing "=" surviving with no leftover "\\r" attached to it).

`_header`, by contrast, only ever runs over the ALREADY-unfolded header block
(built by `_unfold`, which never leaves a stray "\\r" or a trailing "\\n" --
every line is `.strip()`/`.rstrip()`'d on the way in), so a plain
`str.split("\\n")` there is already equivalent to `_rust_lines` and is used
directly for simplicity.

----------------------------------------------------------------- merge note

This module was assembled by judging two independently written candidate
ports against each other and against `rustc` directly (not just against the
five ported unit tests, which both candidates' versions already passed).
Two real, confirmed divergences from the Rust source were found:

1. One candidate's `_rust_lines` stripped a trailing "\\r" from every split
   piece unconditionally, which silently drops the final "\\r" in exactly
   the "a\\r\\nb\\r" -> should stay "b\\r" case above. Confirmed wrong against
   `rustc`; the surviving implementation here tracks per-piece termination
   instead.
2. One candidate's `_decode_base64_text` used `base64.b64decode(s,
   validate=False)`, which is more permissive than the Rust `base64` crate's
   `general_purpose::STANDARD` engine used by the source: e.g. the malformed
   input `"AB==CD=="` (padding embedded mid-string) is REJECTED by
   `STANDARD.decode` (confirmed by running the actual crate at the pinned
   Cargo.lock version, 0.22.1) but silently "decoded" by
   `b64decode(..., validate=False)` into a single garbage byte instead of
   falling back to the original text, as the spec requires on a decode
   failure. `validate=True` was confirmed (again against the real crate) to
   reject that case and several other malformed-padding cases the same way
   Rust does, so it is used here. Neither Python mode replicates the Rust
   engine's rejection of a technically-valid-length base64 group whose
   unused padding bits are non-zero ("non-canonical" padding, e.g. `"TR=="`)
   -- `binascii`/`base64` has no such check under any `validate=` setting.
   This is accepted as a narrow, stdlib-only limitation: real mail bodies are
   written by real encoders and never produce non-canonical padding, and
   reaching for a hand-rolled decoder to cover a case no real .eml will ever
   exercise would trade a one-line stdlib call for a chunk of bespoke bit-
   twiddling to satisfy a case nothing legitimate produces.
"""

from __future__ import annotations

from base64 import b64decode
from binascii import Error as _BinasciiError

from arcelle_sidecar.docs.html import strip_html

# Bound on how much text this reader contributes to the index -- same value
# and purpose as `extraction/data.rs`'s module-wide `MAX_DERIVED_CHARS`. This
# module owns its own copy rather than importing one from elsewhere, matching
# this codebase's established pattern for a bound that isn't genuinely shared
# yet.
_MAX_DERIVED_CHARS = 8 * 1024 * 1024

# 256-entry lookup: `_HEX_DIGITS[byte]` is that byte's value (0-15) if it is
# an ASCII hex digit ('0'-'9', 'a'-'f', 'A'-'F'), else `None`. Used by
# `_decode_quoted_printable` for a strict two-hex-digit check equivalent to
# Rust's `u8::from_str_radix(h, 16)` (which, unlike Python's lenient
# `int(s, 16)`, never accepts a leading sign).
_HEX_DIGITS: list[int | None] = [None] * 256
for _b in range(0x30, 0x3A):  # '0'-'9'
    _HEX_DIGITS[_b] = _b - 0x30
for _b in range(0x61, 0x67):  # 'a'-'f'
    _HEX_DIGITS[_b] = _b - 0x61 + 10
for _b in range(0x41, 0x47):  # 'A'-'F'
    _HEX_DIGITS[_b] = _b - 0x41 + 10
del _b


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


def _push_capped(out: list[str], s: str, total_len: list[int]) -> None:
    """Append `s` to `out`, capping the running UTF-8 byte total at
    `_MAX_DERIVED_CHARS`. An addition that would cross the cap is trimmed at
    the last whole UTF-8 character rather than included partially or
    raising -- mirrors the Rust source's `is_char_boundary` walk-back, done
    here over UTF-8 bytes since Python strings are indexed by code point,
    not byte.

    `out` and `total_len` are one-element-list "out params" so this stays a
    small local helper (this module owns its own copy, matching the
    established pattern in this codebase of not sharing anything not
    genuinely shared elsewhere yet) without needing a class.
    """
    room = _MAX_DERIVED_CHARS - total_len[0]
    if room <= 0:
        return
    encoded = s.encode("utf-8")
    if len(encoded) <= room:
        out.append(s)
        total_len[0] += len(encoded)
        return
    cut = room
    # Walk back to the start of a UTF-8 sequence: continuation bytes have
    # the top two bits `10`.
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    trimmed = encoded[:cut].decode("utf-8")
    out.append(trimmed)
    total_len[0] += len(trimmed.encode("utf-8"))


def extract_eml(raw: str) -> str | None:
    """Headers worth indexing plus the readable body of a saved message."""
    headers, body = _split_headers(raw)
    out: list[str] = []
    total_len = [0]
    for name in ("From", "To", "Cc", "Date", "Subject"):
        value = _header(headers, name)
        if value is not None:
            _push_capped(out, f"{name}: {value}\n", total_len)
    _push_capped(out, "\n", total_len)
    _push_capped(out, _eml_body_text(headers, body), total_len)
    result = "".join(out)
    return result if result.strip() else None


def _split_headers(raw: str) -> tuple[str, str]:
    """Split at the first blank line. A message with no body is still
    valid."""
    # Task spec calls for stripping ONE leading BOM (not the Rust source's
    # `trim_start_matches`, which would strip several in a row) -- a
    # deliberate, harmless simplification since a real message has at most
    # one.
    raw = raw.removeprefix("﻿")
    idx = raw.find("\r\n\r\n")
    if idx != -1:
        return _unfold(raw[:idx]), raw[idx + 4 :]
    idx = raw.find("\n\n")
    if idx != -1:
        return _unfold(raw[:idx]), raw[idx + 2 :]
    return _unfold(raw), ""


def _unfold(headers: str) -> str:
    """RFC 5322 folding: a header line continued on the next line by leading
    whitespace. Unfolded first so a wrapped Subject reads as one value."""
    out = ""
    for line in _rust_lines(headers):
        if line.startswith(" ") or line.startswith("\t"):
            out += " "
            out += line.strip()
        else:
            if out:
                out += "\n"
            out += line.rstrip()
    return out


def _header(headers: str, name: str) -> str | None:
    want = f"{name.lower()}:"
    for line in _rust_lines(headers):
        if line.lower().startswith(want):
            value = _decode_mime_words(line[len(want) :].strip())
            return value if value else None
    return None


def _eml_body_text(headers: str, body: str) -> str:
    """The body, decoded and -- for multipart -- reduced to its readable
    part."""
    content_type = (_header(headers, "Content-Type") or "").lower()
    boundary = _mime_boundary(content_type)
    if boundary is not None:
        html_fallback = ""
        for part in body.split(f"--{boundary}")[1:]:
            # `trim_start_matches("--")` strips the pattern repeatedly, not
            # just once (matters for the trailing `--{boundary}--` close
            # delimiter's piece, which can start with more than one pair).
            while part.startswith("--"):
                part = part[2:]
            if not part.strip():
                continue
            part_headers, part_body = _split_headers(part)
            part_type = (_header(part_headers, "Content-Type") or "").lower()
            # Nested multipart (the common multipart/mixed -> multipart/alternative
            # shape) recurses rather than being skipped as an unknown part.
            if part_type.startswith("multipart/"):
                nested = _eml_body_text(part_headers, part_body)
                if nested.strip():
                    return nested
                continue
            decoded = _decode_transfer(part_headers, part_body)
            if part_type.startswith("text/plain"):
                return decoded
            if part_type.startswith("text/html") and not html_fallback:
                html_fallback = strip_html(decoded)
        return html_fallback
    decoded = _decode_transfer(headers, body)
    if content_type.startswith("text/html"):
        return strip_html(decoded)
    return decoded


def _mime_boundary(content_type: str) -> str | None:
    if not content_type.startswith("multipart/"):
        return None
    key = "boundary="
    at = content_type.find(key)
    if at == -1:
        return None
    rest = content_type[at + len(key) :].strip()
    if rest.startswith('"'):
        value = rest[1:].split('"', 1)[0]
    else:
        # Match against every separator simultaneously, like Rust's
        # `split(&[';', ' ', '\r', '\n'][..])`, not one at a time in a fixed
        # order (which would understate the cut if a later separator in
        # this list actually appears earlier in the string).
        value = rest
        first: int | None = None
        for sep in (";", " ", "\r", "\n"):
            i = value.find(sep)
            if i != -1 and (first is None or i < first):
                first = i
        if first is not None:
            value = value[:first]
    return value if value else None


def _decode_transfer(headers: str, body: str) -> str:
    encoding = (_header(headers, "Content-Transfer-Encoding") or "").strip().lower()
    if encoding == "quoted-printable":
        return _decode_quoted_printable(body)
    if encoding == "base64":
        return _decode_base64_text(body)
    return body


def _decode_quoted_printable(s: str) -> str:
    """`=XX` hex escapes and `=` soft line breaks. Bytes are collected first
    and decoded as UTF-8 at the end, so a multi-byte character split across
    two escapes (by a soft break) survives."""
    out = bytearray()
    lines = _rust_lines(s)
    last_index = len(lines) - 1
    for idx, line in enumerate(lines):
        if line.endswith("="):
            content = line[:-1]
            soft_break = True
        else:
            content = line
            soft_break = False
        raw = content.encode("utf-8")
        i = 0
        n = len(raw)
        while i < n:
            if raw[i] == 0x3D and i + 2 < n:  # b'='
                hi, lo = _HEX_DIGITS[raw[i + 1]], _HEX_DIGITS[raw[i + 2]]
                if hi is not None and lo is not None:
                    out.append((hi << 4) | lo)
                    i += 3
                    continue
            out.append(raw[i])
            i += 1
        if not soft_break and idx != last_index:
            out.append(0x0A)  # b'\n'
    return out.decode("utf-8", errors="replace")


def _decode_base64_text(s: str) -> str:
    packed = "".join(c for c in s if not c.isspace())
    try:
        decoded = b64decode(packed, validate=True)
    except (_BinasciiError, ValueError):
        return s
    return decoded.decode("utf-8", errors="replace")


def _decode_mime_words(value: str) -> str:
    """RFC 2047 `=?utf-8?B?...?=` / `=?utf-8?Q?...?=` encoded words, which is
    how a non-ASCII Subject or display name reaches the file.

    Two things kept deliberately faithful to the Rust source rather than
    "fixed" to a plain-English reading of what it's obviously trying to do:

    * When "=?" is found but no matching "?=" ever follows, Rust's `rest`
      binding is left un-advanced before the `break`, so the final
      `out.push_str(rest)` after the loop re-appends the text before "=?" a
      second time (it was already pushed earlier in that same iteration).
      Confirmed against `rustc` directly (not inferred from reading the
      source): `decode_mime_words("hello =?utf-8?B?abc")` produces
      `"hello hello =?utf-8?B?abc"`, with "hello " duplicated. Reproduced
      here rather than de-duplicated, since a faithful port matches the
      implementation, not the guessed intent.
    * The Rust source reads a `charset` out of the encoded word but never
      actually uses it to pick a decoder -- both arms of its
      `if charset.starts_with(...) { .. } else { .. }` push the identical
      `decoded` value. That branch is dead code and is dropped here (no
      `if`/`else` on charset at all), which changes nothing observable.
    """
    out: list[str] = []
    rest = value
    while True:
        start = rest.find("=?")
        if start == -1:
            break
        out.append(rest[:start])
        after = rest[start + 2 :]
        end = after.find("?=")
        if end == -1:
            # `rest` (the full, un-advanced remainder -- including the
            # prefix just appended above) is what gets appended after the
            # loop below; see the docstring note on this duplication.
            break
        word = after[:end]
        parts = word.split("?", 2)
        if len(parts) == 3:
            encoding = parts[1].upper()
            if encoding == "B":
                decoded = _decode_base64_text(parts[2])
            elif encoding == "Q":
                # In an encoded word, `_` means space.
                decoded = _decode_quoted_printable(parts[2].replace("_", " "))
            else:
                decoded = word
            out.append(decoded)
        else:
            out.append(word)
        rest = after[end + 2 :]
    out.append(rest)
    return "".join(out).strip()
