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
async def test_stream_retries_with_arcelle_write_tools_when_connector_schema_is_rejected(monkeypatch) -> None:
    requests: list[dict] = []
    success = "\n".join(
        [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write","function":{"name":"write_file","arguments":"{\\"name\\":\\"note.md\\",\\"content\\":\\"done\\"}"}}]}}]}',
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
        [
            {"type": "function", "function": {"name": "write_file", "parameters": {}}},
            {"type": "function", "function": {"name": "connector_bad", "parameters": {}}},
        ],
        on_delta,
    )

    assert "tools" in requests[0]
    assert [t["function"]["name"] for t in requests[1]["tools"]] == ["write_file"]
    assert text == ""
    assert calls[0].name == "write_file"
    assert calls[0].arguments == {"name": "note.md", "content": "done"}
    assert usage.is_real is True


def test_write_request_fails_clearly_when_selected_model_has_no_tools() -> None:
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/model", config(tools=False)
    )
    with pytest.raises(provider_api.ProviderApiError, match="Tools capability"):
        model._payload(
            [{"role": "user", "content": "write it"}],
            tools=[
                {"type": "function", "function": {"name": "write_file", "parameters": {}}}
            ],
        )


def test_read_only_tools_also_fail_clearly_when_the_model_has_no_tools() -> None:
    # Dropping the catalog and answering anyway was the quiet failure: the model
    # has no reach into the room at all, and nothing said so.
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/model", config(tools=False)
    )
    with pytest.raises(provider_api.ProviderApiError, match="Tools capability"):
        model._payload(
            [{"role": "user", "content": "what is in my room?"}],
            tools=[
                {"type": "function", "function": {"name": "search_room", "parameters": {}}}
            ],
        )


def test_a_tool_less_call_still_works_on_a_model_without_tools() -> None:
    # Summaries and AI actions offer no tools; they must not be collateral.
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/model", config(tools=False)
    )
    payload = model._payload([{"role": "user", "content": "summarize"}])
    assert "tools" not in payload


def test_a_tool_result_is_labelled_with_the_call_id_the_provider_needs() -> None:
    # summarize.py records the tool's NAME, not the id; sending that as the
    # tool_call_id had the whole request rejected, so a long file's one-line
    # summary failed. The id is in the transcript — pair them up.
    converted = provider_api._messages_for_api(
        [
            {"role": "user", "content": "what is this file"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "read_text", "arguments": {"offset": 0}},
                    }
                ],
            },
            {"role": "tool", "content": "Characters 0-2000", "tool_name": "read_text"},
        ]
    )
    assert converted[2]["tool_call_id"] == "call_abc"
    assert converted[2]["name"] == "read_text"


def test_parallel_tool_results_keep_their_own_call_ids() -> None:
    converted = provider_api._messages_for_api(
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "function": {"name": "read_text", "arguments": {}}},
                    {"id": "c2", "function": {"name": "search_room", "arguments": {}}},
                ],
            },
            {"role": "tool", "content": "b", "tool_name": "search_room"},
            {"role": "tool", "content": "a", "tool_name": "read_text"},
            # An explicit id always wins over the pairing.
            {"role": "tool", "content": "c", "tool_name": "read_text", "tool_call_id": "c9"},
        ]
    )
    assert [m["tool_call_id"] for m in converted[1:]] == ["c2", "c1", "c9"]


@pytest.mark.asyncio
async def test_one_garbled_line_does_not_throw_away_the_reply(monkeypatch) -> None:
    # A truncated frame used to raise out of the middle of the stream and turn
    # the half-written answer already on screen into an error.
    body = "\n".join(
        [
            'data: {"choices":[{"delta":{"content":"Half "}}]}',
            'data: {"choices":[{"delta":{"content":"an ans',  # cut off mid-frame
            ": openrouter processing",  # a comment line, not an event
            'data: {"choices":[{"delta":{"content":"answer"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
            "data: [DONE]",
            "",
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
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
    text, _calls, usage = await model.stream(
        [{"role": "user", "content": "hello"}], [], on_delta
    )
    assert text == "Half answer"
    assert deltas == ["Half ", "answer"]
    assert usage.input_tokens == 7

    chunks = [
        chunk async for chunk in model.generate_stream([{"role": "user", "content": "hi"}])
    ]
    assert chunks == ["Half ", "answer"]


@pytest.mark.asyncio
async def test_an_error_event_still_fails_the_stream(monkeypatch) -> None:
    # Skipping unparseable lines must not swallow the provider saying it failed.
    body = 'data: {"error":{"message":"rate limited"}}\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

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
    with pytest.raises(provider_api.ProviderApiError, match="rate limited"):
        await model.stream([{"role": "user", "content": "hello"}], [], on_delta)


def test_the_give_up_time_can_be_raised_without_a_rebuild(monkeypatch) -> None:
    monkeypatch.delenv(provider_api.PROVIDER_TIMEOUT_ENV, raising=False)
    assert provider_api.provider_timeout_secs() == provider_api.PROVIDER_TIMEOUT_SECS
    monkeypatch.setenv(provider_api.PROVIDER_TIMEOUT_ENV, "1800")
    assert provider_api.provider_timeout_secs() == 1800.0
    monkeypatch.setenv(provider_api.PROVIDER_TIMEOUT_ENV, "later")
    assert provider_api.provider_timeout_secs() == provider_api.PROVIDER_TIMEOUT_SECS
    monkeypatch.setenv(provider_api.PROVIDER_TIMEOUT_ENV, "-5")
    assert provider_api.provider_timeout_secs() == provider_api.PROVIDER_TIMEOUT_SECS


def test_repeated_streamed_tool_name_is_not_duplicated() -> None:
    current = provider_api._merge_stream_piece("", "write_file")
    current = provider_api._merge_stream_piece(current, "write_file")
    assert current == "write_file"
