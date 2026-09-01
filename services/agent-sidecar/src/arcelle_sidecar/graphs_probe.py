"""Probe, staged-catalog, and result-check graph nodes."""

from __future__ import annotations

from typing import Any

from .agents import Flow, get_agent
from .config import AGENT_ROUND_BACKSTOP
from .graph import AgentState
from .graphs_receipts import (
    _check_transcription_terminal,
    _failure_check_result,
    _needs_transcription_terminal_check,
    _receipt_check_result,
)
from .graphs_verify import STAGE_MISSED_NOTE, _live_corrections, narrowed
from .messages import ToolCall

def _tool_is_served(state: AgentState, name: str) -> bool:
    return any(
        (tool.get("function") or {}).get("name") == name
        for tool in state.get("tools", [])
    )


def _probe_precondition_is_met(state: AgentState, flow: Flow) -> bool:
    after = flow.probe_after
    return not after or after in set(state.get("attempted", set()))


def _last_tool_text(state: AgentState) -> str:
    for message in reversed(state.get("messages", [])):
        if message.get("role") == "tool":
            return (message.get("content") or "").lower()
    return ""


def _probe_precondition_failed(state: AgentState, flow: Flow) -> bool:
    blockers = flow.probe_unless
    if not blockers:
        return False
    last = _last_tool_text(state)
    return any(marker.lower() in last for marker in blockers)


def _probe_is_ready(state: AgentState, flow: Flow, name: str) -> bool:
    if not _tool_is_served(state, name):
        return False
    # ...and only once the probe's PRECONDITION has been met. `chat.browse`
    # cannot snapshot a page before `browse_open` has made one; firing anyway
    # spent a guaranteed failure — journalled where the user reads it — as the
    # opening move of every browse task. See `Flow.probe_after`.
    if not _probe_precondition_is_met(state, flow):
        return False
    # ...and not when that tool ran WITHOUT establishing the precondition.
    # `browse_open` with plain words searches instead of navigating, so it is
    # "attempted" with no page behind it. See `Flow.probe_unless`.
    return not _probe_precondition_failed(state, flow)


async def probe(state: AgentState) -> dict[str, Any]:
    """Fire this agent's opening tool call WITHOUT spending a model round.

    ``execute_tools`` runs whatever is in ``state["calls"]``; it does not care
    whether a model produced them. So a plain Python node can fire a real
    bridge call for zero model cost and still get the full SPEC §3.2 treatment
    — step/step_status events, cancellation between calls, successful-only
    memoisation, the progress log, the referent baton.

    This is worth a node because for some agents the first move is a CONSTANT.
    ``TRANSCRIBE_PROMPT`` says "stt_status tells you whether the speech model is
    installed — check it before promising anything", so the model was paying a
    whole round to rediscover something the graph already knows.
    """
    flow = get_agent(state.get("agent_id", "")).flow
    name = flow.probe
    if not name or not _probe_is_ready(state, flow, name):
        return {}
    probe_call = ToolCall(name=name, arguments={})
    # A re-capture is the GRAPH's decision, not the model looping, so it must be
    # exempt from duplicate suppression. `ui_snapshot` takes no arguments, so
    # every capture has an identical `key()`; left in `seen`, the second
    # perceive is swallowed by the `key in seen` guard, `all_dup` stays true and
    # the turn is forced into synthesis after ONE action — the UI agent clicks
    # once and stops. Dropping just this key keeps the guard intact for every
    # call the MODEL makes, which is the behaviour it exists to catch.
    seen: set[str] = set(state.get("seen", set())) - {probe_call.key()}
    # NOTE: only keys declared on AgentState survive. Verified against langgraph
    # 1.2.9: a node returning an undeclared key has it silently DROPPED — no
    # exception, no warning. A stray `"probed": True` here read as if it
    # recorded something and recorded nothing.
    return {"calls": [probe_call], "seen": seen, "synth": True}


def route_after_probe_fired(state: AgentState) -> str:
    """Skip the tool node when the probe ABSTAINED.

    A probe abstains when the bridge did not serve its tool this run (web off,
    a capability the host does not expose). Running `execute_tools` on an empty
    call list is not a no-op: `all_dup` starts True and nothing clears it, so
    the node sets `force_synthesis` and the very next model round is offered
    ZERO tools. The agent would silently lose its whole catalog because an
    optional prefetch was unavailable.
    """
    return "tools" if state.get("calls") else "skip"


