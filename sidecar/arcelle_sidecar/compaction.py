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
from typing import Protocol

from .budget import msg_len
from .messages import Message, user_message

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


def _key(messages: list[Message]) -> str:
    h = hashlib.sha256()
    for m in messages:
        h.update((m.get("role") or "").encode())
        h.update(b"\x00")
        h.update((m.get("content") or "").encode())
        h.update(b"\x01")
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
    older = rest[: len(rest) - len(recent)]
    return head + older, recent


def _chunks(messages: list[Message], limit: int) -> list[list[Message]]:
    out: list[list[Message]] = []
    cur: list[Message] = []
    cur_b = 0
    for m in messages:
        n = msg_len(m)
        if cur and cur_b + n > limit:
            out.append(cur)
            cur, cur_b = [], 0
        cur.append(m)
        cur_b += n
    if cur:
        out.append(cur)
    return out


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
    between becomes one ``user`` message of extracted facts. Role pairing is not
    a concern because whole messages are replaced, never individually dropped:
    an assistant ``tool_calls`` turn and its results either both survive in the
    tail or both fold into the digest.

    Digesting alone cannot always reach the budget, so every exit runs through
    :func:`budget.fit_oversized_results`: the recent tail is kept VERBATIM and
    :func:`_split` always keeps the newest message whole however big it is, so
    one oversized tool result survives this function untouched — and on a cloud
    or CLI engine nothing downstream trims either. See that function for the
    failure it removes.
    """
    from .budget import fit_oversized_results

    def _fit(msgs: list[Message], did: bool) -> tuple[list[Message], bool]:
        out, cut = fit_oversized_results(msgs, budget_bytes, reserved_bytes)
        return out, did or cut

    if budget_bytes is None or not messages:
        return messages, False
    total = sum(msg_len(m) for m in messages) + reserved_bytes
    if total <= budget_bytes or total < MIN_COMPACT_BYTES:
        return _fit(messages, False)

    recent_bytes = max(1, int(budget_bytes * RECENT_SHARE))
    older, recent = _split(messages, recent_bytes)
    system, older_body = older[:1], older[1:]
    if not older_body:
        return _fit(messages, False)

    limit = chunk_bytes or DIGEST_CHUNK_BYTES
    chunks = _chunks(older_body, limit)
    # The LAST chunk is the only partially-filled one, and its contents SHIFT as
    # the turn grows: every round appends an assistant/tool message, the recent
    # tail overflows, and another message slides out of `recent` into `older` —
    # landing in exactly this chunk. Digesting it would therefore miss the cache
    # on every single round, at a full model call each time. Leave it verbatim
    # instead: every digest is then of a FULL chunk on a boundary that never
    # moves, so it is computed once and reused for the life of the session.
    if len(chunks) > 1 and sum(msg_len(m) for m in chunks[-1]) < limit:
        recent = chunks.pop() + recent

    parts: list[str] = []
    failed = 0
    for chunk in chunks:
        key = _key(chunk)
        cached = _cache_get(key)
        if cached is None:
            text = "\n".join(
                f"{m.get('role')}: {m.get('content') or ''}" for m in chunk
            )
            try:
                cached = (await digest(text)).strip()
            except Exception:  # noqa: BLE001 - a failed digest must not fail the turn
                cached = ""
            # A FAILURE IS NOT CACHED. Filing "" under this chunk's hash used to
            # retire that stretch of the conversation permanently — one flaky
            # call and the model never saw those turns again for the rest of the
            # session, with nothing anywhere saying so. Leaving it uncached costs
            # a retry next round, which is what a transient failure deserves.
            if cached:
                _cache_put(key, cached)
        if cached:
            parts.append(cached)
        else:
            failed += 1

    if failed and parts:
        # Some stretches made it and some did not. Say so: an answer built on a
        # transcript with a hole in it should be able to explain the hole.
        parts.append(
            f"[{failed} earlier stretch(es) of this conversation could not be "
            "summarised and are missing from the above]"
        )

    if not parts:
        # Digesting failed outright. Returning the input unchanged is right on a
        # LOCAL room — `trim_messages_to_window` still runs after us and will
        # make it fit. On a cloud or CLI room nothing runs after us, so the
        # oversized-result fit is the whole fallback.
        return _fit(messages, False)

    out = [*system, user_message(DIGEST_HEADER + "\n".join(parts)), *recent]
    return _fit(out, True)


def clear_cache() -> None:
    """Drop the digest cache outright (tests, and a room close).

    The cache is bounded (:data:`_CACHE_MAX_ENTRIES`) so it cannot grow without
    limit on its own; this is the immediate drop for a caller that knows the
    content is finished with.
    """
    _CACHE.clear()


__all__ = [
    "CLOUD_SPEND_FRACTION",
    "DIGEST_PROMPT",
    "MIN_COMPACT_BYTES",
    "RECENT_SHARE",
    "SPEND_FRACTION",
    "clear_cache",
    "compact_to_budget",
    "digest_chunk_bytes",
    "fit_budget_bytes",
]
