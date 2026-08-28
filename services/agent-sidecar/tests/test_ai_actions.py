"""Phase-2 AI actions: /ai_action, /memory_suggestion, /suggest_file_meta,
/generate_ui_text.

No network, no Ollama: a scripted ``ollama.AsyncClient`` is injected (as in
test_llm) and we assert the prompt wiring, the JSON recovery, and the exact
error/degrade behaviour the Rust originals had (an engine failure propagates for
/ai_action but is SWALLOWED for the other three — /generate_ui_text has no Rust
original but degrades to ``null`` by the same design).
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError

from arcelle_sidecar import ai_actions, llm
from arcelle_sidecar.server import create_app

#: The Electron host-side twin of the action table. It owns the menu (title, description,
#: order) and posts `action` + the resolved `instructions`; this module owns the
#: system prompts. `default_prompt` is the one field written out in BOTH, so the
#: last test in this file is what stops the two from drifting.
_HOST = (
    Path(__file__).resolve().parents[3]
    / "apps" / "desktop" / "src" / "main" / "moonshotAiActions.ts"
)


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


def test_catalog_matches_the_electron_host_menu_table() -> None:
    """Adding an action means editing BOTH tables; nothing compared them before.

    The frontend menu is built from the Rust table and every run is dispatched by
    `id` into this one, so a new entry on one side only either offers the user an
    action the engine rejects (UNKNOWN_ACTION) or hides one that works. The
    `default_prompt` wording is compared too — it is sent as `instructions`, so a
    silent edit on one side changes what actually runs while this file still
    documents the old wording.
    """
    src = _HOST.read_text()
    table = re.search(r"const AI_ACTIONS:[^=]+?= \[(.*?)\n\];", src, re.S)
    assert table, "the AI_ACTIONS table moved — update this parity check"
    entries = re.findall(r"\{\n(.*?\n  )\},", table.group(1), re.S)
    assert len(entries) == len(ai_actions.AI_ACTIONS)
    for body, spec in zip(entries, ai_actions.AI_ACTIONS, strict=True):
        text = dict(re.findall(r'(\w+): "(.*?)",', body))
        flags = dict(re.findall(r"(\w+): (true|false),", body))
        assert text["id"] == spec.id
        assert text["scope"] == spec.scope
        assert text["defaultPrompt"] == spec.default_prompt
        assert (flags["needsQuestion"] == "true") is spec.needs_question
        assert (flags["needsLanguage"] == "true") is spec.needs_language


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
    system = fake_client.calls["chat"]["messages"][0]["content"]
    assert "natural, idiomatic terminology" in system
    assert "literal calques" in system


async def test_ai_action_compare_requires_per_file_grounding(
    fake_client: type[FakeAsyncClient],
) -> None:
    fake_client.script["chat"] = _reply('{"markdown": "comparison"}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={
                "model": "m",
                "action": "compare",
                "text": "# report.txt\nbaseline\n# findings.md\nthree records",
                "base_url": "http://h:1",
            },
        )
    assert resp.json() == {"markdown": "comparison"}
    system = fake_client.calls["chat"]["messages"][0]["content"]
    assert "separate fact list for each file heading" in system
    assert "never transfer a fact from one file to another" in system
    assert "Every comparison sentence must name" in system


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


async def test_ai_action_research_without_a_question_errors(fake_client: type[FakeAsyncClient]) -> None:
    # The backstop translate already had: without it the model is told to "answer
    # the question" with no question in the prompt, and invents one.
    fake_client.script["chat"] = RuntimeError("must not be called")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "research", "text": "room text", "base_url": "http://h:1"},
        )
    assert resp.status_code == 400
    assert resp.json() == {"error": "Ask a question first.", "code": "NEEDS_QUESTION"}
    assert "chat" not in fake_client.calls  # no model call


async def test_ai_action_caps_output_tokens(fake_client: type[FakeAsyncClient]) -> None:
    # A runaway guard, not a quality limit: Rust clamps the gathered material to
    # ~12 KB, so a real action lands far below this — but an uncapped degenerate
    # repetition loop on a small local model fills the whole (payload-fitted,
    # up to 128k) window and the menu just appears to hang.
    fake_client.script["chat"] = _reply('{"markdown": "ok"}')
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/ai_action",
            json={"model": "m", "action": "translate", "text": "t", "question": "French", "base_url": "http://h:1"},
        )
    assert fake_client.calls["chat"]["options"]["num_predict"] == ai_actions.ACTION_PREDICT


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


async def test_ai_action_room_scope_empty_result_does_not_blame_a_file(
    fake_client: type[FakeAsyncClient],
) -> None:
    # compare/timeline/themes/gaps/research read the WHOLE room, so "try a
    # different file" sent the user hunting for a file that does not exist.
    fake_client.script["chat"] = _reply('{"markdown": ""}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/ai_action",
            json={"model": "m", "action": "themes", "text": "t", "base_url": "http://h:1"},
        )
    assert resp.status_code == 422
    assert resp.json() == {
        "error": "The model didn't return anything usable — try again, or add more material to this room.",
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


# --- /generate_ui_text -------------------------------------------------------
#
# The generic adaptive-UI-text pipe: NO baked-in prompt (the caller supplies the
# whole `prompt`), and `null` is always a 200 -- never an error -- whether the
# cause is an engine failure or one of the three post-generation validations.

_FACTS = {"count": 3, "size_mb": 110}
_UI_PROMPT = (
    "Write one sentence, max 20 words, describing this Recordings area using "
    "these facts: 3 recordings, all transcribed, largest is Wall Street Analyst at 110MB."
)


def _ui_text_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": "m",
        "kind": "dek",
        "prompt": _UI_PROMPT,
        "facts": _FACTS,
        "max_words": 20,
        "base_url": "http://h:1",
    }
    body.update(overrides)
    return body


async def test_generate_ui_text_happy_path(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"text": "3 recordings, all transcribed, largest 110MB."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    assert resp.status_code == 200
    assert resp.json() == {"text": "3 recordings, all transcribed, largest 110MB."}
    # low temperature, token budget ~= max_words * 2, the {text} grammar, and the
    # short one-shot keep_alive (this is a quick shaping call, not a chat turn).
    assert fake_client.calls["chat"]["options"]["temperature"] == 0.3
    assert fake_client.calls["chat"]["options"]["num_predict"] == 40
    assert fake_client.calls["chat"]["keep_alive"] == "2m"
    assert fake_client.calls["chat"]["format"] == {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }


async def test_generate_ui_text_sends_only_the_caller_prompt(fake_client: type[FakeAsyncClient]) -> None:
    # facts are for the numeral guard ONLY -- never folded into the model call as
    # a separate payload, since the caller already composed them into `prompt`.
    fake_client.script["chat"] = _reply('{"text": "3 recordings, all transcribed, largest 110MB."}')
    app = create_app()
    async with client_for(app) as c:
        await c.post("/generate_ui_text", json=_ui_text_body())
    sent = fake_client.calls["chat"]["messages"]
    assert len(sent) == 1
    assert sent[0]["role"] == "user"
    assert sent[0]["content"].startswith(_UI_PROMPT)
    assert "size_mb" not in sent[0]["content"]  # facts JSON never appears verbatim


async def test_generate_ui_text_llm_error_degrades_to_null(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    # Never a 500/502 -- an unavailable model renders as "no generated text".
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_model_missing_degrades_to_null(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body(model="x"))
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_empty_reply_degrades_to_null(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _reply('{"text": "   "}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_overlong_reply_degrades_to_null(fake_client: type[FakeAsyncClient]) -> None:
    # max_words=5 -> the 1.3x slack allows at most 7 words (ceil(5*1.3)); this
    # reply has 8.
    rambling = "This is a rather long winded sentence indeed"
    assert len(rambling.split()) == 8
    fake_client.script["chat"] = _reply(f'{{"text": "{rambling}"}}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body(max_words=5))
    # better nothing than a result that overflows its UI slot
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_numeral_guard_rejects_a_fabricated_number(
    fake_client: type[FakeAsyncClient],
) -> None:
    # 5 never appears anywhere in `facts` ({"count": 3, "size_mb": 110}).
    fake_client.script["chat"] = _reply('{"text": "There are 5 recordings in this area."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_numeral_guard_accepts_a_real_number(
    fake_client: type[FakeAsyncClient],
) -> None:
    # 3 and 110 both appear in `facts` -- the model didn't invent anything.
    fake_client.script["chat"] = _reply('{"text": "3 recordings, largest 110MB, all transcribed."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    assert resp.status_code == 200
    assert resp.json() == {"text": "3 recordings, largest 110MB, all transcribed."}


async def test_generate_ui_text_prompt_instructs_digits_not_words(
    fake_client: type[FakeAsyncClient],
) -> None:
    # A real local model very often spells small numbers out in ordinary prose
    # ("Twelve recordings...") rather than using digits, which puts them past a
    # digit-only guard entirely -- so every caller's prompt gets this nudge.
    fake_client.script["chat"] = _reply('{"text": "3 recordings, largest 110MB, all transcribed."}')
    app = create_app()
    async with client_for(app) as c:
        await c.post("/generate_ui_text", json=_ui_text_body())
    sent = fake_client.calls["chat"]["messages"][0]["content"]
    assert 'Write every number as a digit (e.g. "3", not "three")' in sent
    # still the caller's own prompt first -- the instruction is appended, not prepended.
    assert sent.startswith(_UI_PROMPT)


async def test_generate_ui_text_numeral_guard_rejects_a_spelled_out_fabrication(
    fake_client: type[FakeAsyncClient],
) -> None:
    # A real qwen3.5:4b-mlx reply to a leading, ungrounded prompt: no digit at
    # all, so the digit-only guard (bug 1) sailed this straight through
    # undetected before the word guard existed. "fifteen" never appears
    # anywhere in `facts` ({"count": 3, "size_mb": 110}).
    fake_client.script["chat"] = _reply('{"text": "The room holds fifteen files."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/generate_ui_text", json=_ui_text_body())
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_numeral_guard_accepts_a_real_number_word(
    fake_client: type[FakeAsyncClient],
) -> None:
    # The fact itself says "three" (not just the digit 3) -- a spelled-out
    # restatement of THAT word must not be a false-positive rejection.
    fake_client.script["chat"] = _reply('{"text": "There are three recordings in this area."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_ui_text",
            json=_ui_text_body(facts={"count": 3, "count_word": "three"}),
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "There are three recordings in this area."}


async def test_generate_ui_text_numeral_guard_word_match_is_whole_word_only(
    fake_client: type[FakeAsyncClient],
) -> None:
    # "seventeen" contains "seven" but is not it -- a substring match would
    # wrongly wave a fabricated "seven" through because "seventeen" appears in
    # the facts text; whole-word matching must catch this.
    fake_client.script["chat"] = _reply('{"text": "There are seven recordings here."}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_ui_text",
            json=_ui_text_body(facts={"note": "seventeen files archived"}),
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": None}


async def test_generate_ui_text_num_predict_floor_for_small_max_words(
    fake_client: type[FakeAsyncClient],
) -> None:
    # Bug 2: max_words=4 -> max_words*2 = 8, too tight once the {"text": "..."}
    # JSON-schema wrapping is included -- a real model's reply got cut off
    # mid-string a measurable fraction of the time. A floor of 24 applies.
    fake_client.script["chat"] = _reply('{"text": "Stock Metrics"}')
    app = create_app()
    async with client_for(app) as c:
        await c.post("/generate_ui_text", json=_ui_text_body(max_words=4))
    assert fake_client.calls["chat"]["options"]["num_predict"] == 24


async def test_generate_ui_text_num_predict_floor_does_not_lower_large_budgets(
    fake_client: type[FakeAsyncClient],
) -> None:
    # The floor only ever RAISES a too-tight budget -- max_words=20 already
    # clears it (20*2 = 40), so it must pass through unchanged.
    fake_client.script["chat"] = _reply('{"text": "3 recordings, largest 110MB, all transcribed."}')
    app = create_app()
    async with client_for(app) as c:
        await c.post("/generate_ui_text", json=_ui_text_body(max_words=20))
    assert fake_client.calls["chat"]["options"]["num_predict"] == 40
