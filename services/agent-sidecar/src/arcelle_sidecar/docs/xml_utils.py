"""Shared OOXML helpers -- zip-entry access with decompression-bomb guards,
and the tag/entity text primitives every Office reader (docx/pptx/xlsx) is
built on.

Port of `src-tauri/src/extraction.rs` (`zip_entry_names`, `read_zip_entry`,
`read_zip_entry_capped`, `xml_attr`, `strip_tags`, `xml_paras_to_text`,
`NAMED_ENTITIES`, `MAX_ENTITY_LEN`, `decode_basic_entities`,
`normalize_whitespace`) and `src-tauri/src/extraction/xlsx.rs`
(`zip_declared_size_within`, `zip_inflated_size_within`).

-------------------------------------------------------------- zip entries

`zipfile` (stdlib) replaces the Rust `zip` crate. Both guards from
`xlsx.rs` are ported even though this module is the *shared* helper layer
(not xlsx-specific) -- `read_zip_entry_capped` needs exactly the same
"declared size can lie" reasoning, and `zip_declared_size_within` /
`zip_inflated_size_within` are useful to every OOXML reader that wants a
pre-flight check before handing bytes to a heavier parser.

`zip_inflated_size_within` streams each entry through bounded `read(n)`
calls (never asking for more than `remaining + 1` bytes at a time) so a
bomb costs at most `cap + 1` bytes of decompression and O(1) memory before
being refused -- the direct Python analogue of the Rust version's
`entry.take(remaining + 1)` into a counting sink.

Every zip-reading function here catches broadly at the "can this even be
opened/read" boundary -- `zipfile.BadZipFile`/`OSError` for an archive that
won't open at all, plus `RuntimeError`/`NotImplementedError` for an
individual entry that opens but can't be decompressed (encrypted, or an
unsupported compression method). That second pair matters as much as the
first: an encrypted Office zip part is exactly the kind of malformed input
`extraction.rs`'s `contain_parser_panic` exists to survive, and `zipfile`
raises `RuntimeError` (not `BadZipFile`) for it -- a guard that only caught
`BadZipFile`/`OSError` would let that exception escape from what is
supposed to be a "return None for anything unreadable" helper. Rust's own
`ZipArchive::by_name(...).ok()?` collapses every one of these into `None`
uniformly, so this port does too.

------------------------------------------------------------- entity decode

`decode_basic_entities` is a single left-to-right pass over the original
string, exactly as in the Rust source, and deliberately NOT a chain of
`.str.replace()` calls: chaining makes decode order load-bearing (`&amp;`
must run last, or `&amp;lt;` decodes twice, all the way down to a bare `<`)
and cannot handle numeric references (`&#8212;`) at all. Scanning once
fixes both -- each `&...;` is resolved exactly once against the ORIGINAL
text, so double-decoding is structurally impossible.

`MAX_ENTITY_LEN` bounds how far past an `&` the scan looks for a `;` before
giving up and emitting the bare `&` verbatim -- long enough for every name
in `NAMED_ENTITIES` and a hex numeric reference, short enough that a bare
`&` in ordinary prose does not scan half a paragraph. The Rust source
measures this bound in UTF-8 BYTES (via `char_indices`), not characters;
`_entity_body_end` below replicates that exactly. This is provably
equivalent to a character-based bound for every string this function can
actually DECODE: a body that resolves to a named entity or a numeric
reference is always pure ASCII (the named-entity table and `0-9a-fA-X#`
are all single-byte), so for any body that ever matters its byte length
equals its character length; the byte/character distinction can only ever
affect where the scan gives up on a body that was never going to decode to
anything but its own literal text either way (verified against the real
Rust binary across ~850 generated cases mixing multi-byte filler with
embedded `&`/`;`, with zero output divergences).

`_parse_u32` mirrors `str::parse::<u32>()` / `u32::from_str_radix(_, 16)`
exactly, including the easy-to-miss detail (confirmed against a compiled
copy of the Rust function) that both accept one optional leading `+` --
`&#+64;` decodes in the Rust source -- but reject underscores and any
whitespace, which Python's own lenient `int(str, base)` would otherwise
silently accept (`int("1_000")` and `int(" 123 ")` both succeed in Python
and would decode entities the Rust source leaves untouched).
"""

