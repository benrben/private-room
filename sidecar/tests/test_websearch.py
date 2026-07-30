"""The room's web search (websearch.py): engine parsing, RRF fusion, the route.

No test here touches the network. Engines are exercised against captured markup
via a fake ``_get`` / ``_SESSION``, and the fusion maths against fake engines —
so a selector rotting on a live site shows up as a failing parse test, not as a
green suite that quietly returns nothing.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
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
      <a class="h" href="https://news.example.com/story">A genuine long headline</a>
      <a class="h" href="https://other.example.com/x">Images</a>
      <a class="h" href="https://brave.com/settings">Brave settings page</a>
    """
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    hits = w.brave("story")
    assert [h["url"] for h in hits] == ["https://news.example.com/story"]


def test_mojeek_403_fails_soft(monkeypatch: Any) -> None:
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(status=403))
    assert w.mojeek("anything") == []


def test_marginalia_parses_heading_links(monkeypatch: Any) -> None:
    html = '<h2><a href="https://tiny.example.net/essay">An essay</a></h2>'
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=html))
    assert w.marginalia("essay")[0]["url"] == "https://tiny.example.net/essay"


def test_wikipedia_parses_opensearch(monkeypatch: Any) -> None:
    payload = [
        "bank of israel",
        ["Bank of Israel", "Bank of Ireland"],
        ["", ""],
        ["https://en.wikipedia.org/wiki/Bank_of_Israel", "https://en.wikipedia.org/wiki/BOI"],
    ]
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload=payload))
    hits = w.wikipedia("bank of israel")
    assert [h["title"] for h in hits] == ["Bank of Israel", "Bank of Ireland"]
    assert all(h["source"] == "wikipedia" for h in hits)


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
        "RelatedTopics": [
            {"Text": "Analytical Engine", "FirstURL": "https://duckduckgo.com/Analytical_Engine"},
            {"Name": "a category with no url"},
        ],
    }
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload=payload))
    hits = w.duckduckgo_ia("ada lovelace")
    assert [h["title"] for h in hits] == ["Ada Lovelace", "Analytical Engine"]


def test_duckduckgo_ia_empty_answer_is_not_an_error(monkeypatch: Any) -> None:
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(payload={"AbstractURL": ""}))
    assert w.duckduckgo_ia("no instant answer for this") == []


def test_google_news_reads_dates_off_the_rss(monkeypatch: Any) -> None:
    rss = """<?xml version="1.0"?><rss><channel>
      <item><title>Rate cut</title><link>https://news.example/1</link>
        <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate></item>
      <item><title>No date</title><link>https://news.example/2</link></item>
    </channel></rss>"""
    monkeypatch.setattr(w, "_get", lambda *a, **k: FakeResponse(text=rss))
    hits = w.google_news("rates")
    assert hits[0]["date"] == "2026-07-06"
    assert hits[1]["date"] is None
    assert all(h["source"] == "news" for h in hits)


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


def test_scores_are_sorted_and_capped_by_limit() -> None:
    hits = w.search("x", limit=2, engines=[engine("e1", *(f"https://a.com/{i}" for i in range(6)))])
    assert len(hits) == 2
    assert hits == sorted(hits, key=lambda h: h["score"], reverse=True)


def test_every_hit_carries_the_documented_shape() -> None:
    hits = w.search("page", engines=[engine("e1", "https://a.com/page")])
    assert set(hits[0]) == {"title", "url", "source", "date", "score"}
    assert 0.0 <= hits[0]["score"] <= 1.0


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


async def test_web_search_route_returns_fused_hits(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        w, "search", lambda q, limit: [dict(w._hit("T", "https://a.com/p", "e1"), score=0.9)]
    )
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "  spaced  ", "limit": 5})
    assert resp.status_code == 200
    assert resp.json() == {
        "hits": [{"title": "T", "url": "https://a.com/p", "source": "e1", "date": None, "score": 0.9}]
    }


async def test_web_search_route_trims_the_query(monkeypatch: Any) -> None:
    seen: dict[str, Any] = {}

    def spy(query: str, limit: int) -> list[dict[str, Any]]:
        seen["query"] = query
        seen["limit"] = limit
        return []

    monkeypatch.setattr(w, "search", spy)
    async with client_for(create_app()) as c:
        await c.post("/web_search", json={"query": "  bank of israel \n", "limit": 3})
    assert seen == {"query": "bank of israel", "limit": 3}


async def test_web_search_route_rejects_an_empty_query() -> None:
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "   "})
    assert resp.status_code == 400
    assert resp.json()["code"] == "BAD_REQUEST"


async def test_web_search_route_reports_a_broken_fusion_as_502(monkeypatch: Any) -> None:
    def boom(query: str, limit: int) -> list[dict[str, Any]]:
        raise RuntimeError("fusion is broken")

    monkeypatch.setattr(w, "search", boom)
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "anything"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "WEB_SEARCH_FAILED"


async def test_web_search_route_has_no_resolve_dates_knob(monkeypatch: Any) -> None:
    """Date resolution fetches each RESULT url from Python, around the Rust SSRF
    guard. The body must not be able to switch it on."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(w, "search", lambda q, limit, **kw: seen.update(kw) or [])
    async with client_for(create_app()) as c:
        resp = await c.post("/web_search", json={"query": "q", "resolve_dates": True})
    assert resp.status_code == 200
    assert seen == {}
