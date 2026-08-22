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

import io
import unicodedata

import olefile
import xlrd
from odf.opendocument import load as _odf_load
from odf.table import Table, TableRow

from arcelle_sidecar.docs import textutil

try:
    import odf.teletype as _teletype
except ImportError:  # pragma: no cover - odfpy always ships this module
    _teletype = None

# ------------------------------------------------------------------- shared

# The point past which any of this module's outputs stop growing, rather
# than quietly handing back an unbounded string to the caller.
MAX_LEGACY_CHARS: int = 8 * 1024 * 1024

# The OLE Compound File magic -- the first eight bytes of every `.doc`,
# `.xls` and `.ppt` written before the 2007 XML formats.
_OLE_MAGIC = bytes((0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1))


def _utf8_len(s: str) -> int:
    """Byte length, matching Rust's `String::len()` (UTF-8 bytes), not
    Python's `len()` (code points). Every MAX_LEGACY_CHARS comparison below
    checks against this, exactly as the Rust source compares against
    `out.len()`.
    """
    return len(s.encode("utf-8"))


def _trim_float(f: float) -> str:
    """`12.0` reads as `12`, `12.5` stays `12.5` -- a spreadsheet of
    integers must not fill the search index with trailing zeros.

    `abs(f) < 1e15` is checked before `f == int(f)` so that NaN/infinity
    (for which `int(f)` raises) never reach the conversion: both already
    fail the magnitude check (comparisons against NaN are always False) and
    fall straight to `str(f)`, which is what the "everything else" branch
    wants for them anyway.
    """
    if abs(f) < 1e15 and f == int(f):
        return str(int(f))
    return str(f)


# ------------------------------------------------------------------ xls / ods

def extract_legacy_spreadsheet(data: bytes, ext: str) -> str | None:
    """`.xls` (via `xlrd`) and `.ods` (via `odfpy`), sheet by sheet, cell by
    cell, in the same tab-separated layout regardless of format so search
    behaves identically across both -- and across the xlsx reader
    elsewhere in this codebase.
    """
    if ext == "xls":
        sheets = _xls_sheets(data)
    elif ext == "ods":
        sheets = _ods_sheets(data)
    else:
        return None
    if sheets is None:
        return None

    out: list[str] = []
    total_len = 0
    for name, rows in sheets:
        # A sheet with nothing but empty cells contributes nothing -- not
        # even its own header line.
        if not any(any(cell.strip() for cell in row) for row in rows):
            continue
        header = f"--- {name} ---\n"
        out.append(header)
        total_len += _utf8_len(header)
        for row in rows:
            # A row of nothing but empty cells contributes nothing.
            if all(cell.strip() == "" for cell in row):
                continue
            line = "\t".join(row) + "\n"
            out.append(line)
            total_len += _utf8_len(line)
            if total_len > MAX_LEGACY_CHARS:
                out.append("\n… (truncated)\n")
                result = "".join(out)
                return result if result.strip() else None
    result = "".join(out)
    return result if result.strip() else None


def _xls_sheets(data: bytes) -> list[tuple[str, list[list[str]]]] | None:
    try:
        # `logfile=io.StringIO()` swallows xlrd's own warnings (it defaults
        # to printing them to stdout), which this sidecar's parent process
        # otherwise reads structured output from.
        book = xlrd.open_workbook(file_contents=data, logfile=io.StringIO())
    except Exception:
        return None
    sheets: list[tuple[str, list[list[str]]]] = []
    for sheet in book.sheets():
        rows = [
            [_xls_cell_value(cell, book.datemode) for cell in sheet.row(r)]
            for r in range(sheet.nrows)
        ]
        sheets.append((sheet.name, rows))
    return sheets


def _xls_cell_value(cell: xlrd.sheet.Cell, datemode: int) -> str:
    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return ""
    if cell.ctype == xlrd.XL_CELL_NUMBER:
        return _trim_float(float(cell.value))
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        # Matches Rust's `Data::Bool(b) => b.to_string()`, which renders
        # lowercase -- NOT Python's `str(bool(x))`, which capitalizes.
        return "true" if cell.value else "false"
    if cell.ctype == xlrd.XL_CELL_DATE:
        try:
            return str(xlrd.xldate_as_datetime(cell.value, datemode))
        except (xlrd.XLDateError, ValueError):
            return _trim_float(float(cell.value))
    if cell.ctype == xlrd.XL_CELL_ERROR:
        return xlrd.error_text_from_code.get(cell.value, str(cell.value))
    return str(cell.value)


