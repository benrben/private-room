"""Phase-2 feature endpoints (feature logic → Python): /label, /feedback_draft.

No network, no Ollama, no weights: the same scripted ``ollama.AsyncClient`` the
gateway tests use is injected, and we assert the wire behaviour and the exact
prompt/schema/parsing ported from front_page.rs and feedback.rs.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError

from arcelle_sidecar import features, llm
from arcelle_sidecar.server import create_app


# --- fakes (mirrors test_llm.py) --------------------------------------------


class FakeAsyncClient:
    """A scripted ollama AsyncClient recording how ``chat`` was called."""

    script: dict[str, Any] = {}
    calls: dict[str, Any] = {}

    def __init__(self, host: str = "") -> None:
        type(self).calls["host"] = host

    async def chat(self, **kwargs: Any) -> Any:
        type(self).calls["chat"] = kwargs
        val = type(self).script.get("chat")
        if isinstance(val, Exception):
            raise val
        return val


@pytest.fixture(autouse=True)
def fake_client(monkeypatch: pytest.MonkeyPatch) -> type[FakeAsyncClient]:
    FakeAsyncClient.script = {}
    FakeAsyncClient.calls = {}
    # llm.py holds a module-level reference; chat.generate does `from ollama
    # import AsyncClient` at call time — patch both sites.
    monkeypatch.setattr(llm, "AsyncClient", FakeAsyncClient)
    import ollama

    monkeypatch.setattr(ollama, "AsyncClient", FakeAsyncClient)
    return FakeAsyncClient


def _chat_reply(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


# --- /label (front_page.rs front_page_suggestions) --------------------------


async def test_label_returns_questions_and_sends_the_prompt(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply(json.dumps({"questions": ["What's the rent?", "When is it due?"]}))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/label",
            json={"model": "qwen3.5:9b", "base_url": "http://h:1", "room_name": "Lease", "files": ["lease.pdf", "rules.md"]},
        )
    assert resp.status_code == 200
    assert resp.json() == {"questions": ["What's the rent?", "When is it due?"]}
    call = fake_client.calls["chat"]
    # The exact ported prompt: system verbatim, user carries room name + files.
    assert call["messages"][0]["role"] == "system"
    assert "up to three short, specific questions" in call["messages"][0]["content"]
    assert call["messages"][1]["content"] == "Room name: Lease\n\nFiles:\nlease.pdf\nrules.md"
    # Ported model params: temp 0.4, WARM keep_alive, the questions schema.
    assert call["options"]["temperature"] == 0.4
    assert call["keep_alive"] == "30m"
    assert call["format"] == {
        "type": "object",
        "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
        "required": ["questions"],
    }
    assert fake_client.calls["host"] == "http://h:1"


async def test_label_drops_blanks_and_caps_at_three(fake_client: type[FakeAsyncClient]) -> None:
    # front_page.rs: filter empty-after-trim, keep the first three, survivors verbatim.
    fake_client.script["chat"] = _chat_reply(
        json.dumps({"questions": ["  ", "one", "", "two", "three", "four"]})
    )
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/label", json={"model": "m", "base_url": "http://h:1", "files": ["a"]})
    assert resp.json() == {"questions": ["one", "two", "three"]}


async def test_label_unparseable_reply_yields_empty(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("not json at all")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/label", json={"model": "m", "base_url": "http://h:1", "files": ["a"]})
    assert resp.status_code == 200
    assert resp.json() == {"questions": []}


async def test_label_swallows_engine_failure_to_empty(fake_client: type[FakeAsyncClient]) -> None:
    # front_page.rs unwrap_or_default(): any engine failure -> no suggestions, so
    # the Rust caller falls back to its cached list. No 5xx leaks out.
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/label", json={"model": "m", "base_url": "http://h:1", "files": ["a"]})
    assert resp.status_code == 200
    assert resp.json() == {"questions": []}


async def test_label_model_missing_also_swallowed(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/label", json={"model": "x", "base_url": "http://h:1", "files": ["a"]})
    assert resp.status_code == 200
    assert resp.json() == {"questions": []}


# --- /feedback_draft (feedback.rs feedback_draft) ---------------------------


async def test_feedback_draft_shapes_title_and_body(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply(
        json.dumps({"title": "Export button does nothing", "body": "## What happened\n\nClicking Export is a no-op."})
    )
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/feedback_draft",
            json={"model": "qwen3.5:9b", "base_url": "http://h:1", "text": "the export button doesnt work"},
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "title": "Export button does nothing",
        "body": "## What happened\n\nClicking Export is a no-op.",
    }
    call = fake_client.calls["chat"]
    assert "turn a user's raw feedback" in call["messages"][0]["content"]
    assert call["messages"][1]["content"] == "the export button doesnt work"
    # Ported model params: temp 0.3, SHORT keep_alive, the {title,body} schema.
    assert call["options"]["temperature"] == 0.3
    assert call["keep_alive"] == "2m"
    assert call["format"]["required"] == ["title", "body"]


async def test_feedback_draft_trims_and_requires_both_fields(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply(json.dumps({"title": "  Padded  ", "body": "  A body.  "}))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": "x"})
    assert resp.json() == {"title": "Padded", "body": "A body."}


async def test_feedback_draft_falls_back_when_a_field_is_missing(fake_client: type[FakeAsyncClient]) -> None:
    # Body empty -> not usable -> the fallback keeps the user's words.
    fake_client.script["chat"] = _chat_reply(json.dumps({"title": "Nice title", "body": "   "}))
    app = create_app()
    text = "First line here\nsecond line"
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": text})
    assert resp.json() == {"title": "First line here", "body": f"## What happened\n\n{text}"}


async def test_feedback_draft_falls_back_on_unparseable_reply(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("garbage, not json")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": "the thing broke"})
    assert resp.json() == {"title": "the thing broke", "body": "## What happened\n\nthe thing broke"}


async def test_feedback_fallback_title_is_capped_at_70_chars(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("not json")
    long = "z" * 200
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": long})
    body = resp.json()
    assert body["title"] == "z" * 70  # feedback.rs: first line, take(70)
    assert body["body"] == f"## What happened\n\n{long}"


async def test_feedback_parsed_title_is_capped_at_120_chars(fake_client: type[FakeAsyncClient]) -> None:
    # A parsed (non-fallback) title is capped at 120 — the final .chars().take(120).
    fake_client.script["chat"] = _chat_reply(json.dumps({"title": "t" * 200, "body": "b"}))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": "x"})
    assert resp.json()["title"] == "t" * 120


async def test_feedback_draft_surfaces_engine_failure(fake_client: type[FakeAsyncClient]) -> None:
    # feedback.rs uses `?`: an engine failure is surfaced, not swallowed.
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "m", "base_url": "http://h:1", "text": "x"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


async def test_feedback_draft_model_missing_surfaces_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/feedback_draft", json={"model": "x", "base_url": "http://h:1", "text": "x"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


# --- direct unit coverage of the ported parsers -----------------------------


def test_parse_questions_matches_rust_filter() -> None:
    assert features._parse_questions(json.dumps({"questions": ["a", " ", "b"]})) == ["a", "b"]
    assert features._parse_questions('{"questions": "not a list"}') == []
    assert features._parse_questions("[]") == []  # not an object
    assert features._parse_questions("nonsense") == []


def test_parse_or_fallback_matches_rust() -> None:
    assert features._parse_or_fallback(json.dumps({"title": "T", "body": "B"}), "raw") == ("T", "B")
    # Missing body -> fallback to first line + What happened.
    assert features._parse_or_fallback('{"title": "T"}', "line one\nline two") == (
        "line one",
        "## What happened\n\nline one\nline two",
    )
    # A \r\n line ending is stripped like Rust str::lines().
    assert features._parse_or_fallback("x", "carriage\r\nreturn")[0] == "carriage"
