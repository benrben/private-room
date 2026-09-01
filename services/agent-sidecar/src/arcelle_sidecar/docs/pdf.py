"""PDF text extraction + Hebrew visual-order repair + extraction-quality gate.

Port of `src-tauri/src/extraction/pdf.rs` (extraction + the RTL repair) and
`src-tauri/src/extraction/pdf_quality.rs` (the "is this text or noise?" gate
that decides whether a page should be re-read with OCR). The two are
combined by `choose()`, exactly as in the Rust source: `extraction/mod.rs`
calls `extract_pdf`, and when `pdf_quality::should_reread_with_ocr` fires on
the result, the sibling `arcelle_sidecar.media.ocr` image-based OCR path is
run and `choose()` decides which reading to keep. This module is TEXT
extraction only; `media/ocr.py` is the sibling IMAGE-based OCR fallback and
is not duplicated here.

-------------------------------------------------------------- extraction

`extract_pdf` replaces the Rust `pdf-extract` crate with `pymupdf`, per the
migration plan's own design decision. `pdf-extract` is a pure-Rust reader
with no layout model that can PANIC on malformed input, which is why the
Rust code wraps the call in `std::panic::catch_unwind` -- pymupdf instead
raises ordinary Python exceptions on a damaged/non-PDF byte string, so a
plain `try`/`except` around `pymupdf.open` (and again around the per-page
walk) gives the same containment goal without anything panic-specific.

Deliberate deviation -- inter-page separator: the Rust crate's
`PlainTextOutput` does not write any explicit separator between pages; the
newlines that appear in its output come from a text-position heuristic (a
big jump in Y, or a leftward+downward move, mid-page) that is unrelated to
page boundaries and depends on the specific glyph layout of the document.
There is no clean signal to reproduce from that heuristic, and pymupdf's
own per-page `get_text()` already returns each page's text with its own
trailing newline. This port joins pages with `"\n\n"` -- a clear,
deterministic page break that cannot be confused with a normal paragraph
gap of a single `\n` within pymupdf's own output -- rather than trying to
reverse-engineer the Rust crate's incidental, content-dependent newline
placement.

-------------------------------------------------------- Hebrew RTL repair

Many Hebrew PDFs carry their text in VISUAL order (left-to-right glyph
order, i.e. each line is character-reversed) because that's how the page
was typeset. The extractor reads glyphs in page order, so a Hebrew Bible
comes out mirrored -- "׃םֽ ֶכיֵלְל" instead of "לְלֵיכֶֽם׃" -- with a space
between glyph clusters inside words and a wider gap between real words. A
model reading that sees gibberish, and search can never match it.

`looks_visual_hebrew` detects this from its signature artifact: clusters
emitted as `space + mark(s) + base`, i.e. combining marks that FOLLOW a
space. In logical Hebrew a mark virtually never follows a space (it always
follows its base letter); in this extractor's visual output most clusters
do.

`fix_visual_hebrew` restores logical order line by line: reverse the line,
un-mirror embedded digit/Latin runs, re-attach combining marks that ended up
before their base, and collapse the glyph-cluster spaces (single space
inside a word; 2+ spaces was the real word gap). Lines with fewer than two
Hebrew letters pass through untouched even inside a visual-order document.
No-op unless the document as a whole looks visual-order.

------------------------------------------------------------ quality gate

`pdf-extract` (and, in principle, any layout-blind extractor) walks glyphs
in content-stream order, which is right for a single column of prose and
wrong for everything else: it interleaves columns on a two-column paper,
runs cells together on a table, and emits raw glyph indices as letters on a
page whose font has no usable ToUnicode map. In every one of those cases it
returns text and reports success -- so the room indexed the mess, RAG
retrieved the mess, and the model answered from the mess with nothing
anywhere saying the page had not been read.

OCR already existed as a fallback but only for the empty case (an
image-only scan). `fault_in` asks the missing question -- "is this text, or
is it noise?" -- of the output before it is trusted, so every failure mode
above, not just the empty one, routes to OCR instead. `choose` then decides,
given both readings, which to keep: OCR is not automatically better (it can
misread a ligature or a digit), so the extracted text wins unless it is
faulty, and OCR is trusted only if it is not faulty itself -- a scan of a
blank page must not replace real text with nothing.
"""

from __future__ import annotations

import string
from enum import Enum

import pymupdf

# ---------------------------------------------------------------- extraction


