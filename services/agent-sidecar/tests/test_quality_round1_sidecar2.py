from __future__ import annotations

import asyncio
import base64
import contextlib
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from fastapi import FastAPI

from arcelle_sidecar import chat, compaction, deep_harness, graph, graphs, imagegen, llm, privacy, server, videogen, websearch, wf_nodes
from arcelle_sidecar.docs import mail, xml_utils
from arcelle_sidecar.media import decode, ocr, quicklook
from arcelle_sidecar import mcp_client
from arcelle_sidecar.rec import session_ws


def test_quicklook_failure_and_encoding_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(quicklook.os, "unlink", lambda _path: (_ for _ in ()).throw(OSError("gone")))
    quicklook._remove("fake")

    monkeypatch.setattr(quicklook, "temp_path_for", lambda _name: "/fake/preview.pages")
    monkeypatch.setattr(quicklook, "write_private", lambda *_args: (_ for _ in ()).throw(FileExistsError()))
    assert quicklook.preview_png("preview.pages", b"bytes") is None

    removed: list[str] = []
    monkeypatch.setattr(quicklook, "_remove", lambda path: removed.append(str(path)))
    monkeypatch.setattr(quicklook, "write_private", lambda *_args: (_ for _ in ()).throw(OSError("full")))
    assert quicklook.preview_png("preview.pages", b"bytes") is None
    assert removed == ["/fake/preview.pages"]

    monkeypatch.setattr(quicklook, "_QUICKLOOK_AVAILABLE", False)
    assert quicklook.thumbnail_png("/fake/input", 10) is None

    class Rep:
        def __init__(self, cg: object | None) -> None:
            self.cg = cg

        def CGImage(self) -> object | None:
            return self.cg

    assert quicklook._png_of(Rep(None)) is None
    fake_appkit = SimpleNamespace(
        NSBitmapImageFileTypePNG=1,
        NSBitmapImageRep=SimpleNamespace(
            alloc=lambda: SimpleNamespace(initWithCGImage_=lambda _cg: None)
        ),
    )
    monkeypatch.setattr(quicklook, "AppKit", fake_appkit, raising=False)
    assert quicklook._png_of(Rep(object())) is None
    bitmap = SimpleNamespace(representationUsingType_properties_=lambda *_args: None)
    fake_appkit.NSBitmapImageRep = SimpleNamespace(
        alloc=lambda: SimpleNamespace(initWithCGImage_=lambda _cg: bitmap)
    )
    assert quicklook._png_of(Rep(object())) is None


def test_websearch_thread_session_get_and_refusals(monkeypatch: pytest.MonkeyPatch) -> None:
    worker = object()
    monkeypatch.setattr(threading, "current_thread", lambda: worker)
    monkeypatch.setattr(threading, "main_thread", lambda: object())
    monkeypatch.setattr(websearch, "_LOCAL", SimpleNamespace())
    made = object()
    monkeypatch.setattr(websearch.requests, "Session", lambda: made)
    assert websearch._session() is made
    assert websearch._session() is made

    calls: list[tuple[str, dict]] = []
    fake_session = SimpleNamespace(get=lambda url, **kwargs: calls.append((url, kwargs)) or object())
    monkeypatch.setattr(websearch, "_session", lambda: fake_session)
    monkeypatch.setattr(websearch, "_browser_headers", lambda: {"User-Agent": "fake", "A": "base"})
    websearch._get("https://fake", timeout=3, headers={"A": "caller"}, params={"q": "x"})
    assert calls[-1] == (
        "https://fake",
        {"headers": {"User-Agent": "fake", "A": "caller"}, "timeout": (3, 3), "params": {"q": "x"}},
    )
    websearch._get("https://fake", timeout=(1, 2))
    assert calls[-1][1]["timeout"] == (1, 2)

    response = object()
    monkeypatch.setattr(websearch, "_get", lambda *_args, **_kwargs: response)
    monkeypatch.setattr(websearch, "_ok", lambda *_args: False)
    assert websearch.brave("q") == []
    assert websearch.marginalia("q") == []


