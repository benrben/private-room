import json
from types import SimpleNamespace

import httpx
import pytest

from arcelle_sidecar import provider_api


def config(*, tools: bool = True, vision: bool | None = None):
    return SimpleNamespace(
        id="openrouter",
        api_key="test-secret",
        base_url="https://openrouter.test/api/v1",
        model="vendor/model",
        context_window=200_000,
        supports_tools=tools,
        supports_vision=vision,
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


def test_openrouter_vision_false_refuses_pixels_before_building_a_payload() -> None:
    """Transport support is not per-model support; explicit false wins."""
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/text-only", config(vision=False)
    )
    with pytest.raises(provider_api.ProviderApiError, match="does not support image input"):
        model._payload(
            [{"role": "user", "content": "inspect this", "images": ["AAAA"]}],
            stream=True,
        )


@pytest.mark.parametrize("vision", [True, None])
def test_openrouter_vision_true_or_legacy_unknown_uses_real_image_url_channel(
    vision: bool | None,
) -> None:
    """True sends pixels; None preserves compatibility with an older host."""
    model = provider_api.OpenAICompatibleChatModel(
        "openrouter::vendor/vision", config(vision=vision)
    )
    payload = model._payload(
        [{"role": "user", "content": "inspect this", "images": ["QUJDRA=="]}]
    )
    content = payload["messages"][0]["content"]
    assert content[1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,QUJDRA=="},
    }


@pytest.mark.asyncio
async def test_a_rejected_catalog_is_never_re_sent_without_the_unrecognised_tools(
    monkeypatch,
) -> None:
    """The replacement for `…retries_with_arcelle_write_tools…`.

    That test pinned a retry which narrowed the catalog to a hardcoded name
    allowlist, and its fixture invented a catalog entry called `connector_bad`
    to justify it. No such entry exists: connected MCP servers are served
    through the `search_mcp_tools` / `run_mcp_tool` proxy pair and their
    individual schemas never enter a model request (`room_mcp.rs::served_tools`).

    So the narrowing could only ever delete OUR tools, and the allowlist had
    gone stale — it was missing every `browse_*` tool, which is the whole
    Browser agent. What the retry actually produced was an agent quietly
    stripped of its catalog, or, when nothing matched, a bare provider error.
    """
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(400, json={"error": {"message": "invalid tool schema"}})

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
    with pytest.raises(provider_api.ProviderApiError, match="invalid tool schema"):
        await model.stream(
            [{"role": "user", "content": "hello"}],
            [
                {"type": "function", "function": {"name": "write_file", "parameters": {}}},
                {"type": "function", "function": {"name": "browse_open", "parameters": {}}},
            ],
            on_delta,
        )

    assert len(requests) == 1, "one attempt — no second, narrowed catalog"
    assert [t["function"]["name"] for t in requests[0]["tools"]] == [
        "write_file",
        "browse_open",
    ]


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


def test_an_unknown_context_window_still_gets_a_budget() -> None:
    """The hole every other guard was built to close.

    "Unknown window means no budget" made `compact_to_budget` return
    immediately and `fit_oversized_results` never run — so one heavy
    `browse_read` reached the provider intact and the turn came back as a bare
    provider error. The token bar already assumed 128k for the same unknown, so
    the bar showed a denominator that nothing enforced.
    """
    from arcelle_sidecar.provider_api import DEFAULT_PROVIDER_CONTEXT

    assert DEFAULT_PROVIDER_CONTEXT > 0
    # A real budget comes out of it, rather than the None that skips fitting.
    from arcelle_sidecar.compaction import CLOUD_SPEND_FRACTION, fit_budget_bytes

    assert fit_budget_bytes(None, 0, CLOUD_SPEND_FRACTION) is None, (
        "an unknown window still yields no budget — this is the hole"
    )
    budget = fit_budget_bytes(DEFAULT_PROVIDER_CONTEXT, 0, CLOUD_SPEND_FRACTION)
    assert budget is not None and budget > 0


# --- What the user is actually told when a routed backend fails ---------------
#
# OpenRouter does not pass an upstream failure through. It substitutes the fixed
# string "Provider returned error" and files the real cause under `metadata`.
# Reading only `error.message` therefore surfaced the one sentence in the whole
# payload that carries no information, which is what reached the agent's
# failure box verbatim.


