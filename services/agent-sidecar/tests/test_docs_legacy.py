"""Tests for `arcelle_sidecar.docs.legacy` (port of
`src-tauri/src/extraction/legacy.rs`, all 723 lines including every
`#[cfg(test)]` case, plus `cp1252_char` from `extraction.rs`).

This file is the merge of two independently-written candidate test suites
(`test_docs_legacy_candidate_a.py` / `test_docs_legacy_candidate_b.py`,
judged and retired -- see the sidecar task report), plus new regression
tests for three real bugs the judging process found: one in each candidate,
and one only visible once both were compared against the Rust source's own
dependencies (calamine).

This repo has no OLE-compound-file WRITER library, so `_ole_with` is a
from-scratch, minimal, real OLE2/CFB v3 writer (512-byte sectors) -- mirrors
the Rust test suite's own `ole_with` helper, which leans on the `cfb`
crate's writer. Every stream it writes is padded to at least 4096 bytes
(the mandatory MiniFAT cutoff) so `olefile` always reads it from the plain
FAT chain rather than the MiniFAT/mini-stream mechanism, which this minimal
writer does not implement.

`_make_doc` shells out to the real `/usr/bin/textutil` on this Mac,
mirroring the Rust suite's own `make_doc` helper, for the two tests that
must go through the REAL textutil import path rather than the OLE stream
sweep -- skipping (not failing) if textutil is unavailable, though it
genuinely runs on this Mac.
"""

from __future__ import annotations

import io
import struct
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from arcelle_sidecar.docs import legacy

# --------------------------------------------------------------- OLE builder

_SECTOR_SIZE = 512
_FREESECT = 0xFFFFFFFF
_ENDOFCHAIN = 0xFFFFFFFE
_FATSECT = 0xFFFFFFFD
_NOSTREAM = 0xFFFFFFFF
# The mandatory MS-CFB "Mini Stream Cutoff Size" -- `olefile` coerces any
# other value back to this (with a warning) rather than honouring it, so
# every stream this helper writes is padded to at least this size and
# always lands in the plain FAT chain rather than the MiniFAT this minimal
# writer does not implement.
_MINI_STREAM_CUTOFF = 0x1000


def _dir_entry(
    name: str,
    entry_type: int,
    sid_left: int,
    sid_right: int,
    sid_child: int,
    isect_start: int,
    size: int,
) -> bytes:
    """One 128-byte MS-CFB directory entry, matching the exact struct
    `olefile.OleDirectoryEntry` parses entries with
    (`'<64sHBBIII16sIQQIII'`) byte for byte.
    """
    name_bytes = (name + "\x00").encode("utf-16-le") if name else b""
    name_field = name_bytes.ljust(64, b"\x00")
    return struct.pack(
        "<64sHBBIII16sIQQIII",
        name_field,
        len(name_bytes),
        entry_type,
        1,  # colour (red/black tree balance only, irrelevant to lookup)
        sid_left,
        sid_right,
        sid_child,
        b"\x00" * 16,  # CLSID
        0,  # user flags
        0,  # create time
        0,  # modify time
        isect_start,
        size & 0xFFFFFFFF,
        0,  # size high (512-byte sectors only ever use the low 32 bits)
    )


