"""The pre-2007 Office formats: `.doc`, `.ppt`, `.xls`, `.ods`.

Port of `src-tauri/src/extraction/legacy.rs` (all 723 lines, including every
`#[cfg(test)]` case) plus `cp1252_char` from `extraction.rs` lines 550-564.

WHY THIS EXISTS: `.doc`/`.ppt`/`.xls`/`.ods` dropped into a room used to
import with no text at all -- invisible to search, RAG and the model, with
nothing on screen saying why. This reads them natively, with no bundled
native libraries.

MERGE NOTE: this file was assembled by judging two independently-written
candidate ports against each other and against the Rust source, then
combining the correct parts of each (see the sidecar task report for the
full account). Concretely:

- `.doc`/`.ppt` gates, the record walker, and the harvest sweep were
  identical in substance between the two candidates and match the Rust
  source directly.
- `_read_ole_stream` wraps `data` in `io.BytesIO` before handing it to
  `olefile.OleFileIO`. One candidate passed `data` (raw `bytes`) directly;
  `olefile`'s own docstring says a `bytes` value SHORTER than 1536 bytes is
  treated as a file PATH to open, not as file content -- confirmed against
  the installed `olefile` package. No genuinely well-formed OLE2 compound
  file can be that small (the mandatory header + FAT sector + directory
  sector alone total exactly 1536 bytes), so this cannot silently misread a
  real `.doc`/`.ppt` as *content* -- but it could misread a short,
  attacker-controlled byte string as a *path* and read an unrelated file
  from disk instead of correctly rejecting the input. Wrapping in
  `io.BytesIO` removes the ambiguity entirely, matching how the Rust `cfb`
  crate treats its input (a `Read + Seek` cursor over the given bytes,
  regardless of length).
- `.xls` boolean cells render as `"true"`/`"false"` (lowercase), matching
  Rust's `bool::to_string()` (`Data::Bool(b) => b.to_string()` in
  `extraction.rs`) exactly. One candidate used Python's `str(bool(x))`,
  which capitalizes (`"True"`/`"False"`) -- a real, verified divergence from
  the Rust source's actual output for any `.xls` sheet containing a boolean
  cell.
- `.ods` cell walking honours BOTH `table:number-columns-repeated` (a run of
  identical/blank cells) AND a merged cell's `table:covered-table-cell`
  continuation (walking `row.childNodes` for either local name, rather than
  `getElementsByType(TableCell)` alone, which silently drops
  `CoveredTableCell` elements entirely and shifts every subsequent cell in
  the row one column to the left -- verified directly against `odfpy`: a
  real `.ods` with ANY merged cell would misalign every cell after it).
  `table:number-rows-repeated` is ALSO expanded (capped, see
  `_MAX_ODS_REPEAT` below) -- verified against the vendored `calamine`
  0.36.1 source (`src/ods.rs`), which expands row-repeat up to its own
  `MAX_ROWS` bound when building the `Range`, so a literal one-`<table:row>`
  read regardless of its repeat count (which one candidate did, reasoning
  that real repeated-content rows are rare) is a real divergence from what
  the Rust source's own dependency actually does, not merely a stylistic
  choice.
- Truncation against `MAX_LEGACY_CHARS` is measured in UTF-8 BYTES
  (`_utf8_len`), matching Rust's `String::len()` exactly, not Python
  character count -- the two units only disagree for non-ASCII text, and
  only in exactly where a many-megabyte document's cut falls, never in
  whether truncation happens for a normal-sized file, but byte-exact is a
  closer port where it costs nothing.

------------------------------------------------------------------- .doc

macOS's own Word importer (`textutil.py`, the sibling module) goes first --
it is the SAME importer that draws the preview, so the words on screen and
the words in the search index come from one source. `textutil` answers even
when it has NOT understood the file: handed a compound file whose
`WordDocument` stream is not a real Word FIB, it echoes the file's own bytes
back, transcoded, with exit status 0. A genuine import is prose; the echo is
riddled with NULs -- `_is_clean_import` is that distinction, and it is far
more reliable than a length or score comparison (the echo contains the real
text too, so scoring can be won by the wrong answer). The harvest sweep
(`_harvest_runs`) is the fallback for a file `textutil` declined.

------------------------------------------------------------------- .ppt

A `.ppt` is an OLE compound file whose `PowerPoint Document` stream is a
tree of length-prefixed records (`_walk_ppt_records`). A record claiming a
length past the end of the buffer stops the WHOLE walk (not just that
record) -- a malformed/truncated deck must not be reinterpreted as records
from a wrong offset. Slide masters (`RT_MAIN_MASTER`) are boilerplate,
skipped whole; slides and notes become numbered/labelled buckets; a notes
bucket arriving before any numbered slide is the notes MASTER (also
boilerplate, since it belongs to no slide) and is dropped. The record walk
falls back to the harvest sweep for a deck whose records don't parse.

The harvest sweep tries BOTH a UTF-16LE reading and a CP1252 byte-wise
reading of the same stream and keeps whichever scores higher as prose
(`_prose_score`) -- scoring by length would pick the wrong one nearly every
time, because ASCII misread as UTF-16LE pairs two letters into one
CJK-range codepoint that encodes to three UTF-8 bytes, making the garbage
reading LONGER than the correct one.

------------------------------------------------------------------ xls / ods

Read directly with `xlrd` (`.xls` only -- xlrd 2.x dropped `.xlsx`, which is
exactly the format split this module wants) and `odfpy` (`.ods`, via
`odf.opendocument.load` + `odf.table` walking) -- there is no Python
calamine equivalent. Every sheet/table, every cell, tab-joined per row,
numbers rendered without a trailing `.0` (`_trim_float`); a row or sheet
with nothing but blank cells contributes nothing.

------------------------------------------------------------------ cp1252

`_CP1252_HIGH`/`_cp1252_char` is this module's OWN copy of the 32-entry
Windows-1252 high-byte table from `extraction.rs`'s `cp1252_char` -- not
imported from anywhere (there is no shared Rust-equivalent module on the
Python side); keep it in sync by hand if the Rust table ever changes.
"""

