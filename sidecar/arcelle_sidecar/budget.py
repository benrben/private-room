"""Byte accounting, and the last-resort fit to a LOCAL model's window.

Arcelle imposes no app-level context budget: the selected provider/model is the
context authority, and a cloud or API model is never touched here. What remains
is the one case where "the model decides" is not available — a LOCAL Ollama
call, where the app itself chooses ``num_ctx`` (``model_limits.pick_num_ctx``)
and the daemon's answer to an oversized prompt is to silently context-shift the
FRONT of it away: the system prompt, the tool doctrine and the question itself.

So when a payload does not fit the window that was actually requested, we shrink
it OURSELVES, oldest-tool-result first and with a visible marker, keeping the
system prompt and the assistant/tool role pairing intact. Only when cutting
every tool result still leaves the request oversized does a user turn lose
anything, and then it keeps its head AND its tail so the question survives. The
trim is deliberate and legible; the daemon's is neither.
"""

from __future__ import annotations

import json
from typing import Any

from .messages import Message, compact_json

#: A tool result shorter than this isn't worth stubbing (the stub is ~50 bytes).
_MIN_STUB_LEN: int = 80

#: The least a USER turn may be cut to, and the smallest one worth cutting.
#: :data:`_MIN_STUB_LEN` is sized for a tool result whose marker only has to say
#: it was there; a user turn is the QUESTION, and its marker alone is 62 bytes —
#: an 80-byte share spends three quarters of itself announcing the cut and
#: leaves about 14 bytes of the attachment and 4 of the question, which is not a
#: cut, it is a deletion. Sized so the tail share (:data:`_USER_TAIL_SHARE`)
#: still carries a whole "Question: …" line out the other side.
_MIN_USER_KEEP: int = 2_000

#: Byte-equivalent prompt cost of ONE attached image. An image does not ride the
#: text context as base64 — the vision encoder charges roughly 1.5k tokens for
#: the models this app ships, which at the cold-start bytes-per-token is this
#: many bytes of text. Counted so a picture is never free: a screenshot on top
#: of a normal turn used to size the window as if only the prose were there, and
#: the daemon's answer to the overflow is to drop the system prompt and the
#: question.
IMAGE_BYTES: int = 4_500

#: How much of a cut USER turn is kept as its TAIL rather than its head. The
#: host composes the question LAST — room context, then the attached file text,
#: then "Question: …" (agent.rs) — so a head-only cut throws away the very thing
#: being asked, which is the failure this cut exists to prevent.
_USER_TAIL_SHARE: float = 0.25

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


def byte_len(s: str) -> int:
    """UTF-8 byte length.

    The Rust counts ``String::len()`` — which is BYTES, not codepoints
    (agent.rs:1145 ``m.content.len()``). Python ``len(str)`` counts codepoints,
    so a Hebrew/CJK tool result would be measured at ~half the byte cost the Rust
    sees and slip past the budget the exact rooms this app ships for overflow on.
    Count bytes so the arithmetic matches the Rust byte for byte.
    """
    return len(s.encode("utf-8"))


def msg_len(m: Message) -> int:
    """What this message costs the prompt, in bytes.

    ``len(content) + len(json(tool_calls))`` — the Rust's ``msg_len`` closure,
    in BYTES to match ``String::len()`` in agent.rs:1145 — plus
    :data:`IMAGE_BYTES` per attached image, because an image is a real prompt
    cost that no byte of ``content`` accounts for. The Rust twin
    (``token_usage.rs``) counts text only, and that is right there: it serves
    the external-CLI engines, which are never handed images.
    """
    n = byte_len(m.get("content") or "")
    tool_calls = m.get("tool_calls")
    if tool_calls is not None:
        n += byte_len(compact_json(tool_calls))
    images = m.get("images")
    if images:
        n += IMAGE_BYTES * len(images)
    return n


def total_chars(messages: list[Message], tools_chars: int) -> int:
    return tools_chars + sum(msg_len(m) for m in messages)


def json_chars(value: Any) -> int:
    """Byte cost of a JSON value as the model will see it (compact, like serde).

    Bytes, not codepoints — the Rust measures ``tools.to_string().len()``
    (agent.rs:1347), which is the UTF-8 byte length.
    """
    return byte_len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


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


def truncate_bytes(s: str, limit: int) -> str:
    """Head of ``s`` within ``limit`` UTF-8 bytes, cut on a codepoint boundary."""
    raw = s.encode("utf-8")
    if len(raw) <= limit:
        return s
    return raw[:limit].decode("utf-8", "ignore")


def tail_bytes(s: str, limit: int) -> str:
    """Tail of ``s`` within ``limit`` UTF-8 bytes, cut on a codepoint boundary."""
    raw = s.encode("utf-8")
    if len(raw) <= limit:
        return s
    return raw[len(raw) - limit :].decode("utf-8", "ignore")


