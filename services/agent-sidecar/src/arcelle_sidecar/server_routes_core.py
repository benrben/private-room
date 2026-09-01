"""Core health, run-control, and model-gateway route registration."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, facade as _facade_module, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup
from .server_run import _configure_run_privacy as _configure_run_privacy, _extend_policy_from_live_guard as _extend_policy_from_live_guard, _live_guard_model as _live_guard_model, _output_policy as _output_policy, _privacy_receipt as _privacy_receipt, _release_run_resources as _release_run_resources, _run_body as _run_body, _run_deps_factory as _run_deps_factory, _run_privacy_is_engaged as _run_privacy_is_engaged, _run_worker_parallel as _run_worker_parallel, _sanitize_run_delta as _sanitize_run_delta, _sanitize_run_event as _sanitize_run_event, _stamped_run_event as _stamped_run_event, _stream_run_payloads as _stream_run_payloads, _visible_run_event as _visible_run_event
from .server_workflow import _dispatch_workflow_node as _dispatch_workflow_node, _is_allowed_stt_staging_path as _is_allowed_stt_staging_path, _resolved_stt_path as _resolved_stt_path, _stt_files_exist as _stt_files_exist, _stt_media_kind as _stt_media_kind, _stt_path_is_file as _stt_path_is_file, _stt_temp_root as _stt_temp_root, _workflow_node_deps as _workflow_node_deps, run_workflow_node as run_workflow_node, transcribe_staged_file as transcribe_staged_file


def register_core_routes(
    app: FastAPI,
    registry: RunRegistry,
    chat_factory: ChatModelFactory,
    mcp_factory: McpFactory,
) -> None:
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
        run_token = CancelToken()
        registry.register(req.run_id, run_token)
        mcp = mcp_factory(req)
        chat = chat_factory(req)
        policy, engaged = await _configure_run_privacy(req, chat)
        deps_factory = _run_deps_factory(
            chat, run_token, mcp, _run_worker_parallel(req)
        )

        return StreamingResponse(
            _run_body(req, deps_factory, policy, engaged, registry, mcp),
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
            text = await _facade_module().until_hangup(
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
