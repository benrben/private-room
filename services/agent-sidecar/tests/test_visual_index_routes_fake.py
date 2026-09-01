"""Fake-only coverage of the visual-index route boundary."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable

import pytest

from arcelle_sidecar.media import visual_index as visual_index_mod


Route = Callable[["FakeRequest"], Awaitable[Any]]


class FakeApp:
    def __init__(self) -> None:
        self.state = SimpleNamespace()
        self.routes: dict[str, Route] = {}

    def post(self, path: str) -> Callable[[Route], Route]:
        def register(handler: Route) -> Route:
            self.routes[path] = handler
            return handler

        return register


class FakeRequest:
    def __init__(self, app: FakeApp, body: object) -> None:
        self.app = app
        self._body = body

    async def json(self) -> object:
        if isinstance(self._body, BaseException):
            raise self._body
        return self._body


class FakeStore:
    def __init__(self) -> None:
        self.warm_calls: list[Path] = []
        self.frame_calls: list[tuple[object, object]] = []
        self.warm_result: object = {"status": "ready", "index_id": "fake-index"}
        self.frame_result: object = {"image_b64": "ZmFrZQ=="}

    def warm(self, source: Path) -> object:
        self.warm_calls.append(source)
        if isinstance(self.warm_result, BaseException):
            raise self.warm_result
        return self.warm_result

    def frame(self, index_id: object, second: object) -> object:
        self.frame_calls.append((index_id, second))
        if isinstance(self.frame_result, BaseException):
            raise self.frame_result
        return self.frame_result


@pytest.fixture
def route_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[FakeApp, FakeStore]:
    async def fake_to_thread(function: Callable[..., object], *args: object) -> object:
        return function(*args)

    monkeypatch.setattr(visual_index_mod.asyncio, "to_thread", fake_to_thread)
    app = FakeApp()
    store = FakeStore()
    assert visual_index_mod.register_visual_index_routes(app, store) is store  # type: ignore[arg-type]
    return app, store


def _error(response: object) -> tuple[int, dict[str, str]]:
    assert isinstance(response, visual_index_mod.JSONResponse)
    return response.status_code, json.loads(response.body)


def test_staged_path_shape_accepts_only_bounded_host_text() -> None:
    assert visual_index_mod._valid_staged_video_value("/fabricated/stage/video.mp4")
    assert not visual_index_mod._valid_staged_video_value("")
    assert not visual_index_mod._valid_staged_video_value("x" * 4097)
    assert not visual_index_mod._valid_staged_video_value(17)


def test_workspace_stage_requires_the_host_temp_layout() -> None:
    temp_root = Path("/fabricated/tmp")
    assert visual_index_mod._is_workspace_staged_video(
        temp_root / "arcelle-stt-job" / "video.mp4", temp_root
    )
    assert visual_index_mod._is_workspace_staged_video(
        temp_root / "arcelle-visual-index-job" / "video.mp4", temp_root
    )
    assert not visual_index_mod._is_workspace_staged_video(
        temp_root / "other-job" / "video.mp4", temp_root
    )
    assert not visual_index_mod._is_workspace_staged_video(
        Path("/fabricated/elsewhere/arcelle-stt-job/video.mp4"), temp_root
    )


def test_route_registration_keeps_one_fake_store_for_all_visual_index_actions(
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, store = route_harness
    assert app.state.visual_index_store is store
    assert set(app.routes) == {
        "/media/visual-index/warm",
        "/media/visual-index/frame",
        "/media/visual-index/capture",
    }


def test_warm_route_forwards_one_fabricated_staged_path(
    monkeypatch: pytest.MonkeyPatch,
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, store = route_harness
    source = Path("/fabricated/tmp/arcelle-stt-job/video.mp4")
    monkeypatch.setattr(visual_index_mod, "_staged_video_path", lambda value: source)

    result = asyncio.run(
        app.routes["/media/visual-index/warm"](FakeRequest(app, {"path": "staged-id"}))
    )

    assert result == {"status": "ready", "index_id": "fake-index"}
    assert store.warm_calls == [source]


def test_frame_route_forwards_fake_index_and_second(
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, store = route_harness

    result = asyncio.run(
        app.routes["/media/visual-index/frame"](
            FakeRequest(app, {"index_id": "fake-index", "second": 5})
        )
    )

    assert result == {"image_b64": "ZmFrZQ=="}
    assert store.frame_calls == [("fake-index", 5)]


def test_capture_route_forwards_fake_stage_second_and_pinned_profile(
    monkeypatch: pytest.MonkeyPatch,
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, _store = route_harness
    source = Path("/fabricated/tmp/arcelle-visual-index-job/video.mp4")
    calls: list[tuple[Path, int, object]] = []
    payload = {"image_b64": "ZmFrZQ==", "resolved_second": 7}
    monkeypatch.setattr(visual_index_mod, "_staged_video_path", lambda value: source)

    def fake_capture(actual_source: Path, second: int, profile: object) -> dict[str, object]:
        calls.append((actual_source, second, profile))
        return payload

    monkeypatch.setattr(visual_index_mod, "capture_frame_avfoundation", fake_capture)
    result = asyncio.run(
        app.routes["/media/visual-index/capture"](
            FakeRequest(app, {"path": "staged-id", "second": 7})
        )
    )

    assert result == payload
    assert calls == [(source, 7, visual_index_mod.PROFILE)]


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("/media/visual-index/warm", {"path": "staged-id", "extra": True}),
        ("/media/visual-index/frame", {"index_id": "fake-index"}),
        ("/media/visual-index/capture", {"path": "staged-id"}),
    ],
)
def test_routes_reject_extra_or_missing_body_fields(
    route_harness: tuple[FakeApp, FakeStore], route: str, body: object
) -> None:
    app, _store = route_harness

    status, payload = _error(asyncio.run(app.routes[route](FakeRequest(app, body))))

    assert status == 400
    assert payload["code"] == "VISUAL_INDEX_BAD_REQUEST"


@pytest.mark.parametrize(
    "route",
    [
        "/media/visual-index/warm",
        "/media/visual-index/frame",
        "/media/visual-index/capture",
    ],
)
def test_routes_map_fabricated_json_type_errors_to_bad_requests(
    route_harness: tuple[FakeApp, FakeStore], route: str
) -> None:
    app, _store = route_harness

    status, payload = _error(
        asyncio.run(app.routes[route](FakeRequest(app, TypeError("fabricated JSON error"))))
    )

    assert status == 400
    assert payload["code"] == "VISUAL_INDEX_BAD_REQUEST"


def test_warm_route_preserves_a_fabricated_visual_index_failure(
    monkeypatch: pytest.MonkeyPatch,
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, store = route_harness
    store.warm_result = visual_index_mod.VisualIndexError(
        "VISUAL_INDEX_UNREADABLE", "fabricated unreadable video", 422
    )
    monkeypatch.setattr(
        visual_index_mod,
        "_staged_video_path",
        lambda value: Path("/fabricated/tmp/arcelle-stt-job/video.mp4"),
    )

    status, payload = _error(
        asyncio.run(app.routes["/media/visual-index/warm"](FakeRequest(app, {"path": "staged-id"})))
    )

    assert (status, payload) == (
        422,
        {"code": "VISUAL_INDEX_UNREADABLE", "error": "fabricated unreadable video"},
    )


def test_frame_route_preserves_a_fabricated_visual_index_failure(
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, store = route_harness
    store.frame_result = visual_index_mod.VisualIndexError(
        "VISUAL_INDEX_NOT_FOUND", "fabricated missing index", 404
    )

    status, payload = _error(
        asyncio.run(
            app.routes["/media/visual-index/frame"](
                FakeRequest(app, {"index_id": "fake-index", "second": 0})
            )
        )
    )

    assert (status, payload) == (
        404,
        {"code": "VISUAL_INDEX_NOT_FOUND", "error": "fabricated missing index"},
    )


def test_capture_route_preserves_a_fabricated_visual_index_failure(
    monkeypatch: pytest.MonkeyPatch,
    route_harness: tuple[FakeApp, FakeStore],
) -> None:
    app, _store = route_harness
    failure = visual_index_mod.VisualIndexError(
        "VISUAL_INDEX_UNREADABLE", "fabricated capture failure", 422
    )
    monkeypatch.setattr(
        visual_index_mod,
        "_staged_video_path",
        lambda value: Path("/fabricated/tmp/arcelle-stt-job/video.mp4"),
    )
    monkeypatch.setattr(visual_index_mod, "_requested_second", lambda value: 0)

    def failed_capture(source: Path, second: int, profile: object) -> object:
        raise failure

    monkeypatch.setattr(visual_index_mod, "capture_frame_avfoundation", failed_capture)

    status, payload = _error(
        asyncio.run(
            app.routes["/media/visual-index/capture"](
                FakeRequest(app, {"path": "staged-id", "second": 0})
            )
        )
    )

    assert (status, payload) == (
        422,
        {"code": "VISUAL_INDEX_UNREADABLE", "error": "fabricated capture failure"},
    )
