"""Context budget — keep many tool rounds from silently overflowing num_ctx.

Ported from ``trim_messages_to_budget`` (agent.rs:1144) and ``CTX_CHAR_BUDGET``
(commands.rs:90). When the running message list outgrows the budget, Ollama
quietly drops the *oldest* turns — which is the user's question and the earliest
tool results. So we stub the bulky middle ourselves, deliberately, oldest first,
and keep the parts that carry the answer.

Pure and testable, exactly like the Rust.
"""

from __future__ import annotations

import json
from typing import Any

from .messages import Message, compact_json

#: commands.rs:90 — chars, not tokens: a cheap proxy that never needs a tokenizer.
CTX_CHAR_BUDGET: int = 36_000

#: A tool result shorter than this isn't worth stubbing (the stub is ~50 chars).
_MIN_STUB_LEN: int = 80

#: Never stub the most recent N messages (≈ the last round or two) — they are
#: what the model is actually reasoning over right now.
_KEEP_RECENT: int = 4


def _blen(s: str) -> int:
    """UTF-8 byte length.

    The Rust counts ``String::len()`` — which is BYTES, not codepoints
    (agent.rs:1145 ``m.content.len()``). Python ``len(str)`` counts codepoints,
    so a Hebrew/CJK tool result would be measured at ~half the byte cost the Rust
    sees and slip past the budget the exact rooms this app ships for overflow on.
    Count bytes so the arithmetic matches the Rust byte for byte.
    """
    return len(s.encode("utf-8"))


def msg_len(m: Message) -> int:
    """len(content) + len(json(tool_calls)) — the Rust's ``msg_len`` closure.

    Byte lengths, to match ``String::len()`` in agent.rs:1145.
    """
    n = _blen(m.get("content") or "")
    tool_calls = m.get("tool_calls")
    if tool_calls is not None:
        n += _blen(compact_json(tool_calls))
    return n


def total_chars(messages: list[Message], tools_chars: int) -> int:
    return tools_chars + sum(msg_len(m) for m in messages)


def trim_messages_to_budget(messages: list[Message], tools_chars: int) -> None:
    """Stub older tool results in place until the list fits the budget.

    Preserves, always:
      - index 0 (the system message),
      - the most recent 4 messages,
      - every assistant ``tool_calls`` message (role pairing — an orphaned tool
        result makes Ollama reject the whole request).

    Mutates ``messages``; returns None (same contract as the Rust).
    """
    total = total_chars(messages, tools_chars)
    if total <= CTX_CHAR_BUDGET:
        return
    over = total - CTX_CHAR_BUDGET
    keep_from = max(len(messages) - _KEEP_RECENT, 0)
    for m in messages[1:keep_from]:
        if over == 0:
            break
        content = m.get("content") or ""
        if m.get("role") == "tool" and _blen(content) > _MIN_STUB_LEN:
            label = m.get("tool_name") or "tool"
            stub = f"[{label} result trimmed to fit context — already used above]"
            saved = max(_blen(content) - _blen(stub), 0)
            m["content"] = stub
            over = max(over - saved, 0)


def json_chars(value: Any) -> int:
    """Byte cost of a JSON value as the model will see it (compact, like serde).

    Bytes, not codepoints — the Rust measures ``tools.to_string().len()``
    (agent.rs:1347), which is the UTF-8 byte length.
    """
    return _blen(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


__all__ = [
    "CTX_CHAR_BUDGET",
    "msg_len",
    "total_chars",
    "trim_messages_to_budget",
    "json_chars",
]
