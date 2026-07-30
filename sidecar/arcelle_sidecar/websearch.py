"""From-scratch multi-engine web search: scrape several engines, fuse by relevance.

The one call you need is :func:`search`; every engine is also usable on its own.

This module IS the room's web search — there is no provider setting any more and
no second implementation. Settings → Online features is a plain on/off switch;
when it is on, `web_search` runs :func:`search` and nothing else. The engines
below are an internal detail of that one provider, not choices a user makes.

Privacy: the query is the only thing that leaves the Mac here, and it goes to
every engine in :data:`DEFAULT_ENGINES`. Nothing in this module logs the query or
any result text — an engine failure logs the ENGINE's name, never its input
(SPEC §6). :func:`search` is deliberately called with ``resolve_dates=False`` by
the HTTP route: date resolution fetches each result URL from Python, which would
step around the Rust SSRF guard that every other outbound fetch goes through.
"""

from __future__ import annotations

import argparse
import itertools
import logging
import re
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Callable, Iterable
from email.utils import parsedate_to_datetime
from functools import wraps
from operator import itemgetter
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlparse

import requests
from bs4 import BeautifulSoup, Tag

__all__ = [
    "search",
    "duckduckgo",
    "brave",
    "mojeek",
    "duckduckgo_ia",
    "google_news",
    "wikipedia",
    "marginalia",
    "DEFAULT_ENGINES",
]

#: A hit is ``{'title', 'url', 'source', 'date'}``; :func:`search` adds ``'score'``.
Hit = dict[str, Any]
#: An engine takes a query (plus optional tuning kwargs) and never raises.
Engine = Callable[..., list[Hit]]

# Failures are silenced on purpose (see _fails_soft) but not lost: a whole engine
# going down logs at WARNING, the per-link date lookups at DEBUG.
_log = logging.getLogger(__name__)

# A few real browser UAs; we rotate to avoid a static fingerprint.
_USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
)
_UA_CYCLE = itertools.cycle(_USER_AGENTS)

_SESSION = requests.Session()


def _browser_headers() -> dict[str, str]:
    """Fresh headers with the next UA in the rotation — the only place UAs are picked."""
    return {"User-Agent": next(_UA_CYCLE), "Accept-Language": "en-US,en;q=0.9"}


def _get(url: str, **kwargs: Any) -> requests.Response:
    """GET with a rotating UA and a default timeout; caller headers win."""
    kwargs.setdefault("timeout", 20)
    headers = _browser_headers() | kwargs.pop("headers", {})
    return _SESSION.get(url, headers=headers, **kwargs)


def _hit(title: str | None, url: str | None, source: str, date: str | None = None) -> Hit:
    """`date` is an ISO string 'YYYY-MM-DD' when known, else None."""
    return {
        "title": (title or "").strip(),
        "url": (url or "").strip(),
        "source": source,
        "date": date,
    }


def _dedupe_key(url: str) -> str:
    """URLs differing only by fragment or trailing slash are the same page."""
    return url.split("#", 1)[0].rstrip("/")


def _fails_soft(engine: Engine) -> Engine:
    """Engines are best-effort: a network error, a bot-block or a layout change
    yields no results rather than an exception, so one bad engine can't sink a search.
    The error is silenced, not swallowed — it is logged at WARNING, because a
    scraper whose selectors have rotted looks exactly like 'nothing matched'."""

    @wraps(engine)
    def wrapper(*args: Any, **kwargs: Any) -> list[Hit]:
        try:
            return engine(*args, **kwargs)
        except Exception:
            _log.warning("engine %s failed", engine.__name__, exc_info=True)
            return []

    return wrapper


def _ok(response: requests.Response, source: str) -> bool:
    """A non-200 from a scrape target means blocked or moved. Say which, don't just
    return [] — a quiet engine is indistinguishable from a query with no answers."""
    if response.status_code == 200:
        return True
    _log.warning("%s returned HTTP %s", source, response.status_code)
    return False


