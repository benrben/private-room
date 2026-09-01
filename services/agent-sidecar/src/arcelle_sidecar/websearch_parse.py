"""Pure hit normalization and result-page parsing for web search engines."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from bs4 import BeautifulSoup, Tag

Hit = dict[str, Any]
_log = logging.getLogger("arcelle_sidecar.websearch")


def _hit(
    title: str | None,
    url: str | None,
    source: str,
    date: str | None = None,
    snippet: str | None = None,
) -> Hit:
    return {
        "title": (title or "").strip(),
        "url": (url or "").strip(),
        "source": source,
        "date": date,
        "snippet": (snippet or "").strip() or None,
    }


def _dedupe_key(url: str) -> str:
    return url.split("#", 1)[0].rstrip("/")


def _self_link(href: str, domain: str) -> bool:
    host = urlparse(href).hostname or ""
    return host == domain or host.endswith(f".{domain}")


def _collect_anchor(
    anchor: Tag,
    *,
    exclude: str | None,
    min_title: int,
    unwrap: Callable[[str], str],
) -> tuple[str, str, str] | None:
    href = unwrap(anchor.get("href", ""))
    key = _dedupe_key(href)
    title = anchor.get_text(" ", strip=True)
    if not href.startswith("http"):
        return None
    if len(title) < min_title:
        return None
    if exclude and _self_link(href, exclude):
        return None
    return href, key, title


def _collect(
    anchors: Iterable[Tag],
    source: str,
    *,
    k: int,
    exclude: str | None = None,
    min_title: int = 0,
    unwrap: Callable[[str], str] = lambda href: href,
    snippet: Callable[[Tag], str | None] = lambda anchor: None,
) -> list[Hit]:
    hits: list[Hit] = []
    seen: set[str] = set()
    for anchor in anchors:
        candidate = _collect_anchor(
            anchor, exclude=exclude, min_title=min_title, unwrap=unwrap
        )
        if candidate is None:
            continue
        href, key, title = candidate
        if key in seen:
            continue
        seen.add(key)
        hits.append(_hit(title, href, source, snippet=snippet(anchor)))
        if len(hits) >= k:
            break
    if not hits:
        _log.warning(
            "%s: 200 OK but no results parsed — bot-check or changed layout?",
            source,
        )
    return hits


def _text_of(element: Tag | None) -> str | None:
    return element.get_text(" ", strip=True) if element is not None else None


def _rss_date(pub_date: str | None) -> str | None:
    if not pub_date:
        return None
    try:
        return parsedate_to_datetime(pub_date).date().isoformat()
    except Exception:
        _log.debug("unparseable pubDate %r", pub_date)
        return None


def _unwrap_ddg(href: str) -> str:
    if "uddg=" not in href:
        return href
    absolute = href if href.startswith("http") else f"https:{href}"
    return unquote(parse_qs(urlparse(absolute).query).get("uddg", [href])[0])


def _ddg_anchors(soup: BeautifulSoup) -> Iterable[Tag]:
    for result in soup.select("div.web-result, div.result"):
        anchor = result.select_one("h2 a, a.result__a")
        if anchor and anchor.get("href"):
            yield anchor


def _ddg_snippet(anchor: Tag) -> str | None:
    block = anchor.find_parent("div", class_=["result", "web-result"])
    return _text_of(block.select_one(".result__snippet")) if block else None


def _brave_snippet(anchor: Tag) -> str | None:
    block = anchor.find_parent(class_="snippet")
    return _text_of(block.select_one(".snippet-description, .snippet-content")) if block else None


def _mojeek_snippet(anchor: Tag) -> str | None:
    block = anchor.find_parent("li")
    return _text_of(block.select_one("p.s")) if block else None


def _marginalia_snippet(anchor: Tag) -> str | None:
    heading = anchor.find_parent("h2")
    following = heading.find_next(["p", "h2"]) if heading else None
    return _text_of(following) if following is not None and following.name == "p" else None


def _rss_snippet(description: str | None) -> str | None:
    if not description:
        return None
    return BeautifulSoup(description, "html.parser").get_text(" ", strip=True)
