"""From-scratch multi-engine web search: scrape several engines, fuse by relevance.

The one call you need is :func:`search`; every engine is also usable on its own.

This module IS the room's web search — there is no provider setting any more and
no second implementation. Settings → Online features is a plain on/off switch;
when it is on, `web_search` runs :func:`search` and nothing else. The engines
below are an internal detail of that one provider, not choices a user makes.

Privacy: the query is the only thing that leaves the Mac here, and it goes to
every engine in :data:`DEFAULT_ENGINES`. Nothing in this module logs the query or
any result text — an engine failure logs the ENGINE's name, never its input
(SPEC §6), and the 'failed' list :func:`timed_search` returns is engine names for
the same reason.

Nothing here ever fetches a RESULT url. Only the engines' own endpoints are
requested, so this module cannot be pointed at an address the user's query
names. A developer-only ``--dates`` command line used to break that rule — it
fetched every result page from Python, around the Rust SSRF guard that refuses
local and private addresses, and read it whole with no size limit — so it and
the page fetch behind it were deleted (2026-08-01 audit). Anything that needs a
result page goes through the host's guarded fetch.
"""

from __future__ import annotations

import itertools
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from email.utils import parsedate_to_datetime
from functools import wraps
from operator import itemgetter
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlparse

import requests
from bs4 import BeautifulSoup, Tag

__all__ = [
    "search",
    "timed_search",
    "duckduckgo",
    "brave",
    "mojeek",
    "duckduckgo_ia",
    "google_news",
    "wikipedia",
    "marginalia",
    "DEFAULT_ENGINES",
]

#: A hit is ``{'title', 'url', 'source', 'date', 'snippet'}``; fusion adds
#: ``'engines'`` (every engine that returned the URL) and :func:`search` ``'score'``.
Hit = dict[str, Any]
#: An engine takes a query (plus optional tuning kwargs) and never raises.
Engine = Callable[..., list[Hit]]

# Failures are silenced on purpose (see _fails_soft) but not lost: a whole engine
# going down logs at WARNING.
_log = logging.getLogger(__name__)

# A few real browser UAs; we rotate to avoid a static fingerprint.
_USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
)
_UA_CYCLE = itertools.cycle(_USER_AGENTS)

_SESSION = requests.Session()

# The engines run in parallel (see _fuse), and a requests.Session is not
# documented thread-safe, so each worker thread gets its own. The fan-out pool is
# shared between searches, so those threads — and their open connections — are
# reused by the next search instead of being built and thrown away every time.
_LOCAL = threading.local()


def _session() -> requests.Session:
    """This thread's session. The main thread keeps the module-level one, so
    single-threaded callers and the tests see exactly what they always did."""
    if threading.current_thread() is threading.main_thread():
        return _SESSION
    session = getattr(_LOCAL, "session", None)
    if session is None:
        session = _LOCAL.session = requests.Session()
    return session


def _browser_headers() -> dict[str, str]:
    """Fresh headers with the next UA in the rotation — the only place UAs are picked."""
    return {"User-Agent": next(_UA_CYCLE), "Accept-Language": "en-US,en;q=0.9"}


#: Seconds to wait for a TCP connection, separately from reading the response.
#: A host that will not accept a connection in this long is down or blocking us;
#: waiting the full read budget for it just burns the user's search. (Measured:
#: DuckDuckGo connect-timing-out at 20s × 3 attempts was 64s of a 64s search.)
_CONNECT_TIMEOUT = 5.0

#: How long the whole fan-out may take. Engines still running when it expires
#: simply do not contribute — the same fail-soft rule as an engine that errors,
#: applied to one that is merely too slow to be useful.
FANOUT_BUDGET = 22.0


def _timeout(read: float) -> tuple[float, float]:
    """(connect, read) for requests. Call sites pass the read budget they want; both
    halves are bounded here — the connect half so one dead host cannot own the search,
    the read half by :data:`FANOUT_BUDGET`, because a response that arrives after the
    fan-out gave up waiting is thrown away anyway (it only holds a thread and a socket
    open past the end of the search that asked for it)."""
    read = min(read, FANOUT_BUDGET)
    return (min(_CONNECT_TIMEOUT, read), read)


