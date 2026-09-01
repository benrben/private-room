"""Decode a text file's bytes into a `str`, honouring its encoding.

Port of `src-tauri/src/extraction.rs` lines 112-282: `EncodingSource`,
`DecodedText`, `decode_text_bytes`, `decode_text_detail`, `decode_text_as`,
`ENCODING_CHOICES`, `encoding_choices()`. (`sniff_text_bytes`, lines 383-396
of the same file, calls `decode_text_detail` but belongs to a later
dispatcher batch -- it is not ported here.)

This was `bytes.decode("utf-8", errors="replace")` in an earlier life, which
silently turns every byte a legacy encoding uses into U+FFFD. A Turkish
windows-1254 file therefore imported as a wall of "" -- unreadable in the
viewer, unsearchable in the index and useless to the model, with nothing
anywhere saying why.

------------------------------------------------------------- the cascade

Order matters, and is preserved exactly from the Rust source:

    1. BOM      -- a byte-order mark is a FACT about the bytes, so it wins
                   outright.
    2. UTF-8    -- valid UTF-8 is next and is near-certain: arbitrary legacy
                   bytes almost never form a valid UTF-8 sequence by
                   accident.
    3. DETECTED -- only when both fail is the encoding actually guessed.

--------------------------------------------------------- detector swap: BIG

The Rust source detects with `chardetng`, Mozilla/Firefox's own encoding
sniffer, written by the author of `encoding_rs`. There is no Python library
that reproduces `chardetng`'s exact algorithm or guarantees identical
guesses on ambiguous input, so this port uses `charset-normalizer` instead
(already in this project's dependency graph transitively via
requests/httpx; now declared directly -- see `pyproject.toml`, following
this codebase's own "declare what you import" convention).

**ACCEPTED, UNAVOIDABLE CONSEQUENCE**: on genuinely ambiguous single-byte
input, `charset-normalizer`'s guess CAN DIFFER from what `chardetng` would
have said -- a different detector with different heuristics, not a bug to
chase. This mirrors the Rust doc comment's own point: single-byte detection
is genuinely hard (it rejected a hand-rolled heuristic for exactly this
reason -- it read a Turkish fixture as windows-1250), and any detector's
guess on truly ambiguous data is a guess, never a fact. Measured during this
port: `charset-normalizer` needs realistic paragraph-length signal to guess
a single-byte legacy encoding reliably -- a short/synthetic sample (a
handful of words) can guess something unrelated. Real files are not that
short, so this is a test-fixture concern, not a production one.

What MUST match the Rust source exactly regardless of the detector's guess,
and does:
  - the BOM fast path (UTF-8 / UTF-16LE / UTF-16BE) -- a fact about the bytes
  - the valid-UTF-8 fast path -- also a fact, no guessing performed
  - the cascade order: BOM, then UTF-8, then detect
  - the WHATWG canonical name strings this module reports (`encoding` field,
    and `encoding_choices()`'s output) -- copied verbatim from the Rust
    source / `encoding_rs::Encoding::name()`, NOT Python's own codec names
  - the "lossy" flag's correctness: True iff ANY byte had no meaning in the
    target encoding and was replaced

The Rust source also explicitly denies two guesses at the detector level:
`Iso2022JpDetection::Deny` (ISO-2022-JP is an escape-sequence encoding and
the room's text can reach an HTML viewer) and `Utf8Detection::Deny` (UTF-8
is already ruled out by step 2, so letting the detector answer UTF-8 would
only reinstate a lossy read). This module has no ISO-2022-JP entry in its
table at all, so a guess in that family can never be chosen -- the same
outcome as an explicit deny, achieved by omission. UTF-8 IS one of this
module's 23 table entries (it must be, for the BOM and `decode_text_as`
paths), so in the extreme case where a file's first 64 KiB happens to be
valid UTF-8 but a later byte is not (making the whole-buffer strict decode
in step 2 fail), the DETECTED step could in principle choose UTF-8 again and
report `lossy=True` on the full decode. This is a theoretical corner of the
already-accepted "detection is a guess" scope, not a violation of anything
in the "must match" list above -- flagged here for a future reader, not
chased.

------------------------------------------------------------------- lossy

`lossy` must be True exactly when replacement occurred, and must NOT be
computed by scanning the decoded text for U+FFFD -- a validly-encoded file
can legitimately already contain a real U+FFFD character, which would be a
false positive. Instead, every decode in this module is attempted STRICT
first; only on `UnicodeDecodeError` does it re-decode with
`errors="replace"` and set `lossy=True`. This mirrors `encoding_rs`'s own
`decode_without_bom_handling`, which returns `(Cow<str>, had_errors)` on
exactly the same basis (whether the decoder had to substitute anything), not
on inspecting its own output afterwards.

------------------------------------------------------- decode_text_as scope

`decode_text_as` in Rust resolves `label` via
`encoding_rs::Encoding::for_label`, which recognises the ENTIRE WHATWG alias
table (~200 labels: "latin1", "ascii", "iso-8859-9", etc.), not just the 23
curated entries the picker offers. This port DELIBERATELY NARROWS that:
`decode_text_as` here only resolves a label against this module's own
23-entry `ENCODING_CHOICES` table (case-insensitively, matching either the
short label or the WHATWG canonical name), and returns `None` for anything
else -- including labels `for_label` would have accepted (e.g. "latin1",
"iso-8859-9"). There is no `encoding_rs`-equivalent full alias table ported
to Python here, and inventing one would be scope creep past what this
module needs: the only caller is the picker built from `encoding_choices()`,
which can never offer anything outside the 23. This is a deliberate,
documented deviation from the Rust source's broader permissiveness, not an
oversight.

----------------------------------------------------------- codec fidelity

Every one of the 23 Python codec names below was verified empirically
(encode a string with it, decode it back, confirm round-trip) during this
port -- see the test file. Three are worth flagging explicitly:

  - `shift_jis` (label) / `shift-jis` (Python codec): Python's Shift_JIS
    table is close to, but not bit-identical with, WHATWG's Shift_JIS for a
    handful of code points (a known, long-standing discrepancy between
    CPython's CJK codec tables and the WHATWG/`encoding_rs` ones). Flagged,
    not chased -- exactly the mapping-table drift this port's scope
    excludes.
  - `macintosh` (label) / `mac-roman` (Python codec): also a legacy
    single-byte mapping table; verified to round-trip on this machine, not
    independently verified bit-identical to `encoding_rs`'s `macintosh`
    table beyond that.
  - `windows-1258` (label) / `cp1258` (Python codec): Python's cp1258 is a
    STATIC charmap that only covers Vietnamese letters with a single
    precomposed diacritic (e.g. "ăâđêôơư" round-trips). Real windows-1258
    represents many TONED Vietnamese vowels (e.g. the "ệ" in "Việt") with a
    base letter plus a COMBINING mark, which Python's charmap-based codec
    does not encode (`UnicodeEncodeError`) -- this only bit test-fixture
    ENCODING, never the DECODE path this module actually ships (decoding
    arbitrary windows-1258 bytes back to Unicode works fine regardless).

------------------------------------------------------------------- detect

Detection is fed a bounded 64 KiB PREFIX of the input (matching the Rust
source's `SAMPLE = 64 * 1024`), but the FULL input is what actually gets
decoded once an encoding is chosen -- only the *guess* is based on a sample.

`charset-normalizer`'s `.best().encoding` can name any of ~100 Python codecs,
most with no entry in this module's 23-item table. Measured empirically
during this port: real-world CJK content very often guesses a vendor
SUPERSET of one of this table's entries rather than the base codec name
itself -- e.g. genuine Shift_JIS text commonly guesses `cp932` (Microsoft's
superset, and what real-world "Shift_JIS" text usually actually is), and
genuine EUC-KR text commonly guesses `cp949` (the analogous Korean
superset). Without accounting for this, those guesses would match nothing
in the table and silently fall back to the windows-1252 default -- which
does not fail loudly, it decodes the bytes as SOMETHING (windows-1252 has
few undefined code points) and produces confidently-wrong mojibake with
`lossy=False`. That is precisely the failure the Rust source's own doc
comment calls out as worse than an honest "unreadable": nothing on screen
admits it is wrong. A small, explicit alias map below absorbs the common
near-exact supersets/variants of entries THIS table does carry; everything
else -- any guess this table has no reasonable match for at all -- falls
back to a single, deliberately chosen default: **windows-1252**, the
historical "ANSI" default for exactly this kind of ambiguous single-byte
legacy text.
"""

