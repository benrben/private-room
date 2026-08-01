"""The room's web search (websearch.py): engine parsing, RRF fusion, the route.

No test here touches the network. Engines are exercised against captured markup
via a fake ``_get`` / ``_SESSION``, and the fusion maths against fake engines —
so a selector rotting on a live site shows up as a failing parse test, not as a
green suite that quietly returns nothing.
"""

from __future__ import annotations

import inspect
from typing import Any

import httpx
import pytest
import requests
from bs4 import BeautifulSoup

from arcelle_sidecar import websearch as w
from arcelle_sidecar.server import create_app


class FakeResponse:
    """Just enough of requests.Response for the engines."""

    def __init__(self, *, text: str = "", status: int = 200, payload: Any = None) -> None:
        self.text = text
        self.content = text.encode()
        self.status_code = status
        self.headers: dict[str, str] = {}
        self._payload = payload

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


def anchors(html: str) -> list[Any]:
    return BeautifulSoup(html, "html.parser").select("a")


# ── helpers ─────────────────────────────────────────────────────────────────────


def test_dedupe_key_ignores_fragment_and_trailing_slash() -> None:
    assert w._dedupe_key("https://a.com/p/") == w._dedupe_key("https://a.com/p")
    assert w._dedupe_key("https://a.com/p#top") == "https://a.com/p"


def test_lexical_is_fraction_of_query_words_in_title() -> None:
    assert w._lexical("bank of israel", "Bank of Israel") == 1.0
    assert w._lexical("bank of israel", "Bank of Ireland") == pytest.approx(2 / 3)
    assert w._lexical("bank", "nothing here") == 0.0
    assert w._lexical("", "anything") == 0.0  # no words -> no signal, not a crash


def test_hit_normalizes_a_blank_snippet_to_none() -> None:
    assert w._hit("t", "u", "e", snippet="  ")["snippet"] is None
    assert w._hit("t", "u", "e", snippet=" text ")["snippet"] == "text"
    assert w._hit("t", "u", "e")["snippet"] is None


def test_rss_date_parses_rfc2822_and_tolerates_junk() -> None:
    assert w._rss_date("Mon, 06 Jul 2026 10:00:00 GMT") == "2026-07-06"
    assert w._rss_date("not a date") is None
    assert w._rss_date(None) is None


def test_unwrap_ddg_recovers_the_real_url() -> None:
    wrapped = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc"
    assert w._unwrap_ddg(wrapped) == "https://example.com/page"
    assert w._unwrap_ddg("https://plain.example.org/x") == "https://plain.example.org/x"


def test_fails_soft_turns_any_exception_into_no_results() -> None:
    @w._fails_soft
    def boom(query: str) -> list[dict[str, Any]]:
        raise RuntimeError("selectors rotted")

    assert boom("q") == []


# ── _collect ────────────────────────────────────────────────────────────────────


def test_collect_drops_non_http_dupes_short_titles_and_self_links() -> None:
    html = """
      <a href="https://good.com/a">A real headline</a>
      <a href="/relative">Relative link</a>
      <a href="https://good.com/a/">A real headline</a>
      <a href="https://engine.com/settings">Settings</a>
      <a href="https://good.com/b">Another real headline</a>
    """
    hits = w._collect(anchors(html), "eng", k=10, exclude="engine.com", min_title=5)
    assert [h["url"] for h in hits] == ["https://good.com/a", "https://good.com/b"]
    assert {h["source"] for h in hits} == {"eng"}


def test_collect_stops_at_k() -> None:
    html = "".join(f'<a href="https://x.com/{i}">Headline {i}</a>' for i in range(10))
    assert len(w._collect(anchors(html), "eng", k=3)) == 3


# ── engines ─────────────────────────────────────────────────────────────────────

DDG_HTML = """
<div class="result">
  <a rel="nofollow" class="result__a"
     href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc">Example <b>Title</b></a>
  <a class="result__snippet" href="#">A short snippet.</a>
</div>
<div class="web-result">
  <h2><a href="https://plain.example.org/x">Second result</a></h2>
</div>
"""


def test_duckduckgo_parses_results_and_unwraps_redirects(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        w._SESSION, "post", lambda *a, **k: FakeResponse(text=DDG_HTML), raising=False
    )
    hits = w.duckduckgo("example")
    assert [h["url"] for h in hits] == ["https://example.com/page", "https://plain.example.org/x"]
    assert hits[0]["title"] == "Example Title"
    assert hits[0]["source"] == "duckduckgo"
    assert hits[0]["snippet"] == "A short snippet."
    assert hits[1]["snippet"] is None  # a result without a blurb stays None, not ""


