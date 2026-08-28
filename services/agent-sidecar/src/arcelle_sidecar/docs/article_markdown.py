"""Article HTML -> Markdown serialization.

Port of `src-tauri/src/extraction/article.rs` lines 203-477 (the
"Article markup -> Markdown" section): `html_to_markdown`, `write_block`,
`is_block`, `write_table`, `inline`, `inline_into`, `wrap_children`,
`collapse`, `push_block`.

Written by hand rather than taken from a general HTML->Markdown library
because those escape `.`, `"`, `(`, `)` and `#` inside ordinary prose. It is
correct CommonMark and it renders fine, but the escaped string is ALSO what
the search index chunks and what the model reads back out of the file, and
`disbelief\\.` is not the word the page printed.

Mirrors the Rust tree-walk exactly, including places that look odd on
purpose: e.g. a bare `<script>`/`<style>` tag with no other markup falls
through to the generic "any other tag" branch in `_write_block`/
`_inline_into` and its raw text becomes prose. The Rust source does not
special-case those tags either -- the only real caller (`read_page`) always
passes Readability-cleaned article content, which has already had chrome
elements like `<script>` removed upstream.

----------------------------------------------------------------- Parser choice

Ported onto BeautifulSoup (bs4), already a direct dependency (`websearch.py`
uses it), with the builtin `html.parser` backend -- the same backend
`websearch.py` uses -- rather than adding lxml or html5lib as a new
dependency. Two backend-specific gaps had to be closed by hand to keep
parity with `dom_query::Document::from` (html5ever, the parser backing the
Rust side):

1. `Document::from` always parses a FULL document, and html5ever's tree
   construction algorithm synthesizes an implicit `<html>`/`<head>`/`<body>`
   wrapper even when the input has no such tags -- `doc.body()` therefore
   always returns the top-level parsed nodes as `<body>`'s children.
   `html.parser` never synthesizes that wrapper, so `html_to_markdown`
   below uses `soup.body`'s children when the input DID contain a literal
   `<body>` tag, and falls back to the soup's own top-level contents
   otherwise. The only real caller (`read_page`) always passes
   Readability's article content, which is a body's worth of markup with
   no literal `<body>` tag of its own -- so the two are the same set of
   nodes for every input this module actually receives, and for both of
   the ported Rust tests (neither contains a `<body>` tag).
2. html5ever's input-stream preprocessing step normalizes every `"\\r\\n"`
   and lone `"\\r"` to `"\\n"` before tokenizing even begins, per the HTML5
   spec, so no `"\\r"` ever reaches a text node on the Rust side.
   `html.parser` does not do this, so `html_to_markdown` normalizes line
   endings by hand before handing the string to BeautifulSoup.
"""

from __future__ import annotations

from bs4 import (
    BeautifulSoup,
    CData,
    Comment,
    Declaration,
    Doctype,
    NavigableString,
    ProcessingInstruction,
    Tag,
)

# NavigableString subclasses that are NOT plain character data in the
# html5ever/dom_query sense -- comments, doctypes, CDATA sections and
# processing instructions are distinct node kinds there, not "Text" nodes,
# so `NodeRef::is_text()` is false for them. `Script`/`Stylesheet` (bs4's
# subclasses for `<script>`/`<style>` contents) are deliberately NOT in this
# tuple: html5ever stores their content as a plain Text child too.
_STRING_NON_TEXT: tuple[type, ...] = (Comment, Doctype, CData, ProcessingInstruction, Declaration)

# Element names that start a block of their own -- the test for whether a
# container should be recursed into or flattened into one paragraph.
_BLOCK_TAGS: frozenset[str] = frozenset(
    {
        "address",
        "article",
        "aside",
        "blockquote",
        "div",
        "dl",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "main",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "ul",
    }
)


def html_to_markdown(html: str) -> str:
    """Serialize extracted article markup as Markdown -- headings, lists,
    block quotes, code, tables, links and images kept.
    """
    # See the "Parser choice" note in the module docstring, point 2.
    html = html.replace("\r\n", "\n").replace("\r", "\n")
    soup = BeautifulSoup(html, "html.parser")
    top_level = soup.body.contents if soup.body is not None else soup.contents

    out: list[str] = []
    for child in top_level:
        _write_block(child, out, 0)

    # Blocks each end with their own blank line; collapse the runs that
    # nesting produces so the file does not read as double-spaced.
    text_parts: list[str] = []
    blanks = 0
    for line in _lines("".join(out)):
        if line.strip() == "":
            blanks += 1
            continue
        if text_parts and blanks > 0:
            text_parts.append("\n\n")
        blanks = 0
        # A line inside a list or a code fence keeps its neighbours: only
        # the blank-run counter above separates blocks.
        text_parts.append(line.rstrip())
        text_parts.append("\n")
    return "".join(text_parts)


