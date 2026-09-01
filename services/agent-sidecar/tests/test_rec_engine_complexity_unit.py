"""Fake-only regression tests for recording-engine orchestration seams."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from arcelle_sidecar.diar.embed import VoicePrint
from arcelle_sidecar.rec import engine as engine_module
from arcelle_sidecar.rec.engine import (
    DecodeJob,
    Engine,
    EngineOutcome,
    JobKind,
    LiveTranslateQueue,
    MsgStop,
    _run_decode_job,
    spawn_live_translator,
)
from arcelle_sidecar.rec.lanes import Source, SysLane
from arcelle_sidecar.rec.meta import RecMeta, RecSegment


def _segment(identifier: str, source: str = "sys", t0: int = 0, t1: int = 100) -> RecSegment:
    return RecSegment(
        id=identifier,
        source=source,
        speaker="Speaker 1",
        t0=t0,
        t1=t1,
        text=identifier,
        words=[],
    )


def test_decode_job_keeps_decoder_error_while_fake_speaker_analysis_still_runs(monkeypatch) -> None:
    calls: list[object] = []
    voice = VoicePrint()

    def broken_decoder(_model, _samples, _offset, mode):
        calls.append(mode)
        raise RuntimeError("fake decoder failed")

    def fake_embed(model, samples):
        calls.append((model, samples.size))
        return voice

    def fake_windows(samples, offset, model):
        calls.append((offset, model))
        return [(offset, offset + samples.size, voice)]

    monkeypatch.setattr(engine_module, "transcribe_segments", broken_decoder)
    monkeypatch.setattr(engine_module, "embed", fake_embed)
    monkeypatch.setattr(engine_module, "window_prints", fake_windows)
    job = DecodeJob(JobKind.FINAL, Source.SYS, 160, np.asarray([0.1, 0.2]), "he")

    out = _run_decode_job("fake-whisper", "fake-diar", job)

    assert type(calls[0]).__name__ == "Watch"
    assert out.err == "fake decoder failed"
    assert out.emb is voice
    assert out.wins == [(1, 3, voice)]
    assert ("fake-diar", 2) in calls


async def test_live_translation_worker_drains_fake_queue_in_order_and_reuses_model() -> None:
    class FakePorts:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []
            self.events: list[tuple[str, dict[str, str]]] = []

        async def translate(self, text: str, lang: str, model: str) -> str:
            self.calls.append((text, lang, model))
            return f"{text}-{lang}"

        def emit(self, event: str, payload: dict[str, str]) -> None:
            self.events.append((event, payload))

    ports = FakePorts()
    queue = LiveTranslateQueue()
    worker = spawn_live_translator(ports, "file", "fake-model", queue)
    queue.push(_segment("first"), "he")
    queue.push(_segment("second"), "en")
    for _ in range(5):
        if len(ports.events) == 2:
            break
        await asyncio.sleep(0)
    worker.cancel()
    with pytest.raises(asyncio.CancelledError):
        await worker

    assert ports.calls == [("first", "he", "fake-model"), ("second", "en", "fake-model")]
    assert [payload["segId"] for _event, payload in ports.events] == ["first", "second"]


async def test_orphan_stop_returns_a_deep_copy_of_the_fake_outcome() -> None:
    engine = object.__new__(Engine)
    meta = RecMeta(speaker_names={"Speaker 1": "Original"})
    engine.outcome = EngineOutcome(ok=True, meta=meta)
    done: asyncio.Future[RecMeta] = asyncio.get_running_loop().create_future()

    engine._answer_orphan(MsgStop(done))

    reply = await done
    reply.speaker_names["Speaker 1"] = "Changed"
    assert meta.speaker_names["Speaker 1"] == "Original"


def test_tick_uses_fake_lanes_to_keep_the_newest_partial_and_emit_once(monkeypatch) -> None:
    class FakeLane:
        def __init__(self, partial, level: float) -> None:
            self.partial = partial
            self.level = level

        def partial_due(self):
            return self.partial

    events: list[tuple[str, dict]] = []
    engine = object.__new__(Engine)
    engine.paused = False
    engine.stopping = False
    engine.mic_flagged = False
    engine.last_mic_push = 3.0
    engine.mic_ever_pushed = False
    engine.live_stt = True
    engine.mic = FakeLane((10, [1.0]), 0.8)
    engine.sys = FakeLane((20, [2.0]), 0.6)
    engine.partial_pending = None
    engine.last_level_emit = 9.7
    engine._mixed_len = 1_600
    engine.cfg = SimpleNamespace(file_id="fake-file")
    engine.ports = SimpleNamespace(emit=lambda event, payload: events.append((event, payload)))
    engine.sys_lane = lambda: SysLane.OFF
    engine.emit_source = lambda source, state, message: events.append(
        ("rec-source", {"source": source, "state": state, "message": message})
    )
    engine.dispatch_next = lambda: events.append(("dispatch", {}))
    monkeypatch.setattr(engine_module.time, "monotonic", lambda: 10.0)

    engine.tick()

    assert engine.partial_pending is not None and engine.partial_pending.source is Source.SYS
    assert engine.partial_pending.samples.tolist() == [2.0]
    assert [event for event, _payload in events] == ["rec-source", "dispatch", "rec-level"]
    assert engine.mic.level == pytest.approx(0.4)
    assert engine.sys.level == pytest.approx(0.3)


def test_sys_overlap_scans_only_fifty_fake_history_rows() -> None:
    engine = object.__new__(Engine)
    engine.sys = SimpleNamespace(state=None)
    engine.meta = SimpleNamespace(segments=[_segment("old-sys")])
    engine.meta.segments.extend(
        _segment(f"mic-{index}", source="mic", t0=2_000 + index, t1=2_001 + index)
        for index in range(50)
    )

    assert engine.overlaps_sys_speech(0, 100) is False
