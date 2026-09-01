"""Fake-only coverage for sidecar route helpers; no ASGI app or model runtime."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from arcelle_sidecar import llm, server, wf_nodes
from arcelle_sidecar.media.decode import MediaKind


class FakeRequest:
    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


async def _inline(call: Callable[..., Any], *args: Any) -> Any:
    return call(*args)


def _response_body(response: Any) -> dict[str, Any]:
    return json.loads(response.body)


async def test_transcribe_staged_file_uses_only_injected_path_and_audio_fakes() -> None:
    root = Path("/sidecar-temp")
    staged = root / "arcelle-stt-job" / "meeting.mp4"
    model = root / "models" / "whisper.bin"
    seen: list[tuple[str, Any]] = []

    def decode(path: Path, kind: MediaKind) -> str:
        seen.append(("decode", (path, kind)))
        return "fake-pcm"

    def transcribe(model_path: str, pcm: str, timestamps: bool) -> str:
        seen.append(("transcribe", (model_path, pcm, timestamps)))
        return "[0:00] fake speech"

    result = await server.transcribe_staged_file(
        FakeRequest({"path": "staged", "model_path": "model", "kind": "video"}),  # type: ignore[arg-type]
        path_from_value={"staged": staged, "model": model}.__getitem__,
        temp_root=lambda: root,
        is_file=lambda _path: True,
        decode=decode,
        transcribe=transcribe,
        run_blocking=_inline,
    )

    assert result == {"text": "[0:00] fake speech"}
    assert seen == [
        ("decode", (staged, MediaKind.VIDEO)),
        ("transcribe", (str(model), "fake-pcm", True)),
    ]


async def test_transcribe_staged_file_refuses_an_unstaged_path_before_decoder_use() -> None:
    called = False

    def decoder(*_args: Any) -> None:
        nonlocal called
        called = True

    response = await server.transcribe_staged_file(
        FakeRequest({"path": "outside", "model_path": "model"}),  # type: ignore[arg-type]
        path_from_value=lambda value: Path(f"/elsewhere/{value}"),
        temp_root=lambda: Path("/sidecar-temp"),
        is_file=lambda _path: True,
        decode=decoder,
        run_blocking=_inline,
    )

    assert response.status_code == 400
    assert _response_body(response) == {
        "code": "STT_BAD_REQUEST",
        "error": "the staged audio path was refused",
    }
    assert called is False


async def test_transcribe_staged_file_reports_missing_fake_staged_or_model_path() -> None:
    root = Path("/sidecar-temp")
    staged = root / "arcelle-stt-job" / "meeting.wav"
    model = root / "models" / "whisper.bin"
    called = False

    def decoder(*_args: Any) -> None:
        nonlocal called
        called = True

    response = await server.transcribe_staged_file(
        FakeRequest({"path": "staged", "model_path": "model"}),  # type: ignore[arg-type]
        path_from_value={"staged": staged, "model": model}.__getitem__,
        temp_root=lambda: root,
        is_file=lambda path: path == staged,
        decode=decoder,
        run_blocking=_inline,
    )

    assert response.status_code == 400
    assert _response_body(response) == {
        "code": "STT_BAD_REQUEST",
        "error": "the audio file or speech model is missing",
    }
    assert called is False


async def test_transcribe_staged_file_maps_fake_decoder_errors_to_stt_failed() -> None:
    root = Path("/sidecar-temp")
    paths = {
        "staged": root / "arcelle-stt-job" / "meeting.wav",
        "model": root / "models" / "whisper.bin",
    }

    def decoder(*_args: Any) -> None:
        raise RuntimeError("fake decode failure")

    response = await server.transcribe_staged_file(
        FakeRequest({"path": "staged", "model_path": "model"}),  # type: ignore[arg-type]
        path_from_value=paths.__getitem__,
        temp_root=lambda: root,
        is_file=lambda _path: True,
        decode=decoder,
        run_blocking=_inline,
    )

    assert response.status_code == 502
    assert _response_body(response) == {
        "code": "STT_FAILED",
        "error": "fake decode failure",
    }


def _workflow_request(kind: str, **extra: Any) -> wf_nodes.WfNodeRequest:
    return wf_nodes.WfNodeRequest(
        kind=kind,
        model="never-started",
        run_id="workflow-step",
        prompt="prompt",
        context="context",
        **extra,
    )


async def test_run_workflow_node_passes_vote_to_fake_runner_and_releases_cancel_handle(
    monkeypatch: Any,
) -> None:
    seen: dict[str, Any] = {}

    async def vote(**kwargs: Any) -> dict[str, str]:
        seen.update(kwargs)
        return {"result": "fake vote"}

    monkeypatch.setattr(wf_nodes, "run_vote", vote)
    registry = server.RunRegistry()
    result = await server.run_workflow_node(
        _workflow_request("vote", mode="majority", samples=3, parallel=4), registry
    )

    assert result == {"result": "fake vote"}
    assert seen["prompt"] == "prompt"
    assert seen["mode"] == "majority"
    assert seen["samples"] == 3
    assert seen["deps"].parallel == 4
    assert seen["deps"].cancel.cancelled is False
    assert len(registry) == 0


async def test_run_workflow_node_dispatches_every_kind_to_fake_runner(
    monkeypatch: Any,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_runner(kind: str) -> Callable[..., Any]:
        async def run(**kwargs: Any) -> dict[str, str]:
            calls.append((kind, kwargs))
            return {"kind": kind}

        return run

    monkeypatch.setattr(wf_nodes, "run_refine", fake_runner("refine"))
    monkeypatch.setattr(wf_nodes, "run_plan_and_map", fake_runner("plan_and_map"))
    monkeypatch.setattr(wf_nodes, "run_extract", fake_runner("extract"))
    monkeypatch.setattr(wf_nodes, "run_route", fake_runner("route"))
    monkeypatch.setattr(wf_nodes, "run_vote", fake_runner("vote"))
    registry = server.RunRegistry()

    for kind, extra in [
        ("refine", {"rubric": "strict", "max_rounds": 2}),
        ("plan_and_map", {"max_workers": 3}),
        ("extract", {"fields": ["name"]}),
        ("route", {"labels": ["yes", "no"]}),
        ("vote", {"mode": "concat", "samples": 2}),
    ]:
        assert await server.run_workflow_node(_workflow_request(kind, **extra), registry) == {"kind": kind}

    assert [kind for kind, _kwargs in calls] == [
        "refine",
        "plan_and_map",
        "extract",
        "route",
        "vote",
    ]
    assert all(kwargs["deps"].cancel.label == "this workflow step" for _kind, kwargs in calls)
    assert len(registry) == 0


async def test_run_workflow_node_returns_bad_kind_and_releases_cancel_handle() -> None:
    registry = server.RunRegistry()

    response = await server.run_workflow_node(_workflow_request("unknown"), registry)

    assert response.status_code == 400
    assert _response_body(response) == {
        "code": "BAD_KIND",
        "error": "unknown workflow node kind: unknown",
    }
    assert len(registry) == 0


async def test_run_workflow_node_keeps_stopped_and_classified_error_contracts(
    monkeypatch: Any,
) -> None:
    async def stopped(**_kwargs: Any) -> None:
        raise wf_nodes.Stopped()

    monkeypatch.setattr(wf_nodes, "run_refine", stopped)
    registry = server.RunRegistry()
    stopped_response = await server.run_workflow_node(_workflow_request("refine"), registry)

    assert _response_body(stopped_response) == {"stopped": True}
    assert len(registry) == 0

    async def failed(**_kwargs: Any) -> None:
        raise llm.LlmError("ENGINE_ERROR", "fake workflow engine failure")

    monkeypatch.setattr(wf_nodes, "run_refine", failed)
    response = await server.run_workflow_node(_workflow_request("refine"), registry)

    assert response.status_code == 502
    assert _response_body(response) == {
        "code": "ENGINE_ERROR",
        "error": "fake workflow engine failure",
    }
    assert len(registry) == 0
