"""Workflow LLM-CHAIN nodes as compiled LangGraph graphs (MIGRATION slice 1).

Ported from ``commands/jobs/workflow.rs`` ``execute_workflow_step`` — the two
arms that are multi-call chains over ``wf_generate`` and touch NOTHING else:
``refine`` (evaluator-optimizer) and ``plan_and_map`` (orchestrator-worker).

Rust keeps everything it already owns and the port changes none of it: it
compiles the plan, assigns the lane, interpolates ``{{files}}``/``{{date}}``
against the encrypted DB BEFORE the call, runs ``run_plan``'s wave scheduler,
and stores the returned ``WfArtifact``. One Rust ``Step`` is still exactly one
POST, so the per-wave checkpoint contract (jobs.rs:1632) is untouched and the
step's durability is unchanged: on any failure the whole step replays, which is
what ``run_plan_discards_a_failed_waves_completed_siblings`` (jobs.rs:1659)
already requires of every step. **No checkpointer is needed and none is used.**

Why these two and not the rest:

* ``extract`` / ``route`` are ONE model call — a graph buys nothing.
* ``vote`` is a fan-out but its aggregation (``aggregate_votes``) is pinned by
  a Rust unit test (workflow.rs:4103) and ties resolve by first-seen index, so
  it needs the ordered-fan-in machinery below before it can move.
* ``for_each_file`` reads ``db::get_file_extracted_text`` BETWEEN calls, so it
  cannot move without a room callback (SPEC.md:5-7).
* ``agent_run`` / ``script_run`` / ``http_fetch`` / ``save_file`` /
  ``summarize_file`` / ``file_pass`` are host-only by construction.

Cancellation (the hazard this slice must close). Dropping the client connection
does NOT cancel a non-streaming handler under the pinned uvicorn 0.51 /
starlette 0.52 — measured: a handler kept running 3s past the drop. A one-call
endpoint tolerates that (``/file_pass_map`` wastes at most one generation); a
7-call refine would burn six more on the GPU after the user pressed Stop. So
these nodes take a ``run_id``, register a :class:`~.graph.CancelToken` in the
server's existing :class:`~.server.RunRegistry`, and Stop reaches them through
the ``/cancel`` route that ``/run`` already uses.

Every node reads its state with ``.get`` and a default. The ``run_*`` entry
points always seed the whole state, but ``langgraph dev`` invokes these graphs
with whatever JSON the developer typed into Studio, and a missing key there
ended the run on a raw ``KeyError`` instead of just running with an empty
objective/prompt.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Annotated, Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from pydantic import BaseModel, ConfigDict

from . import llm
from .config import KEEP_ALIVE_WARM, ProviderConfig
from .graph import CancelToken
from .messages import user_message
from .model_text import recover_json

# --------------------------------------------------------------------------- #
# the one model call — wf_generate's exact body, minus the HTTP hop
# --------------------------------------------------------------------------- #


class Stopped(Exception):
    """Stop was pressed. Surfaces to Rust as the same ``Err("STOPPED")`` the
    in-process arm produced (workflow.rs ``wf_generate`` -> ``Ok(None)``)."""


@dataclass
class NodeDeps:
    """Everything a chain node needs that is not state. Passed through
    ``config.configurable`` so the compiled graphs stay reusable singletons —
    the same discipline :mod:`.graphs` uses for the agent templates."""

    model: str
    base_url: str
    keep_alive: str
    privacy: dict[str, Any] | None
    provider: ProviderConfig | None
    cancel: CancelToken
    #: Lane::slots() for the step's lane, sent by Rust (jobs.rs:48-59):
    #: LocalLlm => 1, Cloud => 4. The Rust comment is load-bearing — "Local
    #: model and Whisper are serial (RAM and a single resident model)". A naive
    #: LangGraph `Send` fan-out runs every worker in ONE superstep and would let
    #: 8 generations hit a local 4B at once (nothing sets OLLAMA_NUM_PARALLEL,
    #: so Ollama's dynamic default would actually admit several), multiplying
    #: resident context. This semaphore re-imposes the lane budget INSIDE the
    #: step, so a local plan_and_map still serializes exactly as the Rust `for`
    #: loop did while a cloud one gets its 4-wide overlap for free.
    parallel: int = 1
    _sem: Any = None

    def __post_init__(self) -> None:
        self._sem = asyncio.Semaphore(max(1, self.parallel))

    async def gen(self, prompt: str, fmt: dict[str, Any] | None = None) -> str:
        """One ``wf_generate``: a single user turn, no temperature, no num_ctx.

        The pre-check mirrors ``sidecar_json_cancellable``, which returns
        ``Ok(None)`` -> ``Err("STOPPED")`` when the flag is already set before
        the POST. That is the ONLY cancel point Rust had, so checking here
        reproduces the in-process cancel granularity exactly."""
        if self.cancel.cancelled:
            raise Stopped()
        async with self._sem:
            # Re-check: Stop may have landed while queued behind the lane.
            if self.cancel.cancelled:
                raise Stopped()
            return await llm.generate(
                self.model,
                [user_message(prompt)],
                self.base_url,
                keep_alive=self.keep_alive,
                format=fmt,
                privacy=self.privacy,
                provider=self.provider,
            )


#: DEV-ONLY seam, same contract as `graph.STUDIO_DEPS` — see the note there.
#: `langgraph dev` cannot pass a NodeDeps through config (Studio sends JSON),
#: and pre-binding via `with_config` is dropped by langgraph-api 0.4.x.
STUDIO_DEPS: NodeDeps | None = None


def _deps(config: RunnableConfig) -> NodeDeps:
    deps = (config or {}).get("configurable", {}).get("deps")
    if isinstance(deps, NodeDeps):
        return deps
    if STUDIO_DEPS is not None:  # pragma: no cover - dev-only path
        return STUDIO_DEPS
    raise RuntimeError("workflow node invoked without NodeDeps in config.configurable")


# --------------------------------------------------------------------------- #
# serde_json parity helpers
# --------------------------------------------------------------------------- #


def _bool_or(parsed: Any, key: str, default: bool) -> bool:
    """``v[key].as_bool().unwrap_or(default)``.

    ``as_bool`` is None for a non-object, a missing key, a string, a number —
    so ``{"pass": "yes"}`` and ``[1,2]`` both take the default. The ``bool``
    check must come first: in Python ``isinstance(1, int)`` and ``bool`` is a
    subclass of ``int``, but ``1`` is NOT a serde bool."""
    if isinstance(parsed, dict):
        v = parsed.get(key)
        if isinstance(v, bool):
            return v
    return default


def _str_or_empty(parsed: Any, key: str) -> str:
    """``v[key].as_str().unwrap_or_default()`` — "" unless it is a string."""
    if isinstance(parsed, dict):
        v = parsed.get(key)
        if isinstance(v, str):
            return v
    return ""


def _parse_or(raw: str, fallback: Any) -> Any:
    """``serde_json::from_str(&recover_json(raw)).unwrap_or(fallback)``."""
    try:
        return json.loads(recover_json(raw))
    except (ValueError, TypeError):
        return fallback


def _clamp(v: int, lo: int, hi: int) -> int:
    """Rust ``i.clamp(lo, hi)``."""
    return max(lo, min(hi, v))


# --------------------------------------------------------------------------- #
# refine — the evaluator-optimizer loop
# --------------------------------------------------------------------------- #

#: workflow.rs: `if rubric.trim().is_empty()` -> this exact sentence.
REFINE_DEFAULT_RUBRIC = "accurate, complete, and clearly written"

REFINE_VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"pass": {"type": "boolean"}, "feedback": {"type": "string"}},
    "required": ["pass", "feedback"],
}


class RefineState(TypedDict, total=False):
    base: str
    rubric: str
    #: `rounds` in Rust = max_rounds.clamp(1,4); the loop is `for _ in 1..rounds`,
    #: so at most `rounds - 1` judge/revise iterations run.
    budget: int
    draft: str
    judged: int
    feedback: str
    #: MUST be declared. LangGraph 1.2.9 filters a node's returned dict against
    #: the state schema and SILENTLY DROPS unknown keys — an undeclared
    #: `passed` made every judge look like a pass, so the loop never ran and
    #: `rounds=4` behaved like `rounds=1`. Caught only by the transcript
    #: comparison in test_wf_nodes.py; the artifact alone still looked
    #: plausible. This is the single biggest porting hazard in the slice.
    passed: bool


async def refine_draft(state: RefineState, config: RunnableConfig) -> dict[str, Any]:
    return {"draft": await _deps(config).gen(state.get("base", "")), "judged": 0}


async def refine_judge(state: RefineState, config: RunnableConfig) -> dict[str, Any]:
    prompt = (
        f"Judge the draft against this bar: {state.get('rubric', REFINE_DEFAULT_RUBRIC)}.\n"
        'Return ONLY JSON {"pass": <bool>, "feedback": <what to fix>}.\n\n'
        f"Draft:\n{state.get('draft', '')}"
    )
    raw = await _deps(config).gen(prompt, REFINE_VERDICT_SCHEMA)
    verdict = _parse_or(raw, {"pass": True, "feedback": ""})
    return {
        "judged": state.get("judged", 0) + 1,
        "feedback": "" if _bool_or(verdict, "pass", True) else _str_or_empty(verdict, "feedback"),
        # Recorded so the router needs no re-parse (see `passed` above).
        "passed": _bool_or(verdict, "pass", True),
    }


async def refine_revise(state: RefineState, config: RunnableConfig) -> dict[str, Any]:
    prompt = (
        f"{state.get('base', '')}\n\nYour previous draft:\n{state.get('draft', '')}\n\n"
        f"Revise it to fix this feedback:\n{state.get('feedback', '')}"
    )
    return {"draft": await _deps(config).gen(prompt)}


def _after_draft(state: RefineState) -> str:
    # `for _ in 1..rounds` runs zero times when rounds == 1.
    return "judge" if state.get("budget", 1) > 1 else END


def _after_judge(state: RefineState) -> str:
    return END if state.get("passed", True) else "revise"


def _after_revise(state: RefineState) -> str:
    # Iteration i (1-based) judged once; the loop body ends after `rounds - 1`
    # iterations, and the last revise's draft is returned WITHOUT a re-judge.
    return "judge" if state.get("judged", 0) < state.get("budget", 1) - 1 else END


def _build_refine() -> Any:
    g: StateGraph = StateGraph(RefineState)
    g.add_node("draft", refine_draft)
    g.add_node("judge", refine_judge)
    g.add_node("revise", refine_revise)
    g.add_edge(START, "draft")
    g.add_conditional_edges("draft", _after_draft, {"judge": "judge", END: END})
    g.add_conditional_edges("judge", _after_judge, {"revise": "revise", END: END})
    g.add_conditional_edges("revise", _after_revise, {"judge": "judge", END: END})
    return g.compile()


REFINE_GRAPH = _build_refine()


async def run_refine(
    *,
    deps: NodeDeps,
    prompt: str,
    rubric: str,
    max_rounds: int,
) -> dict[str, Any]:
    """`NodeKind::Refine`. `prompt` arrives already interpolated by Rust."""
    budget = _clamp(max_rounds, 1, 4)
    rub = rubric.strip() or REFINE_DEFAULT_RUBRIC
    final: RefineState = await REFINE_GRAPH.ainvoke(
        {"base": prompt, "rubric": rub, "budget": budget, "draft": "", "judged": 0},
        config={
            "configurable": {"deps": deps},
            # draft + (budget-1) * (judge + revise); +4 slack. NEVER the 10007
            # default (langgraph/_internal/_config.py:32) — a DAG that needs
            # thousands of supersteps is a bug, not a long run.
            "recursion_limit": 2 * budget + 4,
        },
    )  # type: ignore[assignment]
    return {"result": final.get("draft", "")}


# --------------------------------------------------------------------------- #
# plan_and_map — the orchestrator-worker fan-out
# --------------------------------------------------------------------------- #

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"subtasks": {"type": "array", "items": {"type": "string"}}},
    "required": ["subtasks"],
}


def _ordered(a: list[tuple[int, str]], b: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Fan-in reducer. Workers finish in completion order, not subtask order —
    Rust's sequential ``for st in &subtasks`` produced subtask order and the
    synthesis prompt shows the results in that order, so each worker carries its
    index and the list is sorted on read."""
    return a + b


