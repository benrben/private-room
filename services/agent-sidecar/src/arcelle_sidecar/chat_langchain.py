"""Conversion between Arcelle messages and LangChain chunks."""

from __future__ import annotations

from functools import partial
from typing import Any

from .messages import Message

def _langchain_content(message: Message) -> Any:
    return message.get("content", "") or ""


def _langchain_system_message(message_type: Any, message: Message) -> Any:
    return message_type(content=_langchain_content(message))


def _langchain_image_blocks(content: Any, images: list[str]) -> list[dict[str, Any]]:
    """Represent Ollama's user-turn images as LangChain data-URI blocks."""
    return [{"type": "text", "text": content}] + [
        {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"}
        for b64 in images
    ]


def _langchain_user_message(message_type: Any, message: Message) -> Any:
    content = _langchain_content(message)
    images = message.get("images") or []
    if images:
        return message_type(content=_langchain_image_blocks(content, images))
    return message_type(content=content)


def _langchain_tool_call(raw_call: dict[str, Any], index: int) -> dict[str, Any]:
    function = raw_call.get("function", {}) if isinstance(raw_call, dict) else {}
    return {
        "name": function.get("name", ""),
        "args": function.get("arguments", {}) or {},
        "id": str(raw_call.get("id") or f"call_{index}"),
        "type": "tool_call",
    }


def _langchain_tool_calls(message: Message) -> list[dict[str, Any]]:
    raw_calls = message.get("tool_calls") or []
    return [_langchain_tool_call(raw_call, index) for index, raw_call in enumerate(raw_calls)]


def _langchain_assistant_message(message_type: Any, message: Message) -> Any:
    return message_type(
        content=_langchain_content(message),
        tool_calls=_langchain_tool_calls(message),
    )


def _langchain_tool_message(message_type: Any, message: Message) -> Any:
    tool_name = message.get("tool_name", "tool")
    return message_type(
        content=_langchain_content(message),
        name=tool_name,
        tool_call_id=message.get("tool_call_id") or tool_name or "tool",
    )


def _to_langchain(messages: list[Message]) -> list[Any]:
    """Ollama-shaped dicts -> LangChain message objects."""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    builders = (
        ("system", partial(_langchain_system_message, SystemMessage)),
        ("user", partial(_langchain_user_message, HumanMessage)),
        ("assistant", partial(_langchain_assistant_message, AIMessage)),
        ("tool", partial(_langchain_tool_message, ToolMessage)),
    )
    out: list[Any] = []
    for message in messages:
        role = message.get("role")
        for expected_role, builder in builders:
            if role == expected_role:
                out.append(builder(message))
                break
    return out


def _text_from_chunk_block(block: Any) -> str:
    """The textual portion of one structured provider content block."""
    if isinstance(block, str):
        return block
    if isinstance(block, dict) and block.get("type") == "text":
        return str(block.get("text", ""))
    return ""


def _chunk_text(content: Any) -> str:
    """A chunk's text, whether the provider sends a str or content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(_text_from_chunk_block(block) for block in content)
    return ""
