"""The chat model seam.

The graph talks to a :class:`ChatModel` — one async method that streams deltas
and returns ``(content, tool_calls)``. The real implementation wraps
``langchain_ollama.ChatOllama``; the tests inject a scripted fake. Keeping the
model behind this seam is what makes the whole round loop testable with no
network, no Ollama and no weights.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Protocol

from .config import KEEP_ALIVE_WARM, num_ctx_for_chat
from .messages import Message, ToolCall, attach_images
from .model_limits import native_context_length
from .privacy import PrivacyPolicy, guard_outbound

#: Called with each streamed text delta.
DeltaSink = Callable[[str], Awaitable[None]]


@dataclass(slots=True)
class RoundUsage:
    """One round's token accounting, for the chat token-budget bar.

    ``input_tokens``/``output_tokens`` are the engine's own report (Ollama's
    ``prompt_eval_count``/``eval_count``, surfaced by ``langchain_ollama`` as
    ``usage_metadata``) when available; ``None`` when the engine reported
    nothing, in which case the caller falls back to a char-length estimate.
    ``max_context`` is the model's real advertised context length (from
    Ollama's own catalog — see ``model_limits.native_context_length``), not
    the smaller RAM-adaptive ``num_ctx`` window we actually throttle Ollama to
    for this session (CHG-32 pins that stable for the whole turn, but users
    expect the bar to show what the model itself is capable of).
    """

    input_tokens: int | None
    output_tokens: int | None
    max_context: int
    is_real: bool


class Cancellable(Protocol):
    """Anything with a ``cancelled`` flag — the ask's Stop button, structurally.

    Typed here rather than importing ``graph.CancelToken`` to avoid a circular
    import (``graph`` imports ``chat``).
    """

    @property
    def cancelled(self) -> bool: ...


class ChatModel(Protocol):
    """One model round."""

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: DeltaSink,
        cancel: Optional[Cancellable] = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        """Stream one assistant turn. ``tools`` may be empty — that is the
        tool-less final round, and it must NOT be treated as "no tools argument".

        ``cancel`` is the Stop button: Stop must break the token stream mid-flight
        (agent.rs:1361 threads the cancel token into ``chat_stream_tools``, honoured
        at ollama.rs:521), not merely between rounds — otherwise a plain single-
        stream answer keeps typing after the user pressed Stop.

        Returns ``(content, tool_calls, usage)`` — ``usage`` feeds the chat
        token-budget bar (see :class:`RoundUsage`)."""
        ...


def _to_langchain(messages: list[Message]) -> list[Any]:
    """Ollama-shaped dicts -> LangChain message objects."""
    from langchain_core.messages import (
        AIMessage,
        HumanMessage,
        SystemMessage,
        ToolMessage,
    )

    out: list[Any] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "") or ""
        if role == "system":
            out.append(SystemMessage(content=content))
        elif role == "user":
            images = m.get("images") or []
            if images:
                # Ollama reads images from user turns. LangChain carries them as
                # data-URI image blocks.
                blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
                blocks += [
                    {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"}
                    for b64 in images
                ]
                out.append(HumanMessage(content=blocks))
            else:
                out.append(HumanMessage(content=content))
        elif role == "assistant":
            raw_calls = m.get("tool_calls") or []
            lc_calls = []
            for i, rc in enumerate(raw_calls):
                fn = rc.get("function", {}) if isinstance(rc, dict) else {}
                lc_calls.append(
                    {
                        "name": fn.get("name", ""),
                        "args": fn.get("arguments", {}) or {},
                        "id": str(rc.get("id") or f"call_{i}"),
                        "type": "tool_call",
                    }
                )
            out.append(AIMessage(content=content, tool_calls=lc_calls))
        elif role == "tool":
            out.append(
                ToolMessage(
                    content=content,
                    name=m.get("tool_name", "tool"),
                    tool_call_id=m.get("tool_call_id") or m.get("tool_name") or "tool",
                )
            )
    return out


def _chunk_text(content: Any) -> str:
    """A chunk's text, whether the provider sends a str or content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return ""


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
    ) -> None:
        self.model = model
        self.base_url = base_url
        self.temperature = temperature
        # RAM-adaptive by default (ollama.rs:224): 24576 on 32 GB+, 12288 below.
        self.num_ctx = num_ctx if num_ctx is not None else num_ctx_for_chat()
        # Optional output-token cap. None = no cap (chat's default). A background
        # job sets this so a degenerate repetition loop can't generate until it
        # fills the whole num_ctx window (~72 min on a 4B) — it stops at the cap.
        self.num_predict = num_predict
        self.keep_alive = keep_alive
        # PRIV-1: the /run handler attaches the room's resolved policy here; the
        # agent loop then talks to a ``:cloud`` model only through the door.
        self.privacy: PrivacyPolicy | None = None

    def _llm(self) -> Any:
        from langchain_ollama import ChatOllama

        kwargs: dict[str, Any] = {
            "model": self.model,
            "base_url": self.base_url,
            # CHG-32: pin the window so the tool-less final round doesn't shrink
            # it mid-answer.
            "num_ctx": self.num_ctx,
            # HLT-5: the chat model stays warm throughout the conversation.
            "keep_alive": self.keep_alive,
        }
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

        options: dict[str, Any] = {"num_ctx": self.num_ctx}
        if self.num_predict is not None:
            options["num_predict"] = self.num_predict
        if self.temperature is not None:
            options["temperature"] = self.temperature
        # ollama.rs:505 — only qwen3 non-instruct models accept (and need) the flag.
        think = False if ("qwen3" in self.model and "instruct" not in self.model) else None
        client = AsyncClient(host=self.base_url)
        resp = await client.chat(
            model=self.model,
            messages=attach_images(messages, images),
            format=format,
            options=options,
            keep_alive=self.keep_alive,
            think=think,
            stream=False,
        )
        return resp.message.content or ""

    async def generate_stream(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg
        images: list[str] | None = None,
    ) -> AsyncIterator[str]:
        """One STREAMING tool-less turn (MIGRATION Phase 1: ollama.rs ``chat_core``
        streaming text, reached via ``chat_stream_tools`` with no tools).

        The streaming twin of :meth:`generate`: same ``ollama`` python-client wire
        call so the tokens match the old native path byte for byte — identical
        ``options.num_ctx``/``temperature``, ``keep_alive``, ``format`` grammar, and
        the same qwen3 ``think`` rule (thinking variants burn thousands of hidden
        reasoning tokens, so disable it for them and leave every other model's
        default alone — ollama.rs:505). ``images`` ride on the last user turn
        (vision). Yields each text delta in order; callers concatenate for the full
        answer. Tool calls are intentionally not surfaced — this is tool-less text.
        """
        from ollama import AsyncClient

        options: dict[str, Any] = {"num_ctx": self.num_ctx}
        if self.num_predict is not None:
            options["num_predict"] = self.num_predict
        if self.temperature is not None:
            options["temperature"] = self.temperature
        # ollama.rs:505 — only qwen3 non-instruct models accept (and need) the flag.
        think = False if ("qwen3" in self.model and "instruct" not in self.model) else None
        client = AsyncClient(host=self.base_url)
        stream = await client.chat(
            model=self.model,
            messages=attach_images(messages, images),
            format=format,
            options=options,
            keep_alive=self.keep_alive,
            think=think,
            stream=True,
        )
        async for part in stream:
            delta = part.message.content or ""
            if delta:
                yield delta

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: DeltaSink,
        cancel: Optional[Cancellable] = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        from langchain_core.messages import AIMessageChunk

        # PRIV-1: every round of the agent loop passes the door — the composed
        # history (system prompt, question, tool results with document text) is
        # redacted for a non-local model, and the reply deltas are restored so
        # the user (and the locally-running tools) see real values.
        send, _, engaged = guard_outbound(self.model, messages, self.privacy)
        restorer = engaged.restorer() if engaged else None

        llm: Any = self._llm()
        if tools:
            llm = llm.bind_tools(tools)

        parts: list[str] = []
        merged: AIMessageChunk | None = None
        stream = llm.astream(_to_langchain(send))
        async for chunk in stream:
            # ADD-7 / F1: Stop must break the token stream mid-flight, not only
            # between rounds. On the plain-chat path the whole answer is one
            # stream, so without this Stop is a no-op until generation finishes.
            if cancel is not None and cancel.cancelled:
                aclose = getattr(stream, "aclose", None)
                if aclose is not None:
                    await aclose()
                break
            if not isinstance(chunk, AIMessageChunk):  # pragma: no cover - defensive
                continue
            merged = chunk if merged is None else merged + chunk
            delta = _chunk_text(chunk.content)
            if restorer is not None:
                delta = restorer.feed(delta)
            if delta:
                parts.append(delta)
                await on_delta(delta)
        if restorer is not None:
            tail = restorer.flush()
            if tail:
                parts.append(tail)
                await on_delta(tail)

        content = "".join(parts)
        calls: list[ToolCall] = []
        # The final round offers zero tools; anything the model still emits is
        # ignored by the graph, but don't manufacture calls out of nothing.
        if merged is not None and tools:
            for i, tc in enumerate(merged.tool_calls or []):
                name = tc.get("name") or ""
                if not name:
                    continue
                args = tc.get("args") or {}
                if engaged is not None:
                    args = engaged.restore_value(args)
                call_id = str(tc.get("id") or f"call_{i}")
                calls.append(
                    ToolCall(
                        name=name,
                        arguments=args,
                        id=call_id,
                        raw={
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": args},
                        },
                    )
                )
        return content, calls, await self._round_usage(merged)

    async def _round_usage(self, merged: Any) -> RoundUsage:
        """Real usage when Ollama reported it, else the char-estimate fallback
        signal (``is_real=False`` — the caller substitutes its own estimate).

        ``max_context`` is the model's real advertised context length (Ollama's
        own catalog, confirmed live 2026-07-21 to work for both local and
        ``:cloud`` models) — NOT ``self.num_ctx``, which is only the smaller
        RAM-adaptive WORKING window we throttle Ollama to for speed. Falls
        back to that working window if the catalog lookup fails."""
        max_context = await native_context_length(self.model, self.base_url) or self.num_ctx
        meta = getattr(merged, "usage_metadata", None) if merged is not None else None
        if meta:
            return RoundUsage(
                input_tokens=meta.get("input_tokens"),
                output_tokens=meta.get("output_tokens"),
                max_context=max_context,
                is_real=True,
            )
        return RoundUsage(
            input_tokens=None, output_tokens=None, max_context=max_context, is_real=False
        )


__all__ = ["ChatModel", "OllamaChatModel", "DeltaSink", "Cancellable", "RoundUsage"]
