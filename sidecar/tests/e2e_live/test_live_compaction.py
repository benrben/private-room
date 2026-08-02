"""Live e2e: the compaction fix, OLD path vs NEW path, through the real /run.

This drives the whole shipped stack — `POST /run` -> graph -> `OllamaChatModel`
-> compaction -> `trim_messages_to_window` -> Ollama — with a real model. It is
the end-to-end check that the change actually helps, not just the unit seam.

THE TWO ARMS (both halves of the fix, as they ship together):

  old   history capped at 12,000 B (the pre-fix Rust `MAX_HISTORY_CHARS`) and
        compaction patched OUT, so only the old amputating trim runs.
  raw   the whole conversation handed over, compaction patched OUT. This arm
        exists because the fix has TWO halves and "new beats old" cannot tell
        you which half did the work — or whether the second half is a cost the
        first one is paying for.
  new   the whole conversation handed over AND compaction live: what ships.

THE TASK: four values, each revised 1-3 times across a long conversation, with
superseded values left in as distractors. The model must report all four CURRENT
values. Score = fraction of 4 correct. This shape was chosen after two earlier
designs ceilinged at 100% and could not discriminate anything.

    ARCELLE_E2E=1 ARCELLE_E2E_MODEL=qwen3.5:2b-mlx \
        uv run pytest tests/e2e_live/test_live_compaction.py -q -s
"""

from __future__ import annotations

import os
import random

import pytest

from arcelle_sidecar import compaction

from .harness import BASE_SYSTEM, RecordingBridge, run_ask, skip_unless_live

skip_unless_live()

QUANTITIES = ["rent", "deposit", "service charge", "parking fee"]
TOPICS = [
    "the lease paperwork", "the parking allocation", "the laundry schedule",
    "the balcony quote", "the renovation noise", "the tax rebate",
    "the boiler contract", "the bicycle store", "the roof survey",
    "the watering rota", "the intercom swap", "the stairwell lighting",
]

#: The pre-fix Rust constant, and the post-fix budget. Both are what the HOST
#: hands the sidecar; the sidecar's own fitting happens downstream.
OLD_HANDOFF_BYTES = 12_000
NEW_HANDOFF_BYTES = 200_000              # commands::HISTORY_HANDOFF_MAX

#: Both arms run under the same whole-ask round ceiling. Without it the OLD arm
#: does not merely score badly, it does not FINISH: starved of the history, the
#: Main agent delegates in circles looking for facts that were amputated before
#: it ever saw them (measured 2026-07-27: 32 rounds, 890 s, 16 delegations,
#: `search_room` x14, final answer "not included in this room's content").
#: Holding it equal for both arms is what makes the comparison a comparison.
TURN_ROUNDS = int(os.environ.get("COMPACT_TURN_ROUNDS", "8"))

QUESTION = (
    "What are the CURRENT monthly rent, deposit, service charge and parking fee? "
    "Answer with four lines, each '<item>: <number>'."
)


def _conversation(rng: random.Random, n_turns: int) -> tuple[list[dict[str, str]], dict[str, int]]:
    schedule: dict[int, list[tuple[str, int, bool]]] = {}
    truth: dict[str, int] = {}
    for q in QUANTITIES:
        n_rev = rng.randint(1, 3)
        slots = sorted(rng.sample(range(4, n_turns - 2), n_rev + 1))
        vals = [rng.randrange(1000, 9999) for _ in range(n_rev + 1)]
        for i, (s, v) in enumerate(zip(slots, vals)):
            schedule.setdefault(s, []).append((q, v, i == 0))
        truth[q] = vals[-1]
    msgs: list[dict[str, str]] = []
    for i in range(n_turns):
        if i in schedule:
            for q, v, first in schedule[i]:
                msgs.append({"role": "user", "content": f"What's the {q}?"})
                msgs.append({
                    "role": "assistant",
                    "content": (f"The {q} is {v} shekels." if first else
                                f"The {q} has been revised to {v} shekels, effective "
                                "immediately. The earlier figure no longer applies."),
                })
        else:
            t = rng.choice(TOPICS)
            msgs.append({"role": "user", "content":
                         f"Turn {i}: where did we land on {t}? "
                         + "Give me the practical next step. " * 5})
            msgs.append({"role": "assistant", "content":
                         f"On {t}: unchanged since we last spoke. "
                         + "The committee wants written confirmation first, and the "
                           "contractor will not schedule without it. " * 7})
    return msgs, truth


def _handoff(msgs: list[dict[str, str]], budget: int) -> list[dict[str, str]]:
    """The host's `compact_history`: newest-first under a BYTE budget."""
    kept, remaining = [], budget
    for m in reversed(msgs):
        n = len(m["content"].encode())
        if n > remaining:
            break
        remaining -= n
        kept.append(m)
    return list(reversed(kept))


def _score(answer: str, truth: dict[str, int]) -> float:
    got = 0
    for q, v in truth.items():
        for line in answer.lower().splitlines():
            if q in line and str(v) in line:
                got += 1
                break
    return got / len(truth)


#: How many independent conversations each arm answers. `test_ranking_summary`
#: below is the one that VERDICTS, over all of them together, so it needs to
#: know how many it should have seen.
TRIALS = int(os.environ.get("COMPACT_TRIALS", "3"))