def _collect(
    anchors: Iterable[Tag],
    source: str,
    *,
    k: int,
    exclude: str | None = None,
    min_title: int = 0,
    unwrap: Callable[[str], str] = lambda href: href,
) -> list[Hit]:
    """Turn scraped `<a>` tags into at most `k` deduped hits, dropping self-links
    (`exclude`), non-http hrefs and titles shorter than `min_title`."""
    hits: list[Hit] = []
    seen: set[str] = set()
    for anchor in anchors:
        href = unwrap(anchor.get("href", ""))
        key = _dedupe_key(href)
        title = anchor.get_text(" ", strip=True)
        if (
            not href.startswith("http")
            or key in seen
            or len(title) < min_title
            or (exclude and exclude in href)
        ):
            continue
        seen.add(key)
        hits.append(_hit(title, href, source))
        if len(hits) >= k:
            break
    if not hits:
        # Engines increasingly serve bot-checks as HTTP 200 (Mojeek does), and selectors
        # rot silently. Both land here looking exactly like an empty search.
        _log.warning("%s: 200 OK but no results parsed — bot-check or changed layout?", source)
    return hits


_DATE_SELECTORS = (
    ('meta[property="article:published_time"]', "content"),
    ('meta[name="date"]', "content"),
    ('meta[itemprop="datePublished"]', "content"),
    ('meta[property="og:updated_time"]', "content"),
    ("time[datetime]", "datetime"),
)
_JSON_LD_DATE = re.compile(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})')


def _page_date(url: str) -> str | None:
    """Best-effort published date ('YYYY-MM-DD') for any page, from its meta tags /
    JSON-LD / <time> / Last-Modified header. Returns None if nothing is found."""
    try:
        response = _get(url, timeout=12)
        soup = BeautifulSoup(response.text, "html.parser")
        for selector, attr in _DATE_SELECTORS:
            element = soup.select_one(selector)
            if element and element.get(attr):
                return element[attr][:10]
        if match := _JSON_LD_DATE.search(response.text):
            return match.group(1)
        if last_modified := response.headers.get("Last-Modified"):
            return parsedate_to_datetime(last_modified).date().isoformat()
    except Exception:
        _log.debug("date lookup failed for %s", url, exc_info=True)
    return None


def _rss_date(pub_date: str | None) -> str | None:
    """RFC-2822 pubDate -> 'YYYY-MM-DD', or None if absent/unparseable."""
    if not pub_date:
        return None
    try:
        return parsedate_to_datetime(pub_date).date().isoformat()
    except Exception:
        _log.debug("unparseable pubDate %r", pub_date)
        return None


# ── engines (each returns a list of hits; each fails soft to []) ─────────────────────────

_DDG_URL = "https://html.duckduckgo.com/html/"
_DDG_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://html.duckduckgo.com/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Content-Type": "application/x-www-form-urlencoded",
}


def _unwrap_ddg(href: str) -> str:
    """DDG wraps outbound links as `/l/?uddg=<encoded>`; unwrap when present."""
    if "uddg=" not in href:
        return href
    absolute = href if href.startswith("http") else f"https:{href}"
    return unquote(parse_qs(urlparse(absolute).query).get("uddg", [href])[0])


def _ddg_anchors(soup: BeautifulSoup) -> Iterable[Tag]:
    """The first result link inside each DDG result block (skips inline extras)."""
    for result in soup.select("div.web-result, div.result"):
        anchor = result.select_one("h2 a, a.result__a")
        if anchor and anchor.get("href"):
            yield anchor


@_fails_soft
def _ddg_attempt(query: str, k: int) -> list[Hit]:
    """One POST to the no-JS endpoint. Empty on a challenge page or a non-200."""
    response = _SESSION.post(
        _DDG_URL,
        data={"q": query, "b": "", "kl": "us-en"},
        headers=_browser_headers() | _DDG_HEADERS,
        timeout=20,
    )
    if response.status_code != 200 or "challenge-form" in response.text:
        # Expected and self-healing: the caller retries with a new UA, so this is
        # only interesting when every attempt fails (duckduckgo() warns then).
        _log.debug("ddg attempt blocked (HTTP %s)", response.status_code)
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    return _collect(_ddg_anchors(soup), "duckduckgo", k=k, unwrap=_unwrap_ddg)


def duckduckgo(query: str, k: int = 10, tries: int = 3) -> list[Hit]:
    """Real DuckDuckGo web results by scraping the no-JS HTML endpoint.
    Page 1 needs NO token — just a POST with b='' and proper browser headers.
    DDG's block is INTERMITTENT (HTTP 202), so we retry up to `tries` times with a
    rotating User-Agent and a short pause — that alone clears most transient blocks."""
    for attempt in range(tries):
        if attempt:  # 202 / challenge / empty -> wait a moment, rotate UA, try again
            time.sleep(2)
        if hits := _ddg_attempt(query, k):
            return hits
    _log.warning("duckduckgo blocked after %d attempts", tries)
    return []  # still blocked after retries; the other engines below cover you


