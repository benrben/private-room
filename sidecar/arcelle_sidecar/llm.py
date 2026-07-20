"""The LLM gateway (MIGRATION Phase 1).

The sidecar is the app's SOLE AI service: Rust gathers text from the encrypted DB
and calls these endpoints; all model I/O happens here. This module is the thin
seam over the local Ollama server for the NON-agent calls (embeddings, one-shot
structured/vision generation, and model management). The tool-using AGENT turns
still flow through :mod:`.graph` + :mod:`.chat`; this is everything else.

Privacy (SPEC §6): the Ollama server is loopback-only and every LangSmith/
LangChain tracing var is stripped at package import (:func:`..disable_tracing`),
so nothing here can POST the user's private text off-box. We talk to Ollama with
the ``ollama`` python client — no tracing callbacks, no telemetry.

Error contract: Rust callers branch on two sentinel error codes that predate this
migration (``OLLAMA_DOWN`` when the daemon is unreachable, ``MODEL_MISSING`` when a
model was never pulled — see ollama.rs ``check_model_response``/``map_send_err``).
We classify the ollama-client exceptions back into those codes so the Rust gateway
can reconstruct the exact same error strings its callers already match on.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

import httpx
from fastapi.responses import JSONResponse
from ollama import AsyncClient, ResponseError

from . import external_llm
from . import privacy as privacy_mod
from .chat import OllamaChatModel
from .messages import Message

#: HTTP status the gateway routes use for a classified engine failure. Any non-2xx
#: makes the Rust side read the ``code``; 502 (bad upstream) is the honest one —
#: the sidecar itself is fine, the Ollama server behind it failed.
_ENGINE_ERROR_STATUS = 502


class LlmError(Exception):
    """A classified Ollama failure the routes turn into a ``{code,error}`` body.

    ``code`` is one of ``OLLAMA_DOWN`` / ``MODEL_MISSING`` / ``ENGINE_ERROR``. The
    Rust gateway maps ``MODEL_MISSING`` back to ``MODEL_MISSING:<model>`` (it knows
    the model name) and ``OLLAMA_DOWN`` straight through, preserving the pre-
    migration error surfaces that summarize.rs / jobs.rs / file_pass.rs match on.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def response(self) -> JSONResponse:
        return JSONResponse(
            status_code=_ENGINE_ERROR_STATUS,
            content={"error": self.message, "code": self.code},
        )


def _classify(exc: Exception) -> LlmError:
    """Map an ollama-client / transport exception to the sentinel error contract.

    Mirrors ollama.rs: a 404 whose body says "not found" is a model that was never
    pulled (``MODEL_MISSING``); a connect/timeout failure is a dead or unreachable
    daemon (``OLLAMA_DOWN``, same as the Rust ``map_send_err``); anything else is a
    plain engine error.
    """
    if isinstance(exc, LlmError):
        return exc
    if isinstance(exc, ResponseError):
        status = getattr(exc, "status_code", -1)
        msg = getattr(exc, "error", None) or str(exc)
        if status == 404 and "not found" in msg.lower():
            return LlmError("MODEL_MISSING", msg)
        return LlmError("ENGINE_ERROR", msg)
    # Connect refused / DNS / timeout: the daemon is down or unreachable. The old
    # Rust path mapped both is_connect() and is_timeout() to OLLAMA_DOWN.
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.TimeoutException, ConnectionError)):
        return LlmError("OLLAMA_DOWN", str(exc))
    return LlmError("ENGINE_ERROR", str(exc))


async def embed(
    model: str,
    texts: list[str],
    base_url: str,
    keep_alive: str | None = None,
    *,
    privacy: dict[str, Any] | None = None,
) -> list[list[float]]:
    """One embedding vector per input text, in order (ollama.rs ``embed``).

    PRIV-1: embedding models are local in practice, but if one ever carries the
    ``:cloud`` tag the same door applies — protected strings are replaced before
    the text leaves (vectors come back, nothing to restore).
    """
    if not texts:
        return []
    policy = privacy_mod.policy_from_payload(privacy)
    if policy is not None and policy.active and privacy_mod.is_nonlocal_model(model):
        texts = [policy.redact_text(t) for t in texts]
    try:
        client = AsyncClient(host=base_url)
        resp = await client.embed(model=model, input=list(texts), keep_alive=keep_alive)
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise _classify(exc) from exc
    return [list(v) for v in resp.embeddings]


async def generate(
    model: str,
    messages: list[Message],
    base_url: str,
    *,
    temperature: float | None = None,
    num_ctx: int | None = None,
    num_predict: int | None = None,
    keep_alive: str | None = None,
    format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg name
    images: list[str] | None = None,
    privacy: dict[str, Any] | None = None,
) -> str:
    """One non-streaming assistant turn (ollama.rs ``chat_structured`` gateway).

    Reuses :class:`.chat.OllamaChatModel` for the pinned config (base_url, temp,
    keep_alive, RAM-adaptive num_ctx) and its non-streaming ``generate``. ``format``
    is Ollama's structured-output grammar (a JSON schema); ``images`` ride on the
    last user turn for vision. ``num_predict`` caps output tokens (None = uncapped);
    background jobs set it so a runaway loop can't fill the whole window. Rust keeps
    the schema-in-prompt priming and the fence/`<think>` JSON recovery, so this
    returns the model's raw text verbatim.

    Engine parity: an external-CLI model ("claude-cli…"/"codex-cli…") routes to
    :mod:`.external_llm` instead of Ollama — same messages, schema folded into
    the prompt — so every feature built on this gateway honors the room's
    chosen engine.

    PRIV-1: ``privacy`` is the room's policy payload. The guard runs BEFORE the
    engine split, so both ways out of the Mac (Ollama ``:cloud`` relay, cloud
    CLI) see only redacted text; the answer is restored before returning.
    """
    policy = privacy_mod.policy_from_payload(privacy)
    messages, images, engaged = privacy_mod.guard_outbound(model, messages, policy, images)
    if external_llm.is_external_model(model):
        text = await external_llm.generate_external(model, messages, format=format)
        return engaged.restore_text(text) if engaged else text
    kwargs: dict[str, Any] = {"model": model, "base_url": base_url}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if num_ctx is not None:
        kwargs["num_ctx"] = num_ctx
    if num_predict is not None:
        kwargs["num_predict"] = num_predict
    if keep_alive is not None:
        kwargs["keep_alive"] = keep_alive
    chat = OllamaChatModel(**kwargs)
    try:
        text = await chat.generate(messages, format=format, images=images)
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc
    return engaged.restore_text(text) if engaged else text


