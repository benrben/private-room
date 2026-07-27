"""Parity harness for MIGRATION slice 1 — "Rust drives, Python thinks".

``refine`` and ``plan_and_map`` moved out of ``workflow.rs`` into LangGraph
graphs. The risk of a port like this is not that the answer changes shape — it
is that the MODEL SEES SOMETHING DIFFERENT and nobody notices, because the
artifact still looks plausible. So these tests compare the full PROMPT
TRANSCRIPT of the port against a literal transcription of the Rust arm, both
driven by one scripted model.

``rust_refine`` / ``rust_plan_and_map`` are transcribed from
``src-tauri/src/commands/jobs/workflow.rs`` (the ``NodeKind::Refine`` and
``NodeKind::PlanAndMap`` arms). If a future change touches either Rust arm
without touching these, the transcription is stale — that is the known limit of
this harness and the reason the transcriptions are kept verbatim and short.
"""

from __future__ import annotations

import asyncio

import pytest

from arcelle_sidecar import llm, wf_nodes
from arcelle_sidecar.graph import CancelToken


class Script:
    """Records every prompt it is asked for and replies from a fixed queue."""

    def __init__(self, replies: list[str], delays: dict[int, float] | None = None) -> None:
        self.replies = list(replies)
        self.delays = delays or {}
        self.calls: list[tuple[str, bool]] = []

    async def generate(self, model, messages, base_url, **kw):  # noqa: ANN001
        prompt = messages[-1]["content"]
        self.calls.append((prompt, kw.get("format") is not None))
        delay = self.delays.get(len(self.calls) - 1, 0)
        if delay:
            await asyncio.sleep(delay)
        idx = len(self.calls) - 1
        return self.replies[idx] if idx < len(self.replies) else ""


# --------------------------------------------------------------------------- #
# literal transcriptions of the Rust arms
# --------------------------------------------------------------------------- #


async def rust_refine(script: Script, base: str, rubric: str, max_rounds: int, cancel):
    """workflow.rs ``NodeKind::Refine``."""

    async def wf_generate(prompt: str, fmt=None):  # noqa: ANN001
        if cancel.cancelled:
            raise wf_nodes.Stopped()
        return await script.generate("m", [{"role": "user", "content": prompt}], "u", format=fmt)

    rounds = max(1, min(4, max_rounds))
    draft = await wf_generate(base)
    rub = rubric.strip() or "accurate, complete, and clearly written"
    for _ in range(1, rounds):
        if cancel.cancelled:
            raise wf_nodes.Stopped()
        eval_prompt = (
            f"Judge the draft against this bar: {rub}.\n"
            'Return ONLY JSON {"pass": <bool>, "feedback": <what to fix>}.\n\n'
            f"Draft:\n{draft}"
        )
        raw = await wf_generate(eval_prompt, wf_nodes.REFINE_VERDICT_SCHEMA)
        verdict = wf_nodes._parse_or(raw, {"pass": True, "feedback": ""})
        if wf_nodes._bool_or(verdict, "pass", True):
            break
        feedback = wf_nodes._str_or_empty(verdict, "feedback")
        improve = (
            f"{base}\n\nYour previous draft:\n{draft}\n\n"
            f"Revise it to fix this feedback:\n{feedback}"
        )
        draft = await wf_generate(improve)
    return {"result": draft}


