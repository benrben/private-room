"""Fit a long conversation into a window by COMPRESSING it, not amputating it.

The shipped mechanism drops the oldest turns (Rust ``compact_history``) and then
stubs the oldest tool results (:func:`.budget.trim_messages_to_window`). Both are
amputations: the information is gone, and the model answers from a transcript
that silently lost the facts it needed.

Measured 2026-07-28 on a revision-tracking task (four values, each revised 1-3
times, report all four current ones; n=4 paired per cell):

    arm                     qwen3.5:2b   gemma4:cloud
    truncate @ 12,000 B        0.25         0.25
    truncate @ 96,000 B        0.69         0.94
    truncate @ 176,000 B       0.50         1.00
    compact  @ 12,000 B        0.44         1.00

Two things that shaped this module:

* **A small model has an optimum, and past it more context HURTS.** The 2B fell
  0.69 -> 0.50 going from 96 KB to 176 KB (paired: 0 wins, 3 losses, 1 tie).
* **Compaction at a SMALL budget matched truncation at a huge one** (gemma tied
  4/4 at 1.00; the 2B within noise) on 19x fewer prompt tokens. Compression buys
  more than capacity does.

And one thing that re-shaped it afterwards. Both results above compare
compaction against TRUNCATION. Measured end to end against not compacting at
all — the real `/run`, scoring the answer rather than the payload — handing the
model the conversation verbatim beat compacting it, 0.38 to 0.19 (n=4, paired
1/1/2: no evidence of benefit rather than proven harm). So this runs as a
SAFETY VALVE, in place of the amputating trim when a payload cannot fit, and
not on turns that fit. See :data:`SPEND_FRACTION`.

NOT TRIED AGAIN WITHOUT NEW EVIDENCE — a question-directed MAP. Instead of
summarising each chunk blindly, hand each pass the user's actual question and
let it keep only what bears on it, verbatim; the answering round is the reduce.
It is the obvious next idea and it was measured, at equal chunk size, changing
only whether the pass is told the question (2026-07-29, n=4 / n=2 paired):

    arm      qwen3.5:2b   gemma4:cloud
    raw          0.75         1.00
    digest       0.62         0.75
    map          0.31         0.75

Question-direction bought nothing on the large model (+0.00, 0 win/0 loss/2 tie)
and cost a lot on the small one (-0.31, 0/2/2). The likely reason is structural,
not a prompt to tune: deciding WHICH value is current needs every mention in one
ordered view, and chunking is exactly what destroys that. Map-reduce is the right
shape for tasks whose pieces compose (translate, summarise per section, find all
mentions of X) — `file_pass` and `wf_nodes.plan_and_map` already do that — and
the wrong shape for a task that resolves supersession across the whole history.

The digest is cached: producing one costs ~10 model calls, which is only
affordable because a conversation's older half does not change between turns.
Fresh, it cost the 2B ~100 s; amortised over a 20-turn session, ~5 s/turn.
"""

from __future__ import annotations

import hashlib
from typing import Any, Protocol

from .budget import msg_len
from .messages import Message, compact_json, user_message