def _ole_with(name: str, payload: bytes) -> bytes:
    """Build a minimal, real OLE2/CFB v3 compound file with exactly one
    named stream at the root -- the shape a real `.doc`/`.ppt` has. Mirrors
    the Rust test suite's own `ole_with` helper (`cfb::CompoundFile`).
    """
    size = max(len(payload), _MINI_STREAM_CUTOFF)
    n_sectors = (size + _SECTOR_SIZE - 1) // _SECTOR_SIZE
    physical_size = n_sectors * _SECTOR_SIZE
    content = payload.ljust(physical_size, b"\x00")

    fat = [_FREESECT] * 128
    fat[0] = _FATSECT  # sector 0 (this sector) holds the FAT
    fat[1] = _ENDOFCHAIN  # sector 1 (directory) is a single-sector chain
    for i in range(n_sectors):
        fat[2 + i] = (2 + i + 1) if i + 1 < n_sectors else _ENDOFCHAIN
    fat_sector = b"".join(struct.pack("<I", v) for v in fat)

    root = _dir_entry("Root Entry", 5, _NOSTREAM, _NOSTREAM, 1, _ENDOFCHAIN, 0)
    stream_entry = _dir_entry(name, 2, _NOSTREAM, _NOSTREAM, _NOSTREAM, 2, size)
    empty = b"\x00" * 128
    dir_sector = root + stream_entry + empty + empty

    header = struct.pack(
        "<8s16sHHHHHHLLLLLLLLLL",
        bytes((0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)),
        b"\x00" * 16,  # header CLSID
        0x003E,  # minor version
        3,  # dll version -> 512-byte sectors
        0xFFFE,  # byte order
        9,  # sector shift -> 512
        6,  # mini sector shift -> 64
        0,  # reserved
        0,  # reserved
        0,  # number of directory sectors (must be 0 for 512-byte sectors)
        1,  # number of FAT sectors
        1,  # first directory sector
        0,  # transaction signature
        _MINI_STREAM_CUTOFF,
        _ENDOFCHAIN,  # first MiniFAT sector (unused)
        0,  # number of MiniFAT sectors
        _ENDOFCHAIN,  # first DIFAT sector (unused)
        0,  # number of DIFAT sectors
    ) + struct.pack("<I", 0) + struct.pack("<I", _FREESECT) * 108

    return header + fat_sector + dir_sector + content


def _utf16le(s: str) -> bytes:
    return s.encode("utf-16-le")


def _rec(ver_inst: int, rec_type: int, body: bytes) -> bytes:
    """A PowerPoint record: 2-byte ver/instance, 2-byte type, 4-byte length."""
    return (
        struct.pack("<H", ver_inst)
        + struct.pack("<H", rec_type)
        + struct.pack("<I", len(body))
        + body
    )


def _container(rec_type: int, body: bytes) -> bytes:
    return _rec(0x000F, rec_type, body)


def _text_chars(s: str) -> bytes:
    return _rec(0, legacy.RT_TEXT_CHARS, _utf16le(s))


def _make_doc(rtf: bytes) -> bytes | None:
    """Author a genuine Word 97 file from RTF using macOS's own converter,
    mirroring the Rust test suite's `make_doc` helper exactly.
    """
    if not Path("/usr/bin/textutil").exists():
        return None
    stem = uuid.uuid4()
    tmp_dir = Path(tempfile.gettempdir())
    src = tmp_dir / f"arcelle-test-{stem}.rtf"
    dst = tmp_dir / f"arcelle-test-{stem}.doc"
    try:
        src.write_bytes(rtf)
        import subprocess

        proc = subprocess.run(
            ["/usr/bin/textutil", "-convert", "doc", "-output", str(dst), str(src)],
            capture_output=True,
        )
        if proc.returncode != 0 or not dst.exists():
            return None
        return dst.read_bytes()
    finally:
        src.unlink(missing_ok=True)
        dst.unlink(missing_ok=True)


# ------------------------------------------------------------------------ doc


def test_a_word_97_document_gives_up_its_prose() -> None:
    # The fallback sweep, exercised directly: textutil declines a stream
    # that is not really a .doc, so this is the path that answers.
    payload = bytes((0xEC, 0xA5, 0xC1, 0x00, 0x00, 0x00))
    payload += _utf16le("The lease fee is 5% per annum.\rSigned in Tel Aviv.\r")
    payload += bytes((0x00, 0x01, 0x02, 0x03))
    data = _ole_with("WordDocument", payload)
    text = legacy.extract_legacy_doc("lease.doc", data)
    assert text is not None, "no text from .doc"
    assert "The lease fee is 5% per annum." in text, text
    assert "Signed in Tel Aviv." in text, text


def test_accented_and_hebrew_text_survives() -> None:
    # The whole point of preferring the UTF-16 harvest: these are the
    # characters a byte-wise reader mangles.
    data = _ole_with("WordDocument", _utf16le("Le siège social\rחוזה שכירות\r"))
    text = legacy.extract_legacy_doc("x.doc", data)
    assert text is not None, "no text"
    assert "Le siège social" in text, text
    assert "חוזה שכירות" in text, text