def test_decode_failure_normalization_and_private_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(decode.os, "chmod", lambda *_args: (_ for _ in ()).throw(OSError("denied")))
    decode._make_private(Path("/fake"))
    monkeypatch.setattr(decode.subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("missing")))
    with pytest.raises(RuntimeError, match="afconvert failed to start"):
        decode._run_afconvert(Path("/in"), Path("/out"))

    monkeypatch.setattr(decode, "_run_afconvert", lambda *_args: None)
    monkeypatch.setattr(decode, "_make_private", lambda *_args: None)
    monkeypatch.setattr(decode, "_remove", lambda *_args: None)
    monkeypatch.setattr(Path, "read_bytes", lambda _self: b"bad")
    monkeypatch.setattr(decode, "decode_wav", lambda _data: (_ for _ in ()).throw(ValueError("bad wav")))
    with pytest.raises(RuntimeError, match="bad wav"):
        decode.decode_to_pcm("/fake/input", decode.MediaKind.AUDIO)

    monkeypatch.setattr(decode, "write_private", lambda *_args: (_ for _ in ()).throw(OSError("full")))
    with pytest.raises(RuntimeError, match="full"):
        decode.decode_bytes_to_pcm(b"audio", "wav", decode.MediaKind.AUDIO)


def test_ocr_fail_closed_and_raster_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    request = SimpleNamespace(supportedRecognitionLanguagesAndReturnError_=lambda _error: ([], object()))
    assert ocr._supported_recognition_ids(request) == []
    monkeypatch.setattr(ocr, "Vision", None)
    assert ocr.ocr_image_bytes(b"image") is None

    class Pool:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(ocr, "Vision", object())
    monkeypatch.setattr(ocr, "objc", SimpleNamespace(autorelease_pool=lambda: Pool()))
    monkeypatch.setattr(
        ocr,
        "NSData",
        SimpleNamespace(dataWithBytes_length_=lambda *_args: (_ for _ in ()).throw(RuntimeError("bad"))),
    )
    assert ocr.ocr_image_bytes(b"bad") is None

    page = SimpleNamespace(mediabox=SimpleNamespace(width=0.0, height=0.0))
    doc = SimpleNamespace(load_page=lambda _page: page)
    monkeypatch.setattr(ocr, "page_raster_size", lambda *_args: None)
    assert ocr._render_pdf_page_png(doc, 0) is None
    assert ocr._render_pdf_page_png(SimpleNamespace(load_page=lambda _n: (_ for _ in ()).throw(RuntimeError())), 0) is None


def test_graph_router_missing_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    assert graphs._probe_is_blocked({}, SimpleNamespace(blockers=())) is False
    assert graphs.route_after_stage_tools({"cancelled": True}) == "synthesize"
    assert graphs.route_after_stage_tools({"round": 2, "max_rounds": 2}) == "synthesize"
    assert graphs.route_after_check({"cancelled": True}) == "synthesize"
    assert graphs.route_after_perceive({"cancelled": True}) == "synthesize"
    assert graphs.route_after_perceive({"round": 2, "max_rounds": 2}) == "synthesize"


class _FakeAsyncClient:
    response: object = None
    error: BaseException | None = None

    def __init__(self, **_kwargs: object) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def request(self, *_args: object, **_kwargs: object) -> object:
        if self.error is not None:
            raise self.error
        return self.response


@pytest.mark.asyncio
async def test_videogen_validation_and_call_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(videogen, "MAX_REFERENCE_BYTES", 1)
    with pytest.raises(videogen.VideoGenError, match="over this room"):
        videogen._validate_reference_size(b"xx")

    monkeypatch.setattr(videogen.httpx, "AsyncClient", _FakeAsyncClient)
    provider = SimpleNamespace(base_url="https://fake/", api_key="fake")
    _FakeAsyncClient.error = httpx.ConnectError("offline", request=httpx.Request("GET", "https://fake"))
    with pytest.raises(videogen.VideoGenError, match="could not reach"):
        await videogen._call(provider, "GET", "/video")

    _FakeAsyncClient.error = None
    _FakeAsyncClient.response = SimpleNamespace(
        is_success=True, json=lambda: (_ for _ in ()).throw(ValueError("bad"))
    )
    with pytest.raises(videogen.VideoGenError, match="not JSON"):
        await videogen._call(provider, "GET", "/video")
    _FakeAsyncClient.response = SimpleNamespace(is_success=True, json=lambda: ["wrong"])
    with pytest.raises(videogen.VideoGenError, match="unexpected shape"):
        await videogen._call(provider, "GET", "/video")