def test_duckduckgo_retries_then_gives_up_on_a_challenge(monkeypatch: Any) -> None:
    calls = {"n": 0}

    def blocked(*a: Any, **k: Any) -> FakeResponse:
        calls["n"] += 1
        return FakeResponse(text="<div>challenge-form</div>")

    monkeypatch.setattr(w._SESSION, "post", blocked, raising=False)
    monkeypatch.setattr(w.time, "sleep", lambda _s: None)
    assert w.duckduckgo("example", tries=3) == []
    assert calls["n"] == 3  # the block is intermittent, so it really does retry


def test_brave_rejects_its_own_chrome_by_title_length(monkeypatch: Any) -> None:
    html = """
      <div class="snippet">
        <a class="h" href="https://news.example.com/story">A genuine long headline</a>
        <div class="snippet-description">What actually happened.</div>
      </div>
      <a class="h" href="https://other.example.com/x">Images</a>
      <a class="h" href="https://brave.com/settings">Brave settings page</a>
    """
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    hits = w.brave("story")
    assert [h["url"] for h in hits] == ["https://news.example.com/story"]
    assert hits[0]["snippet"] == "What actually happened."


def test_mojeek_403_fails_soft(monkeypatch: Any) -> None:
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(status=403))
    assert w.mojeek("anything") == []


def test_mojeek_reads_title_and_sibling_snippet(monkeypatch: Any) -> None:
    html = """
      <ul class="results-standard"><li>
        <h2><a class="title" href="https://site.example/a">Result title</a></h2>
        <p class="s">Mojeek's own blurb.</p>
      </li></ul>
    """
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    hits = w.mojeek("result")
    assert [h["url"] for h in hits] == ["https://site.example/a"]
    assert hits[0]["snippet"] == "Mojeek's own blurb."


def test_marginalia_parses_heading_links(monkeypatch: Any) -> None:
    html = '<h2><a href="https://tiny.example.net/essay">An essay</a></h2>'
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    hits = w.marginalia("essay")
    assert hits[0]["url"] == "https://tiny.example.net/essay"
    assert hits[0]["snippet"] is None  # no <p> at all -> no snippet


def test_marginalia_snippet_cannot_steal_the_next_results_blurb(monkeypatch: Any) -> None:
    """The description <p> follows its <h2>; a description-less first result must
    get None, not the second result's text."""
    html = """
      <h2><a href="https://a.example/one">One</a></h2>
      <h2><a href="https://a.example/two">Two</a></h2>
      <p>Two's description.</p>
    """
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    hits = w.marginalia("one two")
    assert [h["snippet"] for h in hits] == [None, "Two's description."]


def test_wikipedia_parses_opensearch(monkeypatch: Any) -> None:
    payload = [
        "bank of israel",
        ["Bank of Israel", "Bank of Ireland"],
        ["Israel's central bank.", ""],
        ["https://en.wikipedia.org/wiki/Bank_of_Israel", "https://en.wikipedia.org/wiki/BOI"],
    ]
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload=payload))
    hits = w.wikipedia("bank of israel")
    assert [h["title"] for h in hits] == ["Bank of Israel", "Bank of Ireland"]
    assert all(h["source"] == "wikipedia" for h in hits)
    # OpenSearch's descriptions array (often empty nowadays) becomes the snippet.
    assert [h["snippet"] for h in hits] == ["Israel's central bank.", None]


def test_wikipedia_403_fails_soft_without_parsing_html(monkeypatch: Any) -> None:
    """Regression: Wikimedia 403s a spoofed browser UA and answers HTML. Calling
    .json() on that raised on EVERY search — soft-failed, but with a traceback."""
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text="<html>403</html>", status=403))
    assert w.wikipedia("bank of israel") == []


def test_wikipedia_sends_the_descriptive_ua_wikimedia_requires(monkeypatch: Any) -> None:
    seen: dict[str, Any] = {}

    def spy(url: str, **kwargs: Any) -> FakeResponse:
        seen.update(kwargs.get("headers", {}))
        return FakeResponse(payload=["q", [], [], []])

    monkeypatch.setattr(w, "_get", spy)
    w.wikipedia("q")
    assert "Arcelle" in seen["User-Agent"]
    assert "Mozilla" not in seen["User-Agent"]