async def rust_plan_and_map(script: Script, obj: str, ctx: str, max_workers: int, cancel):
    """workflow.rs ``NodeKind::PlanAndMap``."""

    async def wf_generate(prompt: str, fmt=None):  # noqa: ANN001
        if cancel.cancelled:
            raise wf_nodes.Stopped()
        return await script.generate("m", [{"role": "user", "content": prompt}], "u", format=fmt)

    width = max(1, min(8, max_workers))
    plan_prompt = (
        f"Break this objective into a short list of independent subtasks (no more "
        f'than {width}). Return ONLY JSON {{"subtasks": ["…"]}}.\n\n'
        f"Objective:\n{obj}\n\nContext:\n{ctx}"
    )
    plan_raw = await wf_generate(plan_prompt, wf_nodes.PLAN_SCHEMA)
    parsed = wf_nodes._parse_or(plan_raw, {"subtasks": []})
    subtasks: list[str] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("subtasks"), list):
        for s in parsed["subtasks"]:
            if isinstance(s, str) and s.strip():
                subtasks.append(s.strip())
            if len(subtasks) == width:
                break
    if not subtasks:
        direct = await wf_generate(f"{obj}\n\nContext:\n{ctx}")
        return {"result": direct}
    worker_results = []
    for st in subtasks:
        if cancel.cancelled:
            raise wf_nodes.Stopped()
        wp = (
            f"Overall objective:\n{obj}\n\nDo ONLY this subtask and return its "
            f"result:\n{st}\n\nContext:\n{ctx}"
        )
        r = await wf_generate(wp)
        worker_results.append(f"### {st}\n\n{r.strip()}")
    synth = (
        "Combine these subtask results into one coherent answer to the "
        f"objective.\n\nObjective:\n{obj}\n\nResults:\n" + "\n\n".join(worker_results)
    )
    return {"result": await wf_generate(synth)}


# --------------------------------------------------------------------------- #
# harness
# --------------------------------------------------------------------------- #


def _deps(script: Script, cancel, monkeypatch, parallel: int = 1) -> wf_nodes.NodeDeps:
    monkeypatch.setattr(llm, "generate", script.generate)
    return wf_nodes.NodeDeps(
        model="m",
        base_url="u",
        keep_alive="5m",
        privacy=None,
        provider=None,
        cancel=cancel,
        parallel=parallel,
    )


REFINE_CASES = [
    ("rounds=1 runs no judge", ["d0"], "", 1),
    ("rounds=0 clamps to 1", ["d0"], "", 0),
    (
        "rounds=9 clamps to 4",
        [
            "d0",
            '{"pass":false,"feedback":"f1"}',
            "d1",
            '{"pass":false,"feedback":"f2"}',
            "d2",
            '{"pass":false,"feedback":"f3"}',
            "d3",
        ],
        "",
        9,
    ),
    ("pass on the first judge stops", ["d0", '{"pass":true,"feedback":""}'], "sharp", 4),
    (
        "fence-wrapped verdict is recovered",
        ["d0", '```json\n{"pass":false,"feedback":"tighten"}\n```', "d1"],
        "",
        2,
    ),
    (
        "think-span verdict is recovered",
        ["d0", '<think>hmm</think>{"pass":false,"feedback":"x"}', "d1"],
        "",
        2,
    ),
    ("unparseable verdict defaults to pass", ["d0", "not json at all"], "", 4),
    (
        'a string "yes" is NOT a bool, so it defaults to pass',
        ["d0", '{"pass":"yes","feedback":"ignored"}'],
        "",
        4,
    ),
    ("an array verdict defaults to pass", ["d0", "[1,2]"], "", 4),
    ("missing feedback becomes an empty string", ["d0", '{"pass":false}', "d1"], "", 2),
    ("a whitespace rubric falls back to the default", ["d0", '{"pass":true}'], "   ", 2),
    (
        "the last revise is returned WITHOUT a re-judge",
        ["d0", '{"pass":false,"feedback":"f1"}', "d1"],
        "",
        2,
    ),
]


@pytest.mark.parametrize(
    "name,replies,rubric,rounds", REFINE_CASES, ids=[c[0] for c in REFINE_CASES]
)
async def test_refine_matches_the_rust_arm(name, replies, rubric, rounds, monkeypatch) -> None:
    rust_script, graph_script = Script(replies), Script(replies)
    monkeypatch.setattr(llm, "generate", rust_script.generate)
    expected = await rust_refine(rust_script, "BASE", rubric, rounds, CancelToken())
    actual = await wf_nodes.run_refine(
        deps=_deps(graph_script, CancelToken(), monkeypatch),
        prompt="BASE",
        rubric=rubric,
        max_rounds=rounds,
    )
    # The transcript is the real assertion: an artifact can match by luck.
    assert graph_script.calls == rust_script.calls
    assert actual == expected