def test_an_openrouter_wrapper_error_reveals_the_upstream_reason() -> None:
    payload = {
        "error": {
            "message": "Provider returned error",
            "code": 429,
            "metadata": {
                "provider_name": "OpenAI",
                "raw": json.dumps(
                    {"error": {"message": "Rate limit reached for gpt-4o", "type": "rate_limit"}}
                ),
            },
        }
    }
    text = provider_api._error_message(httpx.Response(429, json=payload))
    assert "Rate limit reached for gpt-4o" in text, "the actual cause must survive"
    assert "OpenAI" in text, "and the backend that produced it"
    assert "429" in text


def test_an_upstream_error_that_is_not_json_is_shown_as_written() -> None:
    payload = {
        "error": {
            "message": "Provider returned error",
            "code": 502,
            "metadata": {"provider_name": "Together", "raw": "upstream connect timeout"},
        }
    }
    text = provider_api._error_message(httpx.Response(502, json=payload))
    assert "upstream connect timeout" in text
    assert "Together" in text


def test_a_moderation_refusal_names_the_categories() -> None:
    payload = {
        "error": {
            "message": "Provider returned error",
            "code": 403,
            "metadata": {"reasons": ["violence", "self-harm"]},
        }
    }
    text = provider_api._error_message(httpx.Response(403, json=payload))
    assert "violence" in text and "self-harm" in text


def test_an_error_with_no_metadata_at_least_gains_its_status_code() -> None:
    # Nothing can be recovered here, but "(HTTP 401)" still separates a rejected
    # key from a rate limit from a dead endpoint — the bare message did not.
    payload = {"error": {"message": "Provider returned error"}}
    text = provider_api._error_message(httpx.Response(401, json=payload))
    assert text == "Provider returned error (HTTP 401)"


def test_a_status_code_already_in_the_message_is_not_repeated() -> None:
    payload = {"error": {"message": "provider returned HTTP 500", "code": 500}}
    text = provider_api._error_message(httpx.Response(500, json=payload))
    assert text.count("500") == 1


def test_a_body_that_is_not_json_still_reports_the_status() -> None:
    text = provider_api._error_message(httpx.Response(503, text="<html>bad gateway</html>"))
    assert text == "provider returned HTTP 503"


def test_a_giant_upstream_error_is_clipped_for_the_failure_box() -> None:
    payload = {
        "error": {
            "message": "Provider returned error",
            "metadata": {"raw": "x" * 5000},
        }
    }
    text = provider_api._error_message(httpx.Response(400, json=payload))
    assert len(text) <= provider_api.MAX_ERROR_DETAIL_CHARS
    assert text.endswith("…")


@pytest.mark.asyncio
async def test_a_streamed_wrapper_error_also_reveals_the_upstream_reason(monkeypatch) -> None:
    # The streaming path had its own copy of the message-only extraction, so
    # fixing the non-streaming one alone would have left every chat turn — the
    # common case — still reporting nothing.
    error = {
        "error": {
            "message": "Provider returned error",
            "code": 400,
            "metadata": {
                "provider_name": "Anthropic",
                "raw": json.dumps({"error": {"message": "max_tokens exceeds model limit"}}),
            },
        }
    }
    body = f"data: {json.dumps(error)}\n\n"

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
    with pytest.raises(provider_api.ProviderApiError, match="max_tokens exceeds model limit"):
        await model.stream([{"role": "user", "content": "hello"}], [], on_delta)


# --- A tool catalog is never silently shrunk ---------------------------------
#
# A 400 used to narrow the catalog to a hardcoded 44-name allowlist. 19 of the
# room's 62 tools were missing from it — every `browse_*` tool among them — so
# the Browser agent's whole catalog vanished on the retry, and agents whose
# tools were only partly listed carried on with a smaller catalog nobody told
# them about. See the note at the top of provider_api.py.


def _four_hundred(monkeypatch, *, body: str = '{"error":{"message":"bad tools"}}'):
    """Make every provider call answer 400, and record what was sent."""
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(400, text=body, headers={"content-type": "application/json"})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        provider_api.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    return sent