@pytest.mark.asyncio
async def test_llm_failure_wrapping_and_chat_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    assert llm._provider_host(SimpleNamespace()) is None
    classified = RuntimeError("classified")
    monkeypatch.setattr(llm, "_classify", lambda _exc: classified)
    monkeypatch.setattr(llm, "AsyncClient", lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("no client")))
    with pytest.raises(RuntimeError) as listed:
        await llm.list_models("http://fake")
    assert listed.value is classified
    with pytest.raises(RuntimeError) as warmed:
        await llm.warm("fake", "http://fake")
    assert warmed.value is classified

    assert chat._text_from_chunk_block("plain") == "plain"
    model = chat.OllamaChatModel.__new__(chat.OllamaChatModel)
    model.supports_vision = False
    model._require_image_input([{"role": "user", "content": "text"}])
    model.model = "local"
    monkeypatch.setattr(chat, "is_nonlocal_model", lambda _model: False)
    assert await model._remote_window() is None
    model.base_url = "http://fake"
    model.keep_alive = "5m"
    model.num_predict = 7
    model.temperature = None
    monkeypatch.setitem(sys.modules, "langchain_ollama", SimpleNamespace(ChatOllama=lambda **kwargs: kwargs))
    assert model._llm(None)["num_predict"] == 7


def test_mail_image_xml_and_privacy_boundaries(monkeypatch: pytest.MonkeyPatch) -> None:
    assert mail._rust_lines("") == []
    assert mail._split_headers("Subject: one") == ("Subject: one", "")
    assert mail._decode_base64_text("not valid !!") == "not valid !!"
    with pytest.raises(imagegen.ImageGenError, match="empty"):
        imagegen._reference_b64("  ")
    with pytest.raises(imagegen.ImageGenError, match="not a picture"):
        imagegen._reference_mime("text/plain")
    assert imagegen._provider_error_text({"error": 42}) is None
    assert xml_utils._entity_body_end("without terminator") is None
    assert xml_utils._entity_body_end("abc") is None
    assert privacy.PrivacyPolicy().sanitize_output_text("") == ""


@pytest.mark.asyncio
async def test_mcp_notifications_and_workflow_cancel_boundaries(monkeypatch: pytest.MonkeyPatch) -> None:
    class Http:
        def __init__(self, statuses: list[int]) -> None:
            self.statuses = statuses
            self.calls: list[dict] = []

        async def post(self, _url: str, **kwargs: object) -> object:
            self.calls.append(kwargs["json"])
            return SimpleNamespace(status_code=self.statuses.pop(0))

    http = Http([202, 401, 500])
    client = mcp_client.McpClient("http://fake", "token", client=http)
    await client.notify("ready", {"x": 1})
    assert http.calls[0]["params"] == {"x": 1}
    with pytest.raises(mcp_client.McpError, match="bearer"):
        await client.notify("bad")
    with pytest.raises(mcp_client.McpError, match="HTTP 500"):
        await client.notify("bad")

    class Cancel:
        reads = 0

        @property
        def cancelled(self) -> bool:
            self.reads += 1
            return self.reads > 1

    deps = wf_nodes.NodeDeps.__new__(wf_nodes.NodeDeps)
    deps.cancel = Cancel()
    deps._sem = asyncio.Semaphore(1)
    with pytest.raises(wf_nodes.Stopped):
        await deps.gen("fake")
    monkeypatch.setattr(wf_nodes, "STUDIO_DEPS", None)
    with pytest.raises(RuntimeError, match="without NodeDeps"):
        wf_nodes._deps({})


def test_graph_and_protocol_adapter_limits() -> None:
    token = graph.CancelToken("test")
    assert bool(token) is False
    assert graph._args_summary({"a": 1, "b": 2, "c": 3}) == "a=1, b=2, …"
    assert compaction._Digester.__call__ is not None
    assert chat.Cancellable.cancelled is not None
    assert deep_harness.WorkspaceBridge.call is not None


