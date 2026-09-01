"""OpenAI-compatible message and tool-turn normalization."""

from __future__ import annotations

import json
from typing import Any

from .messages import Message, attach_images

def _pop_pending_call_id(pending: list[tuple[str, str]], name: str) -> str:
    """The id of the outstanding tool call this result answers, or "".

    An OpenAI-compatible provider matches a ``role: "tool"`` message to the
    assistant turn that requested it by ``tool_call_id`` and NOTHING else, so a
    caller that only records the tool's NAME (summarize.py's read_text loop) used
    to send ``tool_call_id: "read_text"`` and have the whole request rejected —
    the file's one-line summary failed, but only on long files, where the model
    asks to read more. The ids are right here in the transcript, so pair them up:
    first outstanding call of that name, else the oldest outstanding call.
    """
    for i, (_id, call_name) in enumerate(pending):
        if call_name == name:
            return pending.pop(i)[0]
    return pending.pop(0)[0] if pending else ""


#: Stands in for a tool result that never arrived. Phrased as something the
#: model can act on — it explains the gap instead of leaving it to guess why a
#: tool it called has said nothing.
UNANSWERED_TOOL_NOTE = "(no result — the assistant stopped before this tool ran)"


def _assistant_tool_calls(item: dict[str, Any]) -> list[dict[str, Any]] | None:
    if item.get("role") != "assistant":
        return None
    calls = item.get("tool_calls")
    return calls if calls else None


def _declared_call_id(call: dict[str, Any]) -> str:
    return str(call.get("id") or "")


def _declared_call_name(call: dict[str, Any]) -> str:
    function = call.get("function") or {}
    return str(function.get("name") or "")


def _declared_tool_calls(calls: list[dict[str, Any]]) -> list[tuple[str, str]]:
    declared: list[tuple[str, str]] = []
    seen: set[str] = set()
    for call in calls:
        call_id = _declared_call_id(call)
        if call_id and call_id not in seen:
            name = _declared_call_name(call)
            declared.append((call_id, name))
            seen.add(call_id)
    return declared


def _following_tool_messages(
    messages: list[dict[str, Any]], index: int
) -> tuple[list[dict[str, Any]], set[str], int]:
    tool_messages: list[dict[str, Any]] = []
    answered: set[str] = set()
    while index < len(messages) and messages[index].get("role") == "tool":
        item = messages[index]
        answered.add(str(item.get("tool_call_id") or ""))
        tool_messages.append(item)
        index += 1
    return tool_messages, answered, index


def _missing_tool_replies(
    declared: list[tuple[str, str]], answered: set[str]
) -> list[dict[str, Any]]:
    fillers: list[dict[str, Any]] = []
    for call_id, name in declared:
        if call_id not in answered:
            filler: dict[str, Any] = {
                "role": "tool",
                "tool_call_id": call_id,
                "content": UNANSWERED_TOOL_NOTE,
            }
            if name:
                filler["name"] = name
            fillers.append(filler)
    return fillers