@pytest.mark.parametrize("trial", range(TRIALS))
async def test_compaction_beats_the_old_truncating_path(trial: int, monkeypatch):
    """The whole fix, end to end: more history handed over AND compacted.

    This test ASSERTS NOTHING about the answers. It runs the three arms on one
    conversation, prints them, and leaves the three scores in `_RESULTS`; the
    verdict is `test_ranking_summary`, over every trial at once, because a
    single live trial on a 2B is far too noisy to carry a threshold.
    """
    rng = random.Random(9000 + trial)
    convo, truth = _conversation(rng, 120)
    compaction.clear_cache()

    # --- OLD: small hand-off, compaction removed from the path entirely.
    # Signature must accept everything `chat.stream` passes POSITIONALLY, or
    # the old arm dies with a TypeError instead of answering badly — which is
    # not a worse score, it is no measurement at all.
    async def _no_compaction(messages, budget_bytes, digest, reserved_bytes=0, chunk_bytes=None):
        return messages, False

    monkeypatch.setattr("arcelle_sidecar.chat.compact_to_budget", _no_compaction)
    old = await run_ask(
        QUESTION, bridge=RecordingBridge(), system=BASE_SYSTEM,
        history=_handoff(convo, OLD_HANDOFF_BYTES), temperature=0.0,
        turn_max_rounds=TURN_ROUNDS, timeout=1800.0,
    )
    # --- RAW: the new hand-off, compaction still out. Isolates the two halves.
    raw = await run_ask(
        QUESTION, bridge=RecordingBridge(), system=BASE_SYSTEM,
        history=_handoff(convo, NEW_HANDOFF_BYTES), temperature=0.0,
        turn_max_rounds=TURN_ROUNDS, timeout=1800.0,
    )
    monkeypatch.undo()

    # --- NEW: the real budget, real compaction.
    compaction.clear_cache()
    new = await run_ask(
        QUESTION, bridge=RecordingBridge(), system=BASE_SYSTEM,
        history=_handoff(convo, NEW_HANDOFF_BYTES), temperature=0.0,
        turn_max_rounds=TURN_ROUNDS, timeout=1800.0,
    )

    # An engine error is DATA, not a test failure: whether the long or the
    # compacted payload is the one that trips Ollama's tool-call template
    # parser is exactly what this run is here to find out. Aborting on the
    # first one would hide which arm it belongs to.
    for name, run in (("old", old), ("raw", raw), ("new", new)):
        for e in run["events"]:
            if e["t"] == "error":
                _ERRORS.append((trial, name, str(e["v"])[:120]))

    s_old = _score(old["final"], truth)
    s_raw = _score(raw["final"], truth)
    s_new = _score(new["final"], truth)
    _RESULTS.append((trial, s_old, s_raw, s_new))
    print(f"\n  trial {trial}: old={s_old:.2f}  raw={s_raw:.2f}  new={s_new:.2f}  truth={truth}")
    print(f"    old answer: {old['final'][:120]!r}")
    print(f"    raw answer: {raw['final'][:120]!r}")
    print(f"    new answer: {new['final'][:120]!r}")
    # Deliberately no per-trial assertion on the answer: one live trial on a 2B
    # is too noisy to carry one, and `test_ranking_summary` judges the aggregate.


_RESULTS: list[tuple[int, float, float, float]] = []
_ERRORS: list[tuple[int, str, str]] = []


def test_ranking_summary():
    """THE verdict: ranks the three paths over every trial above.

    Runs last (collection order) and reads the scores the trials left behind, so
    it is only meaningful on a COMPLETE set — deselecting trials, or running this
    alone, would rank the arms on a sample that never happened. Hence the count
    check rather than a bare non-empty one.
    """
    assert len(_RESULTS) == TRIALS, (
        f"{len(_RESULTS)} of {TRIALS} trials recorded — this is the verdict for the "
        "whole set, so run the parametrised test in the same session without "
        "deselecting any trial"
    )
    n = len(_RESULTS)
    old = sum(r[1] for r in _RESULTS) / n
    raw = sum(r[2] for r in _RESULTS) / n
    new = sum(r[3] for r in _RESULTS) / n

    def paired(a: int, b: int) -> str:
        w = sum(1 for r in _RESULTS if r[b] > r[a])
        l = sum(1 for r in _RESULTS if r[b] < r[a])
        return f"{sum(r[b] - r[a] for r in _RESULTS) / n:+.2f}  ({w}/{l}/{n - w - l})"

    ranked = sorted(
        [("truncate @ 12,000 B (shipped before)", old),
         ("hand over everything, no compaction", raw),
         ("hand over everything + compaction", new)],
        key=lambda t: -t[1],
    )
    print("\n" + "=" * 66)
    print(f"{'RANKING — end-to-end, n=' + str(n):<48}{'score':>10}")
    print("-" * 66)
    for i, (label, score) in enumerate(ranked, 1):
        print(f"{str(i) + '. ' + label:<48}{score:>10.2f}")
    print("-" * 66)
    print(f"{'hand-off alone (old -> raw)':<48}{paired(1, 2):>10}")
    print(f"{'compaction alone (raw -> new)':<48}{paired(2, 3):>10}")
    print(f"{'both together (old -> new)':<48}{paired(1, 3):>10}")
    print("=" * 66)
    if _ERRORS:
        print("\nENGINE ERRORS (arm -> message):")
        for t, arm, msg in _ERRORS:
            print(f"  trial {t}  {arm:<4} {msg}")
    assert new >= old, f"the fix REGRESSED end to end: new {new:.2f} < old {old:.2f}"
