"""Tests for `arcelle_sidecar.docs.article_markdown` (port of the
"Article markup -> Markdown" section of `src-tauri/src/extraction/article.rs`,
lines 203-477: `html_to_markdown` and its helpers).

Mirrors the Rust `#[cfg(test)]` cases `markdown_keeps_structure` and
`markdown_keeps_bare_container_text` verbatim -- these two call
`html_to_markdown` directly on hand-written HTML and do not depend on
Readability scoring at all.
"""

from __future__ import annotations

from arcelle_sidecar.docs.article_markdown import html_to_markdown


def test_markdown_keeps_structure() -> None:
    md = html_to_markdown(
        "<div><h2>Title</h2><p>Some <strong>bold</strong> and <em>soft</em> text with "
        "<code>x = 1</code>.</p><blockquote><p>Quoted line</p></blockquote>"
        "<ol><li>first</li><li>second</li></ol><pre>fn main() {}</pre>"
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
        '<p><a href="https://x.test/">link</a> and <a href="javascript:void(0)">js</a></p>'
        "<hr></div>"
    )
    assert "## Title" in md, md
    assert "Some **bold** and *soft* text with `x = 1`." in md, md
    assert "> Quoted line" in md, md
    assert "1. first" in md and "2. second" in md, md
    assert "```\nfn main() {}\n```" in md, md
    assert "| A | B |" in md and "| 1 | 2 |" in md, md
    assert "[link](https://x.test/)" in md, md
    # A javascript: href goes nowhere, so it stays as plain words.
    assert "js" in md and "javascript:" not in md, md
    assert "---" in md, md
    # Ordinary prose is NOT escaped: this string is what search indexes and
    # what the model reads back.
    assert "\\" not in md, f"prose must not be escaped: {md}"


def test_markdown_keeps_bare_container_text() -> None:
    # A `<div>` with no block children is a paragraph; without that case it
    # used to serialize to nothing at all.
    md = html_to_markdown("<div>bare words</div><section><div>nested</div></section>")
    assert "bare words" in md, md
    assert "nested" in md, md


def test_markdown_blockquote_containing_heading_and_list() -> None:
    # Adversarial case beyond the ported Rust suite: `write_block` recurses
    # into a blockquote's children at the same depth, so a heading or list
    # nested inside a `<blockquote>` still goes through the full block
    # dispatch -- every resulting line gets the "> " prefix, including the
    # "#"-heading line and each list-item line. Expected string confirmed
    # byte-for-byte against a standalone build of the cited Rust lines
    # (`html_to_markdown`/`write_block`/... against `dom_query = "0.28"`,
    # the pinned version in src-tauri/Cargo.toml) on this exact HTML.
    md = html_to_markdown(
        "<blockquote><h2>Quoted Heading</h2>"
        "<p>quoted para with <strong>bold</strong></p>"
        "<ul><li>a</li><li>b</li></ul></blockquote>"
    )
    assert md == "> ## Quoted Heading\n> quoted para with **bold**\n> - a\n> - b\n"


def test_markdown_nested_list_with_table_in_list_item() -> None:
    # Adversarial case beyond the ported Rust suite: a `<table>` inside a
    # `<li>` is NOT one of the tags `write_block`'s ul/ol branch treats as a
    # nested block (only `ul`/`ol` children get that treatment), so the
    # table's cell text is flattened into the item's inline text with no
    # pipe syntax -- while a genuinely nested `<ol>` inside a sibling `<li>`
    # still renders as its own indented, numbered block. Expected string
    # confirmed byte-for-byte against a standalone build of the cited Rust
    # lines (see test above) on this exact HTML.
    md = html_to_markdown(
        "<ul><li>Top item"
        "<ul><li>Nested item with a table"
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
        "</li><li>Nested second"
        "<ol><li>Deep one</li><li>Deep two</li></ol>"
        "</li></ul>"
        "</li><li>Second top item</li></ul>"
    )
    assert md == (
        "- Top itemNested item with a tableAB12Nested secondDeep oneDeep two\n"
        "  - Nested item with a tableAB12\n"
        "  - Nested secondDeep oneDeep two\n"
        "    1. Deep one\n"
        "    2. Deep two\n"
        "\n\n"
        "- Second top item\n"
    )