def _get(url: str, **kwargs: Any) -> requests.Response:
    """GET with a rotating UA and a default timeout; caller headers win."""
    timeout = kwargs.pop("timeout", 20)
    if not isinstance(timeout, tuple):
        timeout = _timeout(timeout)
    headers = _browser_headers() | kwargs.pop("headers", {})
    return _session().get(url, headers=headers, timeout=timeout, **kwargs)


def _hit(
    title: str | None,
    url: str | None,
    source: str,
    date: str | None = None,
    snippet: str | None = None,
) -> Hit:
    """`date` is an ISO string 'YYYY-MM-DD' when known, else None. `snippet` is the
    engine's own result blurb, whitespace-trimmed; whitespace-only becomes None."""
    return {
        "title": (title or "").strip(),
        "url": (url or "").strip(),
        "source": source,
        "date": date,
        "snippet": (snippet or "").strip() or None,
    }


def _dedupe_key(url: str) -> str:
    """URLs differing only by fragment or trailing slash are the same page."""
    return url.split("#", 1)[0].rstrip("/")


def _note_failure(reason: str) -> None:
    """Record that the engine running on THIS thread could not answer at all —
    unreachable, blocked, an HTTP error. Every engine still fails soft to [], but
    "I could not reach the web" and "the web has nothing for you" are the opposite
    news to whoever asked, and only the engine knows which one happened. The note is
    left on the thread the engine runs on (one engine per thread, see _fuse) and
    picked up by :func:`_run_engine`; a direct engine call leaves nobody
    listening, and the note is simply dropped."""
    notes = getattr(_LOCAL, "notes", None)
    if notes is not None:
        notes.append(reason)


def _run_engine(engine: Engine, query: str) -> tuple[list[Hit], bool]:
    """Run one engine: (its hits, whether it FAILED rather than found nothing).
    An engine that returns [] having answered normally — no instant answer, no
    Wikipedia page — is not a failure, and must not be reported as one."""
    _LOCAL.notes = notes = []
    try:
        return engine(query) or [], bool(notes)
    finally:
        _LOCAL.notes = None


def _fails_soft(engine: Engine) -> Engine:
    """Engines are best-effort: a network error, a bot-block or a layout change
    yields no results rather than an exception, so one bad engine can't sink a search.
    The error is silenced, not swallowed — it is logged at WARNING and reported to the
    fan-out as a failure, because a scraper whose selectors have rotted (or a Mac with
    no network at all) looks exactly like 'nothing matched'."""

    @wraps(engine)
    def wrapper(*args: Any, **kwargs: Any) -> list[Hit]:
        try:
            return engine(*args, **kwargs)
        except Exception as exc:
            _log.warning("engine %s failed", engine.__name__, exc_info=True)
            _note_failure(type(exc).__name__)
            return []

    return wrapper


def _ok(response: requests.Response, source: str) -> bool:
    """A non-200 from a scrape target means blocked or moved. Say which, don't just
    return [] — a quiet engine is indistinguishable from a query with no answers."""
    if response.status_code == 200:
        return True
    _log.warning("%s returned HTTP %s", source, response.status_code)
    _note_failure(f"HTTP {response.status_code}")
    return False


def _self_link(href: str, domain: str) -> bool:
    """True when `href` points back at the engine itself — `domain` or a subdomain of
    it. Matched on the HOST, never as a substring of the whole URL: "marginalia"
    anywhere in a path meant every genuine article ABOUT marginalia was dropped."""
    host = urlparse(href).hostname or ""
    return host == domain or host.endswith(f".{domain}")


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
    """Turn scraped `<a>` tags into at most `k` deduped hits, dropping the engine's own
    links (`exclude`, a domain), non-http hrefs and titles shorter than `min_title`.
    `snippet` maps a kept anchor to its result blurb elsewhere in the soup — best-effort
    by nature (it reads markup the engine already sent, never fetches), so None is normal."""
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
            or (exclude and _self_link(href, exclude))
        ):
            continue
        seen.add(key)
        hits.append(_hit(title, href, source, snippet=snippet(anchor)))
        if len(hits) >= k:
            break
    if not hits:
        # Engines increasingly serve bot-checks as HTTP 200 (Mojeek does), and selectors
        # rot silently. Both land here looking exactly like an empty search.
        _log.warning("%s: 200 OK but no results parsed — bot-check or changed layout?", source)
    return hits


