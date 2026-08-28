"""The Ollama adapter: the message conversion and the pinned model params.

No network — we build the LangChain objects and inspect them.
"""

from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage

from arcelle_sidecar import chat as chat_module
from arcelle_sidecar.budget import (
    IMAGE_BYTES,
    msg_len,
    trim_messages_to_window,
    window_budget_bytes,
)
from arcelle_sidecar.chat import OllamaChatModel, _chunk_text, _to_langchain
from arcelle_sidecar.config import KEEP_ALIVE_WARM
from arcelle_sidecar.messages import Message
from arcelle_sidecar.model_limits import NUM_CTX_BUCKETS, max_num_ctx, pick_num_ctx


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
    llm = m._llm(None)
    assert llm.model == "qwen3.5:9b"
    assert llm.base_url == "http://127.0.0.1:11434"
    assert m.num_ctx is None
    # HLT-5: the chat model stays warm across the conversation.
    assert llm.keep_alive == KEEP_ALIVE_WARM == "30m"
    assert llm.temperature == 0.7


def test_pick_num_ctx_buckets_and_caps() -> None:
    # The measured live failure: a ~21KB turn (≈6.8k tokens) in the daemon's
    # 4096 default window → context-shift → "Done.". 21KB must pick 16k.
    assert pick_num_ctx(21_000, native_ctx=262_144) == 16_384
    assert pick_num_ctx(1_000, native_ctx=262_144) == 8_192  # floor > daemon 4k
    assert pick_num_ctx(60_000, native_ctx=262_144) == 32_768
    # The job-sized payloads reach the job-sized buckets. A whole-file pass
    # section and a deep summary's gathered reads are 100KB+, and a 32k ceiling
    # put them straight back into the context-shift this exists to prevent.
    assert pick_num_ctx(120_000, native_ctx=262_144) == 65_536
    # …bounded by RAM, not by the caller: 131072 only on a 32 GB+ Mac.
    assert pick_num_ctx(10_000_000, native_ctx=262_144) == max_num_ctx()
    assert max_num_ctx() in (65_536, 131_072)
    # A model whose native window is smaller than the bucket gets its native
    # window — asking beyond it would degrade every token via RoPE stretch.
    assert pick_num_ctx(21_000, native_ctx=8_192) == 8_192
    assert pick_num_ctx(1_000, native_ctx=None) == NUM_CTX_BUCKETS[0]


def test_the_window_budget_is_the_inverse_of_the_bucket_choice() -> None:
    # `trim_messages_to_window` and `pick_num_ctx` must never disagree about
    # whether a payload fits, or the trimmer would either do nothing (and let
    # the daemon shift) or trim a payload that was already fine.
    for payload in (1_000, 21_000, 60_000, 120_000, 400_000):
        window = pick_num_ctx(payload, native_ctx=262_144)
        if window == max_num_ctx() and payload > window_budget_bytes(window):
            continue  # genuinely bigger than any window — the trimmer's job
        assert payload <= window_budget_bytes(window), payload


