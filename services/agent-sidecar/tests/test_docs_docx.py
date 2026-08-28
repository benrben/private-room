"""Tests for `arcelle_sidecar.docs.docx` (port of the EXTRACTION half of
`src-tauri/src/extraction/docx.rs` -- `extract_docx` / `push_docx_part`;
lines 1-49 of that file only).

`docx_replace_text` and its dependencies (`scan_docx_text`, `collapse_ws`,
`find_sub`, `replace_in_text_nodes`, `encode_xml_text`) are a text
REPLACEMENT/editing feature, not extraction, and are out of scope here --
they belong with the agent edit-tool infrastructure a later batch will port.
"""

from __future__ import annotations

import io
import zipfile

from arcelle_sidecar.docs import docx


def fake_office_zip(entry: str, xml: str) -> bytes:
    """Mirrors the Rust test helper `fake_office_zip` in `extraction.rs`: a
    single-entry zip archive, deflate-compressed like a real Office part.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(entry, xml)
    return buf.getvalue()


def fake_office_zip_multi(entries: dict[str, str]) -> bytes:
    """Like `fake_office_zip`, but a minimal zip carrying several named
    entries -- used for fixtures that need `word/document.xml` alongside
    footnotes/endnotes/comments/headers/footers. Entries are written in
    dict-iteration order, which for a Python 3.7+ dict is insertion order,
    so the archive's entry order matches the order the caller wrote it in.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry, xml in entries.items():
            zf.writestr(entry, xml)
    return buf.getvalue()


def test_extracts_docx_paragraphs() -> None:
    xml = (
        "<w:document><w:body>"
        "<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    bytes_ = fake_office_zip("word/document.xml", xml)
    text = docx.extract_docx(bytes_)
    assert text is not None
    assert "Hello world" in text
    assert "Second paragraph" in text
    # Paragraph structure is preserved: the two paragraphs land on separate
    # lines rather than collapsing into one run-on line. (Stripped tags each
    # become a literal space, per `strip_tags`, so lines are compared after
    # trimming rather than exact-matched.)
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    assert lines[0] == "Hello world"
    assert lines[1] == "Second paragraph"


def test_extract_docx_missing_document_returns_none() -> None:
    bytes_ = fake_office_zip("word/other.xml", "<w:document/>")
    assert docx.extract_docx(bytes_) is None


def test_extract_docx_not_a_zip_returns_none() -> None:
    assert docx.extract_docx(b"not a zip file at all") is None


def test_reads_headers_footers_footnotes_and_comments() -> None:
    entries = {
        "word/document.xml": (
            "<w:document><w:body>"
            "<w:p><w:r><w:t>Body text</w:t></w:r></w:p>"
            "</w:body></w:document>"
        ),
        "word/footnotes.xml": (
            "<w:footnotes><w:p><w:r><w:t>A footnote</w:t></w:r></w:p></w:footnotes>"
        ),
        "word/endnotes.xml": (
            "<w:endnotes><w:p><w:r><w:t>An endnote</w:t></w:r></w:p></w:endnotes>"
        ),
        "word/comments.xml": (
            "<w:comments><w:p><w:r><w:t>A comment</w:t></w:r></w:p></w:comments>"
        ),
        "word/header1.xml": (
            "<w:hdr><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>"
        ),
        "word/footer1.xml": (
            "<w:ftr><w:p><w:r><w:t>Footer text</w:t></w:r></w:p></w:ftr>"
        ),
    }
    bytes_ = fake_office_zip_multi(entries)
    text = docx.extract_docx(bytes_)
    assert text is not None

    assert "Body text" in text

    assert "[footnotes]" in text
    assert "A footnote" in text
    assert "[endnotes]" in text
    assert "An endnote" in text
    assert "[comments]" in text
    assert "A comment" in text
    assert "[header]" in text
    assert "Header text" in text
    assert "[footer]" in text
    assert "Footer text" in text

    # Every label is immediately followed (on the very next line) by its own
    # text block, not just present somewhere in the string. Stripped tags
    # each become a literal space (per `strip_tags`), so the line is
    # compared after trimming rather than exact-matched.
    lines = [line.strip() for line in text.split("\n")]

    def line_after(label: str) -> str:
        return lines[lines.index(f"[{label}]") + 1]

    assert line_after("footnotes") == "A footnote"
    assert line_after("endnotes") == "An endnote"
    assert line_after("comments") == "A comment"
    assert line_after("header") == "Header text"
    assert line_after("footer") == "Footer text"


def test_extra_parts_are_additive_not_required() -> None:
    """A document with no footnotes/endnotes/comments/headers/footers still
    extracts fine -- the extra parts are additive, never required (matches
    the Rust doc comment: "Always returns Some... the extra parts are
    additive, never required").
    """
    xml = "<w:document><w:body><w:p><w:r><w:t>Only body</w:t></w:r></w:p></w:body></w:document>"
    bytes_ = fake_office_zip("word/document.xml", xml)
    text = docx.extract_docx(bytes_)
    assert text is not None
    assert text.strip() == "Only body"


def test_blank_extra_part_is_skipped() -> None:
    """A footnotes part that exists but decodes to all-whitespace text
    contributes nothing -- matches `push_docx_part`'s
    `text.trim().is_empty()` guard.
    """
    entries = {
        "word/document.xml": (
            "<w:document><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>"
        ),
        # No <w:t> runs at all -> strip_tags leaves only whitespace/newlines.
        "word/footnotes.xml": "<w:footnotes><w:p></w:p></w:footnotes>",
    }
    bytes_ = fake_office_zip_multi(entries)
    text = docx.extract_docx(bytes_)
    assert text is not None
    assert "[footnotes]" not in text


def test_header_footer_order_follows_archive_order() -> None:
    """Headers/footers are discovered from the archive's own entry list, in
    archive order -- not sorted, not grouped by header-then-footer.
    """
    entries = {
        "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>",
        "word/footer2.xml": "<w:ftr><w:p><w:r><w:t>Footer Two</w:t></w:r></w:p></w:ftr>",
        "word/header2.xml": "<w:hdr><w:p><w:r><w:t>Header Two</w:t></w:r></w:p></w:hdr>",
    }
    bytes_ = fake_office_zip_multi(entries)
    text = docx.extract_docx(bytes_)
    assert text is not None
    assert text.index("Footer Two") < text.index("Header Two")


def test_non_header_footer_word_parts_ignored() -> None:
    """A `word/` entry that isn't `word/header*`/`word/footer*` (or doesn't
    end in `.xml`) is not treated as a header/footer part.
    """
    entries = {
        "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>",
        "word/headers.txt": "not xml, and not word/header* by prefix rule anyway",
        "word/settings.xml": "<w:settings/>",
    }
    bytes_ = fake_office_zip_multi(entries)
    text = docx.extract_docx(bytes_)
    assert text is not None
    assert "[header]" not in text
    assert "[footer]" not in text
