"""The LLM gateway (MIGRATION Phase 1): /embed, /generate, /models, /warm,
/capabilities, /probe_model, /pull.

No network, no Ollama, no weights: a fake ``ollama.AsyncClient`` is injected and
we assert the wire behaviour and the error-code contract the Rust gateway relies
on (OLLAMA_DOWN / MODEL_MISSING).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError

from arcelle_sidecar import llm
from arcelle_sidecar.server import create_app


# --- fakes ------------------------------------------------------------------


class FakeAsyncClient:
    """A scripted ollama AsyncClient. Each method either returns its scripted
    value or raises its scripted exception, and records how it was called."""

    #: class-level script the tests set before constructing the client.
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

    async def embed(self, **kwargs: Any) -> Any:
        return self._run("embed", **kwargs)

    async def chat(self, **kwargs: Any) -> Any:
        # Streaming turns (stream=True) return an async iterator of message
        # chunks, exactly like the real ollama client; the scripted value is the
        # list of chunks (or an Exception to raise, possibly mid-stream).
        if kwargs.get("stream"):
            type(self).calls["chat"] = kwargs
            val = type(self).script.get("chat_stream")
            if isinstance(val, Exception):
                raise val

            async def gen() -> Any:
                for item in val or []:
                    if isinstance(item, Exception):
                        raise item
                    yield item

            return gen()
        return self._run("chat", **kwargs)

    async def delete(self, model: str) -> Any:
        type(self).calls["delete"] = {"model": model}
        val = type(self).script.get("delete")
        if isinstance(val, Exception):
            raise val
        return val

    async def list(self) -> Any:
        return self._run("list")

    async def show(self, model: str) -> Any:
        return self._run("show", model=model)

    async def generate(self, **kwargs: Any) -> Any:
        return self._run("generate", **kwargs)

    async def pull(self, model: str, *, stream: bool = False) -> Any:
        type(self).calls["pull"] = {"model": model, "stream": stream}
        val = type(self).script.get("pull")
        if isinstance(val, Exception):
            raise val

        async def gen() -> Any:
            for item in val or []:
                if isinstance(item, Exception):
                    raise item
                yield item

        return gen()


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


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


# --- /embed -----------------------------------------------------------------


async def test_embed_returns_vectors(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["embed"] = SimpleNamespace(embeddings=[[0.1, 0.2], [0.3, 0.4]])
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/embed",
            json={"model": "nomic-embed-text", "texts": ["a", "b"], "base_url": "http://h:1", "keep_alive": "30s"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"embeddings": [[0.1, 0.2], [0.3, 0.4]]}
    # base_url and keep_alive flow through to the client.
    assert fake_client.calls["host"] == "http://h:1"
    assert fake_client.calls["embed"]["keep_alive"] == "30s"
    assert fake_client.calls["embed"]["input"] == ["a", "b"]


async def test_embed_empty_texts_short_circuits(fake_client: type[FakeAsyncClient]) -> None:
    # ollama.rs returns Ok(vec![]) without a call; the sidecar must too.
    fake_client.script["embed"] = RuntimeError("must not be called")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/embed", json={"model": "m", "texts": [], "base_url": "http://h:1"})
    assert resp.json() == {"embeddings": []}
    assert "embed" not in fake_client.calls


async def test_embed_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["embed"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/embed", json={"model": "x", "texts": ["a"], "base_url": "http://h:1"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_embed_connection_down_maps_to_ollama_down(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["embed"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/embed", json={"model": "m", "texts": ["a"], "base_url": "http://h:1"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


async def test_embed_redacts_a_nonlocal_batch_without_mutating_caller_texts(
    fake_client: type[FakeAsyncClient],
) -> None:
    texts = ["Ben Reich", "public context"]
    fake_client.script["embed"] = SimpleNamespace(embeddings=[(0.1, 0.2), (0.3,)])

    vectors = await llm.embed(
        "nomic-embed-text:cloud",
        texts,
        "http://fake-ollama",
        privacy={
            "active": True,
            "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
        },
    )

    assert fake_client.calls["embed"]["input"] == ["[Person A]", "public context"]
    assert texts == ["Ben Reich", "public context"]
    assert vectors == [[0.1, 0.2], [0.3]]


# --- /generate --------------------------------------------------------------


def _chat_reply(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


async def test_generate_returns_text_and_passes_format_options(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("hello")
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate",
            json={
                "model": "llama3.2",
                "messages": [{"role": "user", "content": "hi"}],
                "base_url": "http://h:1",
                "temperature": 0.3,
                "num_ctx": 4096,
                "keep_alive": "5m",
                "format": schema,
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "hello"}
    call = fake_client.calls["chat"]
    assert call["format"] == schema
    assert call["options"]["num_ctx"] == 4096
    assert call["options"]["temperature"] == 0.3
    assert call["keep_alive"] == "5m"
    # Non-qwen3 model: thinking is left at the model default (not forced).
    assert call["think"] is None
    assert call["stream"] is False


async def test_generate_disables_thinking_for_qwen3(fake_client: type[FakeAsyncClient]) -> None:
    # ollama.rs:505 — qwen3 thinking variants burn hidden reasoning tokens.
    fake_client.script["chat"] = _chat_reply("{}")
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/generate",
            json={"model": "qwen3.5:9b", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    assert fake_client.calls["chat"]["think"] is False


async def test_generate_leaves_qwen3_instruct_thinking_alone(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("{}")
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/generate",
            json={"model": "qwen3-instruct", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    assert fake_client.calls["chat"]["think"] is None


async def test_generate_attaches_images_to_last_user_turn(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("[]")
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/generate",
            json={
                "model": "gemma3:4b",
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "where is the cat"},
                ],
                "base_url": "http://h:1",
                "images": ["B64PNG"],
            },
        )
    sent = fake_client.calls["chat"]["messages"]
    assert sent[-1]["role"] == "user"
    assert sent[-1]["images"] == ["B64PNG"]
    # the system turn is untouched
    assert "images" not in sent[0]


async def test_generate_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate",
            json={"model": "x", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_generate_external_engine_redacts_then_restores_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: dict[str, Any] = {}

    async def external_generate(
        model: str, messages: list[dict[str, Any]], *, format: object, images: object
    ) -> str:
        sent.update(model=model, messages=messages, format=format, images=images)
        return "Hello [Person A]"

    monkeypatch.setattr(llm.external_llm, "is_external_model", lambda _model: True)
    monkeypatch.setattr(llm.external_llm, "generate_external", external_generate)

    text = await llm.generate(
        "m:cloud",
        [{"role": "user", "content": "Ben Reich"}],
        "http://h:1",
        format={"type": "object"},
        images=["png"],
        privacy={
            "active": True,
            "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
        },
    )

    assert text == "Hello Ben Reich"
    assert sent == {
        "model": "m:cloud",
        "messages": [{"role": "user", "content": "[Person A]"}],
        "format": {"type": "object"},
        "images": None,
    }


async def test_generate_provider_passes_the_unmodified_provider_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: dict[str, Any] = {}

    class ProviderChat:
        def __init__(self, model: str, provider: object, temperature: float | None) -> None:
            calls["init"] = (model, provider, temperature)

        async def generate(self, messages: object, format: object, images: object) -> str:
            calls["generate"] = (messages, format, images)
            return "provider reply"

    provider = _openrouter()
    monkeypatch.setattr(llm, "OpenAICompatibleChatModel", ProviderChat)
    messages = [{"role": "user", "content": "hi"}]
    schema = {"type": "object"}

    assert await llm.generate(
        "openrouter/anthropic/claude-sonnet-4",
        messages,
        "http://h:1",
        temperature=0.2,
        format=schema,
        images=["png"],
        provider=provider,
    ) == "provider reply"
    assert calls["init"] == ("openrouter/anthropic/claude-sonnet-4", provider, 0.2)
    assert calls["generate"] == (messages, schema, ["png"])


async def test_generate_local_passes_the_output_cap(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("short reply")
    assert await llm.generate(
        "m",
        [{"role": "user", "content": "hi"}],
        "http://h:1",
        num_predict=32,
    ) == "short reply"
    assert fake_client.calls["chat"]["options"]["num_predict"] == 32


# --- /generate_stream -------------------------------------------------------


def _chat_chunk(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


async def test_generate_stream_emits_deltas_then_done(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat_stream"] = [
        _chat_chunk("Hel"),
        _chat_chunk("lo"),
        _chat_chunk(""),  # empty chunks are dropped, never emitted as a delta
        _chat_chunk(" world"),
    ]
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_stream",
            json={
                "model": "llama3.2",
                "messages": [{"role": "user", "content": "hi"}],
                "base_url": "http://h:1",
                "num_ctx": 4096,
                "temperature": 0.3,
                "keep_alive": "5m",
            },
        )
    assert resp.status_code == 200
    lines = [json.loads(x) for x in resp.text.strip().split("\n")]
    assert lines == [
        {"t": "delta", "v": "Hel"},
        {"t": "delta", "v": "lo"},
        {"t": "delta", "v": " world"},
        {"t": "done"},
    ]
    # same wire config as /generate: options + keep_alive + streaming on.
    call = fake_client.calls["chat"]
    assert call["options"]["num_ctx"] == 4096
    assert call["options"]["temperature"] == 0.3
    assert call["keep_alive"] == "5m"
    assert call["stream"] is True
    assert call["think"] is None  # non-qwen3: model default


async def test_generate_stream_disables_thinking_for_qwen3(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat_stream"] = [_chat_chunk("ok")]
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/generate_stream",
            json={"model": "qwen3.5:9b", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    assert fake_client.calls["chat"]["think"] is False


async def test_generate_stream_attaches_images_to_last_user_turn(
    fake_client: type[FakeAsyncClient],
) -> None:
    fake_client.script["chat_stream"] = [_chat_chunk("a chart")]
    app = create_app()
    async with client_for(app) as c:
        await c.post(
            "/generate_stream",
            json={
                "model": "gemma3:4b",
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "what is on screen"},
                ],
                "base_url": "http://h:1",
                "images": ["B64PNG"],
            },
        )
    sent = fake_client.calls["chat"]["messages"]
    assert sent[-1]["role"] == "user"
    assert sent[-1]["images"] == ["B64PNG"]
    assert "images" not in sent[0]


async def test_generate_stream_error_becomes_terminal_error_line(
    fake_client: type[FakeAsyncClient],
) -> None:
    # A connect failure before any token -> a single {"t":"error"} line, code OLLAMA_DOWN.
    fake_client.script["chat_stream"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_stream",
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    assert resp.status_code == 200  # NDJSON stream; the failure rides in the body
    lines = [json.loads(x) for x in resp.text.strip().split("\n")]
    assert lines == [{"t": "error", "code": "OLLAMA_DOWN", "error": "refused"}]


async def test_generate_stream_mid_stream_error_after_deltas(
    fake_client: type[FakeAsyncClient],
) -> None:
    # Deltas already flushed, then the engine dies: deltas, then error, no "done".
    fake_client.script["chat_stream"] = [
        _chat_chunk("par"),
        _chat_chunk("tial"),
        ResponseError("model 'x' not found", 404),
    ]
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/generate_stream",
            json={"model": "x", "messages": [{"role": "user", "content": "hi"}], "base_url": "http://h:1"},
        )
    lines = [json.loads(x) for x in resp.text.strip().split("\n")]
    assert lines[0] == {"t": "delta", "v": "par"}
    assert lines[1] == {"t": "delta", "v": "tial"}
    assert lines[-1] == {"t": "error", "code": "MODEL_MISSING", "error": "model 'x' not found"}
    assert {"t": "done"} not in lines


async def test_generate_stream_flushes_an_unfinished_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The final partial placeholder must not disappear when a stream ends."""

    async def fake_stream(self, messages, *, format=None, images=None):  # noqa: A002
        yield "answer ends with [Per"

    monkeypatch.setattr(llm.OllamaChatModel, "generate_stream", fake_stream)
    parts = [
        delta
        async for delta in llm.generate_stream(
            "m:cloud",
            [{"role": "user", "content": "hi"}],
            "http://127.0.0.1:11434",
            privacy={
                "active": True,
                "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
            },
        )
    ]
    assert "".join(parts) == "answer ends with [Per"