#: How much of the available context a payload may fill before compaction
#: engages. High on purpose: **compaction is a safety valve, not a policy.**
#:
#: This started at 0.5 on the strength of two experiments that compared
#: compaction against TRUNCATION at the same small budget, where it won
#: decisively (0.44 vs 0.25 on the 2B, 1.00 vs 0.25 on the large model), and a
#: third that measured how many facts survived into the payload, where a
#: compacted transcript scored a perfect 1.00.
#:
#: Then it was measured end to end — the real `/run`, the real model, scoring
#: the ANSWER rather than the payload (n=4, qwen3.5:2b-mlx,
#: `tests/e2e_live/test_live_compaction.py`):
#:
#: ```text
#:   hand over everything, no compaction    0.38
#:   hand over everything + compaction      0.19
#:   truncate at 12,000 B (shipped before)  0.00
#:
#:   hand-off alone   (old -> raw)   +0.38   2 wins / 0 losses / 2 ties
#:   compaction alone (raw -> new)   -0.19   1 win  / 1 loss   / 2 ties
#: ```
#:
#: The hand-off is what won. Compaction, applied to a payload that already
#: FITS, did not help and may have hurt — the paired split is 1/1/2, so the
#: honest reading is "no evidence of benefit", not "proven harm". A plausible
#: mechanism: the digest strips the very cue the model reads the answer off
#: ("revised to X, effective immediately; the earlier figure no longer
#: applies") and leaves a bare list it then picks the wrong entry from.
#:
#: What survives is the case compaction was built for, which the earlier
#: experiments DID establish: when a payload genuinely cannot fit, compressing
#: the older turns beats amputating them. So it now engages only near the wall,
#: in place of `budget.trim_messages_to_window`, and an ordinary turn is sent
#: verbatim.
SPEND_FRACTION: float = 0.9

#: The same fraction for a NON-LOCAL engine.
#:
#: There is a real cost argument for compacting a cloud room aggressively —
#: gemma4 scored 1.00 on a compacted 12 KB transcript and 1.00 on a raw 176 KB
#: one, a 4/4 tie at 19x fewer prompt tokens — and an earlier revision of this
#: file set 0.2 to collect it. It is not enabled, because the only END-TO-END
#: measurement of compaction that exists was run on a local model and came back
#: negative. Trading a cloud room's accuracy for a bill on the strength of a
#: payload-recall proxy is not a trade to make silently.
#:
#: Lower it once there is a cloud e2e arm. The machinery is wired and tested on
#: every cloud path; only this number stands between it and the saving.
CLOUD_SPEND_FRACTION: float = 0.9

#: Never compact below this: a digest of a two-turn conversation is worse than
#: the conversation. Below this size the payload is not the problem.
MIN_COMPACT_BYTES: int = 8_000

#: How much of the budget stays VERBATIM (the recent tail). The rest is digest.
#: The newest turns are what the model is actually reasoning over; summarising
#: them is what makes a compacted transcript feel lobotomised.
RECENT_SHARE: float = 0.5

#: One digest pass reads at most this many bytes. Sized so the pass itself fits
#: a small local window comfortably (~6k tokens at BYTES_PER_TOKEN=3).
DIGEST_CHUNK_BYTES: int = 18_000

#: Ceiling on one CLOUD digest pass. A cloud engine is not pass-limited by
#: comprehension the way a small local model is, so the only thing to optimise
#: is the number of billed calls.
CLOUD_DIGEST_CHUNK_BYTES: int = 200_000

#: Output ceiling for one digest pass.
DIGEST_NUM_PREDICT: int = 400

DIGEST_PROMPT = (
    "Below is part of a conversation. Extract ONLY the durable facts a later "
    "reader would need: every stated value, name, decision, file and outcome, "
    "with what it refers to — one per line. If something was revised, list each "
    "mention IN THE ORDER IT APPEARED so the latest one is last. Do not "
    "summarise the discussion, do not add commentary. Output nothing else."
)

DIGEST_HEADER = (
    "Earlier in this conversation the following was established (later entries "
    "supersede earlier ones):\n"
)


class _Digester(Protocol):
    """The one call compaction needs: text in, factual digest out."""

    async def __call__(self, text: str) -> str: ...


#: Digest cache, keyed by the content hash of the exact messages digested. A
#: conversation's older half is stable across the rounds of a turn AND across
#: turns, so the same chunk is digested once per session rather than per round.
#:
#: BOUNDED, because nothing outside this module clears it: closing a room,
#: switching rooms and deleting the chat all leave every digest of every
#: conversation resident, and each one is a paragraph of the user's own content.
#: Oldest-first eviction keeps the working set (the chunks of the conversation
#: being had right now) and drops the ones a finished room left behind.
_CACHE: dict[str, str] = {}

