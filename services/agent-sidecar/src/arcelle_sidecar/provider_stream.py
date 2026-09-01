"""SSE parsing and completion-response normalization for API providers."""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Optional

import httpx

from .chat import Cancellable, DeltaSink, iter_with_stop
from .messages import ToolCall
from .privacy import PrivacyPolicy
from .provider_core import ProviderApiError, _stall_as_error, provider_timeout_secs
from .provider_errors import (
    _describe_error,
    _error_message,
    _message_skeleton,
    _rejected_catalog_error,
)

_log = logging.getLogger(__name__)

def _sse_data(line: str) -> str | None:
    if not line.startswith("data:"):
        return None
    raw = line[5:].strip()
    return raw if raw and raw != "[DONE]" else None


def _parsed_sse_event(raw: str) -> dict[str, Any] | None:
    try:
        event = json.loads(raw)
    except ValueError:
        return None
    return event if isinstance(event, dict) else None


def _sse_event(line: str) -> dict[str, Any] | None:
    raw = _sse_data(line)
    return _parsed_sse_event(raw) if raw is not None else None


def _raise_sse_error(event: dict[str, Any]) -> None:
    if event.get("error"):
        raise ProviderApiError(_describe_error(event["error"]))


async def _sse_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """The parsed ``data:`` payloads of one streaming response, in order.

    A line that is not valid JSON is SKIPPED, not fatal. Both readers used to
    parse it bare, so one garbled or truncated frame — a dropped byte, a proxy's
    own keep-alive noise — raised out of the middle of the stream and turned the
    half-written answer already on screen into an error. Everything the model
    sent before and after that frame is still good.

    An explicit ``error`` payload is different: that one IS the provider saying
    the turn failed, so it is raised.
    """
    async for line in response.aiter_lines():
        event = _sse_event(line)
        if event is None:
            continue
        _raise_sse_error(event)
        yield event


def _stream_piece_text(piece: Any) -> str:
    return str(piece) if piece else ""


def _merge_stream_piece(current: str, piece: Any) -> str:
    """Merge a streamed id/name fragment without duplicating repeated full values.

    OpenRouter normally sends a function name only once, but some routed
    OpenAI-compatible backends repeat it on later chunks. Blind concatenation
    turned ``write_file`` into ``write_filewrite_file`` and the bridge rejected it.
    """
    incoming = _stream_piece_text(piece)
    if not incoming:
        return current
    if not current or incoming.startswith(current):
        return incoming
    if current.endswith(incoming):
        return current
    return current + incoming


def _stream_call_slot(
    calls_by_index: dict[int, dict[str, Any]], fragment: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    raw_index = fragment.get("index")
    index = raw_index if isinstance(raw_index, int) else 0
    call = calls_by_index.setdefault(index, {"id": "", "name": "", "arguments": ""})
    return index, call


def _append_stream_arguments(current: dict[str, Any], function: dict[str, Any]) -> None:
    arguments = function.get("arguments") or ""
    if isinstance(arguments, str):
        current["arguments"] += arguments
        return
    current["arguments"] += json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))


def _append_stream_tool_fragment(
    calls_by_index: dict[int, dict[str, Any]], fragment: dict[str, Any]
) -> None:
    _index, current = _stream_call_slot(calls_by_index, fragment)
    current["id"] = _merge_stream_piece(current["id"], fragment.get("id"))
    function = fragment.get("function") or {}
    current["name"] = _merge_stream_piece(current["name"], function.get("name"))
    _append_stream_arguments(current, function)


def _append_stream_tool_fragments(
    calls_by_index: dict[int, dict[str, Any]], delta: dict[str, Any]
) -> None:
    for fragment in delta.get("tool_calls") or []:
        _append_stream_tool_fragment(calls_by_index, fragment)


async def _emit_stream_text(
    parts: list[str], restorer: Any, on_delta: DeltaSink, delta: dict[str, Any]
) -> None:
    text = delta.get("content") or ""
    if restorer is not None:
        text = restorer.feed(str(text))
    if not text:
        return
    value = str(text)
    parts.append(value)
    await on_delta(value)


def _stream_input_tokens(event: dict[str, Any], current: int | None) -> int | None:
    return (event.get("usage") or {}).get("prompt_tokens", current)


async def _consume_stream_choice(
    choice: dict[str, Any],
    parts: list[str],
    calls_by_index: dict[int, dict[str, Any]],
    restorer: Any,
    on_delta: DeltaSink,
) -> None:
    delta = choice.get("delta") or {}
    await _emit_stream_text(parts, restorer, on_delta, delta)
    _append_stream_tool_fragments(calls_by_index, delta)


