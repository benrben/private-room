"""Privacy-aware run construction and NDJSON streaming."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, facade as _facade_module, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup

def _run_privacy_is_engaged(policy: Any, model: str) -> bool:
    """Whether this request needs the outbound cloud-privacy door."""
    return bool(
        policy is not None
        and policy.active
        and (privacy_mod.is_nonlocal_model(model) or policy.relayed)
    )


def _live_guard_model(req: RunRequest, policy: Any) -> str:
    """Return the optional local scanner only when concept rules need it."""
    if not policy.concepts:
        return ""
    return str((req.privacy or {}).get("guard_model") or "")


async def _extend_policy_from_live_guard(req: RunRequest, policy: Any) -> None:
    """Best-effort scan of the newly typed question for ephemeral redactions."""
    guard_model = _live_guard_model(req, policy)
    if not guard_model:
        return
    try:
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
    except Exception:  # noqa: BLE001 - guard is best-effort by design
        log.warning("privacy live guard unavailable; exact rules still apply")
        return
    taken = {placeholder for _, placeholder in policy.rules}
    policy.add_rules(privacy_scan_mod.mint_ephemeral_rules(scan.entities, taken))


async def _configure_run_privacy(req: RunRequest, chat: ChatModel) -> tuple[Any, bool]:
    """Resolve request-scoped privacy and attach it only when the door engages."""
    policy = privacy_mod.policy_from_payload(req.privacy)
    engaged = _run_privacy_is_engaged(policy, req.model)
    if not engaged:
        return policy, False
    await _extend_policy_from_live_guard(req, policy)
    chat.privacy = policy  # type: ignore[attr-defined]
    return policy, True


def _run_worker_parallel(req: RunRequest) -> int:
    """Choose safe local serialization or bounded cloud child concurrency."""
    return (
        CLOUD_WORKER_PARALLEL
        if (req.provider is not None or privacy_mod.is_nonlocal_model(req.model))
        else 1
    )


def _run_deps_factory(
    chat: ChatModel,
    token: CancelToken,
    mcp: McpClient | None,
    worker_parallel: int,
) -> Callable[[Emit], Deps]:
    """Bind request-scoped resources for each graph event emitter."""
    def factory(emit: Emit) -> Deps:
        return Deps(
            chat=chat,
            emit=emit,
            cancel=token,
            mcp=mcp,
            worker_parallel=worker_parallel,
        )

    return factory


def _stamped_run_event(event: dict[str, Any], run_id: str) -> bytes:
    """Encode one wire event with the request identifier the host owns."""
    return (compact_json({**event, "run_id": run_id}) + "\n").encode("utf-8")


def _output_policy(policy: Any) -> Any | None:
    """Use final-output sanitization whenever the request policy is active."""
    return policy if policy is not None and policy.active else None


def _sanitize_run_delta(
    event: dict[str, Any],
    policy: Any,
    streams: dict[str, Any],
) -> dict[str, Any] | None:
    """Gate one live delta through the redactor owned by its graph node."""
    node = str(event.get("node") or "main")
    redactor = streams.setdefault(node, policy.output_redactor())
    visible = redactor.feed(str(event.get("v") or ""))
    if not visible:
        return None
    event["v"] = visible
    return event


def _sanitize_run_event(
    event: dict[str, Any], policy: Any, streams: dict[str, Any]
) -> dict[str, Any] | None:
    """Apply final disclosure gating while retaining each graph event's shape."""
    event_type = event.get("t")
    if event_type == "round":
        streams.pop(str(event.get("node") or "main"), None)
        return event
    if event_type == "delta":
        return _sanitize_run_delta(event, policy, streams)
    return policy.sanitize_output_value(event)


def _visible_run_event(
    event: dict[str, Any], policy: Any | None, streams: dict[str, Any]
) -> dict[str, Any] | None:
    """Copy and gate an event only when the request has active privacy rules."""
    if policy is None:
        return event
    return _sanitize_run_event(dict(event), policy, streams)


async def _stream_run_payloads(
    req: RunRequest,
    deps_factory: Callable[[Emit], Deps],
    policy: Any | None,
) -> AsyncIterator[bytes]:
    """Stream every visible graph event as a stamped NDJSON payload."""
    streams: dict[str, Any] = {}
    async for event in _facade_module().stream_events(req, deps_factory):
        visible = _visible_run_event(event, policy, streams)
        if visible is None:
            continue
        yield _stamped_run_event(visible, req.run_id)


def _privacy_receipt(policy: Any, engaged: bool, run_id: str) -> bytes | None:
    """Return the terminal privacy report when the outbound door was active."""
    if not engaged or policy is None:
        return None
    return _stamped_run_event({"t": "privacy", "v": policy.report.as_payload()}, run_id)


async def _release_run_resources(
    registry: RunRegistry, run_id: str, mcp: McpClient | None
) -> None:
    """Release cancellation lookup and close the request's room bridge once."""
    registry.release(run_id)
    if mcp is not None:
        await mcp.aclose()


async def _run_body(
    req: RunRequest,
    deps_factory: Callable[[Emit], Deps],
    policy: Any,
    engaged: bool,
    registry: RunRegistry,
    mcp: McpClient | None,
) -> AsyncIterator[bytes]:
    """Serve one request's graph events and always release its resources."""
    try:
        async for payload in _stream_run_payloads(req, deps_factory, _output_policy(policy)):
            yield payload
        receipt = _privacy_receipt(policy, engaged, req.run_id)
        if receipt is not None:
            yield receipt
    except httpx.HTTPError as exc:
        log.warning("room bridge transport failure: %s", type(exc).__name__)
        yield _stamped_run_event({"t": "error", "v": str(exc)}, req.run_id)
    finally:
        await _release_run_resources(registry, req.run_id, mcp)