from __future__ import annotations

import unicodedata

from arcelle_sidecar.docs import textutil
from arcelle_sidecar.docs.legacy_common import utf8_len as _utf8_len
from arcelle_sidecar.docs.legacy_ole import (
    is_ole_compound as _is_ole_compound,
    olefile as olefile,
    read_ole_stream as _read_ole_stream,
)
from arcelle_sidecar.docs.legacy_spreadsheet import (
    _ods_cell_value as _ods_cell_value,
    _ods_row_values as _ods_row_values,
    _repeat_count as _repeat_count,
    _trim_float as _trim_float,
    _xls_cell_value as _xls_cell_value,
    extract_legacy_spreadsheet as _extract_legacy_spreadsheet,
    xlrd as xlrd,
)

# ------------------------------------------------------------------- shared

# The point past which any of this module's outputs stop growing, rather
# than quietly handing back an unbounded string to the caller.
MAX_LEGACY_CHARS: int = 8 * 1024 * 1024

# ------------------------------------------------------------------ xls / ods

def extract_legacy_spreadsheet(data: bytes, ext: str) -> str | None:
    """Extract a spreadsheet using the caller's live legacy-size ceiling."""
    return _extract_legacy_spreadsheet(data, ext, MAX_LEGACY_CHARS)


# ------------------------------------------------------------------------ doc

def _is_clean_import(s: str) -> bool:
    """True when textutil's answer reads as an imported DOCUMENT rather
    than as the input file's raw bytes handed back.

    A real conversion never contains a NUL, and essentially no other
    control characters either. A raw-byte echo of a compound file is
    mostly NUL padding with the document's text threaded through it --
    which is why it can look convincing in a terminal that strips control
    characters, and why this check exists rather than an eyeball
    comparison.
    """
    if not s or "\0" in s:
        return False
    total = len(s)
    control = sum(
        1 for c in s if unicodedata.category(c) == "Cc" and c not in ("\n", "\r", "\t")
    )
    return control * 100 < total


def extract_legacy_doc(name: str, data: bytes) -> str | None:
    """Text out of a Word 97-2003 `.doc`.

    macOS's own Word importer goes first -- the SAME importer that draws
    the preview, so the words on screen and the words in the search index
    come from one source. It answers even when it has NOT understood the
    file (handed a compound file whose `WordDocument` stream is not a real
    Word FIB, it echoes the file's own bytes back, transcoded, with exit
    status 0), which is exactly what `_is_clean_import` exists to catch: a
    genuine import is prose, the echo is riddled with NULs -- and that is a
    far more reliable signal than "which looks longer" or "which scores
    better", since the echo contains the real text too.
    """
    # TWO STRUCTURAL GATES, because `textutil` applies none of its own.
    # Handed arbitrary bytes in a file named `.doc` it echoes them straight
    # back as "text" and exits 0 -- so without these, any file renamed
    # `.doc` would put its raw bytes into the room's search index as the
    # document's prose.
    if not _is_ole_compound(data):
        return None

    imported = _imported_legacy_doc(name, data)
    if imported is not None:
        return imported

    return _harvested_legacy_doc(data)


