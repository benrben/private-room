"""HTML text extraction: strip chrome/script/style elements, keep the main
article region when one exists, then strip remaining tags.

Port of `src-tauri/src/extraction/html.rs` (`strip_html`, `ascii_lower`).
Built on the shared `strip_tags` primitive in the sibling
`arcelle_sidecar.docs.xml_utils` module rather than redefining it.

----------------------------------------------------------------- ASCII fold

The Rust source searches for tag names in an ASCII-lowercased COPY of the
string, then slices/deletes from the ORIGINAL string using offsets found in
that copy. `str.to_lowercase()` (Rust) / `str.lower()` (Python) are both
Unicode-aware and NOT length-preserving -- Turkish `İ` (U+0130) folds to
`i` + a combining dot above (2 code points), which would shift every later
offset out of alignment with the original string, slicing mid-character or
raising. `_ascii_lower` below folds only `A`-`Z` to `a`-`z` and leaves every
other character (including non-ASCII ones) completely unchanged, so the
search copy stays EXACTLY the same length -- and character-for-character
aligned with the original at every index -- no matter what it contains. Tag
names are always ASCII, so this loses nothing.
"""

from __future__ import annotations

from arcelle_sidecar.docs.xml_utils import strip_tags

# CHG-28: when the page has a <main> or <article>, keep only that region so
# the limited tool-result budget is spent on body text, not site chrome.
_REGION_TAGS: tuple[str, ...] = ("<main", "<article")

# Paragraph/line-break-ish closers: a literal newline is appended after each
# occurrence so text doesn't run together once tags are stripped. Matched
# CASE-SENSITIVELY, exactly as the Rust source does -- this pass runs before
# any lowercasing.
_BREAK_TAGS: tuple[str, ...] = (
    "</p>",
    "</div>",
    "</li>",
    "</h1>",
    "</h2>",
    "</h3>",
    "</h4>",
    "</tr>",
    "<br>",
    "<br/>",
    "<br />",
)

# CHG-28: drop non-content element bodies (nav, chrome, forms, inline SVG)
# in addition to scripts/styles, so their link text and boilerplate don't
# crowd out the article.
_CHROME_PAIRS: tuple[tuple[str, str], ...] = (
    ("<script", "</script>"),
    ("<style", "</style>"),
    ("<nav", "</nav>"),
    ("<header", "</header>"),
    ("<footer", "</footer>"),
    ("<aside", "</aside>"),
    ("<form", "</form>"),
    ("<noscript", "</noscript>"),
    ("<svg", "</svg>"),
)


def _ascii_lower(s: str) -> str:
    """`str::to_ascii_lowercase` -- fold only 'A'-'Z', leave every other
    character (including non-ASCII ones) untouched, so the result stays
    exactly as long as `s` and aligned with it index-for-index. Deliberately
    NOT `str.lower()` (Unicode-aware, can change length -- see module
    docstring).
    """
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def strip_html(html: str) -> str:
    s = html
    for tag in _REGION_TAGS:
        lower = _ascii_lower(s)
        open_pos = lower.find(tag)
        if open_pos == -1:
            continue
        close = f"</{tag[1:]}>"
        rel = lower.rfind(close)
        if rel == -1:
            continue
        # A malformed page can put the closing tag before the opening one;
        # slicing backwards would be wrong, so leave `s` whole.
        if rel >= open_pos:
            s = s[open_pos : rel + len(close)]
            break

    for tag in _BREAK_TAGS:
        s = s.replace(tag, f"{tag}\n")

    for open_tag, close_tag in _CHROME_PAIRS:
        while True:
            lower = _ascii_lower(s)
            start = lower.find(open_tag)
            if start == -1:
                break
            found = lower.find(close_tag, start)
            if found == -1:
                break
            end = found + len(close_tag)
            s = s[:start] + s[end:]

    return strip_tags(s)
