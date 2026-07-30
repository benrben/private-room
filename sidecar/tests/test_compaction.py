"""Compaction: fit a long conversation by compressing it, not amputating it.

Two measurements, and they say different things — both are guarded here.

AGAINST TRUNCATION, at the same budget (2026-07-28, n=4 paired,
revision-tracking task): compaction scored 0.44 (2B) / 1.00 (32B) against
truncation's 0.25, and a compacted 12 KB tied a raw 176 KB on 19x fewer tokens.
That is the case this module exists for.

AGAINST NOT COMPACTING AT ALL, end to end through the real `/run` (n=4, 2B):
verbatim 0.38, compacted 0.19, paired 1 win / 1 loss / 2 ties. No evidence of
benefit once the payload already fits. So `SPEND_FRACTION` is high and this is
a safety valve — see the constant's own note.
"""

import pytest

from arcelle_sidecar import compaction
from arcelle_sidecar.budget import msg_len
from arcelle_sidecar.compaction import (
    MIN_COMPACT_BYTES,
    compact_to_budget,
    fit_budget_bytes,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    compaction.clear_cache()
    yield
    compaction.clear_cache()


def _convo(n_turns: int, body_bytes: int = 1_200):
    """system + n_turns of user/assistant, each roughly `body_bytes`."""
    msgs = [{"role": "system", "content": "SYSTEM PROMPT"}]
    for i in range(n_turns):
        msgs.append({"role": "user", "content": f"Q{i} " + "x" * body_bytes})
        msgs.append({"role": "assistant", "content": f"A{i} " + "y" * body_bytes})
    return msgs


async def _fake_digest(text: str) -> str:
    """Stands in for the model: reports which turns it saw."""
    ids = [tok for tok in text.split() if tok[:1] in "QA" and tok[1:].isdigit()]
    return "facts: " + ",".join(ids)


async def test_cloud_model_is_never_compacted():
    """`num_ctx` None = the model owns its window. Same contract as the trim."""
    msgs = _convo(40)
    out, did = await compact_to_budget(msgs, fit_budget_bytes(None), _fake_digest)
    assert did is False
    assert out is msgs


async def test_a_payload_that_fits_is_left_alone():
    msgs = _convo(2)
    out, did = await compact_to_budget(msgs, 1_000_000, _fake_digest)
    assert did is False and out is msgs


async def test_tiny_payloads_are_never_compacted():
    """A digest of a two-turn chat is worse than the chat."""
    msgs = _convo(1, body_bytes=100)
    assert sum(msg_len(m) for m in msgs) < MIN_COMPACT_BYTES
    _, did = await compact_to_budget(msgs, 10, _fake_digest)
    assert did is False


async def test_compaction_fits_the_budget_and_keeps_system_and_recent():
    msgs = _convo(60)
    budget = 20_000
    out, did = await compact_to_budget(msgs, budget, _fake_digest)
    assert did is True
    # The system message still leads, untouched.
    assert out[0] == msgs[0]
    # The digest sits immediately after it.
    assert out[1]["role"] == "user" and "supersede" in out[1]["content"]
    # The NEWEST turn survives verbatim — that is what the model is answering.
    assert out[-1]["content"] == msgs[-1]["content"]
    # digest + recent share, PLUS at most one chunk: the trailing partial chunk
    # is deliberately left verbatim so its cache key stops moving (see
    # `test_the_digest_cache_survives_a_growing_turn`). Overshooting by that
    # much is safe because `chat.stream` re-fits `num_ctx` to whatever
    # compaction actually produced, so the window grows to hold it rather than
    # the daemon context-shifting the front of it away.
    from arcelle_sidecar.compaction import DIGEST_CHUNK_BYTES

    assert sum(msg_len(m) for m in out) <= budget * 1.35 + DIGEST_CHUNK_BYTES


async def test_nothing_is_silently_dropped_older_turns_become_facts():
    """The point of the module: old turns are COMPRESSED, not amputated."""
    msgs = _convo(60)
    out, did = await compact_to_budget(msgs, 20_000, _fake_digest)
    assert did is True
    digest = out[1]["content"]
    # Turn 0 is far outside any recent window, and truncation would lose it.
    assert "Q0" in digest and "A0" in digest


async def test_the_input_list_is_not_mutated():
    """`guard_outbound` hands back the CALLER'S list for a local model, so an
    in-place edit here would corrupt the conversation for every later round."""
    msgs = _convo(60)
    before = [dict(m) for m in msgs]
    await compact_to_budget(msgs, 20_000, _fake_digest)
    assert msgs == before


async def test_digests_are_cached_across_calls():
    """A conversation's older half is stable, so it is digested ONCE. Fresh
    digesting cost the 2B ~100 s; without this the turn pays it every round."""
    calls = 0

    async def counting(text: str) -> str:
        nonlocal calls
        calls += 1
        return await _fake_digest(text)

    msgs = _convo(60)
    await compact_to_budget(msgs, 20_000, counting)
    first = calls
    assert first > 1  # a 60-turn conversation needs several chunks
    await compact_to_budget(msgs, 20_000, counting)
    assert calls == first, "the second compaction re-digested instead of reusing"


async def test_a_failing_digest_degrades_to_todays_behaviour():
    """A model error must not fail the turn: fall through, and let the existing
    `trim_messages_to_window` make it fit exactly as it does today."""

    async def boom(text: str) -> str:
        raise RuntimeError("model exploded")

    msgs = _convo(60)
    out, did = await compact_to_budget(msgs, 20_000, boom)
    assert did is False
    assert out is msgs


def test_fit_budget_leaves_headroom_below_the_hard_wall():
    """Engaging exactly AT the wall would mean the digest itself is what pushes
    the payload over it. Some headroom, but not much — compacting a payload
    that fits measured worse than sending it (0.19 vs 0.38, end to end)."""
    from arcelle_sidecar.budget import window_budget_bytes

    full = window_budget_bytes(32_768)
    assert fit_budget_bytes(32_768) < full
    assert fit_budget_bytes(32_768) == pytest.approx(full * compaction.SPEND_FRACTION, rel=0.01)
    assert fit_budget_bytes(None) is None


def test_reserved_bytes_come_off_the_budget():
    """Tool schemas ride the same window; ignoring them re-creates the overflow."""
    assert fit_budget_bytes(32_768, 5_000) == fit_budget_bytes(32_768) - 5_000


# --------------------------------------------------------------------------- #
# Cloud engines
#
# Compaction used to be local-only: `num_ctx` is None for a non-local model and
# `fit_budget_bytes` returned None with it. That left the one engine where every
# byte is BILLED re-sending the whole transcript on every round of every turn.
# --------------------------------------------------------------------------- #


def test_a_cloud_engine_gets_a_far_larger_working_payload() -> None:
    """Same fraction of a window 6x bigger, so the payload is what grows — the
    point is to stop re-sending 200 KB every round, not to ration the model."""
    local = fit_budget_bytes(32_768)
    cloud = fit_budget_bytes(200_000, 0, compaction.CLOUD_SPEND_FRACTION)
    assert cloud > local * 3


def test_compaction_does_not_touch_a_payload_that_fits() -> None:
    """The end-to-end result that set `SPEND_FRACTION`: handing the model the
    conversation verbatim scored 0.38, and compacting the same payload scored
    0.19. Compaction earns its keep only when the payload cannot fit at all, so
    an ordinary turn must pass through untouched."""
    from arcelle_sidecar import model_limits

    model_limits.reset_token_ratio()
    try:
        # The whole hand-off the host now sends (commands::HISTORY_HANDOFF_MAX)
        # must sit comfortably inside the budget for a plain 64k local window.
        assert fit_budget_bytes(65_536) > 200_000 * 0.75
        # And once the engine's own token counts arrive, more so, not less.
        for _ in range(10):
            model_limits.observe_token_ratio(5_890, 1_000)
        assert fit_budget_bytes(65_536) > 200_000
    finally:
        model_limits.reset_token_ratio()


def test_compaction_still_engages_when_the_payload_truly_cannot_fit() -> None:
    """The case it WAS built for, and the one the earlier experiments did
    establish: compressing old turns beats amputating them (0.44 vs 0.25 on the
    2B, 1.00 vs 0.25 on the large model, at the same budget). A small window
    must still reach it."""
    assert fit_budget_bytes(8_192) < 40_000


def test_an_unknown_window_still_means_no_budget_at_all() -> None:
    """The contract that keeps this from ever being a regression: if nobody has
    stated a real window, nothing is compacted and the payload goes out whole."""
    assert fit_budget_bytes(None, 0, compaction.CLOUD_SPEND_FRACTION) is None


def test_a_local_digest_pass_does_not_grow_with_the_window() -> None:
    """The local limit is how much a 2B can faithfully compress in one go, NOT
    how much fits — enlarging the span is exactly how facts get dropped."""
    from arcelle_sidecar.compaction import DIGEST_CHUNK_BYTES, digest_chunk_bytes

    assert digest_chunk_bytes(8_192, cloud=False) == DIGEST_CHUNK_BYTES
    assert digest_chunk_bytes(131_072, cloud=False) == DIGEST_CHUNK_BYTES


def test_a_cloud_digest_pass_scales_so_compaction_is_affordable() -> None:
    """Each cloud pass is a billed request (or a whole CLI process), so the pass
    COUNT is the cost. A 200k-token window must swallow a long conversation in
    one or two passes, not the dozen an 18 KB chunk would need."""
    from arcelle_sidecar.compaction import DIGEST_CHUNK_BYTES, digest_chunk_bytes

    big = digest_chunk_bytes(200_000, cloud=True)
    assert big > DIGEST_CHUNK_BYTES
    assert 200_000 // big <= 2
    # And it is bounded — an advertised 1M window must not make one pass try to
    # read a megabyte of conversation.
    assert digest_chunk_bytes(1_000_000, cloud=True) == compaction.CLOUD_DIGEST_CHUNK_BYTES


async def test_the_chunk_size_is_honoured() -> None:
    """`compact_to_budget` takes the chunk size as an argument now; if it fell
    back to the module default the cloud path would silently cost 10x."""
    calls: list[int] = []

    async def counting(text: str) -> str:
        calls.append(len(text))
        return "fact: 1"

    msgs = _convo(60)
    await compact_to_budget(msgs, 20_000, counting, 0, 200_000)
    assert len(calls) == 1, f"expected one big pass, got {len(calls)}"


async def test_the_digest_cache_survives_a_growing_turn() -> None:
    """The cost of compaction is the number of model calls, and a turn appends
    a message every round. If chunk boundaries moved with the tail, the last
    chunk would re-digest EVERY round — a full model call each time, on the one
    path that was supposed to be paid once. Simulates a turn growing round by
    round and asserts the digest count stops rising."""
    calls = 0

    async def counting(text: str) -> str:
        nonlocal calls
        calls += 1
        return await _fake_digest(text)

    msgs = _convo(60)
    budget = 20_000
    await compact_to_budget(msgs, budget, counting)
    first = calls

    # Five more rounds of the same turn: each appends an assistant + tool pair.
    for r in range(5):
        msgs = msgs + [
            {"role": "assistant", "content": f"R{r} " + "a" * 900},
            {"role": "tool", "content": f"T{r} " + "b" * 900, "tool_name": "search_room"},
        ]
        await compact_to_budget(msgs, budget, counting)

    grew = calls - first
    assert grew <= 1, (
        f"{grew} extra digests over 5 rounds — the chunk boundary is moving "
        "with the tail and the cache is being missed every round"
    )


# --------------------------------------------------------------------------- #
# digesting alone cannot always reach the budget
# --------------------------------------------------------------------------- #


async def test_one_huge_tool_result_cannot_ride_through_compaction():
    """The turn that failed live (2026-07-30, finance.yahoo.com).

    `_split` keeps the newest message whole however big it is — the loop breaks
    on `used + n > recent_bytes and recent`, so the FIRST iteration can never
    break. Digesting the older half then compresses a few hundred bytes of
    prose and leaves a 600 KB `fetch_page` result exactly where it was. On a
    local room `trim_messages_to_window` cleaned up afterwards; on a cloud or
    CLI room nothing did, and the provider rejected the request.
    """
    msgs = [
        {"role": "system", "content": "SYSTEM PROMPT"},
        {"role": "user", "content": "Q0 use the screener and list the first five"},
        {"role": "assistant", "content": "A0 fetching", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "y" * 600_000, "tool_name": "fetch_page"},
    ]
    budget = 60_000
    out, did = await compact_to_budget(msgs, budget, _fake_digest)

    assert did is True
    assert sum(msg_len(m) for m in out) <= budget, (
        "compaction returned a payload the provider will reject — the whole "
        "point of being handed a budget"
    )
    # It is the PAGE that was cut, and the cut says so.
    page = [m for m in out if m.get("tool_name") == "fetch_page"]
    assert page and "cut here" in (page[0].get("content") or "")


async def test_a_huge_result_is_cut_even_when_there_is_nothing_to_digest():
    """No older body to compress — compaction used to return the input
    unchanged here, which on a cloud room is the oversized request itself."""
    msgs = [
        {"role": "system", "content": "SYSTEM PROMPT"},
        {"role": "tool", "content": "z" * 400_000, "tool_name": "browse_read"},
    ]
    out, did = await compact_to_budget(msgs, 30_000, _fake_digest)
    assert did is True
    assert sum(msg_len(m) for m in out) <= 30_000


async def test_a_failed_digest_still_cuts_the_oversized_result():
    """`if not parts` is the digest-failed path. It returned the input as-is on
    the theory that the trimmer runs afterwards — true only on a local room.

    Note what is NOT claimed: that the payload fits. With the digest broken and
    72 KB of prose against a 40 KB budget, nothing fits without amputating the
    user's own turns, which this layer deliberately refuses to do — the same
    invariant `trim_messages_to_window` holds. What it guarantees is that the
    half-megabyte page is no longer part of the request.
    """

    async def broken(_text: str) -> str:
        raise RuntimeError("engine down")

    prose = _convo(30)
    msgs = prose + [
        {"role": "tool", "content": "w" * 500_000, "tool_name": "fetch_page"}
    ]
    out, _did = await compact_to_budget(msgs, 40_000, broken)

    before = sum(msg_len(m) for m in msgs)
    after = sum(msg_len(m) for m in out)
    assert after < before / 5, f"the page is still in the request: {before} -> {after}"
    assert after <= sum(msg_len(m) for m in prose) + 1_000
    assert all(
        msg_len(m) < 10_000 for m in out if m.get("role") == "tool"
    ), "an oversized tool result survived the digest-failed path"
