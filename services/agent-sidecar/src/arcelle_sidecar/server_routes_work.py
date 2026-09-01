"""Workflow, AI-action, web, privacy, and summary route registration."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, facade as _facade_module, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup
from .server_run import _configure_run_privacy as _configure_run_privacy, _extend_policy_from_live_guard as _extend_policy_from_live_guard, _live_guard_model as _live_guard_model, _output_policy as _output_policy, _privacy_receipt as _privacy_receipt, _release_run_resources as _release_run_resources, _run_body as _run_body, _run_deps_factory as _run_deps_factory, _run_privacy_is_engaged as _run_privacy_is_engaged, _run_worker_parallel as _run_worker_parallel, _sanitize_run_delta as _sanitize_run_delta, _sanitize_run_event as _sanitize_run_event, _stamped_run_event as _stamped_run_event, _stream_run_payloads as _stream_run_payloads, _visible_run_event as _visible_run_event
from .server_workflow import _dispatch_workflow_node as _dispatch_workflow_node, _is_allowed_stt_staging_path as _is_allowed_stt_staging_path, _resolved_stt_path as _resolved_stt_path, _stt_files_exist as _stt_files_exist, _stt_media_kind as _stt_media_kind, _stt_path_is_file as _stt_path_is_file, _stt_temp_root as _stt_temp_root, _workflow_node_deps as _workflow_node_deps, run_workflow_node as run_workflow_node, transcribe_staged_file as transcribe_staged_file


def register_work_routes(app: FastAPI, registry: RunRegistry) -> None:
    @app.post("/file_pass_map")
    async def file_pass_map(req: file_pass.FilePassMapRequest, request: Request) -> Any:
        try:
            return await _facade_module().until_hangup(
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
            return await _facade_module().until_hangup(request, rec_read.read_window(req))
        except llm.LlmError as exc:
            return exc.response()

    @app.post("/file_pass_section")
    async def file_pass_section(
        req: file_pass.FilePassSectionRequest, request: Request
    ) -> Any:
        # The sectioned path: compose ONE ordered section from a group of windows'
        # notes. Publish concatenates the sections, so no call holds the whole file.
        try:
            return await _facade_module().until_hangup(
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
        return await _facade_module().run_workflow_node(req, registry)

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
            markdown = await _facade_module().until_hangup(
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
        return await _facade_module().until_hangup(
            request,
            ai_actions.memory_suggestion(
                req.model, req.user_text, req.assistant_text, req.base_url,
                privacy=req.privacy, provider=req.provider
            ),
        )

    @app.post("/suggest_file_meta")
    async def suggest_file_meta(req: ai_actions.FileMetaRequest, request: Request) -> Any:
        return await _facade_module().until_hangup(
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
        text = await _facade_module().until_hangup(
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
            scan = await _facade_module().until_hangup(
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
            summary = await _facade_module().until_hangup(
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
            purpose, questions = await _facade_module().until_hangup(
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
            summary = await _facade_module().until_hangup(request, handoff.summarize_for_handoff(req))
        except llm.LlmError as exc:
            return exc.response()
        return {"summary": summary}
