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


def looks_visual_hebrew(text: str) -> bool:
    """Detect visual-order Hebrew from its signature artifact: clusters
    emitted as `space + mark(s) + base`, i.e. combining marks that FOLLOW a
    space. In logical Hebrew a mark virtually never follows a space (it
    always follows its base letter); in visual-order output most clusters
    do. Scans at most the first 400,000 characters -- the failure mode is a
    document-wide property, not something that needs a full multi-megabyte
    book read.
    """
    letters = 0
    orphan_marks = 0
    prev_space = False
    for c in text[:400_000]:
        if is_heb_letter(c):
            letters += 1
        elif is_heb_mark(c) and prev_space:
            orphan_marks += 1
        prev_space = c.isspace()
    return letters > 200 and orphan_marks > 50 and orphan_marks * 20 > letters


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
        heb = sum(1 for c in line if is_heb_letter(c))
        if heb < 2:
            out_lines.append(line)
            continue

        # 1. Mirror the line back to logical order.
        chars: list[str] = list(reversed(line))

        # 2. Digit/Latin runs got mirrored too ("13" -> "31") -- flip them back.
        j = 0
        while j < len(chars):
            if _is_ascii_alnum(chars[j]):
                start = j
                while j < len(chars) and _is_ascii_alnum(chars[j]):
                    j += 1
                chars[start:j] = list(reversed(chars[start:j]))
            else:
                j += 1

        # 3. Clusters the extractor emitted as (base, mark) are now
        #    (mark, base) -- move any mark-run that sits after a space/start
        #    and directly before a letter back behind that letter.
        fixed: list[str] = []
        j = 0
        while j < len(chars):
            at_boundary = not fixed or not (is_heb_letter(fixed[-1]) or is_heb_mark(fixed[-1]))
            if at_boundary and is_heb_mark(chars[j]):
                start = j
                while j < len(chars) and is_heb_mark(chars[j]):
                    j += 1
                if j < len(chars) and is_heb_letter(chars[j]):
                    fixed.append(chars[j])
                    fixed.extend(chars[start:j])
                    j += 1
                else:
                    fixed.extend(chars[start:j])
            else:
                fixed.append(chars[j])
                j += 1

        # 4. Spaces: a single space was a glyph-cluster gap INSIDE a word --
        #    drop it when it sits between Hebrew text on both sides; runs of
        #    2+ spaces were the real word separators.
        cleaned: list[str] = []
        j = 0
        while j < len(fixed):
            if fixed[j] == " ":
                start = j
                while j < len(fixed) and fixed[j] == " ":
                    j += 1
                run = j - start
                prev_heb = bool(cleaned) and (is_heb_letter(cleaned[-1]) or is_heb_mark(cleaned[-1]))
                next_heb = j < len(fixed) and (is_heb_letter(fixed[j]) or is_heb_mark(fixed[j]))
                if run >= 2 or not (prev_heb and next_heb):
                    cleaned.append(" ")
                # else: intra-word cluster gap -- dropped.
            else:
                cleaned.append(fixed[j])
                j += 1

        out_lines.append("".join(cleaned))

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
    total = len(sample)

    replacement = sum(1 for c in sample if c == "�")
    if replacement / total > MAX_REPLACEMENT_RATIO:
        return PdfTextFault.UNDECODABLE

    readable = sum(
        1
        for c in sample
        if c.isalnum() or c.isspace() or c in _ASCII_PUNCTUATION or c in _HEB_OTHER_ALPHABETIC
    )
    if readable / total < MIN_READABLE_RATIO:
        return PdfTextFault.NOT_LANGUAGE

    # Word breaks: any whitespace counts, since a reader that emits one
    # glyph per line still separates its words.
    spaces = sum(1 for c in sample if c.isspace())
    if spaces / total < MIN_SPACE_RATIO:
        return PdfTextFault.NO_WORD_BREAKS

    return None


def should_reread_with_ocr(text: str) -> bool:
    """True when this text should be replaced by an OCR pass over the
    rendered pages. Named for the decision it drives.
    """
    return fault_in(text) is not None


def choose(extracted: str | None, ocr: str | None) -> str | None:
    """Which of two readings of the same document to keep.

    OCR is not automatically better: on a clean, well-encoded PDF the
    embedded text is exact while Vision can misread a ligature or a digit.
    So the extracted text is kept unless it is FAULTY, and the OCR is kept
    only if it is not faulty itself -- a scan of a blank page must not
    replace real text with nothing.
    """
    if extracted is not None and ocr is not None:
        if fault_in(extracted) is None:
            return extracted
        if fault_in(ocr) is None:
            return ocr
        # Both are poor: keep whichever has more readable content, so a
        # partial reading still beats nothing.
        if len(ocr.strip()) > len(extracted.strip()):
            return ocr
        return extracted
    if extracted is not None:
        return extracted
    if ocr is not None:
        return ocr
    return None


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