def test_binary_noise_does_not_reach_the_index() -> None:
    # Short accidental runs are what make a naive strings() dump useless.
    payload = bytes(range(256))
    payload += _utf16le("Genuine sentence of prose here.")
    data = _ole_with("WordDocument", payload)
    text = legacy.extract_legacy_doc("x.doc", data)
    assert text is not None, "no text"
    assert "Genuine sentence of prose here." in text, text
    # The 0..255 sweep contains no 4+ character alphanumeric run in UTF-16.
    for junk in ("abcdefgh", "!\"#$%&'"):
        assert junk not in text, f"binary noise leaked: {text}"


def test_doc_prefers_a_clean_textutil_import_with_resolved_fields(monkeypatch) -> None:
    data = _ole_with("WordDocument", _utf16le("Fallback prose must not win."))
    monkeypatch.setattr(legacy.textutil, "convert", lambda *_: "Clean imported prose")
    monkeypatch.setattr(
        legacy.textutil, "resolve_field_codes", lambda imported, _: f"resolved: {imported}"
    )

    assert legacy.extract_legacy_doc("x.doc", data) == "resolved: Clean imported prose"


def test_doc_falls_back_when_textutil_echo_is_not_clean(monkeypatch) -> None:
    data = _ole_with("WordDocument", _utf16le("Fallback prose survives."))
    monkeypatch.setattr(legacy.textutil, "convert", lambda *_: "raw\x00 bytes echoed")

    text = legacy.extract_legacy_doc("x.doc", data)
    assert text is not None
    assert "Fallback prose survives." in text


def test_a_genuine_word_97_file_reads_as_prose_not_as_its_font_table() -> None:
    # THE REGRESSION THIS PINS: live QA opened a real Word 97 file and the
    # editor showed "Times New Roman / Arial / Droid Sans Fallback /
    # WenQuanYi Zen Hei" and then mojibake -- the font table and binary
    # noise, indexed and shown as if they were the document.
    #
    # The fixture is a REAL .doc rather than a hand-built stream, which is
    # the whole point: every test above passes on a synthetic stream, and
    # the bug only ever appeared on a file Word actually wrote.
    rtf = (
        rb"{\rtf1\ansi{\fonttbl\f0\froman Times New Roman;}\f0\fs24 "
        rb"Lorem ipsum dolor sit amet, consectetur adipiscing elit."
        rb"\par Second paragraph of ordinary prose.\par}"
    )
    doc = _make_doc(rtf)
    if doc is None:
        pytest.skip("textutil could not author a .doc here")
    text = legacy.extract_legacy_doc("authored.doc", doc)
    assert text is not None, "no text from a real .doc"
    assert "Lorem ipsum dolor sit amet" in text, f"prose missing: {text!r}"
    assert "Second paragraph of ordinary prose." in text, f"prose missing: {text!r}"
    for junk in ("Times New Roman", "froman", "fonttbl"):
        assert junk not in text, f"the font table reached the index: {text!r}"


def test_a_hyperlink_field_in_a_real_doc_does_not_reach_the_index_as_a_field_code() -> None:
    # Live QA: the reader showed `HYPERLINK "https://products.office.com/..."`
    # as literal prose, and the same string was the file's indexed text.
    rtf = (
        rb"{\rtf1\ansi\f0\fs24 See {\field{\*\fldinst{HYPERLINK "
        rb'"https://example.com/page"}}{\fldrslt{the page}}} for details.\par}'
    )
    doc = _make_doc(rtf)
    if doc is None:
        pytest.skip("textutil could not author a .doc here")
    text = legacy.extract_legacy_doc("linked.doc", doc)
    assert text is not None, "no text"
    assert "HYPERLINK" not in text, f"the field code leaked: {text!r}"
    assert "for details" in text, f"prose was eaten: {text!r}"