#: Entries kept before the oldest is evicted. A long conversation contributes
#: one entry per full 18 KB chunk, so this is several very long chats.
_CACHE_MAX_ENTRIES: int = 64


def _cache_get(key: str) -> str | None:
    """The cached digest, moved to the young end so use keeps it alive."""
    value = _CACHE.pop(key, None)
    if value is not None:
        _CACHE[key] = value
    return value


def _cache_put(key: str, digest: str) -> None:
    _CACHE[key] = digest
    while len(_CACHE) > _CACHE_MAX_ENTRIES:
        _CACHE.pop(next(iter(_CACHE)))


def _call_mapping(value: Any) -> dict[str, Any]:
    """Return provider data as a mapping, preserving unknown shapes as empty."""
    return value if isinstance(value, dict) else {}


def _call_name(call: dict[str, Any], function: dict[str, Any]) -> Any:
    """Prefer the nested function name, then legacy provider name fields."""
    return function.get("name") or call.get("name") or "tool"


def _call_arguments(call: dict[str, Any], function: dict[str, Any]) -> Any:
    """Read nested arguments without losing the legacy provider fallback."""
    return function.get("arguments", call.get("arguments"))


def _call_arguments_text(arguments: Any) -> str:
    """Render absent arguments as empty parentheses and structured ones as JSON."""
    if arguments is None or arguments == {} or arguments == "":
        return ""
    return arguments if isinstance(arguments, str) else compact_json(arguments)


def _call_text(raw_call: Any) -> str:
    """Render one provider-shaped call without silently dropping malformed data."""
    call = _call_mapping(raw_call)
    function = _call_mapping(call.get("function"))
    name = _call_name(call, function)
    arguments = _call_arguments_text(_call_arguments(call, function))
    return f"{name}({arguments})"


def _calls_text(tool_calls: list[dict[str, Any]]) -> str:
    """``name(args)`` for each call in a provider-shaped ``tool_calls`` array.

    Shape-tolerant on purpose: the array is echoed back from whichever provider
    produced it, and a call whose shape we do not recognise still has to render
    as SOMETHING — a digest that silently drops a call is the failure this
    function exists to remove.
    """
    return ", ".join(_call_text(call) for call in tool_calls)


def _render(m: Message) -> str:
    """One message as the digest model reads it.

    The MACHINERY is part of the record. An assistant turn that only asked for a
    tool used to render as the bare line ``assistant: `` and its answer as
    ``tool: <content>``, so the digest kept a page of fetched text with nothing
    saying which tool fetched it, with what arguments, or from which URL —
    while :data:`DIGEST_PROMPT` asks for every value "with what it refers to".
    """
    role = m.get("role") or ""
    content = m.get("content") or ""
    if role == "tool":
        return _render_tool_message(m.get("tool_name"), content)
    calls = m.get("tool_calls")
    if calls:
        return _render_call_message(role, content, calls)
    return f"{role}: {content}"


def _render_tool_message(name: object, content: str) -> str:
    return f"tool {name}: {content}" if name else f"tool: {content}"


def _render_call_message(role: str, content: str, calls: list[dict[str, Any]]) -> str:
    called = f"called {_calls_text(calls)}"
    return f"{role}: {content}\n{role}: {called}" if content else f"{role}: {called}"


def _key(messages: list[Message]) -> str:
    h = hashlib.sha256()
    for m in messages:
        h.update((m.get("role") or "").encode())
        h.update(b"\x00")
        h.update((m.get("content") or "").encode())
        h.update(b"\x01")
        # The calls and the tool that answered them are IN the digested text, so
        # two chunks differing only there are different digests — a cache keyed
        # on content alone would hand back the wrong one.
        h.update(compact_json(m.get("tool_calls") or []).encode())
        h.update(b"\x02")
        h.update((m.get("tool_name") or "").encode())
        h.update(b"\x03")
    return h.hexdigest()