from __future__ import annotations

import codecs
from dataclasses import dataclass
from enum import Enum

from charset_normalizer import from_bytes as _cn_from_bytes

# ---------------------------------------------------------------- source


class EncodingSource(str, Enum):
    """How a text file's encoding was arrived at.

    The four cases are NOT equally trustworthy: a BOM and valid UTF-8 are
    facts about the bytes, a detection is a guess that single-byte encodings
    make genuinely ambiguous, and a choice is the human overruling that
    guess. String values match the Rust `#[serde(rename_all = "lowercase")]`
    output on `EncodingSource` exactly (`Bom` -> "bom", etc.) -- this is what
    a future IPC/JSON boundary will actually see on the wire.
    """

    BOM = "bom"
    UTF8 = "utf8"
    DETECTED = "detected"
    CHOSEN = "chosen"


@dataclass(frozen=True)
class DecodedText:
    """A decoded text file, with the provenance of the encoding that produced it."""

    text: str
    #: The encoding's WHATWG canonical name (`"UTF-8"`, `"windows-1254"`, …)
    #: -- what a future TypeScript frontend receives over IPC. NOT a Python
    #: codec name. Always one of `encoding_choices()`'s first elements.
    encoding: str
    source: EncodingSource
    #: Some bytes had no meaning in this encoding and became U+FFFD. The
    #: text is therefore NOT the file: round-tripping it would write
    #: replacement characters over the originals.
    lossy: bool


