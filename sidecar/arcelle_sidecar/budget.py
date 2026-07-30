"""Byte accounting, and the last-resort fit to a LOCAL model's window.

Arcelle imposes no app-level context budget: the selected provider/model is the
context authority, and a cloud or API model is never touched here. What remains
is the one case where "the model decides" is not available — a LOCAL Ollama
call, where the app itself chooses ``num_ctx`` (``model_limits.pick_num_ctx``)
and the daemon's answer to an oversized prompt is to silently context-shift the
FRONT of it away: the system prompt, the tool doctrine and the question itself.

So when a payload does not fit the window that was actually requested, we shrink
it OURSELVES, oldest-tool-result first and with a visible marker, keeping the
system prompt, the recent turns and the assistant/tool role pairing intact. The
trim is deliberate and legible; the daemon's is neither.
"""

from __future__ import annotations

import json
from typing import Any

from .messages import Message, compact_json

#: A tool result shorter than this isn't worth stubbing (the stub is ~50 bytes).
_MIN_STUB_LEN: int = 80

#: How much of a specialist's report survives when even the reports have to be
#: cut. Big enough for the DID/FOUND lines a report contract puts first, which
#: is the part the Main agent actually composes its answer from.
_REPORT_HEAD: int = 600


def _is_report(m: Message) -> bool:
    """Is this tool message a SPECIALIST'S REPORT rather than a tool result?

    The hub's transcript is the only place both kinds coexist, and they are not
    interchangeable: a room-tool result has already been read and summarised by
    the turn after it, while a report is raw answer material that nothing has
    consumed yet. Keyed on the delegation tool names, which only the Main agent
    is ever offered (`agents.AGENT_TOOL_NAMES` + `BATCH_TOOL_NAME`), so a
    worker's own transcript is unaffected.
    """
    name = str(m.get("tool_name") or "")
    return name.startswith("ask_")

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