def test_a_non_word_file_renamed_doc_never_imports_its_own_bytes_as_text() -> None:
    # `textutil` does not validate its input: handed arbitrary bytes in a
    # file named `.doc` it echoes them back and exits 0. Without the
    # compound-file gate, renaming ANY file to `.doc` would put its raw
    # bytes into the room's search index as the document's prose.
    disguised = b"\x7fELF\x02\x01\x01\x00 this is a binary, not a document"
    assert legacy.extract_legacy_doc("trojan.doc", disguised) is None
    # A text file renamed .doc is the same mistake, quieter.
    assert legacy.extract_legacy_doc("notes.doc", b"just some plain text here") is None


def test_a_file_that_is_not_a_compound_file_reads_as_nothing() -> None:
    assert legacy.extract_legacy_doc("x.doc", b"not an OLE file at all") is None
    assert legacy.extract_legacy_ppt(bytes(64)) is None


def test_an_ole_file_without_the_expected_stream_reads_as_nothing() -> None:
    data = _ole_with("SomethingElse", _utf16le("text that is not in WordDocument"))
    assert legacy.extract_legacy_doc("x.doc", data) is None


def test_short_input_is_never_misread_as_a_filesystem_path(tmp_path: Path) -> None:
    # REGRESSION: one of the two judged candidates passed `data` (raw
    # `bytes`) straight to `olefile.OleFileIO`. `olefile`'s own docstring
    # says a `bytes` value SHORTER than 1536 bytes is treated as a file
    # PATH to open, not as file content (confirmed against the installed
    # package) -- so a short byte string that happens to spell out a real,
    # existing file's path gets that UNRELATED file opened and parsed
    # instead of the caller's own bytes. Prove it: put a genuine small OLE2
    # file with a recognizable secret on disk, then hand `_read_ole_stream`
    # nothing but that file's path AS BYTES (well under the 1536-byte
    # threshold, and not a valid OLE header itself). A correct
    # implementation parses those bytes as content, finds no OLE header,
    # and returns None; an implementation that treats them as a path opens
    # and returns the unrelated file's real stream -- reproduced directly
    # against the unfixed candidate before this test was written.
    secret_ole = _ole_with("WordDocument", b"SECRET_DISK_CONTENT_MARKER should never leak")
    real_file = tmp_path / "real-ole-file.doc"
    real_file.write_bytes(secret_ole)
    data = str(real_file).encode()
    assert len(data) < 1536, "fixture must stay under olefile's path-vs-content threshold"

    stream = legacy._read_ole_stream(data, ["WordDocument"])
    assert stream is None, (
        "a path-shaped byte string must never be resolved against the filesystem"
    )


# ------------------------------------------------------------------------ ppt


def test_a_powerpoint_97_deck_gives_up_its_slide_text_numbered() -> None:
    slide = _container(legacy.RT_SLIDE, _text_chars("Quarterly review\rRevenue is up 12%.\r"))
    data = _ole_with("PowerPoint Document", slide)
    text = legacy.extract_legacy_ppt(data)
    assert text is not None, "no text from .ppt"
    assert "Quarterly review" in text, text
    assert "Revenue is up 12%." in text, text
    # Numbered exactly as a .pptx is, so a citation means the same thing.
    assert "[slide 1]" in text, f"slides are not numbered: {text}"


def test_the_slide_master_boilerplate_never_reaches_the_text() -> None:
    # A real deck's master carries the placeholder prompts PowerPoint shows
    # in its own editor. The sweep this replaced returned them as content --
    # live QA saw "Click to edit the title text format" above the deck.
    master = _container(legacy.RT_MAIN_MASTER, _text_chars("Click to edit the title text format"))
    slide = _container(legacy.RT_SLIDE, _text_chars("The actual headline"))
    stream = master + slide
    text = legacy.extract_legacy_ppt(_ole_with("PowerPoint Document", stream))
    assert text is not None, "no text"
    assert "The actual headline" in text, text
    assert "Click to edit" not in text, f"master boilerplate leaked: {text}"