def _probe_is_blocked(state: AgentState, flow: Flow) -> bool:
    blockers = flow.blockers
    if not blockers:
        return False
    last = _last_tool_text(state)
    return any(blocker.lower() in last for blocker in blockers)


def route_after_probe(state: AgentState) -> str:
    """Read the probe's answer in Python and decide whether acting is possible.

    The gate is a pure predicate over the tool result the probe just produced.
    When the probe says the capability is missing, the honest answer is a fixed
    sentence — so the blocked path costs ZERO model calls where it costs two
    today.

    Fails OPEN. The blocker strings are matched against Rust-authored result
    text; if that wording drifts, the predicate must fall through to the normal
    path, so the worst case is exactly today's behaviour rather than an agent
    that refuses work it could do.
    """
    if state.get("cancelled", False):
        return "synthesize"
    flow = get_agent(state.get("agent_id", "")).flow
    return "blocked" if _probe_is_blocked(state, flow) else "call_model"


async def probe_answer(state: AgentState) -> dict[str, Any]:
    """The blocked answer, composed in code. No model call at all."""
    spec = get_agent(state.get("agent_id", ""))
    return {"final_text": spec.flow.blocked_answer, "stop": True}


async def stage_catalog(state: AgentState) -> dict[str, Any]:
    """Offer exactly the ONE tool this stage is for, then advance the stage.

    Prompt chaining, with the chain expressed as wiring instead of as English.
    ``WEB_PROMPT`` already dictates the order — "web_search to find pages, then
    fetch_page on the most promising result — a search snippet is not a source"
    — so by the docs' own definition this is a workflow, not an agent: the
    model does not choose the order, it only fills each step's arguments.

    Today the same order is a plea the model may ignore, and a 4B routinely
    answers from the search snippet without ever fetching. Staging the catalog
    makes the fetch structural.
    """
    flow = get_agent(state.get("agent_id", "")).flow
    idx = state.get("stage", 0)
    # Narrow from the FULL box, never from the previous stage's narrowed view.
    # Reading `tools` here instead cost stage 2 its own verb: stage 1 had
    # already reduced the catalog to {web_search, …}, so `fetch_page` was gone
    # and the chain silently degraded into repeating its first stage.
    box = _stage_catalog_box(state)
    if idx >= len(flow.stages):
        return _completed_stage_catalog(state, flow, box)
    return _next_stage_catalog(state, flow, idx, box)


def _stage_catalog_box(state: AgentState) -> list[dict[str, Any]]:
    """Use the complete catalog rather than a previous stage's narrow view."""
    return list(state.get("full_tools") or state.get("tools", []))


def _completed_stage_catalog(
    state: AgentState, flow: Flow, box: list[dict[str, Any]]
) -> dict[str, Any]:
    """Re-offer one skipped stage, or restore the complete catalog to answer."""
    missed = _missing_stage_names(flow, state)
    if not missed or state.get("stage_retried", False):
        return {"full_tools": box}
    want_again = missed[0]
    if want_again not in _catalog_tool_names(box):
        return {"full_tools": box, "stage_retried": True}
    return {
        "tools": narrowed(state, _stage_tools(flow, want_again, box)),
        "full_tools": box,
        "stage_retried": True,
        "corrections": [
            *_live_corrections(state),
            STAGE_MISSED_NOTE.format(tool=want_again),
        ],
    }


def _missing_stage_names(flow: Flow, state: AgentState) -> list[str]:
    """Return the staged verbs not yet called in their required order."""
    attempted = set(state.get("attempted", set()))
    return [stage for stage in flow.stages if stage not in attempted]


def _catalog_tool_names(box: list[dict[str, Any]]) -> set[Any]:
    """Read the function names currently served by one complete catalog."""
    return {(tool.get("function") or {}).get("name") for tool in box}


def _next_stage_catalog(
    state: AgentState, flow: Flow, idx: int, box: list[dict[str, Any]]
) -> dict[str, Any]:
    """Offer the next staged verb while retaining this flow's side tools."""
    want = flow.stages[idx]
    # Abstain rather than narrow to nothing — web tools are absent entirely
    # when the room has web disabled, and an empty catalog is a dead round.
    if want not in _catalog_tool_names(box):
        return {"stage": idx + 1, "full_tools": box}
    return {
        "tools": narrowed(state, _stage_tools(flow, want, box)),
        "stage": idx + 1,
        "full_tools": box,
    }


