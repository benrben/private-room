"""Behavioral edge coverage for LOC-only module extractions."""

from __future__ import annotations

import asyncio
from collections import deque
from types import SimpleNamespace

import pytest

from arcelle_sidecar import graph_actions, graphs, graphs_receipts, graphs_route, server_http
from arcelle_sidecar.config import RunRequest
from arcelle_sidecar.rec import engine as rec_engine
from arcelle_sidecar.rec import engine_workers, session_ws
from arcelle_sidecar.rec.lanes import Source


@pytest.mark.asyncio
async def test_extracted_graph_catalog_edges_remain_behavioral(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    box = [{"type": "function", "function": {"name": "make"}}]
    flow = SimpleNamespace(stages=("make",))
    monkeypatch.setattr(graphs, "_missing_stage_names", lambda _flow, _state: [])
    assert graphs._completed_stage_catalog({}, flow, box) == {"full_tools": box}

    monkeypatch.setattr(graphs, "_missing_stage_names", lambda _flow, _state: ["absent"])
    assert graphs._completed_stage_catalog({}, flow, box) == {
        "full_tools": box,
        "stage_retried": True,
    }
    monkeypatch.setattr(graphs, "_missing_stage_names", lambda _flow, _state: ["make"])
    monkeypatch.setattr(graphs, "_stage_tools", lambda *_args: box)
    retried = graphs._completed_stage_catalog({}, flow, box)
    assert retried["stage_retried"] is True
    assert retried["tools"] == box

    missing = graphs._next_stage_catalog({}, SimpleNamespace(stages=("absent",)), 0, box)
    assert missing == {"stage": 1, "full_tools": box}
    advanced = graphs._next_stage_catalog({}, flow, 0, box)
    assert advanced["stage"] == 1
    assert advanced["tools"] == box

    assert await graphs_route.route_action(
        {"agent_id": "files.read", "question": "read", "tools": box}
    ) == {}
    assert await graphs_route.route_action(
        {
            "agent_id": "creator.studio",
            "question": "make flashcards",
            "tools": [{"type": "function", "function": {"name": "studio_mindmap"}}],
        }
    ) == {}


def test_extracted_transcription_receipt_edges_remain_fail_closed() -> None:
    terminal = {
        "tool_events": [
            {
                "name": "retranscribe_file",
                "arguments": {"name": "meeting.wav"},
                "result": "transcript: ready",
            }
        ]
    }
    assert graphs_receipts._check_transcription_terminal(terminal) == {
        "repair_needed": False
    }
    assert graphs_receipts._transcription_terminal_receipt([]) == (
        "the requested recording",
        "",
        False,
    )
    assert graphs_receipts._transcription_terminal_receipt(
        terminal["tool_events"]
    ) == ("meeting.wav", "", True)

    events = [
        {"name": "other", "result": "completed"},
        {
            "name": "retranscribe_file",
            "arguments": {"name": "meeting.wav"},
            "result": "queued job id=abc123)",
        },
        {"name": "other", "result": "job abc123 completed"},
        {"name": "job_status", "result": "job different completed"},
        {"name": "job_status", "result": "job abc123 completed"},
    ]
    assert graphs_receipts._transcription_terminal_receipt(events) == (
        "meeting.wav",
        "abc123",
        True,
    )
    assert graphs_receipts._transcription_identities("Meeting.wav", "ABC123") == {
        "meeting.wav",
        "abc123",
    }
    assert not graphs_receipts._status_is_terminal_for_transcription(
        {"result": "another job completed"}, {"abc123"}
    )
    repair = graphs_receipts._pending_transcription_result(
        {
            "repairs": 0,
            "corrections": ["prior"],
            "tools": [{"function": {"name": "job_status"}}],
        },
        "meeting.wav",
        "abc123",
    )
    assert repair["repair_needed"] is True
    assert repair["repairs"] == 1


def test_extracted_recording_edges_keep_queue_and_cached_voice_behavior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queued: list[object] = []
    job = SimpleNamespace(source=Source.MIC, lang=None)
    engine = rec_engine.Engine.__new__(rec_engine.Engine)
    engine.decode_busy = False
    engine.final_queue = deque()
    engine.partial_pending = job
    engine.lane_lang = [SimpleNamespace(hint=lambda: "he"), SimpleNamespace(hint=lambda: None)]
    engine._job_queue = SimpleNamespace(put_nowait=queued.append)
    engine.dispatch_next()
    assert engine.partial_pending is None
    assert job.lang == "he"
    assert queued == [job]

    segment = SimpleNamespace(id="seg", t0=0, t1=1)
    cached = [(0, 1, object())]
    engine.cfg = SimpleNamespace(diarize_model_path=None)
    engine.win_cache = {"seg": cached}
    engine.meta = SimpleNamespace(
        segments=[segment], max_speakers=1, speaker_names={}, recognized=set()
    )
    engine.known = []
    seen: list[object] = []

    def split(_segments: object, _count: int, _naming: object, wins_for: object) -> None:
        seen.extend(wins_for(segment))

    monkeypatch.setattr(rec_engine, "split_by_voice", split)
    engine.split_speakers()
    assert seen == cached


def test_extracted_retranscription_word_and_error_edges() -> None:
    word = SimpleNamespace(t0=2, t1=4, del_=False)
    meta = SimpleNamespace(
        segments=[SimpleNamespace(words=[word])],
        cuts=[SimpleNamespace(t0=1, t1=3)],
    )
    engine_workers._mark_retranscribed_cut_words(meta)
    assert word.del_ is True
    assert engine_workers._decode_job_error(None, "fabricated") == (
        "speaker analysis failed: fabricated"
    )
    assert engine_workers._decode_job_error(None, None) is None


@pytest.mark.asyncio
async def test_extracted_session_teardown_answers_pending_waiter() -> None:
    async def done() -> None:
        return None

    waiter = asyncio.get_running_loop().create_future()
    host = SimpleNamespace(ws=None, detach=lambda: None)
    ports = SimpleNamespace(spool=SimpleNamespace(unlink=lambda: None), host=host)
    session = session_ws.LiveSession(
        file_id="file", engine=SimpleNamespace(aclose=done), ports=ports, waiting=[waiter]
    )
    manager = session_ws.RecSessionManager()
    manager.current = session
    await manager.finalize(session)
    assert isinstance(waiter.exception(), RuntimeError)


def test_extracted_server_and_privacy_factory_edges() -> None:
    request = RunRequest(
        model="claude-cli",
        question="inspect the clip",
        privacy={"active": True},
        mcp={"url": "http://127.0.0.1:9999", "token": "secret"},
    )
    assert "Cloud Privacy" in graph_actions._tagged_unavailable_reason(request, "video")
    mcp = server_http._default_mcp(request)
    assert mcp is not None