# --- /delete ----------------------------------------------------------------


async def test_delete_removes_model(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["delete"] = SimpleNamespace(status="success")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/delete", json={"model": "m", "base_url": "http://h:1"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert fake_client.calls["delete"] == {"model": "m"}
    assert fake_client.calls["host"] == "http://h:1"


async def test_delete_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["delete"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/delete", json={"model": "x", "base_url": "http://h:1"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_delete_connection_down_maps_to_ollama_down(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["delete"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/delete", json={"model": "m", "base_url": "http://h:1"})
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


# --- /models, /warm, /capabilities -----------------------------------------


async def test_models_lists_names(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["list"] = SimpleNamespace(
        models=[SimpleNamespace(model="qwen3.5:9b"), SimpleNamespace(model="nomic-embed-text")]
    )
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/models", json={"base_url": "http://h:1"})
    assert resp.json() == {"models": ["qwen3.5:9b", "nomic-embed-text"]}


async def test_warm_is_fire_and_forget_ok(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["generate"] = SimpleNamespace(response="")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/warm", json={"model": "qwen3.5:9b", "base_url": "http://h:1"})
    assert resp.json() == {"ok": True}
    assert fake_client.calls["generate"]["keep_alive"] == "30m"
    assert fake_client.calls["generate"]["options"] == {"num_ctx": 8192}


async def test_capabilities_returns_declared(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["show"] = SimpleNamespace(capabilities=["tools", "vision"])
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/capabilities", json={"model": "m", "base_url": "http://h:1"})
    assert resp.json() == {"capabilities": ["tools", "vision"]}


async def test_capabilities_never_fails(fake_client: type[FakeAsyncClient]) -> None:
    # ollama.rs treats unknown capabilities as none — an error must yield [], 200.
    fake_client.script["show"] = ResponseError("boom", 500)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/capabilities", json={"model": "m", "base_url": "http://h:1"})
    assert resp.status_code == 200
    assert resp.json() == {"capabilities": []}


async def test_probe_model_returns_declared_capabilities(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["show"] = SimpleNamespace(capabilities=["tools", "vision"])
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/probe_model", json={"model": "m", "base_url": "http://h:1"})
    assert resp.status_code == 200
    assert resp.json() == {"capabilities": ["tools", "vision"]}


async def test_probe_model_preserves_model_missing(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["show"] = ResponseError("model 'Wrong' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/probe_model",
            json={"model": "Wrong:cloud", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json() == {
        "code": "MODEL_MISSING",
        "error": "model 'Wrong' not found",
    }


async def test_probe_model_preserves_provider_failure(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["show"] = ResponseError("cloud relay refused the request", 503)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/probe_model",
            json={"model": "gpt-oss:120b-cloud", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json() == {
        "code": "ENGINE_ERROR",
        "error": "cloud relay refused the request",
    }


# --- /pull ------------------------------------------------------------------


async def test_pull_streams_progress(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["pull"] = [
        SimpleNamespace(status="pulling", completed=10, total=100),
        SimpleNamespace(status="pulling", completed=100, total=100),
        SimpleNamespace(status="success", completed=None, total=None),
    ]
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/pull", json={"model": "m", "base_url": "http://h:1"})
    lines = [json.loads(x) for x in resp.text.strip().split("\n")]
    assert lines[0] == {"status": "pulling", "completed": 10, "total": 100}
    assert lines[-1] == {"status": "success"}  # None progress fields are dropped
    assert fake_client.calls["pull"] == {"model": "m", "stream": True}


async def test_pull_error_becomes_a_final_line(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["pull"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post("/pull", json={"model": "m", "base_url": "http://h:1"})
    last = json.loads(resp.text.strip().split("\n")[-1])
    assert last["code"] == "OLLAMA_DOWN"


# --- which seam actually failed ---------------------------------------------


class DeadProviderChat:
    """An OpenAI-compatible provider that cannot be reached at all."""

    def __init__(self, model: str, provider: Any, temperature: float | None = None) -> None:
        self.provider = provider

    async def generate(self, messages: Any, format: Any = None, images: Any = None) -> str:
        raise httpx.ConnectError("All connection attempts failed")

    async def generate_stream(self, messages: Any, format: Any = None, images: Any = None) -> Any:
        raise httpx.ReadTimeout("timed out")
        yield ""  # pragma: no cover - makes this an async generator


def _openrouter() -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://openrouter.ai/api/v1",
        model="anthropic/claude-sonnet-4",
        api_key="sk-or-test",
        supports_tools=True,
    )


async def test_provider_transport_failure_is_not_blamed_on_ollama(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A room whose engine is OpenRouter never touches Ollama. Reporting a dead
    # network as OLLAMA_DOWN made the UI say "The local AI isn't running." and
    # offer to start a daemon the room does not use.
    monkeypatch.setattr(llm, "OpenAICompatibleChatModel", DeadProviderChat)
    with pytest.raises(llm.LlmError) as caught:
        await llm.generate(
            "openrouter/anthropic/claude-sonnet-4",
            [{"role": "user", "content": "hi"}],
            "http://127.0.0.1:11434",
            provider=_openrouter(),
        )
    assert caught.value.code == "ENGINE_ERROR"
    assert "openrouter.ai" in caught.value.message
    assert "All connection attempts failed" in caught.value.message


async def test_provider_stream_transport_failure_is_not_blamed_on_ollama(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm, "OpenAICompatibleChatModel", DeadProviderChat)
    with pytest.raises(llm.LlmError) as caught:
        async for _ in llm.generate_stream(
            "openrouter/anthropic/claude-sonnet-4",
            [{"role": "user", "content": "hi"}],
            "http://127.0.0.1:11434",
            provider=_openrouter(),
        ):
            pass
    assert caught.value.code == "ENGINE_ERROR"
    assert "openrouter.ai" in caught.value.message


async def test_local_transport_failure_still_says_ollama_down(
    fake_client: type[FakeAsyncClient],
) -> None:
    # The sentinel keeps its meaning for calls that really did target the
    # loopback daemon — jobs.rs / summarize.rs branch on it.
    fake_client.script["chat"] = httpx.ConnectError("refused")
    with pytest.raises(llm.LlmError) as caught:
        await llm.generate("m", [{"role": "user", "content": "hi"}], "http://127.0.0.1:11434")
    assert caught.value.code == "OLLAMA_DOWN"


def test_provider_host_falls_back_when_the_base_url_is_unusable() -> None:
    # A provider row with no base_url must not turn a transport failure into a
    # message that names nothing — and must still not say OLLAMA_DOWN.
    err = llm._classify(httpx.ConnectError(""), provider_host=None)
    assert err.code == "OLLAMA_DOWN"
    err = llm._classify(httpx.ConnectError(""), provider_host="openrouter.ai")
    assert err.code == "ENGINE_ERROR"
    assert err.message.strip() and "openrouter.ai" in err.message


def test_classify_preserves_classified_provider_and_generic_errors() -> None:
    existing = llm.LlmError("OLLAMA_DOWN", "already classified")
    assert llm._classify(existing) is existing

    provider = llm._classify(llm.ProviderApiError("provider refused"))
    assert (provider.code, provider.message) == ("ENGINE_ERROR", "provider refused")

    generic = llm._classify(RuntimeError("unexpected engine failure"))
    assert (generic.code, generic.message) == ("ENGINE_ERROR", "unexpected engine failure")
