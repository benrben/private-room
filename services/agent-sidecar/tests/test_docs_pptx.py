"""Tests for `arcelle_sidecar.docs.pptx` (port of
`src-tauri/src/extraction/pptx.rs`).

Ports all five of the Rust module's `#[cfg(test)]` cases verbatim -- same
fixtures, same expected outcomes. The Rust tests drive the extractor
through `extract_text("deck.pptx", &bytes)`, the crate's extension-based
dispatcher; the Python port has no such dispatcher module yet, so these
call `pptx.extract_pptx`/`pptx._extract_pptx_budgeted` directly -- the same
function the dispatcher would reach for a `.pptx` name, just without the
extra routing hop.
"""

from __future__ import annotations

import io
import zipfile

from arcelle_sidecar.docs import pptx


def fake_office_zip(entry: str, xml: str) -> bytes:
    """Mirrors the Rust test helper of the same name: a minimal Office-style
    zip with a single entry.
    """
    return build_zip({entry: xml})


def build_zip(entries: dict[str, str]) -> bytes:
    """Build an in-memory zip with one entry per (name, text) pair, in
    insertion order -- the Python-side equivalent of the Rust tests'
    inline `zip::ZipWriter` blocks.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as writer:
        for name, body in entries.items():
            writer.writestr(name, body.encode("utf-8"))
    return buf.getvalue()


def test_extracts_pptx_slide_text() -> None:
    data = fake_office_zip(
        "ppt/slides/slide1.xml",
        '<p:sld><a:t>Quarterly revenue plan</a:t><a:p></a:p></p:sld>',
    )
    text = pptx.extract_pptx(data)
    assert text is not None, "pptx text"
    assert "Quarterly revenue plan" in text
    assert "[slide 1]" in text


def test_reads_speaker_notes_charts_and_diagrams() -> None:
    # A real deck keeps its argument in the notes and its numbers in the
    # charts; reading slide bodies only left the model answering from
    # headlines. Every part must reach the extracted text, labelled.
    data = build_zip(
        {
            "ppt/slides/slide1.xml": "<a:t>Q3 headline</a:t>",
            "ppt/notesSlides/notesSlide1.xml": (
                "<a:t>Revenue fell because two contracts slipped.</a:t>"
            ),
            "ppt/charts/chart1.xml": "<c:v>Region</c:v><c:v>41200</c:v>",
            "ppt/diagrams/data1.xml": "<a:t>Plan then build</a:t>",
        }
    )
    text = pptx.extract_pptx(data)
    assert text is not None, "pptx text"
    assert "Q3 headline" in text, f"got: {text}"
    assert "[slide 1 notes]" in text, f"notes unlabelled: {text}"
    assert "two contracts slipped" in text, f"notes missing: {text}"
    assert "41200" in text, f"chart values missing: {text}"
    assert "Plan then build" in text, f"diagram text missing: {text}"


def test_a_rels_part_is_read_in_either_quote_style() -> None:
    # The rels part is now authoritative: reading it wrong means "this
    # slide has no notes", so a producer's quoting choice must not cost a
    # deck its whole narration.
    ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    double = (
        f'<Relationships><Relationship Id="rId2" Type="{ns}/notesSlide" '
        f'Target="../notesSlides/notesSlide3.xml"/></Relationships>'
    )
    single = double.replace('"', "'")
    for xml in (double, single):
        assert pptx.notes_rel_target(xml) == "../notesSlides/notesSlide3.xml", (
            f"target unread: {xml}"
        )
    # A slide whose only relationship is its layout has no notes at all.
    layout = (
        f'<Relationships><Relationship Id="rId1" Type="{ns}/slideLayout" '
        f'Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
    )
    assert pptx.notes_rel_target(layout) is None
    assert pptx.notes_rel_target("<Relationships/>") is None


def test_notes_follow_the_slide_rels_not_the_part_number() -> None:
    # A deck annotated only on its second slide still writes
    # notesSlide1.xml, because notes parts are numbered in creation order.
    # Matching the numbers labelled slide 2's narration as slide 1's.
    def rel(kind: str, target: str) -> str:
        return (
            "<Relationships><Relationship Id=\"rId1\" "
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" '
            f'Target="{target}"/></Relationships>'
        )

    data = build_zip(
        {
            "ppt/slides/slide1.xml": "<a:t>Agenda</a:t>",
            "ppt/slides/slide2.xml": "<a:t>Revenue</a:t>",
            "ppt/slides/_rels/slide1.xml.rels": rel(
                "slideLayout", "../slideLayouts/slideLayout1.xml"
            ),
            "ppt/slides/_rels/slide2.xml.rels": rel(
                "notesSlide", "../notesSlides/notesSlide1.xml"
            ),
            "ppt/notesSlides/notesSlide1.xml": "<a:t>Two contracts slipped into Q4.</a:t>",
        }
    )
    text = pptx.extract_pptx(data)
    assert text is not None, "pptx text"
    assert "[slide 2 notes]" in text, f"notes not on slide 2: {text}"
    assert "[slide 1 notes]" not in text, f"notes on slide 1: {text}"
    label = text.find("[slide 2 notes]")
    narration = text.find("Two contracts slipped")
    assert narration != -1, f"narration missing: {text}"
    assert narration > label, f"narration outside its label: {text}"


def test_stops_appending_slides_once_budget_is_spent() -> None:
    # Aggregate-budget guard: each slide is within the per-entry cap, but
    # the total across slides must not exceed the shared budget.
    data = build_zip(
        {f"ppt/slides/slide{n}.xml": f"<a:t>slide {n} body text</a:t>" for n in range(1, 4)}
    )
    all_text = pptx._extract_pptx_budgeted(data, 10_000)
    assert all_text is not None, "all slides"
    assert "slide 3 body text" in all_text, f"got: {all_text}"
    capped = pptx._extract_pptx_budgeted(data, 40)
    assert capped is not None, "first slide"
    assert "slide 1 body text" in capped, f"got: {capped}"
    assert "slide 3 body text" not in capped, f"budget ignored: {capped}"


def test_budget_stops_before_notes_followup_parts_and_later_slides() -> None:
    # Labels count against the aggregate output budget too. A one-byte slide
    # body produces a labelled result larger than this tiny budget, so no
    # notes, charts, or later slides may be consulted afterward.
    data = build_zip(
        {
            "ppt/slides/slide1.xml": "x",
            "ppt/slides/slide2.xml": "y",
            "ppt/charts/chart1.xml": "a chart value",
        }
    )
    text = pptx._extract_pptx_budgeted(data, 1)
    assert text == "[slide 1]\nx\n"


def test_skips_single_word_notes_charts_and_diagrams() -> None:
    data = build_zip(
        {
            "ppt/slides/slide1.xml": "body",
            "ppt/notesSlides/notesSlide1.xml": "alone",
            "ppt/charts/chart1.xml": "alone",
            "ppt/diagrams/data1.xml": "alone",
        }
    )
    text = pptx._extract_pptx_budgeted(data, 1_000)
    assert text == "[slide 1]\nbody\n"


def test_returns_none_when_a_part_exceeds_the_remaining_budget() -> None:
    data = build_zip({"ppt/charts/chart1.xml": "a chart value"})
    assert pptx._extract_pptx_budgeted(data, 1) is None


def test_helper_paths_match_the_rust_style_part_rules() -> None:
    assert pptx.slide_number("ppt/slides/slideNaN.xml") is None
    assert pptx.notes_part(b"", "slide.xml", 4) == "ppt/notesSlides/notesSlide4.xml"
    assert pptx.resolve_part("ppt/slides", "/ppt/notesSlides/notesSlide1.xml") == (
        "ppt/notesSlides/notesSlide1.xml"
    )
    assert pptx.resolve_part("ppt/slides", "./../notesSlides/notesSlide1.xml") == (
        "ppt/notesSlides/notesSlide1.xml"
    )
