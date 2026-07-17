"""Studio artifacts (MIGRATION Phase 2): /studio flashcards | mindmap | podcast.

No network, no Ollama, no weights: a scripted ``generate`` is injected (queued so
"HTML fails → fallback succeeds" is scriptable) and we assert the ported pipeline:
the HTML-first-then-fallback orchestration, chat_structured's schema-priming +
recover_json, the built-in template renderers, and the error contract the Rust
rewiring relies on (502 {code} for engine failures, 422 STUDIO_EMPTY otherwise).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from privateroom_sidecar import llm
from privateroom_sidecar.server import create_app
from privateroom_sidecar.studios import (
    StudioEmpty,
    StudioRequest,
    clean_studio_html,
    recover_json,
    render_flashcards_html,
    render_mindmap_html,
    render_podcast_html,
    run_studio,
    strip_think_spans,
    studio_instruction,
)


# --- scripted model ---------------------------------------------------------


class ScriptedGenerate:
    """An async ``llm.generate`` stand-in that returns queued replies in order and
    records how each call was made (messages, format, temperature, keep_alive)."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self,
        model: str,
        messages: list[dict[str, Any]],
        base_url: str,
        *,
        temperature: float | None = None,
        num_ctx: int | None = None,
        keep_alive: str | None = None,
        format: Any = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> str:
        self.calls.append(
            {
                "model": model,
                "messages": messages,
                "base_url": base_url,
                "temperature": temperature,
                "num_ctx": num_ctx,
                "keep_alive": keep_alive,
                "format": format,
            }
        )
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def _req(kind: str = "flashcards", **kw: Any) -> StudioRequest:
    base: dict[str, Any] = {
        "kind": kind,
        "text": "Photosynthesis converts light to chemical energy.",
        "label": "Biology notes",
        "model": "qwen3.5:9b",
        "base_url": "http://127.0.0.1:11434",
    }
    base.update(kw)
    return StudioRequest(**base)


# --- pure helpers: recover_json / strip_think / clean_studio_html -----------


def test_strip_think_spans() -> None:
    assert strip_think_spans("<think>reasoning</think>answer") == "answer"
    # Unterminated <think> truncates the rest (it's unclosed reasoning).
    assert strip_think_spans("before<think>never closed") == "before"


def test_recover_json_unwraps_fence_and_think() -> None:
    assert recover_json('```json\n{"a":1}\n```') == '{"a":1}'
    assert recover_json('<think>plan</think>\n{"cards":[]}') == '{"cards":[]}'
    assert recover_json('prose {"x":1} trailing') == '{"x":1}'
    # Already-bare JSON is untouched.
    assert recover_json('{"ok":true}') == '{"ok":true}'


def test_clean_studio_html_strips_fence_and_wraps() -> None:
    # A ```html fence despite the schema is stripped.
    fenced = "```html\n<div>" + "x" * 60 + "</div>\n```"
    out = clean_studio_html(fenced)
    assert out is not None and out.startswith("<!doctype html>")
    assert "<div>" in out and "```" not in out


def test_clean_studio_html_passes_full_page_through() -> None:
    page = "<!doctype html><html><body>" + "y" * 60 + "</body></html>"
    assert clean_studio_html(page) == page


def test_clean_studio_html_rejects_non_html_and_too_short() -> None:
    assert clean_studio_html("sorry, I can't do that") is None  # no html-ish tag
    assert clean_studio_html("<div>tiny</div>") is None  # under 60 bytes


def test_studio_instruction_default_vs_supplied() -> None:
    assert studio_instruction(None, "DEF") == "DEF"
    assert studio_instruction("   ", "DEF") == "DEF"  # blank edit falls back
    assert studio_instruction("  do it  ", "DEF") == "do it"


# --- HTML-first authored path -----------------------------------------------


async def test_authored_html_path_single_call() -> None:
    html = "<!doctype html><html><body>" + "deck" * 20 + "</body></html>"
    gen = ScriptedGenerate([f'{{"html": {html!r}}}'.replace("'", '"')])
    result = await run_studio(_req("flashcards"), gen)
    assert result.html == html
    assert result.data == {"kind": "flashcards", "source": "authored", "artifact": None}
    # No fallback: the authored page short-circuits, one model call only.
    assert len(gen.calls) == 1
    # HTML-first call: schema {html}, temperature 0.4, warm keep_alive.
    call = gen.calls[0]
    assert call["format"] == {"type": "object", "properties": {"html": {"type": "string"}}, "required": ["html"]}
    assert call["temperature"] == 0.4
    assert call["keep_alive"] == "30m"