def fit_budget_bytes(
    num_ctx: int | None,
    reserved_bytes: int = 0,
    spend: float = SPEND_FRACTION,
) -> int | None:
    """Bytes of one request we are willing to spend for this window.

    ``None`` (no window known) means no budget is imposed — the same contract
    :func:`.budget.trim_messages_to_window` has, so an engine whose window we
    cannot see never loses a byte to us.

    ``spend`` deliberately defaults to less than the whole window. Filling it
    measurably hurt the smallest engine; a cloud engine passes
    :data:`CLOUD_SPEND_FRACTION` instead, which is nearly all of it.

    ``reserved_bytes`` (the serialized tool catalog) is NOT subtracted here.
    Every consumer of this number — :func:`compact_to_budget`,
    :func:`.budget.fit_oversized_results`,
    :func:`.budget.trim_messages_to_window` — is handed the same figure and adds
    it to the PAYLOAD side of the comparison, which is where it is accounted.
    Taking it off here as well charged the catalog twice on all three engines,
    so every room started compacting a few KB earlier than it had to. The
    argument stays in the signature because the three call sites pass it
    positionally alongside the spend fraction.
    """
    if num_ctx is None:
        return None
    from .budget import window_budget_bytes

    return max(0, int(window_budget_bytes(num_ctx) * spend))


def digest_chunk_bytes(window_tokens: int | None, *, cloud: bool) -> int:
    """How much conversation ONE digest pass may read.

    A pass costs a model call, so the pass count IS the cost of compaction. The
    two engines want opposite things and must not share a number:

    * **Local** stays at :data:`DIGEST_CHUNK_BYTES` regardless of window size.
      The limit here is not the window, it is how much a 2B can faithfully
      compress in one go — enlarging the span is precisely how facts get
      dropped, which is the failure this module exists to prevent. Calls are
      free; passes are cheap; keep them small.
    * **Cloud** scales up, because there each pass is a billed request (or, for
      a CLI, a whole process). A 200k-token window swallows a long
      conversation in one or two passes instead of a dozen.
    """
    if not cloud:
        return DIGEST_CHUNK_BYTES
    if not window_tokens:
        return CLOUD_DIGEST_CHUNK_BYTES
    from .budget import window_budget_bytes

    return max(
        DIGEST_CHUNK_BYTES,
        min(CLOUD_DIGEST_CHUNK_BYTES, int(window_budget_bytes(window_tokens) * 0.5)),
    )


def _exchange_start(messages: list[Message], cut: int) -> int:
    """``cut``, moved back off the middle of a tool exchange.

    An assistant ``tool_calls`` turn and the ``role: "tool"`` messages answering
    it are ONE unit. Every boundary here is measured in bytes and lands wherever
    the arithmetic says, so it can fall between the call and its results —
    digesting the call and leaving results that now answer nothing. Ollama and
    the cloud providers reject that shape outright. Stepping back to the call
    keeps them together on the verbatim side, which costs the recent tail one
    small assistant turn.
    """
    while 0 < cut < len(messages) and messages[cut].get("role") == "tool":
        cut -= 1
    return cut


def _split(messages: list[Message], recent_bytes: int) -> tuple[list[Message], list[Message]]:
    """(older, recent). Index 0 (system) always stays out of the digest."""
    head = messages[:1]
    rest = messages[1:]
    recent: list[Message] = []
    used = 0
    for m in reversed(rest):
        n = msg_len(m)
        if used + n > recent_bytes and recent:
            break
        used += n
        recent.append(m)
    recent.reverse()
    cut = _exchange_start(rest, len(rest) - len(recent))
    return head + rest[:cut], rest[cut:]