from __future__ import annotations

import io
import zipfile

# ------------------------------------------------------------ zip entries

# Hard ceiling on the decompressed size of a single Office zip entry
# (document.xml, slideN.xml, ...). Real Office parts are a few MB at most;
# a tiny archive that inflates past this is a decompression bomb, not a doc.
MAX_ZIP_ENTRY_BYTES: int = 100 * 1024 * 1024

# Exceptions a corrupt/adversarial/encrypted zip can raise while we are only
# trying to read metadata or bounded bytes out of it -- all of these mean
# "treat this entry/archive as unreadable", never "let the exception
# propagate". `RuntimeError`/`NotImplementedError` cover an entry that opens
# but can't be decompressed (encrypted, or an unsupported compression
# method) -- `zipfile.ZipFile.open()` raises `RuntimeError` for a
# password-protected entry, which is NOT a `BadZipFile`.
_ZIP_READ_ERRORS = (
    zipfile.BadZipFile,
    RuntimeError,
    NotImplementedError,
    OSError,
    ValueError,
    EOFError,
)


def zip_entry_names(data: bytes) -> list[str]:
    """Every entry name in an Office archive, in archive order. Empty for
    bytes that aren't a readable zip -- callers treat "no such part" the
    same way either way.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            return list(archive.namelist())
    except _ZIP_READ_ERRORS:
        return []


def read_zip_entry(data: bytes, entry: str) -> str | None:
    return read_zip_entry_capped(data, entry, MAX_ZIP_ENTRY_BYTES)


def read_zip_entry_capped(data: bytes, entry: str, cap: int) -> str | None:
    """`None` if `data` isn't a zip, `entry` is missing, the entry's
    DECLARED size is over `cap`, its ACTUAL read size is over `cap`, or the
    entry can't be decompressed at all (encrypted, unsupported method) --
    every one of these collapses to `None`, matching the Rust source's
    `.ok()?` chain.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except _ZIP_READ_ERRORS:
        return None
    try:
        info = archive.getinfo(entry)
    except KeyError:
        return None
    # Declared size can lie, so the bounded read below is the real guard;
    # checking the header first just skips the allocation for an honest
    # oversized entry.
    if info.file_size > cap:
        return None
    try:
        with archive.open(info) as fh:
            raw = fh.read(cap + 1)
    except _ZIP_READ_ERRORS:
        return None
    if len(raw) > cap:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def zip_declared_size_within(data: bytes, cap: int) -> bool:
    """True when the sum of the archive's declared (uncompressed) entry
    sizes stays within `cap` (and the bytes parse as a zip at all).

    This is the fast path only -- it trusts the zip's own central-directory
    metadata, which a crafted archive can lie about. See
    `zip_inflated_size_within` for the guard that actually matters.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except _ZIP_READ_ERRORS:
        return False
    total = 0
    for info in archive.infolist():
        total += info.file_size
        if total > cap:
            return False
    return True


def zip_inflated_size_within(data: bytes, cap: int) -> bool:
    """True when the sum of the archive's ACTUAL inflated entry sizes stays
    within `cap`. Each entry is streamed through bounded `read()` calls (no
    buffering beyond `remaining + 1` bytes at a time), so a bomb costs at
    most `cap + 1` bytes of decompression work and O(1) memory before it is
    refused. Entries that cannot be read (encrypted, unsupported method)
    refuse the whole archive too -- callers must only ever see bytes that
    verified within bounds.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except _ZIP_READ_ERRORS:
        return False
    remaining = cap
    for info in archive.infolist():
        try:
            with archive.open(info) as fh:
                n = 0
                to_read = remaining + 1
                while to_read > 0:
                    chunk = fh.read(min(65536, to_read))
                    if not chunk:
                        break
                    n += len(chunk)
                    to_read -= len(chunk)
        except _ZIP_READ_ERRORS:
            return False
        if n > remaining:
            return False
        remaining -= n
    return True


# ------------------------------------------------------------- tag/text primitives


