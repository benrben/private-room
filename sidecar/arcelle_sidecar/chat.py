"""The chat model seam.

The graph talks to a :class:`ChatModel` — one async method that streams deltas
and returns ``(content, tool_calls)``. The real implementation wraps
``langchain_ollama.ChatOllama``; the tests inject a scripted fake. Keeping the
model behind this seam is what makes the whole round loop testable with no
network, no Ollama and no weights.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Protocol

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

#: Called with each streamed text delta.
DeltaSink = Callable[[str], Awaitable[None]]

#: How long a local call may wait on a SILENT daemon, in seconds. Nothing used
#: to bound these requests at all: the `ollama` client defaults to no timeout,
#: and Stop only breaks the token loop once tokens are arriving — so a daemon
#: that wedges before the first one (a model that will not load, a stuck GPU)
#: hung the turn with no way out but quitting the app. Generous, because a cold
#: load of a large local model is genuinely slow; the point is that the wait
#: ENDS, with an engine error the caller can report, rather than never.
#:
#: A bound on SILENCE, not on duration: it is applied per streamed chunk and per
#: read, so a reply that keeps arriving may take as long as it likes.
REQUEST_TIMEOUT_SECONDS: float = 600.0

#: The same limit for the LangChain path, which owns its httpx client: applied
#: per read rather than to the whole generation, so a long answer that keeps
#: streaming is never cut off.
REQUEST_TIMEOUT = httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=10.0)

#: How long a NON-streaming generation may take in total. This is the one path
#: with no liveness signal — nothing comes back until the whole answer exists —
#: so the only bound available is a duration, and it must not decide on the
#: caller's behalf that slow work has failed. The work behind it is the slow
#: kind: a whole-file-pass section, a document-length translation (8192 output
#: tokens), a cold load of a large model on top of either — minutes to tens of
#: minutes on a local model. Ten minutes killed those mid-work.
#:
#: Sized at the HOST's own budget for one generation
#: (``src-tauri/src/sidecar.rs`` ``SIDECAR_TIMEOUT``, 3600s), so the sidecar
#: never gives up on work the host is still waiting for, and a wedge on a chain
#: endpoint (whose host budget is ten hours) still ends here.
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


@dataclass(slots=True)
class RoundUsage:
    """One round's token accounting, for the chat token-budget bar.

    ``input_tokens`` is the engine's own report (Ollama's
    ``prompt_eval_count``, surfaced by ``langchain_ollama`` as
    ``usage_metadata``) when available; ``None`` when the engine reported
    nothing, in which case the caller falls back to a char-length estimate.
    The reply's own token count is deliberately NOT carried: the bar bills
    what went IN (``usage.build_usage_event``), and a field nothing reads is
    a field that quietly rots.
    ``max_context`` is the window the call actually ran in: the payload-fitted
    ``num_ctx`` the app requested for a local model (see
    ``model_limits.pick_num_ctx``), or the model's advertised native length
    for non-local models, whose window lives on the remote side.
    """

    input_tokens: int | None
    max_context: int
    is_real: bool


class Cancellable(Protocol):
    """Anything with a ``cancelled`` flag — the ask's Stop button, structurally.

    Typed here rather than importing ``graph.CancelToken`` to avoid a circular
    import (``graph`` imports ``chat``).
    """

    @property
    def cancelled(self) -> bool: ...


class StreamStalled(Exception):
    """Nothing arrived on the token stream for the whole silence budget.

    Carries no message — the call site names the engine it was waiting on.
    """


#: How often :func:`iter_with_stop` wakes to sample Stop while no chunk has
#: arrived. Mirrors ``external_llm._POLL_SECS`` (the CLI half of the same
#: watchdog) so Stop feels equally prompt on both engine families.
_STOP_POLL_SECS = 0.25


async def _abandon(task: "asyncio.Future[Any]") -> None:
    """Cancel a pending ``__anext__`` and reap it, so no task outlives the read."""
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, StopAsyncIteration):
        pass
    except Exception:  # noqa: BLE001 - the read is being abandoned either way
        pass


async def iter_with_stop(
    stream: Any,
    cancel: Optional[Cancellable],
    idle: float,
) -> AsyncIterator[Any]:
    """Yield from ``stream``, sampling Stop *while waiting for* the next chunk.

    ``async for`` only reaches its body once a chunk arrives, so the plain loop
    this replaces sampled the Stop flag exactly when the stream was healthy and
    never when it was not. A model that goes quiet — Ollama loading weights, a
    provider holding the connection open, a wedged socket — therefore swallowed
    Stop entirely: the flag was set, nothing read it, and the turn ran on. Live
    QA (2026-08-03) hit this as "Stop this answer did not stop Claude, local, or
    other long-running work", and as Main agents queued behind a stalled
    specialist forever, because the stalled wave never returned to a flag check.

    Rust already learned this lesson on the ``#command`` path
    (``chat_commands::watch_stream``) — the same race, the same fix, one layer
    down. This is the sidecar's own copy.

    ``idle`` bounds SILENCE, not duration: the deadline resets on every chunk, so
    an answer that keeps arriving may take as long as it likes. Exceeding it
    raises :class:`StreamStalled`; tripping ``cancel`` simply stops iteration, so
    the caller keeps the partial the user already watched arrive.
    """
    it = stream.__aiter__()
    aborted = False
    try:
        while True:
            nxt = asyncio.ensure_future(it.__anext__())
            deadline = time.monotonic() + idle
            while True:
                done, _pending = await asyncio.wait({nxt}, timeout=_STOP_POLL_SECS)
                if done:
                    break
                if cancel is not None and cancel.cancelled:
                    aborted = True
                    await _abandon(nxt)
                    return
                if time.monotonic() >= deadline:
                    aborted = True
                    await _abandon(nxt)
                    raise StreamStalled
            try:
                chunk = nxt.result()
            except StopAsyncIteration:
                return
            # Also sample once the chunk is in hand: a stream that is never idle
            # (a fast local model, a buffered replay) never reaches the wait
            # branch above, and Stop must still land BEFORE this chunk is
            # processed — that is the in-flight break ADD-7 / F1 added.
            if cancel is not None and cancel.cancelled:
                aborted = True
                return
            yield chunk
    finally:
        # Only when we walked away mid-read: a stream drained to StopAsyncIteration
        # has already closed itself, and closing a live one the caller merely broke
        # out of is the caller's call, not ours.
        if aborted:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # noqa: BLE001 - best-effort close
                    pass


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
        # Explicit caller override. When None, each LOCAL call computes a
        # payload-fitted window instead (``_resolve_num_ctx``): the daemon's
        # own default is ~4k tokens and it silently context-shifts the front
        # of an oversized prompt away — the "Done." live regression. `:cloud`
        # models keep None (their window is remote and already the native one).
        self.num_ctx = num_ctx
        # Optional output-token cap. None = no app-level cap.
        self.num_predict = num_predict
        self.keep_alive = keep_alive
        # The window the LAST call actually requested — the truthful
        # ``max_context`` for the token bar (the native length is a capability
        # ceiling, not what the running request can actually hold).
        self._last_num_ctx: int | None = num_ctx
        # PRIV-1: the /run handler attaches the room's resolved policy here; the
        # agent loop then talks to a ``:cloud`` model only through the door.
        self.privacy: PrivacyPolicy | None = None

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
            # The agent loop's rounds run through here, so this is where a
            # wedged daemon hangs the user's turn (see REQUEST_TIMEOUT).
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

        options: dict[str, Any] = {}
        # What the payload costs BESIDES the messages: the grammar and any
        # top-level images. Both ride the same window, and neither can be cut,
        # so they are reserved rather than trimmed.
        reserved = self._payload_bytes([], format, images)
        num_ctx = await self._resolve_num_ctx(
            sum(msg_len(m) for m in messages) + reserved
        )
        # A job's payload can be bigger than the biggest window this Mac may ask
        # for — a whole-file pass section, a translation of a long document. Cut
        # it here, visibly, instead of letting the daemon delete the front of the
        # prompt (the instruction) and return a plausible answer to a question it
        # can no longer see.
        send, _ = fit_to_window(messages, num_ctx, reserved)
        if num_ctx is not None:
            options["num_ctx"] = num_ctx
        if self.num_predict is not None:
            options["num_predict"] = self.num_predict
        if self.temperature is not None:
            options["temperature"] = self.temperature
        # ollama.rs:505 — only qwen3 non-instruct models accept (and need) the flag.
        think = False if ("qwen3" in self.model and "instruct" not in self.model) else None
        client = AsyncClient(host=self.base_url)
        # Bounded (see GENERATION_TIMEOUT_SECONDS): a non-streaming call returns
        # nothing until the whole answer exists, so a daemon that never answers
        # held this await open for the life of the process. Bounded at the
        # HOST's own one-generation budget rather than the silence budget — the
        # jobs on this path (a file-pass section, a long translation) are
        # legitimately slow, and cutting one off mid-work is the failure this
        # bound is not for.
        resp = await _bounded(
            client.chat(
                model=self.model,
                messages=attach_images(send, images),
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

    async def _digest(self, text: str) -> str:
        """One compaction pass: a chunk of old conversation -> its durable facts.

        Deliberately NOT routed through :meth:`generate`: that resolves (and
        remembers) a ``num_ctx`` for the token bar, and a digest is bookkeeping,
        not a round of the user's turn — it must not show up as one. Bounded
        output, own window, no shared state touched.
        """
        from ollama import AsyncClient

        from .compaction import DIGEST_NUM_PREDICT, DIGEST_PROMPT

        msgs: list[Message] = [
            {"role": "system", "content": DIGEST_PROMPT},
            {"role": "user", "content": text},
        ]
        options: dict[str, Any] = {
            "num_predict": DIGEST_NUM_PREDICT,
            "temperature": 0,
        }
        if self.num_ctx is not None:
            options["num_ctx"] = self.num_ctx
        elif not is_nonlocal_model(self.model):
            native = await native_context_length(self.model, self.base_url)
            options["num_ctx"] = pick_num_ctx(
                sum(msg_len(m) for m in msgs), native
            )
        # Same think rule as `generate` (ollama.rs:505): a thinking model spends
        # the whole num_predict on hidden reasoning and returns empty content.
        think = False if ("qwen3" in self.model and "instruct" not in self.model) else None
        client = AsyncClient(host=self.base_url)
        # The silence budget, not the generation one: a digest is bookkeeping
        # with a 400-token ceiling on its output, so ten minutes of nothing is a
        # wedge. A failed digest never fails the turn — `compact_to_budget`
        # catches it and the conversation goes out uncompacted.
        resp = await _bounded(
            client.chat(
                model=self.model,
                messages=msgs,
                options=options,
                keep_alive=self.keep_alive,
                think=think,
                stream=False,
            ),
            REQUEST_TIMEOUT_SECONDS,
            "never answered",
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

        options: dict[str, Any] = {}
        reserved = self._payload_bytes([], format, images)
        num_ctx = await self._resolve_num_ctx(
            sum(msg_len(m) for m in messages) + reserved
        )
        # Same last-resort fit as `generate`: an oversized one-shot payload is
        # cut here, with a marker, rather than by the daemon, silently, from the
        # front.
        send, _ = fit_to_window(messages, num_ctx, reserved)
        if num_ctx is not None:
            options["num_ctx"] = num_ctx
        if self.num_predict is not None:
            options["num_predict"] = self.num_predict
        if self.temperature is not None:
            options["temperature"] = self.temperature
        # ollama.rs:505 — only qwen3 non-instruct models accept (and need) the flag.
        think = False if ("qwen3" in self.model and "instruct" not in self.model) else None
        client = AsyncClient(host=self.base_url)
        stream = await _bounded(
            client.chat(
                model=self.model,
                messages=attach_images(send, images),
                format=format,
                options=options,
                keep_alive=self.keep_alive,
                think=think,
                stream=True,
            ),
            REQUEST_TIMEOUT_SECONDS,
            "never started answering",
        )
        # Bounded per CHUNK, not for the whole answer: a reply that keeps
        # arriving may take as long as it likes, but a daemon that stops
        # answering mid-stream — or never starts — ends the wait with an error
        # instead of a spinner nothing can cancel.
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

        reserved = json_chars(tools) if tools else 0
        num_ctx = await self._resolve_num_ctx(
            sum(msg_len(m) for m in send) + reserved
        )
        # COMPACT before truncating. Both make the payload fit; only this one
        # keeps the facts. Measured 2026-07-28: at the same byte budget a
        # digested transcript scored 0.44 vs 0.25 (2B) and 1.00 vs 0.25 (32B)
        # on a revision-tracking task, and a compacted 12 KB matched a raw
        # 176 KB on 19x fewer prompt tokens. See :mod:`.compaction`.
        #
        # A `:cloud` model has no local `num_ctx` — this used to make compaction
        # a no-op for it, which meant the one engine where every byte is BILLED
        # was the one re-sending the whole transcript every round. It advertises
        # its real remote window through the same catalog `native_context_length`
        # reads, so budget against that instead, at the gentler cloud fraction.
        # Unknown window -> None -> unchanged behaviour, as before.
        budget = await self._compaction_budget(num_ctx, reserved)
        compacted, did = await compact_to_budget(
            send,
            budget,
            self._digest,
            reserved,
            digest_chunk_bytes(
                num_ctx or await self._remote_window(), cloud=num_ctx is None
            ),
        )
        if did:
            # Re-fit the window to what is ACTUALLY going out. `num_ctx` above
            # was sized to the raw payload, and the host now hands over the
            # whole conversation — so without this a 200 KB history would ask
            # Ollama for the 64k bucket and then send ~32k tokens into it,
            # allocating twice the KV cache the call needs (measured elsewhere
            # in this module at 64k ctx -> 7.7 GB on a 16 GB Mac). Still a
            # bucket, so it stays byte-stable across the rounds of a turn and
            # the prompt cache stays warm.
            num_ctx = await self._resolve_num_ctx(
                sum(msg_len(m) for m in compacted) + reserved
            )
            # Rebind rather than mutate: compaction REPLACES turns with a
            # digest, so an in-place edit would corrupt the caller's history
            # (guard_outbound hands back the caller's own list for a local
            # model). The trim below still runs, as the last resort it was.
            send = compacted
        # Last resort: the round loop can outgrow even the largest window this
        # Mac may ask for (a big attachment, a whole fetched page, a chatty
        # connector result). Shrink it deliberately here rather than letting the
        # daemon context-shift the system prompt and the question away.
        #
        # Mutates in place, and that is the contract (it was the deleted Rust
        # `trim_messages_to_budget`'s too): for a LOCAL model `guard_outbound`
        # returns the caller's own list, so a stubbed tool result stays stubbed
        # for the rest of the turn instead of re-growing and being re-trimmed
        # every round. A non-local model takes the other branch — `num_ctx` is
        # None there, so this returns immediately and a cloud model never loses
        # a byte to us.
        trim_messages_to_window(send, reserved, num_ctx)
        # What we are ACTUALLY about to send, after compaction and the trim —
        # the numerator of the bytes-per-token calibration `_round_usage`
        # feeds. Measured here and threaded through for the same reason
        # `num_ctx` is: one ChatModel is shared by every concurrent delegation
        # child, so instance state would be last-writer-wins.
        sent_bytes = sum(msg_len(m) for m in send) + reserved
        llm: Any = self._llm(num_ctx)
        if tools:
            llm = llm.bind_tools(tools)

        parts: list[str] = []
        merged: AIMessageChunk | None = None
        stream = llm.astream(_to_langchain(send))
        # ADD-7 / F1: Stop must break the token stream mid-flight, not only
        # between rounds. On the plain-chat path the whole answer is one
        # stream, so without this Stop is a no-op until generation finishes.
        #
        # The check used to sit in the loop body, which meant it ran only once a
        # chunk had already arrived — i.e. never on the stalls it existed for.
        # `iter_with_stop` polls the flag WHILE the read is outstanding and
        # bounds the silence, so a daemon that wedges before the first token
        # ends the turn instead of hanging it (see live QA 2026-08-03).
        try:
            guarded = iter_with_stop(stream, cancel, REQUEST_TIMEOUT_SECONDS)
            async for chunk in guarded:
                if not isinstance(chunk, AIMessageChunk):  # pragma: no cover - defensive
                    continue
                merged = chunk if merged is None else merged + chunk
                delta = _chunk_text(chunk.content)
                if restorer is not None:
                    delta = restorer.feed(delta)
                if delta:
                    parts.append(delta)
                    await on_delta(delta)
        except StreamStalled as exc:
            # Silent for the whole budget: report it as an engine error rather
            # than hand back a partial that reads like a finished answer. Same
            # contract the CLI path uses for a wedged child (external_llm).
            # Imported here, not at module scope: `llm` imports THIS module.
            from .llm import LlmError

            raise LlmError(
                "ENGINE_ERROR",
                f"{self.model} sent nothing for {REQUEST_TIMEOUT_SECONDS:g}s "
                "and was stopped.",
            ) from exc
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
        return content, calls, await self._round_usage(merged, num_ctx, sent_bytes)

    async def _round_usage(
        self, merged: Any, num_ctx: int | None = None, sent_bytes: int = 0
    ) -> RoundUsage:
        """Real usage when Ollama reported it, else the char-estimate fallback
        signal (``is_real=False`` — the caller substitutes its own estimate).

        ``max_context`` is the window the last call ACTUALLY requested
        (payload-fitted ``num_ctx``) — the pre-fix bar divided real usage by
        the 262k native length while the running window was 4k, showing "1%
        used" on a turn that had already overflowed. Non-local models have no
        local window, so they keep the native advertised length (Ollama's own
        catalog, confirmed live 2026-07-21 for ``:cloud`` models too)."""
        # THIS call's window, passed in from the frame that chose it — not
        # `self._last_num_ctx`. One ChatModel instance is shared by every
        # concurrent delegation child (graph.Deps holds a single `chat`), so
        # instance state here is last-writer-wins: two local siblings whose
        # payloads land in different NUM_CTX_BUCKETS published each other's
        # denominator and the token bar told the user the wrong thing. That is
        # the same class of untruthful bar the 2026-07-21 live QA already fixed
        # once. `_last_num_ctx` stays as the fallback for any caller that has
        # not threaded the value through.
        max_context = (
            num_ctx
            or self._last_num_ctx
            or await native_context_length(self.model, self.base_url)
            or 128_000
        )
        meta = getattr(merged, "usage_metadata", None) if merged is not None else None
        if meta:
            # Close the loop: the engine just told us how many tokens the bytes
            # we sent actually became. Every context budget in the app was
            # GUESSING that ratio at a flat 3 B/token — measured, real content
            # runs 2.5 to 5.9 — so feed the truth back rather than ship the
            # guess. Local only: a non-local model has no window we size.
            if sent_bytes and not is_nonlocal_model(self.model):
                observe_token_ratio(sent_bytes, meta.get("input_tokens") or 0)
            return RoundUsage(
                input_tokens=meta.get("input_tokens"),
                max_context=max_context,
                is_real=True,
            )
        return RoundUsage(input_tokens=None, max_context=max_context, is_real=False)


__all__ = [
    "ChatModel",
    "OllamaChatModel",
    "DeltaSink",
    "Cancellable",
    "RoundUsage",
    "StreamStalled",
    "iter_with_stop",
]
