"""Shared summary-model protocol and structured response call."""

from __future__ import annotations

from typing import Any, Protocol

from .messages import Message, ToolCall
from .model_text import prime_schema, recover_json

class ModelClient(Protocol):
    async def chat_tools(
        self,
        model: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        temperature: float | None,
        num_ctx: int | None,
        keep_alive: str,
    ) -> tuple[str, list[ToolCall]]:
        ...

    async def generate(
        self,
        model: str,
        messages: list[Message],
        *,
        temperature: float | None,
        num_ctx: int | None,
        keep_alive: str,
        format: dict[str, Any] | None = None,  # noqa: A002 - Ollama arg name
    ) -> str:
        ...


async def _chat_structured(
    client: ModelClient,
    model: str,
    messages: list[Message],
    temperature: float | None,
    keep_alive: str,
    schema: dict[str, Any],
) -> str:
    """ollama.rs ``chat_structured``: a one-shot call CONSTRAINED to ``schema`` via
    Ollama ``format`` (grammar token masking), plus the schema appended to the last
    user turn (a small model fills a forced JSON shape with empty strings unless it
    SEES the field names), and ``recover_json`` on the reply.
    """
    primed = prime_schema(messages, schema)
    raw = await client.generate(
        model,
        primed,
        temperature=temperature,
        num_ctx=None,
        keep_alive=keep_alive,
        format=schema,
    )
    return recover_json(raw)