def test_duckduckgo_ia_takes_abstract_and_related_topics(monkeypatch: Any) -> None:
    payload = {
        "Heading": "Ada Lovelace",
        "AbstractURL": "https://duckduckgo.com/Ada_Lovelace",
        "AbstractText": "English mathematician and writer.",
        "RelatedTopics": [
            {"Text": "Analytical Engine", "FirstURL": "https://duckduckgo.com/Analytical_Engine"},
            {"Name": "a category with no url"},
        ],
    }
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload=payload))
    hits = w.duckduckgo_ia("ada lovelace")
    assert [h["title"] for h in hits] == ["Ada Lovelace", "Analytical Engine"]
    # The abstract text is the snippet; a topic's Text is already its title.
    assert [h["snippet"] for h in hits] == ["English mathematician and writer.", None]


def test_duckduckgo_ia_empty_answer_is_not_an_error(monkeypatch: Any) -> None:
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload={"AbstractURL": ""}))
    assert w.duckduckgo_ia("no instant answer for this") == []


def test_google_news_reads_dates_off_the_rss(monkeypatch: Any) -> None:
    rss = """<?xml version="1.0"?><rss><channel>
      <item><title>Rate cut</title><link>https://news.example/1</link>
        <description>&lt;a href="https://news.example/1"&gt;Rate cut&lt;/a&gt;&amp;nbsp;&amp;nbsp;Example Wire</description>
        <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate></item>
      <item><title>No date</title><link>https://news.example/2</link></item>
    </channel></rss>"""
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=rss))
    hits = w.google_news("rates")
    assert hits[0]["date"] == "2026-07-06"
    assert hits[1]["date"] is None
    assert all(h["source"] == "news" for h in hits)
    # The item description is HTML; the snippet is its text with the tags gone.
    assert hits[0]["snippet"] == "Rate cut Example Wire"
    assert hits[1]["snippet"] is None


# ── fusion ──────────────────────────────────────────────────────────────────────


def engine(name: str, *urls: str) -> Any:
    """A fake engine returning `urls` in rank order, titled after the url."""

    def run(query: str, **kwargs: Any) -> list[dict[str, Any]]:
        return [w._hit(u.rsplit("/", 1)[-1], u, name) for u in urls]

    run.__name__ = name
    return run


def test_agreement_between_engines_outranks_a_single_top_hit() -> None:
    both = "https://a.com/shared"
    hits = w.search(
        "shared",
        engines=[engine("e1", both, "https://b.com/only"), engine("e2", "https://c.com/x", both)],
    )
    assert hits[0]["url"] == both
    # b.com/only was ranked #2 by one engine; the shared url beat it on agreement.
    assert hits[0]["score"] > hits[1]["score"]


def test_one_engine_listing_a_page_twice_is_not_two_engines_agreeing() -> None:
    dupe = "https://a.com/p"
    twice = w.search("p", engines=[engine("e1", dupe, dupe + "/")])
    once = w.search("p", engines=[engine("e1", dupe)])
    assert len(twice) == 1
    assert twice[0]["score"] == once[0]["score"]
    assert twice[0]["engines"] == ["e1"]  # nor can it appear twice in the consensus


def test_fused_hit_lists_every_agreeing_engine_in_run_order() -> None:
    shared = "https://a.com/shared"
    hits = w.search(
        "shared",
        engines=[engine("e1", shared), engine("e2", "https://b.com/x", shared)],
    )
    top = next(h for h in hits if h["url"] == shared)
    assert top["engines"] == ["e1", "e2"]
    assert top["source"] == "e1"  # identity stays the first engine's, as before
    only = next(h for h in hits if h["url"] == "https://b.com/x")
    assert only["engines"] == ["e2"]


def test_dedup_keeps_the_first_non_empty_snippet_in_run_order() -> None:
    url = "https://a.com/p"

    def with_snippet(name: str, snippet: str | None) -> Any:
        def run(query: str, **kwargs: Any) -> list[dict[str, Any]]:
            return [w._hit("p", url, name, snippet=snippet)]

        run.__name__ = name
        return run

    hits = w.search(
        "p",
        engines=[with_snippet("e1", None), with_snippet("e2", "second's"), with_snippet("e3", "third's")],
    )
    assert hits[0]["source"] == "e1"  # dedup still keeps the first engine's identity
    assert hits[0]["snippet"] == "second's"  # ...but not its missing snippet


def test_scores_are_sorted_and_capped_by_limit() -> None:
    hits = w.search("x", limit=2, engines=[engine("e1", *(f"https://a.com/{i}" for i in range(6)))])
    assert len(hits) == 2
    assert hits == sorted(hits, key=lambda h: h["score"], reverse=True)


