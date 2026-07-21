"""The Ollama adapter: the message conversion and the pinned model params.

No network — we build the LangChain objects and inspect them.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage

from arcelle_sidecar import chat as chat_module
from arcelle_sidecar.chat import OllamaChatModel, _chunk_text, _to_langchain
from arcelle_sidecar.config import KEEP_ALIVE_WARM, NUM_CTX_HIGH, NUM_CTX_LOW, num_ctx_for_chat
from arcelle_sidecar.messages import Message


async def _no_native_length(model: str, base_url: str) -> int | None:
    """Stub for `model_limits.native_context_length` — these tests build fake
    chunks for a model name ("m") that doesn't exist in any real catalog, so
    forcing this to `None` (the fallback path) keeps them network-free rather
    than depending on whether a real Ollama daemon happens to be reachable."""
    return None


def test_roles_convert() -> None:
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": "looking",
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "search_room", "arguments": {"query": "rent"}}}
            ],
        },
        {"role": "tool", "content": "found it", "tool_name": "search_room", "tool_call_id": "c1"},
    ]
    lc = _to_langchain(messages)
    assert isinstance(lc[0], SystemMessage)
    assert isinstance(lc[1], HumanMessage)
    assert isinstance(lc[2], AIMessage)
    assert lc[2].tool_calls[0]["name"] == "search_room"
    assert lc[2].tool_calls[0]["args"] == {"query": "rent"}
    assert lc[2].tool_calls[0]["id"] == "c1"
    assert isinstance(lc[3], ToolMessage)
    assert lc[3].tool_call_id == "c1"
    assert lc[3].name == "search_room"


def test_images_ride_on_the_user_turn_as_blocks() -> None:
    # Ollama reads images from user turns; they must survive the conversion.
    messages: list[Message] = [
        {"role": "user", "content": "[capture attached]", "images": ["B64PNG"]},
    ]
    human = _to_langchain(messages)[0]
    assert isinstance(human, HumanMessage)
    assert human.content == [
        {"type": "text", "text": "[capture attached]"},
        {"type": "image_url", "image_url": "data:image/png;base64,B64PNG"},
    ]


def test_chunk_text_handles_str_and_blocks() -> None:
    assert _chunk_text("hello") == "hello"
    assert _chunk_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab"
    assert _chunk_text([{"type": "image_url", "image_url": "x"}]) == ""
    assert _chunk_text(None) == ""


def test_model_params_are_pinned() -> None:
    m = OllamaChatModel("qwen3.5:9b", "http://127.0.0.1:11434", temperature=0.7)
    llm = m._llm()
    assert llm.model == "qwen3.5:9b"
    assert llm.base_url == "http://127.0.0.1:11434"
    # CHG-32: the window must not shrink on the tool-less final round. D4: the
    # default is RAM-adaptive (ollama.rs:224) — 24576 on 32 GB+, 12288 below.
    assert llm.num_ctx == num_ctx_for_chat()
    assert llm.num_ctx in (NUM_CTX_LOW, NUM_CTX_HIGH)
    assert (NUM_CTX_LOW, NUM_CTX_HIGH) == (12288, 24576)
    # HLT-5: the chat model stays warm across the conversation.
    assert llm.keep_alive == KEEP_ALIVE_WARM == "30m"
    assert llm.temperature == 0.7


def test_num_ctx_is_ram_adaptive() -> None:
    # D4: on a 32 GB+ Mac the Rust hands Ollama 24576 (ollama.rs:224); the sidecar
    # must not hardcode half of that. Explicit override still wins.
    assert num_ctx_for_chat() in (NUM_CTX_LOW, NUM_CTX_HIGH)
    forced = OllamaChatModel("m", "http://127.0.0.1:11434", num_ctx=99)
    assert forced.num_ctx == 99


def test_temperature_is_omitted_when_unset() -> None:
    llm = OllamaChatModel("m", "http://127.0.0.1:11434")._llm()
    assert llm.temperature is None


class _Cancel:
    def __init__(self) -> None:
        self._c = False

    @property
    def cancelled(self) -> bool:
        return self._c

    def cancel(self) -> None:
        self._c = True


class _FakeStream:
    """An async iterator of chunks that records whether it was closed early."""

    def __init__(self, chunks: list) -> None:
        self._chunks = chunks
        self._i = 0
        self.closed = False

    def __aiter__(self) -> "_FakeStream":
        return self

    async def __anext__(self):
        if self._i >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._i]
        self._i += 1
        return chunk

    async def aclose(self) -> None:
        self.closed = True


def _fake_llm(model: OllamaChatModel, stream: _FakeStream) -> None:
    class _LLM:
        def bind_tools(self, tools: object) -> "_LLM":
            return self

        def astream(self, messages: object) -> _FakeStream:
            return stream

    model._llm = lambda: _LLM()  # type: ignore[method-assign, assignment]


async def test_stream_breaks_the_token_loop_when_cancelled_mid_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # F1 (the confirmed-critical bug): on the plain-chat path the whole answer is
    # one stream. Stop must break it, not run it to completion. Threading a cancel
    # token that flips after 3 tokens must stop delivery and close the stream.
    # No real Ollama catalog to consult in this test — force the num_ctx fallback
    # rather than reaching out over the network for a model that doesn't exist.
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    chunks = [AIMessageChunk(content=f"tok{i} ") for i in range(50)]
    stream = _FakeStream(chunks)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    cancel = _Cancel()
    delivered: list[str] = []

    async def on_delta(d: str) -> None:
        delivered.append(d)
        if len(delivered) == 3:
            cancel.cancel()  # the user presses Stop after three tokens

    content, calls, usage = await m.stream(
        [{"role": "user", "content": "hi"}], [], on_delta, cancel
    )
    assert delivered == ["tok0 ", "tok1 ", "tok2 "]  # not all 50
    assert content == "tok0 tok1 tok2 "
    assert stream.closed is True  # the underlying stream was closed, not drained
    assert calls == []
    # No usage_metadata on these hand-built chunks — falls back to the estimate.
    assert usage.is_real is False
    assert usage.max_context == m.num_ctx


async def test_stream_delivers_everything_when_not_cancelled() -> None:
    chunks = [AIMessageChunk(content=f"t{i}") for i in range(5)]
    stream = _FakeStream(chunks)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    delivered: list[str] = []

    async def on_delta(d: str) -> None:
        delivered.append(d)

    content, _, _ = await m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None)
    assert delivered == ["t0", "t1", "t2", "t3", "t4"]
    assert content == "t0t1t2t3t4"


async def test_stream_surfaces_real_usage_when_ollama_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # langchain_ollama attaches usage_metadata (from Ollama's own
    # prompt_eval_count/eval_count) to the final merged chunk. Confirm `stream`
    # reads it through rather than discarding it.
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    chunks = [
        AIMessageChunk(content="hi"),
        AIMessageChunk(
            content="",
            usage_metadata={"input_tokens": 123, "output_tokens": 7, "total_tokens": 130},
        ),
    ]
    stream = _FakeStream(chunks)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    async def on_delta(_: str) -> None:
        pass

    _, _, usage = await m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None)
    assert usage.is_real is True
    assert usage.input_tokens == 123
    assert usage.output_tokens == 7
    assert usage.max_context == m.num_ctx


async def test_stream_uses_the_model_s_native_context_length_not_num_ctx(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Reported live 2026-07-21: a user's qwen3.5 model natively supports
    # ~256k/128k context, but the bar showed the RAM-throttled working window
    # (12288) instead. max_context must come from the model's own catalog
    # entry, not `num_ctx`, whenever that lookup succeeds.
    async def fake_native_length(model: str, base_url: str) -> int | None:
        assert model == "qwen3.5:4b"
        return 262_144

    monkeypatch.setattr(chat_module, "native_context_length", fake_native_length)
    chunks = [AIMessageChunk(content="hi")]
    stream = _FakeStream(chunks)
    m = OllamaChatModel("qwen3.5:4b", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    async def on_delta(_: str) -> None:
        pass

    _, _, usage = await m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None)
    assert usage.max_context == 262_144
    assert usage.max_context != m.num_ctx


def test_chunks_merge_into_tool_calls() -> None:
    # The shape the streaming path relies on: chunk + chunk keeps tool calls.
    a = AIMessageChunk(content="Let me ")
    b = AIMessageChunk(
        content="look.",
        tool_calls=[{"name": "search_room", "args": {"query": "rent"}, "id": "c1", "type": "tool_call"}],
    )
    merged = a + b
    assert _chunk_text(merged.content) == "Let me look."
    assert merged.tool_calls[0]["name"] == "search_room"
