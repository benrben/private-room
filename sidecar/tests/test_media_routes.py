"""Authenticated media utility routes used by the Electron host."""

from __future__ import annotations

import base64
from typing import Any

import httpx
import pytest

from arcelle_sidecar import server


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://sidecar",
    )


@pytest.mark.anyio
async def test_ocr_decodes_bytes_and_returns_vision_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, str, bytes]] = []

    def recognize(mime: str, ext: str, data: bytes) -> str | None:
        seen.append((mime, ext, data))
        return "שלום\nInvoice 42"

    monkeypatch.setattr(server, "ocr_recognize", recognize)
    app = server.create_app(token="secret")
    async with client_for(app) as client:
        response = await client.post(
            "/ocr",
            headers={"Authorization": "Bearer secret"},
            json={
                "mime": "image/png",
                "ext": "png",
                "data_b64": base64.b64encode(b"scan bytes").decode("ascii"),
            },
        )

    assert response.status_code == 200
    assert response.json() == {"text": "שלום\nInvoice 42"}
    assert seen == [("image/png", "png", b"scan bytes")]


@pytest.mark.anyio
async def test_ocr_rejects_invalid_base64_before_calling_vision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def should_not_run(_mime: str, _ext: str, _data: bytes) -> None:
        raise AssertionError("Vision must not receive malformed input")

    monkeypatch.setattr(server, "ocr_recognize", should_not_run)
    app = server.create_app()
    async with client_for(app) as client:
        response = await client.post(
            "/ocr",
            json={"mime": "image/png", "ext": "png", "data_b64": "not-base64!"},
        )

    assert response.status_code == 400
    assert response.json() == {"code": "OCR_BAD_REQUEST", "error": "invalid base64"}