def test_an_oversized_turn_is_trimmed_deliberately_not_by_the_daemon() -> None:
    # The last resort. Tool results are stubbed oldest-first; the system
    # prompt, the recent turns and the assistant/tool pairing all survive.
    huge = "x" * 300_000
    messages: list[dict] = [
        {"role": "system", "content": "SYSTEM DOCTRINE"},
        {"role": "user", "content": "what does the contract say?"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_name": "fetch_page", "content": huge},  # old
        {"role": "assistant", "content": "an earlier answer"},
        {"role": "user", "content": "and the notice period?"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "2"}]},
        {"role": "tool", "tool_name": "search_room", "content": huge},  # recent
        {"role": "user", "content": "quote it exactly"},
    ]
    assert trim_messages_to_window(messages, 0, 16_384) is True
    assert messages[0]["content"] == "SYSTEM DOCTRINE", "the doctrine must survive"
    assert messages[1]["content"] == "what does the contract say?"
    assert messages[-1]["content"] == "quote it exactly"
    # Pass 1 stubs the OLD result outright — it has already been reasoned over.
    assert "trimmed to fit" in messages[3]["content"]
    assert "fetch_page" in messages[3]["content"]
    # Pass 2 cuts the RECENT one, which `_KEEP_RECENT` protects and which is
    # bigger than the whole window on its own. Without this pass the prompt
    # still wouldn't fit and the daemon would drop the doctrine instead.
    assert messages[7]["content"].startswith("x"), "keep the head, cut the tail"
    assert "cut here to fit" in messages[7]["content"]
    # It actually fits now — that is the whole point.
    assert not trim_messages_to_window(messages, 0, 16_384)
    # Role pairing intact: every tool result still has its assistant turn.
    assert messages[2].get("tool_calls") and messages[6].get("tool_calls")

    # A payload that already fits is untouched, and a non-local model (no
    # window of ours) is never trimmed at all.
    small = [{"role": "system", "content": "hi"}, {"role": "user", "content": "yo"}]
    assert trim_messages_to_window(small, 0, 16_384) is False
    cloud = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_name": "t", "content": huge},
        {"role": "user", "content": "q"},
    ]
    assert trim_messages_to_window(cloud, 0, None) is False
    assert cloud[3]["content"] == huge, "a cloud model owns its own window"


async def test_local_calls_request_a_payload_fitted_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The "Done." live regression (2026-07-23): the daemon loads local models
    # with a ~4k window and context-shifts the FRONT of an oversized prompt
    # away. Every local call must therefore ask for a window that fits its
    # actual payload — never leave the daemon default in charge.
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    m = OllamaChatModel("qwen3.5:4b", "http://127.0.0.1:11434")
    assert await m._resolve_num_ctx(21_000) == 16_384  # the repro's turn size
    assert m._last_num_ctx == 16_384
    assert await m._resolve_num_ctx(1_000) == 8_192  # floor, never the 4k default
    assert await m._resolve_num_ctx(10_000_000) == max_num_ctx()  # RAM-bounded top


async def test_explicit_num_ctx_override_still_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    forced = OllamaChatModel("m", "http://127.0.0.1:11434", num_ctx=99)
    assert await forced._resolve_num_ctx(10_000_000) == 99


async def test_cloud_models_keep_the_remote_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A `:cloud` model's window lives on the remote side — sending a local
    # num_ctx would at best be ignored and at worst shrink it.
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    m = OllamaChatModel("qwen3:cloud", "http://127.0.0.1:11434")
    assert await m._resolve_num_ctx(1_000_000) is None


def test_temperature_is_omitted_when_unset() -> None:
    llm = OllamaChatModel("m", "http://127.0.0.1:11434")._llm(None)
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

    model._llm = lambda num_ctx=None: _LLM()  # type: ignore[method-assign, assignment]


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
    # A local model always runs in the window the call requested (the
    # payload-fitted floor here — no catalog entry for "m").
    assert usage.max_context == 8_192


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


class _StalledStream:
    """A stream that yields nothing and never ends — a wedged daemon.

    The failure live QA 2026-08-03 reported as "Stop this answer did not stop
    Claude, local, or other long-running work": the pre-fix loop only sampled
    the cancel flag from inside its body, which a stream with no chunks never
    reaches. Under that code this fixture hangs forever.
    """

    def __init__(self) -> None:
        self.closed = False

    def __aiter__(self) -> "_StalledStream":
        return self

    async def __anext__(self):
        await asyncio.Event().wait()  # never resolves
        raise AssertionError("unreachable")  # pragma: no cover

    async def aclose(self) -> None:
        self.closed = True