async def generate_stream(
    model: str,
    messages: list[Message],
    base_url: str,
    *,
    temperature: float | None = None,
    num_ctx: int | None = None,
    keep_alive: str | None = None,
    format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg name
    images: list[str] | None = None,
    privacy: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Streaming twin of :func:`generate` (ollama.rs ``chat_core`` streaming text).

    Reuses :class:`.chat.OllamaChatModel` for the pinned config (base_url, temp,
    keep_alive, RAM-adaptive num_ctx) and its streaming ``generate_stream``. Yields
    each text delta in order; the route wraps them into the NDJSON token envelope.
    A classified engine failure is re-raised as :class:`LlmError` so the route can
    emit the terminal ``{"t":"error","code":...}`` line — the SAME sentinels
    (OLLAMA_DOWN / MODEL_MISSING) the non-streaming paths use.

    Engine parity: an external CLI cannot stream tokens, so its whole reply is
    yielded as one final delta — callers see a single chunk instead of many.

    PRIV-1: guarded like :func:`generate`; a placeholder split across deltas is
    re-joined by the stream restorer before the caller sees it.
    """
    policy = privacy_mod.policy_from_payload(privacy)
    messages, images, engaged = privacy_mod.guard_outbound(model, messages, policy, images)
    if external_llm.is_external_model(model):
        text = await external_llm.generate_external(model, messages, format=format)
        yield engaged.restore_text(text) if engaged else text
        return
    kwargs: dict[str, Any] = {"model": model, "base_url": base_url}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if num_ctx is not None:
        kwargs["num_ctx"] = num_ctx
    if keep_alive is not None:
        kwargs["keep_alive"] = keep_alive
    chat = OllamaChatModel(**kwargs)
    restorer = engaged.restorer() if engaged else None
    try:
        async for delta in chat.generate_stream(messages, format=format, images=images):
            if restorer is not None:
                delta = restorer.feed(delta)
                if not delta:
                    continue
            yield delta
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise _classify(exc) from exc
    if restorer is not None:
        tail = restorer.flush()
        if tail:
            yield tail


async def delete(model: str, base_url: str) -> None:
    """Remove an installed model (ollama.rs ``delete_model`` → ``/api/delete``).

    A thin ``AsyncClient.delete`` passthrough; failures are classified into the
    same ``{error, code}`` envelope as the other endpoints so the Rust gateway
    rebuilds OLLAMA_DOWN / MODEL_MISSING:<model> exactly as before.
    """
    try:
        client = AsyncClient(host=base_url)
        await client.delete(model)
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc


async def list_models(base_url: str) -> list[str]:
    """Installed model names (ollama.rs ``list_models`` → ``/api/tags``)."""
    try:
        client = AsyncClient(host=base_url)
        resp = await client.list()
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc
    return [m.model for m in resp.models if m.model]


async def warm(model: str, base_url: str, keep_alive: str = "30m") -> None:
    """Load a model into memory so the first real request is fast (fire-and-forget).

    Mirrors ollama.rs ``warm``: a no-prompt generate with a small window that just
    pulls the weights resident. The result is deliberately ignored.
    """
    try:
        client = AsyncClient(host=base_url)
        await client.generate(model=model, keep_alive=keep_alive, options={"num_ctx": 8192})
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc


async def capabilities(model: str, base_url: str) -> list[str]:
    """A model's declared capabilities via ``/api/show`` (never loads the model).

    Empty on ANY error — ollama.rs treats "unknown" as "no special capability" so
    the Settings badges just don't show rather than failing the call.
    """
    try:
        client = AsyncClient(host=base_url)
        resp = await client.show(model)
    except Exception:  # noqa: BLE001 - metadata call: unknown == none
        return []
    return list(resp.capabilities or [])


async def pull(model: str, base_url: str) -> AsyncIterator[dict[str, Any]]:
    """Stream a model download as ``{status, completed?, total?}`` progress dicts.

    ollama.rs ``pull`` reports progress to the UI, so this stays streaming rather
    than a blocking passthrough — the Rust side reads these lines and re-emits the
    same progress events. Raises :class:`LlmError` on failure (the route turns it
    into a final ``{error,code}`` line).
    """
    try:
        client = AsyncClient(host=base_url)
        iterator = await client.pull(model, stream=True)
        async for prog in iterator:
            out: dict[str, Any] = {"status": prog.status or ""}
            if prog.completed is not None:
                out["completed"] = prog.completed
            if prog.total is not None:
                out["total"] = prog.total
            yield out
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc


__all__ = [
    "LlmError",
    "embed",
    "generate",
    "generate_stream",
    "delete",
    "list_models",
    "warm",
    "capabilities",
    "pull",
]