def _text_of(element: Tag | None) -> str | None:
    """Element text for the snippet extractors, or None when the lookup missed."""
    return element.get_text(" ", strip=True) if element is not None else None


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

#: Wait this long before re-asking a DDG that answered with a challenge — the block is
#: intermittent, and asking again instantly just collects a second one.
_DDG_RETRY_PAUSE = 2.0


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


def _ddg_snippet(anchor: Tag) -> str | None:
    """The blurb sits beside the title link, inside the same result block."""
    block = anchor.find_parent("div", class_=["result", "web-result"])
    return _text_of(block.select_one(".result__snippet")) if block else None


def _ddg_attempt(query: str, k: int, read: float = 20.0) -> list[Hit]:
    """One POST to the no-JS endpoint, waiting at most `read` seconds for the answer.
    Empty on a challenge page or a non-200.

    NOT fail-soft: the caller needs to tell "DDG answered with a challenge"
    (worth retrying) from "DDG could not be reached at all" (not worth
    retrying). `duckduckgo` is itself fail-soft, so nothing escapes to fusion."""
    response = _session().post(
        _DDG_URL,
        data={"q": query, "b": "", "kl": "us-en"},
        headers=_browser_headers() | _DDG_HEADERS,
        timeout=_timeout(read),
    )
    if response.status_code != 200 or "challenge-form" in response.text:
        # Expected and self-healing: the caller retries with a new UA, so this is
        # only interesting when every attempt fails (duckduckgo() warns then).
        _log.debug("ddg attempt blocked (HTTP %s)", response.status_code)
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    return _collect(
        _ddg_anchors(soup), "duckduckgo", k=k, unwrap=_unwrap_ddg, snippet=_ddg_snippet
    )


def duckduckgo(query: str, k: int = 10, tries: int = 3, budget: float = FANOUT_BUDGET) -> list[Hit]:
    """Real DuckDuckGo web results by scraping the no-JS HTML endpoint.
    Page 1 needs NO token — just a POST with b='' and proper browser headers.
    DDG's block is INTERMITTENT (HTTP 202), so we retry up to `tries` times with a
    rotating User-Agent and a short pause — that alone clears most transient blocks.

    All the attempts together get `budget` seconds, which is the whole fan-out's
    budget: three 20s attempts plus their pauses is 64s of a 22s search, so past
    the budget a retry can only produce results that arrive too late to be used."""
    deadline = time.monotonic() + budget
    for attempt in range(tries):
        # A retry's pause comes out of the same budget the attempt does, and is not
        # worth sitting through when there is nothing left to spend after it.
        left = deadline - time.monotonic() - (_DDG_RETRY_PAUSE if attempt else 0.0)
        if left <= 0:
            _log.warning("duckduckgo spent its %.0fs budget after %d attempt(s)", budget, attempt)
            _note_failure("out of budget")
            return []
        if attempt:  # 202 / challenge / empty -> wait a moment, rotate UA, try again
            time.sleep(_DDG_RETRY_PAUSE)
        try:
            if hits := _ddg_attempt(query, k, read=left):
                return hits
        except requests.RequestException as exc:
            # Unreachable is not the same as blocked. Retrying a host that will
            # not complete a TCP handshake just spends the fan-out's budget on
            # a foregone conclusion — it was 3 x 5s + 2 x 2s of every search
            # from a network that cannot reach DDG at all.
            _log.warning("duckduckgo unreachable (%s); not retrying", type(exc).__name__)
            _note_failure(type(exc).__name__)
            return []
    _log.warning("duckduckgo blocked after %d attempts", tries)
    _note_failure("blocked")
    return []  # still blocked after retries; the other engines below cover you


# Brave's result markup also matches its own chrome ("Images", "Settings", "Log in"),
# and every one of those labels is shorter than a real headline.
_BRAVE_MIN_TITLE = 11


def _brave_snippet(anchor: Tag) -> str | None:
    """Brave wraps each result in a `.snippet` card; the blurb is its description."""
    block = anchor.find_parent(class_="snippet")
    return _text_of(block.select_one(".snippet-description, .snippet-content")) if block else None


