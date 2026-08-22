"""The readable article inside a web page -- the body, with the site's
furniture stripped, in the three shapes the room stores it in.

Port of `src-tauri/src/extraction/article.rs` lines 74-201: `ArticleBody`,
`PageCapture`, `MIN_ARTICLE_CHARS`, `read_page`, `read_page_inner`,
`strip_event_handlers`, `read_page_bytes`. `PageMeta` / `extract_page_meta`
(the page's own DECLARED metadata) are imported from the sibling
`article_meta` module, which is final -- nothing about metadata is
redefined here. `html_to_markdown` is imported from the sibling
`article_markdown` module, likewise final.

This file is the JUDGED MERGE of two independently written candidates
(`article_candidate_a.py` / `article_candidate_b.py`, both since deleted).
Both candidates picked the same library (`readability-lxml`) and both
independently discovered the same real scoring bug in it (see "library
choice" below) -- but each compensated for it differently, and each had a
real defect the other did not. Neither candidate is used verbatim; this
module takes the correctness fix from one, the safety-relevant chrome list
from the other, and the more useful text-shape from the one that had it.
See "what came from where" at the end of this docstring for the specifics.

------------------------------------------------------------- library choice

The Rust source scores content with `dom_smoothie`, a Rust port of
Mozilla's Readability.js. There is no Python package that reproduces that
exact algorithm bit-for-bit. This port uses **readability-lxml** (PyPI
`readability-lxml`, imported as `import readability`, `readability.Document`)
-- verified by installing it (`uv add readability-lxml`) and reading its
actual installed source (`readability/readability.py`, `readability/
cleaners.py`, and the `lxml.html.clean.Cleaner` it wraps) rather than
trusting any description of it. It is the most widely used, actively
maintained pure-Python-plus-lxml port of the original Arc90/Mozilla
Readability *algorithm* (score paragraphs by link-density-adjusted content
weight, walk candidate ancestors, sanitize the winner). Apache-2.0
licensed; `lxml` is a C extension but ships manylinux/macOS wheels and
PyInstaller-bundles cleanly, same as this project's other C-extension
dependencies (`lxml` is already a transitive dependency via other document
readers in this package). `Document(html, url=...)` resolves relative
`src`/`href` to absolute automatically when `url` is given (`lxml.html.
make_links_absolute` inside `Document._parse`, confirmed by reading the
source and empirically against the fixtures below) -- no separate
`urllib.parse.urljoin` pass is needed. `beautifulsoup4` (already a direct
dependency, used by `websearch.py` and the sibling `article_meta`/
`article_markdown` modules) does the tree-walking this module needs on top
of readability-lxml's output, with the `"html.parser"` backend those
sibling modules already use -- no second HTML library.

**Deliberate, permanent, documented deviation from bit-for-bit Rust
parity**: `readability-lxml`'s scoring heuristics are not `dom_smoothie`'s
and WILL disagree with it on genuinely marginal pages (verified during this
merge on a Wikipedia-shaped page and a blog-with-sidebar page beyond the
ported fixtures: both libraries would plausibly handle a bare, class-less
`<div id="siteNotice">` differently, and neither this port nor a
hypothetical `dom_smoothie` run is obviously "more correct" on that kind of
edge). What must hold regardless of the scoring disagreement -- and is
verified below, empirically, not assumed -- is: real chrome (nav/footer/ads)
is dropped, real article prose survives with its structure, a page with no
real article returns `article = None` rather than presenting chrome as
content, relative `src`/`href` resolve to absolute against the page URL, and
nothing from the page's own script/markup surface survives into the saved
copy that the Rust source's own `strip_event_handlers` docstring says must
not survive.

Three concrete gaps had to be closed, all found and verified empirically
against real readability-lxml behavior (not assumed from documentation),
to make those properties hold:

1. **A real scoring bug that hands `<body>` an unearned advantage.**
   `readability-lxml` marks the document's own `<body>` element with
   `id="readabilityBody"` for internal bookkeeping *before* scoring runs,
   and its own class/id positive-weight regex contains the literal word
   "body" -- so that internal marker gives `<body>` a scoring bonus it
   would not otherwise have. Verified concretely: running the unmodified
   library on this module's own `NEWS` test fixture with only `<nav>`/
   `<aside>`/`<footer>` present (no other pre-processing) makes `<body>`
   itself -- nav, article and footer all together -- the winning
   candidate, and `Subscribe now` / `Privacy policy` ride straight through
   into the "article." `readability-lxml`'s own "unlikely candidate"
   removal only matches `class`/`id` *keywords*, unlike Mozilla's actual
   Readability.js/`dom_smoothie`, which also drops chrome by *tag name*
   regardless of class. This module therefore removes `<nav>`, `<footer>`,
   `<aside>`, `<form>`, `<iframe>` and `<noscript>` from a WORKING COPY of
   the raw HTML before it ever reaches `readability.Document` (see
   `_prune_chrome`) -- never `<header>`, since a real article's own byline/
   headline block is commonly wrapped in `<header>` at the article-content
   level (`<article><header><h1>...`), and none of the ported fixtures need
   it stripped. `iframe`/`form`/`noscript` are additionally justified below
   (point 3) as more than a scoring-safety belt. `extract_page_meta` always
   runs on the ORIGINAL, un-pruned HTML -- this pre-strip is scoped to the
   scorer's input only.

2. **The wrapper marker from point 1 can leak into the saved article HTML.**
   When `<body>` (or the pruned document's sole remaining top-level
   element) IS the winning candidate, `Document.summary(html_partial=True)`
   returns its result already wrapped as `<div><body id="readabilityBody">
   ...</body></div>` -- and unlike the class/id keyword match in point 1,
   this is not something the pre-pruning in point 1 reliably avoids: it
   reproduces even on the *pruned* `NEWS` fixture, where `<body>`'s only
   remaining child is `<article>` and `<body>` still wins by default,
   verified empirically against this exact fixture through the full
   `read_page` pipeline. Saving a nested `<body id="readabilityBody">` tag
   into a room file that gets embedded into another document's DOM is not
   faithful output regardless of what a Rust equivalent would have done, so
   `_unwrap_summary` strips that specific wrapper (and only that wrapper --
   a winning candidate that was NOT `<body>` is returned unchanged).

3. **A `<script>`-and-`<iframe>`-removal guarantee this codebase's own Rust
   docstring states outright is NOT reliably true of `readability-lxml`.**
   The Rust `strip_event_handlers` doc comment says the extractor "removes
   `<script>` and `<iframe>` elements... it leaves inline handlers alone."
   `readability-lxml` removes `<script>` unconditionally, and removes most
   `<iframe>`s too (`Document.sanitize` drops any `<iframe>` from the
   winning candidate) -- BUT NOT when the iframe's `src` looks like a video
   embed (its own `videoRe` pattern): that one case is deliberately KEPT,
   with only its text content replaced by the literal string `"VIDEO"`,
   `src` and all. Verified empirically: an `<iframe>` whose `src` is a real
   video-hosting embed URL, sitting directly in otherwise-real article
   prose, survives unpruned into `Document.summary()`'s output. A stored
   reading copy carrying a live third-party `<iframe src=...>` into a
   same-origin-scripts viewer means that URL gets a real network request
   every time the room reopens the saved page for reading -- entirely
   outside any browsing context the user chose, which is exactly the kind
   of uncontrolled outbound request this codebase treats as a privacy leak
   elsewhere (see the sibling privacy-gatekeeper and MCP-outbound-masking
   work). The point-1 pre-prune of `<iframe>` (and, for the same "an
   element surviving into the saved copy is a small tracking/embedding
   vector, not just chrome" reasoning, `<form>` and `<noscript>`) closes
   this regardless of the video-src exception. Separately: on inline event
   *attributes* specifically (`onclick`, `onerror`, ...), `readability-lxml`
   is inconsistent between two of its own mechanisms -- its bundled
   `readability/cleaners.py` module defines `bad_attrs = [..., "on*"]` used
   inside a raw (unescaped) regex alternation, where the literal substring
   `"on*"` means "the letter 'o' followed by zero or more 'n's", NOT
   "on-anything" (verified: this specific regex does not match `onclick=`
   or `onerror=` at all). Separately, the underlying `lxml.html.clean.
   Cleaner(javascript=True)` it also runs DOES strip `on`-prefixed
   attributes, via its own direct `attrib.startswith('on')` check (verified
   by reading `lxml/html/clean.py` and confirming empirically that
   `onclick`/`onerror`/`ONLOAD` do NOT survive `Document.summary()` on this
   module's `the_pages_scripts_do_not_come_with_the_article` fixture). So
   the specific `bad_attrs` regex is dead code for this purpose, but the
   *library* still does the job today via its other mechanism -- this
   module's own `_strip_event_handlers` (below) does not rely on either:
   it is an explicit, tested, independent guarantee that does not depend on
   which of the vendor's two mechanisms is doing the work this month, in
   the same spirit as the Rust source's own comment that the extractor
   "happened to" delete `<script>` tags and that is not something to lean
   on structurally.

------------------------------------------------------------ text extraction

`dom_smoothie`'s `Readability::parse()` returns a `text_content` field
(`TextMode::Formatted`, paragraph breaks kept) that `readability-lxml` has
no equivalent for -- it only hands back HTML. This module derives plain
text itself (`_article_text`) by walking the sanitized article HTML: a
block-level element with no block-level descendant becomes one paragraph of
its own collapsed text; one that DOES hold further block-level content is
recursed into instead. List items (`<li>`) and table rows (`<tr>`) are
included in the block set used for THIS walk specifically (not the Rust
`is_block` list verbatim, which drives markdown structure, not the plain
text field, and has no `dom_smoothie` `text_content` shape to match either
way) so that `<li>Eleven nests counted</li><li>Two ringed adults</li>`
becomes two separate, search-index-friendly lines rather than one run-on
paragraph -- verified against the fixtures below to keep a paragraph
containing an inline link (`Read the <a>marsh history</a> for the long
version.`) as ONE paragraph, not fragmented at the `<a>` boundary, which a
bare `soup.get_text(separator="\\n\\n")` would do.

--------------------------------------------------------- parser convention

Built on `bs4.BeautifulSoup` with the `"html.parser"` backend throughout
(`_prune_chrome`, `_unwrap_summary`, `_strip_event_handlers`,
`_article_text`) -- the same library and backend `websearch.py` and the
sibling `article_meta.py` / `article_markdown.py` modules already use.

------------------------------------------------------- what came from where

Both independent candidates used `readability-lxml` and both independently
found the point-1 `<body id="readabilityBody">` scoring bug -- convergent
evidence it is real, not a fixture artifact of one candidate's approach.
Candidate A found and fixed point 1 (pre-pruning `<nav>`/`<footer>`/
`<aside>`/`<form>`/`<iframe>`/`<noscript>`) but did NOT fix point 2: its own
`read_page` on the `NEWS` fixture (verified by running its actual code, not
just reading it) leaves a literal `<body id="readabilityBody">` wrapper in
`article.html`, past its own green test suite, because none of its ported
tests asserted the wrapper's absence. Candidate B fixed point 2
(`_unwrap_summary`) and had the better text-shape (the `li`/`tr` splitting
above), but pruned only `<nav>`/`<footer>`/`<aside>` -- which is why the
point-3 live-YouTube-iframe survival above was reproducible through
candidate B's actual `read_page` but not candidate A's. This module is
therefore: candidate A's chrome tag list (point 1 and point 3), candidate
B's wrapper fix (point 2) and text-extraction shape, and a docstring that
states plainly which library mechanism is actually responsible for
`on`-attribute removal today (point 3's last paragraph) rather than
either candidate's original, narrower claim about it.
"""