def json_chars(value: Any) -> int:
    """Byte cost of a JSON value as the model will see it (compact, like serde).

    Bytes, not codepoints — the Rust measures ``tools.to_string().len()``
    (agent.rs:1347), which is the UTF-8 byte length.
    """
    return _blen(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def window_budget_bytes(num_ctx: int) -> int:
    """How many payload BYTES fit the window a local call requested.

    The inverse of ``model_limits.pick_num_ctx``, using the same bytes-per-token
    ratio and reserving the same generation headroom, so the two can never
    disagree about whether a payload fits. That ratio is now measured from the
    engine's own token counts rather than assumed (``model_limits.
    bytes_per_token``), which is what stops ordinary English chat from being
    held to about half the window it has.
    """
    from .model_limits import GENERATION_HEADROOM_TOKENS, bytes_per_token

    return int(max(0, (num_ctx - GENERATION_HEADROOM_TOKENS)) * bytes_per_token())


def _truncate_bytes(s: str, limit: int) -> str:
    """Head of ``s`` within ``limit`` UTF-8 bytes, cut on a codepoint boundary."""
    raw = s.encode("utf-8")
    if len(raw) <= limit:
        return s
    return raw[:limit].decode("utf-8", "ignore")


def trim_messages_to_window(
    messages: list[Message], reserved_bytes: int, num_ctx: int | None
) -> bool:
    """Shrink ``messages`` in place until they fit ``num_ctx``. Returns whether
    anything was trimmed.

    ``num_ctx`` None means a non-local model chose its own window — nothing to
    fit, so this is a no-op and a cloud model never loses a byte to us.

    Preserves, always:
      - index 0 (the system message) and every user/assistant turn,
      - every assistant ``tool_calls`` message (role pairing — an orphaned tool
        result makes Ollama reject the whole request).

    Only ``role: "tool"`` content is touched, because a tool result is the one
    thing the assistant turn after it already summarised. Two passes, because
    one is not enough since the app stopped clamping tool results upstream:

    1. **Stub** the older results outright (before the last
       :data:`_KEEP_RECENT` messages). Cheapest and least lossy — they have
       already been reasoned over.
    2. **Truncate** what is left, newest results included, to an equal share of
       the remaining budget, keeping each one's HEAD. A single 300 KB
       ``fetch_page`` result is bigger than any window on its own, so pass 1
       cannot reach it and skipping pass 2 would hand the daemon an oversized
       prompt anyway — losing the system prompt and the question instead of the
       tail of one web page.

    Every cut leaves a marker, so a short answer is explainable in the
    transcript. The daemon's context-shift leaves nothing.
    """
    if num_ctx is None:
        return False
    budget = window_budget_bytes(num_ctx)
    if total_chars(messages, reserved_bytes) <= budget:
        return False

    trimmed = False
    keep_from = max(len(messages) - _KEEP_RECENT, 0)
    candidates = [
        m
        for m in messages[1:keep_from]
        if m.get("role") == "tool" and _blen(m.get("content") or "") > _MIN_STUB_LEN
    ]
    # Ordinary room-tool results FIRST, specialist reports LAST.
    #
    # The stub note says "already used above", and for a room-tool result that
    # is true — the assistant turn after it summarised what it found. For a
    # REPORT it is false twice over: in the hub thread the turn after a report
    # is the next delegation, and the only turn that consumes reports is the
    # tool-less synthesis that has not happened yet. Stubbing one deletes a part
    # of the user's answer while the agent strip still shows that specialist
    # green. So a report is only trimmed when nothing else is left, and even
    # then pass 2 keeps its head rather than replacing it wholesale.
    for m in sorted(candidates, key=lambda x: _is_report(x)):
        if total_chars(messages, reserved_bytes) <= budget:
            return trimmed
        if _is_report(m):
            # Never blank a report: leave a head so a four-part answer degrades
            # to four partial parts instead of silently losing one.
            content = m.get("content") or ""
            note = "\n… [report cut here to fit this model's context]"
            m["content"] = _truncate_bytes(content, _REPORT_HEAD) + note
            trimmed = True
            continue
        label = m.get("tool_name") or "tool"
        m["content"] = (
            f"[{label} result trimmed to fit this model's context — already used above]"
        )
        trimmed = True

    # Pass 2: share what's left of the budget between the surviving results.
    survivors = [
        m
        for m in messages
        if m.get("role") == "tool" and _blen(m.get("content") or "") > _MIN_STUB_LEN
    ]
    if not survivors:
        return trimmed
    fixed = total_chars(messages, reserved_bytes) - sum(
        _blen(m.get("content") or "") for m in survivors
    )
    share = max(_MIN_STUB_LEN, (budget - fixed) // len(survivors))
    for m in survivors:
        content = m.get("content") or ""
        if _blen(content) <= share:
            continue
        label = m.get("tool_name") or "tool"
        note = f"\n… [{label} result cut here to fit this model's context]"
        m["content"] = _truncate_bytes(content, max(0, share - _blen(note))) + note
        trimmed = True
    return trimmed


def fit_oversized_results(
    messages: list[Message], budget_bytes: int | None, reserved_bytes: int = 0
) -> tuple[list[Message], bool]:
    """Cut tool results until ``messages`` fits ``budget_bytes``. Never mutates.

    The counterpart of :func:`trim_messages_to_window` for the engines that are
    NOT local Ollama, and the one guard that was missing entirely. Every other
    defence has a hole a single big tool result walks straight through:

    * the app clamps nothing (``clamp_tool_result`` is a deliberate no-op),
    * ``trim_messages_to_window`` returns immediately on ``num_ctx is None``,
      which is every cloud and CLI engine, and it is the ONLY caller-side fit —
      ``chat.py`` calls it, ``provider_api.py`` and ``external_llm.py`` do not,
    * compaction digests the OLDER half and leaves the recent tail verbatim,
      and ``compaction._split`` always keeps the newest message whole however
      big it is (``if used + n > recent_bytes and recent``, so the first
      iteration cannot break).

    So one oversized result — a ``fetch_page`` of a heavy site, a 40 KB
    ``browse_read`` on top of the ones before it — reached the provider intact
    and the request was rejected. The worker then returned no report, which
    :func:`graph._run_worker` scores as ``ok=False``: a red "failed" node and a
    Main agent left to improvise about why it could not read the page.

    Deliberately narrow, and the same invariants as its local twin: only
    ``role: "tool"`` content is cut, never the system prompt, the question, the
    assistant's turns or the ``tool_calls`` pairing; each survivor keeps its
    HEAD and an equal share of what the fixed parts leave; every cut leaves a
    visible marker. Reports are cut like anything else here — this runs only
    when the request would otherwise be REJECTED, where a trimmed report beats
    no answer at all.
    """
    if budget_bytes is None or not messages:
        return messages, False
    if total_chars(messages, reserved_bytes) <= budget_bytes:
        return messages, False
    survivors = [
        i
        for i, m in enumerate(messages)
        if m.get("role") == "tool" and _blen(m.get("content") or "") > _MIN_STUB_LEN
    ]
    if not survivors:
        return messages, False
    fixed = total_chars(messages, reserved_bytes) - sum(
        _blen(messages[i].get("content") or "") for i in survivors
    )
    share = max(_MIN_STUB_LEN, (budget_bytes - fixed) // len(survivors))
    out = [dict(m) for m in messages]
    cut = False
    for i in survivors:
        content = out[i].get("content") or ""
        if _blen(content) <= share:
            continue
        label = out[i].get("tool_name") or "tool"
        note = f"\n… [{label} result cut here to fit this model's context]"
        out[i]["content"] = _truncate_bytes(content, max(0, share - _blen(note))) + note
        cut = True
    return (out, True) if cut else (messages, False)


__all__ = [
    "fit_oversized_results",
    "msg_len",
    "total_chars",
    "json_chars",
    "trim_messages_to_window",
    "window_budget_bytes",
]
