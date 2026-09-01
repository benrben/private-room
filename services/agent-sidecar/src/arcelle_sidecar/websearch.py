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

Nothing here fetches a result URL; only fixed engine endpoints are requested.
Anything needing a result page goes through the host's guarded fetch, preserving
its local/private-address refusal and response-size boundary.
"""
from __future__ import annotations

import itertools
import logging
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from functools import wraps
from typing import Any
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup

from .websearch_fusion import (
    _fuse_results as _fuse_results,
    _lexical as _lexical,
    _rank_results as _rank_results,
    _timed_result as _timed_result,
)
from .websearch_parse import (
    Hit,
    _brave_snippet as _brave_snippet,
    _collect as _collect,
    _ddg_anchors as _ddg_anchors,
    _ddg_snippet as _ddg_snippet,
    _dedupe_key as _dedupe_key,
    _hit as _hit,
    _marginalia_snippet as _marginalia_snippet,
    _mojeek_snippet as _mojeek_snippet,
    _rss_date as _rss_date,
    _rss_snippet as _rss_snippet,
    _text_of as _text_of,
    _unwrap_ddg as _unwrap_ddg,
)

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
    no network at all) looks exactly like 'nothing matched'.

    The ENGINE and the exception TYPE are logged, never the exception itself and
    never a traceback. `requests` builds its message out of the request it was
    making — "HTTPSConnectionPool(host='www.mojeek.com', ...): Max retries
    exceeded with url: /search?q=<the user's words>" — so `exc_info=True` here
    wrote the query into an unencrypted file in the Mac's temp folder
    (`sidecar_lifecycle::stderr_log_path`) on every network blip, which is
    exactly what this module's docstring promises never happens (SPEC §6). The
    type is what tells a rotted selector (AttributeError) from a dead network
    (ConnectionError), and that is the diagnosis this log exists for."""

    @wraps(engine)
    def wrapper(*args: Any, **kwargs: Any) -> list[Hit]:
        try:
            return engine(*args, **kwargs)
        except Exception as exc:
            _log.warning("engine %s failed: %s", engine.__name__, type(exc).__name__)
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


def _ddg_attempt_read_budget(deadline: float, attempt: int) -> float:
    """Leave the next retry's pause inside the search's remaining budget."""
    retry_pause = _DDG_RETRY_PAUSE if attempt else 0.0
    return deadline - time.monotonic() - retry_pause


def _ddg_attempts_within_budget(
    query: str, k: int, tries: int, budget: float
) -> list[Hit] | None:
    """Return DDG hits, [] after challenges, or None after an unrecoverable failure."""
    deadline = time.monotonic() + budget
    for attempt in range(tries):
        left = _ddg_attempt_read_budget(deadline, attempt)
        if left <= 0:
            _log.warning("duckduckgo spent its %.0fs budget after %d attempt(s)", budget, attempt)
            _note_failure("out of budget")
            return None
        if attempt:
            time.sleep(_DDG_RETRY_PAUSE)
        try:
            hits = _ddg_attempt(query, k, read=left)
        except requests.RequestException as exc:
            _log.warning("duckduckgo unreachable (%s); not retrying", type(exc).__name__)
            _note_failure(type(exc).__name__)
            return None
        if hits:
            return hits
    return []


@_fails_soft
def duckduckgo(query: str, k: int = 10, tries: int = 3, budget: float = FANOUT_BUDGET) -> list[Hit]:
    """Real DuckDuckGo web results by scraping the no-JS HTML endpoint.
    Page 1 needs NO token — just a POST with b='' and proper browser headers.
    DDG's block is INTERMITTENT (HTTP 202), so we retry up to `tries` times with a
    rotating User-Agent and a short pause — that alone clears most transient blocks.

    All the attempts together get `budget` seconds, which is the whole fan-out's
    budget: three 20s attempts plus their pauses is 64s of a 22s search, so past
    the budget a retry can only produce results that arrive too late to be used.

    Fail-soft like every other engine — the inner `except requests.RequestException`
    is a different thing, the do-not-retry short-circuit for an unreachable host."""
    hits = _ddg_attempts_within_budget(query, k, tries, budget)
    if hits is None:
        return []
    if hits:
        return hits
    _log.warning("duckduckgo blocked after %d attempts", tries)
    _note_failure("blocked")
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
    return _collect(
        anchors,
        "brave",
        k=k,
        exclude="brave.com",
        min_title=_BRAVE_MIN_TITLE,
        snippet=_brave_snippet,
    )


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