def _tool(name: str) -> dict:
    return {
        "type": "function",
        "function": {"name": name, "description": name, "parameters": {"type": "object"}},
    }


@pytest.mark.asyncio
async def test_a_rejected_catalog_is_reported_not_quietly_shrunk(monkeypatch) -> None:
    sent = _four_hundred(monkeypatch)

    async def on_delta(_v: str) -> None:
        pass

    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    tools = [_tool("browse_open"), _tool("open_file"), _tool("web_search")]
    with pytest.raises(provider_api.ProviderApiError) as err:
        await model.stream([{"role": "user", "content": "hi"}], tools, on_delta)

    assert len(sent) == 1, "the catalog must not be re-sent in a mutilated form"
    assert len(sent[0]["tools"]) == 3, "every tool the agent was given was offered"
    text = str(err.value)
    assert "3 tool definitions" in text, text
    assert "different model" in text, "the message has to be actionable"


@pytest.mark.asyncio
async def test_the_browser_agents_catalog_survives_a_rejection(monkeypatch) -> None:
    # The exact shape that used to collapse to nothing: an agent whose tools are
    # ALL browse_*. None were on the allowlist, so the narrowed set was empty,
    # the retry was skipped, and the user saw only "Provider returned error".
    sent = _four_hundred(monkeypatch)

    async def on_delta(_v: str) -> None:
        pass

    browse = [
        _tool(n)
        for n in ("browse_open", "browse_read", "browse_look", "browse_do", "browse_save")
    ]
    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    with pytest.raises(provider_api.ProviderApiError) as err:
        await model.stream([{"role": "user", "content": "hi"}], browse, on_delta)

    assert [t["function"]["name"] for t in sent[0]["tools"]] == [
        "browse_open", "browse_read", "browse_look", "browse_do", "browse_save",
    ]
    assert "browse_open" in str(err.value), "the message names what was offered"


@pytest.mark.asyncio
async def test_a_400_with_no_tools_keeps_the_plain_provider_message(monkeypatch) -> None:
    sent = _four_hundred(monkeypatch, body='{"error":{"message":"context too long"}}')

    async def on_delta(_v: str) -> None:
        pass

    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    with pytest.raises(provider_api.ProviderApiError) as err:
        await model.stream([{"role": "user", "content": "hi"}], [], on_delta)
    assert "context too long" in str(err.value)
    assert "tool definitions" not in str(err.value), "no catalog, no catalog advice"
    assert sent and "tools" not in sent[0]


@pytest.mark.asyncio
async def test_every_tool_in_the_shipped_catalog_reaches_the_provider(monkeypatch) -> None:
    """The seam that had a third, unchecked copy of "the tool list".

    Agent boxes are pinned against the catalog snapshot
    (`test_dataset_build.test_the_catalog_snapshot_covers_every_box`), and the
    snapshot is pinned against Rust. This layer answered to neither: it carried
    its own frozenset, drifted 19 tools behind, and silently dropped whatever it
    did not recognise. Pinning it against the SAME catalog closes the loop, so a
    tool added tomorrow cannot go missing here alone.
    """
    import pathlib

    catalog_path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "devtools" / "dataset" / "tool_catalog.json"
    )
    catalog = json.loads(catalog_path.read_text())
    tools = [_tool(entry["name"]) for entry in catalog]
    assert len(tools) > 50, "sanity: the catalog should be the whole room"

    sent = _four_hundred(monkeypatch)

    async def on_delta(_v: str) -> None:
        pass

    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    with pytest.raises(provider_api.ProviderApiError):
        await model.stream([{"role": "user", "content": "hi"}], tools, on_delta)

    offered = {t["function"]["name"] for t in sent[0]["tools"]}
    missing = {entry["name"] for entry in catalog} - offered
    assert not missing, f"tools never reached the provider: {sorted(missing)}"


# --- Every declared tool call gets a reply -----------------------------------
#
# Live failure, 2026-08-02, Browser agent on OpenRouter routed to Azure:
#   "Provider returned error (HTTP 400) — Azure said: No tool output found for
#    function call call_6_0."
# The page had already been opened and read. `_Round.run` breaks out of the
# call loop on Stop or a cancelled child, so calls declared after the break are
# never answered, and the NEXT request is rejected in full.