def _stage_tools(flow: Flow, stage: str, box: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Narrow one catalog to the required verb and its permitted side tools."""
    keep = set(flow.keep) | {stage}
    return [tool for tool in box if (tool.get("function") or {}).get("name") in keep]


def _stage_re_offer_due(state: AgentState) -> bool:
    """A staged verb was never actually called, and the one re-offer is unspent.

    Read by BOTH stage routers, which is the point. `stage` counts stages
    OFFERED, and ANY tool call advances the chain: `chat.web` keeps
    `search_room` and the download verbs offered alongside every stage
    (`flow.keep`), so a round that searched the ROOM consumed the "search the
    web" stage — the chain moved on to `fetch_page`, `web_search` was never
    offered again, and the Web agent could finish a web task having never
    touched the web. Only the declined-stage exit checked for that, and the exit
    taken after a tool ran is the one that case takes.
    """
    stages = get_agent(state.get("agent_id", "")).flow.stages
    attempted: set[str] = set(state.get("attempted", set()))
    return any(s not in attempted for s in stages) and not state.get(
        "stage_retried", False
    )


def route_after_stage_model(state: AgentState) -> str:
    """A DECLINED stage must not end the chain.

    `route_after_model` sends any round with no tool calls straight to
    `synthesize`, and `call_model` sets `stop` whenever the model emitted no
    calls. On this shape that made the chain opt-out: chat.web could answer from
    a `web_search` snippet — which WEB_PROMPT itself calls "not a source" — by
    simply not calling `fetch_page` when stage 2 offered it. `stage_catalog`'s
    docstring says "staging the catalog makes the fetch structural"; until
    2026-07-27 the wiring made it a plea the model could ignore.

    Bounded by construction: `stage_catalog` increments `stage` on every visit
    (including when it abstains because the verb is not served), so a model that
    declines every stage walks the chain once and lands on synthesize.
    """
    if state.get("cancelled", False):
        return "synthesize"
    if state.get("calls"):
        return "execute_tools"
    if state.get("force_synthesis", False):
        # The forced tool-less answer round. Not a declined stage.
        return "synthesize"
    # Stages the model has not been OFFERED yet.
    if state.get("stage", 0) < len(get_agent(state.get("agent_id", "")).flow.stages):
        return "stage_catalog"
    # Every stage was offered, and the model answered without calling one of
    # them. That is the skip this shape exists to prevent, so re-offer the
    # missed verb ONCE — bounded by `stage_retried`, so a model that declines
    # twice gets to answer rather than looping.
    if _stage_re_offer_due(state):
        return "stage_catalog"
    return "synthesize"


def route_after_stage_tools(state: AgentState) -> str:
    """Advance to the next stage, or close the chain with the answer round."""
    if state.get("cancelled", False):
        return "synthesize"
    # The shared runaway backstop, NOT 0. Defaulting to 0 made this router fail
    # CLOSED on any state without `max_rounds` — one tool round and out — while
    # `graph.route_after_tools` defaults to the backstop and fails open. Two
    # routers disagreeing about the same missing key is a bug generator.
    if state.get("round", 0) >= state.get("max_rounds", AGENT_ROUND_BACKSTOP):
        return "synthesize"
    spec = get_agent(state.get("agent_id", ""))
    if state.get("stage", 0) < len(spec.flow.stages):
        return "stage_catalog"
    # Every stage was OFFERED, but a side tool spent one of them: `stage` counts
    # offers, and a `flow.keep` verb advances the chain exactly as the staged one
    # does. Same single re-offer the declined-stage exit gets
    # (`_stage_re_offer_due`) — without it the chain could close with its own
    # verb never called.
    if _stage_re_offer_due(state):
        return "stage_catalog"
    return "force_final"


async def check_result(state: AgentState) -> dict[str, Any]:
    """Read the last tool result for a failure the model should be shown.

    The code-assistant tutorial's own A/B is the reason this is a predicate and
    not a reflection call: feeding the RAW error back beat asking a model to
    reflect on it first, which is why the shipped default there is
    "do not reflect". So this node adds no model call — it decides whether the
    NEXT one is worth spending.

    `verify_claims` asks "did a write land?"; this asks "did the thing we ran
    actually work?" — a script whose traceback is sitting in the transcript
    while the agent reports success is the failure mode.
    """
    spec = get_agent(state.get("agent_id", ""))
    attempted = set(state.get("attempted", set()))
    if _needs_transcription_terminal_check(spec.id, attempted):
        return _check_transcription_terminal(state)
    receipt_result = _receipt_check_result(state, spec.flow, attempted)
    if receipt_result is not None:
        return receipt_result
    return _failure_check_result(state, spec.flow)