def _chunks(messages: list[Message], limit: int) -> list[list[Message]]:
    out: list[list[Message]] = []
    cur: list[Message] = []
    cur_b = 0
    for m in messages:
        n = msg_len(m)
        # A tool result never starts a chunk: the last chunk is handed back
        # VERBATIM (see `compact_to_budget`), so a break here would digest the
        # call and keep its results. Letting the group run over `limit` costs
        # one oversized digest pass; breaking it costs a rejected request.
        if cur and cur_b + n > limit and m.get("role") != "tool":
            out.append(cur)
            cur, cur_b = [], 0
        cur.append(m)
        cur_b += n
    if cur:
        out.append(cur)
    return out


def _needs_compaction(
    messages: list[Message], budget_bytes: int, reserved_bytes: int
) -> bool:
    """Whether this payload is large enough to justify a digest."""
    total = sum(msg_len(message) for message in messages) + reserved_bytes
    return total > budget_bytes and total >= MIN_COMPACT_BYTES


def _has_no_compaction_target(
    messages: list[Message], budget_bytes: int | None
) -> bool:
    """Whether a caller supplied no usable payload budget."""
    return budget_bytes is None or not messages


def _fit_compacted_messages(
    messages: list[Message],
    compacted: bool,
    budget_bytes: int,
    reserved_bytes: int,
) -> tuple[list[Message], bool]:
    """Apply the final oversized-result fallback to a compaction outcome."""
    from .budget import fit_oversized_results

    fitted, cut = fit_oversized_results(messages, budget_bytes, reserved_bytes)
    return fitted, compacted or cut


def _digestable_messages(
    messages: list[Message], recent_bytes: int
) -> tuple[list[Message], list[Message], list[Message]]:
    """Return the system turn, digestable older turns, and verbatim recent turns."""
    older, recent = _split(messages, recent_bytes)
    return older[:1], older[1:], recent


def _tail_is_partial(chunks: list[list[Message]], limit: int) -> bool:
    """Whether the moving final digest chunk must stay verbatim."""
    return len(chunks) > 1 and sum(msg_len(message) for message in chunks[-1]) < limit


def _stable_digest_chunks(
    older_body: list[Message], recent: list[Message], limit: int
) -> tuple[list[list[Message]], list[Message]]:
    """Keep the moving partial digest chunk with the verbatim tail."""
    chunks = _chunks(older_body, limit)
    if _tail_is_partial(chunks, limit):
        return chunks[:-1], chunks[-1] + recent
    return chunks, recent


def _digest_chunk_limit(chunk_bytes: int | None) -> int:
    """Use the caller's cloud-sized limit or the local default."""
    return chunk_bytes or DIGEST_CHUNK_BYTES


async def _uncached_digest(key: str, chunk: list[Message], digest: _Digester) -> str:
    """Create and retain one non-empty digest, leaving failures retryable."""
    text = "\n".join(_render(message) for message in chunk)
    try:
        summary = (await digest(text)).strip()
    except Exception:  # noqa: BLE001 - a failed digest must not fail the turn
        return ""
    if summary:
        _cache_put(key, summary)
    return summary


async def _digest_chunk(chunk: list[Message], digest: _Digester) -> str:
    """Read a chunk's cached digest or make one if the cache has no answer."""
    key = _key(chunk)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    return await _uncached_digest(key, chunk, digest)


async def _digest_chunks(
    chunks: list[list[Message]], digest: _Digester
) -> tuple[list[str], int]:
    """Digest every stable chunk and count the stretches that could not be read."""
    parts: list[str] = []
    failed = 0
    for chunk in chunks:
        summary = await _digest_chunk(chunk, digest)
        if summary:
            parts.append(summary)
        else:
            failed += 1
    return parts, failed


def _combined_digest(parts: list[str], failed: int) -> str | None:
    """Join successful digests and visibly account for any failed stretches."""
    if not parts:
        return None
    if failed:
        return "\n".join(
            [
                *parts,
                f"[{failed} earlier stretch(es) of this conversation could not be "
                "summarised and are missing from the above]",
            ]
        )
    return "\n".join(parts)


