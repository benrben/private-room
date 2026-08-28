"""A saved page's DECLARED metadata -- what the page itself says about
itself, kept separate from the article body.

Port of `PageMeta` / `PageMeta::is_undeclared` (lines 1-72) and `some_text`
(lines 195-201) in `src-tauri/src/extraction/article.rs`. The Rust source
gets the actual metadata cascade from the `dom_smoothie` crate's
`Readability::get_article_metadata` / `parse_json_ld` -- a Rust port of
Mozilla's Readability.js -- which has no Python equivalent to lean on. This
module hand-implements the same KIND of cascade over a `BeautifulSoup`
parse of the `<head>`: JSON-LD first (the most explicit, structured
declaration a page can make), then the `article:`/`og:` meta family, then
the plain fallbacks (`<title>`, `twitter:title`). The precedence below was
tuned empirically against the two ported Rust fixture tests
(`test_declared_metadata_is_captured`,
`test_metadata_a_page_never_declared_reads_as_absent`) -- those tests are
the ground truth, not this docstring.

Nothing here invents a value. In particular:

* `excerpt` reads ONLY `meta description` / `og:description` -- never the
  article's own first paragraph. A lede lifted from the body and labelled
  "summary" is metadata the page never actually declared; that is exactly
  what `test_metadata_a_page_never_declared_reads_as_absent` locks in (the
  bare fixture has real paragraph text but no declared excerpt, and the
  excerpt must come back `None`).
* `published`/`modified` are kept EXACTLY as the page wrote them, never
  reformatted -- a date this module reformats is a date it can get wrong.
* Every field is run through `_some_text`, so a page that declares a field
  as an empty or whitespace-only string (`<meta name="author" content="   ">`)
  reads as `None` -- "declared blank" and "never declared" are the same
  thing to a room that would otherwise repeat the blank forever.

Built on `bs4.BeautifulSoup` (already a direct dependency, used by
`websearch.py`) for the head-only tree-walking this module needs, with the
built-in `"html.parser"` backend -- the same one `websearch.py` uses -- so
no second HTML/XML library is pulled in for this.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from bs4 import BeautifulSoup

__all__ = ["PageMeta", "extract_page_meta"]


@dataclass
class PageMeta:
    """What a page says about itself. Mirrors the Rust `PageMeta` struct
    field-for-field; `source_url`/`captured_at` are the ROOM's own facts
    (set by the caller), not things the page declared.
    """

    title: str | None = None
    byline: str | None = None
    site_name: str | None = None
    published: str | None = None
    modified: str | None = None
    excerpt: str | None = None
    lang: str | None = None
    source_url: str | None = None
    captured_at: str | None = None

    def is_undeclared(self) -> bool:
        """True when the page declared nothing beyond what the room already
        knew. `source_url`/`captured_at` are deliberately excluded, matching
        the Rust method exactly -- they are the room's facts, not the page's.
        """
        return (
            self.title is None
            and self.byline is None
            and self.site_name is None
            and self.published is None
            and self.modified is None
            and self.excerpt is None
            and self.lang is None
        )


def _some_text(s: str | None) -> str | None:
    """A trimmed value, or `None` when the field was empty/whitespace-only.
    `""` and `"  "` both mean "not declared" and must not survive as a
    field the room can print. Port of the Rust `some_text` free function.
    """
    if s is None:
        return None
    t = s.strip()
    return t if t else None


def _meta_content(soup: BeautifulSoup, *, name: str | None = None, property: str | None = None) -> str | None:
    """The `content` attribute of the first `<meta>` tag matching `name=` or
    `property=` (exactly one of the two is given by every caller here).
    `None` if no such tag exists, or its `content` attribute is missing.
    """
    attrs: dict[str, str] = {}
    if name is not None:
        attrs["name"] = name
    if property is not None:
        attrs["property"] = property
    tag = soup.find("meta", attrs=attrs)
    if tag is None:
        return None
    content = tag.get("content")
    return content if isinstance(content, str) else None


def _looks_article_shaped(item: dict[str, Any]) -> bool:
    """Best-effort heuristic for "this JSON-LD node is the article, not
    some other node in a `@graph`" when it carries no `@type` -- any of the
    fields this module actually reads from JSON-LD.
    """
    return any(
        key in item
        for key in ("headline", "author", "datePublished", "dateModified", "description", "articleBody")
    )


def _first_article_like(items: list[Any]) -> dict[str, Any] | None:
    """The one dict in `items` this module reads JSON-LD fields from.

    Three passes, each preferring an EARLIER, more-specific match over a
    LATER, less-specific one -- so a `WebSite`/`Organization` node that
    merely happens to sit before the `Article`/`NewsArticle` node in a
    `@graph` does not win by ordering alone: first the first entry that
    looks article-shaped (see `_looks_article_shaped`), else the first
    entry that at least carries an `@type`, else the first entry that is a
    dict at all -- some declared node beats none.
    """
    for item in items:
        if isinstance(item, dict) and _looks_article_shaped(item):
            return item
    for item in items:
        if isinstance(item, dict) and "@type" in item:
            return item
    for item in items:
        if isinstance(item, dict):
            return item
    return None


def _json_ld(soup: BeautifulSoup) -> dict[str, Any]:
    """The page's JSON-LD metadata object, best-effort.

    Finds the first `<script type="application/ld+json">` tag whose content
    parses as JSON (scanning past any that don't -- malformed JSON-LD on an
    earlier tag must not hide a valid one further down). That tag's parsed
    value is then normalized to a single object:

    * a JSON object is used directly;
    * a JSON object with an `"@graph"` list searches that list;
    * a bare JSON list searches the list itself;

    "searches the list" means: the first entry that looks article-shaped
    (see `_looks_article_shaped`) wins, even over an earlier entry that
    merely carries an `@type` (a `WebSite`/`Organization` node preceding
    the `Article`/`NewsArticle` node in a `@graph` must not win by
    ordering alone) -- see `_first_article_like`. If nothing in the list
    qualifies, or the tag's JSON was some other shape entirely (a number, a
    string, ...), the page is treated as having declared no JSON-LD
    metadata at all.

    Never raises on malformed JSON -- an unparseable or absent tag is
    treated as no JSON-LD, exactly like a page that never included any.
    """
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = tag.string
        if raw is None:
            raw = tag.get_text()
        if raw is None or not raw.strip():
            continue
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue

        if isinstance(parsed, dict):
            graph = parsed.get("@graph")
            if isinstance(graph, list):
                found = _first_article_like(graph)
                return found if found is not None else {}
            return parsed
        if isinstance(parsed, list):
            found = _first_article_like(parsed)
            return found if found is not None else {}
        return {}
    return {}


def _ld_str(ld: dict[str, Any], key: str) -> str | None:
    """A JSON-LD field expected to be a plain string (`headline`,
    `datePublished`, `dateModified`) -- `None` if absent or not a string
    (some pages declare these as nested objects; that is not a value this
    module will guess a string out of).
    """
    value = ld.get(key)
    return value if isinstance(value, str) else None


def _ld_byline(value: Any) -> str | None:
    """JSON-LD `author`: a string, or an object/list of objects each with a
    `"name"` field. Multiple names are joined with `", "`. A list entry that
    is itself a bare string is also accepted (some pages declare authors
    that way even though schema.org expects `Person`/`Organization`
    objects) -- accepting it costs nothing and loses no declared name.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        name = value.get("name")
        return name if isinstance(name, str) else None
    if isinstance(value, list):
        names: list[str] = []
        for item in value:
            candidate: str | None = None
            if isinstance(item, dict):
                item_name = item.get("name")
                candidate = item_name if isinstance(item_name, str) else None
            elif isinstance(item, str):
                candidate = item
            candidate = _some_text(candidate)
            if candidate:
                names.append(candidate)
        return ", ".join(names) if names else None
    return None