def test_speaker_notes_are_labelled_and_attached_to_their_slide() -> None:
    stream = _container(legacy.RT_SLIDE, _text_chars("Headline one"))
    stream += _container(legacy.RT_NOTES, _text_chars("Say the number out loud."))
    stream += _container(legacy.RT_SLIDE, _text_chars("Headline two"))
    text = legacy.extract_legacy_ppt(_ole_with("PowerPoint Document", stream))
    assert text is not None, "no text"
    assert "[slide 1 notes]" in text, f"notes unlabelled: {text}"
    assert "Say the number out loud." in text, text
    assert "[slide 2]" in text, f"numbering broke after notes: {text}"


def test_a_notes_master_arriving_before_any_slide_is_dropped() -> None:
    # The notes MASTER is a Notes container with nothing but the slide
    # number placeholder in it; it belongs to no slide.
    stream = _container(legacy.RT_NOTES, _text_chars("*\r*\r*\r"))
    stream += _container(legacy.RT_SLIDE, _text_chars("Real content"))
    text = legacy.extract_legacy_ppt(_ole_with("PowerPoint Document", stream))
    assert text is not None, "no text"
    assert "notes]" not in text, f"the notes master was kept: {text}"
    assert "Real content" in text, text


def test_single_byte_text_atoms_are_read_as_single_bytes() -> None:
    # Older decks store runs as CP1252, not UTF-16.
    atom = _rec(0, legacy.RT_TEXT_BYTES, b"Single byte text atoms throughout.")
    data = _ole_with("PowerPoint Document", _container(legacy.RT_SLIDE, atom))
    text = legacy.extract_legacy_ppt(data)
    assert text is not None, "no text"
    assert "Single byte text atoms throughout." in text, text


def test_ppt_clean_keeps_visible_spacing_and_drops_binary_controls() -> None:
    cleaned = legacy._ppt_clean("one\rtwo\x0bthree\x00four�five\x1esix\nseven\teight")
    assert cleaned == "one\ntwo\nthreefourfivesix\nseven\teight"


def test_ppt_rendering_drops_notes_master_and_marks_an_overflow(monkeypatch) -> None:
    notes_master = legacy._PptChunk(is_notes=True)
    notes_master.lines.append("Master notes must not appear")
    placeholder = legacy._PptChunk(is_notes=False)
    placeholder.lines.append("*")
    slide = legacy._PptChunk(is_notes=False)
    slide.lines.append("Visible slide")
    notes = legacy._PptChunk(is_notes=True)
    notes.lines.append("Visible notes")

    rendered = legacy._render_ppt_chunks([notes_master, placeholder, slide, notes])
    assert rendered == "[slide 1]\nVisible slide\n[slide 1 notes]\nVisible notes\n"

    monkeypatch.setattr(legacy, "MAX_LEGACY_CHARS", 1)
    assert legacy._render_ppt_chunks([slide]) == "[slide 1]\nVisible slide\n\n… (truncated)\n"


def test_a_record_claiming_a_length_past_the_buffer_stops_the_walk() -> None:
    # A malformed or truncated deck must not be reinterpreted as records.
    stream = _container(legacy.RT_SLIDE, _text_chars("Good slide"))
    stream += bytes((0x00, 0x00, 0xEE, 0x03, 0xFF, 0xFF, 0xFF, 0x7F))
    text = legacy.extract_legacy_ppt(_ole_with("PowerPoint Document", stream))
    assert text is not None, "no text"
    assert "Good slide" in text, text


def test_ppt_record_walk_drops_root_text_and_stops_at_a_partial_header() -> None:
    # Document-summary atoms belong to no slide, and a trailing partial
    # header is not a new record. Both must leave the chunk list untouched.
    chunks: list[legacy._PptChunk] = []
    legacy._walk_ppt_records(_text_chars("Deck title") + bytes(7), chunks, None, 0)
    assert chunks == []


def test_deeply_nested_containers_cannot_run_away_with_the_stack() -> None:
    body = _text_chars("deep")
    for _ in range(200):
        body = _container(0x0FF0, body)
    # Must return rather than blow the recursion stack; the text is past
    # the depth limit so nothing more than "doesn't crash" is asserted.
    legacy.extract_legacy_ppt(_ole_with("PowerPoint Document", body))


