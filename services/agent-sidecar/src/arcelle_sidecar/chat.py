"""The injectable chat-model seam and local Ollama implementation."""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Optional

import httpx

from .budget import (
    IMAGE_BYTES,
    fit_to_window,
    json_chars,
    msg_len,
    trim_messages_to_window,
)
from .compaction import (
    CLOUD_SPEND_FRACTION,
    compact_to_budget,
    digest_chunk_bytes,
    fit_budget_bytes,
)
from .config import KEEP_ALIVE_WARM
from .messages import Message, ToolCall, attach_images
from .model_limits import native_context_length, observe_token_ratio, pick_num_ctx
from .privacy import PrivacyPolicy, guard_outbound, is_nonlocal_model

from .chat_stream import (
    Cancellable as Cancellable,
    ChatModel as ChatModel,
    DeltaSink as DeltaSink,
    RoundUsage as RoundUsage,
    StreamStalled as StreamStalled,
    _StreamPreparation,
    iter_with_stop as iter_with_stop,
)
from .chat_langchain import (
    _chunk_text as _chunk_text,
    _text_from_chunk_block as _text_from_chunk_block,
    _to_langchain as _to_langchain,
)
REQUEST_TIMEOUT_SECONDS: float = 600.0

REQUEST_TIMEOUT = httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=10.0)

GENERATION_TIMEOUT_SECONDS: float = 3600.0


def _minutes(seconds: float) -> str:
    count = max(1, round(seconds / 60))
    return "1 minute" if count == 1 else f"{count} minutes"


async def _bounded(awaitable: Any, seconds: float, what: str) -> Any:
    """``asyncio.wait_for`` with an error a human can read.

    A bare ``asyncio.TimeoutError`` stringifies to the EMPTY STRING, and
    ``llm._classify`` has no branch for it (it is neither an httpx timeout nor a
    ConnectionError), so it fell through to ``ENGINE_ERROR`` with no message and
    the user was shown "Local AI error (502): " and nothing after the colon.
    Say what actually happened instead.
    """
    try:
        return await asyncio.wait_for(awaitable, seconds)
    except asyncio.TimeoutError as exc:
        raise TimeoutError(
            f"The local model {what} after {_minutes(seconds)}. It may still be "
            "loading, or the Ollama server may be stuck — try again, or pick a "
            "smaller model."
        ) from exc


