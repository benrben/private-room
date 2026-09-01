"""Reusable LangGraph wiring templates."""

from __future__ import annotations

from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

from .graph import AgentState, call_model, execute_tools, prepare, route_after_model, route_after_tools, synthesize
from .graphs_probe import (
    check_result,
    probe,
    probe_answer,
    route_after_probe,
    route_after_probe_fired,
    route_after_stage_model,
    route_after_stage_tools,
    stage_catalog,
)
from .graphs_route import route_action, route_after_perceive, route_after_react_prepare, trim_images
from .graphs_receipts import route_after_check
from .graphs_verify import _without_tool_orders, route_after_verify, verify_claims

def _react(g: StateGraph) -> StateGraph:
    """The tool-calling cycle shared by most workers."""
    g.add_node("prepare", prepare)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_conditional_edges(
        "prepare",
        route_after_react_prepare,
        {"execute_tools": "execute_tools", "call_model": "call_model"},
    )
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "synthesize"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


async def _force_final(state: AgentState) -> dict[str, Any]:
    """End the tool phase: the next model round is the tool-less one.

    ...and retire EVERY correction that ORDERED a tool call, because that round
    has no tools to obey it with. This node is the ONLY door from the chain's
    tool phase into its answer round, which is what makes it the right place:
    `stage_catalog` is not visited again once every stage has been offered.

    It used to filter with `_live_corrections`, which drops an order only once
    the tool HAS been called — and the order is raised only because it was NOT,
    so it survived in exactly the case this is here to fix: the model spends the
    re-offer round on a `flow.keep` side tool, `route_after_stage_tools` sends
    it here, and the tool-less answer round is still told "call web_search now".
    A 4B answers "I will now search the web" instead of writing the answer.

    `state` was formerly unread and kept only because LangGraph passes it
    positionally (a zero-argument node raises ``TypeError: takes 0 positional
    arguments but 1 was given`` at invoke time, verified against langgraph
    1.2.9). It is read now.
    """
    return {"force_synthesis": True, "corrections": _without_tool_orders(state)}


# `_oneshot` lived here and is DELETED (2026-07-25). It allowed EXACTLY ONE
# tool round, which was structurally wrong for two of its three users:
#
# * media.transcribe — TRANSCRIBE_PROMPT says "stt_status ... check it before
#   promising anything", so an agent that OBEYED its own prompt spent its only
#   round on the probe and could never reach retranscribe_file. The prompt and
#   the template contradicted each other.
# * jobs.run — same trap latent: open with job_status and the pass never starts.
# * creator.studio — not broken, but `route_act` does the job with the same
#   call count, a 3-tool catalog instead of ~21, and a free classifier.
#
# Its one good idea survives: `_force_final`, which closes the tool phase by
# making the NEXT model round tool-less rather than skipping the answer. The
# regression its docstring recorded (execute_tools wired straight to synthesize,
# dropping the round that turns tool RESULTS into a report) is still pinned, now
# against the shapes that inherit the pattern.


