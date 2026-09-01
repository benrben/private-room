"""Tests for `arcelle_sidecar.docs.svg` (port of the SVG section of
`src-tauri/src/extraction/data.rs`: `extract_svg` and `_strip_inner_tags`).

Mirrors the Rust `#[cfg(test)]` SVG case verbatim (`an_svg_gives_up_its_labels`)
plus the SVG line of `unreadable_bytes_read_as_nothing_rather_than_panicking`
(an empty `<svg></svg>` returns `None`), and adds a regression case for the
`<text>` / `<textPath>` name-boundary check that the Rust source's inline
comment calls out explicitly.
"""

from __future__ import annotations

from arcelle_sidecar.docs import svg
from arcelle_sidecar.docs.svg import extract_svg


def test_an_svg_gives_up_its_labels() -> None:
    svg = '<svg><title>Revenue</title><text x="1">Q1 2026</text><path d="M0 0"/></svg>'
    text = extract_svg(svg)
    assert text is not None
    assert "Revenue" in text
    assert "Q1 2026" in text
    assert "M0 0" not in text, f"path data reached the index: {text}"


def test_an_empty_svg_reads_as_nothing() -> None:
    assert extract_svg("<svg></svg>") is None


def test_textpath_before_text_is_not_falsely_matched_by_the_text_pass() -> None:
    """A `<textPath>` element appearing BEFORE any real `<text>` element must
    not be mistaken for one: searching for `<text` inside `<textPath ...>`
    would otherwise match the false prefix (the character right after
    `<text` is `P`, not whitespace/`>`/`/`), swallow everything up through
    the *real* `<text>` element's closing tag, and merge both bodies into
    one entry instead of reading them as two separate matches under their
    own element-name passes.
    """
    svg = (
        '<svg><textPath xlink:href="#curve">Along the Path</textPath>'
        "<text>Flat Label</text></svg>"
    )
    text = extract_svg(svg)
    assert text is not None
    assert "Along the Path" in text
    assert "Flat Label" in text
    # Neither body swallowed the other's content into one run-on entry.
    assert "Along the PathFlat Label" not in text
    assert "Flat LabelAlong the Path" not in text
    lines = [line for line in text.split("\n") if line]
    assert "Along the Path" in lines
    assert "Flat Label" in lines
    assert len(lines) == 2


def test_element_name_matching_is_case_insensitive() -> None:
    """Both the opening tag search and the closing tag search run against an
    ASCII-lowercased copy, so mismatched tag case (`<TEXT>...</TeXt>`) must
    still be recognized as one element, with the RAW (original-case) body
    text preserved in the output.
    """
    svg = "<svg><TEXT>Shout</TeXt></svg>"
    text = extract_svg(svg)
    assert text is not None
    assert "Shout" in text


def test_non_ascii_body_content_stays_aligned_across_element_passes() -> None:
    """Multi-byte characters in an element's body must not desynchronize the
    ASCII-only lowercased search copy from the original string's offsets --
    every element after the multi-byte one must still be found and its body
    extracted intact (not truncated or shifted).
    """
    svg = (
        "<svg><title>מבחן</title>"
        "<desc>emoji test \U0001f389</desc>"
        "<text>Café résumé</text></svg>"
    )
    text = extract_svg(svg)
    assert text is not None
    assert "מבחן" in text
    assert "emoji test \U0001f389" in text
    assert "Café résumé" in text


def test_nested_markup_and_unmatched_closing_angle_brackets_are_preserved_as_before() -> None:
    """Tags are removed, entities decoded, and a stray closing angle bracket
    is ignored.  The nested `tspan` is intentionally reported once through
    its parent `text` and once by the dedicated `tspan` pass.
    """
    text = extract_svg(
        "<svg><text>Lead <tspan>middle</tspan> tail > end &amp; done</text></svg>"
    )
    assert text == "Lead middle tail  end & done\nmiddle\n"


def test_unfinished_svg_text_elements_read_as_nothing() -> None:
    """A recognized open tag needs both its closing `>` and closing element.
    Malformed input must stop extraction rather than inventing prose.
    """
    assert extract_svg("<svg><text") is None
    assert extract_svg("<svg><text ") is None
    assert extract_svg("<svg><text>unclosed") is None


def test_svg_extraction_caps_at_a_whole_utf8_character(monkeypatch) -> None:
    """The cap is a byte limit, so a multibyte character is never cut in two
    and later elements add nothing once the cap is full.
    """
    monkeypatch.setattr(svg, "_MAX_DERIVED_CHARS", 3)
    assert svg.extract_svg("<svg><text>åå</text></svg>") == "å\n"
    assert svg.extract_svg("<svg><text>ab</text><text>x</text></svg>") == "ab\n"