from __future__ import annotations

from dataclasses import dataclass

import readability
from bs4 import BeautifulSoup, Comment, NavigableString, Tag

from arcelle_sidecar.docs.article_markdown import html_to_markdown
from arcelle_sidecar.docs.article_meta import PageMeta, extract_page_meta
from arcelle_sidecar.docs.text_decode import decode_text_bytes

__all__ = ["MIN_ARTICLE_CHARS", "ArticleBody", "PageCapture", "read_page", "read_page_bytes"]

# Below this, "the article" is a caption or a paywall stub, not a body. The
# caller falls back to the whole page instead, which at least keeps the
# words. Matches the Rust `MIN_ARTICLE_CHARS` exactly.
MIN_ARTICLE_CHARS: int = 140

# Elements dropped from a WORKING COPY of the page before it ever reaches
# the scorer -- see the module docstring's "library choice" section, points
# 1 and 3. Deliberately excludes `<header>`.
_CHROME_TAGS: tuple[str, ...] = ("nav", "footer", "aside", "form", "iframe", "noscript")

# Block-level elements for `_article_text`'s tree-walk specifically -- see
# the module docstring's "text extraction" section for why `li`/`tr` are
# included here even though the Rust `is_block` list (which drives markdown
# structure, a different concern with its own sibling module) does not have
# them. Not imported from `article_markdown` -- that module's set is a
# private implementation detail of ITS own tree-walk.
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
        "li",
        "main",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tr",
        "ul",
    }
)

