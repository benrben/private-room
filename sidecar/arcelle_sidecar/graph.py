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
  re-attempted once per round, bounded only by the runaway backstop, until
  synthesis.
* **An all-duplicate round forces synthesis.** If every call this round was an
  exact repeat, the model is looping; spending the remaining budget on repeats
  helps nobody, so the next round is the tool-less one.
* **Cancellation is checked between rounds AND between tool calls.** Stop must
  stop, not "stop after the next 90-second tool".
* **Captured pixels come back as a USER message.** Ollama reads images from user
  turns, not tool turns — attach them to a tool message and the model is blind.

2026-07-23, hub v3 (owner decisions; evidence in
pm-request/small-model-agent-reliability-2026-07-23.md and
pm-request/dispatch-first-agent-proposal-2026-07-23.md):

* **The MAIN AGENT delegates; workers act.** ``run_agent`` runs ONE loop: the
  Main agent's, whose whole catalog is its specialists (``ask_*_agent``, ≤6
  domain tools). ``execute_tools`` intercepts each delegation and runs that
  worker's own scoped sub-loop through this same graph; only the worker's
  REPORT joins the main thread. Things the Main agent knows (greetings,
  general knowledge) it answers directly — no delegation, no tools. Every
  delegation emitted in ONE round runs in PARALLEL: the whole batch is
  launched before any of it is awaited, and the reports are collected in call
  order, so a round costs the slowest child rather than the sum. The referent
  baton (``state["referents"]`` → ``delegation_note``) tells each worker what
  EARLIER rounds' specialists produced — siblings in one batch run blind to
  each other, and their batons are merged once the batch completes.
* **Sub-agents are DATA** (:mod:`.agents`): CORE (the base-prompt-taught
  read+write set — never filtered, or the catalog contradicts the prompt:
  "I can't save files") plus the active agent's ≤6-tool box.
* **request_tools is the escape hatch** for WORKERS whose lane vocabulary was
  missed. Resolved locally — never sent to the bridge.
* **Children are ad-hoc ``ainvoke``s inside this node, NOT subgraph nodes of the
  hub's compiled graph** (reviewed 2026-07-27). The docs' subagents page wires
  children as real subgraph nodes, and doing that here would let
  ``route_after_tools`` read a child's outcome directly instead of receiving it
  through a return tuple. It was NOT done, for a reason worth writing down: the
  worker a delegation resolves to is chosen at RUN TIME by ``resolve_worker``
  across fourteen agents and seven wirings, so making them nodes means either a
  node per worker in the hub graph or a ``Send`` fan-out whose target must be
  static — and either way ``execute_tools``, the one function every shape shares
  and where SPEC §3.2's invariants live, has to split. The two benefits are
  already covered another way: Studio sees every worker graph (``langgraph.json``
  registers all fourteen agents and all shapes by name), and the UI sees the live
  tree through the ``plan``/``agent`` events with per-node keys and batch numbers.
  What remains is internal tidiness, which is not worth destabilising the loop.
* **Small-local mode** (plain Ollama model, no provider/:cloud): rounds are
  capped to ONE tool call (FC mode is measurably unreliable on parallel calls),
  and the turn's verified action log is re-injected each round as an ephemeral
  USER note (a trailing system note silences qwen-class templates — the
  "Done." live-QA regression).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypedDict

from langchain_core.runnables import RunnableConfig

from .budget import json_chars
from .chat import ChatModel
from .usage import build_usage_event, categorize_messages
from .config import AGENT_ROUND_BACKSTOP, RunRequest
from .labels import tool_step_label
from .mcp_client import McpClient, ToolResult
from .messages import (
    Message,
    ToolCall,
    assistant_message,
    tool_message,
    user_message,
)
from .privacy import is_nonlocal_model
from .prompts import (
    SKILLS_NOTE,
    DONE_TEXT,
    EMPTY_PLAN_NOTE,
    IMAGE_HANDOFF,
    TOOL_GROUP_LABELS,
    TOOL_GROUPS_PROMPT,
    correction_note,
    delegation_note,
    duplicate_call_note,
    request_tools_spec,
    turn_progress_note,
    unlocked_note,
)
from .agents import (
    AGENT_TOOL_NAMES,
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    DOMAIN_KEYS,
    GROUPS,
    MAIN_AGENT_ID,
    agent_tool_specs,
    get_agent,
    group_prompt,
    group_tools,
    toolbox_for,
)
from .manager import resolve_worker
from .routing import ADVISOR_TOOL_NAMES, lane_label

#: An event emitted to the Rust host (SPEC §4).
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


#: The Main agent's node identity in the turn's agent graph (see
#: ``AgentState.node_key``). Workers get ``"<agent_id>#<pipeline slot>"``; the
#: hub is a singleton, so it gets a fixed name the UI can root the graph on.
MAIN_NODE_KEY = "main"


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


class _NullSlot:
    """The unbounded case, shaped like a semaphore so the call site has no
    branch — a cloud room holds no resident model and wants every child at once."""

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *exc: Any) -> None:
        return None


_NULL_SLOT = _NullSlot()


@dataclass(slots=True)
class Deps:
    """Everything the graph needs that isn't state: the model, the bridge, the
    event sink and the Stop flag. Passed through ``config.configurable`` so the
    graph itself stays a pure, compiled, reusable object."""

    chat: ChatModel
    emit: Emit
    cancel: CancelToken = field(default_factory=CancelToken)
    mcp: McpClient | None = None
    #: How many delegated children may hold a model round AT ONCE.
    #:
    #: A local room runs ONE resident model, so N concurrent children do not
    #: give N-way throughput — they queue inside the Ollama daemon and, worse,
    #: inflate the payload each of them fits a window to. `wf_nodes.NodeDeps`
    #: already carries exactly this knob for the workflow lanes and defaults it
    #: to 1 for the same reason; the hub's fan-out shipped unbounded, which is
    #: the gap. Cloud engines have no resident model, so the caller raises it.
    #: 0/None means unbounded, which is what a cloud room wants.
    worker_parallel: int | None = None
    _worker_sem: Any = field(default=None, repr=False, compare=False)

    def worker_slot(self) -> Any:
        """An async context manager bounding concurrent children (or a no-op)."""
        if not self.worker_parallel or self.worker_parallel <= 0:
            return _NULL_SLOT
        if self._worker_sem is None:
            self._worker_sem = asyncio.Semaphore(self.worker_parallel)
        return self._worker_sem


