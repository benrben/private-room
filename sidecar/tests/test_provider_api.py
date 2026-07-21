import json
from types import SimpleNamespace

import httpx
import pytest

from arcelle_sidecar import provider_api


def config(*, tools: bool = True):
    return SimpleNamespace(
        id="openrouter",
        api_key="test-secret",
        base_url="https://openrouter.test/api/v1",
        model="vendor/model",
        context_window=200_000,
        supports_tools=tools,
    )


@pytest.mark.asyncio
async def test_stream_reassembles_openai_tool_calls_and_usage(monkeypatch) -> None:
    body = "\n".join(
        [
            'data: {"choices":[{"delta":{"content":"Hi ","tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_","arguments":"{\\"q\\":"}}]}}]}',
            'data: {"choices":[{"delta":{"content":"there","tool_calls":[{"index":0,"function":{"name":"room","arguments":"\\"lease\\"}"}}]}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":9}}',
            "data: [DONE]",
            "",
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.url.path == "/api/v1/chat/completions"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        provider_api.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    deltas: list[str] = []

    async def on_delta(value: str) -> None:
        deltas.append(value)

    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    text, calls, usage = await model.stream(
        [{"role": "user", "content": "hello"}],
        [{"type": "function", "function": {"name": "search_room", "parameters": {}}}],
        on_delta,
    )

    assert text == "Hi there"
    assert deltas == ["Hi ", "there"]
    assert calls[0].name == "search_room"
    assert calls[0].arguments == {"q": "lease"}
    assert calls[0].raw["function"]["arguments"] == '{"q":"lease"}'
    assert usage.input_tokens == 123
    assert usage.output_tokens == 9
    assert usage.max_context == 200_000


def test_message_conversion_preserves_images_and_stringifies_tool_arguments() -> None:
    converted = provider_api._messages_for_api(
        [
            {"role": "user", "content": "look", "images": ["abc"]},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c",
                        "type": "function",
                        "function": {"name": "open_file", "arguments": {"name": "a.pdf"}},
                    }
                ],
            },
        ]
    )
    assert converted[0]["content"][1]["image_url"]["url"].endswith("abc")
    assert converted[1]["tool_calls"][0]["function"]["arguments"] == '{"name":"a.pdf"}'


@pytest.mark.asyncio
async def test_stream_retries_without_rejected_tool_catalog(monkeypatch) -> None:
    requests: list[dict] = []
    success = "\n".join(
        [
            'data: {"choices":[{"delta":{"content":"fallback worked"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
            "data: [DONE]",
            "",
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(
                400,
                json={"error": {"message": "invalid tool schema"}},
            )
        return httpx.Response(
            200,
            text=success,
            headers={"content-type": "text/event-stream"},
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        provider_api.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    async def on_delta(_value: str) -> None:
        pass

    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    text, calls, usage = await model.stream(
        [{"role": "user", "content": "hello"}],
        [{"type": "function", "function": {"name": "bad", "parameters": {}}}],
        on_delta,
    )

    assert "tools" in requests[0]
    assert "tools" not in requests[1]
    assert text == "fallback worked"
    assert calls == []
    assert usage.is_real is True
