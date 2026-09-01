"""Pure availability-guard coverage for graph delegation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar import graph


def _delegator(*, live: list[str], privacy_restricted: bool = False) -> graph._Delegator:
    return graph._Delegator(
        deps=SimpleNamespace(),
        config={},
        state={"web_enabled": False, "privacy_restricted": privacy_restricted},
        pipeline=[],
        batch=0,
        referents_at_launch=[],
        carryover=(),
        served_names={"open_file"},
        live_domain_keys=live,
    )


def test_unavailable_keeps_an_unrecognised_domain_tolerant() -> None:
    assert _delegator(live=["file"]).unavailable(None, "inspect the lease") is None


def test_unavailable_refuses_a_recognised_domain_missing_from_the_live_catalog() -> None:
    refusal = _delegator(live=["file"]).unavailable("web", "find the weather")

    assert refusal is not None
    assert "no 'web' specialist" in refusal
    assert "available: file" in refusal
    assert "do not answer it from memory" in refusal


def test_unavailable_allows_a_live_domain_with_no_instruction_or_nonvideo_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delegator = _delegator(live=["file"])
    assert delegator.unavailable("file") is None

    calls: list[tuple[str, str, bool]] = []

    def resolve(tool: str, instruction: str, *, web_enabled: bool) -> str:
        calls.append((tool, instruction, web_enabled))
        return "files.read"

    monkeypatch.setattr(graph, "resolve_worker", resolve)
    assert delegator.unavailable("file", "read the lease") is None
    assert calls == [("ask_file_agent", "read the lease", False)]


@pytest.mark.parametrize(
    ("privacy_restricted", "expected"),
    [
        (False, "selected model or provider has no usable video-image channel"),
        (True, "Cloud Privacy keeps the requested video pixels on this Mac"),
    ],
)
def test_unavailable_refuses_an_unreachable_video_member(
    monkeypatch: pytest.MonkeyPatch, privacy_restricted: bool, expected: str
) -> None:
    delegator = _delegator(live=["file"], privacy_restricted=privacy_restricted)
    monkeypatch.setattr(graph, "resolve_worker", lambda *_args, **_kwargs: "media.video")
    monkeypatch.setattr(graph, "worker_reachable", lambda *_args, **_kwargs: False)

    refusal = delegator.unavailable("file", "what is on screen at 00:10?")

    assert refusal is not None
    assert expected in refusal
    assert "Do not substitute the File agent" in refusal


def test_unavailable_allows_a_reachable_video_member(monkeypatch: pytest.MonkeyPatch) -> None:
    delegator = _delegator(live=["file"])
    monkeypatch.setattr(graph, "resolve_worker", lambda *_args, **_kwargs: "media.video")
    monkeypatch.setattr(graph, "worker_reachable", lambda *_args, **_kwargs: True)

    assert delegator.unavailable("file", "what is on screen at 00:10?") is None