def _cancellable_sse_events(
    response: httpx.Response, cancel: Optional[Cancellable], model: str
) -> AsyncIterator[dict[str, Any]]:
    return _stall_as_error(
        iter_with_stop(_sse_events(response), cancel, provider_timeout_secs()), model
    )


async def _consume_stream_events(
    response: httpx.Response,
    cancel: Optional[Cancellable],
    model: str,
    parts: list[str],
    calls_by_index: dict[int, dict[str, Any]],
    restorer: Any,
    on_delta: DeltaSink,
) -> int | None:
    input_tokens: int | None = None
    async for event in _cancellable_sse_events(response, cancel, model):
        input_tokens = _stream_input_tokens(event, input_tokens)
        for choice in event.get("choices") or []:
            await _consume_stream_choice(choice, parts, calls_by_index, restorer, on_delta)
    return input_tokens


async def _raise_stream_failure(
    response: httpx.Response, payload: dict[str, Any]
) -> None:
    await response.aread()
    if response.status_code == 400 and payload.get("tools"):
        _log.warning(
            "provider rejected a tool request: %s | shape: %s",
            _error_message(response),
            _message_skeleton(payload.get("messages") or []),
        )
        raise ProviderApiError(_rejected_catalog_error(response, payload["tools"]))
    raise ProviderApiError(_error_message(response))


async def _consume_stream_response(
    response: httpx.Response,
    payload: dict[str, Any],
    cancel: Optional[Cancellable],
    model: str,
    parts: list[str],
    calls_by_index: dict[int, dict[str, Any]],
    restorer: Any,
    on_delta: DeltaSink,
) -> int | None:
    if not response.is_success:
        await _raise_stream_failure(response, payload)
    return await _consume_stream_events(
        response, cancel, model, parts, calls_by_index, restorer, on_delta
    )


def _stream_call_arguments(raw_call: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(raw_call["arguments"] or "{}")
    except ValueError:
        return {}


def _finished_stream_call(
    index: int, raw_call: dict[str, Any], engaged: PrivacyPolicy | None
) -> ToolCall | None:
    if not raw_call["name"]:
        return None
    arguments = _stream_call_arguments(raw_call)
    if engaged is not None:
        arguments = engaged.restore_value(arguments)
    call_id = raw_call["id"] or f"call_{index}"
    return ToolCall(
        name=raw_call["name"],
        arguments=arguments,
        id=call_id,
        raw={
            "id": call_id,
            "type": "function",
            "function": {
                "name": raw_call["name"],
                "arguments": raw_call["arguments"] or "{}",
            },
        },
    )


def _finished_stream_calls(
    calls_by_index: dict[int, dict[str, Any]], engaged: PrivacyPolicy | None
) -> list[ToolCall]:
    calls: list[ToolCall] = []
    for index in sorted(calls_by_index):
        call = _finished_stream_call(index, calls_by_index[index], engaged)
        if call is not None:
            calls.append(call)
    return calls


def _structured_output_was_rejected(
    response: httpx.Response, format: dict[str, Any] | None  # noqa: A002
) -> bool:
    """Whether this provider declined the optional strict-response parameter."""
    return response.status_code == 400 and format is not None


async def _post_completion(
    client: httpx.AsyncClient,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    format: dict[str, Any] | None,  # noqa: A002
) -> httpx.Response:
    """Post one completion, retrying once without an unsupported response schema."""
    response = await client.post(endpoint, headers=headers, json=payload)
    if _structured_output_was_rejected(response, format):
        payload.pop("response_format", None)
        response = await client.post(endpoint, headers=headers, json=payload)
    return response


def _completion_data(response: httpx.Response) -> dict[str, Any]:
    """Return successful completion JSON or the provider's useful failure text."""
    if not response.is_success:
        raise ProviderApiError(_error_message(response))
    return response.json()


def _completion_content(data: dict[str, Any]) -> str:
    """Read the first completion choice, keeping the empty-choice contract."""
    choices = data.get("choices") or []
    if not choices:
        raise ProviderApiError("provider returned no completion")
    return _completion_text(choices[0].get("message", {}).get("content", ""))


def _completion_text(content: Any) -> str:
    """Normalize OpenAI's text or typed-content answer shapes to plain text."""
    if isinstance(content, list):
        return _text_content_blocks(content)
    return str(content or "")


def _text_content_blocks(blocks: list[Any]) -> str:
    """Keep text blocks and ignore provider-native non-text content parts."""
    return "".join(
        str(block.get("text", ""))
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text"
    )