class MapState(TypedDict, total=False):
    objective: str
    context: str
    width: int
    subtasks: list[str]
    results: Annotated[list[tuple[int, str]], _ordered]
    answer: str


async def map_plan(state: MapState, config: RunnableConfig) -> dict[str, Any]:
    width = state.get("width", 1)
    prompt = (
        f"Break this objective into a short list of independent subtasks (no more "
        f'than {width}). Return ONLY JSON {{"subtasks": ["…"]}}.\n\n'
        f'Objective:\n{state.get("objective", "")}\n\nContext:\n{state.get("context", "")}'
    )
    raw = await _deps(config).gen(prompt, PLAN_SCHEMA)
    parsed = _parse_or(raw, {"subtasks": []})
    items: list[str] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("subtasks"), list):
        # Rust: filter_map(as_str).map(trim).filter(!empty).take(width)
        for s in parsed["subtasks"]:
            if isinstance(s, str) and s.strip():
                items.append(s.strip())
            if len(items) == width:
                break
    return {"subtasks": items}


async def map_direct(state: MapState, config: RunnableConfig) -> dict[str, Any]:
    """No decomposition — answer the objective directly (Rust's fallback arm)."""
    text = await _deps(config).gen(
        f'{state.get("objective", "")}\n\nContext:\n{state.get("context", "")}'
    )
    return {"answer": text}