MAP_CASES = [
    ("three subtasks", ['{"subtasks":["a","b","c"]}', "ra", "rb", "rc", "final"], 8),
    ("no subtasks falls back to a direct answer", ['{"subtasks":[]}', "direct"], 4),
    ("an unparseable plan falls back to direct", ["garbage", "direct"], 4),
    ("width clamps how many subtasks are taken", ['{"subtasks":["a","b","c","d"]}', "r1", "r2", "f"], 2),
    (
        "blank and non-string subtasks are dropped",
        ['{"subtasks":["  ","x",7,"  y  "]}', "rx", "ry", "f"],
        8,
    ),
]


@pytest.mark.parametrize("name,replies,workers", MAP_CASES, ids=[c[0] for c in MAP_CASES])
async def test_plan_and_map_matches_the_rust_arm(name, replies, workers, monkeypatch) -> None:
    rust_script, graph_script = Script(replies), Script(replies)
    monkeypatch.setattr(llm, "generate", rust_script.generate)
    expected = await rust_plan_and_map(rust_script, "OBJ", "CTX", workers, CancelToken())
    actual = await wf_nodes.run_plan_and_map(
        deps=_deps(graph_script, CancelToken(), monkeypatch),
        objective="OBJ",
        context="CTX",
        max_workers=workers,
    )
    # Compared as a SET: the fan-out may dispatch workers concurrently, so
    # completion order is not part of the contract. Ordering IS asserted
    # separately, on the synthesis prompt, where it is user-visible.
    assert sorted(graph_script.calls) == sorted(rust_script.calls)
    assert actual == expected


async def test_stop_halts_the_chain_after_the_in_flight_call(monkeypatch) -> None:
    """The hazard this slice had to close.

    Dropping the client connection does NOT cancel a non-streaming handler
    under the pinned uvicorn/starlette — measured, a handler kept running three
    seconds past a hard disconnect. A one-call route tolerates that; a
    seven-call refine would burn six more generations on the GPU after Stop,
    holding ``Lane::LocalLlm``'s single slot while the next job queues behind.
    """
    script = Script(
        ["d0", '{"pass":false,"feedback":"f"}', "d1", '{"pass":false}', "d2"],
        delays={0: 0.05},
    )
    token = CancelToken()
    deps = _deps(script, token, monkeypatch)

    async def stop_soon() -> None:
        await asyncio.sleep(0.02)
        token.cancel()

    stopper = asyncio.create_task(stop_soon())
    with pytest.raises(wf_nodes.Stopped):
        await wf_nodes.run_refine(deps=deps, prompt="BASE", rubric="", max_rounds=4)
    await stopper
    assert len(script.calls) == 1, "Stop must not let the rest of the chain run"


async def test_out_of_order_workers_still_synthesize_in_subtask_order(monkeypatch) -> None:
    """Rust ran workers in a sequential ``for st in &subtasks`` loop, so the
    synthesis prompt listed results in SUBTASK order — and that ordering is
    visible to the user in the final answer. LangGraph's ``Send`` runs the whole
    fan-out in one superstep, so results arrive in COMPLETION order. The
    index-carrying reducer is what puts them back."""
    script = Script(
        ['{"subtasks":["a","b","c"]}', "ra", "rb", "rc", "final"],
        delays={1: 0.06, 2: 0.03},  # 'a' finishes LAST
    )
    await wf_nodes.run_plan_and_map(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=4),
        objective="OBJ",
        context="CTX",
        max_workers=8,
    )
    synth = script.calls[-1][0]
    positions = [synth.index(f"### {x}") for x in ("a", "b", "c")]
    assert positions == sorted(positions)