@pytest.mark.asyncio
async def test_graph_tool_failures_and_batch_cleanup() -> None:
    call = graph.ToolCall(id="c", name="read", arguments={})
    deps = SimpleNamespace(mcp=None)
    unavailable = await graph._run_one_tool(deps, call)
    assert unavailable.is_error is True

    class CancelMcp:
        async def call_tool(self, *_args: object) -> object:
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await graph._run_one_tool(SimpleNamespace(mcp=CancelMcp()), call)

    drained: list[bool] = []
    tool_pass = graph._ToolPass.__new__(graph._ToolPass)
    tool_pass.delegator = SimpleNamespace(drain=lambda: _record_async(drained))
    task = asyncio.create_task(_raise_async(RuntimeError("failed")))
    with pytest.raises(RuntimeError, match="failed"):
        await tool_pass._await_batch(task)
    assert drained == [True]
    tool_pass.state = {"force_synthesis": True}
    assert tool_pass._force_synthesis(0) is True


async def _record_async(out: list[bool]) -> None:
    out.append(True)


async def _raise_async(exc: BaseException) -> None:
    raise exc


@pytest.mark.asyncio
async def test_deep_harness_offline_adapters(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = deep_harness.ArcelleHarnessModelAdapter(inner=object())
    with pytest.raises(RuntimeError, match="async-only"):
        adapter._generate([])

    backend = deep_harness.ArcelleWorkspaceBackend.__new__(deep_harness.ArcelleWorkspaceBackend)
    invalid = await backend.als("../private")
    assert invalid.error
    invalid_grep = await backend.agrep("x", "../private")
    assert invalid_grep.error

    class Mcp:
        async def call_tool(self, name: str, arguments: dict) -> object:
            return SimpleNamespace(is_error=name == "bad", text="failure" if name == "bad" else "ok")

    tools = deep_harness.ArcelleToolBackend(Mcp())
    assert await tools.call("good", {}) == "ok"
    with pytest.raises(RuntimeError, match="failure"):
        await tools.call("bad", {})

    events: list[dict] = []

    async def emit(event: dict) -> None:
        events.append(event)

    fake_agent = SimpleNamespace(
        ainvoke=lambda *_args, **_kwargs: _value_async(
            {"messages": [SimpleNamespace(content="offline answer")]}
        )
    )
    monkeypatch.setattr(deep_harness, "build_deep_agent", lambda *_args, **_kwargs: fake_agent)
    deps = SimpleNamespace(emit=emit)
    assert await deep_harness.run_deep_agent("question", deps, write_enabled=False, max_rounds=2) == "offline answer"
    assert events == [
        {"t": "step", "v": "Deep Harness started"},
        {"t": "final", "v": "offline answer"},
    ]


async def _value_async(value: object) -> object:
    return value


def test_quicklook_completion_timeout_and_empty_representation(monkeypatch: pytest.MonkeyPatch) -> None:
    request = object()
    request_class = SimpleNamespace(
        alloc=lambda: SimpleNamespace(
            initWithFileAtURL_size_scale_representationTypes_=lambda *_args: request
        )
    )

    class Event:
        wait_result = False

        def set(self) -> None:
            self.wait_result = True

        def wait(self, _timeout: float) -> bool:
            return self.wait_result

    generator = SimpleNamespace(
        generateBestRepresentationForRequest_completionHandler_=lambda *_args: None
    )
    monkeypatch.setattr(quicklook, "_QUICKLOOK_AVAILABLE", True)
    monkeypatch.setattr(quicklook.threading, "Event", Event)
    monkeypatch.setattr(
        quicklook,
        "Foundation",
        SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=lambda _path: object())),
        raising=False,
    )
    monkeypatch.setattr(quicklook, "CGSizeMake", lambda *_args: object(), raising=False)
    monkeypatch.setattr(
        quicklook,
        "QLT",
        SimpleNamespace(
            QLThumbnailGenerationRequest=request_class,
            QLThumbnailGenerationRequestRepresentationTypeAll=1,
            QLThumbnailGenerator=SimpleNamespace(sharedGenerator=lambda: generator),
        ),
        raising=False,
    )
    assert quicklook.thumbnail_png("/fake/input", 10) is None

    def complete(_request: object, handler: object) -> None:
        handler(None, None)

    generator.generateBestRepresentationForRequest_completionHandler_ = complete
    assert quicklook.thumbnail_png("/fake/input", 10) is None