def _tool_call_group(
    messages: list[dict[str, Any]], index: int, item: dict[str, Any], calls: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    declared = _declared_tool_calls(calls)
    tool_messages, answered, next_index = _following_tool_messages(messages, index + 1)
    return [item, *tool_messages, *_missing_tool_replies(declared, answered)], next_index


def _answer_every_tool_call(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give every declared tool call the reply the protocol requires.

    An OpenAI-compatible provider rejects the WHOLE request when an assistant
    turn declares `tool_calls` and any one of them is not followed by a matching
    `role: "tool"` message. Azure words it "No tool output found for function
    call <id>", and it arrives as a plain 400 — so the turn dies for a reason
    with no visible relation to what the user asked, after the real work is
    already done. Observed live on 2026-08-02: the Browser agent opened the page
    and read its controls, then the next round 400'd.

    The graph leaves one behind legitimately. `_Round.run` walks a round's calls
    one at a time and BREAKS out of the loop when Stop is pressed or a delegated
    child is cancelled; the call it broke on is answered, but every call after it
    in the same assistant turn is declared and never answered. Rather than teach
    each of those exits to backfill, this — the one place that sees the finished
    conversation on its way out — makes the invariant true for all of them.
    """
    out: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        item = messages[index]
        calls = _assistant_tool_calls(item)
        if not calls:
            out.append(item)
            index += 1
            continue
        group, index = _tool_call_group(messages, index, item, calls)
        out.extend(group)
    return out


def _synthetic_call_id(turn: int, index: int) -> str:
    """A stable id for a tool call that arrived without one.

    The graph fires DETERMINISTIC tool calls of its own — `probe` and `perceive`
    build a `ToolCall` directly instead of reading one off the model — and those
    carry no id, because Ollama never needed one: it pairs a result to its call
    positionally. An OpenAI-compatible provider pairs by `tool_call_id` and
    NOTHING else, so an anonymous call is unanswerable by construction and the
    whole request is rejected.

    Observed live 2026-08-02 on the Browser agent: round one paired fine, round
    two was the browse flow's own `browse_snapshot` probe and went out as
    `assistant[calls:-]` followed by `tool[for:browse_snapshot]` — the tool NAME
    standing in for an id. Azure answered "No tool output found for function
    call call_7_0", naming the index IT had assigned to the call we left
    anonymous, which is why the number moved with the conversation length and
    matched nothing anyone could search for.

    Derived from position rather than a counter or a random value so the same
    conversation always produces the same ids — a request that gets retried, or
    re-fitted after compaction, must not change shape underneath the provider.
    """
    return f"call_auto_{turn}_{index}"


def _image_message_content(content: str, images: list[str]) -> list[dict[str, Any]]:
    return [{"type": "text", "text": content}] + [
        {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{image}"},
        }
        for image in images
    ]


def _message_content(role: str, message: Message) -> str | list[dict[str, Any]]:
    content = message.get("content", "") or ""
    if role != "user":
        return content
    images = message.get("images") or []
    if not images:
        return content
    return _image_message_content(content, images)


def _tool_arguments(function: dict[str, Any]) -> str:
    arguments = function.get("arguments", "{}")
    if isinstance(arguments, str):
        return arguments
    return json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))


def _tool_call_id(call: dict[str, Any], turn: int, index: int) -> str:
    return str(call.get("id") or "") or _synthetic_call_id(turn, index)


def _add_assistant_tool_calls(
    item: dict[str, Any], message: Message, turn: int, pending: list[tuple[str, str]]
) -> None:
    calls = message["tool_calls"]
    normalized_calls: list[dict[str, Any]] = []
    for index, call in enumerate(calls):
        normalized = dict(call)
        function = dict(normalized.get("function") or {})
        function["arguments"] = _tool_arguments(function)
        normalized["function"] = function
        # An anonymous call cannot be answered — see `_synthetic_call_id`.
        # Minted HERE rather than left to the tool message to guess, so both
        # halves of the pair agree.
        call_id = _tool_call_id(normalized, turn, index)
        normalized["id"] = call_id
        normalized_calls.append(normalized)
        pending.append((call_id, str(function.get("name") or "")))
    item["tool_calls"] = normalized_calls


def _tool_result_id(given: str, pending: list[tuple[str, str]], name: str) -> str:
    if given:
        return given
    return _pop_pending_call_id(pending, name) or name or "tool"


def _discard_answered_call(pending: list[tuple[str, str]], call_id: str) -> None:
    if not call_id:
        return
    pending[:] = [call for call in pending if call[0] != call_id]


def _add_tool_response_fields(item: dict[str, Any], message: Message, pending: list[tuple[str, str]]) -> None:
    name = str(message.get("tool_name") or "")
    given = str(message.get("tool_call_id") or "")
    _discard_answered_call(pending, given)
    item["tool_call_id"] = _tool_result_id(given, pending, name)
    if name:
        item["name"] = name


def _add_role_fields(
    item: dict[str, Any], role: str, message: Message, turn: int, pending: list[tuple[str, str]]
) -> None:
    if role == "assistant" and message.get("tool_calls"):
        _add_assistant_tool_calls(item, message, turn, pending)
    if role == "tool":
        _add_tool_response_fields(item, message, pending)


def _messages_for_api(messages: list[Message], images: list[str] | None = None) -> list[dict[str, Any]]:
    source = attach_images(messages, images)
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    for turn, message in enumerate(source):
        role = str(message.get("role") or "user")
        item: dict[str, Any] = {"role": role, "content": _message_content(role, message)}
        _add_role_fields(item, role, message, turn, pending)
        out.append(item)
    return _answer_every_tool_call(out)


#: How much of an upstream provider's own error text to keep. Long enough for a
#: real reason (a rate-limit notice, a rejected parameter, a content-policy
#: verdict), short enough that the failure box stays readable.
