"""Fake-only branch coverage for round-1 sidecar shard 1."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator, Callable

import numpy as np
import pytest

from arcelle_sidecar import __main__ as main_mod
from arcelle_sidecar import external_llm, file_pass, hub_mcp, provider_api, summarize, tts, vision
from arcelle_sidecar.chat import StreamStalled
from arcelle_sidecar.diar import embed
from arcelle_sidecar.docs import legacy, pdf
from arcelle_sidecar.media import probe
from arcelle_sidecar.rec import engine as rec_engine
from arcelle_sidecar.rec import lanes
from arcelle_sidecar.stt import dictation, engine as stt_engine


def _raise(error: BaseException):
    raise error


def test_external_feed_ignores_early_child_exit_and_close_failure() -> None:
    class FakeStdin:
        def write(self, _payload: bytes) -> None:
            raise BrokenPipeError("fabricated child exit")

        async def drain(self) -> None:
            pytest.fail("drain must not run after the fabricated broken pipe")

        def close(self) -> None:
            raise RuntimeError("fabricated already closed")

    asyncio.run(external_llm._feed(FakeStdin(), b"fabricated prompt"))


def test_external_stop_drain_tolerates_dead_process_and_failed_reap() -> None:
    class FakeTask:
        def __init__(self) -> None:
            self.cancelled = False

        def cancel(self) -> None:
            self.cancelled = True

    class FakeProcess:
        def kill(self) -> None:
            raise ProcessLookupError("fabricated process already gone")

        async def wait(self) -> None:
            raise RuntimeError("fabricated reap failure")

    tasks = [FakeTask(), FakeTask()]
    asyncio.run(external_llm._stop_drain(FakeProcess(), tasks))
    assert all(task.cancelled for task in tasks)


def test_external_image_staging_cleans_a_fabricated_create_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cleanup: list[tuple[str, object]] = []
    monkeypatch.setattr(
        external_llm.tempfile,
        "mkstemp",
        lambda **kwargs: _raise(OSError("fabricated staging failure")),
    )
    monkeypatch.setattr(
        external_llm, "_close_staging_fd", lambda fd: cleanup.append(("fd", fd))
    )
    monkeypatch.setattr(
        external_llm, "_unlink_staging_path", lambda path: cleanup.append(("path", path))
    )
    assert external_llm._write_staged_image(b"pixels") is None
    assert cleanup == [("fd", -1), ("path", None)]


def test_external_image_batch_removes_prior_fake_paths_on_write_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    staged = iter(["/fabricated/one.png", None])
    removed: list[list[str]] = []
    monkeypatch.setattr(external_llm, "_decoded_staged_image", lambda value: b"pixels")
    monkeypatch.setattr(external_llm, "_write_staged_image", lambda data: next(staged))
    monkeypatch.setattr(external_llm, "_unlink_all", lambda paths: removed.append(list(paths)))
    assert external_llm._stage_image_files(["one", "two"]) == []
    assert removed == [["/fabricated/one.png"]]


def test_external_stream_cancels_an_unconsumed_fake_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[asyncio.Future[Any]] = []
    real_ensure_future = asyncio.ensure_future

    class FakeTap:
        def __init__(self, _engine: str, sink: Callable[[str], Any]) -> None:
            self.sink = sink

        def tail_for(self, _final: str) -> str:
            return ""

    async def fake_generate(*_args: object, tap: FakeTap, **_kwargs: object) -> str:
        await tap.sink("fabricated delta")
        await asyncio.Event().wait()
        return "unreachable"

    def track(coro: Any) -> asyncio.Future[Any]:
        task = real_ensure_future(coro)
        created.append(task)
        return task

    monkeypatch.setattr(external_llm, "split_external_model", lambda model: ("codex-cli", "x"))
    monkeypatch.setattr(external_llm, "_DeltaTap", FakeTap)
    monkeypatch.setattr(external_llm, "generate_external", fake_generate)
    monkeypatch.setattr(external_llm.asyncio, "ensure_future", track)

    async def scenario() -> None:
        stream = external_llm.generate_external_stream("codex-cli::x", [])
        assert await anext(stream) == "fabricated delta"
        await stream.aclose()
        await asyncio.gather(*created, return_exceptions=True)

    asyncio.run(scenario())
    assert created and created[0].cancelled()


def test_external_compaction_aborts_a_digest_when_fake_cancel_arrives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from arcelle_sidecar import compaction

    checks = iter([False, True, False])
    monkeypatch.setattr(external_llm, "_stopped", lambda cancel: next(checks))

    async def fake_compact(
        messages: list[dict[str, Any]],
        _budget: int,
        digest: Callable[[str], Any],
        _reserved: int,
        _chunk_bytes: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        with pytest.raises(external_llm._Stopped):
            await digest("fabricated transcript")
        return [{"role": "user", "content": "preserved"}], True

    monkeypatch.setattr(compaction, "compact_to_budget", fake_compact)
    monkeypatch.setattr(compaction, "fit_budget_bytes", lambda *args: 100)
    monkeypatch.setattr(compaction, "digest_chunk_bytes", lambda *args, **kwargs: 50)
    model = external_llm.ExternalChatModel.__new__(external_llm.ExternalChatModel)
    messages = [{"role": "user", "content": "original"}]
    assert asyncio.run(model._compact(messages, [], 4096, object())) == [
        {"role": "user", "content": "preserved"}
    ]


def test_live_translation_without_a_fake_model_returns_without_provider_call() -> None:
    ports = SimpleNamespace(
        translate=lambda *_args: pytest.fail("translation provider must not run"),
        emit=lambda *_args: pytest.fail("no event without a translation"),
    )
    segment = SimpleNamespace(id="seg-1", text="fabricated speech")
    assert asyncio.run(
        rec_engine._translate_live_item(ports, "file-1", None, (segment, "he"), None)
    ) is None


def test_orphan_message_without_a_reply_future_is_a_noop() -> None:
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    engine._answer_orphan(SimpleNamespace())


def test_system_lane_reports_fabricated_off_recording_and_starting_states() -> None:
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    engine.cfg = SimpleNamespace(system_audio=False)
    assert engine.sys_lane() is rec_engine.SysLane.OFF
    engine.cfg = SimpleNamespace(system_audio=True)
    engine.sys_tap_up = True
    engine.sys_tap_starting = False
    assert engine.sys_lane() is rec_engine.SysLane.RECORDING
    engine.sys_tap_up = False
    engine.sys_tap_starting = True
    assert engine.sys_lane() is rec_engine.SysLane.STARTING
    engine.sys_tap_starting = False
    assert engine.sys_lane() is rec_engine.SysLane.OFF


def test_split_speakers_embeds_one_uncached_fabricated_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    segment = SimpleNamespace(id="seg-1", t0=0, t1=10)
    engine.cfg = SimpleNamespace(diarize_model_path="/fabricated/model")
    engine.win_cache = {}
    engine.mixed = np.zeros(rec_engine.SAMPLE_RATE // 10, dtype=np.float32)
    engine.meta = SimpleNamespace(
        segments=[segment], max_speakers=2, speaker_names={}, recognized=set()
    )
    engine.known = []
    calls: list[tuple[int, int, str]] = []
    monkeypatch.setattr(
        rec_engine,
        "window_prints",
        lambda samples, t0, model: calls.append((len(samples), t0, model)) or [],
    )

    def fake_split(_segments: object, _max: int, _naming: object, wins_for: Callable) -> None:
        assert wins_for(segment) == []

    monkeypatch.setattr(rec_engine, "split_by_voice", fake_split)
    engine.split_speakers()
    assert calls == [(rec_engine.SAMPLE_RATE // 10, 0, "/fabricated/model")]


def test_relabel_speakers_emits_fabricated_sorted_overlay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    engine.meta = SimpleNamespace(
        segments=[SimpleNamespace(id="seg-1", speaker=2)],
        max_speakers=2,
        speaker_names={2: "Beta", 1: "Alpha"},
        recognized={2, 1},
    )
    engine.known = []
    engine.cfg = SimpleNamespace(file_id="file-1")
    emitted: list[tuple[str, dict[str, Any]]] = []
    engine.ports = SimpleNamespace(emit=lambda event, payload: emitted.append((event, payload)))
    monkeypatch.setattr(rec_engine, "relabel", lambda *args: True)
    monkeypatch.setattr(rec_engine, "relabel_interval", lambda elapsed: 9)
    clock = iter([10.0, 10.001])
    monkeypatch.setattr(rec_engine.time, "monotonic", lambda: next(clock))
    engine.relabel_speakers()
    assert engine.relabel_countdown == 9
    assert emitted == [
        (
            "rec-relabel",
            {
                "fileId": "file-1",
                "labels": [{"id": "seg-1", "speaker": 2}],
                "speakerNames": {1: "Alpha", 2: "Beta"},
                "recognized": [1, 2],
            },
        )
    ]


def test_active_system_phrase_short_circuits_history_overlap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    engine.sys = SimpleNamespace(state=SimpleNamespace(start=0, buf=[0.0] * 160))
    engine.meta = SimpleNamespace(segments=[])
    monkeypatch.setattr(rec_engine, "time_overlap", lambda first, second: 1.0)
    assert engine.overlaps_sys_speech(0, 1)


def test_main_wires_only_fabricated_server_dependencies(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, object]] = []
    args = SimpleNamespace(port=0, log_level="warning")
    sock = SimpleNamespace(getsockname=lambda: ("127.0.0.1", 43210))
    monkeypatch.setattr(main_mod, "_parse_args", lambda argv: args)
    monkeypatch.setattr(main_mod.logging, "basicConfig", lambda **kwargs: calls.append(("log", kwargs)))
    monkeypatch.setattr(main_mod, "_bind", lambda port: calls.append(("bind", port)) or sock)

    class FakeThread:
        def __init__(self, **kwargs: object) -> None:
            calls.append(("thread", kwargs))

        def start(self) -> None:
            calls.append(("thread-start", True))

    class FakeServer:
        def __init__(self, config: object) -> None:
            calls.append(("server", config))

        def run(self, *, sockets: list[object]) -> None:
            calls.append(("run", sockets))

    monkeypatch.setattr(main_mod.threading, "Thread", FakeThread)
    monkeypatch.setattr(main_mod.atexit, "register", lambda fn: calls.append(("atexit", fn)))
    monkeypatch.setattr(main_mod, "create_app", lambda: "fake-app")
    monkeypatch.setattr(
        main_mod,
        "uvicorn",
        SimpleNamespace(
            Config=lambda app, **kwargs: calls.append(("config", (app, kwargs))) or "config",
            Server=FakeServer,
        ),
    )
    assert main_mod.main(["--port", "0"]) == 0
    assert capsys.readouterr().out == "SIDECAR_PORT=43210\n"
    assert ("run", [sock]) in calls


def _bare_hub_handler() -> hub_mcp._HubRequestHandler:
    return hub_mcp._HubRequestHandler.__new__(hub_mcp._HubRequestHandler)


def test_hub_request_timeout_closes_the_fabricated_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _bare_hub_handler()
    timeouts: list[float] = []
    handler.connection = SimpleNamespace(settimeout=lambda value: timeouts.append(value))
    handler.close_connection = False
    monkeypatch.setattr(
        hub_mcp.BaseHTTPRequestHandler,
        "handle_one_request",
        lambda self: _raise(TimeoutError("fabricated silent client")),
    )
    handler.handle_one_request()
    assert timeouts == [hub_mcp._SOCKET_TIMEOUT]
    assert handler.close_connection is True


def test_hub_send_silences_a_fabricated_broken_pipe() -> None:
    handler = _bare_hub_handler()
    handler.send_response = lambda code: _raise(BrokenPipeError("fabricated hangup"))
    handler._send(200, b"payload")


def test_hub_content_length_and_body_reject_an_ambiguous_fake_request() -> None:
    handler = _bare_hub_handler()
    handler.headers = {"Content-Length": "not-an-integer"}
    handler.close_connection = False
    sent: list[int] = []
    handler._send = lambda code, payload=b"": sent.append(code)
    assert handler._content_length() is None
    assert handler._read_body() is None
    assert handler.close_connection is True
    assert sent == [400]


def test_legacy_repeat_and_row_helpers_ignore_fabricated_invalid_values() -> None:
    assert legacy._repeat_count("not-an-integer") == 1
    unknown = SimpleNamespace(qname=("urn", "annotation"))
    row = SimpleNamespace(childNodes=[unknown])
    assert legacy._ods_row_values(row) == []


def test_legacy_ole_reader_skips_a_fabricated_storage_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[bool] = []
    fake_ole = SimpleNamespace(
        exists=lambda name: True,
        openstream=lambda name: _raise(OSError("fabricated storage, not stream")),
        close=lambda: closed.append(True),
    )
    monkeypatch.setattr(legacy.olefile, "OleFileIO", lambda source: fake_ole)
    assert legacy._read_ole_stream(b"fabricated OLE bytes", ["Storage"]) is None
    assert closed == [True]


def test_legacy_harvest_caps_utf16_and_ascii_fake_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(legacy, "MAX_LEGACY_CHARS", 1)
    assert legacy._harvest_utf16("abcd\x00remaining".encode("utf-16-le")) == "abcd\n"
    assert legacy._harvest_ascii(b"abcd\x00remaining") == "abcd\n"


def test_provider_stream_stall_maps_to_provider_error_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def stalled() -> AsyncIterator[dict[str, Any]]:
        if False:
            yield {}
        raise StreamStalled()

    monkeypatch.setattr(provider_api, "provider_timeout_secs", lambda: 3.0)

    async def consume() -> None:
        with pytest.raises(provider_api.ProviderApiError, match="fabricated-model"):
            async for _event in provider_api._stall_as_error(stalled(), "fabricated-model"):
                pass

    asyncio.run(consume())


def test_provider_model_identity_and_empty_pending_call_are_explicit() -> None:
    provider_id = next(iter(provider_api.API_PROVIDER_IDS))
    assert provider_api.is_api_provider_model(f"{provider_id}::fabricated-model")
    assert provider_api._pop_pending_call_id([], "missing") == ""


def test_blind_provider_allows_a_text_only_fabricated_request() -> None:
    provider = SimpleNamespace(model="fabricated", supports_vision=False)
    model = provider_api.OpenAICompatibleChatModel("openrouter::fabricated", provider)
    model._require_image_input([{"role": "user", "content": "text only"}], None)


def test_provider_digest_uses_a_fabricated_generate_method() -> None:
    model = provider_api.OpenAICompatibleChatModel.__new__(
        provider_api.OpenAICompatibleChatModel
    )
    seen: list[list[dict[str, Any]]] = []

    async def fake_generate(messages: list[dict[str, Any]]) -> str:
        seen.append(messages)
        return "fabricated digest"

    model.generate = fake_generate
    assert asyncio.run(model._digest("old details")) == "fabricated digest"
    assert seen[0][-1] == {"role": "user", "content": "old details"}


def test_probe_remove_and_byte_write_failures_use_only_fake_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    removed: list[object] = []

    class FakePath:
        def unlink(self) -> None:
            removed.append("attempt")
            raise OSError("fabricated remove failure")

    monkeypatch.setattr(probe, "Path", lambda path: FakePath())
    probe._remove("fabricated")
    assert removed == ["attempt"]

    fake_temp = SimpleNamespace()
    cleanup: list[object] = []
    monkeypatch.setattr(probe, "_temp_path", lambda prefix, ext: fake_temp)
    monkeypatch.setattr(
        probe, "write_private", lambda path, data: _raise(OSError("fabricated disk full"))
    )
    monkeypatch.setattr(probe, "_remove", lambda path: cleanup.append(path))
    assert probe.probe_bytes(b"video", "mp4") is None
    assert probe.last_frame_png(b"video", "mp4") is None
    assert cleanup == [fake_temp, fake_temp]


def test_dictation_binary_decode_failure_is_logged_and_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    warnings: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        dictation, "_decode_audio_frame", lambda data: _raise(ValueError("fabricated frame"))
    )
    monkeypatch.setattr(
        dictation.log, "warning", lambda *args, **kwargs: warnings.append(args)
    )
    queue = SimpleNamespace(put_nowait=lambda value: pytest.fail("bad frame queued"))
    dictation._handle_audio_frame(queue, b"bad")
    assert warnings


def test_dictation_receive_treats_fake_websocket_disconnect_as_normal() -> None:
    async def receive() -> None:
        class FakeWebsocket:
            async def receive(self) -> dict[str, object]:
                raise dictation.WebSocketDisconnect()

        await dictation._receive_dictation_messages(FakeWebsocket(), asyncio.Queue())

    asyncio.run(receive())


def test_tts_warm_import_silences_a_fabricated_import_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failed_to_thread(function: Callable[..., object], *args: object) -> object:
        raise ImportError("fabricated missing edge_tts")

    monkeypatch.setattr(tts.asyncio, "to_thread", failed_to_thread)
    asyncio.run(tts.warm_import())


def test_tts_wav_pipeline_uses_only_fabricated_audio_functions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_mp3(*_args: object) -> bytes:
        return b"mp3"

    async def fake_to_thread(function: Callable[..., bytes], *args: object) -> bytes:
        return function(*args)

    monkeypatch.setattr(tts, "synthesize_mp3", fake_mp3)
    monkeypatch.setattr(tts, "mp3_to_wav", lambda data: b"wav")
    monkeypatch.setattr(tts, "normalize_wav", lambda data, target: b"normalized")
    monkeypatch.setattr(tts.asyncio, "to_thread", fake_to_thread)
    assert asyncio.run(tts.synthesize_wav("fabricated")) == b"normalized"


def test_wav_frames_rejects_a_fabricated_non_mono_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeReader:
        def __enter__(self) -> "FakeReader":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def getsampwidth(self) -> int:
            return 1

        def getnchannels(self) -> int:
            return 2

    monkeypatch.setattr(tts.wave, "open", lambda *_args, **_kwargs: FakeReader())
    with pytest.raises(tts.TtsError, match="mono 16-bit WAV"):
        tts._wav_frames(b"fabricated wav")


def test_diar_short_and_silent_inputs_return_empty_fake_results() -> None:
    assert embed._frame_view(np.zeros(2, dtype=np.float32), 4, 2).shape == (0, 4)
    assert embed.count_voiced(np.zeros(2, dtype=np.float32)) == 0
    assert embed._window_embedding("/fabricated/model", np.zeros(2, dtype=np.float32)) is None
    voice = embed.dsp_embed(np.zeros(0, dtype=np.float32))
    assert voice.voiced_frames == 0
    assert voice.is_silent()


def test_summarize_boundaries_and_empty_line_use_pure_fabricated_text() -> None:
    encoded = "aéz".encode()
    assert summarize._floor_char_boundary(encoded, 2) == 1
    assert summarize._ceil_char_boundary(encoded, 2) == 3
    assert summarize._first_nonempty_line(" \n\t") == ""


def test_prepare_image_preserves_original_bytes_on_fake_encode_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeFitted:
        def save(self, _out: object, *, format: str) -> None:
            raise OSError("fabricated PNG encode failure")

    image = SimpleNamespace(width=640, height=360, resize=lambda *args: FakeFitted())
    monkeypatch.setattr(vision.Image, "open", lambda source: image)
    assert vision.prepare_image(b"original") == (b"original", 640.0, 360.0)
    assert vision._num("not-a-number") is None


def test_lane_empty_rms_and_negative_partial_growth_are_stable() -> None:
    assert lanes._rms([]) == 0.0
    lane = lanes.Lane.__new__(lanes.Lane)
    lane.state = lanes.Active(start=10, buf=[0.1], partial_at=3)
    assert lane.partial_due() is None


def test_pdf_page_failure_closes_the_fabricated_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[bool] = []

    class FakePage:
        def get_text(self) -> str:
            raise ValueError("fabricated damaged page")

    class FakeDocument:
        def __iter__(self):
            return iter([FakePage()])

        def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(pdf.pymupdf, "open", lambda **kwargs: FakeDocument())
    assert pdf.extract_pdf(b"fabricated PDF") is None
    assert closed == [True]


def test_file_pass_field_and_stt_lock_failures_are_explicit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert file_pass._field({"answer": 7}, "answer") == ""
    fake_lock = SimpleNamespace(acquire=lambda **kwargs: False)
    monkeypatch.setattr(stt_engine, "_lock", fake_lock)
    stt_engine.unload_ctx()
