"""Fake-only contracts for the image-generation and privacy-scan routes."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from arcelle_sidecar import server
from arcelle_sidecar.server import create_app


PROVIDER = {
    "id": "test-provider",
    "api_key": "test-key",
    "base_url": "https://provider.invalid",
    "model": "test/image-model",
}


def client_for_endpoints() -> httpx.AsyncClient:
    """Use ASGI directly so endpoint tests cannot start any real service."""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()),
        base_url="http://sidecar",
    )


async def test_image_generate_requires_a_model() -> None:
    async with client_for_endpoints() as client:
        response = await client.post("/image_generate", json={"prompt": "fake image"})

    assert response.status_code == 422


async def test_image_generate_refuses_a_request_without_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    async def generate_should_not_run(**_kwargs: Any) -> Any:
        nonlocal called
        called = True
        raise AssertionError("the route must refuse before generation")

    monkeypatch.setattr(server.imagegen, "generate", generate_should_not_run)

    async with client_for_endpoints() as client:
        response = await client.post(
            "/image_generate", json={"model": "test/image-model", "prompt": "fake image"}
        )

    assert response.status_code == 400
    assert response.json() == {
        "code": "IMAGEGEN_BAD_REQUEST",
        "error": (
            "No API key is connected for this model. Add one in Settings, under AI "
            "providers."
        ),
    }
    assert called is False


async def test_image_generate_returns_the_fabricated_provider_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}
    result = {"mime": "image/png", "data_b64": "fabricated"}

    async def fake_generate(**kwargs: Any) -> dict[str, str]:
        seen.update(kwargs)
        return result

    monkeypatch.setattr(server.imagegen, "generate", fake_generate)
    body = {
        "model": "test/image-model",
        "prompt": "paint a fabricated test scene",
        "provider": PROVIDER,
        "privacy": {"active": True},
        "reference_b64": ["fake-reference"],
        "reference_mime": ["image/webp"],
        "references_ack": True,
        "aspect_ratio": "16:9",
        "resolution": "1K",
        "kind": "image",
    }

    async with client_for_endpoints() as client:
        response = await client.post("/image_generate", json=body)

    assert response.status_code == 200
    assert response.json() == result
    assert seen["provider"].model_dump(include=set(PROVIDER)) == PROVIDER
    assert {key: value for key, value in seen.items() if key != "provider"} == {
        "prompt": body["prompt"],
        "model": body["model"],
        "privacy": body["privacy"],
        "reference_b64": body["reference_b64"],
        "reference_mime": body["reference_mime"],
        "references_ack": True,
        "aspect_ratio": "16:9",
        "resolution": "1K",
        "kind": "image",
    }


async def test_image_generate_maps_a_fabricated_generation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(**_kwargs: Any) -> Any:
        raise server.imagegen.ImageGenError("fabricated upstream failure")

    monkeypatch.setattr(server.imagegen, "generate", fake_generate)

    async with client_for_endpoints() as client:
        response = await client.post(
            "/image_generate",
            json={"model": "test/image-model", "provider": PROVIDER},
        )

    assert response.status_code == 502
    assert response.json() == {
        "code": "IMAGEGEN_FAILED",
        "error": "fabricated upstream failure",
    }


async def test_privacy_scan_requires_a_model() -> None:
    async with client_for_endpoints() as client:
        response = await client.post("/privacy_scan", json={"text": "fake secret"})

    assert response.status_code == 422


async def test_privacy_scan_returns_a_fabricated_complete_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    class FakeScan:
        entities = [{"text": "Ada", "category": "person"}]
        complete = True
        chunks_failed = 1
        capped = False

    async def await_immediately(_request: Any, work: Any) -> Any:
        return await work

    async def fake_scan_text(
        text: str,
        *,
        model: str,
        base_url: str,
        concepts: list[str],
        known: list[str],
    ) -> FakeScan:
        seen.update(
            text=text,
            model=model,
            base_url=base_url,
            concepts=concepts,
            known=known,
        )
        return FakeScan()

    monkeypatch.setattr(server, "until_hangup", await_immediately)
    monkeypatch.setattr(server.privacy_scan_mod, "scan_text", fake_scan_text)
    body = {
        "model": "local-test-model",
        "base_url": "http://fake-local-engine",
        "text": "Ada's fabricated record",
        "concepts": ["people"],
        "known": ["Ben"],
    }

    async with client_for_endpoints() as client:
        response = await client.post("/privacy_scan", json=body)

    assert response.status_code == 200
    assert response.json() == {
        "entities": [{"text": "Ada", "category": "person"}],
        "complete": True,
        "chunksFailed": 1,
        "capped": False,
    }
    assert seen == body


async def test_privacy_scan_refuses_a_fabricated_invalid_scan_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def await_immediately(_request: Any, work: Any) -> Any:
        return await work

    async def invalid_scan(_text: str, **_kwargs: Any) -> Any:
        raise ValueError("privacy scanning requires a local model")

    monkeypatch.setattr(server, "until_hangup", await_immediately)
    monkeypatch.setattr(server.privacy_scan_mod, "scan_text", invalid_scan)

    async with client_for_endpoints() as client:
        response = await client.post(
            "/privacy_scan", json={"model": "remote-model", "text": "fake secret"}
        )

    assert response.status_code == 400
    assert response.json() == {
        "code": "BAD_REQUEST",
        "error": "privacy scanning requires a local model",
    }


async def test_privacy_scan_preserves_a_fabricated_engine_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def await_immediately(_request: Any, work: Any) -> Any:
        return await work

    async def unavailable_scan(_text: str, **_kwargs: Any) -> Any:
        raise server.llm.LlmError("OLLAMA_DOWN", "fabricated scanner unavailable")

    monkeypatch.setattr(server, "until_hangup", await_immediately)
    monkeypatch.setattr(server.privacy_scan_mod, "scan_text", unavailable_scan)

    async with client_for_endpoints() as client:
        response = await client.post(
            "/privacy_scan", json={"model": "local-test-model", "text": "fake secret"}
        )

    assert response.status_code == 502
    assert response.json() == {
        "code": "OLLAMA_DOWN",
        "error": "fabricated scanner unavailable",
    }
