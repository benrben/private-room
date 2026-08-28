"""Phase-2 chat_commands logic: /knowledge_extract, /generate_doc.

No network, no Ollama, no weights: the same scripted ``ollama.AsyncClient`` the
gateway tests use is injected. We assert (a) the prompts + schema are reproduced
byte for byte from knowledge.rs / docs_html.rs, (b) chat_structured's schema-in-
prompt priming and recover_json are applied to the two structured calls but NOT to
the plain doc-body call, (c) the parse reproductions (parse_string_list / value_str
/ "(not found)"), and (d) the OLLAMA_DOWN / MODEL_MISSING error contract.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError

from arcelle_sidecar import chat_docs, llm, model_text
from arcelle_sidecar.server import create_app


# --- fakes (shared shape with test_llm.py) ----------------------------------


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
    # llm.generate -> OllamaChatModel.generate does `from ollama import AsyncClient`
    # at call time; patch that site.
    import ollama

    monkeypatch.setattr(ollama, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(llm, "AsyncClient", FakeAsyncClient)
    return FakeAsyncClient


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


def _chat_reply(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


# --- /knowledge_extract mode="fields" (cmd_extract) -------------------------


async def test_extract_fields_prompt_schema_and_priming(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply('{"revenue":"$5M","CEO":"Ada Lovelace"}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "llama3.2",
                "base_url": "http://h:1",
                "mode": "fields",
                "fields": ["revenue", "CEO"],
                "document": "ACME earned $5M. CEO: Ada Lovelace.",
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"values": {"revenue": "$5M", "CEO": "Ada Lovelace"}}

    call = fake_client.calls["chat"]
    sent = call["messages"]
    # system verbatim from knowledge.rs.
    assert sent[0]["role"] == "system"
    assert sent[0]["content"] == (
        "You extract specific fields from a document. Fill each field with its value "
        'copied from the document, or "(not found)" if it is absent.'
    )
    # user: "Fields:\n<lines>\n\nDocument:\n<doc>" then the schema-in-prompt primer.
    user = sent[1]["content"]
    assert user.startswith("Fields:\nrevenue\nCEO\n\nDocument:\nACME earned $5M. CEO: Ada Lovelace.")
    assert "\n\nReply with ONLY JSON matching this schema" in user
    # the forced grammar: one string prop per field, all required.
    assert call["format"] == {
        "type": "object",
        "properties": {"revenue": {"type": "string"}, "CEO": {"type": "string"}},
        "required": ["revenue", "CEO"],
    }
    # 2026-07-23: local calls always request a payload-fitted window — the
    # daemon's own ~4k default context-shifts big documents into garbage.
    assert call["options"]["num_ctx"] == 8_192
    assert call["options"]["temperature"] == 0.0
    assert call["keep_alive"] == "30m"


async def test_extract_missing_field_becomes_not_found(fake_client: type[FakeAsyncClient]) -> None:
    # cmd_extract: an absent/blank field is "(not found)".
    fake_client.script["chat"] = _chat_reply('{"revenue":"$5M","CEO":"  "}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["revenue", "CEO", "HQ"], "document": "d"},
        )
    assert resp.json()["values"] == {"revenue": "$5M", "CEO": "(not found)", "HQ": "(not found)"}


async def test_extract_unreadable_reply_is_an_error_not_all_not_found(
    fake_client: type[FakeAsyncClient],
) -> None:
    # An unreadable answer used to parse to {} and fill every column with
    # "(not found)" — indistinguishable from a file that was searched and really
    # doesn't hold the field. It is reported instead, so knowledge.rs's
    # `note_unread()` branch runs and a later window can still answer.
    fake_client.script["chat"] = _chat_reply("sorry, I couldn't read that")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["a", "b"], "document": "d"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "UNREADABLE_REPLY"


async def test_extract_non_object_json_is_also_unreadable(fake_client: type[FakeAsyncClient]) -> None:
    # A JSON ARRAY parses fine but has no field keys, so it produced the same
    # all-"(not found)" row as garbage. It is just as unread.
    fake_client.script["chat"] = _chat_reply('["a", "b"]')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["a", "b"], "document": "d"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "UNREADABLE_REPLY"


async def test_extract_empty_object_is_still_a_real_not_found(fake_client: type[FakeAsyncClient]) -> None:
    # "{}" IS a readable answer — the model looked and found nothing.
    fake_client.script["chat"] = _chat_reply("{}")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["a", "b"], "document": "d"},
        )
    assert resp.json()["values"] == {"a": "(not found)", "b": "(not found)"}


async def test_extract_recovers_fenced_json(fake_client: type[FakeAsyncClient]) -> None:
    # recover_json unwraps a cloud model's ```json fence / <think> preamble.
    fake_client.script["chat"] = _chat_reply("<think>hmm</think>```json\n{\"a\":\"x\"}\n```")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["a"], "document": "d"},
        )
    assert resp.json()["values"] == {"a": "x"}


async def test_extract_preserves_requested_field_order(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply('{"b":"2","a":"1"}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "fields": ["a", "b"], "document": "d"},
        )
    # keyed + ordered by the REQUESTED fields, not the model's reply order.
    assert list(resp.json()["values"].keys()) == ["a", "b"]


# --- /knowledge_extract mode="list" (cmd_add_file "for each") ----------------


async def test_list_mode_parses_json_array(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply('["AAPL","MSFT","NVDA"]')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "m",
                "base_url": "http://h:1",
                "mode": "list",
                "subject": "tickers",
                "conversation": "I like AAPL, MSFT and NVDA.",
            },
        )
    assert resp.json() == {"items": ["AAPL", "MSFT", "NVDA"]}
    sent = fake_client.calls["chat"]["messages"]
    assert sent[0]["content"] == "You extract a list of short names from a conversation."
    assert sent[1]["content"].startswith(
        "From the conversation below, list EVERY one of the tickers as short names. "
        "If there are none, return an empty array.\n\nConversation:\nI like AAPL, MSFT and NVDA."
    )
    # list mode is structured too: array grammar + priming.
    assert fake_client.calls["chat"]["format"] == {"type": "array", "items": {"type": "string"}}
    assert "Reply with ONLY JSON matching this schema" in sent[1]["content"]


async def test_list_mode_prose_fallback_dedups(fake_client: type[FakeAsyncClient]) -> None:
    # parse_string_list falls back to bullet/line splitting, deduped case-insensitively.
    fake_client.script["chat"] = _chat_reply("1. Apple\n2. apple\n- Microsoft")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "mode": "list", "subject": "x", "conversation": "y"},
        )
    assert resp.json() == {"items": ["Apple", "Microsoft"]}


async def test_list_mode_empty_array_reproduces_rust_quirk(fake_client: type[FakeAsyncClient]) -> None:
    # FAITHFULNESS: docs_html.rs parse_string_list falls back to line-splitting
    # when the JSON array parses EMPTY, so a bare "[]" reply yields ["[]"] — NOT
    # []. Verified against the real Rust (cargo run). Reproduced deliberately so
    # cmd_add_file's downstream behavior is byte-identical; this is a latent Rust
    # quirk to fix in the Rust rewiring, not here.
    fake_client.script["chat"] = _chat_reply("[]")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "m", "base_url": "http://h:1", "mode": "list", "subject": "x", "conversation": "y"},
        )
    assert resp.json() == {"items": ["[]"]}


# --- /generate_doc (cmd_add_file DOC_SYS body) ------------------------------


async def test_generate_doc_single_prompt(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("<p>About widgets.</p><h2>Details</h2>")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_doc",
            json={
                "model": "m",
                "base_url": "http://h:1",
                "mode": "single",
                "topic": "widgets",
                "context": "Reference:\nWidgets are round.\n\n",
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "<p>About widgets.</p><h2>Details</h2>"}
    call = fake_client.calls["chat"]
    sent = call["messages"]
    assert sent[0]["content"] == chat_docs.DOC_SYS
    # context is prepended verbatim, then the topic line.
    assert sent[1]["content"] == "Reference:\nWidgets are round.\n\nWrite a well-structured document about: widgets"
    # PLAIN turn: no format (grammar), no schema priming.
    assert call["format"] is None
    assert "Reply with ONLY JSON matching this schema" not in sent[1]["content"]
    assert call["options"]["temperature"] == 0.4
    # 2026-07-23: payload-fitted window on every local call (see test above).
    assert call["options"]["num_ctx"] == 8_192


async def test_generate_doc_each_prompt(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("<p>AAPL note.</p>")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_doc",
            json={
                "model": "m",
                "base_url": "http://h:1",
                "mode": "each",
                "item": "AAPL",
                "history": "[user]\nMake a file per ticker.",
            },
        )
    assert resp.json() == {"text": "<p>AAPL note.</p>"}
    sent = fake_client.calls["chat"]["messages"]
    assert sent[0]["content"] == chat_docs.DOC_SYS
    assert sent[1]["content"] == (
        'Write a concise, useful note about "AAPL", grounded in this conversation '
        "where relevant:\n\n[user]\nMake a file per ticker."
    )


async def test_generate_doc_defaults_to_single(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("<p>x</p>")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_doc",
            json={"model": "m", "base_url": "http://h:1", "topic": "cats", "context": ""},
        )
    assert resp.json() == {"text": "<p>x</p>"}
    # empty context: the topic line stands alone.
    assert fake_client.calls["chat"]["messages"][1]["content"] == "Write a well-structured document about: cats"


# --- error contract (shared with the gateway) -------------------------------


async def test_extract_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={"model": "x", "base_url": "http://h:1", "fields": ["a"], "document": "d"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_generate_doc_engine_down_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_doc",
            json={"model": "m", "base_url": "http://h:1", "topic": "t"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


# --- unit-level reproductions (docs_html.rs / json.rs) ----------------------


def test_parse_string_list_matches_rust() -> None:
    # JSON array wins even with leading prose.
    assert chat_docs.parse_string_list('Sure: ["AAPL", "MSFT", "NVDA"]') == ["AAPL", "MSFT", "NVDA"]
    # line/bullet fallback, case-insensitive dedup.
    assert chat_docs.parse_string_list("1. Apple\n2. apple\n- Microsoft") == ["Apple", "Microsoft"]
    # <think> stripped before parsing.
    assert chat_docs.parse_string_list("<think>reasoning</think>[\"X\"]") == ["X"]
    # Uncapped: "for each" writes a file per item, so a 20-item list stays 20.
    big = json.dumps([f"n{i}" for i in range(20)])
    assert len(chat_docs.parse_string_list(big)) == 20


def test_value_str_matches_rust() -> None:
    parsed = {"a": "  x  ", "n": 3, "empty": "   "}
    assert chat_docs.value_str(parsed, "a") == "x"
    assert chat_docs.value_str(parsed, "n") == ""  # non-string -> ""
    assert chat_docs.value_str(parsed, "empty") == ""
    assert chat_docs.value_str(parsed, "missing") == ""
    assert chat_docs.value_str(["not", "an", "object"], "a") == ""


def test_recover_json_slices_first_to_last_bracket() -> None:
    # The helper now lives in model_text (one copy for all six callers); the
    # assertions stay here because this module's reply parsing depends on them.
    assert model_text.recover_json("noise {\"a\":1} tail") == '{"a":1}'
    assert model_text.recover_json("```json\n[1,2]\n```") == "[1,2]"
    assert model_text.recover_json("plain text") == "plain text"


# --- /knowledge_extract mode="cast" (story.rs character sheets) -------------


def test_a_short_sheet_is_one_window() -> None:
    assert chat_docs.cast_windows("## Mira\nTall.") == ["## Mira\nTall."]
    assert chat_docs.cast_windows("   ") == []


def test_a_long_sheet_is_windowed_with_overlap_not_clamped() -> None:
    """A clamp would read the first N characters and report the rest as "no
    characters found" — a confident answer about the part it happened to see,
    which is the `#minutes` failure exactly."""
    doc = "\n\n".join(f"## Person {i}\n{'x' * 400}" for i in range(120))
    windows = chat_docs.cast_windows(doc)
    assert len(windows) > 1, "a 50 KB sheet must not be read in one bite"
    # Every window is under the ceiling, and the whole document is covered.
    assert all(len(w) <= chat_docs.CAST_WINDOW_CHARS for w in windows)
    assert "Person 0" in windows[0]
    assert "Person 119" in windows[-1]


def test_the_same_person_in_two_windows_is_one_person() -> None:
    """The overlap means a person can come back twice. Two heroes with the same
    name, each knowing half of themselves, is the failure to avoid."""
    merged = chat_docs.merge_cast(
        [
            {"name": "Mira", "description": "Tall, grey coat.", "story": ""},
            {"name": "MIRA", "description": "", "story": "Lost her ship."},
            {"name": "Doran", "description": "Broad.", "story": ""},
        ]
    )
    assert [m["name"] for m in merged] == ["Mira", "Doran"], "first mention wins the name"
    assert merged[0]["description"] == "Tall, grey coat."
    assert merged[0]["story"] == "Lost her ship."


def test_a_later_thinner_window_never_erases_a_fuller_one() -> None:
    merged = chat_docs.merge_cast(
        [
            {"name": "Mira", "description": "Tall, grey wool coat, cropped hair.", "story": ""},
            {"name": "Mira", "description": "", "story": ""},
        ]
    )
    assert merged[0]["description"] == "Tall, grey wool coat, cropped hair."


def test_a_nameless_row_is_dropped_and_the_ceiling_holds() -> None:
    rows = [{"name": "", "description": "x", "story": ""}]
    rows += [{"name": f"P{i}", "description": "", "story": ""} for i in range(100)]
    merged = chat_docs.merge_cast(rows)
    assert len(merged) == chat_docs.CAST_MAX
    assert all(m["name"] for m in merged)


@pytest.mark.asyncio
async def test_reading_a_character_sheet_returns_the_people(
    fake_client: type[FakeAsyncClient],
) -> None:
    fake_client.script["chat"] = _chat_reply(
        '{"cast":[{"name":"Mira","description":"Tall, grey wool coat.",'
        '"story":"Lost her ship."}]}'
    )
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "llama3.2",
                "base_url": "http://h:1",
                "mode": "cast",
                "document": "## Mira\nTall, grey wool coat.\n\nLost her ship.",
            },
        )
    assert resp.status_code == 200
    cast = resp.json()["cast"]
    assert cast == [
        {"name": "Mira", "description": "Tall, grey wool coat.", "story": "Lost her ship."}
    ]
    # The two rules a model gets wrong are the two the prompt leads with.
    sent = fake_client.calls["chat"]["messages"][0]["content"]
    assert "Never invent a character" in sent
    assert "what they LOOK like" in sent


@pytest.mark.asyncio
async def test_a_document_with_no_characters_says_so_rather_than_inventing_one(
    fake_client: type[FakeAsyncClient],
) -> None:
    fake_client.script["chat"] = _chat_reply('{"cast":[]}')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "llama3.2",
                "base_url": "http://h:1",
                "mode": "cast",
                "document": "The harbour is empty. The tide turns.",
            },
        )
    assert resp.json()["cast"] == []


@pytest.mark.asyncio
async def test_an_unreadable_answer_is_not_reported_as_an_empty_cast(
    fake_client: type[FakeAsyncClient],
) -> None:
    """"The model could not read this" must never arrive dressed as "this file
    has no characters in it" — they call for completely different next steps."""
    fake_client.script["chat"] = _chat_reply("I'm afraid I can't help with that.")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "llama3.2",
                "base_url": "http://h:1",
                "mode": "cast",
                "document": "## Mira\nTall.",
            },
        )
    assert resp.status_code == 502
    assert "could not read" in resp.json()["error"]


@pytest.mark.asyncio
async def test_a_dead_engine_during_a_cast_import_is_not_blamed_on_the_document(
    fake_client: type[FakeAsyncClient],
) -> None:
    """Every window fails identically when Ollama is down, which used to satisfy
    `failures == len(windows)` and answer "this file is not a character sheet".
    The sentinel has to survive: it is what the Rust gateway rebuilds
    OLLAMA_DOWN from, and what puts "start Ollama" on the screen."""
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "llama3.2",
                "base_url": "http://h:1",
                "mode": "cast",
                "document": "## Mira\nTall.",
            },
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"
    assert "character sheet" not in resp.json()["error"]


@pytest.mark.asyncio
async def test_an_unpulled_model_during_a_cast_import_keeps_its_sentinel(
    fake_client: type[FakeAsyncClient],
) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/knowledge_extract",
            json={
                "model": "x",
                "base_url": "http://h:1",
                "mode": "cast",
                "document": "## Mira\nTall.",
            },
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"