def extract_pdf(data: bytes) -> str | None:
    """Extract text from a PDF's raw bytes, then repair visual-order Hebrew.

    Returns `None` (rather than raising) on any malformed/non-PDF input, or
    on a page pymupdf cannot walk -- see the module docstring for why this
    mirrors Rust's `catch_unwind` containment goal.
    """
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:  # noqa: BLE001 - malformed/non-PDF bytes must not raise
        return None
    try:
        text = "\n\n".join(page.get_text() for page in doc)
    except Exception:  # noqa: BLE001 - a damaged page object must not raise past here
        return None
    finally:
        doc.close()
    return fix_visual_hebrew(text)


# ---------------------------------------------------------------- RTL repair


def is_heb_letter(c: str) -> bool:
    """True for a single Hebrew consonant letter (U+05D0-U+05EA, alef..tav)."""
    return "א" <= c <= "ת"


#: Punctuation characters that live inside the Hebrew combining-mark block
#: (0591-05C7) but are NOT combining marks: maqaf (05BE), paseq (05C0), sof
#: pasuq (05C3), nun hafukha (05C6). Excluded from `is_heb_mark` below --
#: they must not be stripped or relocated as if they were marks.
_HEB_MARK_PUNCTUATION = frozenset({"־", "׀", "׃", "׆"})


def is_heb_mark(c: str) -> bool:
    """True for a Hebrew combining mark: cantillation (0591-05AF) + points
    (05B0-05C7), excluding `_HEB_MARK_PUNCTUATION`.
    """
    return "֑" <= c <= "ׇ" and c not in _HEB_MARK_PUNCTUATION


def strip_hebrew_marks(text: str) -> str:
    """Drop nikud + cantillation. The FTS tokenizer (unicode61) treats these
    combining marks as SEPARATORS, so a pointed word like קֹהֶלֶת indexes as
    meaningless single-letter fragments and a plain קהלת query can never
    match -- search text must be consonantal.
    """
    if not any(is_heb_mark(c) for c in text):
        return text
    return "".join(c for c in text if not is_heb_mark(c))


def _is_ascii_alnum(c: str) -> bool:
    """Rust's `char::is_ascii_alphanumeric`: ASCII 0-9/A-Z/a-z only. Plain
    `str.isalnum()` is Unicode-aware and would also accept Hebrew letters
    (they ARE alphanumeric under Unicode), which is exactly what pass (2) of
    `fix_visual_hebrew` below must not touch.
    """
    return c.isascii() and c.isalnum()


def _visual_hebrew_counts(text: str) -> tuple[int, int]:
    """Count Hebrew bases and visual-order orphan marks in a bounded sample."""
    letters = 0
    orphan_marks = 0
    previous_was_space = False
    for char in text[:400_000]:
        if is_heb_letter(char):
            letters += 1
        elif is_heb_mark(char) and previous_was_space:
            orphan_marks += 1
        previous_was_space = char.isspace()
    return letters, orphan_marks


def _has_visual_hebrew_signature(letters: int, orphan_marks: int) -> bool:
    return letters > 200 and orphan_marks > 50 and orphan_marks * 20 > letters


def looks_visual_hebrew(text: str) -> bool:
    """Detect visual-order Hebrew from its signature artifact: clusters
    emitted as `space + mark(s) + base`, i.e. combining marks that FOLLOW a
    space. In logical Hebrew a mark virtually never follows a space (it
    always follows its base letter); in visual-order output most clusters
    do. Scans at most the first 400,000 characters -- the failure mode is a
    document-wide property, not something that needs a full multi-megabyte
    book read.
    """
    letters, orphan_marks = _visual_hebrew_counts(text)
    return _has_visual_hebrew_signature(letters, orphan_marks)


def _rust_lines(text: str) -> list[str]:
    """Port of Rust's `str::lines()`: split on `\\n`, strip a trailing `\\r`
    off each piece (CRLF handling), and -- unlike a bare `str.split("\\n")`
    -- do NOT yield a final empty string for a trailing newline (`"a\\n"`
    yields `["a"]`, not `["a", ""]`). Also unlike `str.splitlines()`, which
    additionally breaks on `\\v`, `\\f`, `\\x1c`-`\\x1e`, U+2028/U+2029 that
    Rust's `.lines()` does not treat as line breaks. `fix_visual_hebrew`
    rejoins with a bare `"\\n"`, so this is the one piece of exact iteration
    semantics that has to be ported by hand rather than delegated to a
    builtin.
    """
    parts = text.split("\n")
    if parts and parts[-1] == "":
        parts.pop()
    return [p[:-1] if p.endswith("\r") else p for p in parts]


def _unmirror_ascii_runs(chars: list[str]) -> None:
    """Restore digit and Latin runs after the enclosing visual line flips."""
    index = 0
    while index < len(chars):
        if not _is_ascii_alnum(chars[index]):
            index += 1
            continue
        start = index
        while index < len(chars) and _is_ascii_alnum(chars[index]):
            index += 1
        chars[start:index] = reversed(chars[start:index])