def _react_verify(g: StateGraph) -> StateGraph:
    """The cycle, plus a ground-truth check before the answer."""
    g.add_node("prepare", prepare)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("verify", verify_claims)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "verify",
        route_after_verify,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _route_act(g: StateGraph) -> StateGraph:
    """Deterministic verb pick, then a BOUNDED cycle to fill its arguments.

    A cycle, not `oneshot`'s single round: the routed verb usually needs a real
    filename, and "the contract" is not one. `flow.keep` leaves the resolvers
    (list_room_files / search_room) in the narrowed catalog so the model can
    look one up, which needs a round it can come back from. What stops it is
    the duplicate guard and the tool-less final round, not a round budget.
    """
    g.add_node("prepare", prepare)
    g.add_node("route_action", route_action)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("verify", verify_claims)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "route_action")
    g.add_edge("route_action", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "verify",
        route_after_verify,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _probe_gate_act(g: StateGraph) -> StateGraph:
    """Probe deterministically, gate on the answer, then act.

    Prompt chaining with a deterministic gate — the docs' generate ->
    check -> {Pass/Fail} wiring, where the gate is plain Python. Replaces
    `oneshot` for media.transcribe, which under `oneshot` could not do its job:
    its prompt tells it to check `stt_status` first, and that consumed the only
    tool round it had.

    The gate is the PROBE and nothing else. This shape used to ALSO cap the act
    phase at one model-driven tool round (`force_final` on the execute_tools
    back-edge), which reintroduced `oneshot`'s bug one level up — see the
    comment on that edge. The act phase is now an ordinary bounded cycle.

    Costs ONE FEWER model call than `react` on the happy path (the probe is
    free) and TWO fewer on the blocked path, which reaches no model at all.
    """
    g.add_node("prepare", prepare)
    g.add_node("probe", probe)
    g.add_node("probe_tools", execute_tools)
    g.add_node("probe_answer", probe_answer)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("check", check_result)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "probe")
    g.add_conditional_edges(
        "probe",
        route_after_probe_fired,
        {"tools": "probe_tools", "skip": "call_model"},
    )
    g.add_conditional_edges(
        "probe_tools",
        route_after_probe,
        {
            "call_model": "call_model",
            "blocked": "probe_answer",
            "synthesize": "synthesize",
        },
    )
    g.add_edge("probe_answer", "synthesize")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "check"},
    )
    # The gate is the PROBE, not the round count. `force_final` used to sit on
    # this edge and made every model-driven tool round the last one, which
    # recreated the exact contradiction `oneshot` was deleted for, one level up:
    # media.transcribe's prompt tells it to resolve a file name first, so a run
    # that opened with `list_room_files` spent its only round looking and ended
    # with the file FOUND and never transcribed — reported to the user as done.
    # It also made `request_tools` unreachable in this shape, since unlocking a
    # lane costs the round that would have used it. The ordinary react back-edge
    # still guarantees a model round after tools (pinned structurally by
    # test_a_tool_round_is_always_followed_by_a_model_round), so nothing that
    # `force_final` was defending here is lost.
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "check",
        route_after_check,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _perceive_act(g: StateGraph) -> StateGraph:
    """See, then act — the WebVoyager loop, for the agent that drives the app.

    The biggest structural win in the roster. Today a UI task costs TWO model
    rounds per action: one to ask for `ui_snapshot`, one to decide what to
    click. But the snapshot is not a decision — UI_PROMPT already says "Take a
    fresh ui_snapshot before each ui_act", so the order is prescribed and the
    model was paying to rediscover it. Firing the capture deterministically
    halves the rounds, and `trim_images` keeps exactly one live screenshot in
    context instead of one per action.

    The critic is the next screenshot (the CUA doctrine), which is why this
    shape has no `verify` node: for a pixel agent the following capture IS the
    verification, and it is free.
    """
    g.add_node("prepare", prepare)
    g.add_node("perceive", probe)
    g.add_node("perceive_tools", execute_tools)
    g.add_node("trim_images", trim_images)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "perceive")
    g.add_conditional_edges(
        "perceive",
        route_after_probe_fired,
        {"tools": "perceive_tools", "skip": "call_model"},
    )
    g.add_conditional_edges(
        "perceive_tools",
        route_after_perceive,
        {"trim_images": "trim_images", "synthesize": "synthesize"},
    )
    g.add_edge("trim_images", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "synthesize"},
    )
    # ...and back around to a FRESH capture, not straight to the model: acting
    # without re-perceiving is how a UI agent clicks a control that moved.
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "perceive", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _chain_stage(g: StateGraph) -> StateGraph:
    """A fixed chain of one-tool stages, then the grounded answer.

    Each stage offers ONE verb, so the round is "fill arguments" rather than
    "choose among ~20 tools, then fill arguments" — the single regime a 4B is
    measured frontier-grade at. Bounded by construction: the number of stages,
    plus the tool-less answer round.
    """
    g.add_node("prepare", prepare)
    g.add_node("stage_catalog", stage_catalog)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("force_final", _force_final)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "stage_catalog")
    g.add_edge("stage_catalog", "call_model")
    # NOT `route_after_model`: skipping a stage must re-offer the next verb, not
    # exit the chain. See `route_after_stage_model`.
    g.add_conditional_edges(
        "call_model",
        route_after_stage_model,
        {
            "execute_tools": "execute_tools",
            "stage_catalog": "stage_catalog",
            "synthesize": "synthesize",
        },
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_stage_tools,
        {
            "stage_catalog": "stage_catalog",
            "force_final": "force_final",
            "synthesize": "synthesize",
        },
    )
    g.add_edge("force_final", "call_model")
    g.add_edge("synthesize", END)
    return g


def _recall_act_check(g: StateGraph) -> StateGraph:
    """Load this agent's own prior art for free, act, check the result, repair.

    Episodic-memory retrieval (USACO) in front of the loop, plus a bounded
    generate -> check -> retry. The retrieval half is the cheap win: for all
    four users the FIRST move is an index call — `list_scripts`, `list_skills`,
    `list_workflows` — which is a constant, so paying a model round to
    rediscover it is waste. Firing it deterministically also doubles as the
    few-shot: existing skills and workflows are worked examples, which small
    models follow far better than schema prose.

    The check half is bounded by `flow.repair_cap`, and is DATA per agent:
    `skills.use` gets 0 (a skill that fails is the author's problem, and
    looping a 4B on someone else's script invents output), while
    `skills.author` gets a real budget because repairing its own draft is the
    job.
    """
    g.add_node("prepare", prepare)
    g.add_node("recall", probe)
    g.add_node("recall_tools", execute_tools)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("check", check_result)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "recall")
    g.add_conditional_edges(
        "recall",
        route_after_probe_fired,
        {"tools": "recall_tools", "skip": "call_model"},
    )
    g.add_edge("recall_tools", "call_model")
    # BOTH exits from the loop go through `check`, exactly as `_react_verify`
    # routes both of its exits through `verify`. Sending only `execute_tools`'s
    # exit there left the gate unreachable on the ordinary path — a model that
    # answers with no further calls leaves via `call_model`, which is what
    # happens on every successful run — so the gate ran only when the round
    # budget was exhausted or the turn was cancelled.
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "check",
        route_after_check,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


#: shape name -> builder. `supervisor` shares `react`'s wiring: the Main agent's
#: difference is its CATALOG (specialists, not room tools) and the hub guard in
#: `execute_tools`, both of which are already keyed off `agent_id`. Kept as a
#: separate name so the roster reads truthfully and so the two can diverge
#: without touching every worker.
_BUILDERS: dict[str, Callable[[StateGraph], StateGraph]] = {
    "react": _react,
    "supervisor": _react,
    "route_act": _route_act,
    "probe_gate_act": _probe_gate_act,
    "perceive_act": _perceive_act,
    "chain_stage": _chain_stage,
    "recall_act_check": _recall_act_check,
    "react_verify": _react_verify,
}
