"""The wire message shape.

Deliberately the same dict the Rust ``ollama::ChatMessage`` serialises to —
``{role, content, tool_calls?, tool_name?, images?}`` — so the two engines can be
diffed line for line and the char-budget arithmetic matches byte for byte. The
LangChain message objects only exist inside :mod:`privateroom_sidecar.chat`,
where they are built right before the model call and thrown away after.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

Role = Literal["system", "user", "assistant", "tool"]


class Message(TypedDict, total=False):
    role: Role
    content: str
    #: assistant only: the raw Ollama-shaped tool_calls array.
    tool_calls: list[dict[str, Any]]
    #: tool only: which tool produced this result.
    tool_name: str
    #: tool only: the id of the call this answers (LangChain needs it).
    tool_call_id: str
    #: user only: base64 PNGs (Ollama reads images from user turns).
    images: list[str]


def compact_json(value: Any) -> str:
    """serde_json's ``to_string`` shape: no spaces, keys as given."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_json(value: Any) -> str:
    """Stable key order, so ``{"a":1,"b":2}`` and ``{"b":2,"a":1}`` are one call.

    Used only for the duplicate-suppression key.
    """
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(slots=True)
class ToolCall:
    """One tool call the model asked for."""

    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    id: str = ""
    #: The provider-shaped call, echoed back verbatim in the assistant message.
    raw: dict[str, Any] = field(default_factory=dict)

    def key(self) -> tuple[str, str]:
        """The duplicate-suppression key: (name, canonical args)."""
        return (self.name, canonical_json(self.arguments))

    def to_raw(self) -> dict[str, Any]:
        if self.raw:
            return self.raw
        call: dict[str, Any] = {
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments},
        }
        if self.id:
            call["id"] = self.id
        return call


def attach_images(messages: list[Message], images: list[str] | None) -> list[dict[str, Any]]:
    """Attach top-level base64 ``images`` to the last user message (non-mutating).

    Ollama reads images only from user turns, so the vision path — which sends the
    image at the request's top level rather than inline on a message — hangs them on
    the last user turn here. Structured/chat callers that already carry images inline
    pass ``images=None`` and get a plain copy. If there is no user turn to attach to,
    a minimal one is appended so the image is never silently dropped.
    """
    msgs: list[dict[str, Any]] = [dict(m) for m in messages]
    if not images:
        return msgs
    for m in reversed(msgs):
        if m.get("role") == "user":
            m["images"] = list(m.get("images") or []) + list(images)
            return msgs
    msgs.append({"role": "user", "content": "", "images": list(images)})
    return msgs


def system_message(content: str) -> Message:
    return {"role": "system", "content": content}


def user_message(content: str, images: list[str] | None = None) -> Message:
    m: Message = {"role": "user", "content": content}
    if images:
        m["images"] = list(images)
    return m


def assistant_message(content: str, tool_calls: list[ToolCall] | None = None) -> Message:
    m: Message = {"role": "assistant", "content": content}
    if tool_calls:
        m["tool_calls"] = [c.to_raw() for c in tool_calls]
    return m


def tool_message(content: str, tool_name: str, tool_call_id: str = "") -> Message:
    m: Message = {"role": "tool", "content": content, "tool_name": tool_name}
    if tool_call_id:
        m["tool_call_id"] = tool_call_id
    return m


__all__ = [
    "Message",
    "Role",
    "ToolCall",
    "compact_json",
    "canonical_json",
    "attach_images",
    "system_message",
    "user_message",
    "assistant_message",
    "tool_message",
]