def xml_attr(tag: str, name: str) -> str | None:
    """Find `name="..."` or `name='...'` within `tag` up to its first `>`,
    and return the entity-decoded body, or `None` if not found/malformed.
    """
    gt = tag.find(">")
    head = tag if gt == -1 else tag[:gt]
    needle = f"{name}="
    at = head.find(needle)
    if at == -1:
        return None
    rest = head[at + len(needle) :]
    if not rest:
        return None
    quote = rest[0]
    if quote not in ('"', "'"):
        return None
    body = rest[1:]
    end = body.find(quote)
    if end == -1:
        return None
    return decode_basic_entities(body[:end])


def strip_tags(input: str) -> str:  # noqa: A002 - mirrors the Rust parameter name
    """Remove everything between `<` and `>`, replacing each removed tag
    with a single space -- quote-aware, so a `>` inside a quoted attribute
    value does not end the tag early. (Parsoid-rendered Wikipedia pages
    carry whole infobox/template wikitext inside `data-mw='{...}'`
    attributes whose JSON holds literal `<ref>`/`<br/>` markup; without
    quote-awareness the first stray `>` flips the scanner back out of the
    tag and dumps that raw template JSON into the text.)
    """
    out: list[str] = []
    in_tag = False
    quote: str | None = None
    for c in input:
        if in_tag:
            if quote is not None:
                if c == quote:
                    quote = None
                # else: still inside the quoted value, ignore.
            elif c in ('"', "'"):
                quote = c
            elif c == ">":
                in_tag = False
                out.append(" ")
            # else: ordinary character inside the tag, ignore.
        elif c == "<":
            in_tag = True
        else:
            out.append(c)
    return decode_basic_entities("".join(out))


def xml_paras_to_text(xml: str, para_close: str) -> str:
    """Text of an OOXML part, keeping its paragraph structure: the
    paragraph close tag (`</w:p>` in Word, `</a:p>` in PowerPoint) becomes a
    newline before the markup is stripped, so paragraphs don't collapse
    into one run-on line.
    """
    return strip_tags(xml.replace(para_close, para_close + "\n"))