def test_every_hit_carries_the_documented_shape() -> None:
    hits = w.search("page", engines=[engine("e1", "https://a.com/page")])
    assert set(hits[0]) == {"title", "url", "source", "date", "snippet", "engines", "score"}
    assert 0.0 <= hits[0]["score"] <= 1.0


def test_timed_search_reports_the_raw_hit_count_and_wall_clock() -> None:
    payload = w.timed_search(
        "page",
        engines=[
            engine("e1", "https://a.com/page", "https://a.com/other"),
            engine("e2", "https://a.com/page"),
        ],
    )
    assert {h["url"] for h in payload["hits"]} == {"https://a.com/page", "https://a.com/other"}
    assert payload["merged"] == 3  # 3 raw hits went in, 2 pages came out
    assert isinstance(payload["tookMs"], int)
    assert payload["tookMs"] >= 0


def test_a_dead_engine_cannot_sink_the_search() -> None:
    @w._fails_soft
    def dead(query: str, **kwargs: Any) -> list[dict[str, Any]]:
        raise RuntimeError("blocked")

    hits = w.search("page", engines=[dead, engine("e2", "https://a.com/page")])
    assert [h["url"] for h in hits] == ["https://a.com/page"]


def test_all_engines_dead_returns_empty_not_an_error() -> None:
    assert w.search("page", engines=[engine("e1"), engine("e2")]) == []


def test_default_engines_are_the_seven_fixed_ones() -> None:
    """The provider is not configurable — this set IS the provider."""
    assert [e.__name__ for e in w.DEFAULT_ENGINES] == [
        "duckduckgo",
        "brave",
        "mojeek",
        "marginalia",
        "wikipedia",
        "duckduckgo_ia",
        "google_news",
    ]


# ── the route ───────────────────────────────────────────────────────────────────


async def test_web_search_route_returns_fused_hits_with_telemetry(monkeypatch: Any) -> None:
    payload = {
        "hits": [dict(w._hit("T", "https://a.com/p", "e1"), engines=["e1"], score=0.9)],
        "merged": 3,
        "tookMs": 12,
    }
    monkeypatch.setattr(w, "timed_search", lambda q, limit: payload)
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "  spaced  ", "limit": 5})
    assert resp.status_code == 200
    assert resp.json() == {
        "hits": [
            {
                "title": "T",
                "url": "https://a.com/p",
                "source": "e1",
                "date": None,
                "snippet": None,
                "engines": ["e1"],
                "score": 0.9,
            }
        ],
        "merged": 3,
        "tookMs": 12,
    }


async def test_web_search_route_trims_the_query(monkeypatch: Any) -> None:
    seen: dict[str, Any] = {}

    def spy(query: str, limit: int) -> dict[str, Any]:
        seen["query"] = query
        seen["limit"] = limit
        return {"hits": [], "merged": 0, "tookMs": 0}

    monkeypatch.setattr(w, "timed_search", spy)
    async with client_for(create_app()) as c:
        await c.post("/web_search", json={"query": "  bank of israel \n", "limit": 3})
    assert seen == {"query": "bank of israel", "limit": 3}


async def test_web_search_route_rejects_an_empty_query() -> None:
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "   "})
    assert resp.status_code == 400
    assert resp.json()["code"] == "BAD_REQUEST"


async def test_web_search_route_reports_a_broken_fusion_as_502(monkeypatch: Any) -> None:
    def boom(query: str, limit: int) -> dict[str, Any]:
        raise RuntimeError("fusion is broken")

    monkeypatch.setattr(w, "timed_search", boom)
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "anything"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "WEB_SEARCH_FAILED"


async def test_web_search_route_has_no_resolve_dates_knob(monkeypatch: Any) -> None:
    """Date resolution fetches each RESULT url from Python, around the Rust SSRF
    guard. The body must not be able to switch it on — and timed_search doesn't
    even accept the parameter, so the route couldn't forward it if it tried."""
    assert "resolve_dates" not in inspect.signature(w.timed_search).parameters
    seen: dict[str, Any] = {}

    def spy(query: str, limit: int, **kwargs: Any) -> dict[str, Any]:
        seen.update(kwargs)
        return {"hits": [], "merged": 0, "tookMs": 0}

    monkeypatch.setattr(w, "timed_search", spy)
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "q", "resolve_dates": True})
    assert resp.status_code == 200
    assert seen == {}