def _cut_tool(content: str, label: str, limit: int) -> str:
    """A tool result cut to ``limit`` bytes, keeping its HEAD, with a marker."""
    note = f"\n… [{label} result cut here to fit this model's context]"
    return truncate_bytes(content, max(0, limit - byte_len(note))) + note


def _cut_user(content: str, limit: int) -> str:
    """A user turn cut to ``limit`` bytes, keeping its head AND its tail.

    Head-only is wrong here: the host folds an attached file's whole text into
    the turn and puts "Question: …" after it, so cutting the tail deletes the
    question — exactly what the daemon does to an oversized prompt, and the
    reason this cut exists.
    """
    note = "\n… [attached text cut here to fit this model's context] …\n"
    room = max(0, limit - byte_len(note))
    tail = int(room * _USER_TAIL_SHARE)
    return truncate_bytes(content, room - tail) + note + tail_bytes(content, tail)


def _cuttable(messages: list[Message], role: str, min_len: int = _MIN_STUB_LEN) -> list[int]:
    """Indices of ``role`` messages big enough to be worth cutting.

    ``min_len`` is that threshold, and it is the same number as the floor the
    cut itself uses: a message already at or under the floor cannot give
    anything up, so counting it as cuttable would only dilute everyone else's
    share (and make a hopeless cut look affordable).
    """
    return [
        i
        for i, m in enumerate(messages)
        if m.get("role") == role and byte_len(m.get("content") or "") > min_len
    ]


def _share_and_cut(
    messages: list[Message],
    indices: list[int],
    budget: int,
    reserved_bytes: int,
    *,
    floor: int = _MIN_STUB_LEN,
    only_when_it_fits: bool = False,
) -> bool:
    """Cut each of ``indices`` to an equal share of what the rest leaves.

    In place, with a visible marker on every cut. The single implementation both
    fitting routines share, so a local window and a stated remote window can
    never cut by different rules.

    ``floor`` is the least any one of them may be kept at. A share below it is
    the budget saying there is nothing left to share — usually because the parts
    that cannot be cut (the system prompt, the assistant's turns, the tool
    catalog) already fill it — so cutting to the floor cannot bring the payload
    under budget. ``only_when_it_fits`` then declines to cut at all rather than
    pay the loss for a fit that is out of reach.
    """
    if not indices:
        return False
    fixed = total_chars(messages, reserved_bytes) - sum(
        byte_len(messages[i].get("content") or "") for i in indices
    )
    share = (budget - fixed) // len(indices)
    if share < floor:
        if only_when_it_fits:
            return False
        share = floor
    cut = False
    for i in indices:
        m = messages[i]
        content = m.get("content") or ""
        if byte_len(content) <= share:
            continue
        if m.get("role") == "user":
            m["content"] = _cut_user(content, share)
        else:
            m["content"] = _cut_tool(content, str(m.get("tool_name") or "tool"), share)
        cut = True
    return cut