class AgentState(TypedDict, total=False):
    """The round loop's state."""

    # --- inputs
    question: str
    web_enabled: bool
    write: bool
    advisors: bool
    max_rounds: int
    #: The REQUEST's ceiling — the shared runaway backstop, and since the
    #: per-agent round budgets were removed, the ONLY bound on a run. Workers
    #: take their `max_rounds` straight from this.
    run_max_rounds: int
    #: 2026-07-23 (BFCL-informed): a small LOCAL model is frontier-grade at
    #: single tool calls but collapses on multi-turn agency — so its rounds are
    #: capped to ONE call and its turn progress is re-injected every round.
    small_model: bool
    #: The ACTIVE sub-agent (agents.py registry id) — set per plan step by
    #: run_agent; prepare scopes the catalog and prompt from it.
    agent_id: str
    #: This loop's UNIQUE node identity in the turn's agent graph — `"main"`
    #: for the Main agent, `"<agent_id>#<pipeline slot>"` for a worker. The
    #: registry id alone cannot address a node: a round may dispatch two
    #: `files.read` children in parallel, and the UI has to attribute each
    #: `step` event to the right one. Rides on every emit from this loop.
    node_key: str
    #: True while executing a MULTI-step plan: non-connectors steps then hold
    #: the always-on connector proxy pair so a step can't jump the queue and
    #: send before earlier steps finish (live e2e caught exactly that).
    plan_multi: bool
    #: request_tools groups opened mid-turn (monotonic within the step).
    unlocked_groups: set[str]
    #: The referent baton: artifacts produced by EARLIER specialists this turn
    #: ("file created: X"), injected into the next delegation's kickoff note by
    #: code — the model never has to remember cross-agent state.
    referents: list[str]
    #: The FINDINGS baton, hub loop only: what specialists REPORTED in EARLIER
    #: rounds of this turn, as ``(label, report text)``.
    #:
    #: `referents` carries artifact NAMES, which is enough to open a file a
    #: sibling wrote but not enough to reason about what a sibling READ. Batch
    #: tasks already get findings through `depends_on` (`upstream=`); a
    #: round-to-round chain — "find X", then next round "act on X", which is
    #: exactly what a 4B produces when it does not emit a well-formed plan — got
    #: nothing, and depended on the hub restating the finding in its own
    #: instruction. That is the one thing this design says no model should have
    #: to do.
    reports: list[tuple[str, str]]
    #: Artifacts THIS loop produced, seeded empty for every worker — the same
    #: per-loop discipline `attempted` already has, and for the same reason.
    #:
    #: `graphs.verify_claims` must read THIS, never `referents`: a child is
    #: seeded with the parent's baton, and the gate passes whenever the baton is
    #: non-empty, so every delegation after the first silently lost its
    #: write-claim check. Verified — identical run with a FAILED create_file:
    #: baton [] raised a correction, baton ['create_file: earlier.md'] raised
    #: none. That is the "summarize the lease, then save the notes" shape, where
    #: the unchecked step is the one that writes.
    produced: list[str]
    #: Hub v3 — the MAIN loop only. Specialists invoked so far this ask, in
    #: call order (``{"agent": id, "instruction": …}`` each) — drives the
    #: growing pipeline roster the UI renders.
    pipeline: list[dict[str, str]]
    #: Hub v3 — the conversation as it stood BEFORE the main loop started;
    #: each worker sub-loop builds its context from this (system + history +
    #: delegation note), never from the main loop's tool-call thread.
    worker_base_messages: list[Message]

    # --- derived once, in `prepare`
    tools: list[dict[str, Any]]
    #: The full catalog the bridge served, pre-filter — request_tools rebuilds
    #: the offered subset from this when the model unlocks a group mid-turn.
    served_specs: list[dict[str, Any]]

    # --- the running loop
    messages: list[Message]
    #: Duplicate-suppression memo, `name|canonical-args` (see ToolCall.key).
    #: MUST stay set[str]: set[tuple] serialises to None through LangGraph's
    #: JsonPlusSerializer, silently, so a checkpointed resume loses it.
    seen: set[str]
    #: Tool NAMES executed this turn, successful or not. `seen` deliberately
    #: holds only successes (so a failed call may be retried), which means it
    #: cannot answer "did the model try to write?" — and that is precisely the
    #: question a ground-truth check has to ask. Keep it set[str] for the same
    #: serde reason as `seen`.
    attempted: set[str]
    force_synthesis: bool
    round: int
    calls: list[ToolCall]
    pending_images: list[str]
    final_text: str
    #: One line per executed call this turn ("search_room(query=rent) -> ok") —
    #: the deterministic action log turn_progress_note re-injects each round.
    progress: list[str]
    #: Ground-truth findings raised by a shape's `verify` node — a contradiction
    #: between what the model is about to claim and what the tools actually did.
    #: Re-injected EVERY engine, unlike `progress`: a correction is a fact about
    #: this turn, not a small-model crutch.
    corrections: list[str]
    #: `verify` ran (so it never fires twice) / the model has had its one
    #: tool-less round to answer a correction (so the gate cannot loop).
    verified: bool
    corrected: bool
    #: `check_result` (the recall_act_check shape): the result check has run
    #: this round, how many bounded repair rounds it has spent, and whether the
    #: repair round has already been taken — together they keep the check from
    #: firing twice and the repair from looping.
    checked: bool
    repairs: int
    repaired: bool
    #: `check_result`'s decision for `route_after_check`, recomputed every visit.
    #: The gate used to be a LATCH (`checked` -> `repaired` -> stop), which made
    #: `repair_cap` a boolean: the two agents declaring 2 were given 1. The node
    #: owns the decision now and the router only reads it.
    repair_needed: bool
    cancelled: bool
    #: The verb `route_action` narrowed this turn to ("" = it abstained).
    routed: str
    #: Set by a node that SYNTHESIZED this round's calls (`probe`), cleared by
    #: `execute_tools` once it has recorded the turn.
    synth: bool
    #: Indices into `messages` of assistant turns whose tool_calls the GRAPH
    #: produced, not the model.
    #:
    #: They are indistinguishable otherwise — `execute_tools` appends the same
    #: `assistant_message(text, calls)` either way — and that ambiguity is a
    #: trap for anything that reads a trajectory back: a fine-tune built on raw
    #: transcripts would learn to emit the very calls the graph already makes
    #: for free, then burn a round on the duplicate at inference. Recording the
    #: indices makes a turn self-describing instead.
    synth_turns: list[int]
    #: `chain_stage`: how many one-tool stages have been offered so far.
    stage: int
    #: `chain_stage`: the missed-verb re-offer has been spent. MUST be declared
    #: here — LangGraph filters a node's returned dict against this schema and
    #: SILENTLY DROPS unknown keys, so an undeclared flag would read False
    #: forever and the re-offer would loop until the backstop.
    stage_retried: bool
    #: The agent's FULL box, preserved across stages so each one narrows from
    #: the whole catalog rather than from its predecessor's narrowed view.
    full_tools: list[dict[str, Any]]
    #: set by `call_model` when this round is the last one (no calls / cancelled /
    #: tool-less round) — the router reads it.
    stop: bool


# --------------------------------------------------------------------------- #
# nodes
# --------------------------------------------------------------------------- #


#: DEV-ONLY seam for ``langgraph dev``. Studio can only send JSON state, and a
#: ChatModel / McpClient / emit sink are not JSON, so a Studio run has no way to
#: supply :class:`Deps` through ``config.configurable``.
#:
#: Pre-binding with ``graph.with_config({"configurable": {"deps": …}})`` works on
#: langgraph-api 0.9.x but is DROPPED by 0.4.x, which re-resolves the graph from
#: its spec and discards the binding — a Studio run then dies in ``prepare``
#: with the RuntimeError below. So the hook is a plain module attribute, which
#: no version of the API can plumb away.
#:
#: NOTHING in the shipped package assigns this (pinned by
#: ``test_nothing_in_the_package_sets_the_studio_deps_hook``), and
#: ``devtools/`` is excluded from the PyInstaller bundle, so in the app it stays
#: None and a genuinely unwired graph still raises.
STUDIO_DEPS: Deps | None = None


def _deps(config: RunnableConfig) -> Deps:
    deps = (config or {}).get("configurable", {}).get("deps")
    if isinstance(deps, Deps):
        return deps
    if STUDIO_DEPS is not None:  # pragma: no cover - dev-only path
        return STUDIO_DEPS
    raise RuntimeError("graph invoked without Deps in config.configurable")


def _select_tools(
    served_specs: list[dict[str, Any]],
    *,
    agent_id: str,
    unlocked: set[str],
    advisors: bool,
    plan_multi: bool = False,
) -> list[dict[str, Any]]:
    """The offered catalog: CORE + the active sub-agent's box + any groups
    unlocked mid-turn, intersected with what the bridge served (agents.py).

    Connected third-party MCP tools are namespaced ``server_tool`` and never
    collide with registry names, so a name the registry doesn't know is kept —
    the user connected those explicitly. ``consult_advisor`` is retained only
    when Rust says this is an enabled top-level run.

    ``plan_multi``: during a MULTI-step plan the connector proxy pair
    (search_mcp_tools/run_mcp_tool — always offered on single-step turns so
    an unrouted ask can still reach a connector) is withheld from steps whose
    agent doesn't own it. Live e2e caught the 4B jumping ahead: with the pair
    visible during the jobs step it sent to Slack BEFORE starting the pass —
    exactly the ordering "pending sequential execution" exists to prevent.
    The connectors step of the plan still gets its box.
    """
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    keep = toolbox_for(agent_id, served_names)
    for group in unlocked:
        keep |= group_tools(group) & served_names
    # Every name the registry owns — NOT just the grouped ones. Testing against
    # the grouped subset let the eleven ungrouped registry tools fall through
    # the third-party escape hatch below and reach every agent.
    registry_names = ALL_REGISTRY_TOOLS | keep
    hold: set[str] = set()
    if plan_multi:
        hold = set(get_agent("connectors.use").tools) - keep
    out: list[dict[str, Any]] = []
    for s in served_specs:
        name = s.get("function", {}).get("name")
        if name in ADVISOR_TOOL_NAMES:
            if advisors:
                out.append(s)
        elif name in hold:
            continue
        elif name in keep or name not in registry_names:
            out.append(s)
    return out