# ------------------------------------------------------------- the table


@dataclass(frozen=True)
class _EncodingChoice:
    label: str  # short label, e.g. "windows-1252" -- what decode_text_as accepts
    python_codec: str  # a Python codec name that decodes this encoding
    whatwg_name: str  # exact WHATWG canonical name -- the OUTPUT contract
    title: str  # human-readable title, copied verbatim from the Rust source


# Order matches the Rust source's `ENCODING_CHOICES` exactly -- this IS the
# order `encoding_choices()` returns. Titles are copied verbatim from the
# Rust array's string literals.
#
# The Turkish pair (windows-1254 / ISO-8859-9) are the SAME encoding in the
# WHATWG Encoding Standard, which is why the title names both and there is
# deliberately no separate "iso-8859-9" row -- matching the Rust source,
# which also only lists windows-1254.
ENCODING_CHOICES: tuple[_EncodingChoice, ...] = (
    _EncodingChoice("utf-8", "utf-8", "UTF-8", "Unicode (UTF-8)"),
    _EncodingChoice("utf-16le", "utf-16-le", "UTF-16LE", "Unicode (UTF-16, little-endian)"),
    _EncodingChoice("utf-16be", "utf-16-be", "UTF-16BE", "Unicode (UTF-16, big-endian)"),
    _EncodingChoice("windows-1252", "cp1252", "windows-1252", "Western European (Windows 1252)"),
    _EncodingChoice("iso-8859-15", "iso8859-15", "ISO-8859-15", "Western European (ISO-8859-15)"),
    _EncodingChoice("macintosh", "mac-roman", "macintosh", "Western European (Mac Roman)"),
    _EncodingChoice("windows-1250", "cp1250", "windows-1250", "Central European (Windows 1250)"),
    _EncodingChoice("iso-8859-2", "iso8859-2", "ISO-8859-2", "Central European (ISO-8859-2)"),
    _EncodingChoice(
        "windows-1254", "cp1254", "windows-1254", "Turkish (Windows 1254 / ISO-8859-9)"
    ),
    _EncodingChoice("windows-1251", "cp1251", "windows-1251", "Cyrillic (Windows 1251)"),
    _EncodingChoice("koi8-r", "koi8-r", "KOI8-R", "Cyrillic (KOI8-R)"),
    _EncodingChoice("iso-8859-5", "iso8859-5", "ISO-8859-5", "Cyrillic (ISO-8859-5)"),
    _EncodingChoice("windows-1253", "cp1253", "windows-1253", "Greek (Windows 1253)"),
    _EncodingChoice("windows-1255", "cp1255", "windows-1255", "Hebrew (Windows 1255)"),
    _EncodingChoice("windows-1256", "cp1256", "windows-1256", "Arabic (Windows 1256)"),
    _EncodingChoice("windows-1257", "cp1257", "windows-1257", "Baltic (Windows 1257)"),
    _EncodingChoice("windows-1258", "cp1258", "windows-1258", "Vietnamese (Windows 1258)"),
    _EncodingChoice("shift_jis", "shift-jis", "Shift_JIS", "Japanese (Shift_JIS)"),
    _EncodingChoice("euc-jp", "euc-jp", "EUC-JP", "Japanese (EUC-JP)"),
    _EncodingChoice("gbk", "gbk", "GBK", "Simplified Chinese (GBK)"),
    _EncodingChoice("gb18030", "gb18030", "gb18030", "Simplified Chinese (GB18030)"),
    _EncodingChoice("big5", "big5", "Big5", "Traditional Chinese (Big5)"),
    _EncodingChoice("euc-kr", "euc-kr", "EUC-KR", "Korean (EUC-KR)"),
)