def _imported_legacy_doc(name: str, data: bytes) -> str | None:
    imported = textutil.convert(name, data, "txt")
    if imported is None or not _is_clean_import(imported):
        return None
    resolved = textutil.resolve_field_codes(imported, False)
    return resolved if resolved.strip() else None


def _harvested_legacy_doc(data: bytes) -> str | None:
    """Fallback prose extraction after textutil declined the document.

    Requiring the `WordDocument` stream keeps "is this really a .doc" a
    structural question -- an OLE file that is something else entirely
    reads as nothing rather than as its own innards.
    """
    stream = _read_ole_stream(data, ["WordDocument"])
    if stream is None:
        return None
    text = _harvest_runs(stream)
    return text if text.strip() else None


# ------------------------------------------------------------------------ ppt

# Record types in the PowerPoint 97 binary format that this reader cares about.
RT_TEXT_CHARS = 0x0FA0  # UTF-16LE run
RT_TEXT_BYTES = 0x0FA8  # single-byte (CP1252) run
RT_SLIDE = 0x03EE
RT_NOTES = 0x03F0
RT_MAIN_MASTER = 0x03F8

# Containers nest, and a malformed file can claim to nest forever.
MAX_RECORD_DEPTH = 24


def extract_legacy_ppt(data: bytes) -> str | None:
    """Text out of a PowerPoint 97-2003 `.ppt`: a tree of length-prefixed
    records in the `PowerPoint Document` (or, rarely, `PP97_DUALSTORAGE`)
    stream. Slide masters are skipped whole; slides and notes are numbered
    and labelled.
    """
    stream = _read_ole_stream(data, ["PowerPoint Document", "PP97_DUALSTORAGE"])
    if stream is None:
        return None
    text = _ppt_records_to_text(stream)
    if text.strip():
        return text
    # A deck whose records don't parse still beats nothing.
    text = _harvest_runs(stream)
    return text if text.strip() else None


class _PptChunk:
    """One slide's (or one notes page's) text, in the order the records
    give it.
    """

    __slots__ = ("is_notes", "lines")

    def __init__(self, is_notes: bool) -> None:
        self.is_notes = is_notes
        self.lines: list[str] = []


def _ppt_records_to_text(stream: bytes) -> str:
    chunks: list[_PptChunk] = []
    _walk_ppt_records(stream, chunks, None, 0)
    return _render_ppt_chunks(chunks)


def _render_ppt_chunks(chunks: list[_PptChunk]) -> str:
    out: list[str] = []
    total_len = 0
    slide_no = 0
    for chunk in chunks:
        rendered = _renderable_ppt_chunk(chunk, slide_no)
        if rendered is None:
            continue
        header, body, slide_no = rendered
        total_len = _append_ppt_chunk(out, header, body, total_len)
        if total_len > MAX_LEGACY_CHARS:
            out.append("\n… (truncated)\n")
            break
    return "".join(out)


def _renderable_ppt_chunk(
    chunk: _PptChunk, slide_no: int
) -> tuple[str, str, int] | None:
    body = "\n".join(chunk.lines)
    # A notes page with nothing but the slide-number placeholder ("*"),
    # and any bucket with no actual words in it, is not content.
    if not any(character.isalnum() for character in body):
        return None
    if chunk.is_notes:
        # Notes belong to a slide; one arriving before any slide is the
        # notes MASTER, which is boilerplate like the slide master.
        if slide_no == 0:
            return None
        return f"[slide {slide_no} notes]\n", body, slide_no
    slide_no += 1
    return f"[slide {slide_no}]\n", body, slide_no


def _append_ppt_chunk(out: list[str], header: str, body: str, total_len: int) -> int:
    out.extend((header, body, "\n"))
    return total_len + _utf8_len(header) + _utf8_len(body) + 1


def _walk_ppt_records(
    buf: bytes,
    chunks: list[_PptChunk],
    into: int | None,
    depth: int,
) -> None:
    """Walk the record tree, collecting text atoms into the slide/notes
    container they belong to. `into` is the chunk currently being filled --
    text outside any slide (the document summary, the master's
    placeholders) has nowhere to go and is dropped, which is the entire
    point.
    """
    if depth > MAX_RECORD_DEPTH:
        return
    offset = 0
    while offset < len(buf):
        record = _ppt_record_at(buf, offset)
        if record is None:
            # A short header or a length past the buffer means the tree is
            # not what it claims. Stop rather than reinterpret the rest as
            # records.
            return
        ver_inst, rec_type, body, offset = record
        _visit_ppt_record(ver_inst, rec_type, body, chunks, into, depth)