def test_single_byte_text_wins_over_its_own_utf16_garbage() -> None:
    # Older PowerPoint text atoms are single-byte. Read as UTF-16LE the
    # same bytes decode to CJK ideographs, each THREE UTF-8 bytes -- so the
    # garbage reading is LONGER than the correct one and a length
    # comparison picks it. This pins the fallback sweep's scoring.
    payload = b"This deck was written with single byte text atoms throughout."
    data = _ole_with("PowerPoint Document", payload)
    text = legacy.extract_legacy_ppt(data)
    assert text is not None, "no text"
    assert "single byte text atoms" in text, text


def test_prose_outscores_its_own_misdecoding_in_both_directions() -> None:
    ascii_text = "This deck was written with single byte text atoms throughout."
    as_utf16_garbage = legacy._harvest_utf16(ascii_text.encode())
    assert legacy._prose_score(ascii_text) > legacy._prose_score(as_utf16_garbage), (
        f"ASCII lost to its CJK misreading: {as_utf16_garbage!r}"
    )
    # ...and the other way: real UTF-16 text read byte-wise is fragments.
    utf16 = _utf16le("A properly encoded sentence of ordinary prose.")
    assert legacy._prose_score(legacy._harvest_utf16(utf16)) > legacy._prose_score(
        legacy._harvest_ascii(utf16)
    ), "UTF-16 lost to its byte-wise misreading"


def test_whitespace_is_what_separates_prose_from_noise() -> None:
    # The signal the score rests on, asserted directly.
    assert legacy._prose_score("the quick brown fox") > legacy._prose_score("thequickbrownfox")


# ------------------------------------------------------------------ trim_float


def test_whole_number_cells_do_not_gain_a_decimal_tail() -> None:
    # A sheet of integers rendered as "12.0" pollutes both the index and
    # anything the model reads back.
    assert legacy._trim_float(12.0) == "12"
    assert legacy._trim_float(12.5) == "12.5"
    assert legacy._trim_float(-3.0) == "-3"


# ------------------------------------------------------------------- xls / ods
#
# `legacy.rs` has no dedicated test for `extract_legacy_spreadsheet` itself
# (calamine's own test suite covers the format parsing that crate relies
# on); this port uses a completely different pair of libraries (xlrd /
# odfpy) for the same job, so the sheet-walking logic gets its own direct
# coverage here.


def test_xls_all_numeric_sheet_extracts_with_columns_and_blanks_preserved() -> None:
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Numbers")
    ws.write(0, 0, 1)
    ws.write(0, 1, 2.5)
    # column 2 left blank on purpose
    ws.write(0, 3, 4)
    ws.write(1, 0, 100)
    ws.write(1, 1, "")
    ws.write(1, 3, "End")
    buf = io.BytesIO()
    wb.save(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "xls")
    assert text is not None, "no text from .xls"
    assert "--- Numbers ---" in text, text
    lines = [line for line in text.splitlines() if line and not line.startswith("---")]
    assert lines[0].split("\t") == ["1", "2.5", "", "4"], lines
    assert lines[1].split("\t") == ["100", "", "", "End"], lines
    # Never a trailing ".0" on a whole-number cell.
    assert "1.0" not in text and "100.0" not in text and "4.0" not in text, text