# NavigableString subclasses that are not plain character data -- comments
# must not become "prose" in the extracted text.
_STRING_NON_TEXT: tuple[type, ...] = (Comment,)


@dataclass
class ArticleBody:
    """The readable article: the same content in the three shapes the room
    stores it in -- HTML for the viewer, Markdown for the file, plain text
    for search. `html` has the site's chrome removed and relative
    `src`/`href` resolved against the page URL.
    """

    html: str
    markdown: str
    text: str


@dataclass
class PageCapture:
    """A page read apart: what it declares, and the article inside it.

    `article` is `None` when there is no article to extract -- a
    search-results page, an app shell, a page that never loaded. The caller
    must say so rather than present the chrome as an article.
    """

    meta: PageMeta
    article: ArticleBody | None


def read_page(html: str, url: str | None) -> PageCapture:
    """Read a page's declared metadata and its readable article.

    `url` is the page's own address when it is known: the scorer needs it to
    turn relative `src`/`href` into absolute ones, so the saved copy's
    images and links still point somewhere. It is never invented -- a
    capture with no URL simply keeps the page's relative references.

    Untrusted markup through a third-party parser, so an exception inside it
    must cost this extraction and nothing else (Python has no
    panic/catch_unwind to mirror, but the intent -- and the fallback shape --
    is the same as the Rust source's `catch_unwind`): any failure here
    returns an empty capture (default metadata, no article) rather than
    propagating.
    """
    try:
        return _read_page_inner(html, url)
    except Exception:
        return PageCapture(meta=PageMeta(), article=None)