class OllamaChatModel:
    """The real model: a local Ollama server over loopback, nothing else."""

    def __init__(
        self,
        model: str,
        base_url: str,
        temperature: float | None = None,
        *,
        num_ctx: int | None = None,
        num_predict: int | None = None,
        keep_alive: str = KEEP_ALIVE_WARM,
        supports_vision: bool | None = None,
    ) -> None:
        self.model = model
        self.base_url = base_url
        self.temperature = temperature
        self.num_ctx = num_ctx
        self.num_predict = num_predict
        self.keep_alive = keep_alive
        self.supports_vision = supports_vision
        self._last_num_ctx: int | None = num_ctx
        self.privacy: PrivacyPolicy | None = None

    def _require_image_input(
        self, messages: list[Message], images: list[str] | None = None
    ) -> None:
        if self.supports_vision is not False:
            return
        if not images and not any(message.get("images") for message in messages):
            return
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            "The selected Ollama model does not support image input, so it "
            "cannot inspect the captured frame. Choose a model with Vision "
            "capability.",
        )

    @staticmethod
    def _payload_bytes(
        messages: list[Message],
        format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg
        images: list[str] | None = None,
    ) -> int:
        """Estimated prompt cost of a one-shot call, in bytes of text.

        ``images`` are the ones passed at the request's top level (they are hung
        on the last user turn at send time); images already inline on a message
        are counted by ``msg_len``, so nothing is charged twice.
        """
        return (
            sum(msg_len(m) for m in messages)
            + (json_chars(format) if format else 0)
            + IMAGE_BYTES * len(images or [])
        )

    async def _resolve_num_ctx(self, payload_bytes: int) -> int | None:
        """The ``num_ctx`` this call sends: override > payload-fitted > None.

        None only for non-local (``:cloud``) models, whose window lives on the
        remote side. Remembers the choice for :meth:`_round_usage`.
        """
        num_ctx = self.num_ctx
        if num_ctx is None and not is_nonlocal_model(self.model):
            native = await native_context_length(self.model, self.base_url)
            num_ctx = pick_num_ctx(payload_bytes, native)
        self._last_num_ctx = num_ctx
        return num_ctx

    async def _remote_window(self) -> int | None:
        """A non-local model's OWN window, in tokens, or None.

        Only meaningful for a `:cloud` tag: Ollama's catalog reports the real
        remote length for those (confirmed live 2026-07-21). A local model has
        `num_ctx` instead and never reaches here.
        """
        if not is_nonlocal_model(self.model):
            return None
        return await native_context_length(self.model, self.base_url)

    async def _compaction_budget(self, num_ctx: int | None, reserved: int) -> int | None:
        """Bytes of conversation this call may send, local window or remote."""
        if num_ctx is not None:
            return fit_budget_bytes(num_ctx, reserved)
        window = await self._remote_window()
        return fit_budget_bytes(window, reserved, CLOUD_SPEND_FRACTION)

    def _llm(self, num_ctx: int | None) -> Any:
        from langchain_ollama import ChatOllama

        kwargs: dict[str, Any] = {
            "model": self.model,
            "base_url": self.base_url,
            "keep_alive": self.keep_alive,
            "client_kwargs": {"timeout": REQUEST_TIMEOUT},
        }
        if num_ctx is not None:
            kwargs["num_ctx"] = num_ctx
        if self.num_predict is not None:
            kwargs["num_predict"] = self.num_predict
        if self.temperature is not None:
            kwargs["temperature"] = self.temperature
        return ChatOllama(**kwargs)

    async def generate(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg
        images: list[str] | None = None,
    ) -> str:
        """One NON-streaming turn (MIGRATION Phase 1: ollama.rs ``chat_structured``).

        Talks to Ollama with the ``ollama`` python client directly rather than the
        LangChain streaming path, to reproduce the old ``chat_core`` wire call byte
        for byte: same ``options.num_ctx``/``temperature``, same ``keep_alive``,
        same ``format`` grammar, and the same ``think`` rule (qwen3 thinking
        variants burn thousands of hidden reasoning tokens, so we disable thinking
        for them and leave every other model's default alone — ollama.rs:505).
        ``images`` ride on the last user turn (vision). Returns the raw text; the
        Rust caller keeps the schema-in-prompt priming and JSON recovery.
        """
        from ollama import AsyncClient

        send, options, think = await self._prepare_generate_request(
            messages, format, images
        )
        return await self._generate_response(
            send, format, images, options, think, AsyncClient
        )

    async def _prepare_generate_request(
        self,
        messages: list[Message],
        format: dict[str, Any] | None,
        images: list[str] | None,
    ) -> tuple[list[Message], dict[str, Any], bool | None]:
        """Fit one native non-streaming or streaming generation request."""
        self._require_image_input(messages, images)
        reserved = self._payload_bytes([], format, images)
        num_ctx = await self._resolve_num_ctx(
            sum(msg_len(m) for m in messages) + reserved
        )
        send, _ = fit_to_window(messages, num_ctx, reserved)
        return send, self._stream_options(num_ctx), self._stream_think()

    async def _generate_response(
        self,
        messages: list[Message],
        format: dict[str, Any] | None,
        images: list[str] | None,
        options: dict[str, Any],
        think: bool | None,
        async_client_type: Any,
    ) -> str:
        client = async_client_type(host=self.base_url)
        resp = await _bounded(
            client.chat(
                model=self.model,
                messages=attach_images(messages, images),
                format=format,
                options=options,
                keep_alive=self.keep_alive,
                think=think,
                stream=False,
            ),
            GENERATION_TIMEOUT_SECONDS,
            "never answered",
        )
        return resp.message.content or ""

    async def _digest_num_ctx(self, messages: list[Message]) -> int | None:
        if self.num_ctx is not None:
            return self.num_ctx
        if is_nonlocal_model(self.model):
            return None
        native = await native_context_length(self.model, self.base_url)
        return pick_num_ctx(sum(msg_len(message) for message in messages), native)

    async def _digest_options(
        self, messages: list[Message], num_predict: int
    ) -> dict[str, Any]:
        options: dict[str, Any] = {
            "num_predict": num_predict,
            "temperature": 0,
        }
        num_ctx = await self._digest_num_ctx(messages)
        if num_ctx is not None:
            options["num_ctx"] = num_ctx
        return options

    async def _digest_response(
        self,
        messages: list[Message],
        options: dict[str, Any],
        async_client_type: Any,
    ) -> str:
        client = async_client_type(host=self.base_url)
        think = self._stream_think()
        resp = await _bounded(
            client.chat(
                model=self.model,
                messages=messages,
                options=options,
                keep_alive=self.keep_alive,
                think=think,
                stream=False,
            ),
            REQUEST_TIMEOUT_SECONDS,
            "never answered",
        )
        return resp.message.content or ""

    async def _digest(self, text: str) -> str:
        """One compaction pass: a chunk of old conversation -> its durable facts.

        Deliberately NOT routed through :meth:`generate`: that resolves (and
        remembers) a ``num_ctx`` for the token bar, and a digest is bookkeeping,
        not a round of the user's turn — it must not show up as one. Bounded
        output, own window, no shared state touched.
        """
        from ollama import AsyncClient

        from .compaction import DIGEST_NUM_PREDICT, DIGEST_PROMPT

        messages: list[Message] = [
            {"role": "system", "content": DIGEST_PROMPT},
            {"role": "user", "content": text},
        ]
        options = await self._digest_options(messages, DIGEST_NUM_PREDICT)
        return await self._digest_response(messages, options, AsyncClient)

    def _stream_options(self, num_ctx: int | None) -> dict[str, Any]:
        """The optional Ollama knobs shared by a single text stream."""
        options: dict[str, Any] = {}
        if num_ctx is not None:
            options["num_ctx"] = num_ctx
        if self.num_predict is not None:
            options["num_predict"] = self.num_predict
        if self.temperature is not None:
            options["temperature"] = self.temperature
        return options

    def _stream_think(self) -> bool | None:
        return False if ("qwen3" in self.model and "instruct" not in self.model) else None

    async def _open_generate_stream(
        self,
        messages: list[Message],
        format: dict[str, Any] | None,
        images: list[str] | None,
        options: dict[str, Any],
        think: bool | None,
        async_client_type: Any,
    ) -> Any:
        """Open the Ollama stream with the same bounded first-response wait."""
        client = async_client_type(host=self.base_url)
        return await _bounded(
            client.chat(
                model=self.model,
                messages=attach_images(messages, images),
                format=format,
                options=options,
                keep_alive=self.keep_alive,
                think=think,
                stream=True,
            ),
            REQUEST_TIMEOUT_SECONDS,
            "never started answering",
        )

    async def _stream_deltas(self, stream: Any) -> AsyncIterator[str]:
        """Yield non-empty stream text while bounding each silent read."""
        chunks = stream.__aiter__()
        while True:
            try:
                part = await _bounded(
                    chunks.__anext__(),
                    REQUEST_TIMEOUT_SECONDS,
                    "stopped answering mid-reply",
                )
            except StopAsyncIteration:
                break
            delta = part.message.content or ""
            if delta:
                yield delta

    async def generate_stream(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg
        images: list[str] | None = None,
    ) -> AsyncIterator[str]:
        """Yield a tool-less Ollama text stream with its native call semantics."""
        from ollama import AsyncClient

        send, options, think = await self._prepare_generate_request(messages, format, images)
        stream = await self._open_generate_stream(
            send, format, images, options, think, AsyncClient
        )
        async for delta in self._stream_deltas(stream):
            yield delta

    async def _compact_stream_messages(
        self,
        messages: list[Message],
        reserved: int,
        num_ctx: int | None,
    ) -> tuple[list[Message], int | None]:
        budget = await self._compaction_budget(num_ctx, reserved)
        compacted, did = await compact_to_budget(
            messages,
            budget,
            self._digest,
            reserved,
            digest_chunk_bytes(
                num_ctx or await self._remote_window(), cloud=num_ctx is None
            ),
        )
        if not did:
            return messages, num_ctx
        num_ctx = await self._resolve_num_ctx(sum(msg_len(m) for m in compacted) + reserved)
        return compacted, num_ctx

    async def _prepare_stream(
        self, messages: list[Message], tools: list[dict[str, Any]]
    ) -> _StreamPreparation:
        send, _, engaged = guard_outbound(self.model, messages, self.privacy)
        self._require_image_input(send)
        restorer = engaged.restorer() if engaged else None
        reserved = json_chars(tools) if tools else 0
        num_ctx = await self._resolve_num_ctx(sum(msg_len(m) for m in send) + reserved)
        send, num_ctx = await self._compact_stream_messages(send, reserved, num_ctx)
        trim_messages_to_window(send, reserved, num_ctx)
        sent_bytes = sum(msg_len(m) for m in send) + reserved
        return _StreamPreparation(send, restorer, engaged, num_ctx, sent_bytes)

    def _bound_stream(
        self, preparation: _StreamPreparation, tools: list[dict[str, Any]]
    ) -> Any:
        llm: Any = self._llm(preparation.num_ctx)
        if tools:
            llm = llm.bind_tools(tools)
        return llm.astream(_to_langchain(preparation.messages))

    @staticmethod
    def _message_chunk(chunk: Any, message_chunk_type: Any) -> Any | None:
        if not isinstance(chunk, message_chunk_type):  # pragma: no cover - defensive
            return None
        return chunk

    @staticmethod
    def _merged_chunk(merged: Any | None, chunk: Any) -> Any:
        if merged is None:
            return chunk
        return merged + chunk

    @staticmethod
    def _restored_delta(chunk: Any, restorer: Any | None) -> str:
        delta = _chunk_text(chunk.content)
        if restorer is not None:
            return restorer.feed(delta)
        return delta

    @staticmethod
    async def _record_delta(parts: list[str], delta: str, on_delta: DeltaSink) -> None:
        if not delta:
            return
        parts.append(delta)
        await on_delta(delta)

    async def _flush_restorer(
        self, parts: list[str], on_delta: DeltaSink, restorer: Any | None
    ) -> None:
        if restorer is None:
            return
        await self._record_delta(parts, restorer.flush(), on_delta)

    def _raise_stream_stalled(self, exc: StreamStalled) -> None:
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            f"{self.model} sent nothing for {REQUEST_TIMEOUT_SECONDS:g}s and was stopped.",
        ) from exc

    async def _collect_stream(
        self,
        stream: Any,
        on_delta: DeltaSink,
        cancel: Optional[Cancellable],
        restorer: Any | None,
        message_chunk_type: Any,
    ) -> tuple[str, Any | None]:
        parts: list[str] = []
        merged: Any | None = None
        try:
            async for raw_chunk in iter_with_stop(stream, cancel, REQUEST_TIMEOUT_SECONDS):
                chunk = self._message_chunk(raw_chunk, message_chunk_type)
                if chunk is None:
                    continue
                merged = self._merged_chunk(merged, chunk)
                await self._record_delta(parts, self._restored_delta(chunk, restorer), on_delta)
        except StreamStalled as exc:
            self._raise_stream_stalled(exc)
        await self._flush_restorer(parts, on_delta, restorer)
        return "".join(parts), merged

    @staticmethod
    def _tool_arguments(
        tool_call: dict[str, Any], engaged: PrivacyPolicy | None
    ) -> dict[str, Any]:
        args = tool_call.get("args") or {}
        if engaged is not None:
            return engaged.restore_value(args)
        return args

    def _stream_tool_call(
        self, tool_call: dict[str, Any], index: int, engaged: PrivacyPolicy | None
    ) -> ToolCall | None:
        name = tool_call.get("name") or ""
        if not name:
            return None
        args = self._tool_arguments(tool_call, engaged)
        call_id = str(tool_call.get("id") or f"call_{index}")
        return ToolCall(
            name=name,
            arguments=args,
            id=call_id,
            raw={
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": args},
            },
        )

    def _emitted_tool_calls(
        self, merged: Any, engaged: PrivacyPolicy | None
    ) -> list[ToolCall]:
        calls: list[ToolCall] = []
        for index, tool_call in enumerate(merged.tool_calls or []):
            call = self._stream_tool_call(tool_call, index, engaged)
            if call is not None:
                calls.append(call)
        return calls

    def _stream_tool_calls(
        self,
        merged: Any | None,
        tools: list[dict[str, Any]],
        engaged: PrivacyPolicy | None,
    ) -> list[ToolCall]:
        if merged is None:
            return []
        if not tools:
            return []
        return self._emitted_tool_calls(merged, engaged)

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: DeltaSink,
        cancel: Optional[Cancellable] = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        from langchain_core.messages import AIMessageChunk

        preparation = await self._prepare_stream(messages, tools)
        stream = self._bound_stream(preparation, tools)
        content, merged = await self._collect_stream(
            stream, on_delta, cancel, preparation.restorer, AIMessageChunk
        )
        calls = self._stream_tool_calls(merged, tools, preparation.engaged_policy)
        usage = await self._round_usage(merged, preparation.num_ctx, preparation.sent_bytes)
        return content, calls, usage

    async def _usage_window(self, num_ctx: int | None) -> int:
        if num_ctx:
            return num_ctx
        if self._last_num_ctx:
            return self._last_num_ctx
        native = await native_context_length(self.model, self.base_url)
        return native or 128_000

    @staticmethod
    def _usage_metadata(merged: Any) -> Any:
        return getattr(merged, "usage_metadata", None) if merged is not None else None

    def _observe_usage_ratio(self, sent_bytes: int, meta: Any) -> None:
        if not sent_bytes:
            return
        if is_nonlocal_model(self.model):
            return
        observe_token_ratio(sent_bytes, meta.get("input_tokens") or 0)

    async def _round_usage(
        self, merged: Any, num_ctx: int | None = None, sent_bytes: int = 0
    ) -> RoundUsage:
        """Return engine-reported input usage, or the estimate fallback signal."""
        max_context = await self._usage_window(num_ctx)
        meta = self._usage_metadata(merged)
        if not meta:
            return RoundUsage(input_tokens=None, max_context=max_context, is_real=False)
        self._observe_usage_ratio(sent_bytes, meta)
        return RoundUsage(
            input_tokens=meta.get("input_tokens"),
            max_context=max_context,
            is_real=True,
        )


__all__ = [
    "ChatModel",
    "OllamaChatModel",
    "DeltaSink",
    "Cancellable",
    "RoundUsage",
    "StreamStalled",
    "iter_with_stop",
]
