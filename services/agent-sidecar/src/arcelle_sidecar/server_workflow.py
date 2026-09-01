"""Staged speech-to-text and workflow-node adapters."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, facade as _facade_module, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup
from .server_run import _configure_run_privacy as _configure_run_privacy, _extend_policy_from_live_guard as _extend_policy_from_live_guard, _live_guard_model as _live_guard_model, _output_policy as _output_policy, _privacy_receipt as _privacy_receipt, _release_run_resources as _release_run_resources, _run_body as _run_body, _run_deps_factory as _run_deps_factory, _run_privacy_is_engaged as _run_privacy_is_engaged, _run_worker_parallel as _run_worker_parallel, _sanitize_run_delta as _sanitize_run_delta, _sanitize_run_event as _sanitize_run_event, _stamped_run_event as _stamped_run_event, _stream_run_payloads as _stream_run_payloads, _visible_run_event as _visible_run_event

def _resolved_stt_path(value: Any) -> Path:
    return _facade_module().Path(str(value)).resolve()


def _stt_temp_root() -> Path:
    return _facade_module().Path(tempfile.gettempdir()).resolve()


def _stt_path_is_file(path: Path) -> bool:
    return path.is_file()


def _is_allowed_stt_staging_path(staged: Path, temp_root: Path) -> bool:
    return staged.parent.parent == temp_root and staged.parent.name.startswith("arcelle-stt-")


def _stt_files_exist(
    staged: Path, model_path: Path, is_file: Callable[[Path], bool]
) -> bool:
    return is_file(staged) and is_file(model_path)


def _stt_media_kind(body: dict[str, Any]) -> SttMediaKind:
    return SttMediaKind.VIDEO if body.get("kind") == "video" else SttMediaKind.AUDIO


async def transcribe_staged_file(
    request: Request,
    *,
    path_from_value: Callable[[Any], Path] = _resolved_stt_path,
    temp_root: Callable[[], Path] = _stt_temp_root,
    is_file: Callable[[Path], bool] = _stt_path_is_file,
    decode: Callable[[Path, SttMediaKind], Any] = decode_to_pcm,
    transcribe: Callable[[str, Any, bool], str] = stt_engine.transcribe,
    run_blocking: Callable[..., Awaitable[Any]] = asyncio.to_thread,
) -> Any:
    """Transcribe one approved host-staged file through injectable local seams."""
    body = await request.json()
    staged = path_from_value(body.get("path", ""))
    if not _is_allowed_stt_staging_path(staged, temp_root()):
        return JSONResponse(
            {"code": "STT_BAD_REQUEST", "error": "the staged audio path was refused"},
            status_code=400,
        )
    model_path = path_from_value(body.get("model_path", ""))
    if not _stt_files_exist(staged, model_path, is_file):
        return JSONResponse(
            {"code": "STT_BAD_REQUEST", "error": "the audio file or speech model is missing"},
            status_code=400,
        )
    try:
        pcm = await run_blocking(decode, staged, _stt_media_kind(body))
        text = await run_blocking(transcribe, str(model_path), pcm, True)
        return {"text": text}
    except (OSError, RuntimeError, ValueError) as exc:
        return JSONResponse(
            {"code": "STT_FAILED", "error": str(exc)}, status_code=502
        )


def _workflow_node_deps(
    req: wf_nodes.WfNodeRequest, token: CancelToken
) -> wf_nodes.NodeDeps:
    return wf_nodes.NodeDeps(
        model=req.model,
        base_url=req.base_url,
        keep_alive=req.keep_alive,
        privacy=req.privacy,
        provider=req.provider,
        cancel=token,
        parallel=req.parallel,
    )


async def _dispatch_workflow_node(
    req: wf_nodes.WfNodeRequest, deps: wf_nodes.NodeDeps
) -> Any:
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
        return await wf_nodes.run_extract(deps=deps, fields=req.fields, context=req.context)
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


async def run_workflow_node(req: wf_nodes.WfNodeRequest, registry: RunRegistry) -> Any:
    """Run one registered workflow node and always release its Stop handle."""
    token = CancelToken("this workflow step")
    registry.register(req.run_id, token)
    try:
        return await _dispatch_workflow_node(req, _workflow_node_deps(req, token))
    except wf_nodes.Stopped:
        # Rust's contract for a stopped node is `Ok(None)` -> Err("STOPPED"),
        # which spawn_workflow_job normalises to Paused. Mirror it exactly.
        return JSONResponse({"stopped": True})
    except llm.LlmError as exc:
        return exc.response()
    finally:
        registry.release(req.run_id)