async def test_authored_html_wraps_bare_body() -> None:
    body = "<div>" + "z" * 80 + "</div>"
    gen = ScriptedGenerate(['{"html": ' + f'"{body}"' + "}"])
    result = await run_studio(_req("mindmap"), gen)
    assert result.html.startswith("<!doctype html><html><head>")
    assert body in result.html
    assert result.data["source"] == "authored"


async def test_html_first_user_turn_carries_schema_priming_and_grounding() -> None:
    gen = ScriptedGenerate(["<!doctype html><html><body>" + "q" * 80 + "</body></html>"])
    # Not valid JSON html field -> None -> would fall back; give a valid card set next.
    gen.replies[0] = '{"html":"<html><body>' + "q" * 80 + '</body></html>"}'
    await run_studio(_req("flashcards", label="Cells", text="MATERIAL"), gen)
    user = gen.calls[0]["messages"][1]["content"]
    assert 'Build it only from this material about "Cells":' in user
    assert "MATERIAL" in user
    # chat_structured appends the schema to the last user turn.
    assert "Reply with ONLY JSON matching this schema" in user
    # system prompt = page_role + the self-contained rules.
    system = gen.calls[0]["messages"][0]["content"]
    assert "interactive flashcards study page" in system
    assert "self-contained HTML document" in system


# --- fallback path: flashcards ----------------------------------------------


async def test_fallback_flashcards_renders_template() -> None:
    cards_json = '{"cards":[{"q":"What is ATP?","a":"Energy currency","hint":"cells"},{"q":"Q2","a":"A2"}]}'
    gen = ScriptedGenerate(['{"html":"nope"}', cards_json])  # html unusable -> fallback
    result = await run_studio(_req("flashcards", label="Bio"), gen)
    assert result.data["source"] == "fallback"
    assert result.data["artifact"]["cards"][0] == {"q": "What is ATP?", "a": "Energy currency", "hint": "cells"}
    assert result.html.startswith("<!doctype html>")
    assert "What is ATP?" in result.html and "Energy currency" in result.html
    assert "2 cards" in result.html
    assert "<script" not in result.html  # static, sandbox-safe
    # Two calls: authored then fallback; fallback used the cards schema + temp 0.3.
    assert len(gen.calls) == 2
    assert gen.calls[1]["temperature"] == 0.3
    assert gen.calls[1]["format"]["required"] == ["cards"]
    assert 'Base every card only on this material about "Bio":' in gen.calls[1]["messages"][1]["content"]


async def test_fallback_flashcards_empty_raises_studio_empty() -> None:
    gen = ScriptedGenerate(['{"html":"x"}', '{"cards":[]}'])
    with pytest.raises(StudioEmpty) as exc:
        await run_studio(_req("flashcards"), gen)
    assert exc.value.message == "The model didn't return any usable flashcards — try a different file."


# --- fallback path: mindmap -------------------------------------------------


async def test_fallback_mindmap_renders_tree_and_defaults_root() -> None:
    # root omitted -> defaults to the scope label; a self-cycle must not hang.
    nodes = '{"nodes":[{"label":"Light","parent":""},{"label":"Dark","parent":"Light"},{"label":"Loop","parent":"Loop"}]}'
    gen = ScriptedGenerate(['{"html":"tiny"}', nodes])
    result = await run_studio(_req("mindmap", label="Photosynthesis"), gen)
    assert result.data["source"] == "fallback"
    assert result.data["artifact"]["root"] == "Photosynthesis"
    assert "<summary>Photosynthesis</summary>" in result.html
    assert "Light" in result.html and "Dark" in result.html
    assert "<script" not in result.html
    assert gen.calls[1]["temperature"] == 0.3


async def test_fallback_mindmap_empty_raises() -> None:
    gen = ScriptedGenerate(['{"html":"x"}', '{"root":"R","nodes":[]}'])
    with pytest.raises(StudioEmpty) as exc:
        await run_studio(_req("mindmap"), gen)
    assert exc.value.message == "The model didn't return a usable mind map — try a different file."


# --- fallback path: podcast -------------------------------------------------


async def test_fallback_podcast_audio_note_and_speaker_sides() -> None:
    turns = '{"title":"Ep 1","turns":[{"speaker":"Ada","line":"Welcome."},{"speaker":"Bo","line":"Hi."},{"speaker":"","line":"No name"}]}'
    gen = ScriptedGenerate(['{"html":"x"}', turns])
    result = await run_studio(_req("podcast", label="Show"), gen)
    assert result.data["source"] == "fallback"
    assert "Audio narration is coming in a later version" in result.html
    assert "Ada" in result.html and "Bo" in result.html
    assert "turn b" in result.html  # second distinct speaker lands on side b
    # empty speaker defaults to "Host".
    assert result.data["artifact"]["turns"][2]["speaker"] == "Host"
    assert result.data["artifact"]["title"] == "Ep 1"
    assert gen.calls[1]["temperature"] == 0.5