def extract_page_meta(html: str, url: str | None) -> PageMeta:
    """Read a page's declared metadata -- `<meta>` tags, the `article:` and
    `og:`/`twitter:` families, JSON-LD, `<html lang>`. A field the page
    never declared stays `None`; nothing here invents one.

    `url` is the room's own fact about where the page was captured from,
    not something read out of the markup -- it becomes `source_url`
    verbatim (through `_some_text`, so an empty-string URL reads as `None`
    too, the same "declared blank means absent" rule applied everywhere
    else in this module). `captured_at` is always `None`: this function
    never invents a capture timestamp, the caller sets it.
    """
    soup = BeautifulSoup(html, "html.parser")
    ld = _json_ld(soup)

    title = _some_text(_ld_str(ld, "headline"))
    if title is None:
        title = _some_text(_meta_content(soup, property="og:title"))
    if title is None:
        title = _some_text(_meta_content(soup, name="twitter:title"))
    if title is None:
        title_tag = soup.title
        title = _some_text(title_tag.get_text()) if title_tag is not None else None

    byline = _some_text(_ld_byline(ld.get("author")))
    if byline is None:
        byline = _some_text(_meta_content(soup, name="author"))
    if byline is None:
        byline = _some_text(_meta_content(soup, property="article:author"))

    site_name = _some_text(_meta_content(soup, property="og:site_name"))

    published = _some_text(_meta_content(soup, property="article:published_time"))
    if published is None:
        published = _some_text(_ld_str(ld, "datePublished"))

    modified = _some_text(_meta_content(soup, property="article:modified_time"))
    if modified is None:
        modified = _some_text(_ld_str(ld, "dateModified"))

    excerpt = _some_text(_meta_content(soup, name="description"))
    if excerpt is None:
        excerpt = _some_text(_meta_content(soup, property="og:description"))

    html_tag = soup.find("html")
    html_lang = html_tag.get("lang") if html_tag is not None else None
    lang = _some_text(html_lang) if isinstance(html_lang, str) else None

    source_url = _some_text(url)

    return PageMeta(
        title=title,
        byline=byline,
        site_name=site_name,
        published=published,
        modified=modified,
        excerpt=excerpt,
        lang=lang,
        source_url=source_url,
        captured_at=None,
    )
