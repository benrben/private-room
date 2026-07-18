"""The round loop, as a LangGraph ``StateGraph`` (SPEC §3.2).

    START -> prepare -> call_model --(tools asked for)--> execute_tools --+
                            |                                   |         |
                            | (no calls / last / cancelled)     |         |
                            v                                   |         |
                        synthesize <---------(cancelled)--------+         |
                            |                                             |
                           END                    <-- next round ---------+

Every branch below is a product decision carried over from the Rust ``agent_loop``,
and each one exists because the naive version misbehaved on a 4B local model:

* **The final round offers ZERO tools.** Otherwise the loop's last act is a
  side-effect call whose result nobody ever reads, and the user gets no answer.
  A tool-less round forces a text answer grounded in the results already in hand.
* **Only SUCCESSFUL calls are memoised.** A failed call is not in ``seen``, so
  the model may re-attempt it in a LATER round — transient failures shouldn't be
  permanent. This is NOT a hard "one retry" cap: a call that keeps failing can be
  re-attempted once per round, bounded only by the round budget, until synthesis.
* **An all-duplicate round forces synthesis.** If every call this round was an
  exact repeat, the model is looping; spending the remaining budget on repeats
  helps nobody, so the next round is the tool-less one.
* **Cancellation is checked between rounds AND between tool calls.** Stop must
  stop, not "stop after the next 90-second tool".
* **Captured pixels come back as a USER message.** Ollama reads images from user
  turns, not tool turns — attach them to a tool message and the model is blind.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from .budget import json_chars, trim_messages_to_budget
from .chat import ChatModel
from .config import MAX_TOOL_ROUNDS, RunRequest
from .labels import tool_step_label
from .mcp_client import McpClient, ToolResult
from .messages import (
    Message,
    ToolCall,
    assistant_message,
    tool_message,
    user_message,
)
from .prompts import (
    DONE_TEXT,
    IMAGE_HANDOFF,
    JOBS_PROMPT,
    NEAR_BUDGET_NOTE,
    UI_PROMPT,
    duplicate_call_note,
)
from .routing import (
    FORBIDDEN_TOOL_NAMES,
    JOB_TOOL_NAMES,
    UI_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    lane_label,
)

#: An event emitted to the Rust host (SPEC §4).
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


class CancelToken:
    """The ask's Stop button, seen from inside the loop."""

    __slots__ = ("_cancelled",)

    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def __bool__(self) -> bool:  # pragma: no cover - convenience
        return self._cancelled


@dataclass(slots=True)
class Deps:
    """Everything the graph needs that isn't state: the model, the bridge, the
    event sink and the Stop flag. Passed through ``config.configurable`` so the
    graph itself stays a pure, compiled, reusable object."""

    chat: ChatModel
    emit: Emit
    cancel: CancelToken = field(default_factory=CancelToken)
    mcp: McpClient | None = None


class AgentState(TypedDict, total=False):
    """The round loop's state."""

    # --- inputs
    question: str
    web_enabled: bool
    write: bool
    ui: bool
    jobs: bool
    max_rounds: int

    # --- derived once, in `prepare`
    tools: list[dict[str, Any]]
    tools_chars: int

    # --- the running loop
    messages: list[Message]
    seen: set[tuple[str, str]]
    force_synthesis: bool
    round: int
    calls: list[ToolCall]
    pending_images: list[str]
    final_text: str
    cancelled: bool
    #: set by `call_model` when this round is the last one (no calls / cancelled /
    #: tool-less round) — the router reads it.
    stop: bool


# --------------------------------------------------------------------------- #
# nodes
# --------------------------------------------------------------------------- #


def _deps(config: RunnableConfig) -> Deps:
    deps = (config or {}).get("configurable", {}).get("deps")
    if not isinstance(deps, Deps):  # pragma: no cover - misuse
        raise RuntimeError("graph invoked without Deps in config.configurable")
    return deps


def _filter_catalog(
    specs: list[dict[str, Any]], *, write: bool, ui: bool, jobs: bool
) -> list[dict[str, Any]]:
    """Apply the deterministic routers to whatever the bridge served us.

    ADD-22/25/32: a small model picks the right tool far more reliably from a
    short, relevant list. Connected third-party MCP tools are namespaced
    ``server_tool`` and never collide with these names, so they are never
    filtered — the user connected those explicitly.

    ``consult_advisor`` is dropped here as well as in the MCP client: the
    recursion guard should not depend on one filter being remembered.
    """
    drop: set[str] = set(FORBIDDEN_TOOL_NAMES)
    if not write:
        drop |= set(WRITE_TOOL_NAMES)
    if not ui:
        drop |= set(UI_TOOL_NAMES)
    if not jobs:
        drop |= set(JOB_TOOL_NAMES)
    return [s for s in specs if s.get("function", {}).get("name") not in drop]