async def test_stop_lands_on_a_stream_that_never_sends_a_chunk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    stream = _StalledStream()
    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    cancel = _Cancel()

    async def press_stop() -> None:
        await asyncio.sleep(0.05)
        cancel.cancel()

    async def on_delta(d: str) -> None:  # pragma: no cover - nothing streams
        raise AssertionError("a stalled stream delivers no deltas")

    asyncio.ensure_future(press_stop())
    # The assertion is that this RETURNS at all. Bounded so a regression fails
    # the suite instead of hanging it.
    content, calls, _ = await asyncio.wait_for(
        m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel),
        timeout=5,
    )
    assert content == ""  # nothing arrived, so nothing is claimed
    assert calls == []
    assert stream.closed is True  # the wedged read was closed, not orphaned


async def test_a_silent_stream_ends_as_an_engine_error_not_an_empty_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # With no Stop pressed, silence past the budget must be REPORTED. Returning
    # "" here would render as a finished, empty answer — the exact fabrication
    # shape this codebase's anti-fabrication doctrine exists to prevent.
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    monkeypatch.setattr(chat_module, "REQUEST_TIMEOUT_SECONDS", 0.3)
    stream = _StalledStream()
    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    async def on_delta(d: str) -> None:  # pragma: no cover - nothing streams
        raise AssertionError("a stalled stream delivers no deltas")

    from arcelle_sidecar.llm import LlmError

    with pytest.raises(LlmError) as caught:
        await asyncio.wait_for(
            m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None),
            timeout=5,
        )
    assert caught.value.code == "ENGINE_ERROR"
    assert "sent nothing" in caught.value.message
    assert stream.closed is True


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
    # The truthful ceiling is the requested window, not a display default.
    assert usage.max_context == 8_192


async def test_stream_reports_the_window_the_call_actually_ran_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # History: 2026-07-21 made max_context the native advertised length so the
    # bar wouldn't show a stale RAM-throttled 12288. But the native length is a
    # capability, not the running window — with the daemon's 4k default the bar
    # showed "1% of 262k used" on turns that had already overflowed and been
    # context-shifted into garbage (the "Done." regression). The bar must show
    # the window the call actually REQUESTED: the payload-fitted num_ctx.
    async def fake_native_length(model: str, base_url: str) -> int | None:
        return 262_144

    monkeypatch.setattr(chat_module, "native_context_length", fake_native_length)
    chunks = [AIMessageChunk(content="hi")]
    stream = _FakeStream(chunks)
    m = OllamaChatModel("qwen3.5:4b", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    async def on_delta(_: str) -> None:
        pass

    _, _, usage = await m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None)
    assert usage.max_context == 8_192  # the requested window, not the 262k ceiling


async def test_cloud_stream_still_reports_the_native_remote_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `:cloud` models run in their remote window — the native catalog entry
    # (confirmed live 2026-07-21) stays the truthful ceiling there.
    async def fake_native_length(model: str, base_url: str) -> int | None:
        return 524_288

    monkeypatch.setattr(chat_module, "native_context_length", fake_native_length)
    stream = _FakeStream([AIMessageChunk(content="hi")])
    m = OllamaChatModel("qwen3:cloud", "http://127.0.0.1:11434")
    _fake_llm(m, stream)

    async def on_delta(_: str) -> None:
        pass

    _, _, usage = await m.stream([{"role": "user", "content": "hi"}], [], on_delta, cancel=None)
    assert usage.max_context == 524_288


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


