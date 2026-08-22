"""Word (.docx) text extraction -- port of the EXTRACTION half of
`src-tauri/src/extraction/docx.rs` (`DOCX_EXTRA_PARTS`, `extract_docx`,
`push_docx_part`; lines 1-49 of that file).

Scope note: `docx.rs` also defines `docx_replace_text` and everything it
depends on (`scan_docx_text`, `collapse_ws`, `find_sub`,
`replace_in_text_nodes`, `encode_xml_text`) -- that is a text
REPLACEMENT/editing feature (the agent's in-place document-edit tool), not
extraction, and is deliberately out of scope for this port. It belongs with
the agent edit-tool infrastructure a later batch will port.

The body (`word/document.xml`) is always read first, keeping its paragraph
structure via `xml_paras_to_text`. Footnotes, endnotes and comments are each
one fixed, named part; headers and footers are per-section and numbered
(`header1.xml`, `header2.xml`, ...), so they are discovered from the
archive's own entry list rather than named here. Every extra part is
additive: if it doesn't exist, or its extracted text is all whitespace, it
contributes nothing -- the body text is returned regardless.
"""

from __future__ import annotations

from arcelle_sidecar.docs.xml_utils import (
    read_zip_entry,
    xml_paras_to_text,
    zip_entry_names,
)

# The parts of a Word file that carry prose, in reading order after the body.
# Only `word/document.xml` used to be read, so a clause living in a footnote,
# a header, a footer or a review comment was invisible to search and to the
# assistant with nothing saying part of the document had been skipped.
# Header/footer parts are numbered (`header1.xml`, `header2.xml`, ...), so
# they are discovered from the archive rather than named here.
DOCX_EXTRA_PARTS: tuple[tuple[str, str], ...] = (
    ("word/footnotes.xml", "footnotes"),
    ("word/endnotes.xml", "endnotes"),
    ("word/comments.xml", "comments"),
)


def extract_docx(data: bytes) -> str | None:
    xml = read_zip_entry(data, "word/document.xml")
    if xml is None:
        return None
    out = [xml_paras_to_text(xml, "</w:p>")]
    for entry, label in DOCX_EXTRA_PARTS:
        _append_docx_part(out, data, entry, label)
    # Headers and footers are per-section parts; take them in archive order.
    for name in zip_entry_names(data):
        if name.startswith("word/header"):
            label = "header"
        elif name.startswith("word/footer"):
            label = "footer"
        else:
            continue
        if name.endswith(".xml"):
            _append_docx_part(out, data, name, label)
    return "".join(out)


def _append_docx_part(out: list[str], data: bytes, entry: str, label: str) -> None:
    """Append one labelled part's text, if it exists and holds anything
    readable. The label matters: without it the model cannot tell a
    footnote's small print from the body clause it qualifies.
    """
    xml = read_zip_entry(data, entry)
    if xml is None:
        return
    text = xml_paras_to_text(xml, "</w:p>")
    if not text.strip():
        return
    out.append(f"\n[{label}]\n")
    out.append(text)