# Real .ods files routinely compress a trailing run of identical (usually
# blank) cells or rows with `table:number-*-repeated` counts running into
# the tens of thousands (padding out to the sheet's nominal 1,048,576-row /
# 16,384-column boundary -- see calamine's own `MAX_ROWS`/`MAX_COLUMNS`,
# which it expands up to). Honouring that literally would turn one blank
# filler cell/row into a wall of tabs for no benefit, so both are expanded
# but capped here.
_MAX_ODS_REPEAT = 1024


def _repeat_count(raw: str | None) -> int:
    if raw is None:
        return 1
    try:
        n = int(raw)
    except ValueError:
        return 1
    return max(1, min(n, _MAX_ODS_REPEAT))


def _ods_sheets(data: bytes) -> list[tuple[str, list[list[str]]]] | None:
    try:
        doc = _odf_load(io.BytesIO(data))
    except Exception:
        return None
    sheets: list[tuple[str, list[list[str]]]] = []
    for tbl in doc.getElementsByType(Table):
        name = tbl.getAttribute("name") or ""
        rows: list[list[str]] = []
        for row_el in tbl.getElementsByType(TableRow):
            cells = _ods_row_values(row_el)
            repeat = _repeat_count(row_el.getAttribute("numberrowsrepeated"))
            for _ in range(repeat):
                rows.append(cells)
        sheets.append((name, rows))
    return sheets


def _ods_row_values(row) -> list[str]:
    """One row's cell values, in column order.

    `table:covered-table-cell` (the continuation of a merged cell) counts
    as a blank cell so a later real cell in the same row keeps its true
    column position -- walking `row.childNodes` directly (rather than
    `getElementsByType(TableCell)` alone) is what makes that possible, since
    odfpy models a covered cell as a distinct element type that a
    `TableCell`-only search silently skips.
    `table:number-columns-repeated` is expanded for the same column-position
    reason -- a common OASIS compression for runs of blank (or identical)
    cells.
    """
    values: list[str] = []
    for child in row.childNodes:
        local_name = child.qname[1] if hasattr(child, "qname") else None
        if local_name not in ("table-cell", "covered-table-cell"):
            continue
        value = _ods_cell_value(child)
        repeat = _repeat_count(child.getAttribute("numbercolumnsrepeated"))
        values.extend([value] * repeat)
    return values


def _ods_cell_value(cell) -> str:
    """A cell's value as text: the typed value for numbers/booleans/dates
    (via the `office:value-type`-keyed attribute ODF stores it under),
    else the cell's displayed text.
    """
    value_type = cell.getAttribute("valuetype")
    if value_type in ("float", "percentage", "currency"):
        raw = cell.getAttribute("value")
        if raw is not None:
            try:
                return _trim_float(float(raw))
            except ValueError:
                pass
    elif value_type == "boolean":
        raw = cell.getAttribute("booleanvalue")
        if raw is not None:
            return raw
    elif value_type == "date":
        raw = cell.getAttribute("datevalue")
        if raw is not None:
            return raw
    elif value_type == "time":
        raw = cell.getAttribute("timevalue")
        if raw is not None:
            return raw
    # "string" value-type, no value-type at all (a plain/empty cell), or a
    # typed attribute that was missing/unparseable: the displayed text IS
    # the value.
    return _teletype.extractText(cell) if _teletype is not None else str(cell)


# ------------------------------------------------------------------------ doc

def _is_ole_compound(data: bytes) -> bool:
    return data.startswith(_OLE_MAGIC)


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


# A stream is never read past this many bytes, however large the compound
# file claims it to be. `olefile`'s `OleStream` reads the entire declared
# stream into memory up front (there is no lazy/streaming read the way the
# Rust `cfb` crate's `Stream: Read` impl allows `.take()` to bound), so this
# slice is applied AFTER materialisation -- bounded in practice by the
# file's own actual size, since a stream cannot claim more sectors than the
# file's real FAT provides without `olefile` raising, but peak memory can
# briefly exceed this cap for a very large legacy file where Rust's
# `.take(cap)` never would. A real but low-impact library-boundary gap.
_MAX_OLE_STREAM_BYTES = 200 * 1024 * 1024


