"""The sidecar's HTTP surface (SPEC §5).

Loopback only, no state that outlives a run. The core of it:

  GET  /health -> {"ok": true, "version": "..."}   (the Rust lifecycle manager)
  POST /run    -> application/x-ndjson, one SPEC §4 event per line (the agent loop)
  POST /cancel -> {"run_id": "..."}; the loop checks between rounds and between
                  tool calls, so Stop stops within one tool call, not one round.

Around those sit a set of one-shot gateway endpoints — generation/summarize,
whole-file pass, knowledge extract, vision, TTS, embeddings, privacy scan, and
the rest — that reuse the same engine plumbing without the streaming loop.

Nothing here logs message content: the sidecar handles the user's private files
and a log line is a copy of them that outlives the run (SPEC §6).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import (
    __version__,
    ai_actions,
    chat_docs,
    compaction,
    features,
    file_pass,
    handoff,
    imagegen,
    llm,
    model_limits,
    rec_read,
    videogen,
    vision,
    websearch,
    wf_nodes,
)
from . import privacy as privacy_mod
from . import privacy_scan as privacy_scan_mod
from . import summarize as summarize_feature
from . import tts as tts_mod
from .docs.dispatch import extract_text as extract_document_text
from .chat import ChatModel, OllamaChatModel
from .config import (
    CLOUD_WORKER_PARALLEL,
    CancelRequest,
    CapabilitiesRequest,
    DeleteRequest,
    EmbedRequest,
    FeedbackDraftRequest,
    GenerateDocRequest,
    GenerateRequest,
    HealthResponse,
    ImageGenerateRequest,
    KnowledgeExtractRequest,
    LabelRequest,
    ModelsRequest,
    OcrRequest,
    PrivacyScanRequest,
    PullRequest,
    RunRequest,
    AgentSupportRequest,
    SpecialistsRequest,
    PodcastTtsRequest,
    TtsRequest,
    VideoJobRequest,
    VideoStartRequest,
    VisionLocateRequest,
    QuickLookRequest,
    WarmRequest,
    WebSearchRequest,
)
from .media.ocr import recognize as ocr_recognize
from .agents import agent_roster, reachable_agent_ids, specialist_catalog
from .external_llm import ExternalChatModel, is_external_model
from .graph import CancelToken, Deps, Emit, stream_events
from .mcp_client import McpClient
from .messages import compact_json
from .provider_api import OpenAICompatibleChatModel
from .rec.session_ws import register_rec_routes
from .stt.dictation import register_dict_routes
from .stt import engine as stt_engine
from .media.decode import MediaKind as SttMediaKind, decode_to_pcm
from .media.quicklook import preview_png as quicklook_preview_png

log = logging.getLogger("arcelle_sidecar")

#: Ceiling on one incoming request body. Only programs already on this Mac can
#: reach the port, so this is hardening, not a live defence: the biggest real
#: body is a base64 image or a file-pass window, orders of magnitude under this,
#: and holding an unbounded one whole in memory on a machine already running a
#: multi-GB model is the failure worth refusing. Enforced on the declared
#: ``Content-Length``, which is what every caller of ours sends.
MAX_REQUEST_BYTES: int = 128 << 20

#: Environment variable carrying the shared secret the Rust host hands us at
#: spawn. See :class:`TokenAuthMiddleware`.
TOKEN_ENV = "ARCELLE_SIDECAR_TOKEN"

#: The one route that answers without the token: the host's own liveness probe,
#: which runs before anything is configured and reveals nothing but "yes, and
#: this is my version".
_OPEN_PATHS = frozenset({"/health"})

#: How often a one-shot handler checks whether its caller is still there.
_HANGUP_POLL_SECS = 0.25

#: A factory so tests can inject a scripted model instead of a real Ollama.
ChatModelFactory = Callable[[RunRequest], ChatModel]
McpFactory = Callable[[RunRequest], McpClient | None]


def _default_chat_model(req: RunRequest) -> ChatModel:
    if req.provider is not None:
        return OpenAICompatibleChatModel(
            model=req.model,
            provider=req.provider,
            temperature=req.temperature,
        )
    # Engine parity: a cloud CLI is just a third implementation of the same
    # one-method seam, so the agent hub (main agent + domain agents) runs on
    # `claude -p` / `codex exec` through exactly the code the local engine uses.
    if is_external_model(req.model):
        return ExternalChatModel(
            model=req.model,
            temperature=req.temperature,
            max_context=req.max_context,
            # Room tools are handed to Claude as a REAL MCP server scoped to
            # each agent's box — the CLI drives its own tool loop over the same
            # bridge the sidecar uses.
            mcp_url=req.mcp.url if req.mcp else "",
            mcp_token=req.mcp.token if req.mcp else "",
        )
    return OllamaChatModel(
        model=req.model,
        base_url=req.ollama_base_url,
        temperature=req.temperature,
    )


def _default_mcp(req: RunRequest) -> McpClient | None:
    if req.mcp is None:
        return None
    return McpClient(req.mcp.url, req.mcp.token)


class BodyLimitMiddleware:
    """Refuse a request whose declared body is past :data:`MAX_REQUEST_BYTES`.

    Raw ASGI rather than a Starlette ``BaseHTTPMiddleware``: it reads the scope
    headers and either answers 413 itself or steps aside completely, so the
    NDJSON streams (``/run``, ``/pull``, ``/generate_stream``) keep the exact
    send path they have today.
    """

    def __init__(self, app: Any, max_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and self._too_big(scope):
            body = compact_json(
                {"error": "request body too large", "code": "BODY_TOO_LARGE"}
            ).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)

    def _too_big(self, scope: Any) -> bool:
        for name, value in scope.get("headers") or []:
            if name == b"content-length":
                try:
                    return int(value) > self.max_bytes
                except ValueError:
                    return False
        return False


class TokenAuthMiddleware:
    """Require the host's bearer token on everything but ``/health``.

    The port is loopback-only, but loopback on a Mac is not a boundary: every
    other program running as this user could drive the agent — start runs,
    generate text, search the web, delete downloaded models — and the app's two
    other local services (the room MCP bridge and ``hub_mcp``) have always
    demanded a fresh token, so this one was the odd one out.

    The secret is generated per app process and handed to us in the environment
    at spawn (:data:`TOKEN_ENV`); it is never logged and never written to disk.
    An EMPTY or absent variable leaves the port open, which is how a developer
    running ``python -m arcelle_sidecar`` by hand and every test in this repo
    reaches it — the Rust host always sets it, so a shipped app is never in that
    state.

    Raw ASGI for the same reason as :class:`BodyLimitMiddleware`: it answers 401
    itself or steps aside completely, leaving the NDJSON streams' send path
    untouched.
    """

    def __init__(self, app: Any, token: str) -> None:
        self.app = app
        self.token = token
        self._expected = f"Bearer {token}".encode()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and not self._allowed(scope):
            body = compact_json({"error": "unauthorized", "code": "NO_TOKEN"}).encode(
                "utf-8"
            )
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        # MIGRATION (rec/session_ws.py): the recording WebSocket routes
        # (/rec/session, /rec/host) are reached by a renderer WebSocket client,
        # which cannot set an Authorization header on the handshake — so the
        # same token rides a `?token=` query parameter instead (the plan's own
        # owner decision Q3: "accept with a WS-only token scope check in
        # TokenMiddleware"). Here rather than per-route so this class stays the
        # single answer to "who may drive this sidecar" and a WS route added
        # later inherits the guard instead of having to remember it. The
        # header-based branch above is untouched for every HTTP route.
        #
        # Rejected before `self.app`, and therefore before the route, ever sees
        # the connection: answering `websocket.close` instead of
        # `websocket.accept` fails the handshake outright.
        if scope.get("type") == "websocket" and not self._ws_allowed(scope):
            await receive()
            await send({"type": "websocket.close", "code": 4401})
            return
        await self.app(scope, receive, send)

    def _allowed(self, scope: Any) -> bool:
        if scope.get("path") in _OPEN_PATHS:
            return True
        for name, value in scope.get("headers") or []:
            if name == b"authorization":
                # compare_digest, not ==: the reply timing of a loopback socket
                # is a poor oracle, but this costs nothing.
                return hmac.compare_digest(value, self._expected)
        return False

    def _ws_allowed(self, scope: Any) -> bool:
        """The same secret, off the query string instead of a header — see the
        websocket branch in :meth:`__call__`."""
        query = parse_qsl((scope.get("query_string") or b"").decode("utf-8", "replace"))
        for key, value in query:
            if key == "token":
                return hmac.compare_digest(value.encode(), self.token.encode())
        return False


class ClientGone(Exception):
    """The caller hung up while a one-shot handler was still working."""


T = TypeVar("T")


async def until_hangup(request: Request, work: Awaitable[T]) -> T:
    """Await ``work``, abandoning it if the caller disconnects.

    Stop, for the one-shot endpoints, is the host dropping the HTTP request:
    their bodies carry no ``run_id`` for ``/cancel`` to find. uvicorn hands us
    the disconnect and then simply waits — measured against the pinned uvicorn
    0.51 / starlette 0.52, a non-streaming handler keeps running seconds past a
    hard disconnect (the same measurement that put ``/wf_node`` in the
    :class:`RunRegistry`). For a model call that means the local engine keeps
    generating an answer nobody will read, holding the one resident-model slot
    the next job is queued behind. Cancelling the task closes the HTTP
    connection to the engine, which is how the generation actually stops.

    Raises :class:`ClientGone` when it did; :func:`create_app` turns that into
    a 499 body there is nobody left to read.
    """
    task = asyncio.ensure_future(work)
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=_HANGUP_POLL_SECS)
            if done:
                return task.result()
            if await request.is_disconnected():
                raise ClientGone
    finally:
        # Also the path where this handler is itself cancelled: the work must
        # never outlive the request that asked for it.
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


class RunRegistry:
    """Live runs, so /cancel can find one. Entries die with the run."""

    def __init__(self) -> None:
        self._tokens: dict[str, CancelToken] = {}

    def register(self, run_id: str, token: CancelToken) -> None:
        if run_id:
            self._tokens[run_id] = token

    def release(self, run_id: str) -> None:
        self._tokens.pop(run_id, None)

    def cancel(self, run_id: str) -> list[str] | None:
        """What this Stop actually stopped — the run and every specialist under
        it (``CancelToken.cancel`` walks the tree). ``None`` for an unknown id;
        an EMPTY list means we knew the run and it was already stopped, which is
        not the same thing and must not be reported as if it were. A no-op for
        an unknown id, same contract as the Rust ``cancel_ask``."""
        token = self._tokens.get(run_id)
        if token is None:
            return None
        return token.cancel()

    def __len__(self) -> int:  # pragma: no cover - introspection
        return len(self._tokens)


def create_app(
    chat_factory: ChatModelFactory = _default_chat_model,
    mcp_factory: McpFactory = _default_mcp,
    token: str | None = None,
) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Off the request path, on purpose — see tts.warm_import. Fire and
        # forget: nothing waits for it, and a failure changes nothing about how
        # the first spoken sentence behaves. Dropped on shutdown so nothing
        # awaits it; the import itself runs in a worker thread the loop's own
        # executor joins, which `Task.cancel` cannot and does not interrupt.
        warm = asyncio.get_running_loop().create_task(tts_mod.warm_import())
        try:
            yield
        finally:
            warm.cancel()

    app = FastAPI(title="Arcelle agent sidecar", version=__version__, lifespan=lifespan)
    app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)
    # Added AFTER the body limit so it runs BEFORE it (Starlette wraps
    # outermost-last): an unauthorized caller is turned away without us reading
    # its Content-Length, let alone its body.
    token = os.environ.get(TOKEN_ENV, "") if token is None else token
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    # The recording surface: POST /rec/* + WS /rec/session + WS /rec/host, and
    # the single-live-session slot behind them (on `app.state.rec_manager`).
    # Its own module owns every decision; this is the whole of its footprint
    # here, and it needs no token of its own — the WS routes are guarded by the
    # `?token=` branch of TokenAuthMiddleware above.
    register_rec_routes(app)
    # The dictation surface: WS /dict/session and the single-live-session slot
    # behind it (on `app.state.dict_manager`). Same deal as the recording
    # routes above — its own module owns every decision, and it needs no token
    # of its own.
    register_dict_routes(app)
    registry = RunRegistry()
    app.state.registry = registry

    @app.exception_handler(ClientGone)
    async def _client_gone(_request: Request, _exc: ClientGone) -> JSONResponse:
        # The socket is already gone; this exists so the abandoned handler ends
        # as a normal response instead of a 500 traceback in the log.
        return JSONResponse(
            {"error": "caller hung up", "code": "CLIENT_GONE"}, status_code=499
        )

    @app.get("/health")
    async def health() -> HealthResponse:
        return HealthResponse(ok=True, version=__version__)

    @app.post("/run")
    async def run(req: RunRequest) -> StreamingResponse:
        token = CancelToken()
        registry.register(req.run_id, token)
        mcp = mcp_factory(req)
        chat = chat_factory(req)

        # PRIV-1: resolve the room policy once per run and hand it to the model
        # seam — the agent loop then talks to a ``:cloud`` model only through
        # the door. Local models: the guard is a no-op.
        policy = privacy_mod.policy_from_payload(req.privacy)
        engaged = (
            policy is not None
            and policy.active
            and (privacy_mod.is_nonlocal_model(req.model) or policy.relayed)
        )
        if engaged:
            # The live guard (PRIV-2): the user's freshly TYPED question can't
            # have import-time marks, so when concept rules exist, a local model
            # scans it now and its findings become request-scoped rules. Best
            # effort — the exact rules below enforce regardless.
            guard_model = str((req.privacy or {}).get("guard_model") or "")
            if policy.concepts and guard_model:
                try:
                    # Hard cap: the guard must never make chat FEEL stuck. A
                    # busy local model (e.g. the background document scan) can
                    # queue this call for minutes — after 8s the turn proceeds
                    # with the exact rules alone, which never need a model.
                    scan = await asyncio.wait_for(
                        privacy_scan_mod.scan_text(
                            req.question,
                            model=guard_model,
                            base_url=req.ollama_base_url,
                            concepts=policy.concepts,
                            known=[r for r, _ in policy.rules],
                        ),
                        timeout=8.0,
                    )
                    taken = {p for _, p in policy.rules}
                    # A partial guard scan is still worth its rules: one typed
                    # message is one chunk, so `complete` is almost always true
                    # here, and a rule found is a rule enforced either way.
                    policy.add_rules(
                        privacy_scan_mod.mint_ephemeral_rules(scan.entities, taken)
                    )
                except Exception:  # noqa: BLE001 - guard is best-effort by design
                    log.warning("privacy live guard unavailable; exact rules still apply")
            chat.privacy = policy  # type: ignore[attr-defined]

        # How many delegated children may hold a model round at once. A LOCAL
        # room has one resident model, so concurrent children are contention
        # rather than throughput — and each of them inflates the payload the
        # others fit their window to. `wf_nodes.NodeDeps.parallel` already makes
        # exactly this call for the workflow lanes. A cloud engine has no
        # resident model, so it really does fan out — but not unbounded: a plan
        # with twenty tasks opened twenty PAID conversations at once, which is a
        # rate-limit wall and a cost spike, not twenty-way speed
        # (`config.CLOUD_WORKER_PARALLEL`).
        worker_parallel = (
            CLOUD_WORKER_PARALLEL
            if (req.provider is not None or privacy_mod.is_nonlocal_model(req.model))
            else 1
        )

        def deps_factory(emit: Emit) -> Deps:
            return Deps(
                chat=chat,
                emit=emit,
                cancel=token,
                mcp=mcp,
                worker_parallel=worker_parallel,
            )

        def stamped(event: dict[str, Any]) -> bytes:
            """Name the run every line belongs to.

            Owner replacement #4 (2026-08-03): the host turns these lines into
            window events that a specific conversation paints, so each one has
            to say which run produced it — including the ones emitted by a
            delegated sub-agent, which travel on this same stream. One place,
            because every exit below (the graph's events, the privacy receipt,
            a transport failure) is equally a line the host will attribute.

            An id, nothing else: the host owns the chat id and never tells us
            which conversation a run belongs to.
            """
            return (compact_json({**event, "run_id": req.run_id}) + "\n").encode("utf-8")

        async def body() -> AsyncIterator[bytes]:
            # ARC-002: the final disclosure gate is independent of transport.
            # A local specialist can quote a protected room value just as a
            # cloud model can restore one, so sanitize every user-visible event
            # whenever the room policy is active.  Deltas need one redactor per
            # live graph node because parallel specialists may interleave.
            output_policy = policy if policy is not None and policy.active else None
            output_streams: dict[str, privacy_mod.OutputRedactor] = {}
            try:
                async for event in stream_events(req, deps_factory):
                    if output_policy is not None:
                        event = dict(event)
                        event_type = event.get("t")
                        node = str(event.get("node") or "main")
                        if event_type == "round":
                            # A new model round clears the live answer area; its
                            # predecessor's held suffix is obsolete and the
                            # complete final event is gated independently.
                            output_streams.pop(node, None)
                        elif event_type == "delta":
                            redactor = output_streams.setdefault(
                                node, output_policy.output_redactor()
                            )
                            visible = redactor.feed(str(event.get("v") or ""))
                            if not visible:
                                continue
                            event["v"] = visible
                        else:
                            event = output_policy.sanitize_output_value(event)
                    yield stamped(event)
                if engaged and policy is not None:
                    # After the final event: what the door actually did, for the
                    # chat indicator ("N details hidden from the cloud model").
                    yield stamped({"t": "privacy", "v": policy.report.as_payload()})
            except httpx.HTTPError as exc:
                # The bridge died mid-run: tell the host so it can surface the
                # failure instead of hanging. There is no native engine behind
                # this one to fall back to — it was deleted with agent_loop.
                log.warning("room bridge transport failure: %s", type(exc).__name__)
                yield stamped({"t": "error", "v": str(exc)})
            finally:
                registry.release(req.run_id)
                if mcp is not None:
                    await mcp.aclose()

        return StreamingResponse(
            body(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/cancel")
    async def cancel(req: CancelRequest) -> JSONResponse:
        stopped = registry.cancel(req.run_id)
        # `stopped` names the run and the specialists under it — static agent
        # labels, never room content. `known` keeps its old meaning and shape so
        # the host's `cancel_delivered` check is untouched.
        return JSONResponse(
            {"ok": True, "known": stopped is not None, "stopped": stopped or []}
        )

    @app.post("/forget")
    async def forget() -> Any:
        """Drop everything this process still holds about the room that closed.

        The service outlives every room: one process serves whichever room is
        open, so its in-memory state has to be told when a room goes away. The
        compaction cache is that state — boiled-down summaries of the room's own
        conversation, which survived lock, room-switch and chat deletion alike
        and broke the "close the room and nothing survives" promise.

        Answers a COUNT, never content, and the host treats a missing service as
        nothing to forget rather than a failure (`rooms.rs` teardown).
        """
        dropped = compaction.cache_size()
        compaction.clear_cache()
        return {"ok": True, "dropped": dropped}

    # --- LLM gateway (MIGRATION Phase 1) ------------------------------------
    #
    # The sidecar is the app's SOLE AI service: Rust gathers DB text and calls
    # these; the model I/O happens here. A classified engine failure comes back
    # as a non-2xx ``{error, code}`` body so the Rust gateway can rebuild the
    # OLLAMA_DOWN / MODEL_MISSING:<model> sentinels its callers branch on.

    @app.post("/embed")
    async def embed(req: EmbedRequest) -> Any:
        try:
            vectors = await llm.embed(
                req.model, req.texts, req.base_url, req.keep_alive, privacy=req.privacy
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"embeddings": vectors}

    @app.post("/generate")
    async def generate(req: GenerateRequest, request: Request) -> Any:
        try:
            text = await until_hangup(
                request,
                llm.generate(
                    req.model,
                    req.messages,
                    req.base_url,
                    temperature=req.temperature,
                    num_ctx=req.num_ctx,
                    keep_alive=req.keep_alive,
                    format=req.format,
                    images=req.images,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"text": text}

    @app.post("/generate_stream")
    async def generate_stream(req: GenerateRequest) -> StreamingResponse:
        # Streaming twin of /generate (ollama.rs chat_core streaming, reached via
        # chat_stream_tools with no tools): one NDJSON line per token
        # {"t":"delta","v":<tok>}, a terminal {"t":"done"}, and — on a classified
        # engine failure — {"t":"error","code":OLLAMA_DOWN|MODEL_MISSING|ENGINE_ERROR,
        # "error":<msg>} instead of "done". The error can arrive mid-stream (after
        # some deltas): the host reads the code the same way it does for /generate.
        async def body() -> AsyncIterator[bytes]:
            try:
                async for delta in llm.generate_stream(
                    req.model,
                    req.messages,
                    req.base_url,
                    temperature=req.temperature,
                    num_ctx=req.num_ctx,
                    keep_alive=req.keep_alive,
                    format=req.format,
                    images=req.images,
                    privacy=req.privacy,
                    provider=req.provider,
                ):
                    yield (compact_json({"t": "delta", "v": delta}) + "\n").encode("utf-8")
                yield (compact_json({"t": "done"}) + "\n").encode("utf-8")
            except llm.LlmError as exc:
                yield (
                    compact_json({"t": "error", "code": exc.code, "error": exc.message}) + "\n"
                ).encode("utf-8")

        return StreamingResponse(
            body(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/delete")
    async def delete(req: DeleteRequest) -> Any:
        try:
            await llm.delete(req.model, req.base_url)
        except llm.LlmError as exc:
            return exc.response()
        return {"ok": True}

    @app.post("/models")
    async def models(req: ModelsRequest) -> Any:
        try:
            names = await llm.list_models(req.base_url)
        except llm.LlmError as exc:
            return exc.response()
        return {"models": names}

    @app.post("/warm")
    async def warm(req: WarmRequest) -> Any:
        try:
            await llm.warm(req.model, req.base_url, req.keep_alive)
        except llm.LlmError as exc:
            return exc.response()
        return {"ok": True}

    @app.post("/capabilities")
    async def capabilities(req: CapabilitiesRequest) -> Any:
        # Never fails: unknown capabilities == none (ollama.rs contract).
        caps = await llm.capabilities(req.model, req.base_url)
        return {"capabilities": caps}

    @app.post("/probe_model")
    async def probe_model(req: CapabilitiesRequest) -> Any:
        # Selection is fail-closed. Unlike /capabilities (best-effort badges),
        # this route preserves MODEL_MISSING / OLLAMA_DOWN / ENGINE_ERROR so an
        # invalid exact ID cannot reach a real agent run.
        try:
            caps = await llm.probe_model(req.model, req.base_url)
        except llm.LlmError as exc:
            return exc.response()
        return {"capabilities": caps}

    @app.post("/agents")
    async def agents(req: SpecialistsRequest) -> Any:
        # The composer's `*` menu — one row per AGENT the room can run, not per
        # domain, so the Browser agent is offered by name instead of hiding
        # under the Web agent's row (owner report 2026-08-03). Derived from the
        # same `specialist_workers` a tagged turn is ROUTED by, which is the
        # whole reason the host asks us instead of keeping its own list: the
        # menu may never offer a specialist the room could not dispatch to, nor
        # withhold one it could.
        return {
            "agents": specialist_catalog(
                web_enabled=req.web_enabled,
                served_names=set(req.served_names),
            )
        }

    @app.post("/agent_support")
    async def agent_support(req: AgentSupportRequest) -> Any:
        # The agent half of the published provider x agent matrix. The host
        # declares what each ENGINE can do and which tool names each bridge
        # TIER serves; only this side knows which workers those names add up
        # to, and it answers with the same `worker_reachable` predicate a live
        # turn uses. So the matrix is derived on both sides and neither keeps a
        # written-down copy that could rot.
        return {
            "agents": agent_roster(),
            "tiers": {
                name: reachable_agent_ids(set(tools), web_enabled=req.web_enabled)
                for name, tools in req.tiers.items()
            },
        }

    @app.post("/context_length")
    async def context_length(req: CapabilitiesRequest) -> Any:
        # The sidecar is the SOLE AI service: this is the last Ollama read the
        # host used to do itself (`ollama.rs::native_context_length`'s raw
        # GET /api/tags). Never fails — `None` means "unknown", and the caller
        # falls back to its explicit override or a display default.
        length = await model_limits.native_context_length(req.model, req.base_url)
        return {"context_length": length}

    @app.post("/pull")
    async def pull(req: PullRequest) -> StreamingResponse:
        async def body() -> AsyncIterator[bytes]:
            try:
                async for prog in llm.pull(req.model, req.base_url):
                    yield (compact_json(prog) + "\n").encode("utf-8")
            except llm.LlmError as exc:
                yield (compact_json({"error": exc.message, "code": exc.code}) + "\n").encode("utf-8")

        return StreamingResponse(
            body(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    # --- Phase-2 feature endpoints (feature logic → Python) -----------------
    #
    # The full PROMPT + parsing lives in :mod:`.features`; Rust gathers the DB
    # text and stores/returns the result. The two features differ in how they
    # treat an engine failure, faithfully to their Rust originals:
    #   /label          swallows it -> {"questions": []} (front_page.rs
    #                   unwrap_or_default -> the Rust caller reuses its cache).
    #   /feedback_draft surfaces it -> 502 {error, code} (feedback.rs `?`).

    @app.post("/tts")
    async def tts_route(req: TtsRequest) -> Any:
        """Neural spoken voice: sentence text -> normalized WAV (b64).

        The one seam where reply text leaves for speech (see tts.py). A dead
        or offline service is a clean 502; the webview skips that sentence
        (neural is the only engine — there is no fallback voice).
        """
        text = req.text.strip()
        if not text:
            return JSONResponse(
                {"code": "TTS_BAD_REQUEST", "error": "empty text"}, status_code=400
            )
        if len(text) > tts_mod.MAX_TTS_CHARS:
            return JSONResponse(
                {"code": "TTS_BAD_REQUEST", "error": "text too long"}, status_code=400
            )
        try:
            wav = await tts_mod.synthesize_wav(text, req.voice, req.rate, req.pitch)
        except tts_mod.TtsError as exc:
            return JSONResponse(
                {"code": "TTS_UNAVAILABLE", "error": str(exc)}, status_code=502
            )
        return {"audio_b64": tts_mod.wav_b64(wav)}

    @app.post("/image_generate")
    async def image_generate(req: ImageGenerateRequest) -> Any:
        """One prompt -> one picture or clip, as base64 for the host to file.

        Deliberately not part of the chat path: ``generate`` there is typed
        ``-> str`` and drops non-text blocks, so a returned image would vanish
        silently. See :mod:`.imagegen` for the privacy rule, which REFUSES a
        reference image rather than stripping it.

        A missing ``provider`` is a 400 rather than a crash: it means the host
        could not mint a key for this model, which is a setup problem the user
        can act on ("connect OpenRouter"), not a provider failure.
        """
        if req.provider is None:
            return JSONResponse(
                {
                    "code": "IMAGEGEN_BAD_REQUEST",
                    "error": (
                        "No API key is connected for this model. Add one in "
                        "Settings, under AI providers."
                    ),
                },
                status_code=400,
            )
        try:
            result = await imagegen.generate(
                prompt=req.prompt,
                model=req.model,
                provider=req.provider,
                privacy=req.privacy,
                reference_b64=req.reference_b64,
                reference_mime=req.reference_mime,
                references_ack=req.references_ack,
                aspect_ratio=req.aspect_ratio,
                resolution=req.resolution,
                kind=req.kind,
            )
        except imagegen.ImageGenError as exc:
            return JSONResponse(
                {"code": "IMAGEGEN_FAILED", "error": str(exc)}, status_code=502
            )
        return result

    def _no_key() -> JSONResponse:
        return JSONResponse(
            {
                "code": "VIDEOGEN_BAD_REQUEST",
                "error": (
                    "No API key is connected for this model. Add one in "
                    "Settings, under AI providers."
                ),
            },
            status_code=400,
        )

    @app.post("/video_start")
    async def video_start(req: VideoStartRequest) -> Any:
        """Submit one clip and return the provider's job id. Does NOT wait.

        Video is a three-call API, not a chat completion — see
        :mod:`.videogen`. Submission is split from polling so the host's Stop
        is real and the progress bar moves; a loop that blocked here would give
        the user a frozen bar and nothing to cancel, on work that is billed.
        """
        if req.provider is None:
            return _no_key()
        try:
            return await videogen.submit(
                prompt=req.prompt,
                model=req.model,
                provider=req.provider,
                privacy=req.privacy,
                seconds=req.seconds,
                resolution=req.resolution,
                aspect_ratio=req.aspect_ratio,
                frames=[frame.model_dump() for frame in req.frames],
                references=[ref.model_dump() for ref in req.references],
                references_ack=req.references_ack,
                generate_audio=req.generate_audio,
            )
        except videogen.VideoGenError as exc:
            return JSONResponse(
                {"code": "VIDEOGEN_FAILED", "error": str(exc)}, status_code=502
            )

    @app.post("/video_status")
    async def video_status(req: VideoJobRequest) -> Any:
        """Where one submitted clip has got to."""
        if req.provider is None:
            return _no_key()
        try:
            return await videogen.status(
                model=req.model, video_id=req.video_id, provider=req.provider
            )
        except videogen.VideoGenError as exc:
            return JSONResponse(
                {"code": "VIDEOGEN_FAILED", "error": str(exc)}, status_code=502
            )

    @app.post("/video_fetch")
    async def video_fetch(req: VideoJobRequest) -> Any:
        """Download a finished clip as base64 for the host to file."""
        if req.provider is None:
            return _no_key()
        try:
            return await videogen.fetch(
                model=req.model,
                video_id=req.video_id,
                provider=req.provider,
                index=req.index,
            )
        except videogen.VideoGenError as exc:
            return JSONResponse(
                {"code": "VIDEOGEN_FAILED", "error": str(exc)}, status_code=502
            )

    @app.post("/tts/podcast")
    async def tts_podcast(req: PodcastTtsRequest) -> Any:
        """A whole episode: many turns, each in its own voice, one WAV back.

        Deliberately not "loop /tts N times from the host". The loudness pass
        has to run over the finished mix (per-clip normalization makes every
        speaker change a level jump), the gaps between turns are part of the
        result, and the per-turn OFFSETS returned here are what let the caller
        write a seekable ``[m:ss] Speaker: line`` transcript onto the room file.

        Minutes of network work in one request. The host runs it as a
        background job with its own Stop, so nothing here needs a timeout of
        its own — a dropped caller ends the request the same way it ends a long
        model call.
        """
        if not req.turns:
            return JSONResponse(
                {"code": "TTS_BAD_REQUEST", "error": "no turns"}, status_code=400
            )
        try:
            wav, offsets, duration_ms = await tts_mod.synthesize_podcast(
                [t.model_dump() for t in req.turns], req.gap_ms
            )
        except tts_mod.TtsError as exc:
            return JSONResponse(
                {"code": "TTS_UNAVAILABLE", "error": str(exc)}, status_code=502
            )
        return {
            "audio_b64": tts_mod.wav_b64(wav),
            "offsets_ms": offsets,
            "duration_ms": duration_ms,
        }

    @app.post("/tts/voices")
    async def tts_voices() -> Any:
        """The service's LIVE voice catalog, for the Settings picker.

        Dynamic by design — nothing is bundled, so new service voices appear
        without an app update. The fetch carries no room data. A dead
        service (and no last-good cache) is a 502; the webview keeps the
        saved voice and says the list couldn't load.
        """
        try:
            return {"voices": await tts_mod.list_neural_voices()}
        except tts_mod.TtsError as exc:
            return JSONResponse(
                {"code": "TTS_UNAVAILABLE", "error": str(exc)}, status_code=502
            )

    @app.post("/stt/transcribe_file")
    async def stt_transcribe_file(request: Request) -> Any:
        """Transcribe one host-staged media file with the on-device model.

        The authenticated Electron host stages decrypted bytes beneath the
        OS temp directory and removes them after this call. Refusing every
        other input path prevents this local endpoint becoming a generic file
        reader even if its process token were accidentally disclosed.
        """
        body = await request.json()
        staged = Path(str(body.get("path", ""))).resolve()
        temp_root = Path(tempfile.gettempdir()).resolve()
        if staged.parent.parent != temp_root or not staged.parent.name.startswith("arcelle-stt-"):
            return JSONResponse(
                {"code": "STT_BAD_REQUEST", "error": "the staged audio path was refused"},
                status_code=400,
            )
        model_path = Path(str(body.get("model_path", ""))).resolve()
        if not staged.is_file() or not model_path.is_file():
            return JSONResponse(
                {"code": "STT_BAD_REQUEST", "error": "the audio file or speech model is missing"},
                status_code=400,
            )
        kind = SttMediaKind.VIDEO if body.get("kind") == "video" else SttMediaKind.AUDIO
        try:
            pcm = await asyncio.to_thread(decode_to_pcm, staged, kind)
            text = await asyncio.to_thread(stt_engine.transcribe, str(model_path), pcm, True)
            return {"text": text}
        except (OSError, RuntimeError, ValueError) as exc:
            return JSONResponse(
                {"code": "STT_FAILED", "error": str(exc)}, status_code=502
            )

    @app.post("/docs/extract")
    async def docs_extract(request: Request) -> Any:
        """Extract text from one host-staged room document.

        Only the Electron host's private temporary directories are accepted;
        the endpoint cannot be used as a general local-file reader.
        """
        body = await request.json()
        staged = Path(str(body.get("path", ""))).resolve()
        temp_root = Path(tempfile.gettempdir()).resolve()
        if staged.parent.parent != temp_root or not staged.parent.name.startswith("arcelle-docs-"):
            return JSONResponse(
                {"code": "DOCS_BAD_REQUEST", "error": "the staged document path was refused"},
                status_code=400,
            )
        if not staged.is_file():
            return JSONResponse(
                {"code": "DOCS_BAD_REQUEST", "error": "the staged document is missing"},
                status_code=400,
            )
        try:
            data = await asyncio.to_thread(staged.read_bytes)
            text = await asyncio.to_thread(
                extract_document_text, str(body.get("name", staged.name)), data
            )
            return {"text": text}
        except (OSError, RuntimeError, ValueError) as exc:
            return JSONResponse(
                {"code": "DOCS_EXTRACT_FAILED", "error": str(exc)}, status_code=422
            )


    @app.post("/label")
    async def label(req: LabelRequest, request: Request) -> Any:
        # D4 front-page suggestions. There is no room-GRAPH AI labeling to serve
        # here — graph.rs build_room_graph is model-free by design.
        try:
            questions = await until_hangup(
                request,
                features.front_page_labels(
                    req.model, req.room_name, req.files, req.base_url,
                    privacy=req.privacy, provider=req.provider
                ),
            )
        except llm.LlmError:
            # Front page is resilient: any engine failure yields no suggestions,
            # and the Rust caller falls back to its cached list.
            return {"questions": []}
        return {"questions": questions}

    @app.post("/feedback_draft")
    async def feedback_draft(req: FeedbackDraftRequest, request: Request) -> Any:
        try:
            draft = await until_hangup(
                request,
                features.feedback_draft(
                    req.model, req.text, req.base_url,
                    privacy=req.privacy, provider=req.provider
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return draft

    @app.post("/vision_locate")
    async def vision_locate(req: VisionLocateRequest, request: Request) -> Any:
        # vision.rs locate_in_image: prepare the image, ground the query with the
        # boxes schema via the Phase-1 /generate path, parse to normalized boxes.
        # An engine failure surfaces as 502 {error, code} exactly like /generate —
        # the Rust caller rebuilds OLLAMA_DOWN / MODEL_MISSING:<model> for the UI.
        try:
            boxes = await until_hangup(
                request,
                vision.vision_locate(
                    req.model,
                    req.image_b64,
                    req.query,
                    req.base_url,
                    temperature=req.temperature,
                    num_ctx=req.num_ctx,
                    keep_alive=req.keep_alive,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"boxes": boxes}

    @app.post("/quicklook")
    async def quicklook(req: QuickLookRequest, request: Request) -> Any:
        """Render host-supplied bytes through macOS Quick Look off the loop."""
        try:
            data = base64.b64decode(req.data_b64, validate=True)
        except (ValueError, TypeError):
            return JSONResponse({"code": "QUICKLOOK_BAD_REQUEST", "error": "invalid base64"}, status_code=400)
        png = await until_hangup(request, asyncio.to_thread(quicklook_preview_png, req.name, data))
        return {"png_b64": None if png is None else base64.b64encode(png).decode("ascii")}

    @app.post("/ocr")
    async def ocr(req: OcrRequest, request: Request) -> Any:
        """Recognize text with macOS Vision without blocking the event loop."""
        try:
            data = base64.b64decode(req.data_b64, validate=True)
        except (ValueError, TypeError):
            return JSONResponse({"code": "OCR_BAD_REQUEST", "error": "invalid base64"}, status_code=400)
        text = await until_hangup(
            request,
            asyncio.to_thread(ocr_recognize, req.mime, req.ext, data),
        )
        return {"text": text}

    @app.post("/knowledge_extract")
    async def knowledge_extract(req: KnowledgeExtractRequest, request: Request) -> Any:
        # knowledge.rs cmd_extract (mode="fields") / cmd_add_file "for each"
        # (mode="list"). Both are STRUCTURED calls reproducing chat_structured
        # (schema-in-prompt priming + recover_json). An engine failure surfaces as
        # 502 {error, code} like /generate — the Rust caller rebuilds OLLAMA_DOWN /
        # MODEL_MISSING:<model>. (cmd_extract itself swallows a failed row into
        # "(not found)" via unwrap_or_default; leaving the sentinel visible here is
        # a superset — Rust maps it back to an empty row if it wants the old
        # best-effort behavior.)
        try:
            if req.mode == "cast":
                # story.rs: a character sheet -> the people in it. Nothing is
                # written by this call; the host shows them to be checked and
                # edited first, which is what makes a MODEL safe to use here
                # at all — it can misread, and the preview is the guard.
                cast = await until_hangup(
                    request,
                    chat_docs.extract_cast(
                        req.model,
                        req.base_url,
                        req.document,
                        temperature=req.temperature,
                        keep_alive=req.keep_alive,
                        privacy=req.privacy,
                        provider=req.provider,
                    ),
                )
                return {"cast": cast}
            if req.mode == "list":
                items = await until_hangup(
                    request,
                    chat_docs.enumerate_names(
                        req.model,
                        req.base_url,
                        req.subject,
                        req.conversation,
                        temperature=req.temperature,
                        keep_alive=req.keep_alive,
                        privacy=req.privacy,
                        provider=req.provider,
                    ),
                )
                return {"items": items}
            values = await until_hangup(
                request,
                chat_docs.extract_fields(
                    req.model,
                    req.base_url,
                    req.fields,
                    req.document,
                    temperature=req.temperature,
                    keep_alive=req.keep_alive,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"values": values}

    @app.post("/generate_doc")
    async def generate_doc(req: GenerateDocRequest, request: Request) -> Any:
        # knowledge.rs cmd_add_file document body (DOC_SYS). A PLAIN chat turn —
        # returns the raw HTML body; Rust checks emptiness and wraps it. An engine
        # failure surfaces as 502 {error, code} like /generate.
        try:
            text = await until_hangup(
                request,
                chat_docs.generate_doc(
                    req.model,
                    req.base_url,
                    mode=req.mode,
                    topic=req.topic,
                    context=req.context,
                    item=req.item,
                    history=req.history,
                    temperature=req.temperature,
                    keep_alive=req.keep_alive,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"text": text}

    # --- whole-file PASS steps (file_pass.rs execute_pass_step) -------------
    #
    # ADD-32: the durable map/merge/compose job. Rust owns the immutable plan and
    # the DB (it slices each window, loads each step's inputs from the jobs
    # artifacts, stores the returned artifact, and does the no-model publish
    # step); these endpoints own only the compute — the exact prompts, the
    # structured call with model_call's single-retry, and the parse/clamp into the
    # artifact ``{result, thread, skipped}``. A FATAL engine failure (OLLAMA_DOWN /
    # MODEL_MISSING) surfaces as 502 {error, code} so the Rust host parks the job
    # for Resume; a transient double-failure is absorbed into the artifact (map ->
    # skipped, merge -> verbatim concat, compose -> raw notes) exactly like Rust.

    @app.post("/file_pass_map")
    async def file_pass_map(req: file_pass.FilePassMapRequest, request: Request) -> Any:
        try:
            return await until_hangup(
                request,
                file_pass.run_map(
                    model=req.model,
                    base_url=req.base_url,
                    mode=req.mode,
                    file_name=req.file_name,
                    instruction=req.instruction,
                    part=req.part,
                    total=req.total,
                    start=req.start,
                    end=req.end,
                    text_len=req.text_len,
                    thread=req.thread,
                    window_text=req.window_text,
                    keep_alive=req.keep_alive,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()

    @app.post("/rec_read_map")
    async def rec_read_map(req: rec_read.RecReadMapRequest, request: Request) -> Any:
        # One window of a meeting, read into findings. The model answers with the
        # NUMBER of the line each finding came from — never a time — and Rust drops
        # any number that is not a real turn, so a hallucinated moment cannot reach
        # the transcript.
        try:
            return await until_hangup(request, rec_read.read_window(req))
        except llm.LlmError as exc:
            return exc.response()

    @app.post("/file_pass_section")
    async def file_pass_section(
        req: file_pass.FilePassSectionRequest, request: Request
    ) -> Any:
        # The sectioned path: compose ONE ordered section from a group of windows'
        # notes. Publish concatenates the sections, so no call holds the whole file.
        try:
            return await until_hangup(
                request,
                file_pass.run_section(
                    model=req.model,
                    base_url=req.base_url,
                    instruction=req.instruction,
                    file_name=req.file_name,
                    section=req.section,
                    total=req.total,
                    sections=req.sections,
                    missing=req.missing,
                    keep_alive=req.keep_alive,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except llm.LlmError as exc:
            return exc.response()

    @app.post("/wf_node")
    async def wf_node(req: wf_nodes.WfNodeRequest) -> Any:
        """One workflow CHAIN node, as a compiled LangGraph graph.

        MIGRATION slice 1 (owner decision 2026-07-25, "Rust drives, Python
        thinks"): the two workflow arms that are multi-call model chains and
        touch nothing else — ``refine`` and ``plan_and_map`` — run here instead
        of in ``workflow.rs``. Rust keeps the plan, the lane, the interpolation
        against the encrypted DB, ``run_plan``'s wave scheduler and every
        checkpoint. One Rust ``Step`` is still exactly one POST, so the per-wave
        checkpoint contract is untouched and the 33 resume characterization
        tests are structurally unreachable by this change.

        Registered in the SAME ``RunRegistry`` ``/run`` uses, because Stop does
        NOT arrive by the client hanging up: measured against the pinned
        uvicorn 0.51 / starlette 0.52, a non-streaming handler kept running
        three seconds past a hard disconnect. A one-call route tolerates that;
        a seven-call refine would burn six more generations on the GPU after
        the user pressed Stop, holding ``Lane::LocalLlm``'s single slot.
        """
        # Labelled for the `/cancel` reply: this run is one workflow STEP, not a
        # chat answer, and a Stop that reports the wrong thing is worse than one
        # that reports a count.
        token = CancelToken("this workflow step")
        registry.register(req.run_id, token)
        try:
            deps = wf_nodes.NodeDeps(
                model=req.model,
                base_url=req.base_url,
                keep_alive=req.keep_alive,
                privacy=req.privacy,
                provider=req.provider,
                cancel=token,
                parallel=req.parallel,
            )
            if req.kind == "refine":
                return await wf_nodes.run_refine(
                    deps=deps,
                    prompt=req.prompt,
                    rubric=req.rubric,
                    max_rounds=req.max_rounds,
                )
            if req.kind == "plan_and_map":
                return await wf_nodes.run_plan_and_map(
                    deps=deps,
                    objective=req.prompt,
                    context=req.context,
                    max_workers=req.max_workers,
                )
            if req.kind == "extract":
                return await wf_nodes.run_extract(
                    deps=deps, fields=req.fields, context=req.context
                )
            if req.kind == "route":
                return await wf_nodes.run_route(
                    deps=deps,
                    prompt=req.prompt,
                    labels=req.labels,
                    context=req.context,
                )
            if req.kind == "vote":
                return await wf_nodes.run_vote(
                    deps=deps,
                    prompt=req.prompt,
                    mode=req.mode,
                    samples=req.samples,
                )
            return JSONResponse(
                {"error": f"unknown workflow node kind: {req.kind}", "code": "BAD_KIND"},
                status_code=400,
            )
        except wf_nodes.Stopped:
            # Rust's contract for a stopped node is `Ok(None)` -> Err("STOPPED"),
            # which spawn_workflow_job normalises to Paused. Mirror it exactly.
            return JSONResponse({"stopped": True})
        except llm.LlmError as exc:
            return exc.response()
        finally:
            registry.release(req.run_id)

    # --- AI actions / memory / file-meta / adaptive UI text ------------------
    #
    # /ai_action        surfaces an engine failure -> 502 (ai_actions.rs `?`), and
    #                   a bad action id / missing language / empty result -> 4xx.
    # /memory_suggestion, /suggest_file_meta, and /generate_ui_text all SWALLOW an
    #                   engine failure to a quiet default (Rust `unwrap_or_default()`
    #                   for the first two; `generate_ui_text` degrades the same way
    #                   by design, no Rust original), so their logic never raises
    #                   LlmError up here.

    @app.post("/ai_action")
    async def ai_action(req: ai_actions.AiActionRequest, request: Request) -> Any:
        try:
            markdown = await until_hangup(
                request,
                ai_actions.run_ai_action(
                    action=req.action,
                    text=req.text,
                    model=req.model,
                    base_url=req.base_url,
                    instructions=req.instructions,
                    question=req.question,
                    privacy=req.privacy,
                    provider=req.provider,
                ),
            )
        except (ai_actions.ActionError, llm.LlmError) as exc:
            return exc.response()
        return {"markdown": markdown}

    @app.post("/memory_suggestion")
    async def memory_suggestion(
        req: ai_actions.MemorySuggestionRequest, request: Request
    ) -> Any:
        return await until_hangup(
            request,
            ai_actions.memory_suggestion(
                req.model, req.user_text, req.assistant_text, req.base_url,
                privacy=req.privacy, provider=req.provider
            ),
        )

    @app.post("/suggest_file_meta")
    async def suggest_file_meta(req: ai_actions.FileMetaRequest, request: Request) -> Any:
        return await until_hangup(
            request,
            ai_actions.suggest_file_meta(
                req.model, req.current_name, req.text, req.base_url,
                privacy=req.privacy, provider=req.provider
            ),
        )

    # /generate_ui_text: the generic adaptive-UI-text pipe. Never raises — an
    # engine failure or a validation rejection both degrade to `{"text": null}`
    # inside ai_actions.generate_ui_text, so unlike /ai_action there is nothing
    # here to catch.
    @app.post("/generate_ui_text")
    async def generate_ui_text(req: ai_actions.UiTextRequest, request: Request) -> Any:
        text = await until_hangup(
            request,
            ai_actions.generate_ui_text(
                req.kind, req.prompt, req.facts, req.max_words, req.model, req.base_url,
                privacy=req.privacy, provider=req.provider
            ),
        )
        return {"text": text}

    # --- privacy scanner (PRIV-2) -------------------------------------------
    #
    # The judgment half of the privacy gatekeeper: a LOCAL model reads document
    # text (import scan / re-scan job) or a typed chat message (live guard) and
    # names the sensitive strings. Rust stores the findings as marks + stable
    # placeholders; the mechanical door (privacy.py) enforces them at send time.

    @app.post("/privacy_scan")
    async def privacy_scan(req: PrivacyScanRequest, request: Request) -> Any:
        try:
            scan = await until_hangup(
                request,
                privacy_scan_mod.scan_text(
                    req.text,
                    model=req.model,
                    base_url=req.base_url,
                    concepts=req.concepts,
                    known=req.known,
                ),
            )
        except ValueError as exc:
            # A non-local scan model is refused outright: scanning private text
            # through the very door being guarded would BE the leak.
            return JSONResponse(
                status_code=400, content={"error": str(exc), "code": "BAD_REQUEST"}
            )
        except llm.LlmError as exc:
            return exc.response()
        # `complete` is load-bearing: the host records a scan row (= "this file
        # is protected") only for a pass that reached the end of the document.
        return {
            "entities": scan.entities,
            "complete": scan.complete,
            "chunksFailed": scan.chunks_failed,
            "capped": scan.capped,
        }

    # --- web search ---------------------------------------------------------
    #
    # The room's ONE search provider, and the only endpoint here with no model in
    # it: websearch.py scrapes/queries a fixed set of engines and fuses them by
    # relevance. Rust owns the on/off setting, the 15-minute result cache and the
    # tool plumbing; this owns the engines.

    @app.post("/web_search")
    async def web_search(req: WebSearchRequest) -> Any:
        query = req.query.strip()
        if not query:
            return JSONResponse(
                status_code=400,
                content={"error": "web_search needs a query.", "code": "BAD_REQUEST"},
            )
        # websearch.timed_search is BLOCKING (requests, and its own thread pool
        # across the engines, ~3-5s warm) and bounds itself with its own overall
        # deadline. On the event loop it would stall every other lane including
        # /health, which the Rust lifecycle manager reads to decide the sidecar is
        # alive — so it runs in a worker thread, always. It returns the whole
        # response body: hits plus 'merged'/'tookMs' telemetry.
        try:
            payload = await asyncio.to_thread(websearch.timed_search, query, req.limit)
        except Exception as exc:
            # Individual engines already fail soft; reaching here means the fusion
            # itself broke, which is a bug, not a blocked engine. Log the type, not
            # the query (SPEC §6).
            log.warning("web_search failed: %s", type(exc).__name__)
            return JSONResponse(
                status_code=502,
                content={"error": f"Web search failed: {exc}", "code": "WEB_SEARCH_FAILED"},
            )
        return payload

    # --- summarize (MIGRATION Phase 2) --------------------------------------
    #
    # summarize.rs' two-step map-reduce. Rust gathers the file text / cached
    # one-liners from the encrypted DB and calls these; the prompts + the ADD-27
    # read-loop orchestration run here. Rust keeps the deterministic HTML assembly
    # and the "Room summary.html" write. An engine failure surfaces as 502
    # {error, code} like /generate, so Rust rebuilds OLLAMA_DOWN /
    # MODEL_MISSING:<model> — the summarize_room per-file loop aborts on those two
    # and degrades a file to name-and-type on any other error, exactly as before.

    @app.post("/summarize_file")
    async def summarize_file(
        req: summarize_feature.SummarizeFileRequest, request: Request
    ) -> Any:
        # `provider` is optional on the client and defaults to None, so a room on
        # an API provider and a room on plain Ollama build the SAME client here.
        client = summarize_feature.OllamaModelClient(
            req.base_url, req.privacy, req.provider
        )
        try:
            summary = await until_hangup(
                request,
                summarize_feature.summarize_one_file(
                    client, req.model, req.name, req.mime, req.text, req.keep_alive
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"summary": summary}

    @app.post("/combine_summary")
    async def combine_summary(
        req: summarize_feature.CombineSummaryRequest, request: Request
    ) -> Any:
        client = summarize_feature.OllamaModelClient(
            req.base_url, req.privacy, req.provider
        )
        try:
            purpose, questions = await until_hangup(
                request,
                summarize_feature.combine_summary(
                    client, req.model, req.room_name, req.memories, req.file_lines
                ),
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"purpose": purpose, "questions": questions}

    @app.post("/handoff_summary")
    async def handoff_summary(
        req: handoff.HandoffSummaryRequest, request: Request
    ) -> Any:
        try:
            summary = await until_hangup(request, handoff.summarize_for_handoff(req))
        except llm.LlmError as exc:
            return exc.response()
        return {"summary": summary}

    return app


app: Any = create_app()

__all__ = [
    "BodyLimitMiddleware",
    "ClientGone",
    "MAX_REQUEST_BYTES",
    "RunRegistry",
    "TOKEN_ENV",
    "TokenAuthMiddleware",
    "app",
    "create_app",
    "until_hangup",
]
