"""Native context-length lookup (`model_limits.native_context_length`) — the
token-budget bar's `max_context` for Ollama-routed models, both local and
`:cloud`. No real Ollama daemon: `httpx.AsyncClient` is swapped for a
`MockTransport`, matching this suite's existing convention (test_mcp_client.py).
"""

from __future__ import annotations

import httpx
import pytest

from arcelle_sidecar import model_limits

#: captured before any test monkeypatches httpx.AsyncClient — the mock
#: factory below must construct the REAL client (with a MockTransport), not
#: recurse into whatever monkeypatch swapped the module attribute for.
_RealAsyncClient = httpx.AsyncClient


def _client_with(handler):
    return lambda *args, **kwargs: _RealAsyncClient(transport=httpx.MockTransport(handler))


async def test_native_context_length_reads_the_matching_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "models": [
                    {"model": "qwen3.5:4b", "details": {"context_length": 262144}},
                    {"model": "nomic-embed-text:latest", "details": {"context_length": 2048}},
                ]
            },
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert length == 262_144


async def test_native_context_length_matches_by_name_field_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"models": [{"name": "gemma4:cloud", "details": {"context_length": 262144}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("gemma4:cloud", "http://127.0.0.1:11434")
    assert length == 262_144


async def test_native_context_length_returns_none_for_an_unlisted_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": []})

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("mystery:1b", "http://127.0.0.1:11434")
    assert length is None


async def test_native_context_length_returns_none_when_the_daemon_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert length is None


async def test_native_context_length_caches_a_successful_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={"models": [{"model": "qwen3.5:4b", "details": {"context_length": 262144}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    first = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    second = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert first == second == 262_144
    assert calls == 1  # the second call was served from cache — no second request