def _locked_groups(served_names: set[str], current: set[str], unlocked: set[str]) -> list[str]:
    """request_tools groups still locked AND actually servable this run (an
    advisor-scope bridge never serves ui tools — offering an unlockable group
    would teach the model to hallucinate)."""
    return [
        g
        for g in GROUPS
        if g not in unlocked
        and (group_tools(g) & served_names)
        and not (group_tools(g) <= current)
    ]


async def prepare(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """The active sub-agent's toolbox, and the system-prompt appends."""
    deps = _deps(config)
    web_enabled = bool(state.get("web_enabled", False))
    write = bool(state.get("write", False))
    advisors = bool(state.get("advisors", False))
    agent = get_agent(str(state.get("agent_id", "")))
    unlocked: set[str] = set(state.get("unlocked_groups", set()))

    # ADD-22: let the user see which lane was chosen, so an odd answer is
    # explainable. The label follows the ACTIVE sub-agent (the catalog below is
    # scoped by the same spec), so the chip can never claim "Using the app"
    # while the UI tools were withheld. The main agent's synthesis turn emits
    # no lane — the agent strip already names it, and it opens no toolbox.
    if not agent.main:
        await deps.emit(
            {
                "t": "lane",
                "v": lane_label(ui=agent.id == "app.ui", write=write, web_enabled=web_enabled),
            }
        )

    # Never hardcode the catalog — the host decides our trust scope (SPEC §2.1).
    served = await deps.mcp.list_tools() if deps.mcp is not None else []
    served_specs = [s.to_ollama() for s in served]
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    # Hub v3: the MAIN agent's only tools are its specialists — the
    # ask_*_agent catalog (≤6 entries, one per reachable domain). It never
    # sees a room tool; acting is what workers are for. (No request_tools
    # either: the specialists cover every unlockable lane.)
    tools = (
        agent_tool_specs(web_enabled=web_enabled, served_names=served_names)
        if agent.main
        else _select_tools(
            served_specs,
            agent_id=agent.id,
            unlocked=unlocked,
            advisors=advisors,
            plan_multi=bool(state.get("plan_multi", False)),
        )
    )

    messages: list[Message] = [dict(m) for m in state.get("messages", [])]  # type: ignore[misc]
    offered = {s.get("function", {}).get("name") for s in tools}
    # The escape hatch (2026-07-23): groups the manager left OFF (but the
    # bridge actually serves) stay reachable through one always-on mini-tool —
    # a lane the vocabulary missed is one trivial enum call away instead of
    # permanently invisible.
    locked = [] if agent.main else _locked_groups(served_names, offered, unlocked)
    if locked:
        tools.append(request_tools_spec(locked))
    if messages and messages[0].get("role") == "system":
        # Only describe tools the model actually has this turn — telling it
        # about tools it wasn't given teaches it to hallucinate calls. The
        # active sub-agent contributes its own paragraph; locked groups are
        # named ONLY at the group level (TOOL_GROUPS_PROMPT), so the model
        # keeps a stable self-image without unseen schemas.
        if (
            agent.prompt
            # served this scope — never describe unserved tools. The Main
            # agent's paragraph describes its ask_*_agent catalog instead,
            # which prepare just built (offered = its specialists).
            and (agent.main or set(agent.tools) & offered)
            and agent.prompt not in (messages[0].get("content") or "")
        ):
            messages[0]["content"] = (messages[0].get("content") or "") + agent.prompt
        # Skills sit one layer below the paragraph: the paragraph is who this
        # agent is and rides every turn; a skill is a saved procedure it loads
        # only when one applies. Workers only — the Main agent delegates rather
        # than executing procedures, and list_skills is not in its catalog.
        if (
            not agent.main
            and "list_skills" in offered
            and SKILLS_NOTE not in (messages[0].get("content") or "")
        ):
            messages[0]["content"] = (messages[0].get("content") or "") + SKILLS_NOTE
        if locked:
            messages[0]["content"] = (messages[0].get("content") or "") + TOOL_GROUPS_PROMPT.format(
                groups="; ".join(TOOL_GROUP_LABELS[g] for g in locked)
            )

    return {
        "tools": tools,
        "served_specs": served_specs,
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
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
    max_rounds = state.get("max_rounds", AGENT_ROUND_BACKSTOP)
    # CHG-0/CHG-32: the final round (and any forced synthesis) is tool-less, so
    # the loop always ends with a text answer grounded in prior results.
    last = (rnd + 1 == max_rounds) or bool(state.get("force_synthesis", False))

    messages: list[Message] = state["messages"]
    tools: list[dict[str, Any]] = state.get("tools", [])
    # CHG-5: a fresh model round begins — the frontend clears its live text, so
    # what the user sees is always exactly the current round's words.
    await deps.emit({"t": "round"})

    offered: list[dict[str, Any]] = [] if last else tools

    async def on_delta(d: str) -> None:
        await deps.emit({"t": "delta", "v": d})

    # Small-local mode (BFCL 2025, ICML): the dominant multi-turn failure of
    # small models is losing track of what already happened. Re-inject the
    # turn's verified action log as an EPHEMERAL note — rebuilt fresh each
    # round, never appended to history, so it can't accumulate or drift.
    # Role USER, not system: qwen-class chat templates go silent on a trailing
    # system message (live QA 2026-07-23, the "Done." regression), while a
    # bracketed user note is the exact pattern IMAGE_HANDOFF already proves.
    small = bool(state.get("small_model", False))
    progress: list[str] = list(state.get("progress", []))
    notes: list[str] = []
    if small and progress:
        notes.append(turn_progress_note(progress))
    # A ground-truth correction is NOT gated on `small`. It says the tools
    # disagree with what the model is about to claim, which a cloud engine can
    # be just as wrong about — and it is the whole point of a `verify` shape.
    corrections: list[str] = list(state.get("corrections", []))
    if corrections:
        notes.append(correction_note(corrections))
    to_send = messages + [{"role": "user", "content": n} for n in notes] if notes else messages

    content, calls, usage = await deps.chat.stream(to_send, offered, on_delta, deps.cancel)

    # A small local model used to be held to ONE call per round here (BFCL: FC
    # mode gets call COUNTS wrong ~4x more often than prompting does). That cap
    # is gone with the rest of the limits — and it was the one that mattered
    # most, because it meant the hub's parallel delegation could never fire on a
    # local model: every round the Main agent asked for three specialists, two
    # were silently dropped and re-asked a round later. The duplicate guard, not
    # a cap, is what stops a model that repeats itself.

    # Token-budget bar: categorize what was actually SENT this round (the tool
    # catalog offered this round, not the cached full-catalog `tools_chars` —
    # the tool-less final round offers none, and the breakdown must reflect that).
    breakdown_chars = categorize_messages(messages, json_chars(offered))
    await deps.emit({"t": "usage", **build_usage_event(rnd, usage, breakdown_chars)})

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


def _args_summary(arguments: dict[str, Any] | None, limit: int = 40) -> str:
    """Compact ``k=v`` recap of a call's arguments for the turn progress log."""
    items = list((arguments or {}).items())[:2]
    parts = [f"{k}={str(v)[:limit]}" for k, v in items]
    if arguments and len(arguments) > 2:
        parts.append("…")
    return ", ".join(parts)


def _unlock_group(
    group: str,
    state: AgentState,
    unlocked: set[str],
    messages: list[Message],
) -> tuple[str, bool, list[dict[str, Any]] | None]:
    """Handle one request_tools call. Returns (result text, ok, new tools or None)."""
    served_specs: list[dict[str, Any]] = list(state.get("served_specs", []))
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    if group not in GROUPS:
        return (
            f"Unknown tool group '{group}'. Valid groups: {', '.join(GROUPS)}.",
            False,
            None,
        )
    names = group_tools(group)
    if not served_names & names:
        # An advisor-scope bridge never serves these — don't pretend otherwise.
        return (f"The {group} tools are not available in this context.", False, None)

    unlocked.add(group)
    tools = _select_tools(
        served_specs,
        agent_id=str(state.get("agent_id", "")),
        unlocked=unlocked,
        advisors=bool(state.get("advisors", False)),
        plan_multi=bool(state.get("plan_multi", False)),
    )
    offered = {s.get("function", {}).get("name") for s in tools}
    still_locked = _locked_groups(served_names, offered, unlocked)
    if still_locked:
        tools.append(request_tools_spec(still_locked))
    # The group is unlocked, so NOW its system-prompt paragraph applies (same
    # doctrine as prepare: describe only tools the model actually has).
    prompt = group_prompt(group)
    if messages and messages[0].get("role") == "system" and prompt and prompt not in (
        messages[0].get("content") or ""
    ):
        messages[0]["content"] = (messages[0].get("content") or "") + prompt
    return unlocked_note(group, sorted(served_names & names)), True, tools


def _active_step(pipeline: list[dict[str, Any]]) -> int:
    """The 1-based slot the legacy single active marker points at.

    A batch runs several children at once, so "the active step" is no longer a
    single truth — this picks the FIRST still-running child (call order), and
    falls back to the Main agent's slot when none is running. Consumers that
    want the real picture read per-entry `status` off the roster instead.
    """
    for i, entry in enumerate(pipeline):
        if entry.get("status") == "running":
            return i + 1
    return len(pipeline) + 1


async def _emit_pipeline(
    deps: Deps, pipeline: list[dict[str, Any]], active_step: int
) -> None:
    """The growing roster + active marker. The roster is every specialist
    invoked so far (in call order) with the Main agent always LAST; the UI
    re-renders the graph on each plan event, so delegation visibly extends
    the pipeline as the Main agent works.

    Each entry carries its own `status` (pending/running/done/failed), a `batch`
    number (children dispatched in the SAME round share one — that is what makes
    parallelism legible), and a `key` that uniquely addresses the node (the
    registry id does not: one round can dispatch two `files.read` children).
    Every plan event is a COMPLETE snapshot, so a consumer needs no event
    ordering and no diffing — the last plan it saw is the whole truth. That
    matters: children emit concurrently, so relative order of their events is
    not guaranteed.
    """
    main = get_agent(MAIN_AGENT_ID)
    total = len(pipeline) + 1
    roster = [
        *(
            {
                "agent": entry["agent"],
                "label": get_agent(entry["agent"]).label,
                "instruction": entry["instruction"],
                "status": entry.get("status", "pending"),
                "batch": entry.get("batch", 0),
                "key": entry.get("key", f"{entry['agent']}#{i}"),
            }
            for i, entry in enumerate(pipeline)
        ),
        {
            "agent": main.id,
            "label": main.label,
            "instruction": "answer the user from the specialists' reports",
            # The hub is "running" only when it holds the turn itself; while its
            # children work it is waiting on them, which the UI draws as a
            # dimmed root rather than a third spinner competing for attention.
            "status": "running" if active_step == total else "pending",
            "batch": None,
            "key": MAIN_NODE_KEY,
        },
    ]
    active = roster[active_step - 1]
    await deps.emit({"t": "plan", "v": roster})
    await deps.emit(
        {
            "t": "agent",
            "v": {
                # Legacy single-marker fields — kept populated verbatim so the
                # old flat strip (and any other consumer) keeps working.
                "id": active["agent"],
                "label": active["label"],
                "step": active_step,
                "total": total,
                # The real picture: every slot running right now, 1-based.
                "active_steps": [
                    i + 1
                    for i, entry in enumerate(pipeline)
                    if entry.get("status") == "running"
                ]
                or [active_step],
            },
        }
    )


#: Tools whose success leaves an artifact worth recording in the baton, and
#: whose absence from the ledger is what `graphs.verify_claims` reads as "the
#: write did not land". MUST stay a superset of `graphs.WRITE_TOOLS` — a tool
#: that can trip the write-claim gate but cannot record a referent is a
#: guaranteed false accusation, which is exactly what `edit_files` and
#: `move_file` were until 2026-07-27.
LEDGER_TOOLS: frozenset[str] = frozenset(
    {
        "create_file",
        "write_file",
        "edit_file",
        "edit_files",
        "rename_file",
        "move_file",
        "set_cells",
        "start_file_pass",
        "save_workflow",
        "run_mcp_tool",
    }
)


def _referent_names(tool: str, args: dict[str, Any] | None) -> list[str]:
    """What a successful write actually left behind, read per tool SHAPE.

    This used to be a single `arguments["name"]` lookup for every tool, which
    silently inverted the write-claim gate for the two tools whose arguments do
    not look like that:

    * ``edit_files`` carries its names inside ``edits: [{name, ...}]`` (see the
      Rust schema, agent.rs) — so a SUCCESSFUL atomic multi-file edit recorded
      nothing, tripped ``CLAIM_UNSUPPORTED``, cost an extra model round and
      told the user the change had not landed. On the very verb whose own
      description says "Prefer this over repeated edit_file calls".
    * ``move_file`` was in ``WRITE_TOOLS`` but never in the ledger list at all.

    Fails open per-tool: an argument shape we do not recognise yields no name,
    which is the old behaviour, never an exception inside the tool loop.
    """
    args = args or {}
    if tool == "edit_files":
        edits = args.get("edits")
        # A 4B sometimes flattens `edits` to a bare string; take it rather than
        # recording nothing and accusing itself of a failed write.
        if isinstance(edits, str) and edits.strip():
            return [edits.strip()[:80]]
        out: list[str] = []
        for e in edits if isinstance(edits, list) else []:
            if isinstance(e, dict):
                # A rename's RESULT is new_name; that is the artifact that now
                # exists, and the name a later step has to be able to open.
                name = e.get("new_name") or e.get("name")
                if name:
                    out.append(str(name)[:80])
            elif isinstance(e, str) and e.strip():
                out.append(e.strip()[:80])
        return out
    if tool == "rename_file":
        name = args.get("new_name") or args.get("name")
        return [str(name)[:80]] if name else []
    if tool == "run_mcp_tool":
        # {tool, arguments} (room_mcp.rs MCP_RUN_TOOL). The evidence is WHICH
        # connector tool ran — the id is what a later step, and the user, can
        # check. Recorded only on success, which is what lets the write-claim
        # gate catch "I sent the email" after a send that errored.
        ran = args.get("tool") or args.get("name")
        return [str(ran)[:80]] if ran else ["a connector tool"]
    name = args.get("name")
    return [str(name)[:80]] if name else []


async def _run_worker(
    state: AgentState,
    config: RunnableConfig,
    worker_id: str,
    instruction: str,
    referents: list[str],
    node_key: str,
    upstream: tuple[str, ...] = (),
) -> tuple[str, bool, bool, list[str]]:
    """Execute one ask_*_agent delegation: run the specialist's own scoped
    sub-loop and return ``(report, ok, cancelled, referents)``. Only the REPORT
    joins the main thread — the worker's internal tool traffic stays its own.

    Runs CONCURRENTLY with its siblings (``execute_tools`` launches the whole
    round's batch before awaiting any of it), so this function touches no shared
    mutable state: the worker is resolved and its pipeline slot registered by
    the caller, ``referents`` is a read-only snapshot of the baton as it stood
    when the batch launched, and this worker's own referents come back through
    the return value for the caller to merge in call order. An earlier version
    appended to ``state["pipeline"]`` and did ``referents[:] = worker_refs``
    from inside here; under a parallel batch both are races — a nondeterministic
    roster and a last-writer-wins baton that silently drops siblings' artifacts.
    """
    deps = _deps(config)
    worker = get_agent(worker_id)

    base: list[Message] = [dict(m) for m in state.get("worker_base_messages", [])]  # type: ignore[misc]  # noqa: E501
    base.append(user_message(delegation_note(instruction, referents, upstream)))
    # The worker runs to the REQUEST ceiling. It used to be clamped to the
    # worker's own per-agent round budget; that budget is gone, so nothing cuts
    # a specialist short mid-task.
    max_rounds = state.get("run_max_rounds", AGENT_ROUND_BACKSTOP)
    initial: AgentState = {
        "question": instruction,
        "web_enabled": bool(state.get("web_enabled", False)),
        "write": bool(state.get("write", False)),
        "advisors": bool(state.get("advisors", False)),
        "max_rounds": max_rounds,
        "run_max_rounds": state.get("run_max_rounds", AGENT_ROUND_BACKSTOP),
        "small_model": bool(state.get("small_model", False)),
        "agent_id": worker.id,
        # This child's slot in the turn's graph — every `step` it emits is
        # stamped with it, so the UI can attribute tool traffic to the right
        # node even when three siblings are interleaving their events.
        "node_key": node_key,
        # Workers act inside a Main-agent pipeline: the always-on connector
        # proxy pair stays held unless this worker owns it (the queue-jump
        # guard — cross-domain sequencing belongs to the Main agent).
        "plan_multi": True,
        "unlocked_groups": set(),
        "referents": list(referents),
        # Seeded EMPTY, deliberately: this child's write-claim gate must judge
        # what IT wrote, not what the Main agent's baton already carried.
        "produced": [],
        "pipeline": [],
        "worker_base_messages": [],
        "messages": base,
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "cancelled": False,
        "stop": False,
    }
    # The worker runs ITS OWN shape (2026-07-25), not the one graph every agent
    # used to share: the Studio agent generates once with no cycle, the File
    # agent's claims pass a ground-truth check first. Imported here rather than
    # at module scope because `graphs` composes the node functions defined in
    # THIS module — a top-level import would be circular.
    from .graphs import graph_for, recursion_limit_for

    # One slot per child. Unbounded on a cloud room; serialized on a local one,
    # where a single resident model means N children are contention, not speed.
    async with deps.worker_slot():
        final: AgentState = await graph_for(worker.id).ainvoke(
            initial,
            config={
                "configurable": {"deps": deps},
                # Sized to THIS worker's shape — not every shape spends two
                # supersteps per round (see recursion_limit_for).
                "recursion_limit": recursion_limit_for(worker.id, max_rounds),
            },
        )  # type: ignore[assignment]
    report_text = (final.get("final_text", "") or "").strip()
    # What the child ADDED, not the baton it was handed — the caller merges this
    # back, and returning the whole baton would just re-merge the parent's own
    # entries (harmless today only because the merge de-duplicates).
    worker_refs = list(final.get("produced", []))
    cancelled = bool(final.get("cancelled", False))
    # A delegation can FAIL. `ok` was a hardcoded True, so `step_status` was
    # always green, the roster entry always flipped to "done", the UI's `failed`
    # node state was unreachable, and the progress log — which the code itself
    # calls "the small model's only record of what actually happened" — said
    # "report received" on the very branch whose text is "returned no report".
    #
    # Derived from the child's own state, no model call. Deliberately narrow:
    # "did this specialist come back with something". NOT `corrections`, which
    # is a record that a gate fired at some point, not a verdict — the model is
    # sent back to restate when one does, so by the time the report exists it
    # has already been corrected, and counting it here would mark a
    # successfully-corrected child as failed.
    ok = bool(report_text)
    report = (
        f"Report from the {worker.label}:\n{report_text}"
        if report_text
        else f"The {worker.label} finished but returned no report."
    )
    return report, ok, cancelled, worker_refs


def parse_plan(raw: Any) -> list[dict[str, Any]]:
    """Normalise the ``ask_agents`` argument into a task list.

    Fails OPEN at every step. A malformed plan from a 4B is the expected case,
    not the exceptional one, and the alternatives to salvaging it are both
    worse than a slightly-wrong dispatch: refusing costs the user a whole round
    to be told off, and raising kills the turn. So a task keeps whatever it
    got — an unusable one is dropped rather than allowed to poison the batch.
    """
    if isinstance(raw, str):
        # Some engines hand back the arguments object as a JSON string.
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    if isinstance(raw, dict):
        raw = raw.get("tasks", raw)
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            # A bare string is a plausible small-model shortcut for "just do it".
            if isinstance(item, str) and item.strip():
                out.append({"agent": "", "instruction": item.strip(), "depends_on": []})
            continue
        instruction = str(item.get("instruction") or item.get("task") or "").strip()
        if not instruction:
            continue
        deps_raw = item.get("depends_on") or item.get("after") or []
        deps = [int(d) for d in deps_raw if isinstance(d, (int, float, str)) and str(d).lstrip("-").isdigit()] if isinstance(deps_raw, list) else []
        out.append(
            {
                "agent": str(item.get("agent") or item.get("domain") or "").strip().lower(),
                "instruction": instruction,
                "depends_on": deps,
            }
        )
    return out


def plan_waves(tasks: list[dict[str, Any]]) -> list[list[int]]:
    """Group task indices into execution WAVES — each wave runs in parallel.

    Kahn's algorithm, with every failure mode resolved toward "run it" rather
    than "drop it":

    * a dependency index that is out of range, negative, or self-referential is
      ignored — the model miscounted, which is not a reason to strand the task;
    * a CYCLE cannot be scheduled at all, so whatever remains when no task is
      ready becomes one final wave and runs concurrently. A cyclic plan is a
      model error; the tasks in it are still real work the user asked for.

    Consequence worth stating: a task never waits for a dependency that did not
    run, because there is no such thing here — every task lands in some wave.
    """
    n = len(tasks)
    deps: list[set[int]] = []
    for i, t in enumerate(tasks):
        deps.append({d for d in t.get("depends_on", []) if 0 <= d < n and d != i})
    waves: list[list[int]] = []
    done: set[int] = set()
    while len(done) < n:
        ready = [i for i in range(n) if i not in done and deps[i] <= done]
        if not ready:
            # Cycle (or a dependency on something already proven unreachable):
            # everything still pending goes out together rather than never.
            ready = [i for i in range(n) if i not in done]
        waves.append(ready)
        done.update(ready)
    return waves


async def execute_tools(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Run this round's calls, with duplicate suppression and image handoff."""
    deps = _deps(config)
    agent = get_agent(str(state.get("agent_id", "")))
    # Who is emitting: the hub, or one specific child slot. Stamped onto every
    # step/step_status this loop emits (see AgentState.node_key).
    node = str(state.get("node_key") or MAIN_NODE_KEY)
    messages: list[Message] = state["messages"]
    seen: set[str] = set(state.get("seen", set()))
    calls: list[ToolCall] = state.get("calls", [])
    rnd = state.get("round", 0)

    # A GRAPH-synthesized tool turn is not the model speaking. `probe` and
    # `perceive` fire a deterministic call and never touch `final_text`, so
    # appending it here re-attributed the model's PREVIOUS utterance to this
    # turn: on `perceive_act` — the one shape whose whole premise is a clean
    # see/act loop — "I will click Settings." appeared on the ui_act turn AND
    # again on the ui_snapshot turn that followed, teaching the model it had
    # said the same thing twice. `synth` already marks exactly these turns.
    said = "" if state.get("synth") else state.get("final_text", "")
    messages.append(assistant_message(said, calls))
    synth_turns: list[int] = list(state.get("synth_turns", []))
    if state.get("synth"):
        synth_turns.append(len(messages) - 1)

    all_dup = True
    cancelled = deps.cancel.cancelled
    # Pixels captured this round, drained into a user message as soon as they
    # appear (mirrors the Rust `effects.pending_images`).
    pending_images: list[str] = list(state.get("pending_images", []))
    # The turn's verified action log (small-model mode re-injects it each round).
    progress: list[str] = list(state.get("progress", []))
    # The referent baton: artifacts later plan steps get told about by code.
    referents: list[str] = list(state.get("referents", []))
    # ...and the subset THIS loop produced, which is what the write gate reads.
    produced: list[str] = list(state.get("produced", []))
    # The FINDINGS baton: what specialists reported in EARLIER rounds. Carried
    # to this round's children verbatim, so a "find X then act on X" chain never
    # depends on the hub restating X in its own instruction.
    reports_so_far: list[tuple[str, str]] = [
        (str(a), str(b)) for a, b in state.get("reports", [])
    ]
    # Every tool the model actually reached — the `verify` shapes' ground truth.
    attempted: set[str] = set(state.get("attempted", set()))
    # Groups + catalog may change mid-round via request_tools.
    unlocked: set[str] = set(state.get("unlocked_groups", set()))
    tools_update: list[dict[str, Any]] | None = None

    # ----------------------------------------------------------------------- #
    # Fan-out: every delegation this round starts BEFORE any of them is awaited.
    # ----------------------------------------------------------------------- #
    #
    # The Main agent's children run in PARALLEL. Its catalog is ask_*_agent and
    # nothing else, so a round is either all-delegations (the Main agent) or
    # all-regular-tools (a worker, whose catalog contains no ask_* at all) —
    # which is why launching the delegations up front and then walking `calls`
    # in order is safe: room tools still execute strictly sequentially, one at a
    # time, exactly as before. Only the specialist sub-loops overlap.
    #
    # Awaiting in CALL ORDER (rather than as-completed) is deliberate: the tool
    # messages must land in the same order the model emitted the calls, or a
    # provider that pairs them positionally sees a scrambled transcript.
    pipeline: list[dict[str, Any]] = list(state.get("pipeline", []))
    served_names = {
        s.get("function", {}).get("name") for s in state.get("served_specs", [])
    }
    # The baton as it stood when the batch launched — every sibling reads the
    # SAME snapshot, since none of them can see another's artifacts yet.
    referents_at_launch = list(referents)
    # Findings from EARLIER ROUNDS only, for the same reason: siblings dispatched
    # together ran blind to each other, so handing one another's reports around
    # would be a lie about what was known when. Last two: enough for a
    # find-then-act chain without re-sending the whole turn every round.
    carryover: tuple[str, ...] = tuple(
        f"The {label} reported earlier in this turn:\n{text}"
        for label, text in reports_so_far[-2:]
    )
    tasks: dict[str, asyncio.Task[tuple[str, bool, bool, list[str]]]] = {}
    launched: set[str] = set()
    #: call id -> the human label of whatever is running for it, so a crash can
    #: be reported by name without re-resolving the worker in the error path.
    launched_label: dict[str, str] = {}
    # Children dispatched together share a batch number — the ONE fact that says
    # "these ran at the same time", which no amount of roster diffing downstream
    # can reconstruct reliably. Derived from the roster so it needs no state.
    batch = max((int(e.get("batch") or 0) for e in pipeline), default=-1) + 1

    async def _tracked(
        entry: dict[str, Any],
        worker_id: str,
        instruction: str,
        node_key: str,
        baton: list[str] | None = None,
        *,
        upstream: tuple[str, ...] = (),
    ) -> tuple[str, bool, bool, list[str]]:
        """Run one child, flipping ITS roster slot as it starts and finishes.

        The status flip has to happen where the child actually ends, not where
        the parent collects it: reports are collected in call order, so a fast
        third child would otherwise keep pulsing on screen until the slow first
        one returned — the exact illusion this feature exists to remove.
        """
        try:
            result = await _run_worker(
                state,
                config,
                worker_id,
                instruction,
                referents_at_launch if baton is None else baton,
                node_key,
                upstream,
            )
        except asyncio.CancelledError:
            # Stop pressed / a sibling failed the round. Mark it, but do NOT
            # emit — nothing is draining the queue once the run is torn down.
            entry["status"] = "failed"
            raise
        except Exception:
            entry["status"] = "failed"
            await _emit_pipeline(deps, pipeline, _active_step(pipeline))
            raise
        # result = (report, ok, cancelled, referents)
        entry["status"] = "done" if result[1] and not result[2] else "failed"
        await _emit_pipeline(deps, pipeline, _active_step(pipeline))
        return result

    def _register(worker_id: str, instruction: str, wave: int) -> dict[str, Any]:
        """Claim this child's roster slot. Call order, before anything runs."""
        entry: dict[str, Any] = {
            "agent": worker_id,
            "instruction": instruction,
            "status": "running",
            "batch": batch + wave,
            "key": f"{worker_id}#{len(pipeline)}",
        }
        pipeline.append(entry)
        return entry

    async def _run_plan(
        plan: list[dict[str, Any]],
    ) -> tuple[str, bool, bool, list[str]]:
        """Run one ``ask_agents`` batch wave by wave; one combined report back.

        Independent tasks in a wave run concurrently; a wave starts only once
        every task it depends on has reported, and those reports are handed to
        the dependents verbatim. The whole plan is ONE tool call, so it returns
        ONE tool message — the reports are labelled by task position, which is
        what the model's `depends_on` indices refer to.
        """
        waves = plan_waves(plan)
        reports: dict[int, str] = {}
        #: Per-task outcome. The plan's own `ok` is the AND of these, so a batch
        #: whose tasks all came back empty cannot render as a green step — the
        #: same reason a single delegation's `ok` stopped being hardcoded True.
        task_ok: dict[int, bool] = {}
        gathered: list[str] = list(referents_at_launch)
        cancelled_any = False
        for wave_no, wave in enumerate(waves):
            if deps.cancel.cancelled:
                cancelled_any = True
                break
            baton = list(gathered)
            running: list[tuple[int, dict[str, Any], asyncio.Task[Any]]] = []
            for idx in wave:
                task_spec = plan[idx]
                domain = DOMAIN_KEYS.get(str(task_spec.get("agent", "")), "")
                instruction = str(task_spec["instruction"])
                worker_id = resolve_worker(
                    # An unknown/absent domain key falls through to
                    # resolve_worker's own default rather than being refused.
                    domain,
                    instruction,
                    served_names=served_names,
                    web_enabled=bool(state.get("web_enabled", False)),
                )
                entry = _register(worker_id, instruction, wave_no)
                dep_reports = tuple(
                    reports[d]
                    for d in sorted(set(task_spec.get("depends_on", [])))
                    if d in reports
                )
                # Its own dependencies first; earlier ROUNDS' findings behind
                # them, so a plan that follows a previous round still sees what
                # that round learned.
                upstream = dep_reports + carryover
                running.append(
                    (
                        idx,
                        entry,
                        asyncio.create_task(
                            _tracked(
                                entry,
                                worker_id,
                                instruction,
                                entry["key"],
                                baton,
                                upstream=upstream,
                            )
                        ),
                    )
                )
            await _emit_pipeline(deps, pipeline, _active_step(pipeline))
            results = await asyncio.gather(
                *(t for _, _, t in running), return_exceptions=True
            )
            for (idx, entry, _), result in zip(running, results):
                label = get_agent(str(entry["agent"])).label
                if isinstance(result, BaseException):
                    # One task failing must not abort its siblings or the plan:
                    # the Main agent is told, and decides what to do with the
                    # rest. A raised exception here would strand the whole batch.
                    reports[idx] = f"Task {idx} ({label}) failed: {result}"
                    task_ok[idx] = False
                    continue
                report, child_ok, child_cancelled, child_refs = result
                task_ok[idx] = bool(child_ok)
                reports[idx] = f"Task {idx} — {report}"
                cancelled_any = cancelled_any or child_cancelled
                for ref in child_refs:
                    if ref not in gathered:
                        gathered.append(ref)
            if cancelled_any:
                break
        text = "\n\n".join(reports[i] for i in sorted(reports)) or (
            "No tasks ran — the plan was empty."
        )
        new_refs = [r for r in gathered if r not in referents_at_launch]
        return text, bool(reports) and all(task_ok.values()), cancelled_any, new_refs

    for call in calls:
        if agent.main is False:
            continue
        if call.name == BATCH_TOOL_NAME:
            key = call.key()
            if key in seen or key in launched:
                continue
            plan = parse_plan((call.arguments or {}).get("tasks"))
            if not plan:
                continue  # answered inline below with a corrective note
            launched.add(key)
            launched_label[call.id] = "task plan"
            tasks[call.id] = asyncio.create_task(_run_plan(plan))
            continue
        if call.name not in AGENT_TOOL_NAMES:
            continue
        key = call.key()
        # Same-round duplicate: the sequential pass below answers the repeat
        # from `seen`/the duplicate note, so it must not get its own worker.
        if key in seen or key in launched:
            continue
        launched.add(key)
        instruction = str(
            (call.arguments or {}).get("instruction") or state.get("question", "")
        )
        # Resolve HERE, not inside the worker: the pipeline roster has to be
        # registered in call order before anything runs concurrently.
        worker_id = resolve_worker(
            call.name,
            instruction,
            served_names=served_names,
            web_enabled=bool(state.get("web_enabled", False)),
        )
        node_key = f"{worker_id}#{len(pipeline)}"
        entry: dict[str, Any] = {
            "agent": worker_id,
            "instruction": instruction,
            "status": "running",
            "batch": batch,
            "key": node_key,
        }
        pipeline.append(entry)
        launched_label[call.id] = get_agent(worker_id).label
        tasks[call.id] = asyncio.create_task(
            _tracked(entry, worker_id, instruction, node_key, upstream=carryover)
        )

    if tasks:
        # One roster emit for the whole batch — every child in it is already
        # marked `running`, so the UI lights them all at once. The legacy
        # single active marker points at the first of them.
        await _emit_pipeline(
            deps, pipeline, active_step=len(pipeline) - len(tasks) + 1
        )

    async def _drain_tasks() -> None:
        """Cancellation between calls must not orphan running sub-loops."""
        for task in tasks.values():
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    for call in calls:
        # ADD-7: stop between tool calls.
        if deps.cancel.cancelled:
            cancelled = True
            await _drain_tasks()
            break
        # A skill may belong to ONE sub-agent, and `list_skills` scopes its
        # answer to the caller. The Rust bridge is built per RUN, not per
        # worker, so it cannot know which specialist is asking — we do, so the
        # id is injected here rather than left to the model to remember.
        if call.name == "list_skills":
            call.arguments = {**(call.arguments or {}), "agent": agent.id}

        key = call.key()
        if key in seen:
            # CHG-3: don't re-run an identical call or re-flood the context.
            messages.append(tool_message(duplicate_call_note(call.name), call.name, call.id))
            continue
        all_dup = False

        # Hub guard (v3): the MAIN agent never touches a room tool — even if
        # the model drifts and emits one, it is rejected here, before the
        # bridge, with a corrective note steering it back to delegation.
        if (
            get_agent(str(state.get("agent_id", ""))).main
            and call.name not in AGENT_TOOL_NAMES
            and call.name != BATCH_TOOL_NAME
        ):
            messages.append(
                tool_message(
                    f"You have no tool named '{call.name}' — you are the Main "
                    "agent and never act directly. Delegate with one of your "
                    "ask_*_agent tools, or answer the user.",
                    call.name,
                    call.id,
                )
            )
            continue

        # CHG-5: a human step label, not inline "⚙ name…" answer text. Stamped
        # with the emitting loop's node so the UI can file it under the right
        # agent — siblings run concurrently, so arrival order proves nothing.
        await deps.emit({"t": "step", "v": tool_step_label(call.name), "node": node})

        if call.name == "request_tools":
            # 2026-07-23: the lane escape hatch — resolved here, never sent to
            # the bridge (the bridge has no such tool).
            group = str((call.arguments or {}).get("group") or "")
            result, ok, new_tools = _unlock_group(group, state, unlocked, messages)
            if new_tools is not None:
                tools_update = new_tools
            await deps.emit({"t": "step_status", "ok": ok, "node": node})
            if ok:
                seen.add(key)
            progress.append(f"request_tools(group={group}) -> {'ok' if ok else 'error'}")
            messages.append(tool_message(result, call.name, call.id))
            continue

        if call.name == BATCH_TOOL_NAME:
            # A whole PLAN, already running wave by wave since the fan-out
            # above. One call in, one tool message out.
            task = tasks.get(call.id)
            if task is None:
                # `parse_plan` salvaged nothing. Say what was wrong rather than
                # returning an empty report the model will read as "done".
                await deps.emit({"t": "step_status", "ok": False, "node": node})
                progress.append(f"{BATCH_TOOL_NAME}() -> unusable plan")
                messages.append(tool_message(EMPTY_PLAN_NOTE, call.name, call.id))
                continue
            try:
                report, ok, plan_cancelled, plan_refs = await task
            except BaseException:
                await _drain_tasks()
                raise
            for ref in plan_refs:
                if ref not in referents:
                    referents.append(ref)
            if ok:
                reports_so_far.append(("specialists", report))
            await deps.emit({"t": "step_status", "ok": ok, "node": node})
            if ok:
                seen.add(key)
            progress.append(
                f"{BATCH_TOOL_NAME}({len(parse_plan((call.arguments or {}).get('tasks')))} tasks)"
                + (" -> reports received" if ok else " -> no reports")
            )
            messages.append(tool_message(report, call.name, call.id))
            if plan_cancelled:
                cancelled = True
                await _drain_tasks()
                break
            continue

        if call.name in AGENT_TOOL_NAMES:
            # Hub v3: the Main agent asked a specialist. Resolved and executed
            # HERE — the bridge has no such tool; the worker's own sub-loop
            # runs with its scoped box and only its REPORT returns to the
            # main thread. The referent baton carries artifacts across
            # specialists so no model has to remember another's work.
            instruction = str(
                (call.arguments or {}).get("instruction") or state.get("question", "")
            )
            # Already running since the fan-out above — this awaits it, it does
            # not start it. A delegation with no task was launched by neither
            # branch (only reachable if the batch scan and this one disagree),
            # so run it inline rather than drop the call on the floor.
            task = tasks.get(call.id)
            try:
                if task is None:
                    worker_id = resolve_worker(
                        call.name,
                        instruction,
                        served_names=served_names,
                        web_enabled=bool(state.get("web_enabled", False)),
                    )
                    fallback_key = f"{worker_id}#{len(pipeline)}"
                    fallback: dict[str, Any] = {
                        "agent": worker_id,
                        "instruction": instruction,
                        "status": "running",
                        "batch": batch,
                        "key": fallback_key,
                    }
                    pipeline.append(fallback)
                    report, ok, worker_cancelled, worker_refs = await _run_worker(
                        state,
                        config,
                        worker_id,
                        instruction,
                        referents_at_launch,
                        fallback_key,
                    )
                    fallback["status"] = "done" if ok and not worker_cancelled else "failed"
                else:
                    report, ok, worker_cancelled, worker_refs = await task
            except asyncio.CancelledError:
                # Stop, or the run being torn down. Not a specialist failure —
                # let it propagate, after draining the siblings so they do not
                # outlive the turn as orphans emitting into a dead run.
                await _drain_tasks()
                raise
            except Exception as exc:  # noqa: BLE001 - one child, not the ask
                # ONE specialist blew up (a model error, the recursion limit).
                # This used to re-raise, which killed the whole ask and threw
                # away every sibling report that had already succeeded — while
                # the identical crash inside `ask_agents` degraded to a per-task
                # failure line, because `_run_plan` writes out the right rule:
                # "One task failing must not abort its siblings or the plan."
                # The safer behaviour is now the DEFAULT rather than the special
                # case. The Main agent is told, truthfully, and decides.
                who = launched_label.get(call.id, "specialist")
                report = f"The {who} could not finish: {exc}"
                ok, worker_cancelled, worker_refs = False, False, []
            # Merge the child's baton in CALL order, de-duplicated: siblings ran
            # blind to each other, so the union is what later rounds must see.
            for ref in worker_refs:
                if ref not in referents:
                    referents.append(ref)
            if ok:
                # Into the FINDINGS baton, so the NEXT round's specialists get
                # this verbatim instead of the hub having to restate it.
                reports_so_far.append((launched_label.get(call.id, "specialist"), report))
            await deps.emit({"t": "step_status", "ok": ok, "node": node})
            if ok:
                seen.add(key)
            # Truthful either way: this log is the small model's only record of
            # what actually happened, so it must never claim a report it lacks.
            progress.append(
                f"{call.name}({instruction[:60]}) -> "
                + ("report received" if ok else "no report")
            )
            messages.append(tool_message(report, call.name, call.id))
            if worker_cancelled:
                cancelled = True
                await _drain_tasks()
                break
            continue

        outcome = await _run_one_tool(deps, call)
        attempted.add(call.name)
        ok = not outcome.is_error
        # ADD-22: tell the UI whether the step succeeded, so a failed chip doesn't
        # look identical to a successful one.
        await deps.emit({"t": "step_status", "ok": ok, "node": node})

        if ok:
            # Only remember successful calls, so a failed one may be re-attempted
            # in a later round (bounded by the round backstop, not a retry cap).
            seen.add(key)
            result = outcome.text
            # Referent baton: record produced artifacts so a LATER plan step's
            # kickoff note can name them deterministically — and so the
            # write-claim gate can tell a real write from a claimed one.
            if call.name in LEDGER_TOOLS:
                for artifact in _referent_names(call.name, call.arguments):
                    entry_text = f"{call.name}: {artifact}"
                    referents.append(entry_text)
                    produced.append(entry_text)
        else:
            result = f"Tool error: {outcome.text}"
        progress.append(
            f"{call.name}({_args_summary(call.arguments)}) -> {'ok' if ok else 'error'}"
        )

        messages.append(tool_message(result, call.name, call.id))

        # ADD-25: a perception tool captured pixels. Hand them to the (vision-
        # capable) chat model as a USER message right after the tool result —
        # Ollama reads images from user turns, not tool turns.
        pending_images.extend(outcome.images)
        if pending_images:
            messages.append(user_message(IMAGE_HANDOFF, pending_images))
            pending_images = []

    # A round of only repeats means the model is stuck: force a tool-less
    # synthesis next round instead of spinning to the round backstop.
    force_synthesis = bool(state.get("force_synthesis", False)) or all_dup

    if tasks and not cancelled:
        # The Main agent resumes — mark it active again so its chip pulses while
        # it reads the batch's reports and decides the next move. This used to
        # live at the tail of `_run_worker`; with a parallel batch it belongs
        # here, once, after every child has been collected.
        await _emit_pipeline(deps, pipeline, active_step=len(pipeline) + 1)

    updates: dict[str, Any] = {
        "messages": messages,
        "seen": seen,
        "force_synthesis": force_synthesis,
        "round": rnd + 1,
        "calls": [],
        "pending_images": pending_images,
        "progress": progress,
        "referents": referents,
        "produced": produced,
        "reports": reports_so_far,
        "attempted": attempted,
        "synth_turns": synth_turns,
        "synth": False,
        "unlocked_groups": unlocked,
        "pipeline": pipeline,
        "cancelled": cancelled or deps.cancel.cancelled,
    }
    if tools_update is not None:
        updates["tools"] = tools_update
    return updates


async def synthesize(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Settle the step's final text (run_agent emits the ONE final event —
    a multi-step plan must not fire N competing finals at the frontend)."""
    deps = _deps(config)
    cancelled = bool(state.get("cancelled", False)) or deps.cancel.cancelled
    final_text = state.get("final_text", "") or ""
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
    if state.get("round", 0) >= state.get("max_rounds", AGENT_ROUND_BACKSTOP):
        # Unreachable by construction (the round before last is tool-less and
        # breaks), but a runaway backstop should not depend on that proof.
        return "synthesize"
    return "call_model"


# `build_graph()` / `AGENT_GRAPH` used to live here: a SECOND compiled copy of
# the same wiring `graphs._react` builds. Deleted 2026-07-25 because the
# duplicate was already lying. `run_agent` invoked it while workers invoked
# `graph_for(worker.id)`, so the main agent did NOT run the template it
# declares (`chat.answer` -> "supervisor"). The two happened to be identical
# wirings, which is exactly why nothing failed — and why the first divergence
# in the supervisor shape would have silently skipped the main agent.
# `graphs.MAIN_GRAPH` is now the single definition; see
# `test_run_agent_uses_the_main_agents_declared_template`.


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #


async def run_agent(req: RunRequest, deps: Deps) -> str:
    """Run one ask to completion. Emits SPEC §4 events through ``deps.emit``.

    Hub v3 (owner decision 2026-07-23): ONE loop — the MAIN AGENT's. Its tool
    catalog is its specialists (``agent_tool_specs``); it calls as many as the
    request needs (``execute_tools`` intercepts each ask_*_agent call and runs
    that worker's scoped sub-loop, returning only the report), and answers
    directly what it already knows. Every delegation the model emits in ONE
    round runs in PARALLEL — the batch is launched before any of it is awaited,
    and the reports are collected in call order. The pipeline roster grows live
    (``_emit_pipeline``); ONE final event per ask.
    """
    write, ui, jobs, skills, connectors = req.resolved_routing()
    run_max_rounds = req.resolved_max_rounds(ui, jobs, skills, connectors)
    # No per-agent budget narrows this any more: the Main agent delegates until
    # it has what it needs, bounded only by the shared runaway backstop.
    max_rounds = run_max_rounds

    # The ask lives in `question` (a REQUIRED field); `messages` is optional
    # history. Chat callers ALSO append the ask as the final user turn, but
    # headless callers (workflow agent_run) send only `question` with an empty
    # history. If no user turn is present, seed one from `question` — otherwise
    # the model is called with zero messages, and Ollama answers an empty
    # conversation with just a done_reason='load' response, which langchain_ollama
    # skips, leaving zero generation chunks → "No generation chunks were returned".
    messages: list[Message] = [dict(m) for m in req.messages]  # type: ignore[misc]
    if req.question.strip() and not any(m.get("role") == "user" for m in messages):
        messages.append(user_message(req.question))

    main = get_agent(MAIN_AGENT_ID)
    pipeline: list[dict[str, str]] = []
    # The opening roster: just the Main agent, thinking. Every delegation
    # extends it (File agent → …) via _emit_pipeline.
    await deps.emit(
        {
            "t": "plan",
            "v": [
                {
                    "agent": main.id,
                    "label": main.label,
                    "instruction": "decide, delegate to specialists, answer",
                    "status": "running",
                    "batch": None,
                    "key": MAIN_NODE_KEY,
                }
            ],
        }
    )
    await deps.emit(
        {
            "t": "agent",
            "v": {
                "id": main.id,
                "label": main.label,
                "step": 1,
                "total": 1,
                "active_steps": [1],
            },
        }
    )

    small_model = req.provider is None and not is_nonlocal_model(req.model)
    initial: AgentState = {
        "question": req.question,
        "web_enabled": req.web_enabled,
        "write": write,
        "advisors": bool(req.advisors),
        "max_rounds": max_rounds,
        "run_max_rounds": run_max_rounds,
        # A plain local Ollama model (no API provider, no :cloud relay) gets
        # the small-model guardrails: one delegation per round + turn-progress
        # re-injection. Cloud-class models keep parallel calls, lean prompt.
        "small_model": small_model,
        "agent_id": main.id,
        "node_key": MAIN_NODE_KEY,
        "plan_multi": False,
        "unlocked_groups": set(),
        "referents": [],
        "pipeline": pipeline,
        "worker_base_messages": [dict(m) for m in messages],  # type: ignore[misc]
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "cancelled": False,
        "stop": False,
    }
    # The MAIN agent runs the shape it DECLARES, exactly as workers do. Imported
    # here, not at module scope: `graphs` imports these node functions.
    from .graphs import graph_for, recursion_limit_for

    # Sized off the shape rather than assumed to be two supersteps per round.
    # The loop self-terminates long before this; it is the runaway guard.
    config = {
        "configurable": {"deps": deps},
        "recursion_limit": recursion_limit_for(MAIN_AGENT_ID, max_rounds),
    }

    final: AgentState = await graph_for(MAIN_AGENT_ID).ainvoke(initial, config=config)  # type: ignore[arg-type]

    # The ONE final event for the whole pipeline. Don't invent "Done." over a
    # partial answer the user stopped.
    answer = (final.get("final_text", "") or "").strip()
    if not answer and not deps.cancel.cancelled:
        answer = DONE_TEXT
    elif deps.cancel.cancelled:
        answer = final.get("final_text", "") or ""
        if not answer.strip():
            # Stop landed before the hub composed anything, but specialists may
            # already have finished real work. Handing back "" threw all of it
            # away and the user saw a turn that did nothing — the actual harm
            # behind "a crash/Stop discards completed work". No model call: the
            # findings baton already holds each report verbatim.
            done = [
                f"**{label}** — {text.split(':', 1)[-1].strip() if text.startswith('Report from the') else text}"
                for label, text in final.get("reports", [])
            ]
            if done:
                answer = "Stopped. Here is what had already come back:\n\n" + "\n\n".join(
                    done
                )
    await deps.emit({"t": "final", "v": answer})
    return answer


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
    "AgentState",
    "CancelToken",
    "Deps",
    "Event",
    "call_model",
    "execute_tools",
    "prepare",
    "route_after_model",
    "route_after_tools",
    "run_agent",
    "stream_events",
    "synthesize",
]