def test_ods_all_numeric_sheet_extracts_with_columns_and_blanks_preserved() -> None:
    odf_table = pytest.importorskip("odf.table")
    odf_text = pytest.importorskip("odf.text")
    from odf.opendocument import OpenDocumentSpreadsheet

    Table, TableRow, TableCell = odf_table.Table, odf_table.TableRow, odf_table.TableCell
    P = odf_text.P

    doc = OpenDocumentSpreadsheet()
    table = Table(name="Sheet1")

    row1 = TableRow()
    row1.addElement(TableCell(valuetype="float", value=1))
    row1.addElement(TableCell(valuetype="float", value=2.5))
    row1.addElement(TableCell())  # genuinely blank cell
    c4 = TableCell(valuetype="float", value=4)
    row1.addElement(c4)
    table.addElement(row1)

    row2 = TableRow()
    row2.addElement(TableCell(valuetype="float", value=100))
    row2.addElement(TableCell())
    row2.addElement(TableCell())
    c_end = TableCell(valuetype="string")
    c_end.addElement(P(text="End"))
    row2.addElement(c_end)
    table.addElement(row2)

    doc.spreadsheet.addElement(table)
    buf = io.BytesIO()
    doc.write(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "ods")
    assert text is not None, "no text from .ods"
    assert "--- Sheet1 ---" in text, text
    lines = [line for line in text.splitlines() if line and not line.startswith("---")]
    assert lines[0].split("\t") == ["1", "2.5", "", "4"], lines
    assert lines[1].split("\t") == ["100", "", "", "End"], lines
    assert "1.0" not in text and "100.0" not in text and "4.0" not in text, text


def test_ods_cell_values_prefer_usable_typed_values_and_otherwise_use_display_text() -> None:
    odf_table = pytest.importorskip("odf.table")
    odf_text = pytest.importorskip("odf.text")
    TableCell, P = odf_table.TableCell, odf_text.P

    invalid_number = TableCell(valuetype="float", value="not-a-number")
    invalid_number.addElement(P(text="shown instead"))
    missing_number = TableCell(valuetype="currency")
    missing_number.addElement(P(text="also shown"))
    string = TableCell(valuetype="string")
    string.addElement(P(text="plain text"))

    assert legacy._ods_cell_value(TableCell(valuetype="percentage", value=2.5)) == "2.5"
    assert legacy._ods_cell_value(TableCell(valuetype="boolean", booleanvalue="true")) == "true"
    assert legacy._ods_cell_value(TableCell(valuetype="date", datevalue="2026-08-31")) == "2026-08-31"
    assert legacy._ods_cell_value(TableCell(valuetype="time", timevalue="PT1H2M")) == "PT1H2M"
    assert legacy._ods_cell_value(invalid_number) == "shown instead"
    assert legacy._ods_cell_value(missing_number) == "also shown"
    assert legacy._ods_cell_value(string) == "plain text"


def test_an_all_blank_sheet_is_skipped_entirely() -> None:
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Empty")
    ws.write(0, 0, "")
    buf = io.BytesIO()
    wb.save(buf)
    assert legacy.extract_legacy_spreadsheet(buf.getvalue(), "xls") is None


def test_a_blank_row_in_a_non_empty_sheet_is_skipped() -> None:
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Sparse")
    ws.write(0, 0, "first row")
    ws.write(1, 0, "")
    ws.write(2, 0, "last row")
    buf = io.BytesIO()
    wb.save(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "xls")
    assert text == "--- Sparse ---\nfirst row\nlast row\n"


def test_spreadsheet_output_keeps_the_overflowing_row_then_marks_truncation(monkeypatch) -> None:
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Tiny")
    ws.write(0, 0, "row beyond the limit")
    buf = io.BytesIO()
    wb.save(buf)
    monkeypatch.setattr(legacy, "MAX_LEGACY_CHARS", len("--- Tiny ---\n"))

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "xls")
    assert text == "--- Tiny ---\nrow beyond the limit\n\n… (truncated)\n"


def test_invalid_known_spreadsheet_formats_read_as_nothing() -> None:
    assert legacy.extract_legacy_spreadsheet(b"not a spreadsheet", "xls") is None
    assert legacy.extract_legacy_spreadsheet(b"not a spreadsheet", "ods") is None


def test_an_unknown_spreadsheet_extension_reads_as_nothing() -> None:
    assert legacy.extract_legacy_spreadsheet(b"whatever", "csv") is None


def test_xls_boolean_cells_render_lowercase_matching_rust() -> None:
    # REGRESSION: matches Rust's `Data::Bool(b) => b.to_string()`, which
    # renders lowercase. One of the two judged candidates used Python's
    # `str(bool(x))` instead, which capitalizes ("True"/"False") -- a real
    # divergence from the source's actual output.
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Flags")
    ws.write(0, 0, True)
    ws.write(0, 1, False)
    buf = io.BytesIO()
    wb.save(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "xls")
    assert text is not None
    assert "true" in text and "false" in text, text
    assert "True" not in text and "False" not in text, text