# label (lowercase) / whatwg canonical name (lowercase) -> choice, so
# decode_text_as can match either spelling case-insensitively. Both keys are
# indexed even though, for every row, the canonical name lowercases to
# exactly the label -- belt-and-suspenders against the two ever diverging.
_BY_KEY: dict[str, _EncodingChoice] = {}
for _choice in ENCODING_CHOICES:
    _BY_KEY[_choice.label.lower()] = _choice
    _BY_KEY[_choice.whatwg_name.lower()] = _choice
del _choice

# Python's own normalized codec name (via codecs.lookup(...).name) -> choice.
# Lets a charset-normalizer guess that names one of THIS table's codecs
# directly (however it happens to spell/case it) resolve without needing an
# explicit alias entry below.
_BY_NORMALIZED_CODEC: dict[str, _EncodingChoice] = {
    codecs.lookup(_choice.python_codec).name: _choice for _choice in ENCODING_CHOICES
}

# charset-normalizer / Python codec name (already run through
# codecs.lookup(...).name) -> this table's label, for guesses that are a
# close superset/variant of one of our 23 entries but not a literal name
# match. Verified empirically (not assumed) during this port: real Shift_JIS
# and EUC-KR content routinely guesses as `cp932`/`cp949` respectively (see
# the module docstring's "detect" section for why leaving these unmapped is
# a real, silent correctness bug -- it falls through to the windows-1252
# default and produces confident mojibake instead of the right answer).
# Deliberately small and explicit, not attempted to be exhaustive.
_DETECTION_ALIASES: dict[str, str] = {
    "cp932": "shift_jis",  # MS's real-world superset of Shift_JIS
    "shift_jis_2004": "shift_jis",
    "shift_jisx0213": "shift_jis",
    "euc_jis_2004": "euc-jp",
    "euc_jisx0213": "euc-jp",
    "cp950": "big5",  # MS's real-world superset of Big5
    "big5hkscs": "big5",
    "gb2312": "gbk",  # gb2312 is a strict subset of gbk
    "cp949": "euc-kr",  # MS's real-world (UHC) superset of EUC-KR
}

# The deliberate fallback for a detector guess that matches nothing above at
# all -- the historical "ANSI" default for ambiguous single-byte legacy
# text. See the "detect" section of the module docstring.
_DEFAULT_CHOICE = _BY_KEY["windows-1252"]

# Detection is fed a bounded prefix, not the whole file -- the detector
# wants a sample, not the whole file, and a book-length import should not be
# scanned twice. Matches the Rust source's `SAMPLE = 64 * 1024` exactly.
_SAMPLE_BYTES = 64 * 1024

_UTF8_BOM = b"\xef\xbb\xbf"
_UTF16LE_BOM = b"\xff\xfe"
_UTF16BE_BOM = b"\xfe\xff"


def _decode_with_flag(data: bytes, python_codec: str) -> tuple[str, bool]:
    """Decode `data` as `python_codec`, tracking whether any byte had no
    meaning in it (became a replacement character).

    Decodes STRICT first; if that raises, decodes again with
    `errors="replace"` and reports lossy=True. This is deliberately NOT
    "decode lossily, then scan the result for U+FFFD" -- a file that is
    validly encoded and genuinely CONTAINS a real U+FFFD character would
    produce a false positive from that approach. Catching the strict-decode
    exception is the only test that can't be fooled by data that
    legitimately contains the replacement character.
    """
    try:
        return data.decode(python_codec, errors="strict"), False
    except UnicodeDecodeError:
        return data.decode(python_codec, errors="replace"), True


def _bom_match(data: bytes) -> tuple[str, str, int] | None:
    """Returns (python_codec, whatwg_name, bom_length_in_bytes) for a
    recognised BOM prefix, or None.

    Exactly three cases, each an independent prefix check -- the WHATWG
    Encoding Standard has no UTF-32 concept, so there is no fourth case, and
    FF FE / FE FF are each other's byte-swap while neither is a prefix of
    the 3-byte EF BB BF pattern, so there is no ordering ambiguity between
    them either.
    """
    if data.startswith(_UTF8_BOM):
        return ("utf-8", "UTF-8", len(_UTF8_BOM))
    if data.startswith(_UTF16LE_BOM):
        return ("utf-16-le", "UTF-16LE", len(_UTF16LE_BOM))
    if data.startswith(_UTF16BE_BOM):
        return ("utf-16-be", "UTF-16BE", len(_UTF16BE_BOM))
    return None


