"""Fully fabricated transport coverage for one-shot provider streaming."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar import provider_api


class _FakeResponse:
    def __init__(
        self,
        lines: list[str],
        *,
        is_success: bool = True,
        status_code: int = 200,
        error: Any = None,
    ) -> None:
        self._lines = lines
        self.is_success = is_success
        self.status_code = status_code
        self._error = error
        self.read = False
        self.closed = False

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *_args: object) -> None:
        self.closed = True

    async def aiter_lines(self):  # type: ignore[no-untyped-def]
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        self.read = True
        return b""

    def json(self) -> Any:
        return {"error": self._error} if self._error is not None else {}


class _FakeClient:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.requests: list[dict[str, Any]] = []
        self.closed = False

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_args: object) -> None:
        self.closed = True

    def stream(self, method: str, endpoint: str, **kwargs: Any) -> _FakeResponse:
        self.requests.append({"method": method, "endpoint": endpoint, **kwargs})
        return self.response


def _config() -> SimpleNamespace:
    return SimpleNamespace(
        id="openrouter",
        api_key="test-key",
        base_url="https://provider.invalid/api/v1",
        model="vendor/model",
        context_window=16_000,
        supports_tools=True,
        supports_vision=None,
    )


def _install_client(
    monkeypatch: pytest.MonkeyPatch, response: _FakeResponse
) -> _FakeClient:
    client = _FakeClient(response)
    monkeypatch.setattr(provider_api.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


async def test_generate_stream_yields_content_and_sends_the_stream_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeResponse(
        [
            ": keep-alive",
            'data: {"choices":[]}',
            'data: {"choices":[{"delta":{"content":"Hello "}}]}',
            "data: malformed JSON",
            'data: {"choices":[{"delta":{"content":2}}]}',
            'data: {"choices":[{"delta":{"content":""}}]}',
            "data: [DONE]",
        ]
    )
    client = _install_client(monkeypatch, response)
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/model", _config(), temperature=0.25
    )

    chunks = [
        chunk
        async for chunk in model.generate_stream(
            [{"role": "user", "content": "Summarize this."}],
            format={"type": "object", "properties": {"title": {"type": "string"}}},
        )
    ]

    assert chunks == ["Hello ", "2"]
    assert client.requests == [
        {
            "method": "POST",
            "endpoint": "https://provider.invalid/api/v1/chat/completions",
            "headers": {
                "Authorization": "Bearer test-key",
                "Content-Type": "application/json",
                "X-OpenRouter-Title": "Arcelle",
            },
            "json": {
                "model": "vendor/model",
                "messages": [{"role": "user", "content": "Summarize this."}],
                "stream": True,
                "stream_options": {"include_usage": True},
                "temperature": 0.25,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "arcelle_response",
                        "strict": True,
                        "schema": {"type": "object", "properties": {"title": {"type": "string"}}},
                    },
                },
            },
        }
    ]
    assert response.closed and client.closed


async def test_generate_stream_reads_a_failed_response_before_reporting_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeResponse(
        [], is_success=False, status_code=429, error={"message": "rate limited"}
    )
    client = _install_client(monkeypatch, response)
    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", _config())

    with pytest.raises(provider_api.ProviderApiError, match="rate limited"):
        async for _chunk in model.generate_stream([{"role": "user", "content": "hello"}]):
            pass

    assert response.read
    assert response.closed and client.closed


async def test_generate_stream_propagates_a_provider_sse_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeResponse(['data: {"error":{"message":"stream failed"}}'])
    _install_client(monkeypatch, response)
    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", _config())

    with pytest.raises(provider_api.ProviderApiError, match="stream failed"):
        async for _chunk in model.generate_stream([{"role": "user", "content": "hello"}]):
            pass