@_fails_soft
def brave(query: str, k: int = 10) -> list[Hit]:
    """Brave Search (scrape). Independent index, good quality. Works from a normal/home IP;
    a datacenter IP usually gets HTTP 429 -> returns [] (fails soft)."""
    response = _get("https://search.brave.com/search", params={"q": query, "source": "web"})
    if not _ok(response, "brave"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    anchors = soup.select("a.h[href^='http'], #results .snippet a[href^='http'], .snippet-title")
    return _collect(
        anchors,
        "brave",
        k=k,
        exclude="brave.com",
        min_title=_BRAVE_MIN_TITLE,
        snippet=_brave_snippet,
    )


def _mojeek_snippet(anchor: Tag) -> str | None:
    """Mojeek keeps title and blurb (`p.s`) as siblings inside one `<li>`."""
    block = anchor.find_parent("li")
    return _text_of(block.select_one("p.s")) if block else None


@_fails_soft
def mojeek(query: str, k: int = 10) -> list[Hit]:
    """Mojeek (scrape). One of the few truly independent crawlers. Clean IP works;
    datacenter IPs often get HTTP 403 -> returns [] (fails soft)."""
    response = _get("https://www.mojeek.com/search", params={"q": query})
    if not _ok(response, "mojeek"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    anchors = soup.select("ul.results-standard li a.title, li h2 a, a.ob")
    return _collect(anchors, "mojeek", k=k, exclude="mojeek.com", snippet=_mojeek_snippet)


def _marginalia_snippet(anchor: Tag) -> str | None:
    """The description `<p>` follows the result's `<h2>`. Stop at the NEXT `<h2>`,
    or a description-less result would steal its neighbour's blurb."""
    heading = anchor.find_parent("h2")
    following = heading.find_next(["p", "h2"]) if heading else None
    return _text_of(following) if following is not None and following.name == "p" else None


@_fails_soft
def marginalia(query: str, k: int = 10) -> list[Hit]:
    """Marginalia — independent engine, tolerant of scraping (HTTP 200). Real web links.
    The slowest of the engines, so it gets everything the fan-out will actually wait
    for — and not a second more, which is all it used to ask for and never got."""
    response = _get(
        "https://search.marginalia.nu/search", params={"query": query}, timeout=FANOUT_BUDGET
    )
    if not _ok(response, "marginalia"):
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    return _collect(
        soup.select("h2 a[href]"), "marginalia", k=k, exclude="marginalia.nu",
        snippet=_marginalia_snippet,
    )


@_fails_soft
def duckduckgo_ia(query: str, k: int = 10) -> list[Hit]:
    """DuckDuckGo Instant Answer API — never blocks. Definition + related-topic links."""
    data = _get(
        "https://api.duckduckgo.com/",
        params={"q": query, "format": "json", "no_html": 1, "t": "agent"},
    ).json()
    hits = []
    if data.get("AbstractURL"):
        # no_html=1 above keeps AbstractText plain; related topics reuse their
        # Text as the title, so a snippet there would just repeat it.
        hits.append(
            _hit(
                data.get("Heading", ""),
                data["AbstractURL"],
                "ddg-ia",
                snippet=data.get("AbstractText") or data.get("Abstract"),
            )
        )
    hits.extend(
        _hit(topic.get("Text", ""), topic["FirstURL"], "ddg-ia")
        for topic in data.get("RelatedTopics", [])
        if isinstance(topic, dict) and topic.get("FirstURL")
    )
    return hits[:k]


def _rss_snippet(description: str | None) -> str | None:
    """Google News item descriptions are HTML (a link back to the article plus the
    outlet's name); keep the text, drop the tags."""
    if not description:
        return None
    return BeautifulSoup(description, "html.parser").get_text(" ", strip=True)


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
            snippet=_rss_snippet(item.findtext("description")),
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
    _query, titles, descriptions, urls = response.json()
    return [
        _hit(title, url, "wikipedia", snippet=description)
        for title, description, url in zip(titles, descriptions, urls, strict=True)
    ]


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

#: The fan-out pool is shared by every search instead of being built and binned per
#: query: a search should not pay to create seven threads — and, through them, seven
#: fresh requests.Sessions — that it discards a second later. Nothing here is ever
#: shut down; a straggler ends on its own read timeout, which _timeout() caps at the
#: fan-out budget.
#:
#: Sized for several searches at once, because a straggler holds its thread for the
#: whole fan-out budget: at 2x one search, two overlapping searches with hanging
#: engines took every slot and a third one's engines sat in the QUEUE until its
#: budget expired, having never opened a socket. Threads are created on demand and
#: reused, so this ceiling costs nothing until the concurrency is real — one user
#: searching alone still builds exactly seven.
_MAX_INFLIGHT_SEARCHES = 6
_MAX_WORKERS = _MAX_INFLIGHT_SEARCHES * len(DEFAULT_ENGINES)
_POOL_LOCK = threading.Lock()
_POOL: ThreadPoolExecutor | None = None


def _pool() -> ThreadPoolExecutor:
    """The shared fan-out pool, built on first use — importing this module (or running
    the CLI with --help) should not start threads."""
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="websearch")
        return _POOL


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
    query: str,
    engines: Iterable[Engine],
    *,
    delay: float,
    rrf_k: int,
    budget: float = FANOUT_BUDGET,
) -> tuple[dict[str, Hit], dict[str, float], int, list[str]]:
    """Run every engine and return (page by URL, summed reciprocal rank by URL,
    raw hit count before dedup, names of the engines that could not answer).
    A page ranked `rank` by one engine contributes 1/(rrf_k + rank) — once per
    engine, or an engine listing the same page twice would look like two engines
    agreeing.

    The page keeps the FIRST engine's dict (so 'source' stays that engine's name)
    and gains 'engines': every engine that returned the URL, in the order the
    engines ran — DEFAULT_ENGINES order, which is the priority order. A later
    engine also fills in 'snippet' when the earlier ones had none, so dedup never
    throws away the only blurb we got.

    An engine counts as having FAILED when it was blocked, unreachable or too slow
    for the budget — not when it simply had nothing to say, and not when it never
    ran at all because the shared pool was busy with another search. Fusion still
    ignores it either way; the names are for whoever has to tell the user which of
    "no results" and "no network" just happened, and blaming the network for a busy
    moment is the answer that sends them looking at their router."""
    engines = list(engines)
    # Results are slotted BY INDEX, so the merge below sees the engines in
    # DEFAULT_ENGINES order no matter what order they finish in. That order is
    # load-bearing: it decides each page's 'source' and the order of its
    # 'engines' list.
    results: list[list[Hit]] = [[] for _ in engines]
    broke = [False] * len(engines)
    # Run the engines CONCURRENTLY. They are independent network calls to
    # different hosts, and running them one after another made the wall clock
    # the SUM of seven timeouts — measured at 86s for one query, which the
    # browser's results page shows as a dead "Searching…" screen (owner report
    # 2026-08-01). In parallel the cost is the slowest single engine.
    #
    # `delay` is the politeness knob for the CLI, and spacing requests out is
    # its entire purpose, so that path stays sequential.
    if delay:
        for i, engine in enumerate(engines):
            if i:
                time.sleep(delay)  # be polite; protects your IP reputation
            results[i], broke[i] = _run_engine(engine, query)
    else:
        pool = _pool()
        futures = {pool.submit(_run_engine, engine, query): i for i, engine in enumerate(engines)}
        try:
            for future in as_completed(list(futures), timeout=budget):
                index = futures[future]
                results[index], broke[index] = future.result()
        except FuturesTimeout:
            # A running engine is not waited for: a straggler blocked on a dead
            # host would put the whole budget back. It ends on its own read
            # timeout (capped at the budget by _timeout) and frees its pooled
            # thread; its result is simply not part of this search.
            #
            # An engine that never STARTED is a different animal and must not be
            # reported as one that could not answer: nothing was wrong with it —
            # the shared pool was busy with another search — and 'failed' means
            # "the search never happened, you are offline" to whoever reads it.
            # Cancelling is both true and useful: it would otherwise run against
            # a search that has already answered, holding a thread from the next
            # one.
            late, queued = [], []
            for future, index in futures.items():
                if future.done():
                    continue
                if future.cancel():
                    queued.append(index)
                    continue
                late.append(index)
                broke[index] = True
            # Engine names only, never the query (SPEC §6).
            for indices, why in ((sorted(late), "missed"), (sorted(queued), "never started within")):
                if indices:
                    names = ", ".join(engines[index].__name__ for index in indices)
                    _log.warning("web search: %s %s the %.0fs budget", names, why, budget)

    merged: dict[str, Hit] = {}
    rrf: defaultdict[str, float] = defaultdict(float)
    collected = 0
    for hits in results:
        counted: set[str] = set()
        for rank, hit in enumerate(hits, start=1):
            collected += 1
            key = _dedupe_key(hit["url"])
            if not key or key in counted:
                continue
            counted.add(key)
            page = merged.setdefault(key, dict(hit, engines=[]))
            if hit["source"] not in page["engines"]:
                page["engines"].append(hit["source"])
            if page.get("snippet") is None and hit.get("snippet"):
                page["snippet"] = hit["snippet"]
            rrf[key] += 1.0 / (rrf_k + rank)
    failed = [engine.__name__ for engine, missed in zip(engines, broke, strict=True) if missed]
    return merged, rrf, collected, failed