def _guess_choice(sample: bytes) -> _EncodingChoice:
    """Best-effort mapping from a charset-normalizer guess (on a bounded
    sample) to this module's own WHATWG table.

    Resolution order: literal codec-name match against this table, then the
    explicit superset/variant alias map, then the windows-1252 default. See
    the module docstring's "detect" section.
    """
    normalized = _normalized_detection_codec(sample)
    return _choice_for_normalized_detection(normalized)


def _normalized_detection_codec(sample: bytes) -> str | None:
    """Return the detector's Python-normalized codec name, if usable."""
    best = _cn_from_bytes(sample).best()
    if best is None or not best.encoding:
        return None
    try:
        return codecs.lookup(best.encoding).name
    except LookupError:
        return None


def _choice_for_normalized_detection(normalized: str | None) -> _EncodingChoice:
    """Resolve a normalized detector name through direct and alias matches."""
    if normalized is None:
        return _DEFAULT_CHOICE
    matched = _BY_NORMALIZED_CODEC.get(normalized)
    if matched is not None:
        return matched
    alias_label = _DETECTION_ALIASES.get(normalized)
    if alias_label is not None:
        return _BY_KEY[alias_label]
    return _DEFAULT_CHOICE


def decode_text_bytes(data: bytes) -> str:
    """`decode_text_detail(data).text` -- the encoding-agnostic convenience form."""
    return decode_text_detail(data).text


def decode_text_detail(data: bytes) -> DecodedText:
    """`decode_text_bytes`, keeping the encoding it settled on.

    See the module docstring for why the order is BOM -> UTF-8 -> detect.
    """
    # 1. A byte-order mark states the encoding outright. Skip the BOM's own
    #    bytes so the mark itself never lands in the text as U+FEFF.
    bom = _bom_match(data)
    if bom is not None:
        python_codec, whatwg_name, bom_len = bom
        text, lossy = _decode_with_flag(data[bom_len:], python_codec)
        return DecodedText(text=text, encoding=whatwg_name, source=EncodingSource.BOM, lossy=lossy)

    # 2. Valid UTF-8 is taken as UTF-8, no guessing. A strict whole-buffer
    #    decode either succeeds outright (near-certain for real UTF-8; a
    #    legacy-encoded file forming valid UTF-8 by accident is vanishingly
    #    rare) or raises, in which case we fall through to detection.
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        pass
    else:
        return DecodedText(text=text, encoding="UTF-8", source=EncodingSource.UTF8, lossy=False)

    # 3. Detect, from a bounded prefix; decode the FULL input with the guess.
    sample = data[:_SAMPLE_BYTES]
    choice = _guess_choice(sample)
    text, lossy = _decode_with_flag(data, choice.python_codec)
    return DecodedText(
        text=text, encoding=choice.whatwg_name, source=EncodingSource.DETECTED, lossy=lossy
    )


def decode_text_as(data: bytes, label: str) -> DecodedText | None:
    """Decode `data` as the NAMED encoding, for the viewer's override.

    `None` when `label` isn't one of this module's 23 known choices
    (case-insensitive; also matches each choice's own WHATWG canonical
    name) -- see the module docstring's "decode_text_as scope" section for
    why this is narrower than the Rust source's full WHATWG alias table,
    deliberately.

    BOM handling is deliberately OFF: the point of the override is that the
    user overrules what the bytes appear to say, so the WHOLE input
    (including any BOM-looking bytes) is decoded literally as the chosen
    encoding.
    """
    choice = _BY_KEY.get(label.lower())
    if choice is None:
        return None
    text, lossy = _decode_with_flag(data, choice.python_codec)
    return DecodedText(text=text, encoding=choice.whatwg_name, source=EncodingSource.CHOSEN, lossy=lossy)


def encoding_choices() -> list[tuple[str, str]]:
    """The offer list: (WHATWG canonical name, human title) pairs, in the
    same order as the Rust source's `ENCODING_CHOICES` table.

    Each name is exactly what `decode_text_as` reports back for it (and
    accepts as input), so the strip's "read as X" and the menu's selected
    row are the same string.
    """
    return [(choice.whatwg_name, choice.title) for choice in ENCODING_CHOICES]
