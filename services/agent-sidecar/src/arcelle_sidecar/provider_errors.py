"""Actionable, bounded provider error descriptions."""

from __future__ import annotations

import json
from typing import Any

import httpx

MAX_ERROR_DETAIL_CHARS = 600


def _metadata_raw_value(metadata: dict[str, Any]) -> str:
    raw = metadata.get("raw")
    if isinstance(raw, (dict, list)):
        return json.dumps(raw)
    if isinstance(raw, str):
        return raw.strip()
    return ""


def _nested_error_reason(error: Any) -> str:
    if isinstance(error, dict):
        message = error.get("message")
        return str(message) if message else ""
    if isinstance(error, str):
        return error.strip()
    return ""


def _decoded_upstream_reason(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    reason = _nested_error_reason(value.get("error"))
    if reason:
        return reason
    message = value.get("message")
    return str(message) if message else ""


def _raw_upstream_reason(raw: str) -> str:
    try:
        decoded = json.loads(raw)
    except ValueError:
        return raw
    return _decoded_upstream_reason(decoded) or raw


def _moderation_reason(metadata: dict[str, Any]) -> str:
    reasons = metadata.get("reasons")
    if not isinstance(reasons, list) or not reasons:
        return ""
    return "flagged as " + ", ".join(str(reason) for reason in reasons)


def _upstream_reason(metadata: Any) -> str:
    """The upstream provider's OWN words, dug out of an OpenRouter envelope.

    When a routed backend fails, OpenRouter replaces its message with the fixed
    string "Provider returned error" and files the real cause under
    ``metadata`` — ``raw`` (usually the backend's whole JSON error, as a string)
    and ``provider_name``. Keeping only ``message`` therefore produced a failure
    box that said nothing at all: the one sentence shown to the user was the one
    sentence guaranteed to carry no information.

    ``raw`` is unwrapped one level when it parses as a provider error envelope,
    so the reader gets "Rate limit reached for gpt-4o" rather than a JSON blob.
    """
    if not isinstance(metadata, dict):
        return ""
    raw = _metadata_raw_value(metadata)
    if raw:
        return _raw_upstream_reason(raw)
    # Moderation refusals carry no `raw` — the categories are the whole reason.
    return _moderation_reason(metadata)


def _error_text(value: Any) -> str:
    return str(value or "").strip()


def _error_parts(error: Any) -> tuple[str, Any, Any]:
    if not isinstance(error, dict):
        return _error_text(error), None, None
    return _error_text(error.get("message")), error.get("metadata"), error.get("code")


def _error_tag(code: Any, status: int | None) -> Any:
    if code in (None, ""):
        return status
    return code


def _with_status(head: str, tag: Any) -> str:
    if tag in (None, ""):
        return head
    tag_text = str(tag)
    if tag_text in head:
        return head
    if head:
        return f"{head} (HTTP {tag_text})"
    return f"provider returned HTTP {tag_text}"


def _provider_name(metadata: Any) -> str:
    if not isinstance(metadata, dict):
        return ""
    return _error_text(metadata.get("provider_name"))


def _provider_reason(provider: str, reason: str) -> str:
    if not provider:
        return reason
    return f"{provider} said: {reason}"


def _provider_detail(metadata: Any, head: str) -> str:
    provider = _provider_name(metadata)
    reason = _upstream_reason(metadata)
    if reason:
        return _provider_reason(provider, reason)
    if not provider or provider.lower() in head.lower():
        return ""
    if head:
        return f"upstream provider: {provider}"
    return provider


def _with_provider_detail(head: str, metadata: Any) -> str:
    detail = _provider_detail(metadata, head)
    if not detail:
        return head
    if head:
        return f"{head} — {detail}"
    return detail


def _trim_error_detail(head: str) -> str:
    if len(head) <= MAX_ERROR_DETAIL_CHARS:
        return head
    return head[: MAX_ERROR_DETAIL_CHARS - 1].rstrip() + "…"


def _describe_error(error: Any, status: int | None = None) -> str:
    """One line naming what actually went wrong, for a human reading a failure.

    Assembled as ``message (HTTP code) — Provider said: reason`` so the useful
    part survives even when only some of it is present.
    """
    head, metadata, code = _error_parts(error)
    head = _with_status(head, _error_tag(code, status))
    head = _with_provider_detail(head, metadata)
    head = _trim_error_detail(head)
    return head or "the provider returned an error with no detail"


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, TypeError):
        payload = None
    if isinstance(payload, dict) and payload.get("error") is not None:
        return _describe_error(payload["error"], response.status_code)
    return f"provider returned HTTP {response.status_code}"


def _tool_name(spec: dict[str, Any]) -> str:
    return str((spec.get("function") or {}).get("name") or "")


def _assistant_skeleton(message: dict[str, Any]) -> str:
    calls = message.get("tool_calls")
    if not calls:
        return "assistant"
    ids = ",".join(str(call.get("id") or "-") for call in calls)
    return f"assistant[calls:{ids}]"


def _tool_skeleton(message: dict[str, Any]) -> str:
    return f"tool[for:{message.get('tool_call_id') or '-'}]"


def _message_skeleton_part(message: dict[str, Any]) -> str:
    role = str(message.get("role") or "?")
    if role == "assistant":
        return _assistant_skeleton(message)
    if role == "tool":
        return _tool_skeleton(message)
    return role


def _message_skeleton(messages: list[dict[str, Any]]) -> str:
    """The SHAPE of a request — roles and tool-call ids, never any content.

    A 400 about tool-call pairing ("No tool output found for function call
    <id>") is unanswerable without seeing how the conversation was laid out, and
    the layout is exactly what no log had: the failure named an id that appears
    nowhere a person can look. Content is deliberately excluded (SPEC §6) — the
    pairing is structural, so the skeleton is the whole evidence.
    """
    return " ".join(_message_skeleton_part(message) for message in messages)


def _rejected_catalog_error(response: httpx.Response, tools: list[dict[str, Any]]) -> str:
    """The message for a 400 that arrived with a tool catalog attached.

    Names the model and how many tools it was offered, because the actionable
    fix is almost always "this model's backend does not accept this catalog —
    use another model", and nothing else in the UI says that.
    """
    detail = _error_message(response)
    names = ", ".join(sorted(filter(None, (_tool_name(t) for t in tools)))[:8])
    return (
        f"{detail} — this happened on a request carrying {len(tools)} tool "
        f"definitions ({names}…). If it repeats for every message, the model's "
        f"provider is rejecting this room's tool catalog; choose a different "
        f"model with Tools capability."
    )
