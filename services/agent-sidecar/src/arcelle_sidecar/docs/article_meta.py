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
from collections.abc import Callable
from typing import Any

from bs4 import BeautifulSoup, Tag

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
        return all(
            field is None
            for field in (
                self.title,
                self.byline,
                self.site_name,
                self.published,
                self.modified,
                self.excerpt,
                self.lang,
            )
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


def _dictionary_items(items: list[Any]) -> list[dict[str, Any]]:
    """Keep JSON-LD object nodes, in their declared order."""
    return [item for item in items if isinstance(item, dict)]


def _first_matching_item(
    items: list[dict[str, Any]],
    predicate: Callable[[dict[str, Any]], bool],
) -> dict[str, Any] | None:
    """The earliest item that satisfies a JSON-LD selection rule."""
    for item in items:
        if predicate(item):
            return item
    return None


def _has_json_ld_type(item: dict[str, Any]) -> bool:
    """Whether a JSON-LD object explicitly identifies its type."""
    return "@type" in item


def _accept_json_ld_item(_: dict[str, Any]) -> bool:
    """The final JSON-LD fallback accepts the earliest object node."""
    return True


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
    objects = _dictionary_items(items)
    for predicate in (_looks_article_shaped, _has_json_ld_type, _accept_json_ld_item):
        item = _first_matching_item(objects, predicate)
        if item is not None:
            return item
    return None


_NO_JSON_LD = object()


def _parsed_json_ld(tag: Tag) -> Any:
    """Return a JSON-LD script's value, or a sentinel when it is unusable.

    The sentinel deliberately differs from JSON's `null`: a valid `null`
    declaration stops the scan and is normalized to no metadata, while an
    absent, blank, or malformed script must let a later script participate.
    """
    raw = tag.string
    if raw is None:
        raw = tag.get_text()
    if raw is None or not raw.strip():
        return _NO_JSON_LD
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return _NO_JSON_LD


def _article_from_items(items: list[Any]) -> dict[str, Any]:
    """Choose the declared article node from a JSON-LD graph or list."""
    found = _first_article_like(items)
    return found if found is not None else {}


def _json_ld_object(value: dict[str, Any]) -> dict[str, Any]:
    """Normalize an object-shaped JSON-LD declaration."""
    graph = value.get("@graph")
    return _article_from_items(graph) if isinstance(graph, list) else value


def _normalized_json_ld(value: Any) -> dict[str, Any]:
    """Normalize supported JSON-LD shapes to the one metadata object."""
    if isinstance(value, dict):
        return _json_ld_object(value)
    if isinstance(value, list):
        return _article_from_items(value)
    return {}


def _json_ld(soup: BeautifulSoup) -> dict[str, Any]:
    """The first valid JSON-LD script's article metadata, best-effort.

    A malformed or blank script is ignored so a later valid declaration can
    still supply metadata. Once a script parses, its object/list shape is
    normalized; another JSON shape declares no JSON-LD metadata.
    """
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        parsed = _parsed_json_ld(tag)
        if parsed is not _NO_JSON_LD:
            return _normalized_json_ld(parsed)
    return {}


def _ld_str(ld: dict[str, Any], key: str) -> str | None:
    """A JSON-LD field expected to be a plain string (`headline`,
    `datePublished`, `dateModified`) -- `None` if absent or not a string
    (some pages declare these as nested objects; that is not a value this
    module will guess a string out of).
    """
    value = ld.get(key)
    return value if isinstance(value, str) else None


def _ld_author_name(value: Any) -> str | None:
    """The declared name from one JSON-LD author value, when it has one."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        name = value.get("name")
        return name if isinstance(name, str) else None
    return None


def _ld_byline_list(values: list[Any]) -> str | None:
    """Join the nonblank declared author names in a JSON-LD author list."""
    names: list[str] = []
    for value in values:
        name = _some_text(_ld_author_name(value))
        if name:
            names.append(name)
    return ", ".join(names) if names else None


def _ld_byline(value: Any) -> str | None:
    """Read a JSON-LD `author` string, object, or list of either."""
    return _ld_byline_list(value) if isinstance(value, list) else _ld_author_name(value)


def _first_text(*values: str | None) -> str | None:
    """The first nonblank declared string, after normalizing each value."""
    for value in values:
        text = _some_text(value)
        if text is not None:
            return text
    return None


def _title_tag_text(soup: BeautifulSoup) -> str | None:
    """The document title's text, when a title element exists."""
    title_tag = soup.title
    return title_tag.get_text() if title_tag is not None else None


def _title(soup: BeautifulSoup, ld: dict[str, Any]) -> str | None:
    """Read the title cascade from structured data through the title tag."""
    return _first_text(
        _ld_str(ld, "headline"),
        _meta_content(soup, property="og:title"),
        _meta_content(soup, name="twitter:title"),
        _title_tag_text(soup),
    )


def _byline(soup: BeautifulSoup, ld: dict[str, Any]) -> str | None:
    """Read the author cascade from JSON-LD through article metadata."""
    return _first_text(
        _ld_byline(ld.get("author")),
        _meta_content(soup, name="author"),
        _meta_content(soup, property="article:author"),
    )


def _article_time(
    soup: BeautifulSoup,
    ld: dict[str, Any],
    *,
    meta_property: str,
    json_ld_key: str,
) -> str | None:
    """Read an article date while preserving meta-tag precedence."""
    return _first_text(_meta_content(soup, property=meta_property), _ld_str(ld, json_ld_key))


def _excerpt(soup: BeautifulSoup) -> str | None:
    """Read a declared description without deriving text from the body."""
    return _first_text(
        _meta_content(soup, name="description"),
        _meta_content(soup, property="og:description"),
    )


def _document_lang(soup: BeautifulSoup) -> str | None:
    """Read the document language only when the HTML element declares it."""
    html_tag = soup.find("html")
    lang = html_tag.get("lang") if html_tag is not None else None
    return _some_text(lang) if isinstance(lang, str) else None


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

    return PageMeta(
        title=_title(soup, ld),
        byline=_byline(soup, ld),
        site_name=_some_text(_meta_content(soup, property="og:site_name")),
        published=_article_time(
            soup,
            ld,
            meta_property="article:published_time",
            json_ld_key="datePublished",
        ),
        modified=_article_time(
            soup,
            ld,
            meta_property="article:modified_time",
            json_ld_key="dateModified",
        ),
        excerpt=_excerpt(soup),
        lang=_document_lang(soup),
        source_url=_some_text(url),
        captured_at=None,
    )