@pytest.mark.asyncio
async def test_graph_stream_driver_base_exception_and_close(monkeypatch: pytest.MonkeyPatch) -> None:
    class Fatal(BaseException):
        pass

    async def interrupted(*_args: object, **_kwargs: object) -> None:
        raise Fatal("offline fatal")

    monkeypatch.setattr(graph, "_run_stream_request", interrupted)
    events = [event async for event in graph.stream_events("q", lambda _emit: object())]
    assert events[-1]["t"] == "error"

    release = asyncio.Event()

    async def pending(_question: str, deps: object) -> None:
        await deps.emit({"t": "step", "v": "offline"})
        await release.wait()

    monkeypatch.setattr(graph, "_run_stream_request", pending)
    stream = graph.stream_events("q", lambda emit: SimpleNamespace(emit=emit))
    assert await anext(stream) == {"t": "step", "v": "offline"}
    await stream.aclose()


def test_recording_pure_refusal_and_noop_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = np.asarray([1.25, -2.5], dtype="<f4").tobytes()
    np.testing.assert_array_equal(
        session_ws._decode_base_samples(base64.b64encode(raw).decode()),
        np.asarray([1.25, -2.5], dtype=np.float32),
    )
    meta = session_ws.RecMeta()
    engine = SimpleNamespace(duration_cs=10)
    assert session_ws._apply_add_note(engine, 0, "point", "", None)(meta) == "A note needs some words."
    assert session_ws._apply_add_note(engine, 11, "point", "note", None)(meta)
    assert session_ws._apply_set_note("missing", "")(meta) == "A note needs some words."
    assert session_ws._apply_add_chapter(engine, 0, "")(meta) == "A chapter needs a name."
    assert session_ws._apply_set_chapter("missing", "")(meta) == "A chapter needs a name."
    assert session_ws._apply_set_chapter("missing", "title")(meta) == "That chapter is no longer in this recording."
    assert session_ws._apply_add_highlight(engine, 11, 12)(meta)

    spool = session_ws.SpoolWriter.__new__(session_ws.SpoolWriter)
    spool._fh = None
    spool.truncate_to(0)
    link = session_ws._HostLink()
    link.ws = object()
    assert link.attach(object()) is False
    link._pending = {}
    link.resolve({"ok": True})

    ports = session_ws.WsEnginePorts.__new__(session_ws.WsEnginePorts)
    ports.engine = None
    ports._emit_lang_locked()
    monkeypatch.setattr(
        session_ws,
        "_decode_audio_frame",
        lambda _data: (_ for _ in ()).throw(ValueError("bad frame")),
    )
    session_ws._handle_audio_frame(SimpleNamespace(send=lambda _msg: None), b"bad")
    session_ws._handle_control_text(SimpleNamespace(send=lambda _msg: None), "[]")
    monkeypatch.setattr(Path, "resolve", lambda _self: (_ for _ in ()).throw(ValueError("bad path")))
    assert session_ws._staged_media_path("bad") is None
    assert session_ws._media_kind_for(Path("fake"), "audio") is session_ws.MediaKind.AUDIO


@pytest.mark.asyncio
async def test_recording_socket_send_failure() -> None:
    queue: asyncio.Queue[str] = asyncio.Queue()
    queue.put_nowait("offline")

    async def fail(_line: str) -> None:
        raise RuntimeError("closed")

    await session_ws._pump_session_socket(SimpleNamespace(send_text=fail), queue)


def _route(app: FastAPI, path: str):
    return next(route.endpoint for route in app.routes if getattr(route, "path", None) == path)