def _is_hebrew_glyph(char: str) -> bool:
    return is_heb_letter(char) or is_heb_mark(char)


def _is_mark_cluster_boundary(fixed: list[str]) -> bool:
    return not fixed or not _is_hebrew_glyph(fixed[-1])


def _has_hebrew_base(chars: list[str], index: int) -> bool:
    return index < len(chars) and is_heb_letter(chars[index])


def _mark_run_end(chars: list[str], index: int) -> int:
    while index < len(chars) and is_heb_mark(chars[index]):
        index += 1
    return index


def _restore_mark_clusters(chars: list[str]) -> list[str]:
    """Move a visual-order mark run behind the Hebrew base it modifies."""
    fixed: list[str] = []
    index = 0
    while index < len(chars):
        if _is_mark_cluster_boundary(fixed) and is_heb_mark(chars[index]):
            start = index
            index = _mark_run_end(chars, index)
            if _has_hebrew_base(chars, index):
                fixed.append(chars[index])
                fixed.extend(chars[start:index])
                index += 1
            else:
                fixed.extend(chars[start:index])
            continue
        fixed.append(chars[index])
        index += 1
    return fixed


def _space_has_hebrew_on_both_sides(cleaned: list[str], fixed: list[str], index: int) -> bool:
    return bool(cleaned) and _is_hebrew_glyph(cleaned[-1]) and index < len(fixed) and _is_hebrew_glyph(fixed[index])


def _keep_space(run_length: int, cleaned: list[str], fixed: list[str], index: int) -> bool:
    return run_length >= 2 or not _space_has_hebrew_on_both_sides(cleaned, fixed, index)


def _space_run_end(fixed: list[str], index: int) -> int:
    while index < len(fixed) and fixed[index] == " ":
        index += 1
    return index


def _collapse_cluster_spaces(fixed: list[str]) -> list[str]:
    """Drop a single visual cluster gap but retain real word separators."""
    cleaned: list[str] = []
    index = 0
    while index < len(fixed):
        if fixed[index] != " ":
            cleaned.append(fixed[index])
            index += 1
            continue
        start = index
        index = _space_run_end(fixed, index)
        if _keep_space(index - start, cleaned, fixed, index):
            cleaned.append(" ")
    return cleaned


def _fix_visual_hebrew_line(line: str) -> str:
    chars = list(reversed(line))
    _unmirror_ascii_runs(chars)
    return "".join(_collapse_cluster_spaces(_restore_mark_clusters(chars)))


def _hebrew_letter_count(line: str) -> int:
    return sum(1 for char in line if is_heb_letter(char))


def fix_visual_hebrew(text: str) -> str:
    """Restore logical order for visual-order Hebrew text, line by line:
    reverse the line, un-mirror embedded digit/Latin runs, re-attach
    combining marks that ended up before their base, and collapse the
    glyph-cluster spaces (single space inside a word; 2+ spaces was the real
    word gap). Lines with fewer than two Hebrew letters pass through
    untouched. No-op unless the document as a whole looks visual-order.
    """
    if not looks_visual_hebrew(text):
        return text

    out_lines: list[str] = []
    for line in _rust_lines(text):
        if _hebrew_letter_count(line) < 2:
            out_lines.append(line)
            continue
        out_lines.append(_fix_visual_hebrew_line(line))

    return "\n".join(out_lines)


# --------------------------------------------------------------- quality gate

#: A page of prose has a space roughly every 5-6 characters. Below this the
#: extractor has run words together -- the ToUnicode/width failure -- and
#: the result tokenizes into nothing a search can match.
MIN_SPACE_RATIO: float = 0.06

#: Above this share of replacement characters, the encoding was not understood.
MAX_REPLACEMENT_RATIO: float = 0.02

#: Below this share of characters being letters/digits/space/punctuation,
#: the output is symbol soup rather than language.
MIN_READABLE_RATIO: float = 0.80

#: Text shorter than this is judged only on "is it empty" -- a title page or
#: a cover legitimately carries a dozen words, and ratios over 40 characters
#: are noise themselves.
MIN_SAMPLE: int = 200

#: The ASCII punctuation set Rust's `char::is_ascii_punctuation` accepts --
#: `string.punctuation` is exactly that 32-character set, so membership in
#: it is already ASCII-only with no extra `isascii()` guard needed.
_ASCII_PUNCTUATION = frozenset(string.punctuation)

