"""Streaming cancellation seam and chat protocol types."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Protocol

from .messages import Message, ToolCall
from .privacy import PrivacyPolicy

DeltaSink = Callable[[str], Awaitable[None]]

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


@dataclass(slots=True)
class _StreamPreparation:
    """The request state chosen before opening one LangChain token stream."""

    messages: list[Message]
    restorer: Any | None
    engaged_policy: PrivacyPolicy | None
    num_ctx: int | None
    sent_bytes: int


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
_END_OF_STREAM = object()


@dataclass(slots=True)
class _StreamStopState:
    """Whether this iterator, rather than its consumer, ended the stream."""

    aborted: bool = False


async def _abandon(task: "asyncio.Future[Any]") -> None:
    """Cancel a pending ``__anext__`` and reap it, so no task outlives the read."""
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, StopAsyncIteration):
        pass
    except Exception:  # noqa: BLE001 - the read is being abandoned either way
        pass


def _stop_requested(cancel: Optional[Cancellable]) -> bool:
    return cancel is not None and cancel.cancelled


async def _wait_for_next(
    task: "asyncio.Future[Any]",
    cancel: Optional[Cancellable],
    deadline: float,
    state: _StreamStopState,
) -> bool:
    """Wait for one read, returning false only when Stop won the race."""
    while True:
        done, _pending = await asyncio.wait({task}, timeout=_STOP_POLL_SECS)
        if done:
            return True
        if _stop_requested(cancel):
            state.aborted = True
            await _abandon(task)
            return False
        if time.monotonic() >= deadline:
            state.aborted = True
            await _abandon(task)
            raise StreamStalled


def _completed_chunk(
    task: "asyncio.Future[Any]", cancel: Optional[Cancellable], state: _StreamStopState
) -> Any:
    """Return a completed read, stopping before a buffered chunk is handled."""
    try:
        chunk = task.result()
    except StopAsyncIteration:
        return _END_OF_STREAM
    # A stream that is never idle (a fast local model or buffered replay) never
    # reaches the wait branch, so Stop must still land before this chunk is
    # processed.
    if _stop_requested(cancel):
        state.aborted = True
        return _END_OF_STREAM
    return chunk


async def _close_aborted_stream(stream: Any) -> None:
    """Best-effort close for the read this iterator deliberately stopped."""
    aclose = getattr(stream, "aclose", None)
    if aclose is None:
        return
    try:
        await aclose()
    except Exception:  # noqa: BLE001 - best-effort close
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
    state = _StreamStopState()
    try:
        while True:
            nxt = asyncio.ensure_future(it.__anext__())
            deadline = time.monotonic() + idle
            if not await _wait_for_next(nxt, cancel, deadline, state):
                return
            chunk = _completed_chunk(nxt, cancel, state)
            if chunk is _END_OF_STREAM:
                return
            yield chunk
    finally:
        # Only when we walked away mid-read: a stream drained to StopAsyncIteration
        # has already closed itself, and closing a live one the caller merely broke
        # out of is the caller's call, not ours.
        if state.aborted:
            await _close_aborted_stream(stream)


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