def _ppt_record_at(buf: bytes, offset: int) -> tuple[int, int, bytes, int] | None:
    """Return the record at ``offset`` only when its full body is present."""
    if offset + 8 > len(buf):
        return None
    ver_inst = int.from_bytes(buf[offset : offset + 2], "little")
    rec_type = int.from_bytes(buf[offset + 2 : offset + 4], "little")
    rec_len = int.from_bytes(buf[offset + 4 : offset + 8], "little")
    body_start = offset + 8
    if rec_len > len(buf) - body_start:
        return None
    body_end = body_start + rec_len
    return ver_inst, rec_type, buf[body_start:body_end], body_end


def _visit_ppt_record(
    ver_inst: int,
    rec_type: int,
    body: bytes,
    chunks: list[_PptChunk],
    into: int | None,
    depth: int,
) -> None:
    if rec_type == RT_MAIN_MASTER:
        # Boilerplate the deck's author never wrote: skip the whole subtree.
        return
    if rec_type in (RT_SLIDE, RT_NOTES):
        _walk_ppt_chunk(rec_type, body, chunks, depth)
        return
    if rec_type in (RT_TEXT_CHARS, RT_TEXT_BYTES):
        _append_ppt_text(rec_type, body, chunks, into)
        return
    # 0xF in the low nibble marks a container; anything else is an atom
    # whose payload is not text.
    if ver_inst & 0x0F == 0x0F:
        _walk_ppt_records(body, chunks, into, depth + 1)
    # else: skipped -- body bytes are simply not visited further.


def _walk_ppt_chunk(
    rec_type: int, body: bytes, chunks: list[_PptChunk], depth: int
) -> None:
    chunks.append(_PptChunk(is_notes=(rec_type == RT_NOTES)))
    _walk_ppt_records(body, chunks, len(chunks) - 1, depth + 1)


def _append_ppt_text(
    rec_type: int, body: bytes, chunks: list[_PptChunk], into: int | None
) -> None:
    if into is None:
        return
    raw = _ppt_atom_text(rec_type, body)
    text = _ppt_clean(raw)
    if text.strip():
        chunks[into].lines.append(text)


def _ppt_atom_text(rec_type: int, body: bytes) -> str:
    if rec_type == RT_TEXT_CHARS:
        return _decode_utf16le_lossy(body)
    return "".join(c for c in (_cp1252_char(b) for b in body) if c is not None)


def _ppt_clean(s: str) -> str:
    """PowerPoint's in-text control characters, as a reader sees them: \\r
    ends a paragraph, \\v a line, and \\x0b/\\x0d appear interchangeably.
    """
    return "".join(filter(None, (_ppt_clean_character(character) for character in s))).rstrip()


def _ppt_clean_character(character: str) -> str | None:
    if character in ("\r", "\x0b"):
        return "\n"
    if _ppt_character_is_discarded(character):
        return None
    return character


def _ppt_character_is_discarded(character: str) -> bool:
    if character in ("\x00", "�"):
        return True
    return unicodedata.category(character) == "Cc" and character not in ("\n", "\t")


# ------------------------------------------------------------- harvest sweep

# A run has to be at least this many characters to count as prose. Below it,
# binary noise decodes into stray letter pairs that would pollute the index.
MIN_RUN = 4

# The longest run of letters that can still be a word. Beyond this it is an
# alphabet sweep, a base64 blob or a GUID -- the shapes binary regions of an
# Office file decode into.
MAX_WORD_LEN = 20


def _harvest_runs(stream: bytes) -> str:
    """Pull readable runs out of a stream that is mostly binary.

    Both encodings are tried because both appear: Word stores text as
    UTF-16LE (so ASCII letters alternate with NUL bytes) while
    PowerPoint's older text atoms are single-byte. The reading that looks
    more like PROSE wins -- scoring by length would be wrong, and wrong in
    a way that is easy to miss (see `_prose_score`): ASCII read as UTF-16LE
    pairs each two letters into one CJK codepoint, and those encode to
    THREE UTF-8 bytes each, so the garbage reading is longer in bytes than
    the correct one and a length comparison picks the garbage every time.
    """
    utf16 = _harvest_utf16(stream)
    ascii_text = _harvest_ascii(stream)
    return utf16 if _prose_score(utf16) >= _prose_score(ascii_text) else ascii_text