async def test_a_local_lane_serializes_the_fan_out(monkeypatch) -> None:
    """``Lane::LocalLlm => 1`` exists because "Local model and Whisper are
    serial (RAM and a single resident model)". Rust enforces that ACROSS steps
    in ``plan_dispatch``; a fan-out INSIDE one step bypasses it entirely, and
    nothing in the tree sets ``OLLAMA_NUM_PARALLEL``, so Ollama's dynamic
    default would happily admit several concurrent generations against a local
    4B and multiply resident context. The semaphore re-imposes the budget."""
    in_flight = 0
    peak = 0

    class Tracking(Script):
        async def generate(self, model, messages, base_url, **kw):  # noqa: ANN001
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            try:
                await asyncio.sleep(0.01)
                return await super().generate(model, messages, base_url, **kw)
            finally:
                in_flight -= 1

    replies = ['{"subtasks":["a","b","c","d"]}', "r1", "r2", "r3", "r4", "final"]

    script = Tracking(replies)
    await wf_nodes.run_plan_and_map(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=1),
        objective="OBJ",
        context="CTX",
        max_workers=8,
    )
    assert peak == 1, f"a LocalLlm fan-out ran {peak} generations at once"

    in_flight = peak = 0
    script = Tracking(replies)
    await wf_nodes.run_plan_and_map(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=4),
        objective="OBJ",
        context="CTX",
        max_workers=8,
    )
    assert peak > 1, "a Cloud lane should actually overlap its workers"


# --------------------------------------------------------------------------- #
# vote (MIGRATION slice 2)
# --------------------------------------------------------------------------- #


def test_aggregate_votes_matches_the_rust_rules() -> None:
    """The four assertions that used to live in
    ``workflow.rs::vote_aggregation_picks_majority_and_concats``.

    That Rust function is DELETED — the vote arm runs in the sidecar now, and
    keeping a second implementation was the "written twice" case. These
    assertions are what it guaranteed, moved verbatim; the tie rule especially,
    because it is the only reason the fan-out has to preserve sample order.
    """
    assert wf_nodes.aggregate_votes("majority", ["yes", "no", "yes"]) == "yes"
    # A tie resolves to the EARLIEST sample, not an arbitrary dict order.
    assert wf_nodes.aggregate_votes("majority", ["b", "a"]) == "b"
    assert "sample 1" in wf_nodes.aggregate_votes("concat", ["yes", "no", "yes"])
    assert wf_nodes.aggregate_votes("majority", []) == ""


async def test_vote_on_the_local_lane_is_byte_identical_to_the_rust_loop(monkeypatch) -> None:
    """`Lane::LocalLlm` (parallel=1) is the lane that must not change at all.

    A subtlety worth writing down, because it limits what ordering can buy: all
    N vote samples use the SAME prompt, so a sample carries nothing that
    identifies which draw it was. Under a concurrent fan-out "which reply is
    sample 0" is therefore decided by arrival, and majority's
    tie-goes-to-the-earliest rule becomes arbitrary — not because the reducer
    is wrong, but because i.i.d. draws have no intrinsic order to preserve.

    On the local lane the semaphore serializes the fan-out, so draw order IS
    index order and the Rust semantics hold exactly. That is the guarantee this
    pins; the cloud lane's is weaker and is stated in `run_vote`'s docstring.
    """
    script = Script(["b", "a"], delays={0: 0.06})
    out = await wf_nodes.run_vote(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=1),
        prompt="P",
        mode="majority",
        samples=2,
    )
    # Two distinct samples -> a tie -> the EARLIEST drawn wins, exactly as the
    # sequential Rust loop did.
    assert out["result"] == "b"


async def test_vote_concat_labels_every_sample_in_order(monkeypatch) -> None:
    script = Script(["first", "second", "third"])
    out = await wf_nodes.run_vote(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=1),
        prompt="P",
        mode="concat",
        samples=3,
    )
    body = out["result"]
    assert body.index("first") < body.index("second") < body.index("third")
    assert "— sample 1 —" in body and "— sample 3 —" in body