def test_a_tool_call_left_unanswered_is_given_a_reply() -> None:
    converted = provider_api._messages_for_api(
        [
            {"role": "user", "content": "open the page"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_6_0", "type": "function",
                     "function": {"name": "browse_open", "arguments": {}}},
                    {"id": "call_6_1", "type": "function",
                     "function": {"name": "browse_read", "arguments": {}}},
                ],
            },
            {"role": "tool", "content": "opened", "tool_name": "browse_open",
             "tool_call_id": "call_6_0"},
        ]
    )
    tool_ids = [m["tool_call_id"] for m in converted if m["role"] == "tool"]
    assert tool_ids == ["call_6_0", "call_6_1"], "the abandoned call needs a reply too"
    filler = next(m for m in converted if m.get("tool_call_id") == "call_6_1")
    assert filler["content"] == provider_api.UNANSWERED_TOOL_NOTE
    assert filler["name"] == "browse_read", "named, so the model knows which tool"


def test_the_exact_live_failure_shape_no_result_at_all() -> None:
    # The harshest version: the round broke before ANY call was answered.
    converted = provider_api._messages_for_api(
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_6_0", "type": "function",
                     "function": {"name": "browse_look", "arguments": {}}},
                ],
            },
        ]
    )
    assert [m["role"] for m in converted] == ["assistant", "tool"]
    assert converted[1]["tool_call_id"] == "call_6_0"


def test_a_fully_answered_round_is_left_exactly_as_it_was() -> None:
    original = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "a", "type": "function",
                 "function": {"name": "open_file", "arguments": {}}},
                {"id": "b", "type": "function",
                 "function": {"name": "search_room", "arguments": {}}},
            ],
        },
        {"role": "tool", "content": "1", "tool_name": "open_file", "tool_call_id": "a"},
        {"role": "tool", "content": "2", "tool_name": "search_room", "tool_call_id": "b"},
        {"role": "user", "content": "thanks"},
    ]
    converted = provider_api._messages_for_api(original)
    assert len(converted) == 4, "no filler where none is needed"
    assert [m["role"] for m in converted] == ["assistant", "tool", "tool", "user"]


def test_a_later_round_is_not_swallowed_by_an_earlier_ones_backfill() -> None:
    # The scan must stop at the first non-tool message, or a second round's
    # assistant turn would be consumed as though it answered the first.
    converted = provider_api._messages_for_api(
        [
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "r1", "type": "function",
                             "function": {"name": "browse_open", "arguments": {}}}]},
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "r2", "type": "function",
                             "function": {"name": "browse_read", "arguments": {}}}]},
        ]
    )
    assert [m["role"] for m in converted] == ["assistant", "tool", "assistant", "tool"]
    assert converted[1]["tool_call_id"] == "r1"
    assert converted[3]["tool_call_id"] == "r2"


# --- Anonymous tool calls ------------------------------------------------------
#
# THE live root cause, 2026-08-02. The graph fires deterministic calls of its own
# (`probe`, `perceive`) which carry no id, because Ollama pairs results to calls
# positionally. An OpenAI-compatible provider pairs by `tool_call_id` alone, so
# the request went out as:
#     assistant[calls:-]  tool[for:browse_snapshot]
# and Azure answered "No tool output found for function call call_7_0" — its own
# index for the call we left anonymous.


def test_a_graph_fired_call_with_no_id_is_still_answerable() -> None:
    converted = provider_api._messages_for_api(
        [
            {"role": "user", "content": "open it"},
            # No "id" — exactly what `ToolCall.to_raw()` emits for a synthesized call.
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"type": "function",
                     "function": {"name": "browse_snapshot", "arguments": {}}}
                ],
            },
            {"role": "tool", "content": "3 controls", "tool_name": "browse_snapshot"},
        ]
    )
    declared = converted[1]["tool_calls"][0]["id"]
    assert declared, "an anonymous call is unanswerable — it must be given an id"
    assert converted[2]["tool_call_id"] == declared, (
        "the result must carry the SAME id, not the tool's name"
    )
    assert converted[2]["tool_call_id"] != "browse_snapshot"