def _read_ole_stream(data: bytes, names: list[str]) -> bytes | None:
    """Read the first of `names` that exists in the compound file.

    `data` is always wrapped in `io.BytesIO` before reaching `olefile`:
    passed raw, `olefile.OleFileIO` treats a `bytes` value SHORTER than its
    own internal 1536-byte threshold as a file PATH, not file content
    (confirmed against the installed `olefile` package's own docstring and
    behaviour) -- exactly the size range a short or malformed input can
    fall into. No well-formed OLE2 file is ever that small (the mandatory
    header + FAT sector + directory sector alone total exactly 1536 bytes),
    so this only ever matters for input that isn't a real compound file
    anyway -- but without the wrapper, such input would be handed to the
    filesystem as a path (potentially reading an unrelated file from disk)
    rather than cleanly failing to parse as one, the way the Rust `cfb`
    crate always treats its input as bytes regardless of length.

    Stream lookups in both `olefile` and the `cfb` crate are
    case-INSENSITIVE, per the MS-CFB spec's own name-ordering rule (`cfb`'s
    `compare_names` upper-cases before comparing; `olefile`'s `_find`
    lower-cases) -- so plain `exists`/`openstream` on the bare name is
    already exactly equivalent to the Rust side; no extra case handling
    needed here.
    """
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except Exception:
        return None
    try:
        for name in names:
            if not ole.exists(name):
                continue
            try:
                stream = ole.openstream(name)
            except Exception:
                # `exists` is true for a storage too; only a stream opens.
                continue
            return stream.read(_MAX_OLE_STREAM_BYTES)
        return None
    finally:
        ole.close()


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

    imported = textutil.convert(name, data, "txt")
    if imported is not None and _is_clean_import(imported):
        resolved = textutil.resolve_field_codes(imported, False)
        if resolved.strip():
            return resolved

    # The sweep, for a file macOS declined. Requiring the `WordDocument`
    # stream keeps "is this really a .doc" a structural question -- an OLE
    # file that is something else entirely reads as nothing rather than as
    # its own innards.
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

    out: list[str] = []
    total_len = 0
    slide_no = 0
    for chunk in chunks:
        body = "\n".join(chunk.lines)
        # A notes page with nothing but the slide-number placeholder ("*"),
        # and any bucket with no actual words in it, is not content.
        if not any(c.isalnum() for c in body):
            continue
        if chunk.is_notes:
            # Notes belong to a slide; one arriving before any slide is the
            # notes MASTER, which is boilerplate like the slide master.
            if slide_no == 0:
                continue
            header = f"[slide {slide_no} notes]\n"
        else:
            slide_no += 1
            header = f"[slide {slide_no}]\n"
        out.append(header)
        out.append(body)
        out.append("\n")
        total_len += _utf8_len(header) + _utf8_len(body) + 1
        if total_len > MAX_LEGACY_CHARS:
            out.append("\n… (truncated)\n")
            break
    return "".join(out)


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
    i = 0
    n = len(buf)
    while i + 8 <= n:
        ver_inst = int.from_bytes(buf[i : i + 2], "little")
        rec_type = int.from_bytes(buf[i + 2 : i + 4], "little")
        rec_len = int.from_bytes(buf[i + 4 : i + 8], "little")
        i += 8
        # A length past the end of the buffer means the tree is not what it
        # claims; stop rather than reinterpret the rest as records.
        if rec_len > n - i:
            return
        body = buf[i : i + rec_len]
        i += rec_len

        if rec_type == RT_MAIN_MASTER:
            # Boilerplate the deck's author never wrote: skip the whole
            # subtree.
            continue
        if rec_type == RT_SLIDE or rec_type == RT_NOTES:
            chunks.append(_PptChunk(is_notes=(rec_type == RT_NOTES)))
            idx = len(chunks) - 1
            _walk_ppt_records(body, chunks, idx, depth + 1)
            continue
        if rec_type == RT_TEXT_CHARS or rec_type == RT_TEXT_BYTES:
            if into is None:
                continue
            if rec_type == RT_TEXT_CHARS:
                raw = _decode_utf16le_lossy(body)
            else:
                raw = "".join(c for c in (_cp1252_char(b) for b in body) if c is not None)
            text = _ppt_clean(raw)
            if text.strip():
                chunks[into].lines.append(text)
            continue
        # 0xF in the low nibble marks a container; anything else is an atom
        # whose payload is not text.
        if ver_inst & 0x0F == 0x0F:
            _walk_ppt_records(body, chunks, into, depth + 1)
        # else: skipped -- body bytes are simply not visited further.


def _ppt_clean(s: str) -> str:
    """PowerPoint's in-text control characters, as a reader sees them: \\r
    ends a paragraph, \\v a line, and \\x0b/\\x0d appear interchangeably.
    """
    out: list[str] = []
    for c in s:
        if c == "\r" or c == "\x0b":
            out.append("\n")
        elif c == "\x00" or c == "�":
            continue
        elif unicodedata.category(c) == "Cc" and c != "\n" and c != "\t":
            continue
        else:
            out.append(c)
    return "".join(out).rstrip()


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