#: The fan-out pool is shared: a search should not create seven threads and
#: sessions that it discards a second later. Nothing here is ever
#: shut down; a straggler ends on its own read timeout, which _timeout() caps at the
#: fan-out budget.
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


def _run_engines_politely(
    engines: list[Engine], query: str, delay: float, results: list[list[Hit]], broke: list[bool]
) -> None:
    """Run engines in order when the caller asked to space out its requests."""
    for index, engine in enumerate(engines):
        if index:
            time.sleep(delay)  # be polite; protects your IP reputation
        results[index], broke[index] = _run_engine(engine, query)


def _save_engine_result(
    future: Any,
    index: int,
    engines: list[Engine],
    results: list[list[Hit]],
    broke: list[bool],
) -> None:
    """Keep one parallel engine's answer without letting its bug sink the search."""
    try:
        results[index], broke[index] = future.result()
    except Exception as exc:
        # Every engine is wrapped in _fails_soft, so reaching here means one was
        # added without it. Keep the engines that did answer, and diagnose only
        # the engine and exception type — never the query (SPEC §6).
        _log.warning(
            "engine %s raised past its guard: %s",
            engines[index].__name__,
            type(exc).__name__,
        )
        broke[index] = True


def _cancel_unfinished_engines(futures: dict[Any, int], broke: list[bool]) -> tuple[list[int], list[int]]:
    """Return running and never-started engine indices after the fan-out budget."""
    late, queued = [], []
    for future, index in futures.items():
        if future.done():
            continue
        if future.cancel():
            queued.append(index)
            continue
        late.append(index)
        broke[index] = True
    return late, queued


def _log_budget_miss(engines: list[Engine], indices: list[int], why: str, budget: float) -> None:
    """Log timed-out engines without exposing the user's query."""
    if indices:
        names = ", ".join(engines[index].__name__ for index in indices)
        _log.warning("web search: %s %s the %.0fs budget", names, why, budget)


def _handle_fanout_timeout(
    futures: dict[Any, int], engines: list[Engine], broke: list[bool], budget: float
) -> None:
    """Cancel queued work and record only engines that really started then missed budget."""
    late, queued = _cancel_unfinished_engines(futures, broke)
    _log_budget_miss(engines, sorted(late), "missed", budget)
    _log_budget_miss(engines, sorted(queued), "never started within", budget)


def _run_engines_in_parallel(
    engines: list[Engine], query: str, budget: float, results: list[list[Hit]], broke: list[bool]
) -> None:
    """Fan independent engine calls out concurrently, with one wall-clock budget."""
    pool = _pool()
    futures = {pool.submit(_run_engine, engine, query): index for index, engine in enumerate(engines)}
    try:
        for future in as_completed(list(futures), timeout=budget):
            _save_engine_result(future, futures[future], engines, results, broke)
    except FuturesTimeout:
        _handle_fanout_timeout(futures, engines, broke, budget)


def _fuse(
    query: str,
    engines: Iterable[Engine],
    *,
    delay: float,
    rrf_k: int,
    budget: float = FANOUT_BUDGET,
) -> tuple[dict[str, Hit], dict[str, float], int, list[str]]:
    """Run engines with the original network seams, then fuse their results."""
    return _fuse_results(
        engines,
        query=query,
        delay=delay,
        rrf_k=rrf_k,
        budget=budget,
        run_politely=_run_engines_politely,
        run_parallel=_run_engines_in_parallel,
    )


def _ranked(
    query: str,
    limit: int,
    *,
    engines: Iterable[Engine] | None = None,
    delay: float = 0.0,
    rrf_k: int = 60,
    budget: float = FANOUT_BUDGET,
) -> tuple[list[Hit], int, list[str]]:
    """Return ranked hits, raw hit count, and engines that could not answer."""
    return _rank_results(
        query,
        limit,
        engines=DEFAULT_ENGINES if engines is None else engines,
        delay=delay,
        rrf_k=rrf_k,
        budget=budget,
        fuse_runner=_fuse,
    )


def search(
    query: str,
    limit: int = 12,
    *,
    engines: Iterable[Engine] | None = None,
    delay: float = 0.0,
    rrf_k: int = 60,
) -> list[Hit]:
    """Return the highest-ranked deduplicated engine results."""
    return _ranked(query, limit, engines=engines, delay=delay, rrf_k=rrf_k)[0]


def timed_search(
    query: str, limit: int = 12, *, engines: Iterable[Engine] | None = None
) -> dict[str, Any]:
    """Return fused hits with raw count, elapsed milliseconds, and failures."""
    return _timed_result(query, limit, engines, _ranked, time.monotonic)