async def compact_to_budget(
    messages: list[Message],
    budget_bytes: int | None,
    digest: _Digester,
    reserved_bytes: int = 0,
    chunk_bytes: int | None = None,
) -> tuple[list[Message], bool]:
    """Fit ``messages`` into ``budget_bytes`` by digesting the older half.

    Returns ``(messages, compacted)``. The input list is NOT mutated — the
    caller decides whether to adopt the result, and the digest replaces turns
    rather than editing them in place.

    Leaves the system message first and the recent tail verbatim; everything
    between becomes one ``user`` message of extracted facts. Whole messages are
    replaced, never individually dropped, and every boundary between the digest
    and the verbatim part is moved off the middle of a tool exchange
    (:func:`_exchange_start`, :func:`_chunks`), so an assistant ``tool_calls``
    turn and its results either both survive in the tail or both fold into the
    digest — a result whose call has been digested is a request the provider
    rejects.

    Digesting alone cannot always reach the budget, so every exit runs through
    :func:`budget.fit_oversized_results`: the recent tail is kept VERBATIM and
    :func:`_split` always keeps the newest message whole however big it is, so
    one oversized tool result survives this function untouched — and on a cloud
    or CLI engine nothing downstream trims either. See that function for the
    failure it removes.
    """
    if _has_no_compaction_target(messages, budget_bytes):
        return messages, False
    if not _needs_compaction(messages, budget_bytes, reserved_bytes):
        return _fit_compacted_messages(messages, False, budget_bytes, reserved_bytes)

    recent_bytes = max(1, int(budget_bytes * RECENT_SHARE))
    system, older_body, recent = _digestable_messages(messages, recent_bytes)
    if not older_body:
        return _fit_compacted_messages(messages, False, budget_bytes, reserved_bytes)

    limit = _digest_chunk_limit(chunk_bytes)
    # The LAST chunk is the only partially-filled one, and its contents SHIFT as
    # the turn grows: every round appends an assistant/tool message, the recent
    # tail overflows, and another message slides out of `recent` into `older` —
    # landing in exactly this chunk. Digesting it would therefore miss the cache
    # on every single round, at a full model call each time. Leave it verbatim
    # instead: every digest is then of a FULL chunk on a boundary that never
    # moves, so it is computed once and reused for the life of the session.
    chunks, recent = _stable_digest_chunks(older_body, recent, limit)
    parts, failed = await _digest_chunks(chunks, digest)
    combined = _combined_digest(parts, failed)
    if combined is None:
        # Digesting failed outright. Returning the input unchanged is right on a
        # LOCAL room — `trim_messages_to_window` still runs after us and will
        # make it fit. On a cloud or CLI room nothing runs after us, so the
        # oversized-result fit is the whole fallback.
        return _fit_compacted_messages(messages, False, budget_bytes, reserved_bytes)

    out = [*system, user_message(DIGEST_HEADER + combined), *recent]
    return _fit_compacted_messages(out, True, budget_bytes, reserved_bytes)


def clear_cache() -> None:
    """Drop the digest cache outright (tests, and a room close).

    The cache is bounded (:data:`_CACHE_MAX_ENTRIES`) so it cannot grow without
    limit on its own; this is the immediate drop for a caller that knows the
    content is finished with.
    """
    _CACHE.clear()


def cache_size() -> int:
    """How many digests are held. A COUNT — never the digests themselves.

    The host reports "N summaries dropped" when a room locks, and a count is the
    whole of what may leave this process: every value in the cache is boiled-down
    room content.
    """
    return len(_CACHE)


__all__ = [
    "CLOUD_SPEND_FRACTION",
    "DIGEST_PROMPT",
    "cache_size",
    "MIN_COMPACT_BYTES",
    "RECENT_SHARE",
    "SPEND_FRACTION",
    "clear_cache",
    "compact_to_budget",
    "digest_chunk_bytes",
    "fit_budget_bytes",
]
