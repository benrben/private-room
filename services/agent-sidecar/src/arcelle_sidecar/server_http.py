"""Server model factories, middleware, hangup handling, and run registry."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes, facade as _facade_module

def _default_chat_model(req: RunRequest) -> ChatModel:
    if req.provider is not None:
        return _facade_module().OpenAICompatibleChatModel(
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
        supports_vision=req.supports_vision,
    )


def _default_mcp(req: RunRequest) -> McpClient | None:
    if req.mcp is None:
        return None
    return McpClient(req.mcp.url, req.mcp.token)


class BodyLimitMiddleware:
    """Refuse a request whose declared body is past :data:`_facade_module().MAX_REQUEST_BYTES`.

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
            done, _pending = await asyncio.wait({task}, timeout=_facade_module()._HANGUP_POLL_SECS)
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