def test_xls_cell_values_keep_type_specific_rendering(monkeypatch) -> None:
    def cell(ctype, value):
        return SimpleNamespace(ctype=ctype, value=value)

    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_EMPTY, "ignored"), 0) == ""
    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_NUMBER, 12.0), 0) == "12"
    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_BOOLEAN, False), 0) == "false"

    monkeypatch.setattr(legacy.xlrd, "xldate_as_datetime", lambda *_: "date value")
    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_DATE, 2.0), 0) == "date value"
    monkeypatch.setattr(
        legacy.xlrd,
        "xldate_as_datetime",
        lambda *_: (_ for _ in ()).throw(ValueError("invalid date")),
    )
    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_DATE, 12.0), 0) == "12"

    error_code, error_text = next(iter(legacy.xlrd.error_text_from_code.items()))
    assert legacy._xls_cell_value(cell(legacy.xlrd.XL_CELL_ERROR, error_code), 0) == error_text
    assert legacy._xls_cell_value(cell(99, "displayed"), 0) == "displayed"


def test_ods_merged_cell_continuation_keeps_later_cells_in_their_real_column() -> None:
    # REGRESSION: `table:covered-table-cell` (the continuation of a merged
    # cell) must still occupy a column. One of the two judged candidates
    # walked `getElementsByType(TableCell)` only, which silently skips a
    # `CoveredTableCell` element entirely and shifts every later cell in
    # the row one column to the left -- verified directly against odfpy.
    odf_table = pytest.importorskip("odf.table")
    odf_text = pytest.importorskip("odf.text")
    from odf.opendocument import OpenDocumentSpreadsheet

    Table, TableRow = odf_table.Table, odf_table.TableRow
    TableCell, CoveredTableCell = odf_table.TableCell, odf_table.CoveredTableCell
    P = odf_text.P

    doc = OpenDocumentSpreadsheet()
    table = Table(name="Merged")
    row = TableRow()
    first = TableCell(valuetype="string")
    first.addElement(P(text="first"))
    row.addElement(first)
    row.addElement(CoveredTableCell())  # merged-cell continuation
    after = TableCell(valuetype="string")
    after.addElement(P(text="after-merge"))
    row.addElement(after)
    table.addElement(row)
    doc.spreadsheet.addElement(table)
    buf = io.BytesIO()
    doc.save(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "ods")
    assert text is not None
    lines = [line for line in text.splitlines() if line and not line.startswith("---")]
    assert lines[0].split("\t") == ["first", "", "after-merge"], lines


def test_ods_row_repeat_is_expanded() -> None:
    # REGRESSION: `table:number-rows-repeated` means "this literal row
    # repeats N times" -- verified against the vendored calamine 0.36.1
    # source (`src/ods.rs`), which expands it up to its own `MAX_ROWS`
    # bound when building the range. One of the two judged candidates never
    # expanded it at all (each `<table:row>` read exactly once regardless
    # of the attribute), under-reporting a sheet with repeated content.
    odf_table = pytest.importorskip("odf.table")
    odf_text = pytest.importorskip("odf.text")
    from odf.opendocument import OpenDocumentSpreadsheet

    Table, TableRow, TableCell = odf_table.Table, odf_table.TableRow, odf_table.TableCell
    P = odf_text.P

    doc = OpenDocumentSpreadsheet()
    table = Table(name="Repeats")
    row = TableRow(numberrowsrepeated=3)
    cell = TableCell(valuetype="string")
    cell.addElement(P(text="repeated row"))
    row.addElement(cell)
    table.addElement(row)
    doc.spreadsheet.addElement(table)
    buf = io.BytesIO()
    doc.save(buf)

    text = legacy.extract_legacy_spreadsheet(buf.getvalue(), "ods")
    assert text is not None
    assert text.count("repeated row") == 3, text