async def prepare(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Routing, the tool catalog, and the system-prompt appends."""
    deps = _deps(config)
    web_enabled = bool(state.get("web_enabled", False))
    write = bool(state.get("write", False))
    ui = bool(state.get("ui", False))
    jobs = bool(state.get("jobs", False))

    # ADD-22: let the user see which lane the deterministic router chose, so an
    # odd answer is explainable ("oh, it thought I wanted an edit"). Use the
    # RESOLVED routing (the host's override may differ from the question-derived
    # routers, and the catalog below is filtered by these same booleans) so the
    # chip can never claim "Using the app" while the UI tools were withheld.
    await deps.emit({"t": "lane", "v": lane_label(ui=ui, write=write, web_enabled=web_enabled)})

    # Never hardcode the catalog — the host decides our trust scope (SPEC §2.1).
    served = await deps.mcp.list_tools() if deps.mcp is not None else []
    tools = _filter_catalog(
        [s.to_ollama() for s in served], write=write, ui=ui, jobs=jobs
    )

    messages: list[Message] = [dict(m) for m in state.get("messages", [])]  # type: ignore[misc]
    offered = {s.get("function", {}).get("name") for s in tools}
    if messages and messages[0].get("role") == "system":
        # Only describe tools the model actually has this turn — telling it about
        # tools it wasn't given teaches it to hallucinate calls.
        if jobs and offered & set(JOB_TOOL_NAMES):
            messages[0]["content"] = (messages[0].get("content") or "") + JOBS_PROMPT
        if ui and offered & set(UI_TOOL_NAMES):
            messages[0]["content"] = (messages[0].get("content") or "") + UI_PROMPT

    return {
        "tools": tools,
        "tools_chars": json_chars(tools),
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "cancelled": deps.cancel.cancelled,
        "stop": False,
    }


async def call_model(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """One model round: trim, announce, stream."""
    deps = _deps(config)

    # ADD-7: stop between rounds too.
    if deps.cancel.cancelled:
        return {"cancelled": True, "stop": True, "calls": []}

    rnd = state.get("round", 0)
    max_rounds = state.get("max_rounds", MAX_TOOL_ROUNDS)
    # CHG-0/CHG-32: the final round (and any forced synthesis) is tool-less, so
    # the loop always ends with a text answer grounded in prior results.
    last = (rnd + 1 == max_rounds) or bool(state.get("force_synthesis", False))

    messages: list[Message] = state["messages"]
    tools: list[dict[str, Any]] = state.get("tools", [])
    # CHG-4/CHG-30: keep the running context within budget before sending.
    trim_messages_to_budget(messages, state.get("tools_chars", 0))

    # CHG-5: a fresh model round begins — the frontend clears its live text, so
    # what the user sees is always exactly the current round's words.
    await deps.emit({"t": "round"})

    offered: list[dict[str, Any]] = [] if last else tools

    async def on_delta(d: str) -> None:
        await deps.emit({"t": "delta", "v": d})

    content, calls = await deps.chat.stream(messages, offered, on_delta, deps.cancel)

    cancelled = deps.cancel.cancelled
    stop = last or cancelled or not calls
    return {
        "messages": messages,
        "final_text": content,
        "calls": [] if stop else calls,
        "cancelled": cancelled,
        "stop": stop,
    }


async def _run_one_tool(deps: Deps, call: ToolCall) -> ToolResult:
    if deps.mcp is None:
        return ToolResult(text="no room bridge is available", is_error=True)
    return await deps.mcp.call_tool(call.name, call.arguments)


async def execute_tools(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Run this round's calls, with duplicate suppression and image handoff."""
    deps = _deps(config)
    messages: list[Message] = state["messages"]
    seen: set[tuple[str, str]] = set(state.get("seen", set()))
    calls: list[ToolCall] = state.get("calls", [])
    rnd = state.get("round", 0)
    max_rounds = state.get("max_rounds", MAX_TOOL_ROUNDS)

    messages.append(assistant_message(state.get("final_text", ""), calls))

    # Penultimate round: nudge the small model to wrap up next turn.
    near_budget = rnd + 2 >= max_rounds
    all_dup = True
    cancelled = deps.cancel.cancelled
    # Pixels captured this round, drained into a user message as soon as they
    # appear (mirrors the Rust `effects.pending_images`).
    pending_images: list[str] = list(state.get("pending_images", []))

    for call in calls:
        # ADD-7: stop between tool calls.
        if deps.cancel.cancelled:
            cancelled = True
            break
        key = call.key()
        if key in seen:
            # CHG-3: don't re-run an identical call or re-flood the context.
            messages.append(tool_message(duplicate_call_note(call.name), call.name, call.id))
            continue
        all_dup = False

        # CHG-5: a human step label, not inline "⚙ name…" answer text.
        await deps.emit({"t": "step", "v": tool_step_label(call.name)})
        outcome = await _run_one_tool(deps, call)
        ok = not outcome.is_error
        # ADD-22: tell the UI whether the step succeeded, so a failed chip doesn't
        # look identical to a successful one.
        await deps.emit({"t": "step_status", "ok": ok})

        if ok:
            # Only remember successful calls, so a failed one may be re-attempted
            # in a later round (bounded by the round budget, not a single-retry cap).
            seen.add(key)
            result = outcome.text
        else:
            result = f"Tool error: {outcome.text}"

        if near_budget:
            result += NEAR_BUDGET_NOTE

        messages.append(tool_message(result, call.name, call.id))

        # ADD-25: a perception tool captured pixels. Hand them to the (vision-
        # capable) chat model as a USER message right after the tool result —
        # Ollama reads images from user turns, not tool turns.
        pending_images.extend(outcome.images)
        if pending_images:
            messages.append(user_message(IMAGE_HANDOFF, pending_images))
            pending_images = []

    # A round of only repeats means the model is stuck: force a tool-less
    # synthesis next round instead of looping until the budget runs out.
    force_synthesis = bool(state.get("force_synthesis", False)) or all_dup

    return {
        "messages": messages,
        "seen": seen,
        "force_synthesis": force_synthesis,
        "round": rnd + 1,
        "calls": [],
        "pending_images": pending_images,
        "cancelled": cancelled or deps.cancel.cancelled,
    }


async def synthesize(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Settle the final text and emit it."""
    deps = _deps(config)
    cancelled = bool(state.get("cancelled", False)) or deps.cancel.cancelled
    final_text = state.get("final_text", "") or ""
    # Don't invent "Done." over a partial answer the user stopped. After the
    # tool-less final round this is a genuine dead-path net, not the outcome.
    if not final_text.strip() and not cancelled:
        final_text = DONE_TEXT
    await deps.emit({"t": "final", "v": final_text})
    return {"final_text": final_text, "cancelled": cancelled}


# --------------------------------------------------------------------------- #
# edges
# --------------------------------------------------------------------------- #


def route_after_model(state: AgentState) -> str:
    """No calls, cancelled, or the tool-less round -> we're done talking."""
    return "synthesize" if state.get("stop", False) else "execute_tools"


def route_after_tools(state: AgentState) -> str:
    """Next round — unless Stop was pressed, or the backstop is exhausted."""
    if state.get("cancelled", False):
        return "synthesize"
    if state.get("round", 0) >= state.get("max_rounds", MAX_TOOL_ROUNDS):
        # Unreachable by construction (the round before last is tool-less and
        # breaks), but a runaway backstop should not depend on that proof.
        return "synthesize"
    return "call_model"


def build_graph() -> Any:
    """Compile the round loop. Pure: no model, no bridge, no I/O bound in."""
    g: StateGraph = StateGraph(AgentState)
    g.add_node("prepare", prepare)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "call_model")
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
    return g.compile()


#: Compiled once — the graph is stateless, every run carries its own Deps.
AGENT_GRAPH = build_graph()


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #


async def run_agent(req: RunRequest, deps: Deps) -> str:
    """Run one ask to completion. Emits SPEC §4 events through ``deps.emit``."""
    write, ui, jobs = req.resolved_routing()
    max_rounds = req.resolved_max_rounds(ui, jobs)

    initial: AgentState = {
        "question": req.question,
        "web_enabled": req.web_enabled,
        "write": write,
        "ui": ui,
        "jobs": jobs,
        "max_rounds": max_rounds,
        "messages": [dict(m) for m in req.messages],  # type: ignore[misc]
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "cancelled": False,
        "stop": False,
    }
    # Two super-steps per round (call_model + execute_tools), plus prepare and
    # synthesize, plus slack. The loop self-terminates long before this.
    recursion_limit = 2 * max_rounds + 10
    config = {
        "configurable": {"deps": deps},
        "recursion_limit": recursion_limit,
    }
    final: AgentState = await AGENT_GRAPH.ainvoke(initial, config=config)  # type: ignore[arg-type]
    return final.get("final_text", "") or ""


async def stream_events(req: RunRequest, deps_factory: Callable[[Emit], Deps]):
    """Async iterator of SPEC §4 events for one run — what the server streams.

    The graph pushes events onto a queue as it goes; this drains the queue while
    the graph runs, so the user sees deltas as they are generated rather than
    after the whole ask completes.
    """
    queue: asyncio.Queue[Event | None] = asyncio.Queue()

    async def emit(event: Event) -> None:
        await queue.put(event)

    deps = deps_factory(emit)

    async def driver() -> None:
        try:
            await run_agent(req, deps)
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            raise
        except Exception as exc:  # noqa: BLE001 - any failure must reach the host
            await queue.put({"t": "error", "v": str(exc)})
        finally:
            await queue.put(None)

    task = asyncio.create_task(driver())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


__all__ = [
    "AGENT_GRAPH",
    "AgentState",
    "CancelToken",
    "Deps",
    "Event",
    "build_graph",
    "call_model",
    "execute_tools",
    "prepare",
    "route_after_model",
    "route_after_tools",
    "run_agent",
    "stream_events",
    "synthesize",
]