def trim_messages_to_window(
    messages: list[Message], reserved_bytes: int, num_ctx: int | None
) -> bool:
    """Shrink ``messages`` in place until they fit ``num_ctx``. Returns whether
    anything was trimmed.

    ``num_ctx`` None means a non-local model chose its own window — nothing to
    fit, so this is a no-op and a cloud model never loses a byte to us.

    Preserves, always:
      - index 0 (the system message) and every assistant turn,
      - every assistant ``tool_calls`` message (role pairing — an orphaned tool
        result makes Ollama reject the whole request),
      - every message as a message: content is shortened, nothing is dropped.

    Tool results go first, because a tool result is the one thing the assistant
    turn after it already summarised. Three passes, each running only while the
    payload still does not fit:

    1. **Stub** the older results outright (before the last
       :data:`_KEEP_RECENT` messages). Cheapest and least lossy — they have
       already been reasoned over.
    2. **Truncate** what is left, newest results included, to an equal share of
       the remaining budget, keeping each one's HEAD. A single 300 KB
       ``fetch_page`` result is bigger than any window on its own, so pass 1
       cannot reach it and skipping pass 2 would hand the daemon an oversized
       prompt anyway — losing the system prompt and the question instead of the
       tail of one web page.
    3. **Cut the USER turns**, head and tail kept, and never below
       :data:`_MIN_USER_KEEP`. Last, and reluctantly: these are the user's own
       words. But an attached file folds its whole text into the turn with no
       limit upstream, so a single 2 MB attachment leaves nothing else to give —
       and the alternative is not "keep the turn whole", it is the daemon
       dropping the system prompt and the question. Skipped entirely when even
       cutting every one of them to the floor would not fit, because then the
       loss buys nothing: see the call site.

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
        if m.get("role") == "tool" and byte_len(m.get("content") or "") > _MIN_STUB_LEN
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
            m["content"] = truncate_bytes(content, _REPORT_HEAD) + note
            trimmed = True
            continue
        label = m.get("tool_name") or "tool"
        m["content"] = (
            f"[{label} result trimmed to fit this model's context — already used above]"
        )
        trimmed = True

    # Pass 2: share what's left of the budget between the surviving results.
    # Re-checked first: pass 1 stubbing the last candidate can be exactly what
    # made the payload fit, and cutting a result the model has just read when
    # nothing needs cutting is pure loss.
    if total_chars(messages, reserved_bytes) <= budget:
        return trimmed
    if _share_and_cut(messages, _cuttable(messages, "tool"), budget, reserved_bytes):
        trimmed = True

    # Pass 3: the user's own turns, only if the tool results were not enough —
    # and only when cutting them can actually make the payload fit. On a small
    # local window a big inventory-bearing system prompt plus the tool catalog
    # can exceed the budget between them, and then this pass cannot win: the
    # request goes out oversized either way, and the only thing the cut achieves
    # is destroying the question the user just typed. Left whole, the daemon's
    # own context-shift takes the FRONT of the prompt and the question — which
    # is composed LAST — survives it.
    if total_chars(messages, reserved_bytes) <= budget:
        return trimmed
    if _share_and_cut(
        messages,
        _cuttable(messages, "user", _MIN_USER_KEEP),
        budget,
        reserved_bytes,
        floor=_MIN_USER_KEEP,
        only_when_it_fits=True,
    ):
        trimmed = True
    return trimmed


def fit_oversized_results(
    messages: list[Message], budget_bytes: int | None, reserved_bytes: int = 0
) -> tuple[list[Message], bool]:
    """Cut ``messages`` down until it fits ``budget_bytes``. Never mutates.

    The counterpart of :func:`trim_messages_to_window` for the engines that are
    NOT local Ollama, and the one guard that was missing entirely. Every other
    defence has a hole a single big tool result walks straight through:

    * the Rust host clamps nothing at the tool seam,
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

    The same invariants as its local twin, and the same order: tool results
    first, the user's own turns only when cutting every result still leaves the
    request oversized (one 2 MB attachment folded into a question is that case,
    and there the choice is a marked cut or a rejected request). Never the
    system prompt, the assistant's turns or the ``tool_calls`` pairing; a result
    keeps its HEAD, a user turn keeps its head AND its tail — the question is
    composed last — and every cut leaves a visible marker. Reports are cut like
    anything else here: this runs only when the request would otherwise be
    REJECTED, where a trimmed report beats no answer at all.
    """
    if budget_bytes is None or not messages:
        return messages, False
    if total_chars(messages, reserved_bytes) <= budget_bytes:
        return messages, False
    out = [dict(m) for m in messages]
    cut = _share_and_cut(out, _cuttable(out, "tool"), budget_bytes, reserved_bytes)
    if total_chars(out, reserved_bytes) > budget_bytes:
        # Cut here even when the fit is out of reach — this budget is a fraction
        # of a stated window, so a smaller request can still be accepted where
        # the whole one would be rejected — but never below the floor. The
        # question has to survive the cut it exists to prevent.
        cut = (
            _share_and_cut(
                out,
                _cuttable(out, "user", _MIN_USER_KEEP),
                budget_bytes,
                reserved_bytes,
                floor=_MIN_USER_KEEP,
            )
            or cut
        )
    return (out, True) if cut else (messages, False)


def fit_to_window(
    messages: list[Message], num_ctx: int | None, reserved_bytes: int = 0
) -> tuple[list[Message], bool]:
    """Non-mutating fit of a ONE-SHOT call to the local window it requested.

    The streaming agent loop trims itself (:func:`trim_messages_to_window`), but
    the one-shot paths — translate, whole-file summarise, document generation,
    a workflow step — composed their payload, asked
    :func:`.model_limits.pick_num_ctx` for a window and then sent whatever they
    had. A payload bigger than the largest window this Mac may ask for went out
    oversized, and the daemon answers that by deleting the FRONT of the prompt:
    the instruction that says what to do with the text. The result reads
    plausible and is wrong, with nothing anywhere saying so.

    ``num_ctx`` None (a non-local model) is a no-op, as everywhere else.
    """
    if num_ctx is None:
        return messages, False
    return fit_oversized_results(
        messages, window_budget_bytes(num_ctx), reserved_bytes
    )


__all__ = [
    "IMAGE_BYTES",
    "byte_len",
    "fit_oversized_results",
    "fit_to_window",
    "json_chars",
    "msg_len",
    "tail_bytes",
    "total_chars",
    "trim_messages_to_window",
    "truncate_bytes",
    "window_budget_bytes",
]