@pytest.mark.asyncio
async def test_recording_missing_session_routes_and_edit_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    manager = session_ws.register_rec_routes(app)
    for path, req in (
        ("/rec/resume", SimpleNamespace(file_id="missing")),
        ("/rec/set_live_stt", SimpleNamespace(file_id="missing", on=True)),
        ("/rec/set_live_translate", SimpleNamespace(file_id="missing", lang="fr")),
        ("/rec/edit_meta", SimpleNamespace(file_id="missing")),
    ):
        response = await _route(app, path)(req)
        assert response.status_code == 404

    class Engine:
        duration_cs = 10

        def send(self, _message: object) -> None:
            pass

    manager.current = SimpleNamespace(file_id="live", engine=Engine(), finalized=False)
    monkeypatch.setattr(session_ws, "EDIT_META_TIMEOUT", 0)
    req = SimpleNamespace(file_id="live", op="set_note", note_id="n", text="text")
    response = await _route(app, "/rec/edit_meta")(req)
    assert response.status_code == 504


@pytest.mark.asyncio
async def test_server_helpers_and_fully_faked_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = object()
    monkeypatch.setattr(server, "OpenAICompatibleChatModel", lambda **_kwargs: marker)
    assert server._default_chat_model(
        SimpleNamespace(provider=object(), model="fake", temperature=None)
    ) is marker
    assert server._default_mcp(SimpleNamespace(mcp=None)) is None
    middleware = server.BodyLimitMiddleware(object(), max_bytes=1)
    assert middleware._too_big({"headers": [(b"content-length", b"invalid")]}) is False

    class FakePath:
        def __init__(self, value: object) -> None:
            self.value = value

        def resolve(self) -> "FakePath":
            return self

    monkeypatch.setattr(server, "Path", FakePath)
    monkeypatch.setattr(server.tempfile, "gettempdir", lambda: "/fake-temp")
    assert server._resolved_stt_path("input").value == "input"
    assert server._stt_temp_root().value == "/fake-temp"
    assert server._stt_path_is_file(SimpleNamespace(is_file=lambda: True)) is True

    app = server.create_app(chat_factory=lambda _req: object(), mcp_factory=lambda _req: None, token="")
    response = await app.exception_handlers[server.ClientGone](None, server.ClientGone())
    assert response.status_code == 499

    failure = server.llm.LlmError("ENGINE_ERROR", "offline")

    async def fail(*_args: object, **_kwargs: object) -> None:
        raise failure

    monkeypatch.setattr(server.llm, "list_models", fail)
    assert (await _route(app, "/models")(SimpleNamespace(base_url="http://fake"))).status_code == 502
    monkeypatch.setattr(server.llm, "warm", fail)
    assert (
        await _route(app, "/warm")(
            SimpleNamespace(model="fake", base_url="http://fake", keep_alive="1m")
        )
    ).status_code == 502
    monkeypatch.setattr(server.model_limits, "native_context_length", lambda *_args: _value_async(123))
    assert await _route(app, "/context_length")(
        SimpleNamespace(model="fake", base_url="http://fake")
    ) == {"context_length": 123}

    async def fail_tts(*_args: object, **_kwargs: object) -> None:
        raise server.tts_mod.TtsError("offline")

    monkeypatch.setattr(server.tts_mod, "synthesize_podcast", fail_tts)
    podcast = await _route(app, "/tts/podcast")(
        SimpleNamespace(turns=[SimpleNamespace(model_dump=lambda: {})], gap_ms=0)
    )
    assert podcast.status_code == 502
    sentinel = object()
    monkeypatch.setattr(server, "transcribe_staged_file", lambda _request: _value_async(sentinel))
    assert await _route(app, "/stt/transcribe_file")(object()) is sentinel

    monkeypatch.setattr(server, "until_hangup", lambda _request, work: work)
    monkeypatch.setattr(server.rec_read, "read_window", lambda _req: fail())
    assert (await _route(app, "/rec_read_map")(object(), object())).status_code == 502
    monkeypatch.setattr(server, "run_workflow_node", lambda req, registry: _value_async((req, registry)))
    wf_req = object()
    wf_result = await _route(app, "/wf_node")(wf_req)
    assert wf_result[0] is wf_req
    monkeypatch.setattr(
        server.handoff, "summarize_for_handoff", lambda _req: _value_async("offline summary")
    )
    assert await _route(app, "/handoff_summary")(object(), object()) == {
        "summary": "offline summary"
    }
    monkeypatch.setattr(server.handoff, "summarize_for_handoff", lambda _req: fail())
    assert (await _route(app, "/handoff_summary")(object(), object())).status_code == 502
