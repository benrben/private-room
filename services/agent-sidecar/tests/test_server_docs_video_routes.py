"""Fake-only coverage for the document-extract and video-submit HTTP routes."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Callable

import httpx
import pytest

from arcelle_sidecar import server


def client_for(app: Any) -> httpx.AsyncClient:
    """An in-process ASGI client: it never opens a listening socket."""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://sidecar"
    )


@dataclass(frozen=True)
class FakePath:
    """The small Path surface `/docs/extract` needs, with no disk access."""

    value: str
    exists: bool = True
    payload: bytes = b"fake staged document"

    def resolve(self) -> FakePath:
        return self

    @property
    def parent(self) -> FakePath:
        head, _separator, _tail = self.value.rstrip("/").rpartition("/")
        return FakePath(head or "/", self.exists, self.payload)

    @property
    def name(self) -> str:
        return self.value.rstrip("/").rpartition("/")[2]

    def is_file(self) -> bool:
        return self.exists

    def read_bytes(self) -> bytes:
        return self.payload


def fake_paths(
    monkeypatch: pytest.MonkeyPatch,
    *,
    exists: bool = True,
    payload: bytes = b"fake staged document",
) -> None:
    def path(value: str | FakePath) -> FakePath:
        if isinstance(value, FakePath):
            return value
        return FakePath(str(value), exists=exists, payload=payload)

    async def direct_thread(function: Callable[..., Any], *args: Any) -> Any:
        return function(*args)

    monkeypatch.setattr(server, "Path", path)
    monkeypatch.setattr(server.tempfile, "gettempdir", lambda: "/fake-tmp")
    monkeypatch.setattr(server.asyncio, "to_thread", direct_thread)


def provider_body() -> dict[str, Any]:
    return {
        "id": "fake-provider",
        "api_key": "fake-key",
        "base_url": "https://fake-provider.invalid/v1",
        "model": "fake/filmer",
    }


@pytest.mark.anyio
async def test_docs_extract_uses_only_a_fabricated_staged_path_and_dispatcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_paths(monkeypatch, payload=b"fake .docx bytes")
    seen: list[tuple[str, bytes]] = []

    def extract(name: str, data: bytes) -> str:
        seen.append((name, data))
        return "fake extracted text"

    monkeypatch.setattr(server, "extract_document_text", extract)
    app = server.create_app(token="fake-token")
    async with client_for(app) as client:
        response = await client.post(
            "/docs/extract",
            headers={"Authorization": "Bearer fake-token"},
            json={
                "path": "/fake-tmp/arcelle-docs-test/upload.docx",
                "name": "meeting.docx",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"text": "fake extracted text"}
    assert seen == [("meeting.docx", b"fake .docx bytes")]


@pytest.mark.anyio
async def test_docs_extract_refuses_nonstaged_and_missing_fake_paths_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatched = False

    def should_not_extract(_name: str, _data: bytes) -> str:
        nonlocal dispatched
        dispatched = True
        raise AssertionError("a refused path must not reach document extraction")

    fake_paths(monkeypatch)
    monkeypatch.setattr(server, "extract_document_text", should_not_extract)
    app = server.create_app()
    async with client_for(app) as client:
        refused = await client.post(
            "/docs/extract", json={"path": "/fake-tmp/not-arcelle/file.docx"}
        )

    assert refused.status_code == 400
    assert refused.json() == {
        "code": "DOCS_BAD_REQUEST",
        "error": "the staged document path was refused",
    }
    assert dispatched is False

    fake_paths(monkeypatch, exists=False)
    app = server.create_app()
    async with client_for(app) as client:
        missing = await client.post(
            "/docs/extract", json={"path": "/fake-tmp/arcelle-docs-test/missing.docx"}
        )

    assert missing.status_code == 400
    assert missing.json() == {
        "code": "DOCS_BAD_REQUEST",
        "error": "the staged document is missing",
    }
    assert dispatched is False


@pytest.mark.anyio
async def test_docs_extract_keeps_a_fabricated_dispatch_failure_visible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_paths(monkeypatch)

    def explode(_name: str, _data: bytes) -> str:
        raise ValueError("fake parser refused this document")

    monkeypatch.setattr(server, "extract_document_text", explode)
    app = server.create_app()
    async with client_for(app) as client:
        response = await client.post(
            "/docs/extract", json={"path": "/fake-tmp/arcelle-docs-test/bad.docx"}
        )

    assert response.status_code == 422
    assert response.json() == {
        "code": "DOCS_EXTRACT_FAILED",
        "error": "fake parser refused this document",
    }


@pytest.mark.anyio
async def test_video_start_rejects_missing_credentials_without_submitting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def should_not_submit(**_kwargs: Any) -> dict[str, str]:
        raise AssertionError("a request without a provider must not be submitted")

    monkeypatch.setattr(server.videogen, "submit", should_not_submit)
    app = server.create_app()
    async with client_for(app) as client:
        response = await client.post("/video_start", json={"model": "openrouter::fake/filmer"})

    assert response.status_code == 400
    assert response.json() == {
        "code": "VIDEOGEN_BAD_REQUEST",
        "error": "No API key is connected for this model. Add one in Settings, under AI providers.",
    }


@pytest.mark.anyio
async def test_video_start_forwards_only_to_a_fabricated_submitter_and_surfaces_its_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def submit(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"video_id": "fake-video-job", "privacy": {"redacted": 0}}

    monkeypatch.setattr(server.videogen, "submit", submit)
    body = {
        "model": "openrouter::fake/filmer",
        "prompt": "a fake paper boat in a fake harbour",
        "provider": provider_body(),
        "privacy": {"active": False},
        "seconds": 6,
        "resolution": "720p",
        "aspect_ratio": "16:9",
        "frames": [{"b64": "ZmFrZQ==", "mime": "image/png", "frame_type": "last_frame"}],
        "references": [{"b64": "ZmFrZSByZWZlcmVuY2U=", "mime": "image/jpeg"}],
        "references_ack": True,
        "generate_audio": False,
    }
    app = server.create_app(token="fake-token")
    async with client_for(app) as client:
        response = await client.post(
            "/video_start", headers={"Authorization": "Bearer fake-token"}, json=body
        )

    assert response.status_code == 200
    assert response.json() == {"video_id": "fake-video-job", "privacy": {"redacted": 0}}
    assert len(calls) == 1
    call = calls[0]
    assert {key: value for key, value in call.items() if key != "provider"} == {
        "prompt": "a fake paper boat in a fake harbour",
        "model": "openrouter::fake/filmer",
        "privacy": {"active": False},
        "seconds": 6,
        "resolution": "720p",
        "aspect_ratio": "16:9",
        "frames": [{"b64": "ZmFrZQ==", "mime": "image/png", "frame_type": "last_frame"}],
        "references": [{"b64": "ZmFrZSByZWZlcmVuY2U=", "mime": "image/jpeg"}],
        "references_ack": True,
        "generate_audio": False,
    }
    for key, value in provider_body().items():
        assert getattr(call["provider"], key) == value

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise server.videogen.VideoGenError("fake provider unavailable")

    monkeypatch.setattr(server.videogen, "submit", fail)
    app = server.create_app()
    async with client_for(app) as client:
        failed = await client.post("/video_start", json=body)

    assert failed.status_code == 502
    assert failed.json() == {
        "code": "VIDEOGEN_FAILED",
        "error": "fake provider unavailable",
    }


@pytest.mark.anyio
async def test_video_status_validates_credentials_and_uses_only_a_fabricated_poller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def status(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"status": "running", "progress": 42}

    monkeypatch.setattr(server.videogen, "status", status)
    body = {
        "model": "openrouter::fake/filmer",
        "video_id": "fake-video-job",
        "provider": provider_body(),
    }
    app = server.create_app()
    async with client_for(app) as client:
        missing_provider = await client.post(
            "/video_status", json={"model": "openrouter::fake/filmer", "video_id": "fake-video-job"}
        )
        success = await client.post("/video_status", json=body)

    assert missing_provider.status_code == 400
    assert missing_provider.json() == {
        "code": "VIDEOGEN_BAD_REQUEST",
        "error": "No API key is connected for this model. Add one in Settings, under AI providers.",
    }
    assert success.status_code == 200
    assert success.json() == {"status": "running", "progress": 42}
    assert len(calls) == 1
    assert {key: value for key, value in calls[0].items() if key != "provider"} == {
        "model": "openrouter::fake/filmer",
        "video_id": "fake-video-job",
    }
    for key, value in provider_body().items():
        assert getattr(calls[0]["provider"], key) == value

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise server.videogen.VideoGenError("fake status provider failure")

    monkeypatch.setattr(server.videogen, "status", fail)
    app = server.create_app()
    async with client_for(app) as client:
        failed = await client.post("/video_status", json=body)

    assert failed.status_code == 502
    assert failed.json() == {
        "code": "VIDEOGEN_FAILED",
        "error": "fake status provider failure",
    }


@pytest.mark.anyio
async def test_video_fetch_validates_then_uses_only_a_fabricated_fetcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def fetch(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"video_b64": "ZmFrZSBjbGlw", "mime": "video/mp4"}

    monkeypatch.setattr(server.videogen, "fetch", fetch)
    body = {
        "model": "openrouter::fake/filmer",
        "video_id": "fake-video-job",
        "index": 2,
        "provider": provider_body(),
    }
    app = server.create_app()
    async with client_for(app) as client:
        malformed = await client.post("/video_fetch", json={"model": "fake"})
        missing_provider = await client.post(
            "/video_fetch", json={"model": "fake", "video_id": "fake-video-job"}
        )
        success = await client.post("/video_fetch", json=body)

    assert malformed.status_code == 422
    assert missing_provider.status_code == 400
    assert success.status_code == 200
    assert success.json() == {"video_b64": "ZmFrZSBjbGlw", "mime": "video/mp4"}
    assert len(calls) == 1
    assert {key: value for key, value in calls[0].items() if key != "provider"} == {
        "model": "openrouter::fake/filmer",
        "video_id": "fake-video-job",
        "index": 2,
    }

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise server.videogen.VideoGenError("fake fetch provider failure")

    monkeypatch.setattr(server.videogen, "fetch", fail)
    app = server.create_app()
    async with client_for(app) as client:
        failed = await client.post("/video_fetch", json=body)

    assert failed.status_code == 502
    assert failed.json() == {
        "code": "VIDEOGEN_FAILED",
        "error": "fake fetch provider failure",
    }


@pytest.mark.anyio
async def test_quicklook_validates_base64_and_uses_only_a_fabricated_renderer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, bytes]] = []

    async def direct_thread(function: Callable[..., Any], *args: Any) -> Any:
        return function(*args)

    def preview(name: str, data: bytes) -> bytes | None:
        calls.append((name, data))
        return b"fake png"

    monkeypatch.setattr(server.asyncio, "to_thread", direct_thread)
    monkeypatch.setattr(server, "quicklook_preview_png", preview)
    app = server.create_app()
    async with client_for(app) as client:
        invalid = await client.post(
            "/quicklook", json={"name": "fake.pdf", "data_b64": "not-base64!"}
        )
        success = await client.post(
            "/quicklook",
            json={
                "name": "fake.pdf",
                "data_b64": base64.b64encode(b"fake document").decode("ascii"),
            },
        )

    assert invalid.status_code == 400
    assert invalid.json() == {"code": "QUICKLOOK_BAD_REQUEST", "error": "invalid base64"}
    assert success.status_code == 200
    assert success.json() == {"png_b64": base64.b64encode(b"fake png").decode("ascii")}
    assert calls == [("fake.pdf", b"fake document")]

    monkeypatch.setattr(server, "quicklook_preview_png", lambda _name, _data: None)
    app = server.create_app()
    async with client_for(app) as client:
        unavailable = await client.post(
            "/quicklook",
            json={"name": "fake.pdf", "data_b64": base64.b64encode(b"empty").decode("ascii")},
        )

    assert unavailable.status_code == 200
    assert unavailable.json() == {"png_b64": None}