def _write_block(node: object, out: list[str], depth: int) -> None:
    """Emit one block-level node. `depth` is the list nesting level."""
    if _is_text(node):
        t = _collapse(str(node))
        if t:
            _push_block(out, t)
        return
    if not _is_element(node):
        return

    name = _node_name(node)

    if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
        level = int(name[1:])
        text = _inline(node)
        if text:
            _push_block(out, f"{'#' * level} {text}")
        return

    if name in ("p", "figcaption"):
        text = _inline(node)
        if text:
            _push_block(out, text)
        return

    if name == "blockquote":
        inner: list[str] = []
        for child in node.contents:
            _write_block(child, inner, depth)
        quoted = [f"> {line}" for line in _lines("".join(inner)) if line.strip()]
        if quoted:
            _push_block(out, "\n".join(quoted))
        return

    if name in ("ul", "ol"):
        ordered = name == "ol"
        indent = "  " * depth
        n = 0
        items: list[str] = []
        for li in node.contents:
            if _node_name(li) != "li":
                continue
            n += 1
            marker = f"{n}. " if ordered else "- "
            text = _inline(li)
            if text:
                items.append(f"{indent}{marker}{text}\n")
            # A nested list is a block inside the item, not inline text.
            for child in li.contents:
                if _node_name(child) in ("ul", "ol"):
                    _write_block(child, items, depth + 1)
        joined = "".join(items)
        if joined.strip():
            _push_block(out, joined.rstrip("\n"))
        return

    if name == "pre":
        code = _text_content(node)
        if code.strip():
            _push_block(out, f"```\n{code.rstrip()}\n```")
        return

    if name == "hr":
        _push_block(out, "---")
        return

    if name == "table":
        table_md = _write_table(node)
        if table_md:
            _push_block(out, table_md)
        return

    if name == "img":
        text = _inline(node)
        if text:
            _push_block(out, text)
        return

    # Anything else (div, section, article, figure, aside kept by the
    # scorer…) is a container: recurse when it holds blocks, otherwise
    # treat its inline content as one paragraph. Without the second half a
    # `<div>bare text</div>` would vanish.
    if any(_is_block(child) for child in node.contents):
        for child in node.contents:
            _write_block(child, out, depth)
    else:
        text = _inline(node)
        if text:
            _push_block(out, text)


def _is_block(node: object) -> bool:
    return _is_element(node) and _node_name(node) in _BLOCK_TAGS


def _write_table(table: Tag) -> str:
    """Markdown rows for one table. Headerless tables get an empty header
    row, so the result is still a table every renderer accepts.
    """
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        cells = [
            _inline(c).replace("|", "\\|")
            for c in tr.contents
            if _is_element(c) and _node_name(c) in ("td", "th")
        ]
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    out: list[str] = []
    for i, row in enumerate(rows):
        cells = row + [""] * (width - len(row))
        out.append(f"| {' | '.join(cells)} |\n")
        if i == 0:
            out.append("|" + " --- |" * width + "\n")
    return "".join(out).rstrip()


def _inline(node: object) -> str:
    """A node's inline content: text with links, images and emphasis kept."""
    out: list[str] = []
    _inline_into(node, out)
    return _collapse("".join(out))


def _inline_into(node: object, out: list[str]) -> None:
    if _is_text(node):
        out.append(str(node))
        return
    if not _is_element(node):
        return

    name = _node_name(node)

    if name == "a":
        text = _collapse(_text_content(node))
        # A link with no text is furniture (an icon, an anchor); a
        # `javascript:` href is not somewhere the reader can go.
        if not text:
            return
        href = node.get("href") or ""
        if not href or href.startswith("javascript:"):
            out.append(text)
        else:
            out.append(f"[{text}]({href})")
        return

    if name == "img":
        src = node.get("src") or ""
        if src:
            alt = _collapse(node.get("alt") or "")
            out.append(f"![{alt}]({src})")
        return

    if name == "br":
        out.append(" ")
        return

    if name in ("code", "kbd", "samp"):
        text = _collapse(_text_content(node))
        if text:
            out.append(f"`{text}`")
        return

    if name in ("strong", "b"):
        _wrap_children(node, out, "**")
        return

    if name in ("em", "i"):
        _wrap_children(node, out, "*")
        return

    for child in node.contents:
        _inline_into(child, out)


def _wrap_children(node: Tag, out: list[str], marker: str) -> None:
    inner: list[str] = []
    for child in node.contents:
        _inline_into(child, inner)
    collapsed = _collapse("".join(inner))
    if not collapsed:
        return
    out.append(marker)
    out.append(collapsed)
    out.append(marker)


def _text_content(node: object) -> str:
    """All descendant text, concatenated raw with no separators -- mirrors
    dom_query's `NodeRef::text()`, a plain recursive walk that does not
    special-case any tag (including `<script>`/`<style>`).
    """
    if _is_text(node):
        return str(node)
    if not _is_element(node):
        return ""
    return "".join(_text_content(child) for child in node.contents)


def _collapse(s: str) -> str:
    """HTML whitespace rules: any run of spaces, tabs and newlines is one
    space.
    """
    return " ".join(s.split())


def _push_block(out: list[str], block: str) -> None:
    out.append(block)
    out.append("\n\n")


def _is_text(node: object) -> bool:
    return isinstance(node, NavigableString) and not isinstance(node, _STRING_NON_TEXT)


def _is_element(node: object) -> bool:
    return isinstance(node, Tag)


def _node_name(node: object) -> str:
    if not _is_element(node):
        return ""
    return (node.name or "").lower()


def _lines(s: str) -> list[str]:
    """Mirror Rust's `str::lines()`: split on "\\n" only, with no trailing
    empty line for a string that ends in "\\n". (No "\\r" ever reaches this
    function -- `html_to_markdown` normalizes it away up front, and every
    other string this module builds is markdown syntax it generated itself.)
    """
    if s == "":
        return []
    parts = s.split("\n")
    if s.endswith("\n"):
        parts.pop()
    return parts
