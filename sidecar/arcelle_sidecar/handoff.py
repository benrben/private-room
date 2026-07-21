"""Context handoff — the chat's "hand off" button.

Summarizes the conversation so far into a compact recap; the recap is
persisted as a `kind='handoff'` marker message (`db::insert_handoff_message`,
`src-tauri/src/db/messages.rs`), and `db::recent_messages` then starts every
future turn's history from that marker — the summary plus whatever comes
after it, not the whole chat. This is the entire mechanism: no separate
"compacted context" state anywhere, just where history reading begins.

Reuses the same one-shot LLM gateway (:func:`.llm.generate`) every other
non-agent feature (summaries, AI actions) rides — it already dispatches to
Ollama or an external CLI based on the model string, so this works on
whichever engine the room is set to with no extra branching.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from .llm import generate
from .messages import Message, system_message, user_message

HANDOFF_SYSTEM_PROMPT = (
    "You are compacting a conversation so it can continue with a much smaller "
    "context window. Write a concise recap covering: decisions already made, "
    "facts established, the user's stated preferences, and any open threads "
    "or unfinished tasks. Write it as prose the assistant itself can read and "
    "continue from — not a transcript, not meta-commentary about summarizing, "
    "and do not address the user directly. This recap becomes the assistant's "
    "own memory of the conversation so far."
)


class HandoffSummaryRequest(BaseModel):
    """Body of ``POST /handoff_summary``."""

    model: str
    base_url: str = "http://127.0.0.1:11434"
    messages: list[Message]
    temperature: float | None = None
    privacy: dict[str, Any] | None = None


def _transcript(messages: list[Message]) -> str:
    """Role-labelled user/assistant turns. Persisted messages are never
    ``role: "tool"`` (that scratchpad never survives a turn), so no
    tool-call noise ever needs filtering out here."""
    lines: list[str] = []
    for m in messages:
        content = m.get("content") or ""
        if not content:
            continue
        role = m.get("role")
        if role == "user":
            lines.append(f"User: {content}")
        elif role == "assistant":
            lines.append(f"Assistant: {content}")
    return "\n\n".join(lines)


async def summarize_for_handoff(req: HandoffSummaryRequest) -> str:
    """The recap text — raises :class:`.llm.LlmError` on engine failure, same
    sentinel contract as every other gateway call."""
    prompt = [
        system_message(HANDOFF_SYSTEM_PROMPT),
        user_message(_transcript(req.messages) or "(nothing said yet)"),
    ]
    return await generate(
        req.model,
        prompt,
        req.base_url,
        temperature=req.temperature,
        privacy=req.privacy,
    )


__all__ = ["HandoffSummaryRequest", "summarize_for_handoff"]
