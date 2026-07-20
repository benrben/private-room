"""Phase-2 AI actions: /ai_action, /memory_suggestion, /suggest_file_meta.

No network, no Ollama: a scripted ``ollama.AsyncClient`` is injected (as in
test_llm) and we assert the prompt wiring, the JSON recovery, and the exact
error/degrade behaviour the Rust originals had (an engine failure propagates for
/ai_action but is SWALLOWED for the other two).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError

from arcelle_sidecar import ai_actions, llm
from arcelle_sidecar.server import create_app


# --- fakes (same shape as test_llm) -----------------------------------------


class FakeAsyncClient:
    script: dict[str, Any] = {}
    calls: dict[str, Any] = {}

    def __init__(self, host: str = "") -> None:
        type(self).calls["host"] = host

    def _run(self, name: str, **kwargs: Any) -> Any:
        type(self).calls[name] = kwargs
        val = type(self).script.get(name)
        if isinstance(val, Exception):
            raise val
        return val

    async def chat(self, **kwargs: Any) -> Any:
        return self._run("chat", **kwargs)


@pytest.fixture(autouse=True)
def fake_client(monkeypatch: pytest.MonkeyPatch) -> type[FakeAsyncClient]:
    FakeAsyncClient.script = {}
    FakeAsyncClient.calls = {}
    monkeypatch.setattr(llm, "AsyncClient", FakeAsyncClient)
    import ollama

    monkeypatch.setattr(ollama, "AsyncClient", FakeAsyncClient)
    return FakeAsyncClient


def _reply(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


# --- the action catalog is faithful to the Rust table -----------------------


def test_catalog_is_the_fourteen_actions_in_menu_order() -> None:
    ids = [a.id for a in ai_actions.AI_ACTIONS]
    assert ids == [
        "summarize", "analyze", "explain", "extract", "outline", "rewrite",
        "qa_pack", "fact_check", "translate",  # file scope (9)
        "research", "compare", "timeline", "themes", "gaps",  # room scope (5)
    ]
    for a in ai_actions.AI_ACTIONS[:9]:
        assert a.scope == "file"
    for a in ai_actions.AI_ACTIONS[9:]:
        assert a.scope == "room"
    # Only research needs a question; only translate needs a language.
    for a in ai_actions.AI_ACTIONS:
        assert a.needs_question == (a.id == "research")
        assert a.needs_language == (a.id == "translate")
        assert a.default_prompt.strip()
        assert a.system.strip()


# --- /ai_action -------------------------------------------------------------


async def test_ai_action_builds_prompt_and_returns_markdown(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "# TL;DR\\n- a\\n- b"}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "qwen3.5:9b", "action": "summarize", "text": "the material", "base_url": "http://h:1"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"markdown": "# TL;DR\n- a\n- b"}
    sent = fake_client.calls["chat"]["messages"]
    # system prompt is the summarize action's, user grounds in the material with
    # the default prompt (no instructions override).
    assert sent[0]["role"] == "system"
    assert "single tight TL;DR line" in sent[0]["content"]
    assert sent[1]["role"] == "user"
    assert sent[1]["content"].startswith(
        "Summarize this material: a one-line TL;DR, then the key points as a short list."
    )
    assert "Base everything only on this material:\n\nthe material" in sent[1]["content"]
    # chat_structured primes the schema onto the last user turn (grammar alone
    # leaves the field name unseen, so a small model fills it with "").
    assert sent[1]["content"].endswith(
        '\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n'
        '{"type":"object","properties":{"markdown":{"type":"string"}},"required":["markdown"]}'
    )
    # temperature 0.3, keep_alive warm, the markdown grammar.
    assert fake_client.calls["chat"]["options"]["temperature"] == 0.3
    assert fake_client.calls["chat"]["keep_alive"] == "30m"
    assert fake_client.calls["chat"]["format"] == {
        "type": "object",
        "properties": {"markdown": {"type": "string"}},
        "required": ["markdown"],
    }


async def test_ai_action_instructions_override_default_prompt(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "x"}')
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/ai_action",
            json={
                "model": "m",
                "action": "outline",
                "text": "t",
                "instructions": "  Make it terse  ",
                "base_url": "http://h:1",
            },
        )
    user = fake_client.calls["chat"]["messages"][1]["content"]
    # trimmed override wins over the action default.
    assert user.startswith("Make it terse\n\n")
    assert "Turn this material into a clean" not in user


async def test_ai_action_research_folds_in_the_question(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "answer"}')
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/ai_action",
            json={
                "model": "m",
                "action": "research",
                "text": "room text",
                "question": "  What is the budget?  ",
                "base_url": "http://h:1",
            },
        )
    user = fake_client.calls["chat"]["messages"][1]["content"]
    assert "\n\nQuestion: What is the budget?\n\n" in user


async def test_ai_action_translate_uses_target_language(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "traduction"}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "translate", "text": "t", "question": "French", "base_url": "http://h:1"},
        )
    assert resp.json() == {"markdown": "traduction"}
    user = fake_client.calls["chat"]["messages"][1]["content"]
    assert "\n\nTarget language: French\n\n" in user


async def test_ai_action_translate_without_language_errors(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = RuntimeError("must not be called")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "translate", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.status_code == 400
    assert resp.json() == {"error": "Pick a target language first.", "code": "NEEDS_LANGUAGE"}
    assert "chat" not in fake_client.calls  # no model call


async def test_ai_action_unknown_action_errors(fake_client: type[FakeAsyncClient]) -> None:
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/ai_action", json={"model": "m", "action": "nope", "text": "t", "base_url": "http://h:1"})
    assert resp.status_code == 400
    assert resp.json() == {"error": '"nope" isn\'t a known AI action.', "code": "UNKNOWN_ACTION"}


async def test_ai_action_empty_markdown_is_nothing_usable(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "   "}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "summarize", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.status_code == 422
    assert resp.json() == {
        "error": "The model didn't return anything usable — try a different file.",
        "code": "EMPTY_RESULT",
    }


async def test_ai_action_recovers_fenced_and_thinking_json(fake_client: type[FakeAsyncClient]) -> None:
    # A :cloud model ignores `format` and fence-wraps with a <think> preamble.
    fake_client.script["chat"] = _reply('<think>reasoning</think>\n```json\n{"markdown": "clean"}\n```')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "analyze", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.json() == {"markdown": "clean"}


async def test_ai_action_propagates_engine_failure(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "summarize", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


async def test_ai_action_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "x", "action": "summarize", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


# --- /memory_suggestion -----------------------------------------------------


async def test_memory_suggestion_worth_when_flagged_with_fact(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"worth_remembering": true, "fact": "Ben prefers dark mode."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/memory_suggestion",
            json={"model": "m", "user_text": "I like dark mode", "assistant_text": "Noted.", "base_url": "http://h:1"},
        )
    assert resp.json() == {"worth": True, "fact": "Ben prefers dark mode."}
    # temperature 0.2 and the exchange prompt shape.
    assert fake_client.calls["chat"]["options"]["temperature"] == 0.2
    user = fake_client.calls["chat"]["messages"][1]["content"]
    assert user.startswith("User asked:\nI like dark mode\n\nAssistant answered:\nNoted.")
    # chat_structured primes the schema onto the last user turn.
    assert "Reply with ONLY JSON matching this schema" in user
    assert '"worth_remembering"' in user


async def test_memory_suggestion_flagged_but_empty_fact_is_not_worth(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"worth_remembering": true, "fact": "  "}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/memory_suggestion",
            json={"model": "m", "user_text": "u", "assistant_text": "a", "base_url": "http://h:1"},
        )
    # worth requires BOTH the flag and a non-empty fact.
    assert resp.json() == {"worth": False, "fact": ""}


async def test_memory_suggestion_swallows_engine_failure(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/memory_suggestion",
            json={"model": "m", "user_text": "u", "assistant_text": "a", "base_url": "http://h:1"},
        )
    # Rust unwrap_or_default(): a model failure is "not worth", never an error.
    assert resp.status_code == 200
    assert resp.json() == {"worth": False, "fact": ""}


# --- /suggest_file_meta -----------------------------------------------------


async def test_suggest_file_meta_returns_title_folder_tags(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply(
        '{"title": "Q3 Budget", "folder": "Finance", "tags": ["Budget", "Q3", "  ", "FINANCE"]}'
    )
    long_text = "x" * 200
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/suggest_file_meta",
            json={"model": "m", "current_name": "doc.pdf", "text": long_text, "base_url": "http://h:1"},
        )
    # tags lowercased, blanks dropped, capped at five.
    assert resp.json() == {"title": "Q3 Budget", "folder": "Finance", "tags": ["budget", "q3", "finance"]}
    assert fake_client.calls["chat"]["options"]["temperature"] == 0.3


async def test_suggest_file_meta_caps_tags_at_five(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"title": "T", "folder": "F", "tags": ["a", "b", "c", "d", "e", "f", "g"]}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/suggest_file_meta",
            json={"model": "m", "current_name": "x.md", "text": "y" * 200, "base_url": "http://h:1"},
        )
    assert resp.json()["tags"] == ["a", "b", "c", "d", "e"]


async def test_suggest_file_meta_short_text_echoes_without_a_model_call(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = RuntimeError("must not be called")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/suggest_file_meta",
            json={"model": "m", "current_name": "Report.pdf", "text": "too short", "base_url": "http://h:1"},
        )
    # <80 chars -> echo (title from name, no folder, no tags), no model call.
    assert resp.json() == {"title": "Report", "folder": "", "tags": []}
    assert "chat" not in fake_client.calls


async def test_suggest_file_meta_empty_title_falls_back_to_name(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"title": "", "folder": "", "tags": []}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/suggest_file_meta",
            json={"model": "m", "current_name": "Meeting Notes.md", "text": "z" * 200, "base_url": "http://h:1"},
        )
    assert resp.json() == {"title": "Meeting Notes", "folder": "", "tags": []}


async def test_suggest_file_meta_swallows_engine_failure_to_echo(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/suggest_file_meta",
            json={"model": "x", "current_name": "data.csv", "text": "w" * 200, "base_url": "http://h:1"},
        )
    # Rust unwrap_or_default(): a model failure degrades to the echo, not an error.
    assert resp.status_code == 200
    assert resp.json() == {"title": "data", "folder": "", "tags": []}
