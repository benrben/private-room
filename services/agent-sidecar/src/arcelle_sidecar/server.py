"""The sidecar's authenticated HTTP surface and route composition."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup
from .server_run import _configure_run_privacy as _configure_run_privacy, _extend_policy_from_live_guard as _extend_policy_from_live_guard, _live_guard_model as _live_guard_model, _output_policy as _output_policy, _privacy_receipt as _privacy_receipt, _release_run_resources as _release_run_resources, _run_body as _run_body, _run_deps_factory as _run_deps_factory, _run_privacy_is_engaged as _run_privacy_is_engaged, _run_worker_parallel as _run_worker_parallel, _sanitize_run_delta as _sanitize_run_delta, _sanitize_run_event as _sanitize_run_event, _stamped_run_event as _stamped_run_event, _stream_run_payloads as _stream_run_payloads, _visible_run_event as _visible_run_event
from .server_workflow import _dispatch_workflow_node as _dispatch_workflow_node, _is_allowed_stt_staging_path as _is_allowed_stt_staging_path, _resolved_stt_path as _resolved_stt_path, _stt_files_exist as _stt_files_exist, _stt_media_kind as _stt_media_kind, _stt_path_is_file as _stt_path_is_file, _stt_temp_root as _stt_temp_root, _workflow_node_deps as _workflow_node_deps, run_workflow_node as run_workflow_node, transcribe_staged_file as transcribe_staged_file
from .server_routes_core import register_core_routes
from .server_routes_media import register_media_routes
from .server_routes_work import register_work_routes


def create_app(
    chat_factory: ChatModelFactory = _default_chat_model,
    mcp_factory: McpFactory = _default_mcp,
    token: str | None = None,
) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        warm = asyncio.get_running_loop().create_task(tts_mod.warm_import())
        try:
            yield
        finally:
            warm.cancel()

    app = FastAPI(title="Arcelle agent sidecar", version=__version__, lifespan=lifespan)
    app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)
    token = os.environ.get(TOKEN_ENV, "") if token is None else token
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    register_rec_routes(app)
    register_dict_routes(app)
    register_visual_index_routes(app)
    registry = RunRegistry()
    app.state.registry = registry
    register_core_routes(app, registry, chat_factory, mcp_factory)
    register_media_routes(app)
    register_work_routes(app, registry)
    return app