def _ranked(
    query: str,
    limit: int,
    *,
    engines: Iterable[Engine] | None = None,
    delay: float = 0.0,
    rrf_k: int = 60,
    budget: float = FANOUT_BUDGET,
) -> tuple[list[Hit], int, list[str]]:
    """search() minus the public shape: (hits, raw hit count before dedup, engines
    that could not answer) — the count is what the route reports as 'merged', the
    names what it reports as 'failed'."""
    merged, rrf, collected, failed = _fuse(
        query,
        DEFAULT_ENGINES if engines is None else engines,
        delay=delay,
        rrf_k=rrf_k,
        budget=budget,
    )
    if not merged:
        return [], collected, failed

    top_rrf = max(rrf.values()) or 1.0
    scored = [
        dict(hit, score=_score(query, hit, rrf[key] / top_rrf)) for key, hit in merged.items()
    ]
    scored.sort(key=itemgetter("score"), reverse=True)
    return scored[:limit], collected, failed


def search(
    query: str,
    limit: int = 12,
    *,
    engines: Iterable[Engine] | None = None,
    delay: float = 0.0,
    rrf_k: int = 60,
) -> list[Hit]:
    """Return up to `limit` deduped web links, most-relevant first:
        [{'title','url','source','date','snippet','engines','score'}, ...]

    'engines' lists every engine that returned the URL (in DEFAULT_ENGINES order);
    'source' is always engines[0]. 'snippet' is the first non-empty blurb among
    those engines, in the same order.

    score (0..1, relative within this query) = 70% Reciprocal-Rank-Fusion + 30% title match.
      - RRF rewards links the engines rank HIGH and that MULTIPLE engines agree on
        (a URL found by two engines sums both contributions). `rrf_k` is its damping
        constant — larger flattens the rank curve, so agreement outweighs position.
      - title match rewards links whose title actually contains your query words.
    So it's a real cross-engine relevance ranking, computed from scratch — no ML, no API.

    Dates: news carries a real date for free; the other links keep whatever their
    engine reported, which is often nothing. Filling the rest in would mean fetching
    each RESULT url from Python, around the Rust SSRF guard — see the module
    docstring — so this module never does it."""
    return _ranked(query, limit, engines=engines, delay=delay, rrf_k=rrf_k)[0]


def timed_search(
    query: str, limit: int = 12, *, engines: Iterable[Engine] | None = None
) -> dict[str, Any]:
    """What ``POST /web_search`` returns: ``{'hits', 'merged', 'tookMs', 'failed'}`` —
    the fused hits plus how much raw material the fusion saw ('merged', hits
    across all engines before URL dedup), the wall-clock milliseconds, and the
    engines that could not answer at all ('failed': blocked, unreachable or too
    slow for the budget).

    'failed' is what separates the two ways a search comes back empty. No hits and
    nothing failed means the web really had nothing for that query. No hits and
    every engine failed means the search never happened — offline, or a network
    blocking all of them — and telling the user to try fewer words would be a lie.

    Like :func:`search` it never fetches a result URL — no entry point here owns
    a knob that would step around the Rust SSRF guard (see the module
    docstring)."""
    started = time.monotonic()
    hits, collected, failed = _ranked(query, limit, engines=engines)
    return {
        "hits": hits,
        "merged": collected,
        "tookMs": int((time.monotonic() - started) * 1000),
        "failed": failed,
    }