# Brave's result markup also matches its own chrome ("Images", "Settings", "Log in"),
# and every one of those labels is shorter than a real headline.
_BRAVE_MIN_TITLE = 11


@_fails_soft
def brave(query: str, k: int = 10) -> list[Hit]:
    """Brave Search (scrape). Independent index, good quality. Works from a normal/home IP;
    a datacenter IP usually gets HTTP 429 -> returns [] (fails soft)."""
    response = _get("https://search.brave.com/search", params={"q": query, "source": "web"})
    if not _ok(response, "brave"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    anchors = soup.select("a.h[href^='http'], #results .snippet a[href^='http'], .snippet-title")
    return _collect(anchors, "brave", k=k, exclude="brave.com", min_title=_BRAVE_MIN_TITLE)


@_fails_soft
def mojeek(query: str, k: int = 10) -> list[Hit]:
    """Mojeek (scrape). One of the few truly independent crawlers. Clean IP works;
    datacenter IPs often get HTTP 403 -> returns [] (fails soft)."""
    response = _get("https://www.mojeek.com/search", params={"q": query})
    if not _ok(response, "mojeek"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    anchors = soup.select("ul.results-standard li a.title, li h2 a, a.ob")
    return _collect(anchors, "mojeek", k=k, exclude="mojeek.com")


@_fails_soft
def marginalia(query: str, k: int = 10) -> list[Hit]:
    """Marginalia — independent engine, tolerant of scraping (HTTP 200). Real web links."""
    response = _get("https://search.marginalia.nu/search", params={"query": query}, timeout=25)
    if not _ok(response, "marginalia"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    return _collect(soup.select("h2 a[href]"), "marginalia", k=k, exclude="marginalia")


@_fails_soft
def duckduckgo_ia(query: str, k: int = 10) -> list[Hit]:
    """DuckDuckGo Instant Answer API — never blocks. Definition + related-topic links."""
    data = _get(
        "https://api.duckduckgo.com/",
        params={"q": query, "format": "json", "no_html": 1, "t": "agent"},
    ).json()
    hits = []
    if data.get("AbstractURL"):
        hits.append(_hit(data.get("Heading", ""), data["AbstractURL"], "ddg-ia"))
    hits.extend(
        _hit(topic.get("Text", ""), topic["FirstURL"], "ddg-ia")
        for topic in data.get("RelatedTopics", [])
        if isinstance(topic, dict) and topic.get("FirstURL")
    )
    return hits[:k]


@_fails_soft
def google_news(query: str, k: int = 10) -> list[Hit]:
    """Google News RSS — never blocks, great for anything current. Returns article links.
    (Links are Google redirects that resolve to the real article when you fetch them.)"""
    params = urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    root = ET.fromstring(_get(f"https://news.google.com/rss/search?{params}").content)
    items = (
        _hit(
            item.findtext("title"),
            item.findtext("link"),
            "news",
            _rss_date(item.findtext("pubDate")),
        )
        for item in root.iter("item")
    )
    return list(itertools.islice(items, k))


#: Wikimedia's UA policy REQUIRES a descriptive User-Agent on api.php and answers
#: 403 to the rotated browser UAs the scrapers need — verified 2026-07-30, it was
#: a 403 on every single search. This is the one engine that must not be spoofed.
_WIKIMEDIA_UA = "Arcelle/0.12 (private-room desktop app; https://github.com/benrben/private-room)"


@_fails_soft
def wikipedia(query: str, k: int = 6) -> list[Hit]:
    """Wikipedia OpenSearch — never blocks. Facts/entities."""
    response = _get(
        "https://en.wikipedia.org/w/api.php",
        params={"action": "opensearch", "search": query, "limit": k, "format": "json"},
        headers={"User-Agent": _WIKIMEDIA_UA},
    )
    # Guarded, unlike the other JSON engines: a blocked api.php answers HTML, and
    # .json() on HTML raises — which _fails_soft would catch, but only after
    # logging a full traceback on every search.
    if not _ok(response, "wikipedia"):
        return []
    _query, titles, _descriptions, urls = response.json()
    return [_hit(title, url, "wikipedia") for title, url in zip(titles, urls, strict=True)]


# ── the one call you use ─────────────────────────────────────────────────────────────────

# All engines are fused by relevance (see search()), so order here doesn't affect ranking.
# duckduckgo/brave/mojeek are the general-web scrapers (great from a clean IP); the rest
# never bot-block, so they're your always-on floor even from a datacenter/VPS.
DEFAULT_ENGINES: tuple[Engine, ...] = (
    duckduckgo,
    brave,
    mojeek,
    marginalia,
    wikipedia,
    duckduckgo_ia,
    google_news,
)

_RRF_WEIGHT = 0.70
_LEXICAL_WEIGHT = 0.30
_WORD = re.compile(r"[a-z0-9]+")


def _lexical(query: str, title: str | None) -> float:
    """Fraction of query words present in the title (0..1) — a cheap on-topic signal."""
    words = set(_WORD.findall(query.lower()))
    if not words:
        return 0.0
    return len(words & set(_WORD.findall((title or "").lower()))) / len(words)


def _score(query: str, hit: Hit, rrf_share: float) -> float:
    """Blend cross-engine agreement (RRF, as a share of the best hit's) with title match."""
    return round(_RRF_WEIGHT * rrf_share + _LEXICAL_WEIGHT * _lexical(query, hit["title"]), 3)


def _fuse(
    query: str, engines: Iterable[Engine], *, delay: float, rrf_k: int
) -> tuple[dict[str, Hit], dict[str, float]]:
    """Run every engine and return (page by URL, summed reciprocal rank by URL).
    A page ranked `rank` by one engine contributes 1/(rrf_k + rank) — once per engine,
    or an engine listing the same page twice would look like two engines agreeing."""
    merged: dict[str, Hit] = {}
    rrf: defaultdict[str, float] = defaultdict(float)
    for i, engine in enumerate(engines):
        if delay and i:
            time.sleep(delay)  # be polite; protects your IP reputation
        counted: set[str] = set()
        for rank, hit in enumerate(engine(query), start=1):
            key = _dedupe_key(hit["url"])
            if not key or key in counted:
                continue
            counted.add(key)
            merged.setdefault(key, dict(hit))
            rrf[key] += 1.0 / (rrf_k + rank)
    return merged, rrf


def search(
    query: str,
    limit: int = 12,
    *,
    engines: Iterable[Engine] | None = None,
    delay: float = 0.0,
    resolve_dates: bool = False,
    rrf_k: int = 60,
) -> list[Hit]:
    """Return up to `limit` deduped web links, most-relevant first:
        [{'title','url','source','date','score'}, ...]

    score (0..1, relative within this query) = 70% Reciprocal-Rank-Fusion + 30% title match.
      - RRF rewards links the engines rank HIGH and that MULTIPLE engines agree on
        (a URL found by two engines sums both contributions). `rrf_k` is its damping
        constant — larger flattens the rank curve, so agreement outweighs position.
      - title match rewards links whose title actually contains your query words.
    So it's a real cross-engine relevance ranking, computed from scratch — no ML, no API.

    Dates: news carries a real date for free. resolve_dates=True fills dates for the other
    links too (one fetch per dateless link, only for the `limit` links you get back)."""
    merged, rrf = _fuse(
        query,
        DEFAULT_ENGINES if engines is None else engines,
        delay=delay,
        rrf_k=rrf_k,
    )
    if not merged:
        return []

    top_rrf = max(rrf.values()) or 1.0
    scored = [
        dict(hit, score=_score(query, hit, rrf[key] / top_rrf)) for key, hit in merged.items()
    ]
    scored.sort(key=itemgetter("score"), reverse=True)
    hits = scored[:limit]

    if resolve_dates:
        for hit in hits:
            hit["date"] = hit["date"] or _page_date(hit["url"])
    return hits


_NO_DATE = "     —    "  # same width as an ISO date, so columns line up


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("query", nargs="+", help="search terms")
    parser.add_argument(
        "--dates",
        action="store_true",
        help="also resolve a date for non-news links (one fetch per link)",
    )
    args = parser.parse_args(argv)

    query = " ".join(args.query)
    print(f"# from-scratch web search: {query!r}  (dates: {'on' if args.dates else 'news-only'})\n")
    for hit in search(query, resolve_dates=args.dates):
        print(
            f"[{hit['score']:.2f}] [{hit['source']:>10}] "
            f"{hit['date'] or _NO_DATE}  {hit['title'][:52]}"
        )
        print(f"        {hit['url']}")


if __name__ == "__main__":
    main()
