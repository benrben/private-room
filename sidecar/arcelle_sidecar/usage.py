"""Token-budget accounting for the chat bar (SPEC: token-budget bar + handoff).

No engine reports usage broken down by prompt content — only an aggregate
input/output total, and only some engines report even that (see
:class:`.chat.RoundUsage`). So the categorized breakdown is always a
char-length estimate: bucket every message's byte length by what it is
(system prompt / conversation history / tool result / skill content / file
read), then — when a real aggregate is known for the round — scale the
estimated shares proportionally so they sum to the real number instead of the
rougher char-based one. `CHARS_PER_TOKEN` mirrors the ratio already
documented at `ollama.rs:273` (`job_context_chars`, "≈3 chars/token — a safe
floor across English and Hebrew"); this module deliberately does not invent a
different one.
"""

from __future__ import annotations

from typing import Any

from .budget import msg_len
from .chat import RoundUsage
from .messages import Message
from .routing import SKILL_TOOL_NAMES

#: chars/token — kept identical to ollama.rs's `job_context_chars` ratio.
CHARS_PER_TOKEN: int = 3

#: The built-in tools whose results are literal file text/excerpts
#: (agent.rs BUILTIN_TOOL_NAMES / room_mcp.rs — "search_room"/"open_file").
FILE_TOOL_NAMES: tuple[str, ...] = ("open_file", "search_room")

#: The 5 fixed breakdown categories, in the same order the frontend legend
#: and segment stack use. Never reordered.
CATEGORIES: tuple[str, ...] = ("system", "history", "tools", "skills", "files")


def categorize_messages(messages: list[Message], tools_chars: int) -> dict[str, int]:
    """Bucket every message's byte length into one of the 5 categories.

    ``tools_chars`` seeds "tools" — the serialized tool-catalog schema actually
    offered THIS round (the tool-less final round offers none, so pass 0 then).
    """
    totals: dict[str, int] = {c: 0 for c in CATEGORIES}
    totals["tools"] += max(tools_chars, 0)
    for m in messages:
        role = m.get("role")
        n = msg_len(m)
        if role == "system":
            totals["system"] += n
        elif role == "tool":
            name = m.get("tool_name") or ""
            if name in SKILL_TOOL_NAMES:
                totals["skills"] += n
            elif name in FILE_TOOL_NAMES:
                totals["files"] += n
            else:
                totals["tools"] += n
        elif role == "user" and m.get("images"):
            totals["files"] += n
        else:
            # user/assistant text — the running conversation.
            totals["history"] += n
    return totals


def build_usage_event(
    round_: int | None, usage: RoundUsage, breakdown_chars: dict[str, int]
) -> dict[str, Any]:
    """The ``AskTokenUsage`` event dict (minus the NDJSON ``"t"`` discriminator).

    ``usage.input_tokens`` — when real — is the round's actual prompt/context
    token count (Ollama's ``prompt_eval_count``), the same thing the char
    breakdown describes; the model's own reply only enters context on the
    NEXT round (once persisted as an assistant message), so it is correctly
    left out of "total tokens consumed so far".
    """
    est_breakdown = {c: max(breakdown_chars.get(c, 0), 0) // CHARS_PER_TOKEN for c in CATEGORIES}
    est_total = sum(est_breakdown.values())
    real_total = usage.input_tokens if usage.is_real else None

    if real_total is not None and est_total > 0:
        breakdown = {
            c: {"tokens": round(v * real_total / est_total), "estimated": True}
            for c, v in est_breakdown.items()
        }
        total_tokens = real_total
        estimated = False
    else:
        breakdown = {c: {"tokens": v, "estimated": True} for c, v in est_breakdown.items()}
        total_tokens = real_total if real_total is not None else est_total
        estimated = real_total is None

    event: dict[str, Any] = {
        "total_tokens": total_tokens,
        "max_context": usage.max_context,
        "estimated": estimated,
        "breakdown": breakdown,
    }
    if round_ is not None:
        event["round"] = round_
    return event


__all__ = ["CHARS_PER_TOKEN", "FILE_TOOL_NAMES", "CATEGORIES", "categorize_messages", "build_usage_event"]
