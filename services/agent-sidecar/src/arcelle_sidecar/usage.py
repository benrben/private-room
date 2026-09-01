"""Token-budget accounting for the chat bar (SPEC: token-budget bar + handoff).

No engine reports usage broken down by prompt content — only an aggregate
input/output total, and only some engines report even that (see
:class:`.chat.RoundUsage`). So the categorized breakdown is always a
char-length estimate: bucket every message's byte length by what it is
(system prompt / conversation history / tool result / skill content / file
read), then — when a real aggregate is known for the round — scale the
estimated shares proportionally so they sum to the real number instead of the
rougher char-based one. When no aggregate is known the estimate is all there
is, so it uses the ratio the app has actually MEASURED this session
(:func:`.model_limits.bytes_per_token`) rather than the cold-start constant.
"""

from __future__ import annotations

from typing import Any

from .budget import msg_len
from .chat import RoundUsage
from .messages import Message
from .model_limits import BYTES_PER_TOKEN, bytes_per_token
from .routing import SKILL_TOOL_NAMES

#: bytes/token before anything has been measured — the cold-start floor, kept
#: identical to `token_usage.rs`'s `CHARS_PER_TOKEN` (that module runs this same
#: categorization for the external CLI engines). It is only the FLOOR: measured
#: 2026-07-28, ordinary English prose runs 5.89 B/token, so estimating at a flat
#: 3 told the user they had burned about twice the tokens they had.
CHARS_PER_TOKEN: int = BYTES_PER_TOKEN

#: The built-in tools whose results are literal file text/excerpts
#: (agent.rs BUILTIN_TOOL_NAMES / room_mcp.rs — "search_room"/"open_file").
FILE_TOOL_NAMES: tuple[str, ...] = ("open_file", "search_room")

#: The 5 fixed breakdown categories, in the same order the frontend legend
#: and segment stack use. Never reordered.
CATEGORIES: tuple[str, ...] = ("system", "history", "tools", "skills", "files")


def categorize_messages(messages: list[Message], tools_chars: int) -> dict[str, int]:
    """Bucket every message's byte cost into one of the 5 categories.

    ``tools_chars`` seeds "tools" — the serialized tool-catalog schema actually
    offered THIS round (the tool-less final round offers none, so pass 0 then).

    A picture is charged at :data:`.budget.IMAGE_BYTES` by ``msg_len``, so an
    attached screenshot lands in "files" at what it really costs the prompt.
    Measuring only its caption gave the heaviest turns in the app the smallest
    "files" slice.
    """
    totals: dict[str, int] = {c: 0 for c in CATEGORIES}
    totals["tools"] += max(tools_chars, 0)
    for message in messages:
        _add_message_cost(totals, message, message.get("role"), msg_len(message))
    return totals


def _add_message_cost(
    totals: dict[str, int], message: Message, role: object, cost: int
) -> None:
    """Charge one already-measured message to its fixed usage bucket."""
    totals[_message_category(role, message)] += cost


def _message_category(role: object, message: Message) -> str:
    """Classify system and tool turns before ordinary conversation turns."""
    if role == "system":
        return "system"
    if role == "tool":
        return _tool_result_category(message)
    return _ordinary_message_category(role, message)


def _tool_result_category(message: Message) -> str:
    """Classify a tool result by the kind of prompt material it returns."""
    name = message.get("tool_name") or ""
    if name in SKILL_TOOL_NAMES:
        return "skills"
    return "files" if name in FILE_TOOL_NAMES else "tools"


def _ordinary_message_category(role: object, message: Message) -> str:
    """Charge user attachments as files; all other ordinary turns as history."""
    return "files" if role == "user" and message.get("images") else "history"


def build_usage_event(
    round_: int | None, usage: RoundUsage, breakdown_chars: dict[str, int]
) -> dict[str, Any]:
    """The ``AskTokenUsage`` event dict (minus the NDJSON ``"t"`` discriminator).

    ``usage.input_tokens`` — when real — is the round's actual prompt/context
    token count (Ollama's ``prompt_eval_count``), the same thing the char
    breakdown describes; the model's own reply only enters context on the
    NEXT round (once persisted as an assistant message), so it is correctly
    left out of "total tokens consumed so far".

    The estimate divides by the LIVE bytes-per-token ratio, not by
    :data:`CHARS_PER_TOKEN`. On the rounds where an engine reports no usage the
    estimate is the whole bar, and a flat 3 against the 5.89 the app measured
    for English prose told the user they had spent roughly double.
    """
    estimated_breakdown = _estimated_breakdown(breakdown_chars, bytes_per_token())
    total_tokens, estimated, breakdown = _usage_numbers(usage, estimated_breakdown)
    event = {
        "total_tokens": total_tokens,
        "max_context": usage.max_context,
        "estimated": estimated,
        "breakdown": breakdown,
    }
    return _with_round(event, round_)


def _estimated_breakdown(breakdown_chars: dict[str, int], per_token: float) -> dict[str, int]:
    return {category: int(max(breakdown_chars.get(category, 0), 0) / per_token) for category in CATEGORIES}


def _usage_numbers(
    usage: RoundUsage, estimated_breakdown: dict[str, int]
) -> tuple[int, bool, dict[str, dict[str, int | bool]]]:
    estimated_total = sum(estimated_breakdown.values())
    real_total = usage.input_tokens if usage.is_real else None
    if real_total is not None and estimated_total > 0:
        return real_total, False, _scaled_breakdown(estimated_breakdown, real_total, estimated_total)
    total_tokens = real_total if real_total is not None else estimated_total
    return total_tokens, real_total is None, _estimated_category_breakdown(estimated_breakdown)


def _scaled_breakdown(
    estimated_breakdown: dict[str, int], real_total: int, estimated_total: int
) -> dict[str, dict[str, int | bool]]:
    return {
        category: {"tokens": round(value * real_total / estimated_total), "estimated": True}
        for category, value in estimated_breakdown.items()
    }


def _estimated_category_breakdown(estimated_breakdown: dict[str, int]) -> dict[str, dict[str, int | bool]]:
    return {
        category: {"tokens": value, "estimated": True}
        for category, value in estimated_breakdown.items()
    }


def _with_round(event: dict[str, Any], round_: int | None) -> dict[str, Any]:
    if round_ is not None:
        event["round"] = round_
    return event


__all__ = ["CHARS_PER_TOKEN", "FILE_TOOL_NAMES", "CATEGORIES", "categorize_messages", "build_usage_event"]