def _decode_utf16le_lossy(data: bytes) -> str:
    """Decode `data` as UTF-16LE code units the way Rust's
    `String::from_utf16_lossy` does: an odd trailing byte is not part of
    any whole code unit and is simply dropped (matching
    `chunks_exact(2)`), and any lone/unpaired surrogate becomes one U+FFFD
    rather than raising.
    """
    even = data[: len(data) - (len(data) % 2)]
    return even.decode("utf-16-le", errors="replace")


def _harvest_utf16(stream: bytes) -> str:
    text = _decode_utf16le_lossy(stream)
    out: list[str] = []
    out_len = 0
    run: list[str] = []
    for c in text:
        if _is_document_char(c):
            run.append(_normalize_control(c))
        else:
            out_len += _flush_run(run, out)
        if out_len > MAX_LEGACY_CHARS:
            break
    out_len += _flush_run(run, out)
    return "".join(out)


def _harvest_ascii(stream: bytes) -> str:
    out: list[str] = []
    out_len = 0
    run: list[str] = []
    for b in stream:
        # Windows-1252 covers the accented letters these files actually
        # carry; an undefined byte is not a character at all, so it is
        # dropped before the document-char check, not merely rejected by it.
        c = _cp1252_char(b)
        if c is not None and _is_document_char(c):
            run.append(_normalize_control(c))
        else:
            out_len += _flush_run(run, out)
        if out_len > MAX_LEGACY_CHARS:
            break
    out_len += _flush_run(run, out)
    return "".join(out)


def _flush_run(run: list[str], out: list[str]) -> int:
    """Keep `run` only if it has 4+ CHARACTERS (code points, not bytes) and
    at least one is alphanumeric; append it (stripped, plus a trailing
    newline) to `out` if so. Always clears `run` in place, mirroring the
    Rust `run.clear()` that happens unconditionally at the end of
    `flush_run`. Returns the number of UTF-8 BYTES just added to `out` (0 if
    the run was discarded), matching Rust's `out.len()` byte semantics, so
    callers can track a running total without re-encoding `out` on every
    character.
    """
    added = 0
    if len(run) >= MIN_RUN and any(c.isalnum() for c in run):
        piece = "".join(run).strip() + "\n"
        out.append(piece)
        added = _utf8_len(piece)
    run.clear()
    return added


def _is_document_char(c: str) -> bool:
    """Characters that belong to a document's text. Word uses \\r for a
    paragraph break and \\x07 for a cell/row end; \\x0b is a soft line
    break. `unicodedata.category(c) == "Cc"` is the Python equivalent of
    Rust's `char::is_control()` -- both mean the Unicode CONTROL category,
    not merely the ASCII control range (there are non-ASCII control
    characters too).
    """
    if c in ("\r", "\n", "\t", "\x0b", "\x07"):
        return True
    return unicodedata.category(c) != "Cc" and c != "�" and c != "\x00"


def _normalize_control(c: str) -> str:
    return "\n" if c in ("\r", "\x0b", "\x07") else c


def _prose_score(s: str) -> int:
    """How much a candidate reading looks like written language.

    Scores WORD STRUCTURE, not character volume: a binary region decoded
    byte-wise yields long unbroken sweeps that would beat a real sentence
    on any count-the-characters metric. Only runs short enough to be words
    score at all, and the whitespace BETWEEN them is weighted heavily,
    because separated words are the one thing every misreading destroys:
    ASCII misread as UTF-16 pairs letters into single ideographs, and
    UTF-16 misread as single bytes interleaves letters with control bytes.
    """
    score = 0
    word = 0
    for c in s:
        if c.isalnum():
            word += 1
            continue
        if word <= MAX_WORD_LEN:
            score += word
        word = 0
        if c.isspace():
            score += 4
    if word <= MAX_WORD_LEN:
        score += word
    return score


# Windows-1252 -- the code page `\ansi` RTF means by default, and the one
# Word and TextEdit actually write. 0x00-0x7F is ASCII and 0xA0-0xFF is
# Latin-1 (so the byte IS the code point); only 0x80-0x9F differ, and five
# of those are undefined.
#
# This module's OWN copy of `extraction.rs`'s `cp1252_char` table (lines
# 550-564) -- deliberately not imported from anywhere else, since there is
# no shared Rust-equivalent module on the Python side.
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