def _read_page_inner(html: str, url: str | None) -> PageCapture:
    # Metadata FIRST, on the ORIGINAL html -- a page whose article cannot be
    # scored still declares a title, an author and a date. `extract_page_meta`
    # does not raise on malformed input (see its own docstring), so nothing
    # past this point can cost the metadata already captured here.
    meta = extract_page_meta(html, url)

    # An absolute URL is what the scorer needs to resolve relative
    # references; a bare or malformed one must cost the URL, not the whole
    # extraction. Mirrors the Rust `abs` filter exactly.
    abs_url = url if url is not None and (url.startswith("http://") or url.startswith("https://")) else None

    summary_html: str | None = None
    try:
        prepared = _prune_chrome(html)
        document = readability.Document(prepared, url=abs_url)
        summary_html = document.summary(html_partial=True)
    except Exception:
        # A page the scorer cannot parse at all is "no article", exactly
        # like a page it parses but finds nothing in -- the caller already
        # handles both the same way. Metadata already captured above
        # survives this.
        summary_html = None

    article: ArticleBody | None = None
    if summary_html:
        article_html = _unwrap_summary(summary_html)
        article_html = _strip_event_handlers(article_html)
        text = _article_text(article_html)
        if len(text) >= MIN_ARTICLE_CHARS:
            markdown = html_to_markdown(article_html)
            article = ArticleBody(html=article_html, markdown=markdown, text=text)

    return PageCapture(meta=meta, article=article)