# The named entities worth carrying: the five XML ones plus the typographic
# punctuation real prose is full of. Anything outside this table and outside
# the numeric forms is left exactly as written, which is the honest outcome
# -- a literal `&foo;` in the text is visibly not decoded, where a guess
# would be silently wrong.
NAMED_ENTITIES: tuple[tuple[str, str], ...] = (
    ("lt", "<"),
    ("gt", ">"),
    ("quot", '"'),
    ("apos", "'"),
    ("amp", "&"),
    ("nbsp", " "),
    ("mdash", "—"),
    ("ndash", "–"),
    ("hellip", "…"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("bull", "•"),
    ("middot", "·"),
    ("times", "×"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
    ("deg", "°"),
    ("euro", "€"),
    ("pound", "£"),
    ("laquo", "«"),
    ("raquo", "»"),
)

# The longest `&...;` we will look at (in UTF-8 BYTES, matching the Rust
# source's `char_indices` bound -- see `_entity_body_end`). Long enough for
# every name above and for a hex reference; short enough that a bare `&` in
# prose scans a few bytes and gives up rather than swallowing half a
# paragraph looking for a `;`.
MAX_ENTITY_LEN: int = 12


def _ascii_ci_eq(a: str, b: str) -> bool:
    """`str::eq_ignore_ascii_case` -- ASCII letters compare case-insensitively,
    everything else (including any non-ASCII character) must match exactly.
    """
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x == y:
            continue
        if x.isascii() and y.isascii() and x.lower() == y.lower():
            continue
        return False
    return True


def _lookup_named_entity(body: str) -> str | None:
    for name, ch in NAMED_ENTITIES:
        if _ascii_ci_eq(name, body):
            return ch
    return None


def _parse_u32(digits: str, base: int) -> int | None:
    """`u32::from_str_radix` / `str::parse::<u32>` -- digits with an
    optional single leading `+` (never `-`, since u32 cannot be negative),
    no underscores, no whitespace -- and the value must fit in 32 bits.

    Confirmed against a compiled copy of the Rust function: both
    `"123".parse::<u32>()` and `"+123".parse::<u32>()` succeed (as does
    `u32::from_str_radix("+7B", 16)`), while a leading `-`, any internal
    `_`, or surrounding whitespace all fail to parse -- unlike Python's own
    `int(str, base)`, which accepts all three.
    """
    if digits.startswith("+"):
        digits = digits[1:]
    if not digits:
        return None
    alphabet = "0123456789abcdefABCDEF" if base == 16 else "0123456789"
    if any(c not in alphabet for c in digits):
        return None
    value = int(digits, base)
    if value > 0xFFFFFFFF:
        return None
    return value


def _char_from_u32(code: int) -> str | None:
    """`char::from_u32` -- `None` for surrogate code points and anything
    past the Unicode ceiling (Python's own `chr` allows lone surrogates,
    unlike Rust's `char`, so that range needs an explicit refusal).
    """
    if code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
        return None
    return chr(code)


def _entity_body_end(after: str) -> int | None:
    """Byte-index (within `after`, matching the Rust source's
    `char_indices` scan) of the first `;` no further than `MAX_ENTITY_LEN`
    UTF-8 bytes in, or `None` if none is found in that window. Returns the
    CHARACTER index of that `;` (safe to slice `after` with, since it lands
    on a character boundary by construction).
    """
    byte_pos = 0
    for idx, c in enumerate(after):
        if byte_pos > MAX_ENTITY_LEN:
            return None
        if c == ";":
            return idx
        byte_pos += len(c.encode("utf-8"))
    return None


def decode_basic_entities(s: str) -> str:
    """Decode HTML/XML entities in extracted text.

    Single pass, deliberately: each `&...;` is examined in the ORIGINAL text
    and replaced exactly once, so ordering never matters and double-decoding
    (`&amp;lt;` -> `&lt;`, never all the way down to `<`) is structurally
    impossible.
    """
    # Nothing to do, and the overwhelmingly common case for non-HTML sources.
    if "&" not in s:
        return s
    out: list[str] = []
    rest = s
    while True:
        amp = rest.find("&")
        if amp == -1:
            break
        out.append(rest[:amp])
        after = rest[amp + 1 :]
        semi = _entity_body_end(after)
        if semi is None:
            # A bare `&` -- emit it and carry on from just after it, so the
            # next `find` cannot rediscover this same one and loop forever.
            out.append("&")
            rest = after
            continue
        body = after[:semi]
        decoded: str | None
        if body.startswith("#"):
            digits = body[1:]
            if digits[:1] in ("x", "X"):
                code = _parse_u32(digits[1:], 16)
            else:
                code = _parse_u32(digits, 10)
            decoded = _char_from_u32(code) if code is not None else None
        else:
            decoded = _lookup_named_entity(body)
        if decoded is not None:
            out.append(decoded)
        else:
            # Unrecognized: keep it verbatim, `&` and `;` included.
            out.append("&")
            out.append(body)
            out.append(";")
        rest = after[semi + 1 :]
    out.append(rest)
    return "".join(out)


def normalize_whitespace(s: str) -> str:
    """Collapse whitespace runs to a single space PER LINE, and squeeze runs
    of blank lines down to at most one blank line.

    NOTE for extractors: this runs over EVERY extractor's output, and it
    collapses tabs along with spaces. An extractor that wants column
    structure to survive into the search index and the model's view must
    emit a visible separator (e.g. `" | "`), never a tab.
    """
    out: list[str] = []
    blank_lines = 0
    for line in _rust_lines(s):
        trimmed = " ".join(line.split())
        if trimmed == "":
            blank_lines += 1
            if blank_lines <= 1:
                out.append("\n")
        else:
            blank_lines = 0
            out.append(trimmed)
            out.append("\n")
    return "".join(out)


def _rust_lines(s: str) -> list[str]:
    """`str::lines()` -- split on `\\n`, stripping a trailing `\\r` from
    each piece (so `\\r\\n` is one boundary), with no extra empty line for a
    final trailing `\\n`. Deliberately NOT Python's `str.splitlines()`,
    which also treats `\\v`, `\\f`, `\\x1c`-`\\x1e`, `\\x85`, `\\u2028`, and
    `\\u2029` as line breaks -- Rust's version only ever splits on
    `\\n`/`\\r\\n`, and matching that exactly matters for `normalize_whitespace`'s
    blank-line counting.
    """
    parts = s.split("\n")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return [p[:-1] if p.endswith("\r") else p for p in parts]