async def test_a_cloud_lane_may_overlap_vote_samples(monkeypatch) -> None:
    """The one user-visible win: a Cloud step draws its samples concurrently
    instead of one after another."""
    in_flight = 0
    peak = 0

    class Tracking(Script):
        async def generate(self, model, messages, base_url, **kw):  # noqa: ANN001
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            try:
                await asyncio.sleep(0.02)
                return await super().generate(model, messages, base_url, **kw)
            finally:
                in_flight -= 1

    script = Tracking(["a", "b", "c", "d"])
    await wf_nodes.run_vote(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=4),
        prompt="P",
        mode="concat",
        samples=4,
    )
    assert peak > 1, "a Cloud vote should overlap its samples"


async def test_a_local_lane_serializes_the_vote_fan_out(monkeypatch) -> None:
    """Same Lane::LocalLlm invariant as plan_and_map: N samples inside ONE step
    must not bypass the serial-local budget."""
    in_flight = 0
    peak = 0

    class Tracking(Script):
        async def generate(self, model, messages, base_url, **kw):  # noqa: ANN001
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            try:
                await asyncio.sleep(0.01)
                return await super().generate(model, messages, base_url, **kw)
            finally:
                in_flight -= 1

    script = Tracking(["a", "b", "c", "d"])
    await wf_nodes.run_vote(
        deps=_deps(script, CancelToken(), monkeypatch, parallel=1),
        prompt="P",
        mode="concat",
        samples=4,
    )
    assert peak == 1, f"a LocalLlm vote ran {peak} generations at once"


# --------------------------------------------------------------------------- #
# extract / route (MIGRATION slice 3)
# --------------------------------------------------------------------------- #
#
# The assertions below are `workflow.rs::route_label_pick_is_robust` and
# `::extract_schema_requires_each_field`, moved verbatim. Those Rust helpers are
# DELETED — the arms run in the sidecar now, and keeping a second copy was the
# "written twice" case.


def test_route_label_pick_is_robust() -> None:
    labels = ["action", "reference", "idea"]
    # A structured answer wins.
    assert wf_nodes.pick_route_label('{"label":"idea"}', labels) == "idea"
    # Fuzzy: the label appears in prose.
    assert (
        wf_nodes.pick_route_label("This is clearly a reference note.", labels)
        == "reference"
    )
    # Nothing matches -> the FIRST label. A route always takes some branch;
    # returning nothing would strand the DAG with no edge to prune to.
    assert wf_nodes.pick_route_label("uh, dunno", labels) == "action"


def test_extract_schema_requires_each_field() -> None:
    s = wf_nodes.build_extract_schema(["name", "date", "  "])
    assert s["type"] == "object"
    assert isinstance(s["properties"]["name"], dict)
    # Blank field names are dropped.
    assert len(s["required"]) == 2


async def test_route_returns_the_branch_the_dag_prunes_on(monkeypatch) -> None:
    """`route` is the one migrated arm whose artifact is not just text: Rust
    reads `branch` to prune dead edges, so the envelope must carry it."""
    script = Script(['{"label":"reference"}'])
    out = await wf_nodes.run_route(
        deps=_deps(script, CancelToken(), monkeypatch),
        prompt="Classify this note.",
        labels=["action", "reference", "idea"],
        context="A citation list.",
    )
    assert out["branch"] == "reference"
    assert out["result"] == "route: reference"
    # The classifier is grammar-constrained to the label set.
    _, had_format = script.calls[0]
    assert had_format, "route must constrain the label enum, not hope for prose"


async def test_extract_returns_pretty_json_and_survives_garbage(monkeypatch) -> None:
    good = Script(['{"name":"Ada","date":"1843"}'])
    out = await wf_nodes.run_extract(
        deps=_deps(good, CancelToken(), monkeypatch),
        fields=["name", "date"],
        context="Ada Lovelace, 1843.",
    )
    assert '"name": "Ada"' in out["result"]

    # Rust fell back to {"_raw": raw} on unparseable output rather than failing
    # the step — a downstream node then sees the raw text instead of nothing.
    bad = Script(["not json at all"])
    out2 = await wf_nodes.run_extract(
        deps=_deps(bad, CancelToken(), monkeypatch),
        fields=["name"],
        context="…",
    )
    assert "_raw" in out2["result"]
