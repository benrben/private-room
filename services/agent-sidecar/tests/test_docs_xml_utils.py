"""Tests for `arcelle_sidecar.docs.xml_utils` (port of the shared OOXML
helpers in `src-tauri/src/extraction.rs` -- `zip_entry_names`,
`read_zip_entry`, `read_zip_entry_capped`, `xml_attr`, `strip_tags`,
`xml_paras_to_text`, `NAMED_ENTITIES`, `MAX_ENTITY_LEN`,
`decode_basic_entities`, `normalize_whitespace` -- plus the
decompression-bomb guards `zip_declared_size_within`/
`zip_inflated_size_within` from `src-tauri/src/extraction/xlsx.rs`).

Mirrors the Rust `#[cfg(test)]` cases for these functions where one exists,
plus regression tests for divergences found while judging two independent
candidate ports against a compiled copy of the actual Rust function
(`decode_basic_entities`'s leading-`+`/underscore/whitespace numeric-ref
handling, and an encrypted zip entry crashing `read_zip_entry_capped`).
"""

from __future__ import annotations

import io
import struct
import zipfile

from arcelle_sidecar.docs import xml_utils as xu


def fake_office_zip(entry: str, xml: str) -> bytes:
    """Mirrors the Rust test helper `fake_office_zip` in `extraction.rs`: a
    single-entry zip archive, deflate-compressed like a real Office part.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(entry, xml)
    return buf.getvalue()


def patch_declared_size(data: bytes, new_size: int) -> bytes:
    """Mirrors the Rust test's exact byte-patching approach
    (`refuses_workbook_with_lying_declared_sizes`): overwrite the declared
    uncompressed-size field in BOTH the local file header (4 bytes at
    offset+22 past `PK\\x03\\x04`) and the central directory record (4 bytes
    at offset+24 past `PK\\x01\\x02`) with a little-endian u32, so the zip's
    own metadata lies about how big the entry really inflates.
    """
    out = bytearray(data)
    local = out.index(b"PK\x03\x04")
    out[local + 22 : local + 26] = struct.pack("<I", new_size)
    central = out.index(b"PK\x01\x02")
    out[central + 24 : central + 28] = struct.pack("<I", new_size)
    return bytes(out)


def flag_entry_as_encrypted(data: bytes) -> bytes:
    """Set the encryption bit (bit 0 of the general-purpose flag) in both
    the local file header and the central directory record of a
    single-entry zip, WITHOUT actually encrypting the payload -- enough to
    make `zipfile.ZipFile.open()` refuse the entry with `RuntimeError:
    ... password required for extraction`, the exact failure mode an
    encrypted Office zip part would hit.
    """
    out = bytearray(data)
    local = out.index(b"PK\x03\x04")
    flag = int.from_bytes(out[local + 6 : local + 8], "little") | 0x1
    out[local + 6 : local + 8] = flag.to_bytes(2, "little")
    central = out.index(b"PK\x01\x02")
    flag_c = int.from_bytes(out[central + 8 : central + 10], "little") | 0x1
    out[central + 8 : central + 10] = flag_c.to_bytes(2, "little")
    return bytes(out)


# --------------------------------------------------------------- zip entries


def test_zip_entry_names_lists_entries_in_archive_order() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", "<x/>")
        zf.writestr("word/media/image1.png", b"\x00")
    assert xu.zip_entry_names(buf.getvalue()) == [
        "word/document.xml",
        "word/media/image1.png",
    ]


def test_zip_entry_names_empty_for_non_zip_bytes() -> None:
    assert xu.zip_entry_names(b"not a zip") == []


def test_read_zip_entry_refuses_entries_over_cap() -> None:
    # Decompression-bomb guard: an entry whose decompressed size exceeds
    # the cap must yield None instead of ballooning memory. Verbatim from
    # the Rust `read_zip_entry_refuses_entries_over_cap` test.
    data = fake_office_zip("word/document.xml", "0123456789")
    assert xu.read_zip_entry_capped(data, "word/document.xml", 64) == "0123456789"
    assert xu.read_zip_entry_capped(data, "word/document.xml", 9) is None


def test_read_zip_entry_none_for_missing_entry_or_non_zip() -> None:
    data = fake_office_zip("word/document.xml", "hello")
    assert xu.read_zip_entry_capped(data, "word/nope.xml", 64) is None
    assert xu.read_zip_entry_capped(b"not a zip", "word/document.xml", 64) is None


def test_read_zip_entry_refuses_non_utf8_content() -> None:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("word/document.xml", b"\xff\xfe")
    assert xu.read_zip_entry_capped(data.getvalue(), "word/document.xml", 64) is None


def test_read_zip_entry_default_cap_reads_a_real_entry() -> None:
    data = fake_office_zip("word/document.xml", "<w:p>hi</w:p>")
    assert xu.read_zip_entry(data, "word/document.xml") == "<w:p>hi</w:p>"


def test_zip_declared_size_within_basic() -> None:
    data = fake_office_zip("xl/worksheets/sheet1.xml", "<x/>")
    assert xu.zip_declared_size_within(data, 1024) is True
    assert xu.zip_declared_size_within(data, 1) is False  # 4-byte entry > 1-byte cap
    assert xu.zip_declared_size_within(b"not a zip", 1024) is False


def test_zip_inflated_size_within_basic() -> None:
    content = "x" * 100
    data = fake_office_zip("xl/worksheets/sheet1.xml", content)
    assert xu.zip_inflated_size_within(data, 1024) is True
    assert xu.zip_inflated_size_within(data, 99) is False
    assert xu.zip_inflated_size_within(b"not a zip", 1024) is False


def test_refuses_workbook_with_lying_declared_sizes() -> None:
    # A crafted bomb declares a tiny uncompressed size but inflates far
    # past it; the declared-size fast path passes, so the streaming
    # re-count must be the one that refuses it. Verbatim scenario from the
    # Rust `refuses_workbook_with_lying_declared_sizes` test.
    content = "x" * 100
    data = fake_office_zip("xl/worksheets/sheet1.xml", content)
    patched = patch_declared_size(data, 1)
    assert xu.zip_declared_size_within(patched, 64) is True, "fast path should pass"
    assert xu.zip_inflated_size_within(patched, 64) is False, "real guard must catch it"
    # read_zip_entry_capped must not be fooled either: its own header check
    # sees the lying declared size (1 <= cap) and passes it through to the
    # bounded read, which then catches the real, oversized content.
    assert xu.read_zip_entry_capped(patched, "xl/worksheets/sheet1.xml", 64) is None


def test_encrypted_zip_entry_is_refused_not_raised() -> None:
    # Regression found while judging two candidate ports: `zipfile.ZipFile.
    # open()` raises `RuntimeError` (not `BadZipFile`) for a
    # password-protected entry. The Rust source's `ZipArchive::by_name(...)
    # .ok()?` collapses that into `None` uniformly; a port that only caught
    # `BadZipFile`/`OSError` let the `RuntimeError` escape uncaught instead
    # of returning `None` -- exactly the "a bad file must only cost its own
    # text" invariant `extraction.rs`'s `contain_parser_panic` exists for.
    data = fake_office_zip("xl/worksheets/sheet1.xml", "x" * 100)
    encrypted = flag_entry_as_encrypted(data)
    assert xu.read_zip_entry_capped(encrypted, "xl/worksheets/sheet1.xml", 1024) is None
    assert xu.read_zip_entry(encrypted, "xl/worksheets/sheet1.xml") is None
    # The streaming inflate guard already handled this correctly in both
    # candidates; kept here so the three guards are tested against the same
    # fixture.
    assert xu.zip_inflated_size_within(encrypted, 1024) is False


# ------------------------------------------------------------- xml_attr


def test_xml_attr_double_quotes() -> None:
    assert xu.xml_attr('<w:r w:id="7">', "w:id") == "7"


def test_xml_attr_single_quotes() -> None:
    assert xu.xml_attr("<w:r w:id='7'>", "w:id") == "7"


def test_xml_attr_decodes_entities_in_the_value() -> None:
    assert xu.xml_attr('<a href="a &amp; b">', "href") == "a & b"


def test_xml_attr_none_when_attribute_missing() -> None:
    assert xu.xml_attr('<w:r w:id="7">', "w:name") is None


def test_xml_attr_only_looks_up_to_first_gt() -> None:
    # An attribute that only appears AFTER the tag's own '>' must not match.
    assert xu.xml_attr('<w:r w:id="7">w:name="x"', "w:name") is None


# -------------------------------------------------------------- strip_tags


def test_strip_tags_removes_markup_and_joins_with_spaces() -> None:
    assert xu.strip_tags("<p>hello <b>world</b></p>") == " hello  world  "


def test_strip_tags_ignores_gt_inside_quoted_attribute() -> None:
    # Regression: Parsoid-rendered Wikipedia carries whole template wikitext
    # inside a single-quoted `data-mw='{…}'` attribute whose JSON holds
    # literal `<ref>`/`>` markup. A quote-naive scanner treated the first
    # stray `>` as the tag close and dumped the raw JSON into the text.
    # Verbatim from the Rust `strip_tags_ignores_gt_inside_quoted_attribute`.
    html = '<div data-mw=\'{"wt":"{{coord|52|N}}<ref>x</ref>"}\'>Berlin</div>'
    assert xu.strip_tags(html).strip() == "Berlin"
    # Both quote styles, and normal tags, still strip cleanly.
    assert xu.strip_tags('<a href="x>y">link</a>').strip() == "link"
    assert xu.strip_tags("<b>bold</b> text").strip() == "bold  text".strip()


def test_strip_tags_decodes_entities_after_stripping() -> None:
    assert xu.strip_tags("<p>a &amp; b</p>") == " a & b "


def test_ascii_case_comparison_never_folds_non_ascii_characters() -> None:
    assert xu._ascii_ci_eq("AMP", "amp") is True
    assert xu._ascii_ci_eq("é", "É") is False
    assert xu._ascii_ci_eq("amp", "amps") is False


# --------------------------------------------------------- xml_paras_to_text


def test_xml_paras_to_text_inserts_newline_before_stripping() -> None:
    xml = "<w:p>first</w:p><w:p>second</w:p>"
    result = xu.xml_paras_to_text(xml, "</w:p>")
    lines = [line for line in result.split("\n") if line.strip()]
    assert lines == [" first ", " second "]


# ------------------------------------------------------ decode_basic_entities


def test_decode_all_24_named_entities() -> None:
    assert len(xu.NAMED_ENTITIES) == 24
    for name, ch in xu.NAMED_ENTITIES:
        assert xu.decode_basic_entities(f"&{name};") == ch, f"entity {name}"


def test_decode_named_entities_case_insensitive() -> None:
    assert xu.decode_basic_entities("&AMP;") == "&"
    assert xu.decode_basic_entities("&Amp;") == "&"


def test_decode_decimal_numeric_reference() -> None:
    assert xu.decode_basic_entities("&#8212;") == "—"  # em dash
    assert xu.decode_basic_entities("Python&#8212;docs") == "Python—docs"


def test_decode_hex_numeric_reference() -> None:
    assert xu.decode_basic_entities("&#x2014;") == "—"  # em dash
    assert xu.decode_basic_entities("&#X2014;") == "—"  # uppercase X too


def test_decode_surrogate_code_point_is_left_unresolved() -> None:
    # `char::from_u32` in Rust returns None for the surrogate range
    # (D800-DFFF), which is not a valid Unicode Scalar Value; Python's bare
    # `chr()` would otherwise happily construct a lone surrogate.
    assert xu.decode_basic_entities("&#xD800;") == "&#xD800;"


def test_decode_unrecognized_entity_left_verbatim() -> None:
    assert xu.decode_basic_entities("&foobar;") == "&foobar;"


def test_decode_bare_unterminated_ampersand_does_not_hang_or_vanish() -> None:
    # No ';' within MAX_ENTITY_LEN bytes: the '&' is emitted as-is and the
    # scan must move past it (not re-find the same '&' and loop forever).
    text = "Tom & Jerry never had a semicolon anywhere near that ampersand"
    assert xu.decode_basic_entities(text) == text


def test_decode_double_decode_trap() -> None:
    # The whole point of single-pass decoding: `&amp;lt;` must decode to
    # exactly the literal text "&lt;", NOT all the way down to "<".
    assert xu.decode_basic_entities("&amp;lt;") == "&lt;"
    assert xu.decode_basic_entities("&amp;amp;") == "&amp;"


def test_decode_mixed_text_with_entities_and_plain_content() -> None:
    assert xu.decode_basic_entities("Q&amp;A &mdash; done") == "Q&A — done"


def test_decode_no_ampersand_returns_input_unchanged() -> None:
    assert xu.decode_basic_entities("plain text, nothing to do") == "plain text, nothing to do"


def test_decode_matches_rust_source_doc_example() -> None:
    assert xu.decode_basic_entities("a &amp; b") == "a & b"
    assert xu.decode_basic_entities("&lt;p&gt;&quot;hi&quot;&#39;&nbsp;") == '<p>"hi"\' '


def test_decode_leading_plus_is_accepted_in_numeric_refs() -> None:
    # Regression found while judging two candidate ports: confirmed against
    # a compiled copy of the actual Rust function that both
    # `"123".parse::<u32>()` and `u32::from_str_radix("+7B", 16)` accept one
    # optional leading '+'. One candidate's stricter digit-alphabet check
    # rejected it outright, silently leaving `&#+123;` undecoded where Rust
    # decodes it.
    assert xu.decode_basic_entities("&#+123;") == "{"
    assert xu.decode_basic_entities("&#x+2014;") == "—"


def test_decode_underscore_in_numeric_ref_is_rejected() -> None:
    # Regression: Python's `int("1_000")` succeeds (digit-group separator),
    # but Rust's `"1_000".parse::<u32>()` does not -- a port that reaches
    # straight for `int(digits, base)` would silently decode text the Rust
    # source leaves untouched.
    assert xu.decode_basic_entities("&#1_000;") == "&#1_000;"
    assert xu.decode_basic_entities("&#x1_0;") == "&#x1_0;"


def test_decode_whitespace_in_numeric_ref_is_rejected() -> None:
    # Regression: Python's `int(" 123 ")` strips surrounding whitespace and
    # succeeds; Rust's `str::parse::<u32>()` does not accept any whitespace
    # at all.
    assert xu.decode_basic_entities("&# 123;") == "&# 123;"
    assert xu.decode_basic_entities("&#123 ;") == "&#123 ;"


def test_decode_minus_sign_in_numeric_ref_is_rejected() -> None:
    # Unlike '+', a leading '-' has no valid u32 meaning and must not parse.
    assert xu.decode_basic_entities("&#-5;") == "&#-5;"
    assert xu.decode_basic_entities("&#x-5;") == "&#x-5;"


def test_parse_u32_rejects_empty_and_overflowing_numbers() -> None:
    assert xu._parse_u32("", 10) is None
    assert xu._parse_u32("+FFFFFFFF", 16) == 0xFFFFFFFF
    assert xu._parse_u32("100000000", 16) is None


def test_decode_multibyte_filler_around_embedded_ampersand_round_trips() -> None:
    # The Rust source measures MAX_ENTITY_LEN in UTF-8 BYTES (`char_indices`)
    # while this port's window-search is also byte-based (`_entity_body_end`);
    # verified against a compiled copy of the real Rust function that this
    # never changes the DECODED OUTPUT (only a body that could never resolve
    # to a real entity is affected, and such a body is echoed back verbatim
    # either way). A handful of the generated cases as a standing regression.
    assert xu.decode_basic_entities("&ééééééé;TAIL") == "&ééééééé;TAIL"
    assert xu.decode_basic_entities("prefix&€€€€€€€;mid&üüü;end") == "prefix&€€€€€€€;mid&üüü;end"


# ----------------------------------------------------------- normalize_whitespace


def test_normalize_whitespace_collapses_tabs_and_multiple_spaces() -> None:
    assert xu.normalize_whitespace("a\t\tb   c") == "a b c\n"


def test_normalize_whitespace_squeezes_multiple_blank_lines_to_one() -> None:
    assert xu.normalize_whitespace("a\n\n\n\nb") == "a\n\nb\n"


def test_normalize_whitespace_no_blank_line_stays_none() -> None:
    assert xu.normalize_whitespace("a\nb") == "a\nb\n"


def test_normalize_whitespace_handles_crlf_line_endings() -> None:
    assert xu.normalize_whitespace("a\r\n\r\nb") == "a\n\nb\n"


def test_normalize_whitespace_whitespace_only_line_counts_as_blank() -> None:
    assert xu.normalize_whitespace("a\n   \n\t\n\nb\n") == "a\n\nb\n"


# ------------------------------------------------------------------- constants


def test_constants_match_rust_source() -> None:
    assert xu.MAX_ZIP_ENTRY_BYTES == 100 * 1024 * 1024
    assert xu.MAX_ENTITY_LEN == 12