def test_minted_ids_are_stable_across_identical_requests() -> None:
    # A retry, or a re-fit after compaction, must not reshape the conversation.
    convo = [
        {"role": "assistant", "content": "",
         "tool_calls": [{"type": "function",
                         "function": {"name": "browse_look", "arguments": {}}}]},
        {"role": "tool", "content": "ok", "tool_name": "browse_look"},
    ]
    first = provider_api._messages_for_api(convo)
    second = provider_api._messages_for_api(convo)
    assert first[0]["tool_calls"][0]["id"] == second[0]["tool_calls"][0]["id"]


def test_two_anonymous_calls_in_one_turn_get_distinct_ids() -> None:
    converted = provider_api._messages_for_api(
        [
            {"role": "assistant", "content": "",
             "tool_calls": [
                 {"type": "function", "function": {"name": "browse_look", "arguments": {}}},
                 {"type": "function", "function": {"name": "browse_read", "arguments": {}}},
             ]},
            {"role": "tool", "content": "a", "tool_name": "browse_look"},
            {"role": "tool", "content": "b", "tool_name": "browse_read"},
        ]
    )
    ids = [c["id"] for c in converted[0]["tool_calls"]]
    assert len(set(ids)) == 2, ids
    assert [m["tool_call_id"] for m in converted[1:]] == ids


def test_a_real_provider_id_is_never_replaced() -> None:
    converted = provider_api._messages_for_api(
        [
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "call_bgrfaE2GPFMXVjztoqc9MU2j", "type": "function",
                             "function": {"name": "browse_open", "arguments": {}}}]},
            {"role": "tool", "content": "ok", "tool_name": "browse_open",
             "tool_call_id": "call_bgrfaE2GPFMXVjztoqc9MU2j"},
        ]
    )
    assert converted[0]["tool_calls"][0]["id"] == "call_bgrfaE2GPFMXVjztoqc9MU2j"
    assert converted[1]["tool_call_id"] == "call_bgrfaE2GPFMXVjztoqc9MU2j"


def test_the_skeleton_names_shapes_without_leaking_content() -> None:
    skeleton = provider_api._message_skeleton(
        [
            {"role": "system", "content": "SECRET PROMPT"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "x"}]},
            {"role": "tool", "content": "SECRET RESULT", "tool_call_id": "x"},
        ]
    )
    assert skeleton == "system assistant[calls:x] tool[for:x]"
    assert "SECRET" not in skeleton


@pytest.mark.asyncio
async def test_a_one_shot_call_is_cut_to_the_providers_window(monkeypatch) -> None:
    """A handoff summary on a small-window room reached the provider whole.

    The local twin cuts every one of these calls (`chat.ChatModel.generate` →
    `fit_to_window`) and says where it cut; the gateway sent them unbounded, so
    a long conversation came back as a bare provider 400.
    """
    sent: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}}]},
            headers={"content-type": "application/json"},
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        provider_api.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    small = config()
    small.context_window = 8_000
    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", small)
    transcript = "the tide turns at four. " * 40_000  # ~920 KB, far past 8k tokens
    answer = await model.generate(
        [
            {"role": "system", "content": "Summarise the handover."},
            {"role": "user", "content": transcript},
        ]
    )

    assert answer == "ok"
    posted = sum(len(str(m.get("content", ""))) for m in sent["messages"])
    # An 8k window is ~16 KB of text at the cloud spend fraction. The bound is
    # generous rather than exact — the point is that what went out is of that
    # ORDER, not that 23 bytes of system prompt came off a 920 KB turn.
    assert posted < 40_000, f"the turn went out at {posted} bytes"
    # The instruction survives the cut it exists to protect.
    assert sent["messages"][0]["content"] == "Summarise the handover."
    # And the cut says where it cut, rather than handing the model a transcript
    # that simply stops.
    assert "cut here to fit this model's context" in sent["messages"][1]["content"]


@pytest.mark.asyncio
async def test_a_one_shot_call_that_already_fits_is_sent_untouched(monkeypatch) -> None:
    posted: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        posted.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}}]},
            headers={"content-type": "application/json"},
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        provider_api.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    model = provider_api.OpenAICompatibleChatModel("openrouter::vendor/model", config())
    await model.generate([{"role": "user", "content": "who signed the lease?"}])

    assert posted["messages"] == [{"role": "user", "content": "who signed the lease?"}]