async def test_the_window_is_refitted_to_what_compaction_actually_sends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The host hands over the WHOLE conversation now, so the raw payload no
    longer says what the call needs. Sizing `num_ctx` off the raw bytes and then
    sending a compacted payload asks Ollama for roughly twice the KV cache the
    call uses — 64k ctx costs ~7.7 GB on a 16 GB Mac (model_limits)."""

    async def fake_native_length(model: str, base_url: str) -> int | None:
        return 262_144

    monkeypatch.setattr(chat_module, "native_context_length", fake_native_length)

    async def tiny_digest(self, text: str) -> str:
        return "facts: the rent is 4200"

    monkeypatch.setattr(OllamaChatModel, "_digest", tiny_digest)

    # Record the BYTES the window was fitted to, not the bucket it landed in:
    # buckets are coarse (8k/16k/32k/64k/128k) and a shrink can easily stay
    # inside one, which would make a bucket assertion pass or fail for reasons
    # that have nothing to do with the behaviour under test.
    asked: list[int] = []
    real_resolve = OllamaChatModel._resolve_num_ctx

    async def spy(self, payload_bytes: int) -> int | None:
        asked.append(payload_bytes)
        return await real_resolve(self, payload_bytes)

    monkeypatch.setattr(OllamaChatModel, "_resolve_num_ctx", spy)

    m = OllamaChatModel("qwen3.5:4b", "http://127.0.0.1:11434")
    _fake_llm(m, _FakeStream([AIMessageChunk(content="ok")]))

    async def on_delta(_: str) -> None:
        pass

    # Big enough to exceed even the largest window this Mac may ask for, so
    # compaction engages at all — it is a safety valve now (SPEND_FRACTION 0.9),
    # not something an ordinary turn triggers.
    big: list[Message] = [{"role": "system", "content": "S"}] + [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i} " + "x" * 2_500}
        for i in range(120)
    ]
    await m.stream(big, [], on_delta, cancel=None)

    assert len(asked) == 2, f"the window was never re-fitted after compaction: {asked}"
    assert asked[1] < asked[0], f"the re-fit saw no smaller payload: {asked}"


# --------------------------------------------------------------------------- #
# a wedged daemon must not hang the turn
#
# Nothing bounded these requests: the `ollama` client defaults to no timeout at
# all, and Stop only breaks the token loop once tokens are ARRIVING. A daemon
# that never answers the first one left the turn spinning with no way out but
# quitting the app.
# --------------------------------------------------------------------------- #


class _WedgedClient:
    """An Ollama that accepts the request and then says nothing, ever."""

    def __init__(self, host: str = "", **kwargs: object) -> None:
        pass

    async def chat(self, **kwargs: object):
        if kwargs.get("stream"):

            async def never():
                await asyncio.sleep(30)
                yield None  # pragma: no cover - never reached

            return never()
        await asyncio.sleep(30)


async def test_a_wedged_daemon_ends_the_call_instead_of_hanging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ollama

    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    monkeypatch.setattr(chat_module, "GENERATION_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(ollama, "AsyncClient", _WedgedClient)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")

    with pytest.raises(asyncio.TimeoutError) as caught:
        await m.generate([{"role": "user", "content": "hi"}])

    # ...and SAYS so. A bare asyncio.TimeoutError stringifies to nothing, which
    # the route renders as "Local AI error (502): " with the message missing:
    # the user is told that something failed and nothing about what.
    from arcelle_sidecar import llm as llm_module

    assert str(caught.value).strip(), "the timeout carried no message at all"
    assert llm_module._classify(caught.value).message.strip(), (
        "the sentinel the user is shown ends at the colon"
    )


def test_a_slow_one_shot_generation_is_not_cut_off_at_the_silence_budget() -> None:
    """The non-streaming path carries the SLOW work — a whole-file-pass section,
    a document-length translation, a cold load of a large model on top of either
    — and has no liveness signal to bound it by, so its bound is a duration.
    Holding that work to the ten-minute silence budget killed runs that were
    merely ambitious; the host waits an hour for the same call
    (src-tauri/src/sidecar.rs SIDECAR_TIMEOUT), so nothing here should give up
    first.
    """
    assert chat_module.GENERATION_TIMEOUT_SECONDS >= 3600.0
    assert chat_module.GENERATION_TIMEOUT_SECONDS > chat_module.REQUEST_TIMEOUT_SECONDS


async def test_a_stream_that_never_produces_a_token_ends_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case Stop cannot help with: the wedge happens BEFORE the first word,
    so there is no token loop to break."""
    import ollama

    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    monkeypatch.setattr(chat_module, "REQUEST_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(ollama, "AsyncClient", _WedgedClient)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")

    with pytest.raises(asyncio.TimeoutError) as caught:
        async for _ in m.generate_stream([{"role": "user", "content": "hi"}]):
            pass  # pragma: no cover - nothing is ever yielded
    assert str(caught.value).strip(), "the timeout carried no message at all"