#: Hebrew combining marks that the Unicode *Alphabetic* derived property
#: covers (`Other_Alphabetic` in DerivedCoreProperties.txt) but Python's
#: category-based `str.isalnum()` does not: the vowel points, dagesh/mapiq,
#: rafe, shin/sin dot and qamats qatan (05B0-05BD, 05BF, 05C1-05C2, 05C4-05C5,
#: 05C7). Rust's `char::is_alphanumeric()` follows that full derived
#: property (confirmed directly against `rustc`), so a fully-pointed
#: (niqqud) Hebrew Bible verse -- this module's own motivating case -- has
#: roughly half its characters be these marks, and without this set they
#: would not count as "readable", pushing ordinary, correctly-extracted
#: Hebrew prose below MIN_READABLE_RATIO and into a bogus NOT_LANGUAGE
#: verdict. The cantillation marks (0591-05AF) are NOT in this set -- they
#: are genuinely not Alphabetic in Unicode either, being prosodic/musical
#: annotations rather than vowel signs.
_HEB_OTHER_ALPHABETIC = frozenset(
    chr(cp)
    for cp in (
        list(range(0x05B0, 0x05BE)) + [0x05BF, 0x05C1, 0x05C2, 0x05C4, 0x05C5, 0x05C7]
    )
)


class PdfTextFault(Enum):
    """Why a PDF's extracted text was rejected. Carried so the decision can
    be logged and tested by name rather than as a bare bool.
    """

    #: Nothing at all -- the classic image-only scan.
    EMPTY = "empty"
    #: Words run together: almost no spaces.
    NO_WORD_BREAKS = "no_word_breaks"
    #: The font's character map wasn't understood.
    UNDECODABLE = "undecodable"
    #: Mostly symbols rather than language.
    NOT_LANGUAGE = "not_language"


def _replacement_ratio(text: str) -> float:
    return sum(1 for char in text if char == "�") / len(text)


def _is_readable_pdf_char(char: str) -> bool:
    return char.isalnum() or char.isspace() or char in _ASCII_PUNCTUATION or char in _HEB_OTHER_ALPHABETIC


def _readable_ratio(text: str) -> float:
    return sum(1 for char in text if _is_readable_pdf_char(char)) / len(text)


def _space_ratio(text: str) -> float:
    return sum(1 for char in text if char.isspace()) / len(text)


def _sample_fault(sample: str) -> PdfTextFault | None:
    if _replacement_ratio(sample) > MAX_REPLACEMENT_RATIO:
        return PdfTextFault.UNDECODABLE
    if _readable_ratio(sample) < MIN_READABLE_RATIO:
        return PdfTextFault.NOT_LANGUAGE
    if _space_ratio(sample) < MIN_SPACE_RATIO:
        return PdfTextFault.NO_WORD_BREAKS
    return None


def fault_in(text: str) -> PdfTextFault | None:
    """Judge extracted PDF text. `None` means "good enough to index"."""
    trimmed = text.strip()
    if not trimmed:
        return PdfTextFault.EMPTY
    # Sample the head rather than walk a 900-page book: the failure modes
    # are properties of the document's fonts and layout, not of one page.
    sample = trimmed[:20_000]
    if len(sample) < MIN_SAMPLE:
        return None
    # Any whitespace counts as a word break: one glyph per line still separates words.
    return _sample_fault(sample)


def should_reread_with_ocr(text: str) -> bool:
    """True when this text should be replaced by an OCR pass over the
    rendered pages. Named for the decision it drives.
    """
    return fault_in(text) is not None


def _choose_two_readings(extracted: str, ocr: str) -> str:
    """Prefer a sound reading, then the longer of two faulty readings."""
    if fault_in(extracted) is None:
        return extracted
    if fault_in(ocr) is None:
        return ocr
    # Both are poor: keep whichever has more readable content, so a
    # partial reading still beats nothing.
    return ocr if len(ocr.strip()) > len(extracted.strip()) else extracted


def choose(extracted: str | None, ocr: str | None) -> str | None:
    """Which of two readings of the same document to keep.

    OCR is not automatically better: on a clean, well-encoded PDF the
    embedded text is exact while Vision can misread a ligature or a digit.
    So the extracted text is kept unless it is FAULTY, and the OCR is kept
    only if it is not faulty itself -- a scan of a blank page must not
    replace real text with nothing.
    """
    if extracted is None:
        return ocr
    if ocr is None:
        return extracted
    return _choose_two_readings(extracted, ocr)


__all__ = [
    "MIN_SPACE_RATIO",
    "MAX_REPLACEMENT_RATIO",
    "MIN_READABLE_RATIO",
    "MIN_SAMPLE",
    "PdfTextFault",
    "extract_pdf",
    "is_heb_letter",
    "is_heb_mark",
    "strip_hebrew_marks",
    "looks_visual_hebrew",
    "fix_visual_hebrew",
    "fault_in",
    "should_reread_with_ocr",
    "choose",
]
