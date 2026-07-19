"""The sidecar's HTTP surface (SPEC §5).

Loopback only, three endpoints, no state that outlives a run:

  GET  /health -> {"ok": true, "version": "..."}   (the Rust lifecycle manager)
  POST /run    -> application/x-ndjson, one SPEC §4 event per line
  POST /cancel -> {"run_id": "..."}; the loop checks between rounds and between
                  tool calls, so Stop stops within one tool call, not one round.

Nothing here logs message content: the sidecar handles the user's private files
and a log line is a copy of them that outlives the run (SPEC §6).
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__, ai_actions, chat_docs, features, file_pass, llm, vision
from . import summarize as summarize_feature
from . import tts as tts_mod
from .chat import ChatModel, OllamaChatModel
from .config import (
    CancelRequest,
    CapabilitiesRequest,
    DeleteRequest,
    EmbedRequest,
    FeedbackDraftRequest,
    GenerateDocRequest,
    GenerateRequest,
    HealthResponse,
    KnowledgeExtractRequest,
    LabelRequest,
    ModelsRequest,
    PullRequest,
    RunRequest,
    TtsRequest,
    VisionLocateRequest,
    WarmRequest,
)
from .graph import CancelToken, Deps, Emit, Event, stream_events
from .mcp_client import McpClient
from .messages import compact_json

log = logging.getLogger("privateroom_sidecar")

#: A factory so tests can inject a scripted model instead of a real Ollama.
ChatModelFactory = Callable[[RunRequest], ChatModel]
McpFactory = Callable[[RunRequest], McpClient | None]


def _default_chat_model(req: RunRequest) -> ChatModel:
    return OllamaChatModel(
        model=req.model,
        base_url=req.ollama_base_url,
        temperature=req.temperature,
    )


def _default_mcp(req: RunRequest) -> McpClient | None:
    if req.mcp is None:
        return None
    return McpClient(req.mcp.url, req.mcp.token)


class RunRegistry:
    """Live runs, so /cancel can find one. Entries die with the run."""

    def __init__(self) -> None:
        self._tokens: dict[str, CancelToken] = {}

    def register(self, run_id: str, token: CancelToken) -> None:
        if run_id:
            self._tokens[run_id] = token

    def release(self, run_id: str) -> None:
        self._tokens.pop(run_id, None)

    def cancel(self, run_id: str) -> bool:
        """True if we knew the run. A no-op for an unknown id — the ask may have
        already finished (same contract as the Rust ``cancel_ask``)."""
        token = self._tokens.get(run_id)
        if token is None:
            return False
        token.cancel()
        return True

    def __len__(self) -> int:  # pragma: no cover - introspection
        return len(self._tokens)


def create_app(
    chat_factory: ChatModelFactory = _default_chat_model,
    mcp_factory: McpFactory = _default_mcp,
) -> FastAPI:
    app = FastAPI(title="Private Room agent sidecar", version=__version__)
    registry = RunRegistry()
    app.state.registry = registry

    @app.get("/health")
    async def health() -> HealthResponse:
        return HealthResponse(ok=True, version=__version__)

    @app.post("/run")
    async def run(req: RunRequest) -> StreamingResponse:
        token = CancelToken()
        registry.register(req.run_id, token)
        mcp = mcp_factory(req)
        chat = chat_factory(req)

        def deps_factory(emit: Emit) -> Deps:
            return Deps(chat=chat, emit=emit, cancel=token, mcp=mcp)

        async def body() -> AsyncIterator[bytes]:
            try:
                async for event in stream_events(req, deps_factory):
                    yield (compact_json(event) + "\n").encode("utf-8")
            except httpx.HTTPError as exc:
                # The bridge died mid-run: tell the host so it can fall back to
                # the native engine instead of hanging.
                log.warning("room bridge transport failure: %s", type(exc).__name__)
                yield (compact_json({"t": "error", "v": str(exc)}) + "\n").encode("utf-8")
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
        known = registry.cancel(req.run_id)
        return JSONResponse({"ok": True, "known": known})

    # --- LLM gateway (MIGRATION Phase 1) ------------------------------------
    #
    # The sidecar is the app's SOLE AI service: Rust gathers DB text and calls
    # these; the model I/O happens here. A classified engine failure comes back
    # as a non-2xx ``{error, code}`` body so the Rust gateway can rebuild the
    # OLLAMA_DOWN / MODEL_MISSING:<model> sentinels its callers branch on.

    @app.post("/embed")
    async def embed(req: EmbedRequest) -> Any:
        try:
            vectors = await llm.embed(req.model, req.texts, req.base_url, req.keep_alive)
        except llm.LlmError as exc:
            return exc.response()
        return {"embeddings": vectors}

    @app.post("/generate")
    async def generate(req: GenerateRequest) -> Any:
        try:
            text = await llm.generate(
                req.model,
                req.messages,
                req.base_url,
                temperature=req.temperature,
                num_ctx=req.num_ctx,
                keep_alive=req.keep_alive,
                format=req.format,
                images=req.images,
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
        or offline service is a clean 502 so the webview can fall back to the
        on-device AVSpeech voice for that sentence.
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


    @app.post("/label")
    async def label(req: LabelRequest) -> Any:
        # D4 front-page suggestions. There is no room-GRAPH AI labeling to serve
        # here — graph.rs build_room_graph is model-free by design.
        try:
            questions = await features.front_page_labels(
                req.model, req.room_name, req.files, req.base_url
            )
        except llm.LlmError:
            # Front page is resilient: any engine failure yields no suggestions,
            # and the Rust caller falls back to its cached list.
            return {"questions": []}
        return {"questions": questions}

    @app.post("/feedback_draft")
    async def feedback_draft(req: FeedbackDraftRequest) -> Any:
        try:
            draft = await features.feedback_draft(req.model, req.text, req.base_url)
        except llm.LlmError as exc:
            return exc.response()
        return draft

    @app.post("/vision_locate")
    async def vision_locate(req: VisionLocateRequest) -> Any:
        # vision.rs locate_in_image: prepare the image, ground the query with the
        # boxes schema via the Phase-1 /generate path, parse to normalized boxes.
        # An engine failure surfaces as 502 {error, code} exactly like /generate —
        # the Rust caller rebuilds OLLAMA_DOWN / MODEL_MISSING:<model> for the UI.
        try:
            boxes = await vision.vision_locate(
                req.model,
                req.image_b64,
                req.query,
                req.base_url,
                temperature=req.temperature,
                num_ctx=req.num_ctx,
                keep_alive=req.keep_alive,
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"boxes": boxes}

    @app.post("/knowledge_extract")
    async def knowledge_extract(req: KnowledgeExtractRequest) -> Any:
        # knowledge.rs cmd_extract (mode="fields") / cmd_add_file "for each"
        # (mode="list"). Both are STRUCTURED calls reproducing chat_structured
        # (schema-in-prompt priming + recover_json). An engine failure surfaces as
        # 502 {error, code} like /generate — the Rust caller rebuilds OLLAMA_DOWN /
        # MODEL_MISSING:<model>. (cmd_extract itself swallows a failed row into
        # "(not found)" via unwrap_or_default; leaving the sentinel visible here is
        # a superset — Rust maps it back to an empty row if it wants the old
        # best-effort behavior.)
        try:
            if req.mode == "list":
                items = await chat_docs.enumerate_names(
                    req.model,
                    req.base_url,
                    req.subject,
                    req.conversation,
                    temperature=req.temperature,
                    keep_alive=req.keep_alive,
                )
                return {"items": items}
            values = await chat_docs.extract_fields(
                req.model,
                req.base_url,
                req.fields,
                req.document,
                temperature=req.temperature,
                keep_alive=req.keep_alive,
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"values": values}

    @app.post("/generate_doc")
    async def generate_doc(req: GenerateDocRequest) -> Any:
        # knowledge.rs cmd_add_file document body (DOC_SYS). A PLAIN chat turn —
        # returns the raw HTML body; Rust checks emptiness and wraps it. An engine
        # failure surfaces as 502 {error, code} like /generate.
        try:
            text = await chat_docs.generate_doc(
                req.model,
                req.base_url,
                mode=req.mode,
                topic=req.topic,
                context=req.context,
                item=req.item,
                history=req.history,
                temperature=req.temperature,
                keep_alive=req.keep_alive,
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
    async def file_pass_map(req: file_pass.FilePassMapRequest) -> Any:
        try:
            return await file_pass.run_map(
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
            )
        except llm.LlmError as exc:
            return exc.response()

    @app.post("/file_pass_section")
    async def file_pass_section(req: file_pass.FilePassSectionRequest) -> Any:
        # The sectioned path: compose ONE ordered section from a group of windows'
        # notes. Publish concatenates the sections, so no call holds the whole file.
        try:
            return await file_pass.run_section(
                model=req.model,
                base_url=req.base_url,
                instruction=req.instruction,
                file_name=req.file_name,
                section=req.section,
                total=req.total,
                sections=req.sections,
                missing=req.missing,
                keep_alive=req.keep_alive,
            )
        except llm.LlmError as exc:
            return exc.response()

    # --- AI actions / memory / file-meta (moonshot/ai_actions.rs) -----------
    #
    # /ai_action        surfaces an engine failure -> 502 (ai_actions.rs `?`), and
    #                   a bad action id / missing language / empty result -> 4xx.
    # /memory_suggestion and /suggest_file_meta both SWALLOW an engine failure to a
    #                   quiet default (Rust `unwrap_or_default()`), so their logic
    #                   never raises LlmError up here.

    @app.post("/ai_action")
    async def ai_action(req: ai_actions.AiActionRequest) -> Any:
        try:
            markdown = await ai_actions.run_ai_action(
                action=req.action,
                text=req.text,
                model=req.model,
                base_url=req.base_url,
                instructions=req.instructions,
                question=req.question,
            )
        except (ai_actions.ActionError, llm.LlmError) as exc:
            return exc.response()
        return {"markdown": markdown}

    @app.post("/memory_suggestion")
    async def memory_suggestion(req: ai_actions.MemorySuggestionRequest) -> Any:
        return await ai_actions.memory_suggestion(
            req.model, req.user_text, req.assistant_text, req.base_url
        )

    @app.post("/suggest_file_meta")
    async def suggest_file_meta(req: ai_actions.FileMetaRequest) -> Any:
        return await ai_actions.suggest_file_meta(
            req.model, req.current_name, req.text, req.base_url
        )

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
    async def summarize_file(req: summarize_feature.SummarizeFileRequest) -> Any:
        client = summarize_feature.OllamaModelClient(req.base_url)
        try:
            summary = await summarize_feature.summarize_one_file(
                client, req.model, req.name, req.mime, req.text, req.keep_alive
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"summary": summary}

    @app.post("/combine_summary")
    async def combine_summary(req: summarize_feature.CombineSummaryRequest) -> Any:
        client = summarize_feature.OllamaModelClient(req.base_url)
        try:
            purpose, questions = await summarize_feature.combine_summary(
                client, req.model, req.room_name, req.memories, req.file_lines
            )
        except llm.LlmError as exc:
            return exc.response()
        return {"purpose": purpose, "questions": questions}

    return app


def make_event_line(event: Event) -> str:  # pragma: no cover - helper for hosts
    return compact_json(event) + "\n"


app: Any = create_app()

__all__ = ["create_app", "app", "RunRegistry", "make_event_line"]