async def map_worker(state: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
    prompt = (
        f'Overall objective:\n{state["objective"]}\n\nDo ONLY this subtask and '
        f'return its result:\n{state["subtask"]}\n\nContext:\n{state["context"]}'
    )
    text = await _deps(config).gen(prompt)
    return {"results": [(state["i"], f'### {state["subtask"]}\n\n{text.strip()}')]}


async def map_synthesize(state: MapState, config: RunnableConfig) -> dict[str, Any]:
    joined = "\n\n".join(s for _, s in sorted(state.get("results") or [], key=lambda p: p[0]))
    prompt = (
        "Combine these subtask results into one coherent answer to the "
        f'objective.\n\nObjective:\n{state.get("objective", "")}\n\nResults:\n{joined}'
    )
    return {"answer": await _deps(config).gen(prompt)}


def _after_plan(state: MapState) -> Any:
    subtasks = state.get("subtasks") or []
    if not subtasks:
        return "direct"
    return [
        Send(
            "worker",
            {
                "i": i,
                "subtask": s,
                "objective": state.get("objective", ""),
                "context": state.get("context", ""),
            },
        )
        for i, s in enumerate(subtasks)
    ]


def _build_map() -> Any:
    g: StateGraph = StateGraph(MapState)
    g.add_node("plan", map_plan)
    g.add_node("worker", map_worker)
    g.add_node("synthesize", map_synthesize)
    g.add_node("direct", map_direct)
    g.add_edge(START, "plan")
    g.add_conditional_edges("plan", _after_plan, ["worker", "direct"])
    g.add_edge("worker", "synthesize")
    g.add_edge("synthesize", END)
    g.add_edge("direct", END)
    return g.compile()


MAP_GRAPH = _build_map()


async def run_plan_and_map(
    *, deps: NodeDeps, objective: str, context: str, max_workers: int
) -> dict[str, Any]:
    """`NodeKind::PlanAndMap`. `objective` arrives already interpolated."""
    width = _clamp(max_workers, 1, 8)
    final: MapState = await MAP_GRAPH.ainvoke(
        {"objective": objective, "context": context, "width": width, "results": []},
        config={
            "configurable": {"deps": deps},
            # plan + worker-wave + synthesize; the whole fan-out is ONE superstep.
            "recursion_limit": 8,
        },
    )  # type: ignore[assignment]
    return {"result": final.get("answer", "")}


# --------------------------------------------------------------------------- #
# vote — self-consistency sampling
# --------------------------------------------------------------------------- #


def aggregate_votes(mode: str, samples: list[str]) -> str:
    """Rust ``aggregate_votes`` (workflow.rs), semantics preserved exactly.

    ``mode`` is "majority" or anything else, which is "concat". The VALIDATION of
    the two legal modes belongs to the plan compiler that owns the palette
    (workflow.rs ``VOTE_MODES``) and is not repeated here — a list published
    beside this function looked like a check it never performed.

    The subtle half is majority's tie rule: highest count wins, and a TIE goes
    to the LOWEST first-seen index. That is why the samples must arrive in
    sample order — the fan-out below carries an index for the same reason
    ``plan_and_map``'s workers do.
    """
    if not samples:
        return ""
    if mode == "majority":
        counts: dict[str, tuple[int, int]] = {}
        for i, s in enumerate(samples):
            key = s.strip()
            n, first = counts.get(key, (0, i))
            counts[key] = (n + 1, first)
        # max by count, then by SMALLEST first-seen index -> negate the index.
        return max(counts.items(), key=lambda kv: (kv[1][0], -kv[1][1]))[0]
    return "\n\n".join(
        f"— sample {i + 1} —\n{s.strip()}" for i, s in enumerate(samples)
    )


class VoteState(TypedDict, total=False):
    prompt: str
    mode: str
    width: int
    samples: Annotated[list[tuple[int, str]], _ordered]
    answer: str


async def vote_sample(state: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
    text = await _deps(config).gen(state["prompt"])
    return {"samples": [(state["i"], text)]}


async def vote_tally(state: VoteState, config: RunnableConfig) -> dict[str, Any]:
    ordered = [s for _, s in sorted(state.get("samples") or [], key=lambda p: p[0])]
    return {"answer": aggregate_votes(state.get("mode", "concat"), ordered)}


def _fan_votes(state: VoteState) -> Any:
    return [
        Send("sample", {"i": i, "prompt": state.get("prompt", "")})
        for i in range(state.get("width", 1))
    ]


def _build_vote() -> Any:
    g: StateGraph = StateGraph(VoteState)
    g.add_node("sample", vote_sample)
    g.add_node("tally", vote_tally)
    g.add_conditional_edges(START, _fan_votes, ["sample"])
    g.add_edge("sample", "tally")
    g.add_edge("tally", END)
    return g.compile()


VOTE_GRAPH = _build_vote()


async def run_vote(
    *, deps: NodeDeps, prompt: str, mode: str, samples: int
) -> dict[str, Any]:
    """`NodeKind::Vote`. `prompt` arrives already interpolated.

    Ordering caveat, stated because it bounds what the reducer can promise: all
    N samples use the SAME prompt, so nothing in a reply identifies which draw
    produced it. On `Lane::LocalLlm` the semaphore serializes the fan-out, draw
    order IS index order, and majority's tie-goes-to-the-earliest rule matches
    the sequential Rust loop exactly. On a Cloud lane the draws overlap, so a
    TIE between distinct samples resolves arbitrarily — which is sound, because
    i.i.d. samples of one prompt have no meaningful order, but it is a real
    difference from the old behaviour and should not be discovered later.
    """
    width = _clamp(samples, 1, 7)
    final: VoteState = await VOTE_GRAPH.ainvoke(
        {"prompt": prompt, "mode": mode, "width": width, "samples": []},
        config={"configurable": {"deps": deps}, "recursion_limit": 6},
    )  # type: ignore[assignment]
    return {"result": final.get("answer", "")}


# --------------------------------------------------------------------------- #
# extract / route — single structured calls (MIGRATION slice 3)
# --------------------------------------------------------------------------- #
#
# One model call each, so neither needs a graph — they are here for the reason
# the owner asked for: after this, no workflow node body calls a model in Rust
# except `for_each_file`, which reads the room BETWEEN calls and is therefore
# structurally forbidden from moving (SPEC: the sidecar has no DB).
# Their pure helpers moved WITH them and brought their Rust assertions along, so
# nothing is implemented twice.


def build_extract_schema(fields: list[str]) -> dict[str, Any]:
    """Rust ``build_extract_schema``: every named field required, as a string."""
    props: dict[str, Any] = {}
    required: list[str] = []
    for f in (f.strip() for f in fields):
        if f:
            props[f] = {"type": "string"}
            required.append(f)
    return {"type": "object", "properties": props, "required": required}


def route_schema_of(labels: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"label": {"type": "string", "enum": list(labels)}},
        "required": ["label"],
    }


def pick_route_label(raw: str, labels: list[str]) -> str:
    """Rust ``pick_route_label``, semantics preserved.

    A structured ``{"label": …}`` wins on a case-insensitive match; else the
    first label whose text appears anywhere; else the FIRST label — a route
    always takes some branch rather than stalling the DAG.
    """
    parsed = _parse_or(raw, None)
    if isinstance(parsed, dict):
        label = parsed.get("label")
        if isinstance(label, str):
            for x in labels:
                if x.casefold() == label.strip().casefold():
                    return x
    hay = raw.lower()
    for x in labels:
        if x.lower() in hay:
            return x
    return labels[0] if labels else ""


async def run_extract(
    *, deps: NodeDeps, fields: list[str], context: str
) -> dict[str, Any]:
    """`NodeKind::Extract`."""
    prompt = (
        "Extract these fields from the text and return ONLY a JSON object with "
        f"exactly these keys: {', '.join(fields)}.\n\nText:\n{context}"
    )
    raw = await deps.gen(prompt, build_extract_schema(fields))
    # `_parse_or` already ran the reply through recover_json, and its fallback is
    # a plain dict, so `val` is always JSON-serializable — pretty-print it.
    val = _parse_or(raw, {"_raw": raw})
    return {"result": json.dumps(val, indent=2, ensure_ascii=False)}


async def run_route(
    *, deps: NodeDeps, prompt: str, labels: list[str], context: str
) -> dict[str, Any]:
    """`NodeKind::Route`. Returns the chosen branch alongside the artifact."""
    ask = prompt.strip() or "Classify the input."
    full = (
        f"{ask}\n\nChoose EXACTLY ONE label for the following, from: "
        f"{', '.join(labels)}.\n\n{context}"
    )
    raw = await deps.gen(full, route_schema_of(labels))
    label = pick_route_label(raw, labels)
    return {"result": f"route: {label}", "branch": label}


# --------------------------------------------------------------------------- #
# request body — the /wf_node endpoint
# --------------------------------------------------------------------------- #


class WfNodeRequest(BaseModel):
    """One workflow chain node. Mirrors ``FilePassMapRequest``'s discipline: the
    body carries only gathered text + plan facts, never a room handle.

    ``model`` MUST stay a TOP-LEVEL field — ``sidecar_json`` keys
    ``inject_policy`` (privacy.rs:319) and ``inject_provider_runtime`` off
    ``body["model"]``, so a nested model would silently drop the privacy door
    and the Keychain-backed provider credentials on a cloud engine."""

    model_config = ConfigDict(extra="ignore")

    #: "refine" | "plan_and_map" | "vote" | "extract" | "route"
    kind: str
    model: str
    base_url: str = "http://127.0.0.1:11434"
    #: "<job_id>:<step_id>" — the /cancel key. Stop is NOT delivered by dropping
    #: the connection (measured: the handler survives the disconnect).
    run_id: str = ""
    #: Rust-interpolated prompt / objective (`{{files}}`, `{{date}}` already resolved).
    prompt: str = ""
    #: the joined live incoming-edge results (`inputs_joined`).
    context: str = ""
    rubric: str = ""
    max_rounds: int = 1
    max_workers: int = 1
    #: vote: how many samples to draw, and how to combine them.
    mode: str = "concat"
    samples: int = 1
    #: extract: the field names. route: the branch labels.
    fields: list[str] = []
    labels: list[str] = []
    #: Lane::slots() for this step's lane (jobs.rs:48-59). 1 = LocalLlm/Whisper.
    parallel: int = 1
    keep_alive: str = KEEP_ALIVE_WARM
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


__all__ = [
    "MAP_GRAPH",
    "VOTE_GRAPH",
    "aggregate_votes",
    "build_extract_schema",
    "pick_route_label",
    "route_schema_of",
    "NodeDeps",
    "REFINE_DEFAULT_RUBRIC",
    "REFINE_GRAPH",
    "Stopped",
    "WfNodeRequest",
    "run_plan_and_map",
    "run_extract",
    "run_refine",
    "run_route",
    "run_vote",
]