async def test_fallback_podcast_title_defaults_to_label() -> None:
    gen = ScriptedGenerate(['{"html":"x"}', '{"turns":[{"speaker":"A","line":"hi"}]}'])
    result = await run_studio(_req("podcast", label="My Episode"), gen)
    assert result.data["artifact"]["title"] == "My Episode"
    assert "<h1>My Episode</h1>" in result.html


async def test_fallback_podcast_empty_raises() -> None:
    gen = ScriptedGenerate(['{"html":"x"}', '{"title":"T","turns":[]}'])
    with pytest.raises(StudioEmpty) as exc:
        await run_studio(_req("podcast"), gen)
    assert exc.value.message == "The model didn't return a usable script — try a different file."


# --- fenced fallback reply is still recovered -------------------------------


async def test_fallback_recovers_fenced_json() -> None:
    fenced = '```json\n{"cards":[{"q":"Q","a":"A"}]}\n```'
    gen = ScriptedGenerate(['{"html":"unusable"}', fenced])
    result = await run_studio(_req("flashcards"), gen)
    assert result.data["source"] == "fallback"
    assert result.data["artifact"]["cards"] == [{"q": "Q", "a": "A", "hint": ""}]


# --- renderers escape and stay script-free ----------------------------------


def test_render_flashcards_escapes_and_is_static() -> None:
    html = render_flashcards_html("My <Deck>", [{"q": "<b>?", "a": "</script>x", "hint": "h"}])
    assert "<title>My &lt;Deck&gt; — Flashcards</title>" in html
    assert "&lt;b&gt;?" in html and "&lt;/script&gt;x" in html
    assert "</script>x" not in html
    assert "<script" not in html
    assert "1 card" in html and "Hint: h" in html


def test_render_mindmap_builds_nested_details() -> None:
    nodes = [
        {"label": "Child A", "parent": "Root"},
        {"label": "Grandchild", "parent": "Child A"},
        {"label": "Child B", "parent": ""},  # empty parent -> root
    ]
    html = render_mindmap_html("My Map", "Root", nodes)
    assert "<summary>Root</summary>" in html
    assert "Child A" in html and "Grandchild" in html and "Child B" in html
    assert "<script" not in html


def test_render_podcast_carries_note_and_sides() -> None:
    html = render_podcast_html("Episode 1", [{"speaker": "Ada", "line": "Hi."}, {"speaker": "Bo", "line": "Yo."}])
    assert "Audio narration is coming in a later version" in html
    assert "turn a" in html and "turn b" in html


# --- unknown kind ------------------------------------------------------------


async def test_unknown_kind_raises_studio_empty() -> None:
    gen = ScriptedGenerate([])
    with pytest.raises(StudioEmpty):
        await run_studio(_req("quiz"), gen)


# --- HTTP surface: /studio route + error envelopes --------------------------


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


async def test_http_studio_authored_returns_html_and_data(monkeypatch: pytest.MonkeyPatch) -> None:
    page = "<!doctype html><html><body>" + "w" * 80 + "</body></html>"
    gen = ScriptedGenerate(['{"html":' + f'"{page[:0]}' + page + '"}'])
    gen.replies[0] = '{"html":"' + page.replace('"', "") + '"}'
    monkeypatch.setattr(llm, "generate", gen)
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/studio",
            json={"kind": "flashcards", "text": "T", "label": "L", "model": "m", "base_url": "http://h:1"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == {"kind": "flashcards", "source": "authored", "artifact": None}
    assert body["html"].startswith("<!doctype html>")


async def test_http_studio_empty_is_422(monkeypatch: pytest.MonkeyPatch) -> None:
    gen = ScriptedGenerate(['{"html":"x"}', '{"cards":[]}'])
    monkeypatch.setattr(llm, "generate", gen)
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/studio",
            json={"kind": "flashcards", "text": "T", "label": "L", "model": "m", "base_url": "http://h:1"},
        )
    assert resp.status_code == 422
    body = resp.json()
    assert body["code"] == "STUDIO_EMPTY"
    assert body["error"] == "The model didn't return any usable flashcards — try a different file."


async def test_http_studio_engine_failure_is_502(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*a: Any, **k: Any) -> str:
        raise llm.LlmError("OLLAMA_DOWN", "connection refused")

    monkeypatch.setattr(llm, "generate", boom)
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/studio",
            json={"kind": "mindmap", "text": "T", "label": "L", "model": "m", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"
