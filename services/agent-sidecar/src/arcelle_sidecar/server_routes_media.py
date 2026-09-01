"""Media, document, and generation feature route registration."""

from __future__ import annotations

from .server_runtime import AgentSupportRequest as AgentSupportRequest, Any as Any, AsyncIterator as AsyncIterator, Awaitable as Awaitable, CLOUD_WORKER_PARALLEL as CLOUD_WORKER_PARALLEL, Callable as Callable, CancelRequest as CancelRequest, CancelToken as CancelToken, CapabilitiesRequest as CapabilitiesRequest, ChatModel as ChatModel, ChatModelFactory as ChatModelFactory, DeleteRequest as DeleteRequest, Deps as Deps, EmbedRequest as EmbedRequest, Emit as Emit, ExternalChatModel as ExternalChatModel, FastAPI as FastAPI, FeedbackDraftRequest as FeedbackDraftRequest, GenerateDocRequest as GenerateDocRequest, GenerateRequest as GenerateRequest, HealthResponse as HealthResponse, ImageGenerateRequest as ImageGenerateRequest, JSONResponse as JSONResponse, KnowledgeExtractRequest as KnowledgeExtractRequest, LabelRequest as LabelRequest, MAX_REQUEST_BYTES as MAX_REQUEST_BYTES, McpClient as McpClient, McpFactory as McpFactory, ModelsRequest as ModelsRequest, OcrRequest as OcrRequest, OllamaChatModel as OllamaChatModel, OpenAICompatibleChatModel as OpenAICompatibleChatModel, Path as Path, PodcastTtsRequest as PodcastTtsRequest, PrivacyScanRequest as PrivacyScanRequest, PullRequest as PullRequest, QuickLookRequest as QuickLookRequest, Request as Request, RunRequest as RunRequest, SpecialistsRequest as SpecialistsRequest, StreamingResponse as StreamingResponse, SttMediaKind as SttMediaKind, TOKEN_ENV as TOKEN_ENV, TtsRequest as TtsRequest, TypeVar as TypeVar, VideoJobRequest as VideoJobRequest, VideoStartRequest as VideoStartRequest, VisionLocateRequest as VisionLocateRequest, WarmRequest as WarmRequest, WebSearchRequest as WebSearchRequest, _HANGUP_POLL_SECS as _HANGUP_POLL_SECS, _OPEN_PATHS as _OPEN_PATHS, __all__ as __all__, __version__ as __version__, agent_roster as agent_roster, ai_actions as ai_actions, asyncio as asyncio, base64 as base64, chat_docs as chat_docs, compact_json as compact_json, compaction as compaction, contextlib as contextlib, decode_to_pcm as decode_to_pcm, extract_document_text as extract_document_text, facade as _facade_module, features as features, file_pass as file_pass, handoff as handoff, hmac as hmac, httpx as httpx, imagegen as imagegen, is_external_model as is_external_model, llm as llm, log as log, logging as logging, model_limits as model_limits, ocr_recognize as ocr_recognize, os as os, parse_qsl as parse_qsl, privacy_mod as privacy_mod, privacy_scan_mod as privacy_scan_mod, quicklook_preview_png as quicklook_preview_png, reachable_agent_ids as reachable_agent_ids, rec_read as rec_read, register_dict_routes as register_dict_routes, register_rec_routes as register_rec_routes, register_visual_index_routes as register_visual_index_routes, specialist_catalog as specialist_catalog, stream_events as stream_events, stt_engine as stt_engine, summarize_feature as summarize_feature, sys as sys, tempfile as tempfile, tts_mod as tts_mod, videogen as videogen, vision as vision, websearch as websearch, wf_nodes as wf_nodes
from .server_http import BodyLimitMiddleware as BodyLimitMiddleware, ClientGone as ClientGone, RunRegistry as RunRegistry, T as T, TokenAuthMiddleware as TokenAuthMiddleware, _default_chat_model as _default_chat_model, _default_mcp as _default_mcp, until_hangup as until_hangup
from .server_run import _configure_run_privacy as _configure_run_privacy, _extend_policy_from_live_guard as _extend_policy_from_live_guard, _live_guard_model as _live_guard_model, _output_policy as _output_policy, _privacy_receipt as _privacy_receipt, _release_run_resources as _release_run_resources, _run_body as _run_body, _run_deps_factory as _run_deps_factory, _run_privacy_is_engaged as _run_privacy_is_engaged, _run_worker_parallel as _run_worker_parallel, _sanitize_run_delta as _sanitize_run_delta, _sanitize_run_event as _sanitize_run_event, _stamped_run_event as _stamped_run_event, _stream_run_payloads as _stream_run_payloads, _visible_run_event as _visible_run_event
from .server_workflow import _dispatch_workflow_node as _dispatch_workflow_node, _is_allowed_stt_staging_path as _is_allowed_stt_staging_path, _resolved_stt_path as _resolved_stt_path, _stt_files_exist as _stt_files_exist, _stt_media_kind as _stt_media_kind, _stt_path_is_file as _stt_path_is_file, _stt_temp_root as _stt_temp_root, _workflow_node_deps as _workflow_node_deps, run_workflow_node as run_workflow_node, transcribe_staged_file as transcribe_staged_file


def register_media_routes(app: FastAPI) -> None:
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
        return await _facade_module().transcribe_staged_file(request)

    @app.post("/docs/extract")
    async def docs_extract(request: Request) -> Any:
        """Extract text from one host-staged room document.

        Only the Electron host's private temporary directories are accepted;
        the endpoint cannot be used as a general local-file reader.
        """
        body = await request.json()
        staged = _facade_module().Path(str(body.get("path", ""))).resolve()
        temp_root = _facade_module().Path(tempfile.gettempdir()).resolve()
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
                _facade_module().extract_document_text,
                str(body.get("name", staged.name)),
                data,
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
            questions = await _facade_module().until_hangup(
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
            draft = await _facade_module().until_hangup(
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
            boxes = await _facade_module().until_hangup(
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
        png = await _facade_module().until_hangup(
            request,
            asyncio.to_thread(_facade_module().quicklook_preview_png, req.name, data),
        )
        return {"png_b64": None if png is None else base64.b64encode(png).decode("ascii")}

    @app.post("/ocr")
    async def ocr(req: OcrRequest, request: Request) -> Any:
        """Recognize text with macOS Vision without blocking the event loop."""
        try:
            data = base64.b64decode(req.data_b64, validate=True)
        except (ValueError, TypeError):
            return JSONResponse({"code": "OCR_BAD_REQUEST", "error": "invalid base64"}, status_code=400)
        text = await _facade_module().until_hangup(
            request,
            asyncio.to_thread(_facade_module().ocr_recognize, req.mime, req.ext, data),
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
                cast = await _facade_module().until_hangup(
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
                items = await _facade_module().until_hangup(
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
            values = await _facade_module().until_hangup(
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
            text = await _facade_module().until_hangup(
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
