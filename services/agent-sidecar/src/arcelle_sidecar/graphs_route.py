"""Perception trimming and deterministic action routing nodes."""

from __future__ import annotations

from typing import Any

from .agents import Action, get_agent
from .config import AGENT_ROUND_BACKSTOP
from .graph import AgentState
from .graphs_verify import narrowed
from .messages import Message

STALE_IMAGE = "[earlier screenshot — superseded by the current one below]"


async def trim_images(state: AgentState) -> dict[str, Any]:
    """Keep ONE live screenshot in context; strip the pixels from the rest.

    WebVoyager's shipped answer to the same problem. Every capture lands as a
    user message carrying base64 pixels (``IMAGE_HANDOFF``), and under a plain
    tool-calling loop they ACCUMULATE — one per action — inside a
    payload-fitted ``num_ctx``. That is the context-shift failure class already
    diagnosed in this repo on 2026-07-23 (the Ollama 4k default window: big
    turns silently truncated, producing "Done." and fabrications).

    A stale screenshot is also actively misleading: it shows a UI state that no
    longer exists, and the model cannot tell which one is current from pixels
    alone. So the fix is not only cheaper, it is more correct.
    """
    messages: list[Message] = list(state.get("messages", []))
    bearing = [i for i, m in enumerate(messages) if m.get("images")]
    if len(bearing) <= 1:
        return {}
    trimmed = list(messages)
    for i in bearing[:-1]:
        stale = dict(trimmed[i])
        stale.pop("images", None)
        stale["content"] = STALE_IMAGE
        trimmed[i] = stale
    return {"messages": trimmed}


def route_after_perceive(state: AgentState) -> str:
    """Cancellation is checked here too — a perceive round is still a round."""
    if state.get("cancelled", False):
        return "synthesize"
    # The shared backstop, NOT 0 — see route_after_stage_tools. Failing closed
    # on a missing key ended a UI task after its first capture.
    if state.get("round", 0) >= state.get("max_rounds", AGENT_ROUND_BACKSTOP):
        return "synthesize"
    return "trim_images"


def _action_scores(actions: tuple[Action, ...], ask: str) -> dict[str, int]:
    """Count each action's routing hints in the normalized question."""
    return {action.tool: _hint_score(action.hints, ask) for action in actions}


def _hint_score(hints: tuple[str, ...], ask: str) -> int:
    """Return how many of an action's hint fragments the ask contains."""
    return sum(hint in ask for hint in hints)


def _unambiguous_winner(scores: dict[str, int]) -> str:
    """Return the sole positive leader, or abstain from narrowing."""
    best = max(scores.values(), default=0)
    if best == 0:
        return ""
    winners = [tool for tool, score in scores.items() if score == best]
    if len(winners) != 1:
        return ""
    return winners[0]


def _tool_name(tool: dict[str, Any]) -> str:
    """Read an OpenAI-function tool's name, tolerating malformed entries."""
    return str((tool.get("function") or {}).get("name") or "")


def _routed_catalog(
    tools: list[dict[str, Any]], keep: set[str]
) -> list[dict[str, Any]]:
    """Keep routing resolvers and the one action selected for this ask."""
    return [tool for tool in tools if _tool_name(tool) in keep]


def _catalog_contains(tools: list[dict[str, Any]], target: str) -> bool:
    """Whether the bridge actually served the action we selected."""
    return any(_tool_name(tool) == target for tool in tools)


async def route_action(state: AgentState) -> dict[str, Any]:
    """Pick the one terminal verb this ask wants, in plain Python.

    LangGraph's Router pattern is explicitly "a single LLM call **or
    rule-based logic**", and rule-based is the reliable arm here: a
    deterministic pick is 100% reproducible where a 4B's is roughly 22% on a
    multi-turn agency round. Studio's three generators and the Jobs agent's two
    verbs are mutually exclusive, and the vocabulary that separates them is
    already written — it is the ``Action.hints`` tuple.

    Narrowing the catalog to ONE verb turns the round from "choose among ~21
    tools, then fill arguments" into "fill arguments", which is the single
    regime small models are measured frontier-grade at.

    Deliberately abstains. On a tie, or a zero score, it returns ``{}`` and the
    model sees the full box exactly as it does today. A router that guessed
    would be worse than no router: the other verbs are no longer in the catalog,
    so a wrong narrow is unrecoverable. Narrow only when it is unambiguous.
    """
    spec = get_agent(state.get("agent_id", ""))
    actions = spec.flow.actions
    if not actions:
        return {}

    ask = (state.get("question", "") or "").lower()
    target = _unambiguous_winner(_action_scores(actions, ask))
    if not target:
        return {}

    keep = set(spec.flow.keep) | {target}
    routed = _routed_catalog(state.get("tools", []), keep)
    # Never narrow to nothing: if the bridge did not serve the routed verb this
    # run, the full box is strictly better than an empty catalog.
    if not _catalog_contains(routed, target):
        return {}
    return {"tools": narrowed(state, routed), "routed": target}


# --------------------------------------------------------------------------- #
# shape builders
# --------------------------------------------------------------------------- #


def route_after_react_prepare(state: AgentState) -> str:
    """Run a deterministic delegation prepared by Arcelle before any model.

    Ordinary react/supervisor turns still enter ``call_model``.  The one
    prepared-call case is Main's high-confidence visual-video delegation; it
    goes through the normal ``execute_tools`` hub path, so privacy refusal,
    roster accounting and the media.video child remain identical to a model-
    authored ``ask_file_agent`` call.
    """
    return "execute_tools" if state.get("calls") else "call_model"