# --------------------------------------------------------------------------- #
# the one-shot job paths (translate, whole-file summarise, document generation)
# --------------------------------------------------------------------------- #


class _RecordingClient:
    """Records the request it was handed, and answers immediately."""

    last: dict = {}

    def __init__(self, host: str = "", **kwargs: object) -> None:
        pass

    async def chat(self, **kwargs: object):
        from types import SimpleNamespace

        type(self).last = dict(kwargs)
        return SimpleNamespace(message=SimpleNamespace(content="ok"))


async def test_a_one_shot_job_cuts_its_own_payload_to_the_window_it_asked_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`generate` sized a window and then sent whatever it had. Past the biggest
    window this Mac may ask for, the daemon deletes the FRONT of the prompt —
    the instruction — and answers a question it can no longer see."""
    import ollama

    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    monkeypatch.setattr(ollama, "AsyncClient", _RecordingClient)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")

    body = "x" * 3_000_000
    messages: list[Message] = [
        {"role": "system", "content": "Translate the text below into French."},
        {"role": "user", "content": body + "\n[end of document]"},
    ]
    assert await m.generate(messages) == "ok"

    sent = _RecordingClient.last["messages"]
    window = _RecordingClient.last["options"]["num_ctx"]
    assert window == max_num_ctx()
    assert sum(msg_len(x) for x in sent) <= window_budget_bytes(window), (
        "the daemon was handed a payload bigger than the window it was asked "
        "for — the silent context-shift this exists to prevent"
    )
    assert sent[0]["content"] == "Translate the text below into French."
    assert "cut here" in sent[1]["content"]
    assert messages[1]["content"] == body + "\n[end of document]", (
        "the caller's own messages were mutated"
    )


async def test_an_ordinary_one_shot_payload_is_sent_verbatim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ollama

    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)
    monkeypatch.setattr(ollama, "AsyncClient", _RecordingClient)
    m = OllamaChatModel("m", "http://127.0.0.1:11434")

    messages: list[Message] = [
        {"role": "system", "content": "Summarise."},
        {"role": "user", "content": "y" * 5_000},
    ]
    await m.generate(messages)
    assert [x["content"] for x in _RecordingClient.last["messages"]] == [
        "Summarise.",
        "y" * 5_000,
    ]


# --------------------------------------------------------------------------- #
# a picture is not free
# --------------------------------------------------------------------------- #


async def test_attached_pictures_are_counted_when_sizing_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A screenshot costs roughly 1.5k tokens and was counted as nothing, so a
    turn carrying a few of them sized its window off the prose alone and came
    up short — the daemon then dropping the doctrine and the question."""
    monkeypatch.setattr(chat_module, "native_context_length", _no_native_length)

    asked: list[int] = []
    real_resolve = OllamaChatModel._resolve_num_ctx

    async def spy(self, payload_bytes: int) -> int | None:
        asked.append(payload_bytes)
        return await real_resolve(self, payload_bytes)

    monkeypatch.setattr(OllamaChatModel, "_resolve_num_ctx", spy)

    async def on_delta(_: str) -> None:
        pass

    m = OllamaChatModel("m", "http://127.0.0.1:11434")
    _fake_llm(m, _FakeStream([AIMessageChunk(content="ok")]))
    await m.stream([{"role": "user", "content": "what is this?"}], [], on_delta, None)

    _fake_llm(m, _FakeStream([AIMessageChunk(content="ok")]))
    await m.stream(
        [{"role": "user", "content": "what is this?", "images": ["b64", "b64"]}],
        [],
        on_delta,
        None,
    )

    assert asked[1] - asked[0] == 2 * IMAGE_BYTES