def _prune_chrome(html: str) -> str:
    """A working copy of `html` with `<nav>`/`<footer>`/`<aside>`/`<form>`/
    `<iframe>`/`<noscript>` elements removed outright, before it reaches the
    scorer. See the module docstring's "library choice" section, points 1
    and 3, for why this is necessary and why `<header>` is deliberately
    excluded.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(_CHROME_TAGS):
        tag.decompose()
    return str(soup)


def _unwrap_summary(summary_html: str) -> str:
    """`readability.Document.summary(html_partial=True)` sometimes wraps its
    result in a synthetic `<body id="readabilityBody">` element -- an
    internal bookkeeping marker the library sets on the document's own
    `<body>` tag before scoring (see the module docstring's point 2), which
    surfaces in the output whenever `<body>` itself ends up as the winning
    candidate. Unwrap it if present, keeping only its children, so the
    room's saved article HTML never carries the library's own scratch
    marker. A summary that is NOT wrapped this way (the winning candidate
    was some other, more specific node) is returned unchanged.
    """
    frag = BeautifulSoup(summary_html, "html.parser")
    container = frag.body if frag.body is not None else frag
    return "".join(str(child) for child in container.contents)


def _strip_event_handlers(html: str) -> str:
    """Drop `on*` attributes from extracted article markup.

    A content extractor is not a sanitizer: the Rust source's own
    `strip_event_handlers` doc comment says as much, and this port's own
    investigation (see the module docstring's point 3) found the same
    library-reliability gap it warns about -- `readability-lxml` strips
    these today via one of its own mechanisms, but not via the mechanism it
    LOOKS like it uses, and that is exactly the kind of thing not to depend
    on continuing to hold across an upgrade. `<p onclick="…">` and
    `<img src=… onerror="…">` must not survive into a file that opens in a
    viewer whose iframe runs the page's own inline JS (sandboxed, but
    same-origin scripts), so this pass runs unconditionally regardless of
    what the vendor library already did.

    Every element with at least one attribute whose name is longer than 2
    characters and starts with "on" (case-insensitive) has exactly those
    attributes removed; every other attribute, and all other content, is
    left untouched. Matches the Rust `strip_event_handlers`'s `n.len() > 2`
    check exactly (so a hypothetical 2-character "on" attribute, if one
    could ever exist, would not be touched either).
    """
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.find_all(True):
        handlers = [name for name in el.attrs if len(name) > 2 and name[:2].lower() == "on"]
        for name in handlers:
            del el[name]
    # `str(soup)` round-trips a bare fragment (no synthesized html/body
    # wrapper from `html.parser`), so this is safe to use directly as the
    # article's HTML.
    return str(soup)


def _article_text(html: str) -> str:
    """Plain, paragraph-separated text for the extracted article: each
    block-level element's own text (collapsed whitespace, no fragmentation
    from inline children like `<a>`/`<strong>`) becomes one paragraph,
    paragraphs joined by a blank line. See the module docstring's "text
    extraction" section for why `<li>`/`<tr>` are their own paragraphs here.
    """
    soup = BeautifulSoup(html, "html.parser")
    paragraphs: list[str] = []
    _collect_text_blocks(soup, paragraphs)
    return "\n\n".join(paragraphs)


def _collect_text_blocks(node: BeautifulSoup | Tag, paragraphs: list[str]) -> None:
    for child in node.contents:
        if isinstance(child, Tag):
            name = (child.name or "").lower()
            if name in ("script", "style"):
                continue
            if name in _BLOCK_TAGS:
                has_block_child = any(
                    isinstance(gc, Tag) and (gc.name or "").lower() in _BLOCK_TAGS for gc in child.contents
                )
                if has_block_child:
                    _collect_text_blocks(child, paragraphs)
                else:
                    text = " ".join(child.get_text(" ").split())
                    if text:
                        paragraphs.append(text)
            else:
                _collect_text_blocks(child, paragraphs)
        elif isinstance(child, NavigableString) and not isinstance(child, _STRING_NON_TEXT):
            text = " ".join(str(child).split())
            if text:
                paragraphs.append(text)


def read_page_bytes(data: bytes, url: str | None) -> PageCapture:
    """`read_page` over raw bytes -- the shape every fetched or imported
    page arrives in. The decode is `decode_text_bytes` (BOM -> strict UTF-8
    -> detection), the same one every other text format in the app goes
    through: a page served as windows-1255 has to become Hebrew BEFORE any
    tag is looked at, because no HTML pass can recover a character already
    replaced.
    """
    return read_page(decode_text_bytes(data), url)