def test_parallel_fanout_matches_sequential_exactly():
    """The engines run concurrently, but the merge must see them in
    DEFAULT_ENGINES order — that order decides each page's 'source' and the
    order of its 'engines' list. Parallel is a pure speedup, never a reshuffle."""
    import time as _time

    def slow(name, hits):
        def engine(query, **kwargs):
            _time.sleep(0.15)
            return hits

        engine.__name__ = name
        return engine

    shared = "https://shared.example/page"
    engines = [
        slow("a", [w._hit("A one", shared, "a", snippet=None),
                   w._hit("A two", "https://a.example/2", "a")]),
        slow("b", [w._hit("B one", shared, "b", snippet="from b")]),
        slow("c", [w._hit("C one", "https://c.example/1", "c")]),
    ]

    started = _time.monotonic()
    hits, collected = w._ranked("q", 10, engines=engines)
    elapsed = _time.monotonic() - started

    # Three 0.15s engines: sequential would be >=0.45s, parallel ~0.15s.
    assert elapsed < 0.40, f"engines did not run concurrently ({elapsed:.2f}s)"
    assert collected == 4

    by_url = {hit["url"]: hit for hit in hits}
    page = by_url[shared]
    # Engine order preserved: 'a' ran first, so it owns 'source'…
    assert page["source"] == "a"
    assert page["engines"] == ["a", "b"]
    # …and 'b' still fills in the snippet 'a' did not have.
    assert page["snippet"] == "from b"


def test_delay_still_serializes_for_the_polite_cli_path():
    """`delay` exists to space requests out; that path must stay sequential."""
    import time as _time

    order = []

    def engine_factory(name):
        def engine(query, **kwargs):
            order.append(name)
            return []

        engine.__name__ = name
        return engine

    started = _time.monotonic()
    w._ranked("q", 5, engines=[engine_factory("a"), engine_factory("b")], delay=0.2)
    assert _time.monotonic() - started >= 0.2
    assert order == ["a", "b"]


def test_a_slow_engine_cannot_own_the_search():
    """The fan-out has a wall-clock budget. An engine still running when it
    expires contributes nothing — the same fail-soft rule as one that errors,
    applied to one that is merely too slow. Without this, DuckDuckGo
    connect-timing-out (20s x 3 attempts) made every search 64s long."""
    import time as _time

    def fast(query, **kwargs):
        return [w._hit("Fast", "https://fast.example/1", "fast")]

    def glacial(query, **kwargs):
        _time.sleep(5)
        return [w._hit("Glacial", "https://slow.example/1", "glacial")]

    fast.__name__, glacial.__name__ = "fast", "glacial"

    started = _time.monotonic()
    hits, _collected = w._ranked("q", 10, engines=[glacial, fast], budget=0.4)
    elapsed = _time.monotonic() - started

    assert elapsed < 2.0, f"the budget did not cut the slow engine off ({elapsed:.2f}s)"
    urls = [h["url"] for h in hits]
    assert "https://fast.example/1" in urls
    assert "https://slow.example/1" not in urls


def test_connect_timeout_is_bounded_separately_from_read():
    """A host that will not accept a connection quickly is down or blocking us;
    it must not be able to spend the whole read budget."""
    assert w._timeout(20) == (5.0, 20)
    # A read budget tighter than the connect bound stays whole.
    assert w._timeout(3) == (3, 3)


def test_duckduckgo_does_not_retry_a_host_it_cannot_reach(monkeypatch):
    """A challenge page is worth retrying; an unreachable host is not. Retrying
    a connect timeout three times was most of a 19s search."""
    calls = []

    def unreachable(query, k):
        calls.append(1)
        raise requests.ConnectTimeout("no route")

    monkeypatch.setattr(w, "_ddg_attempt", unreachable)
    assert w.duckduckgo("q") == []
    assert len(calls) == 1, "an unreachable host must not be retried"


def test_duckduckgo_still_retries_an_intermittent_challenge(monkeypatch):
    """The retry exists for DDG's intermittent HTTP 202 — keep it working."""
    attempts = []

    def flaky(query, k):
        attempts.append(1)
        if len(attempts) < 2:
            return []  # challenge page: empty, but reachable
        return [w._hit("Real", "https://ddg.example/1", "duckduckgo")]

    monkeypatch.setattr(w, "_ddg_attempt", flaky)
    monkeypatch.setattr(w.time, "sleep", lambda _s: None)
    hits = w.duckduckgo("q")
    assert len(attempts) == 2
    assert hits and hits[0]["url"] == "https://ddg.example/1"
