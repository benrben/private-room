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
* **Only SUCCESSFUL ROOM TOOL calls are memoised.** A failed one is not in
  ``seen``, so the model may re-attempt it in a LATER round — transient failures
  shouldn't be permanent. This is NOT a hard "one retry" cap: a call that keeps
  failing can be re-attempted once per round, bounded only by the runaway
  backstop, until synthesis. A DELEGATION is memoised either way
  (``_ToolPass._memoise_delegation``): re-running a specialist is a whole child
  loop rather than one call, and its outcome — empty report included — is
  already in the thread for the model to read.
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
import logging
import weakref
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, NamedTuple, TypedDict

from langchain_core.runnables import RunnableConfig

from .agents import (
    AGENT_TOOL_NAMES,
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    DOMAIN_KEYS,
    GROUPS,
    MAIN_AGENT_ID,
    AgentSpec,
    agent_tool_specs,
    get_agent,
    group_prompt,
    group_servable,
    group_tools,
    main_prompt,
    normalize_domain_key,
    reachable_domain_keys,
    specialist_workers,
    tagged_specialist,
    toolbox_for,
)
from .budget import byte_len, json_chars
from .chat import ChatModel
from .config import AGENT_ROUND_BACKSTOP, NO_PROGRESS_ROUNDS, RunRequest
from .labels import tool_step_label
from .manager import resolve_worker
from .mcp_client import McpClient, ToolResult
from .messages import (
    Message,
    ToolCall,
    assistant_message,
    tool_message,
    user_message,
)
from .planner import build_plan
from .privacy import is_nonlocal_model
from .prompts import (
    DIRECT_SPECIALIST_NOTE,
    DONE_TEXT,
    EMPTY_PLAN_NOTE,
    IMAGE_HANDOFF,
    READ_RESULT_TOOL,
    SKILLS_NOTE,
    TOOL_GROUP_LABELS,
    TOOL_GROUPS_PROMPT,
    correction_note,
    delegation_note,
    duplicate_call_note,
    request_tools_spec,
    spill_note,
    tag_unavailable_answer,
    turn_progress_note,
    unlocked_note,
    with_read_result,
)
from .results import SPILL_BYTES, ResultStore, read_spill
from .routing import ADVISOR_TOOL_NAMES, lane_label
from .usage import build_usage_event, categorize_messages

#: Failures here are mirrored to `arcelle-sidecar.log` by the host
#: (`sidecar_lifecycle.rs::drain_stderr`). Nothing configures logging in this
#: process, so `logging.lastResort` carries ERROR to stderr — which is exactly
#: the stream the host drains. Do not log below ERROR from this module: it would
#: be dropped, and a log line nobody can read is worse than none.
_log = logging.getLogger("arcelle_sidecar.graph")

#: An event emitted to the Rust host (SPEC §4).
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


#: The Main agent's node identity in the turn's agent graph (see
#: ``AgentState.node_key``). Workers get ``"<agent_id>#<pipeline slot>"``; the
#: hub is a singleton, so it gets a fixed name the UI can root the graph on.
MAIN_NODE_KEY = "main"

#: Shown in the step strip when the turn-wide round budget runs out. The user
#: gets an answer either way; this says the answer came from what was already
#: gathered rather than from the loop deciding it was finished.
ROUND_BUDGET_STEP = "Round budget reached — answering with what we have"

#: How many lines of the turn's action log the small-model note re-sends. The
#: log itself is kept WHOLE in state — it is what an inspected turn reads, and
#: what `verify` appends to. What is bounded is the copy paid for out of the
#: model's window every single round.
PROGRESS_NOTE_LINES = 12

#: Stands in for the actions the tail dropped. `turn_progress_note` numbers what
#: it is handed from 1 under a heading that reads like the turn's COMPLETE action
#: list, so a silently trimmed log told the model actions 9-20 were actions
#: 1-12 — and a model that believes the list is complete re-issues an older call.
#: The duplicate guard catches that, so the cost is a wasted round, not a wrong
#: answer; one honest line removes it. It occupies one of the lines above, so the
#: note's size is bounded exactly as before.
PROGRESS_ELIDED = "({n} earlier actions omitted — they are further up in this thread)"

#: The honest net for a turn that ended with no words AND nothing to show for
#: itself. `DONE_TEXT` is a claim of success, and it is only true over work that
#: actually happened; said over a turn where no specialist reported and nothing
#: was written, it tells the user the app finished something it never started.
NOTHING_TEXT = (
    "I could not produce an answer for that — nothing was run and nothing was "
    "changed. Please try asking again."
)

#: The same honesty for the turn that DID run something and has nothing to show
#: for it — a specialist that failed or was refused, a tool round that came back
#: empty. A specialist's report is recorded on SUCCESS only, so all of those fell
#: through to `NOTHING_TEXT`, which told the user nothing had been run while the
#: step beside it was red. Both halves of this sentence are facts the loop owns:
#: the action log is non-empty and the referent baton is not.
NOTHING_USABLE_TEXT = (
    "I could not produce an answer for that. Some steps ran, but none of them "
    "came back with anything I can use, and nothing was changed. Please try "
    "asking again."
)


class CancelToken:
    """The ask's Stop button, seen from inside the loop — and one NODE of the
    run's cancel tree.

    Owner replacement #3 (2026-08-03): cancellation is a hierarchy rooted at the
    run. Every delegated child loop gets its own token (``Deps.for_child``), so
    stopping the run stops every specialist under it, while a token cancelled
    further down stops only its own subtree and leaves its siblings running.

    Two mechanisms, deliberately, because they cover different failure modes:

    * :meth:`cancel` walks DOWN, so a caller can be told what it actually
      stopped (the ``/cancel`` reply, and eventually the user).
    * :attr:`cancelled` reads UP the parent chain, so a child created DURING or
      AFTER its parent's walk is stopped anyway. In the host this needs an
      explicit re-check at birth, because Rust hands raw ``Arc<AtomicBool>``
      flags to loops that never see the tree; here every reader goes through
      this property, so the chain alone is enough.

    ``label`` names the work for the user ("the File agent") — never room
    content, in line with the rest of what leaves this process.
    """

    __slots__ = ("_cancelled", "_parent", "_kids", "label", "__weakref__")

    def __init__(self, label: str = "this answer", parent: "CancelToken | None" = None) -> None:
        self._cancelled = False
        self._parent = parent
        self._kids: list[weakref.ref[CancelToken]] = []
        self.label = label

    def child(self, label: str) -> "CancelToken":
        """A token for work this one starts. Weakly held: a child is owned by
        the coroutine running it, so a finished specialist prunes itself rather
        than piling up for the length of a long turn."""
        kid = CancelToken(label, parent=self)
        self._kids = [w for w in self._kids if w() is not None]
        self._kids.append(weakref.ref(kid))
        return kid

    def cancel(self) -> list[str]:
        """Stop this node and its whole subtree; return the labels this call
        actually stopped. Already-cancelled work is not re-reported — it was
        stopped by the earlier Stop, and saying so twice would be a claim about
        THIS one that isn't true."""
        stopped: list[str] = []
        if not self._cancelled:
            self._cancelled = True
            stopped.append(self.label)
        for ref in list(self._kids):
            kid = ref()
            if kid is not None:
                stopped.extend(kid.cancel())
        return stopped

    @property
    def cancelled(self) -> bool:
        if self._cancelled:
            return True
        return self._parent is not None and self._parent.cancelled

    def __bool__(self) -> bool:  # pragma: no cover - convenience
        return self.cancelled


class _NullSlot:
    """The unbounded case, shaped like a semaphore so the call site has no
    branch — a cloud room holds no resident model and wants every child at once."""

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *exc: Any) -> None:
        return None


_NULL_SLOT = _NullSlot()


@dataclass(slots=True)
class _TurnShared:
    """The three pieces of ``Deps`` that are per-TURN, not per-loop.

    ``Deps`` used to be one object passed by reference to every loop in the
    tree, which made "shared" and "copied" the same thing. Giving a delegated
    child its own cancel token means giving it its own ``Deps``
    (:meth:`Deps.for_child`) — and a plain copy would silently hand each child
    its own round counter, its own worker semaphore and its own idea of who
    holds the live answer area: the turn-wide runaway net would stop counting
    the turn, the local room's one-model serialization would evaporate, and
    every child would claim the live area the lease exists to arbitrate. Boxing
    them here keeps them shared BY REFERENCE across every copy, which is the
    property those three fields always relied on.
    """

    rounds_spent: int = 0
    worker_sem: Any = None
    live_node: str | None = None


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
    #: the gap. Cloud engines have no resident model, so the caller raises it —
    #: to `config.CLOUD_WORKER_PARALLEL`, not to unbounded: twenty tasks meant
    #: twenty PAID conversations opening in the same instant.
    #: 0/None means unbounded, which only a headless caller that owns its own
    #: rate limiting should ask for.
    worker_parallel: int | None = None
    #: Tool results too big for the thread, parked whole (:mod:`.results`).
    #:
    #: Per RUN, because `Deps` is built per request (`server.py`) and passed by
    #: reference into every child loop — so the store is created and freed with
    #: the run, and no teardown has to remember it. Which refs a given loop may
    #: READ is scoped separately, by `AgentState.spills`.
    results: ResultStore = field(default_factory=ResultStore)
    #: The WHOLE ASK's runaway net (`config.TURN_ROUND_BACKSTOP`), shared
    #: by every loop in the delegation tree. `max_rounds` lives in state, and
    #: each child starts a fresh state at round 0, so it bounds a loop and not a
    #: turn — the one place a turn-wide count can live is here, because `Deps`
    #: is the single object passed by reference all the way down.
    #: None/0 = unbounded (what a headless caller that owns its own timeout wants).
    turn_round_budget: int | None = None
    #: How many CONSECUTIVE no-progress rounds a loop may spend before it is
    #: made tool-less (`config.NO_PROGRESS_ROUNDS`). Unlike the net above this
    #: is a THRESHOLD, not a counter — the count itself is per-loop and lives in
    #: `AgentState.stalls`, because a worker that repeats itself should end its
    #: own loop, not its siblings'. None/0 = the gate is off.
    turn_stall_budget: int | None = NO_PROGRESS_ROUNDS
    #: The per-TURN state every copy of this object shares — the round counter,
    #: the worker semaphore and the live-area lease (`_TurnShared`). Shared BY
    #: REFERENCE, which is what makes `for_child` safe.
    _shared: _TurnShared = field(default_factory=_TurnShared, repr=False, compare=False)

    def for_child(self, label: str) -> "Deps":
        """This run's deps as one delegated CHILD sees them: same model, same
        bridge, same turn budget, same live-area lease — its own cancel token.

        Owner replacement #3. The child inherits its parent's Stop through the
        token's parent chain, so cancelling the run still reaches every
        specialist under it; what is new is that the child now HAS a node, which
        is what a per-specialist Stop (and an honest "what did this Stop
        actually stop" answer) can be built on.
        """
        return replace(self, cancel=self.cancel.child(label))

    def spend_round(self) -> bool:
        """Take one round from the TURN's budget; False once it is exhausted.

        Not a lock: the batch of delegated children is concurrent, but each of
        them awaits its own model call, and asyncio gives us a single thread —
        ``+= 1`` between awaits cannot interleave.
        """
        self._shared.rounds_spent += 1
        if not self.turn_round_budget or self.turn_round_budget <= 0:
            return True
        return self._shared.rounds_spent <= self.turn_round_budget

    def just_exhausted(self) -> bool:
        """True on the ONE round that first crossed the budget — so the user is
        told once, not once per loop still unwinding."""
        return (
            bool(self.turn_round_budget)
            and self._shared.rounds_spent == self.turn_round_budget + 1
        )

    def claim_live(self, node: str) -> bool:
        """True when THIS loop may stream its round into the live answer area.

        There is exactly ONE of those in the UI, and a `round` event BLANKS it
        (`effects.ts`) before the deltas that follow. A round of the hub's
        dispatches its whole batch of specialists at once, and every one of them
        streamed into that same area: the user watched fragments of three agents
        shuffled together and repeatedly erased, and read-aloud spoke the
        jumble. Whoever gets there first holds it until its round ends — the
        siblings are still visible as step chips and roster nodes, and the
        answer the user keeps is composed by the hub either way.

        A LEASE, not a lock: a loop that does not get it simply stays quiet.
        Nothing waits on anything, so this cannot deadlock or reorder events.
        """
        if self._shared.live_node is None:
            self._shared.live_node = node
            return True
        return self._shared.live_node == node

    def release_live(self, node: str) -> None:
        """Give the live area back, if this loop is what is holding it."""
        if self._shared.live_node == node:
            self._shared.live_node = None

    def worker_slot(self) -> Any:
        """An async context manager bounding concurrent children (or a no-op)."""
        if not self.worker_parallel or self.worker_parallel <= 0:
            return _NULL_SLOT
        if self._shared.worker_sem is None:
            self._shared.worker_sem = asyncio.Semaphore(self.worker_parallel)
        return self._shared.worker_sem


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
    #: The composer's ``*`` tag ran this turn STRAIGHT to this specialist: no
    #: Main agent decided anything, so this loop writes the user's answer
    #: itself rather than a report for a hub to relay (`DIRECT_SPECIALIST_NOTE`).
    #: False for every other loop, the Main agent's included.
    direct: bool
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
    #: Refs of tool results THIS loop parked whole (:mod:`.results`), in the
    #: order they were parked. Scopes `read_result`: the store hangs off `Deps`
    #: and is shared by the whole delegation tree, so without this a specialist
    #: could read text a sibling fetched and never showed it.
    #:
    #: MUST be declared here — LangGraph filters a node's returned dict against
    #: this schema and SILENTLY DROPS unknown keys, so an undeclared list would
    #: read empty forever and the reader would be retired the round after it
    #: appeared. Same trap as `stage_retried`.
    spills: list[str]
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
    #: Consecutive rounds this loop has spent without learning anything
    #: new. Reset to 0 by any round that does. At
    #: `Deps.turn_stall_budget` the next round is served tool-less.
    stalls: int
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
    #: `check_result` (the recall_act_check shape): how many bounded repair
    #: rounds this loop has spent — the gate's WHOLE budget. `checked` and
    #: `repaired` sat here too, left over from the latch the counter replaced;
    #: both were written on every visit and read by nothing (removed 2026-08-01).
    repairs: int
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


def _why(exc: BaseException) -> str:
    """A reason a person can read.

    ``str()`` on several httpx/asyncio errors is the EMPTY STRING, so every
    place that reports a failure by interpolating the exception could produce
    "failed:" with nothing after it — a line that is then handed to the Main
    agent and from there to the user. ``stream_events`` already solved this for
    the run-level error; the delegation paths interpolated raw and did not.
    """
    return str(exc) or type(exc).__name__


#: Exceptions whose message is already a whole sentence aimed at the user. For
#: everything else the class name is kept, because it is often the only clue
#: there is: bare ``'model'`` from a KeyError explains nothing, while
#: ``KeyError: 'model'`` at least says an internal lookup missed.
_SELF_EXPLAINING_ERRORS = ("ProviderApiError", "LlmError", "ToolError")


def _why_failed(exc: BaseException) -> str:
    """``_why`` for a failure shown in a UI, where jargon costs the reader.

    Prefixing every reason with its Python class turned a provider's own
    sentence into "ProviderApiError: …", which reads as an internal fault the
    user caused. The prefix is dropped only when the message stands alone.
    """
    name = type(exc).__name__
    reason = str(exc).strip()
    if not reason:
        return name
    return reason if name in _SELF_EXPLAINING_ERRORS else f"{name}: {reason}"


async def _list_tools(deps: Deps) -> list[Any]:
    """The bridge's catalog, with ONE retry and a sentence the user can act on.

    This is the FIRST thing every loop does, before any work — so a hiccup here
    costs nothing but the turn, and the turn used to end in whatever raw
    httpx/JSON-RPC text the exception carried, with no retry and no explanation.
    One retry covers the transient case. A second failure is reported as itself
    rather than swallowed, because continuing with an EMPTY catalog would be
    worse: an agent with no tools does not say so, it answers from memory.
    """
    if deps.mcp is None:
        return []
    try:
        return await deps.mcp.list_tools()
    except asyncio.CancelledError:
        raise
    except Exception as first:  # noqa: BLE001 - retried once, then reported
        try:
            return await deps.mcp.list_tools()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # BOTH reasons, and they are often different — "connection refused"
            # then "timed out" is the shape of a bridge coming down mid-turn.
            # Only the retry's reason goes in the sentence the user reads; the
            # first attempt's belongs in the log with the traceback.
            _log.error(
                "the room's tool catalog could not be loaded (first attempt: %s)",
                _why(first),
                exc_info=True,
            )
            raise RuntimeError(
                # `_why` falls back to the exception's class NAME, which is never
                # empty, so this used to read `_why(exc) or _why(first)` with a
                # second half that could not be reached.
                "this room's tools could not be loaded, so nothing could be "
                f"done safely: {_why(exc)}"
            ) from exc


def _locked_groups(
    served_names: set[str], current: set[str], unlocked: set[str], own: str = ""
) -> list[str]:
    """request_tools groups still locked AND actually servable this run (an
    advisor-scope bridge never serves ui tools — offering an unlockable group
    would teach the model to hallucinate).

    "Servable" is `agents.group_servable`, NOT "was any tool of this group
    served": on the cloud-CLI tier `app_ui` passes the any-one-of-them test on
    `view_media_frame` alone (a room video's pixels, served as CONTENT) while
    the three SCREEN tools stay local-only — so the group was still offered
    here, a round could be spent unlocking it, and `group_prompt` then briefed
    the model on ui_snapshot/ui_act. That is the failure `AgentSpec.requires`
    was added to kill, reached through this entrance instead.

    ``own`` is the asking agent's OWN group, and it is never offered. The hatch
    exists for a lane the keyword routers MISSED — a reader that turns out to
    need the jobs tools — not for widening an agent inside its own domain,
    where the box is a deliberate scope decision and a sibling already holds the
    rest. Without this, `skills.use` (read and run only, by its own paragraph)
    could unlock the `skills` group and reach save_skill and delete_skill; the
    Main agent routes an authoring ask to `skills.author` instead.
    """
    return [
        g
        for g in GROUPS
        if g not in unlocked
        and g != own
        and group_servable(g, served_names)
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
                "v": lane_label(
                    ui=agent.id == "app.ui",
                    write=write,
                    web_enabled=web_enabled,
                    agent_id=agent.id,
                ),
            }
        )

    # Never hardcode the catalog — the host decides our trust scope (SPEC §2.1).
    served = await _list_tools(deps)
    served_specs = [s.to_ollama() for s in served]
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    # Hub v3: the MAIN agent's only tools are its specialists — the
    # ask_*_agent catalog (≤6 entries, one per reachable domain). It never
    # sees a room tool; acting is what workers are for. (No request_tools
    # either: the specialists cover every unlockable lane.)
    #
    # The `*` tag does NOT narrow this any more (2026-08-04). It used to, and
    # the Main agent still ran the turn — planning and delegating a route the
    # user had already chosen. `run_agent` now sends a tagged turn straight to
    # the specialist, so a hub that is running was never tagged.
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

    # The degenerate tier, said OUT LOUD. When the bridge serves nothing the
    # Main agent gets an empty catalog and `MAIN_PROMPT_NO_SPECIALISTS` tells it
    # to admit it cannot reach the room — which it duly does, in its own words.
    # Those words are then the ENTIRE diagnosis available, because this app
    # writes no log of its own, and they describe the model rather than the
    # fault. Live QA 2026-08-03 read one such answer ("I'm Claude Code running
    # in a terminal, I can't see the Arcelle room") as a statement about what
    # the product IS, and filed it as a capability regression. It is not a
    # capability at all: it is a wiring failure with a confident narrator.
    #
    # A step chip cannot be mistaken for the model's opinion, so the cause
    # travels with the symptom.
    if agent.main and not tools:
        await deps.emit(
            {
                "t": "step",
                "v": (
                    "No specialists available — the room tool bridge served "
                    f"{len(served_specs)} tools this run"
                ),
            }
        )
        await deps.emit({"t": "step_status", "ok": False})

    # DISPATCH IS ARCELLE-BUILT, NOT MODEL-DIRECTED (owner decision #2,
    # 2026-08-03). The same request used to produce twelve specialists, then
    # five, then none, because the plan was the model's to invent — and
    # inventing a plan is the multi-turn agency a small model is measurably
    # worst at. `build_plan` decides it here instead, from the user's words and
    # from `served_names`/`web_enabled` — the SAME two inputs that just built
    # the catalog above, which is what keeps prompt and catalog from telling a
    # harness engine two different stories.
    #
    # Only the hub, and only once: `prepare` is the graph's entry node, so a
    # turn is planned exactly once and no later round can re-plan it.
    plan = (
        build_plan(
            str(state.get("question") or ""),
            web_enabled=web_enabled,
            served_names=served_names,
        )
        if agent.main
        else None
    )
    if plan is not None and plan.steps:
        # The plan, as a chip, BEFORE the model has done anything with it. The
        # roster shows which specialists ran; only this says which ones Arcelle
        # asked for — so a hub that deviates is visible rather than inferred.
        node = str(state.get("node_key") or MAIN_NODE_KEY)
        await deps.emit({"t": "step", "v": f"Plan: {plan.summary}", "node": node})
        await deps.emit({"t": "step_status", "ok": True, "node": node})

    messages: list[Message] = [dict(m) for m in state.get("messages", [])]  # type: ignore[misc]
    offered = {s.get("function", {}).get("name") for s in tools}
    # The escape hatch (2026-07-23): groups the manager left OFF (but the
    # bridge actually serves) stay reachable through one always-on mini-tool —
    # a lane the vocabulary missed is one trivial enum call away instead of
    # permanently invisible.
    locked = [] if agent.main else _locked_groups(served_names, offered, unlocked, agent.group)
    if locked:
        tools.append(request_tools_spec(locked))
    if messages and messages[0].get("role") == "system":
        # Only describe tools the model actually has this turn — telling it
        # about tools it wasn't given teaches it to hallucinate calls. The
        # active sub-agent contributes its own paragraph; locked groups are
        # named ONLY at the group level (TOOL_GROUPS_PROMPT), so the model
        # keeps a stable self-image without unseen schemas.
        # The Main agent's paragraph is GENERATED from the domains actually in
        # the catalog `prepare` just built, not the static all-domains default
        # on its spec: a web-disabled room must not read "the internet" in its
        # own system prompt (2026-07-28). Workers use their static paragraph,
        # which `test_every_agent_prompt_names_only_its_own_tools` already pins
        # against their box.
        paragraph = (
            main_prompt(
                (k for k, name in DOMAIN_KEYS.items() if name in offered),
                web_off=not state.get("web_enabled", False),
            )
            if agent.main
            else agent.prompt
        )
        if (
            paragraph
            # served this scope — never describe unserved tools. The Main
            # agent's paragraph describes its ask_*_agent catalog instead,
            # which prepare just built (offered = its specialists).
            and (agent.main or set(agent.tools) & offered)
            and paragraph not in (messages[0].get("content") or "")
        ):
            messages[0]["content"] = (messages[0].get("content") or "") + paragraph
        # The `*` tag, said out loud — to the SPECIALIST, which is the only
        # thing running on a tagged turn now. Without it this loop writes the
        # DID/FOUND/MISSING report `delegation_note` asks a delegated worker
        # for, and there is no Main agent left to turn that into an answer: the
        # user would read a form. `run_agent` refuses an unreachable tag before
        # any of this, so a loop that gets here was tagged AND is reachable.
        if state.get("direct", False) and not agent.main:
            note = DIRECT_SPECIALIST_NOTE.format(label=agent.label, area=agent.area)
            if note not in (messages[0].get("content") or ""):
                messages[0]["content"] = (messages[0].get("content") or "") + note
        # …and the plan Arcelle built, LAST of the hub's paragraphs so it is the
        # most recent thing in the system message. `Plan.note` is "" for the two
        # cases that already have their own paragraph (an empty catalog) or
        # deliberately have none (the planner abstained in a room whose default
        # worker is unreachable), so nothing here can contradict them.
        if plan is not None:
            plan_paragraph = plan.note
            if plan_paragraph and plan_paragraph not in (messages[0].get("content") or ""):
                messages[0]["content"] = (
                    messages[0].get("content") or ""
                ) + plan_paragraph
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
        "stalls": 0,
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
    node = str(state.get("node_key") or MAIN_NODE_KEY)
    # The turn-wide budget, spent by EVERY loop in the tree (`Deps.spend_round`).
    # Exhausting it does not abort anything: it makes this and every remaining
    # round tool-less, which is the same mechanism as `last` below — so each
    # loop still unwinds into a text answer instead of dying mid-delegation.
    within_turn_budget = deps.spend_round()
    if not within_turn_budget and deps.just_exhausted():
        await deps.emit({"t": "step", "v": ROUND_BUDGET_STEP, "node": node})
    # CHG-0/CHG-32: the final round (and any forced synthesis) is tool-less, so
    # the loop always ends with a text answer grounded in prior results.
    last = (
        (rnd + 1 == max_rounds)
        or bool(state.get("force_synthesis", False))
        or not within_turn_budget
    )

    messages: list[Message] = state["messages"]
    tools: list[dict[str, Any]] = state.get("tools", [])
    # CHG-5: a fresh model round begins — the frontend clears its live text, so
    # what the user sees is always exactly the current round's words. Which is
    # exactly why only ONE loop at a time may say it (`Deps.claim_live`): a
    # batch of specialists all writing into that one area is a jumble that each
    # of them then blanks.
    #
    # Both events carry the emitting node. Unlike step/step_status, the HOST does
    # not forward it — `ask-round` is emitted with an empty payload and
    # `ask-delta` with just the text — and it is not needed for display either,
    # because the lease above already guarantees the live area has exactly one
    # writer, so "the active agent" is never ambiguous. The stamp is on the wire
    # as the evidence the lease is checked AGAINST (a `delta` landing inside
    # another node's live block is a lease bug, and only the stamp can show it);
    # forwarding it in `sidecar.rs` is a future option, not something the UI does
    # today.
    live = deps.claim_live(node)
    if live:
        await deps.emit({"t": "round", "node": node})

    offered: list[dict[str, Any]] = [] if last else tools

    async def on_delta(d: str) -> None:
        if live:
            await deps.emit({"t": "delta", "v": d, "node": node})

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
        # The TAIL, not the whole log. The note is rebuilt every round and the
        # budget protects a note from trimming, so an unbounded one grows all
        # turn and is paid for out of the same window as the tool RESULTS — on a
        # long turn the fitter starts dropping the file contents and search hits
        # that the note is only a one-line summary of. The recent steps are the
        # ones a small model loses track of; the older ones are still above it
        # in the thread — which the note SAYS when it trims, because the list is
        # numbered from 1 either way and otherwise reads as the whole turn.
        if len(progress) <= PROGRESS_NOTE_LINES:
            shown = progress
        else:
            kept = progress[-(PROGRESS_NOTE_LINES - 1):]
            shown = [PROGRESS_ELIDED.format(n=len(progress) - len(kept)), *kept]
        notes.append(turn_progress_note(shown))
    # A ground-truth correction is NOT gated on `small`. It says the tools
    # disagree with what the model is about to claim, which a cloud engine can
    # be just as wrong about — and it is the whole point of a `verify` shape.
    corrections: list[str] = list(state.get("corrections", []))
    if corrections:
        notes.append(correction_note(corrections))
    to_send = messages + [{"role": "user", "content": n} for n in notes] if notes else messages

    try:
        content, calls, usage = await deps.chat.stream(
            to_send, offered, on_delta, deps.cancel
        )
    finally:
        # Hand the live area back the moment this round stops talking — whether
        # it answered, failed or was cancelled. A lease nobody releases is a
        # muted UI for the rest of the turn.
        deps.release_live(node)

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
    # `to_send`, not `messages`: the ephemeral notes above ARE part of the
    # request, so leaving them out under-counted every round that carried one —
    # only the colours on an engine that reports its own totals, but the whole
    # number on an engine that does not.
    breakdown_chars = categorize_messages(to_send, json_chars(offered))
    await deps.emit(
        {"t": "usage", "node": node, **build_usage_event(rnd, usage, breakdown_chars)}
    )

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
    """One room tool. A failure of ANY kind comes back as a tool RESULT.

    `McpClient.call_tool` turns its own protocol errors into `is_error` results
    for exactly this reason — "so the round can still make progress" — but it
    catches `McpError` only. A dropped connection or a timed-out request raises
    httpx straight through the tool loop instead: the specialist died mid-task,
    its half-finished work went with it, and raw transport text ended up in the
    answer. A tool that could not run is a result the model can read and react
    to, and that is true whether the room refused or the socket did.
    """
    if deps.mcp is None:
        return ToolResult(text="no room bridge is available", is_error=True)
    try:
        return await deps.mcp.call_tool(call.name, call.arguments)
    except asyncio.CancelledError:
        # Stop, or the run being torn down — not a tool failure.
        raise
    except Exception as exc:  # noqa: BLE001 - one tool, not the whole ask
        _log.error("the room bridge failed on %s", call.name, exc_info=True)
        return ToolResult(text=f"the room bridge failed: {_why(exc)}", is_error=True)


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
    own = get_agent(str(state.get("agent_id", ""))).group
    if group == own:
        # The hatch widens a MISSED lane, never an agent inside its own domain
        # (see `_locked_groups`). The enum never offers this, so reaching here
        # means the model asked for it anyway.
        return (
            f"The rest of the {group} tools belong to another specialist. Do what "
            "your own instructions allow and report the rest as MISSING.",
            False,
            None,
        )
    names = group_tools(group)
    # The same servability question `_locked_groups` asks, asked the same way:
    # a group whose load-bearing tools this tier withholds is NOT unlockable,
    # however many of its incidental tools were served. Answering "here you go"
    # here would append `group_prompt` — a briefing on tools the model does not
    # hold — which is the whole failure this gate exists to prevent.
    if not group_servable(group, served_names):
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
    still_locked = _locked_groups(served_names, offered, unlocked, own)
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


def _live_domains(state: AgentState, served_names: set[str]) -> list[str]:
    """Which specialists exist for THIS turn — the hub's delegation guard.

    Reachability and nothing else. It used to apply the `*` tag on top as a
    NARROWING (``[tagged] if tagged in keys else keys``), which is the shape
    the owner reported: the Main agent still ran, saw a one-item roster and
    delegated into it. A tagged turn never reaches the hub now
    (`run_agent`), so there is no tag here to apply.
    """
    return reachable_domain_keys(
        web_enabled=bool(state.get("web_enabled", False)),
        served_names=served_names,
    )


def _unavailable_note(key: str, available: list[str]) -> str:
    """What the Main agent is told when it asks for a specialist this room lacks.

    ONE wording for BOTH delegation paths. The batch dispatcher grew this guard
    first and the direct ``ask_*_agent`` path never got it — that path only
    calls `resolve_worker`, which falls through to the DEFAULT worker when every
    member of a domain is unreachable. So "ask the Web agent what the weather
    is" in a web-off room was answered out of the user's own documents, under a
    "File agent" label.
    """
    names = ", ".join(available) or "none"
    return (
        f"This room has no {key!r} specialist right now (available: {names}). "
        "MISSING: tell the user plainly that this room cannot do that part — "
        "do not answer it from memory."
    )


#: Ceiling on a report as SHOWN in the agent diagram. The report itself is
#: never touched — this bounds only the copy that travels to the UI, because a
#: file-reading specialist can hand back a whole book and the inspector is a
#: panel in a chat bubble. Generous enough that a normal report arrives whole.
MAX_SHOWN_REPORT_CHARS = 40_000


def _clip_report(text: str) -> str:
    """A report trimmed for display, saying so when it was."""
    if len(text) <= MAX_SHOWN_REPORT_CHARS:
        return text
    kept = text[:MAX_SHOWN_REPORT_CHARS]
    dropped = len(text) - MAX_SHOWN_REPORT_CHARS
    return f"{kept}\n\n… {dropped:,} more characters were reported to the Main agent."


class WorkerOutcome(NamedTuple):
    """What one delegation — a single specialist, or a whole ``ask_agents``
    batch — hands back to the sequential pass.

    A NamedTuple rather than a plain tuple so the fields name themselves at the
    call sites: the collectors used to read ``result[1]`` / ``result[2]`` and
    needed a comment to say which was which. Still a tuple, so
    ``report, ok, cancelled, refs = ...`` keeps working.
    """

    #: The text that joins the MAIN thread as this call's tool message.
    report: str
    #: "Did something actually come back" — gates memoisation, the findings
    #: baton and the green/red step chip. Never derived from a model call.
    ok: bool
    #: Stop was pressed somewhere inside this delegation.
    cancelled: bool
    #: Artifacts this delegation ADDED, for the caller to merge into the baton.
    referents: list[str]


async def _run_worker(
    state: AgentState,
    config: RunnableConfig,
    worker_id: str,
    instruction: str,
    referents: list[str],
    node_key: str,
    upstream: tuple[str, ...] = (),
) -> WorkerOutcome:
    """Execute one ask_*_agent delegation: run the specialist's own scoped
    sub-loop and return a :class:`WorkerOutcome`. Only the REPORT joins the main
    thread — the worker's internal tool traffic stays its own.

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
        # Seeded EMPTY like `produced`: the run's store is shared, but a child
        # may only read back what IT parked.
        "spills": [],
        "referents": list(referents),
        # Seeded EMPTY, deliberately: this child's write-claim gate must judge
        # what IT wrote, not what the Main agent's baton already carried.
        "produced": [],
        "pipeline": [],
        "worker_base_messages": [],
        "messages": base,
        "seen": set(),
        "force_synthesis": False,
        "stalls": 0,
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
    from .graphs import graph_for, recursion_limit_for, worker_report

    # Owner replacement #3: this specialist is a CHILD of the run. It reads the
    # run's Stop through its token's parent chain exactly as it did when every
    # loop shared one token, and it now has a node of its own — which is what
    # makes a Stop reportable per specialist instead of per turn. Held for the
    # child's lifetime by this frame, so the parent's link prunes itself when
    # the specialist returns.
    child_deps = deps.for_child(worker.label)
    # One slot per child. Unbounded on a cloud room; serialized on a local one,
    # where a single resident model means N children are contention, not speed.
    async with deps.worker_slot():
        final: AgentState = await graph_for(worker.id).ainvoke(
            initial,
            config={
                "configurable": {"deps": child_deps},
                # Sized to THIS worker's shape — not every shape spends two
                # supersteps per round (see recursion_limit_for).
                "recursion_limit": recursion_limit_for(worker.id, max_rounds),
            },
        )  # type: ignore[assignment]
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
    #
    # 2026-08-01: `bool(final_text)` was that verdict, and it passed the one
    # shape the local models actually produce — "Done." after a round of real
    # tool calls, or the contract's own three lines filled with "nothing". Both
    # are empty reports wearing a green chip, and the Main agent composes the
    # user's answer out of them. `graphs.worker_report` is the same question
    # asked properly, still with no model call.
    report, ok = worker_report(worker.label, final)
    return WorkerOutcome(report, ok, cancelled, worker_refs)


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


@dataclass(slots=True)
class _Batch:
    """One ``ask_agents`` plan's accumulators, every one of them keyed by task
    INDEX — the position in the model's own plan, which is what its
    ``depends_on`` numbers refer to.

    Per-PLAN and NOT per-round, deliberately: two ``ask_agents`` calls in one
    round run their plans concurrently against the same :class:`_Delegator`, so
    this state cannot live on it without the two batches reading each other's
    reports.
    """

    #: Task index -> the line that joins the plan's one combined tool message.
    reports: dict[int, str] = field(default_factory=dict)
    #: Per-task outcome. The plan's own `ok` is ANY of these — a batch whose
    #: tasks ALL came back empty still cannot render as a green step (the
    #: same reason a single delegation's `ok` stopped being hardcoded True),
    #: but a PARTIAL batch counts as a success.
    #:
    #: It was the AND until 2026-07-30, and that cost the user real work: in
    #: the BATCH_TOOL_NAME branch `ok=False` skips BOTH
    #: `reports_so_far.append` and `seen.add(key)`. So a 3-task batch where
    #: two tasks reported and one hit an unavailable domain (a) dropped both
    #: real reports out of the findings baton — the next round's specialists
    #: lost exactly the findings that baton was added to carry, and the
    #: "find X then act on X" chain fell back to the hub restating X — and
    #: (b) left the call unmemoised, so the model could legally re-emit the
    #: identical batch next round and the two successful tasks were re-run
    #: and re-paid for. The report TEXT is unchanged: every failed or
    #: unavailable task still says so on its own line, so the Main agent can
    #: still tell the user plainly what could not be done.
    task_ok: dict[int, bool] = field(default_factory=dict)
    #: The referent baton as the plan has grown it: what it started with, plus
    #: every artifact its children reported, merged in dispatch order.
    gathered: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _Delegator:
    """One round's fan-out: launch every delegation, track its roster slot, and
    drain the batch if the turn is torn down.

    Extracted from ``execute_tools`` 2026-07-30. It was three async closures
    (``_tracked``/``_register``/``_run_plan``) over ~15 locals inside a 567-line
    node — the ONE function every graph shape shares and where SPEC §3.2's
    invariants live — so none of its phases could be exercised on its own, which
    is the worst possible place in the package to have no unit seam.
    ``execute_tools`` keeps what only it can do (the assistant turn, the state
    update); the strictly-sequential per-call pass is :class:`_ToolPass`, and
    everything that runs CONCURRENTLY lives here.

    Behaviour-identical by construction: ``pipeline`` is the SAME list object
    ``execute_tools`` hands back in its updates, so a slot claimed here is
    visible there — exactly what the closures' shared local did.
    """

    deps: Deps
    config: RunnableConfig
    state: AgentState
    #: The turn's roster, shared BY REFERENCE with the caller (see above).
    pipeline: list[dict[str, Any]]
    #: This round's batch number — the band everything dispatched at round start
    #: shares. Later waves take their own band from `wave_batch`.
    batch: int
    #: The referent baton as it stood when this round's batch launched.
    referents_at_launch: list[str]
    #: Earlier ROUNDS' findings, prepended to every child's kickoff note.
    carryover: tuple[str, ...]
    #: What the bridge served this run — how a delegation resolves to a worker.
    served_names: set[str]
    #: The domains this room can actually serve, by short key — THE definition
    #: of "which specialists exist right now" (`reachable_domain_keys`). Read by
    #: BOTH delegation paths, so neither can dispatch a phantom.
    live_domain_keys: list[str]
    #: The next free band number, handed out by `wave_batch`. Seeded lazily from
    #: `batch` so no constructor has to remember to keep the two in step.
    next_batch: int | None = None
    #: Duplicate keys already dispatched this round.
    launched: set[str] = field(default_factory=set)
    #: call id -> the human label of whatever is running for it, so a crash can
    #: be reported by name without re-resolving the worker in the error path.
    launched_label: dict[str, str] = field(default_factory=dict)
    #: call id -> how many tasks its `ask_agents` plan parsed to. Carried from
    #: the fan-out, where the parse already happened, so the sequential pass's
    #: progress line does not re-parse the whole plan just to count it.
    plan_sizes: dict[str, int] = field(default_factory=dict)
    #: call id -> the in-flight delegation the sequential pass will await.
    tasks: dict[str, asyncio.Task[WorkerOutcome]] = field(default_factory=dict)

    @classmethod
    def for_round(
        cls,
        deps: Deps,
        config: RunnableConfig,
        state: AgentState,
        referents: list[str],
        reports_so_far: list[tuple[str, str]],
    ) -> _Delegator:
        """This round's fan-out, with everything it derives from ``state``.

        ``referents`` and ``reports_so_far`` are the caller's own accumulators
        (see :meth:`_ToolPass.for_round`) rather than re-read from state: the
        batons this round's children are handed are the ones the round is
        actually working with.
        """
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
        # Children dispatched together share a batch number — the ONE fact that says
        # "these ran at the same time", which no amount of roster diffing downstream
        # can reconstruct reliably. Derived from the roster so it needs no state.
        batch = max((int(e.get("batch") or 0) for e in pipeline), default=-1) + 1
        return cls(
            deps=deps,
            config=config,
            state=state,
            pipeline=pipeline,
            batch=batch,
            referents_at_launch=referents_at_launch,
            carryover=carryover,
            served_names=served_names,
            # The same list that built the `agent` enum the model chose from, so
            # the guard and the catalog cannot disagree: a domain the hub was
            # never offered is refused here by name rather than falling through
            # to `resolve_worker`'s default worker.
            live_domain_keys=_live_domains(state, served_names),
        )

    def wave_batch(self, wave_no: int) -> int:
        """The parallel BAND one wave belongs to — what makes concurrency legible.

        Everything a round dispatches at once shares the round's band, and that
        includes the FIRST wave of every ``ask_agents`` plan in it: those really
        do start together. Every LATER wave takes a band of its own, because it
        did not. The band used to be `round batch + wave index`, so two plans
        launched in the same round had their second waves drawn as one group
        however far apart they actually ran.

        Allocation is atomic by construction: no await between the read and the
        write, and asyncio gives us one thread.
        """
        if wave_no == 0:
            return self.batch
        if self.next_batch is None:
            self.next_batch = self.batch + 1
        band = self.next_batch
        self.next_batch += 1
        return band

    def register(self, worker_id: str, instruction: str, batch: int) -> dict[str, Any]:
        """Claim this child's roster slot. Call order, before anything runs."""
        entry: dict[str, Any] = {
            "agent": worker_id,
            "instruction": instruction,
            "status": "running",
            "batch": batch,
            "key": f"{worker_id}#{len(self.pipeline)}",
        }
        self.pipeline.append(entry)
        return entry

    def unavailable(self, domain_key: str | None) -> str | None:
        """The refusal for a domain this room cannot serve, else ``None``.

        ``None`` for an UNRECOGNISED name keeps the tolerant fallback a garbled
        key has always had: `resolve_worker` lands on the default worker.
        Recognised-but-unavailable is the case this refuses.
        """
        if domain_key is None or domain_key in self.live_domain_keys:
            return None
        return _unavailable_note(domain_key, self.live_domain_keys)

    def register_unavailable(
        self, tool: str, instruction: str, batch: int, refusal: str = ""
    ) -> dict[str, Any]:
        """A roster slot, already marked failed, for a delegation this room
        cannot run.

        The specialist is named WITHOUT ``served_names``: we are naming the one
        the user asked for, not choosing one to run. Without this the task was
        simply absent from the live picture — the assistant was told in text and
        said so, but the diagram showed a turn that never asked.

        ``refusal`` rides on the roster entry rather than going out as a
        ``report`` event, because one of the two callers is synchronous and
        cannot await an emit. The roster is a complete snapshot on every
        `plan`, so the reason reaches the UI either way — and a node that never
        ran is precisely the one whose "why" is otherwise unrecoverable.
        """
        entry = self.register(resolve_worker(tool, instruction), instruction, batch)
        entry["status"] = "failed"
        if refusal:
            entry["report"] = refusal
        return entry

    async def tracked(
        self,
        entry: dict[str, Any],
        worker_id: str,
        instruction: str,
        node_key: str,
        baton: list[str] | None = None,
        *,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        """Run one child, flipping ITS roster slot as it starts and finishes.

        The status flip has to happen where the child actually ends, not where
        the parent collects it: reports are collected in call order, so a fast
        third child would otherwise keep pulsing on screen until the slow first
        one returned — the exact illusion this feature exists to remove.
        """
        try:
            result = await _run_worker(
                self.state,
                self.config,
                worker_id,
                instruction,
                self.referents_at_launch if baton is None else baton,
                node_key,
                upstream,
            )
        except asyncio.CancelledError:
            # Stop pressed / a sibling failed the round. Mark it, but do NOT
            # emit — nothing is draining the queue once the run is torn down.
            entry["status"] = "failed"
            raise
        except Exception as exc:
            entry["status"] = "failed"
            # Twice: once for the user, once for disk. The report box is the only
            # thing a user sees, but it lives and dies with the turn's diagram —
            # so a failure that needs looking into later left NOTHING behind (the
            # stderr log sat empty through exactly such a failure). The run-level
            # handler never fires here, because a failed child does not fail the run.
            _log.warning(
                "delegation to %s failed: %s", node_key, _why_failed(exc), exc_info=True
            )
            await self._emit_report(node_key, _why_failed(exc), ok=False)
            await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))
            raise
        entry["status"] = "done" if result.ok and not result.cancelled else "failed"
        await self._emit_report(
            node_key, result.report, ok=result.ok and not result.cancelled
        )
        await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))
        return result

    async def _emit_report(self, node_key: str, text: str, *, ok: bool) -> None:
        """Hand the UI what this child actually said back to the Main agent.

        WHY THIS EXISTS AS ITS OWN EVENT. A child's words already reach the
        screen as `delta`s while it holds the live-text lease, and they are
        wiped by the next `round` — correctly, because that area shows the
        CURRENT round. The consequence was that a specialist's answer flashed
        up and vanished, and the only lasting trace was a green tick: the
        diagram could say a child had "reported back to the Main agent" without
        being able to show one word of the report.

        Reconstructing it from the delta stream would be the wrong fix twice
        over — deltas are only emitted by the lease HOLDER (so a child that
        never held it streams nothing at all), and a failed child's reason
        never goes through them. This is the report itself: exactly the text
        that became the Main agent's tool message, success or failure.
        """
        await self.deps.emit(
            {
                "t": "report",
                "node": node_key,
                "v": _clip_report(text),
                "ok": ok,
            }
        )

    async def run_plan(self, plan: list[dict[str, Any]]) -> WorkerOutcome:
        """Run one ``ask_agents`` batch wave by wave; one combined report back.

        Independent tasks in a wave run concurrently; a wave starts only once
        every task it depends on has reported, and those reports are handed to
        the dependents verbatim. The whole plan is ONE tool call, so it returns
        ONE tool message — the reports are labelled by task position, which is
        what the model's `depends_on` indices refer to.
        """
        waves = plan_waves(plan)
        batch = _Batch(gathered=list(self.referents_at_launch))
        cancelled_any = False
        for wave_no, wave in enumerate(waves):
            if self.deps.cancel.cancelled:
                cancelled_any = True
                break
            running = self._launch_wave(plan, wave, wave_no, batch)
            await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))
            if await self._collect_wave(running, batch):
                cancelled_any = True
                break
        text = "\n\n".join(batch.reports[i] for i in sorted(batch.reports)) or (
            "No tasks ran — the plan was empty."
        )
        new_refs = [r for r in batch.gathered if r not in self.referents_at_launch]
        return WorkerOutcome(text, any(batch.task_ok.values()), cancelled_any, new_refs)

    def _launch_wave(
        self,
        plan: list[dict[str, Any]],
        wave: list[int],
        wave_no: int,
        batch: _Batch,
    ) -> list[tuple[int, dict[str, Any], asyncio.Task[Any]]]:
        """Start every task in ONE wave; collect none of them.

        A task whose domain this room cannot serve is answered into ``batch``
        here and never launches. Returns the in-flight tasks in dispatch order,
        for :meth:`_collect_wave`.
        """
        baton = list(batch.gathered)
        band = self.wave_batch(wave_no)
        running: list[tuple[int, dict[str, Any], asyncio.Task[Any]]] = []
        for idx in wave:
            task_spec = plan[idx]
            key = str(task_spec.get("agent", ""))
            # Accept any spelling of a domain a small model might emit —
            # short key, full tool name, or a member worker id.
            norm = normalize_domain_key(key)
            # UNRECOGNISED stays tolerant: fall through to resolve_worker's
            # default, exactly as before. RECOGNISED-BUT-UNAVAILABLE is the
            # bug this guard exists for — `DOMAIN_KEYS` is unfiltered, so a
            # "web" task in a web-off room resolved to chat.web, found it
            # unreachable, and landed on the File agent, which answered a
            # weather question from room content. Report MISSING instead.
            # Belt to the braces of the generated enum + description: even
            # if that ever drifts again, this cannot become a fabrication.
            refusal = self.unavailable(norm)
            if refusal is not None:
                batch.reports[idx] = f"Task {idx} could not run. {refusal}"
                batch.task_ok[idx] = False
                # ...and it shows up in the live picture as the failed node it
                # is, rather than being silently absent from the diagram while
                # the assistant is told about it in text.
                self.register_unavailable(
                    DOMAIN_KEYS.get(norm or "", ""),
                    str(task_spec["instruction"]),
                    band,
                    refusal,
                )
                continue
            entry, task = self._launch_task(task_spec, norm, band, baton, batch)
            running.append((idx, entry, task))
        return running

    def _launch_task(
        self,
        task_spec: dict[str, Any],
        norm: str | None,
        band: int,
        baton: list[str],
        batch: _Batch,
    ) -> tuple[dict[str, Any], asyncio.Task[WorkerOutcome]]:
        """Resolve ONE task to a worker, claim its roster slot, and start it."""
        domain = DOMAIN_KEYS.get(norm, "") if norm else ""
        instruction = str(task_spec["instruction"])
        worker_id = resolve_worker(
            # An unknown/absent domain key falls through to
            # resolve_worker's own default rather than being refused.
            domain,
            instruction,
            served_names=self.served_names,
            web_enabled=bool(self.state.get("web_enabled", False)),
        )
        entry = self.register(worker_id, instruction, band)
        dep_reports = tuple(
            batch.reports[d]
            for d in sorted(set(task_spec.get("depends_on", [])))
            if d in batch.reports
        )
        # Its own dependencies first; earlier ROUNDS' findings behind
        # them, so a plan that follows a previous round still sees what
        # that round learned.
        upstream = dep_reports + self.carryover
        return entry, asyncio.create_task(
            self.tracked(
                entry,
                worker_id,
                instruction,
                entry["key"],
                baton,
                upstream=upstream,
            )
        )

    async def _collect_wave(
        self,
        running: list[tuple[int, dict[str, Any], asyncio.Task[Any]]],
        batch: _Batch,
    ) -> bool:
        """Await one wave and record it into ``batch``. True when a child came
        back cancelled — Stop landed inside it, so the wave loop must stop."""
        results = await asyncio.gather(
            *(t for _, _, t in running), return_exceptions=True
        )
        cancelled_any = False
        for (idx, entry, _), result in zip(running, results):
            label = get_agent(str(entry["agent"])).label
            if isinstance(result, BaseException):
                # One task failing must not abort its siblings or the plan:
                # the Main agent is told, and decides what to do with the
                # rest. A raised exception here would strand the whole batch.
                # `_why`, not the bare exception: several of the errors that land
                # here str() to "", and "failed:" with nothing after it is what
                # the Main agent would then tell the user.
                batch.reports[idx] = f"Task {idx} ({label}) failed: {_why(result)}"
                batch.task_ok[idx] = False
                continue
            report, child_ok, child_cancelled, child_refs = result
            batch.task_ok[idx] = bool(child_ok)
            batch.reports[idx] = f"Task {idx} — {report}"
            cancelled_any = cancelled_any or child_cancelled
            for ref in child_refs:
                if ref not in batch.gathered:
                    batch.gathered.append(ref)
        return cancelled_any

    async def launch(self, calls: list[ToolCall], seen: set[str]) -> None:
        """Start every delegation in ``calls``; collect none of them.

        Each one is parked in ``self.tasks`` under its call id for the
        sequential pass to await IN CALL ORDER. ``seen`` is the caller's memo of
        this turn's already-successful calls, read-only.
        """
        for call in calls:
            if call.name == BATCH_TOOL_NAME:
                key = call.key()
                if key in seen or key in self.launched:
                    continue
                plan = parse_plan((call.arguments or {}).get("tasks"))
                if not plan:
                    continue  # answered inline by the caller with a corrective note
                self.launched.add(key)
                self.launched_label[call.id] = "task plan"
                # The size is recorded HERE, where the plan is already parsed:
                # the progress line used to re-parse the whole argument just to
                # count its tasks.
                self.plan_sizes[call.id] = len(plan)
                self.tasks[call.id] = asyncio.create_task(self.run_plan(plan))
                continue
            if call.name not in AGENT_TOOL_NAMES:
                continue
            key = call.key()
            # Same-round duplicate: the sequential pass answers the repeat from
            # `seen`/the duplicate note, so it must not get its own worker.
            if key in seen or key in self.launched:
                continue
            # A domain this room cannot serve gets no worker at all — the
            # sequential pass answers it with the same MISSING note the batch
            # path uses (`_ToolPass._delegation`). Launching it would hand the
            # ask to `resolve_worker`'s DEFAULT specialist under the label of
            # the one the model asked for.
            if self.unavailable(normalize_domain_key(call.name)) is not None:
                continue
            self.launched.add(key)
            instruction = str(
                (call.arguments or {}).get("instruction") or self.state.get("question", "")
            )
            # Resolve HERE, not inside the worker: the pipeline roster has to be
            # registered in call order before anything runs concurrently.
            worker_id = resolve_worker(
                call.name,
                instruction,
                served_names=self.served_names,
                web_enabled=bool(self.state.get("web_enabled", False)),
            )
            entry = self.register(worker_id, instruction, self.batch)
            self.launched_label[call.id] = get_agent(worker_id).label
            self.tasks[call.id] = asyncio.create_task(
                self.tracked(
                    entry, worker_id, instruction, entry["key"], upstream=self.carryover
                )
            )

    async def drain(self) -> None:
        """Cancellation between calls must not orphan running sub-loops."""
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)


@dataclass(slots=True)
class _ToolPass:
    """This round's SEQUENTIAL pass over the model's calls: one tool at a time,
    in the model's own call order, and where SPEC §3.2's invariants live.

    Extracted from ``execute_tools`` 2026-07-30, the second half of the split
    that produced :class:`_Delegator`. It was a four-way dispatch inline in a
    345-line node, every arm mutating a dozen shared locals, so the rules that
    live here — duplicate suppression, the hub guard, "only SUCCESSFUL calls are
    memoised", the LEDGER baton, the image handoff, drain-on-Stop — could be
    reached only by invoking a compiled graph with a per-child scripted model.
    They are unit-testable now.

    A dataclass rather than a pile of parameters because the accumulators ARE
    the state: every arm reads and writes several of them, and the node's whole
    returned update is built from all of them at once (:meth:`to_updates`).
    They are the SAME objects the caller unpacked and the same ones it hands
    back, exactly as the inline locals were.

    Sequential BY CONSTRUCTION: :meth:`run` awaits one arm before it looks at
    the next call. A provider that pairs tool messages positionally sees a
    scrambled transcript otherwise — which is why the delegations that DO
    overlap are launched by :class:`_Delegator` before the pass starts and only
    AWAITED here, in call order.
    """

    deps: Deps
    config: RunnableConfig
    state: AgentState
    #: The ACTIVE sub-agent. The hub guard and `list_skills` scoping turn on it.
    agent: AgentSpec
    node: str
    delegator: _Delegator
    # --- the accumulators every arm mutates; see `for_round`
    messages: list[Message]
    seen: set[str]
    attempted: set[str]
    progress: list[str]
    referents: list[str]
    produced: list[str]
    reports_so_far: list[tuple[str, str]]
    unlocked: set[str]
    #: Refs this loop has parked, oldest first (see `AgentState.spills`).
    spills: list[str]
    pending_images: list[str]
    #: The catalog a mid-round rebuild produced — `request_tools` unlocking a
    #: group, or a spill minting the reader — or None if neither happened. The
    #: one key `to_updates` adds conditionally.
    tools_update: list[dict[str, Any]] | None = None
    all_dup: bool = True
    cancelled: bool = False

    @classmethod
    def for_round(
        cls,
        deps: Deps,
        state: AgentState,
        config: RunnableConfig,
        messages: list[Message],
    ) -> _ToolPass:
        """This round's pass, with every accumulator unpacked from ``state``.

        COPIES of the state's collections, never the state's own objects (the
        exception is ``messages``, which the node appends to in place exactly as
        it always has): a LangGraph node returns its updates.
        """
        # The referent baton: artifacts later plan steps get told about by code.
        referents: list[str] = list(state.get("referents", []))
        # The FINDINGS baton: what specialists reported in EARLIER rounds. Carried
        # to this round's children verbatim, so a "find X then act on X" chain never
        # depends on the hub restating X in its own instruction.
        reports_so_far: list[tuple[str, str]] = [
            (str(a), str(b)) for a, b in state.get("reports", [])
        ]
        return cls(
            deps=deps,
            config=config,
            state=state,
            agent=get_agent(str(state.get("agent_id", ""))),
            # Who is emitting: the hub, or one specific child slot. Stamped onto every
            # step/step_status this loop emits (see AgentState.node_key).
            node=str(state.get("node_key") or MAIN_NODE_KEY),
            delegator=_Delegator.for_round(deps, config, state, referents, reports_so_far),
            messages=messages,
            seen=set(state.get("seen", set())),
            # Every tool the model actually reached — the `verify` shapes' ground truth.
            attempted=set(state.get("attempted", set())),
            # The turn's verified action log (small-model mode re-injects it each round).
            progress=list(state.get("progress", [])),
            referents=referents,
            # ...and the subset THIS loop produced, which is what the write gate reads.
            produced=list(state.get("produced", [])),
            reports_so_far=reports_so_far,
            # Groups + catalog may change mid-round via request_tools.
            unlocked=set(state.get("unlocked_groups", set())),
            # ...and via a parked result, which mints the reader the same way.
            spills=list(state.get("spills", [])),
            # Pixels captured this round, drained into a user message as soon as they
            # appear (mirrors the Rust `effects.pending_images`).
            pending_images=list(state.get("pending_images", [])),
            cancelled=deps.cancel.cancelled,
        )

    async def fan_out(self, calls: list[ToolCall]) -> None:
        """Fan-out: every delegation this round starts BEFORE any of them is awaited."""
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
        #
        # A WORKER never delegates: its catalog holds no ask_* tool at all, so the
        # whole scan is dead for one. Guarded ONCE here rather than tested per call
        # inside the scan — and a worker that invents one anyway is refused by
        # `_rejected_by_catalog_guard`, not run inline off an empty base thread.
        if self.agent.main:
            await self.delegator.launch(calls, self.seen)

        if self.delegator.tasks:
            # One roster emit for the whole batch — every child in it is already
            # marked `running`, so the UI lights them all at once. The legacy
            # single active marker points at the first of them.
            #
            # Read OFF THE ROSTER (`_active_step` = the first slot still running)
            # rather than computed as `len(pipeline) - len(tasks) + 1`, which was
            # wrong whenever the two counts disagreed: an `ask_agents` call parks
            # a `run_plan` task WITHOUT claiming a slot of its own (its tasks
            # claim theirs later, inside `_launch_task`), so tasks outnumbered
            # slots and the arithmetic walked BACKWARDS off the front of the
            # roster — with an empty prior roster, one `ask_agents` call silently
            # marked the Main agent active (`roster[-1]`) and two raised
            # `IndexError: list index out of range` out of `execute_tools`,
            # killing the turn. Found 2026-07-30; the same arithmetic is in
            # 0.12.0. `_active_step` cannot go out of range by construction.
            await _emit_pipeline(
                self.deps,
                self.delegator.pipeline,
                active_step=_active_step(self.delegator.pipeline),
            )

    async def run(self, calls: list[ToolCall]) -> None:
        """Walk this round's calls ONE AT A TIME, in the model's own call order —
        each arm awaited before the next call is looked at, Stop checked BETWEEN
        calls, and cancelling drains the in-flight children instead of orphaning
        them."""
        for call in calls:
            # ADD-7: stop between tool calls.
            if self.deps.cancel.cancelled:
                self.cancelled = True
                await self.delegator.drain()
                break
            # A skill may belong to ONE sub-agent, and `list_skills` scopes its
            # answer to the caller. The Rust bridge is built per RUN, not per
            # worker, so it cannot know which specialist is asking — we do, so the
            # id is injected here rather than left to the model to remember.
            if call.name == "list_skills":
                call.arguments = {**(call.arguments or {}), "agent": self.agent.id}

            key = call.key()
            if key in self.seen:
                # CHG-3: don't re-run an identical call or re-flood the context.
                self.messages.append(
                    tool_message(duplicate_call_note(call.name), call.name, call.id)
                )
                continue
            self.all_dup = False

            if self._rejected_by_catalog_guard(call):
                continue

            # CHG-5: a human step label, not inline "⚙ name…" answer text. Stamped
            # with the emitting loop's node so the UI can file it under the right
            # agent — siblings run concurrently, so arrival order proves nothing.
            await self.deps.emit(
                {"t": "step", "v": tool_step_label(call.name), "node": self.node}
            )

            arm = self._arm_for(call)
            if not await arm(call, key):
                break

        if self.delegator.tasks and not self.cancelled:
            # The Main agent resumes — mark it active again so its chip pulses while
            # it reads the batch's reports and decides the next move. This used to
            # live at the tail of `_run_worker`; with a parallel batch it belongs
            # here, once, after every child has been collected.
            roster = self.delegator.pipeline
            await _emit_pipeline(self.deps, roster, active_step=len(roster) + 1)

    def _rejected_by_catalog_guard(self, call: ToolCall) -> bool:
        """True when this call was ANSWERED with a corrective note instead of
        being run at all: a call the ACTIVE agent does not own.

        Two directions, one rule. The MAIN agent never touches a room tool — it
        delegates. A WORKER never delegates: no ask_* tool is in any worker's
        box, so a delegation emitted by one is a name the model invented.

        Only the first direction was guarded, and the second was HONOURED:
        `_arm_for` dispatches on the tool NAME alone, so a worker's invented
        `ask_file_agent` reached `_delegation`, found no launched task (the
        fan-out only launches for the hub) and ran the child INLINE — built from
        `worker_base_messages`, which is seeded EMPTY for a worker. That is a
        whole nested assistant with no system prompt, no room context and no
        rules, whose answer rejoined the thread as a genuine specialist report.
        Nothing bounded the nesting either: that child could do it again.

        The same call spelled `ask_agents` fell through to `_batch`, which
        answered a worker with `EMPTY_PLAN_NOTE` — a lecture on how to format a
        task list, for a tool it does not have. The plain truth is what the Main
        agent already gets in the mirror-image case.
        """
        delegation = call.name in AGENT_TOOL_NAMES or call.name == BATCH_TOOL_NAME
        if self.agent.main and not delegation:
            note = (
                f"You have no tool named '{call.name}' — you are the Main "
                "agent and never act directly. Delegate with one of your "
                "ask_*_agent tools, or answer the user."
            )
        elif delegation and not self.agent.main:
            note = (
                f"You have no tool named '{call.name}' — you are the "
                f"{self.agent.label} and cannot hand work to another agent. "
                "Do this task with your own tools, or report what you found "
                "and what is missing."
            )
        else:
            return False
        self.messages.append(tool_message(note, call.name, call.id))
        return True

    def _set_catalog(self, tools: list[dict[str, Any]]) -> None:
        """Adopt a rebuilt catalog, keeping the spill reader offered.

        `request_tools` rebuilds from the SERVED specs, which never contain
        `read_result` — it is minted here, not by the bridge — so a rebuild that
        did not come back through this method would retire the only route to a
        shortened result. Same reason `graphs.narrowed` exists for the shapes
        that narrow the catalog between rounds.
        """
        self.tools_update = with_read_result(tools, self.spills)

    def _park_if_oversized(self, tool: str, result: str) -> str:
        """The result, or a head plus the ref that reads the rest.

        Parking happens at CAPTURE, not at fit time. The budget's own guard
        runs only when a request would otherwise be rejected — far too late for
        a local 4B whose whole window is smaller than one big page — and what it
        does then is truncate, which is the loss this replaces.
        """
        if byte_len(result) <= SPILL_BYTES:
            return result
        spill = self.deps.results.put(tool, result)
        self.spills.append(spill.ref)
        self._set_catalog(
            self.tools_update
            if self.tools_update is not None
            else list(self.state.get("tools", []))
        )
        head = spill.head()
        return spill_note(spill.ref, head, len(head), len(spill.text))

    def _arm_for(self, call: ToolCall) -> Callable[[ToolCall, str], Awaitable[bool]]:
        """Which of the five kinds of call this is. Every arm returns "keep
        going"; False stops the pass (Stop landed inside a child)."""
        if call.name == "request_tools":
            return self._request_tools
        if call.name == READ_RESULT_TOOL:
            return self._read_result
        if call.name == BATCH_TOOL_NAME:
            return self._batch
        if call.name in AGENT_TOOL_NAMES:
            return self._delegation
        return self._room_tool

    async def _request_tools(self, call: ToolCall, key: str) -> bool:
        """One request_tools call: unlock a group and re-offer the catalog."""
        # 2026-07-23: the lane escape hatch — resolved here, never sent to
        # the bridge (the bridge has no such tool).
        group = str((call.arguments or {}).get("group") or "")
        result, ok, new_tools = _unlock_group(group, self.state, self.unlocked, self.messages)
        if new_tools is not None:
            self._set_catalog(new_tools)
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        # Remembered WHATEVER came back, like a delegation and unlike a room
        # tool. Every way this can fail is permanent for the turn: `GROUPS` is a
        # constant, the agent's own group does not change, and `served_specs` is
        # derived once in `prepare` — so none of the three refusals can start
        # succeeding in a later round. Recorded only on success, an identical
        # repeat was never a duplicate, so the round never counted as a stall,
        # the no-progress gate that is supposed to end it never fired, and a
        # model that kept asking burned rounds to the turn-wide backstop.
        self.seen.add(key)
        self.progress.append(f"request_tools(group={group}) -> {'ok' if ok else 'error'}")
        self.messages.append(tool_message(result, call.name, call.id))
        return True

    async def _read_result(self, call: ToolCall, key: str) -> bool:
        """One read_result call: more of a result this loop already parked.

        Resolved HERE, never sent to the bridge — the bridge has no such tool,
        exactly like `request_tools`. Not recorded in `attempted` for the same
        reason: that set is the write gate's ground truth about ROOM tools, and
        reading text this loop already fetched changed nothing in the room.
        """
        args = call.arguments or {}
        result, ok = read_spill(self.deps.results, self.spills, args)
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        if ok:
            self.seen.add(key)
        self.progress.append(
            f"{call.name}({_args_summary(args)}) -> {'ok' if ok else 'error'}"
        )
        self.messages.append(tool_message(result, call.name, call.id))
        return True

    async def _batch(self, call: ToolCall, key: str) -> bool:
        """One ``ask_agents`` call: collect the plan the fan-out already started."""
        # A whole PLAN, already running wave by wave since the fan-out
        # (`_Delegator.launch`). One call in, one tool message out.
        task = self.delegator.tasks.get(call.id)
        if task is None:
            # `parse_plan` salvaged nothing. Say what was wrong rather than
            # returning an empty report the model will read as "done".
            await self.deps.emit({"t": "step_status", "ok": False, "node": self.node})
            self.progress.append(f"{BATCH_TOOL_NAME}() -> unusable plan")
            self.messages.append(tool_message(EMPTY_PLAN_NOTE, call.name, call.id))
            return True
        try:
            report, ok, plan_cancelled, plan_refs = await task
        except BaseException:
            await self.delegator.drain()
            raise
        for ref in plan_refs:
            if ref not in self.referents:
                self.referents.append(ref)
        if ok:
            self.reports_so_far.append(("specialists", report))
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        self._memoise_delegation(key)
        self.progress.append(
            f"{BATCH_TOOL_NAME}({self.delegator.plan_sizes.get(call.id, 0)} tasks)"
            + (" -> reports received" if ok else " -> no reports")
        )
        self.messages.append(tool_message(report, call.name, call.id))
        if plan_cancelled:
            self.cancelled = True
            await self.delegator.drain()
            return False
        return True

    def _memoise_delegation(self, key: str) -> None:
        """Remember this delegation WHATEVER came back.

        The opposite of a room tool, whose failure may well be transient and is
        deliberately left out of `seen` so a later round can retry it (SPEC
        §3.2). Re-running a specialist is not a retry of one call, it is a whole
        child loop — real waiting, and real money on a cloud room — and the
        outcome it already gave is sitting in the thread right above, which is
        exactly what `duplicate_call_note` points the model at while inviting a
        DIFFERENT instruction. A changed instruction changes `ToolCall.key`, so
        only the byte-identical repeat is suppressed.
        """
        self.seen.add(key)

    async def _delegation(self, call: ToolCall, key: str) -> bool:
        """One ask_*_agent call: collect the specialist and record what it left."""
        # Hub v3: the Main agent asked a specialist. Resolved and executed
        # HERE — the bridge has no such tool; the worker's own sub-loop
        # runs with its scoped box and only its REPORT returns to the
        # main thread. The referent baton carries artifacts across
        # specialists so no model has to remember another's work.
        instruction = str(
            (call.arguments or {}).get("instruction") or self.state.get("question", "")
        )
        # ...unless this room has no such specialist. The batch path has always
        # refused that; this one dispatched it to `resolve_worker`'s DEFAULT
        # worker instead, so "ask the Web agent what the weather is" in a
        # web-off room was answered out of the user's own files under the File
        # agent's label. Same note as the batch path, and no worker runs.
        refusal = self.delegator.unavailable(normalize_domain_key(call.name))
        if refusal is not None:
            self.delegator.register_unavailable(
                call.name, instruction, self.delegator.batch, refusal
            )
            await _emit_pipeline(
                self.deps, self.delegator.pipeline, _active_step(self.delegator.pipeline)
            )
            await self.deps.emit({"t": "step_status", "ok": False, "node": self.node})
            # Memoised like any other delegation: this one cannot start
            # succeeding later in the turn, so a byte-identical repeat is answered
            # from the note already in the thread rather than re-refused every
            # round until the backstop.
            self._memoise_delegation(key)
            self.progress.append(
                f"{call.name}({instruction[:60]}) -> no such specialist"
            )
            self.messages.append(tool_message(refusal, call.name, call.id))
            return True
        report, ok, worker_cancelled, worker_refs = await self._child_outcome(
            call, instruction
        )
        # Merge the child's baton in CALL order, de-duplicated: siblings ran
        # blind to each other, so the union is what later rounds must see.
        for ref in worker_refs:
            if ref not in self.referents:
                self.referents.append(ref)
        if ok:
            # Into the FINDINGS baton, so the NEXT round's specialists get
            # this verbatim instead of the hub having to restate it.
            self.reports_so_far.append(
                (self.delegator.launched_label.get(call.id, "specialist"), report)
            )
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        self._memoise_delegation(key)
        # Truthful either way: this log is the small model's only record of
        # what actually happened, so it must never claim a report it lacks.
        self.progress.append(
            f"{call.name}({instruction[:60]}) -> "
            + ("report received" if ok else "no report")
        )
        self.messages.append(tool_message(report, call.name, call.id))
        if worker_cancelled:
            self.cancelled = True
            await self.delegator.drain()
            return False
        return True

    async def _child_outcome(self, call: ToolCall, instruction: str) -> WorkerOutcome:
        """Await ONE specialist and hand back its outcome, whatever happened."""
        # Already running since the fan-out (`_Delegator.launch`) — this awaits
        # it, it does not start it. A delegation with no task was launched by
        # neither branch (only reachable if the batch scan and this one
        # disagree), so run it inline rather than drop the call on the floor.
        task = self.delegator.tasks.get(call.id)
        try:
            if task is None:
                worker_id = resolve_worker(
                    call.name,
                    instruction,
                    served_names=self.delegator.served_names,
                    web_enabled=bool(self.state.get("web_enabled", False)),
                )
                fallback = self.delegator.register(
                    worker_id, instruction, self.delegator.batch
                )
                result = await _run_worker(
                    self.state,
                    self.config,
                    worker_id,
                    instruction,
                    self.delegator.referents_at_launch,
                    fallback["key"],
                )
                fallback["status"] = (
                    "done" if result.ok and not result.cancelled else "failed"
                )
                return result
            return await task
        except asyncio.CancelledError:
            # Stop, or the run being torn down. Not a specialist failure —
            # let it propagate, after draining the siblings so they do not
            # outlive the turn as orphans emitting into a dead run.
            await self.delegator.drain()
            raise
        except Exception as exc:  # noqa: BLE001 - one child, not the ask
            # ONE specialist blew up (a model error, the recursion limit).
            # This used to re-raise, which killed the whole ask and threw
            # away every sibling report that had already succeeded — while
            # the identical crash inside `ask_agents` degraded to a per-task
            # failure line, because `_Delegator.run_plan` writes out the right
            # rule: "One task failing must not abort its siblings or the plan."
            # The safer behaviour is now the DEFAULT rather than the special
            # case. The Main agent is told, truthfully, and decides.
            who = self.delegator.launched_label.get(call.id, "specialist")
            # `_why`, not the bare exception: this line is handed to the Main
            # agent and from there to the user, and several of the errors that
            # reach it str() to "" — "could not finish:" and nothing after it.
            return WorkerOutcome(
                f"The {who} could not finish: {_why(exc)}", False, False, []
            )

    async def _room_tool(self, call: ToolCall, key: str) -> bool:
        """One ordinary room tool, through the bridge — the only arm that does."""
        outcome = await _run_one_tool(self.deps, call)
        self.attempted.add(call.name)
        ok = not outcome.is_error
        # ADD-22: tell the UI whether the step succeeded, so a failed chip doesn't
        # look identical to a successful one.
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})

        if ok:
            # Only remember successful calls, so a failed one may be re-attempted
            # in a later round (bounded by the round backstop, not a retry cap).
            self.seen.add(key)
            result = outcome.text
            # Referent baton: record produced artifacts so a LATER plan step's
            # kickoff note can name them deterministically — and so the
            # write-claim gate can tell a real write from a claimed one.
            if call.name in LEDGER_TOOLS:
                for artifact in _referent_names(call.name, call.arguments):
                    entry_text = f"{call.name}: {artifact}"
                    self.referents.append(entry_text)
                    self.produced.append(entry_text)
        else:
            result = f"Tool error: {outcome.text}"
        self.progress.append(
            f"{call.name}({_args_summary(call.arguments)}) -> {'ok' if ok else 'error'}"
        )

        self.messages.append(
            tool_message(self._park_if_oversized(call.name, result), call.name, call.id)
        )

        # ADD-25: a perception tool captured pixels. Hand them to the (vision-
        # capable) chat model as a USER message right after the tool result —
        # Ollama reads images from user turns, not tool turns.
        self.pending_images.extend(outcome.images)
        if self.pending_images:
            self.messages.append(user_message(IMAGE_HANDOFF, self.pending_images))
            self.pending_images = []
        return True

    def to_updates(self, synth_turns: list[int]) -> dict[str, Any]:
        """The node's state update. ``tools`` is the one conditional key: it
        appears only if a mid-round `request_tools` rebuilt the offered catalog.
        """
        # A round of only repeats learned nothing. That USED to end the turn on
        # the spot, which punished a model for one wasted round — re-reading a
        # file it just wrote, polling a job, retrying a transient failure are all
        # legitimate repeats mid-task. What actually distinguishes stuck from
        # working is whether it KEEPS happening, so count consecutive stalls and
        # let `config.NO_PROGRESS_ROUNDS` of them be the thing that gives up.
        # Any round that learns something resets the count to zero.
        budget = self.deps.turn_stall_budget
        stalls = (int(self.state.get("stalls", 0)) + 1) if self.all_dup else 0
        force_synthesis = (
            bool(self.state.get("force_synthesis", False))
            or bool(budget and budget > 0 and stalls >= budget)
        )

        updates: dict[str, Any] = {
            "messages": self.messages,
            "seen": self.seen,
            "stalls": stalls,
            "force_synthesis": force_synthesis,
            "round": self.state.get("round", 0) + 1,
            "calls": [],
            "pending_images": self.pending_images,
            "progress": self.progress,
            "referents": self.referents,
            "produced": self.produced,
            "reports": self.reports_so_far,
            "attempted": self.attempted,
            "synth_turns": synth_turns,
            "synth": False,
            "unlocked_groups": self.unlocked,
            "spills": self.spills,
            "pipeline": self.delegator.pipeline,
            "cancelled": self.cancelled or self.deps.cancel.cancelled,
        }
        if self.tools_update is not None:
            updates["tools"] = self.tools_update
        return updates


async def execute_tools(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """Run this round's calls, with duplicate suppression and image handoff.

    Three phases, each its own unit: FAN OUT every delegation (concurrent,
    :class:`_Delegator`), walk the calls one at a time (sequential,
    :meth:`_ToolPass.run`), hand back the state update
    (:meth:`_ToolPass.to_updates`). The assistant turn below is the only thing
    still inline — it has to land between reading the model's calls and running
    any of them.
    """
    deps = _deps(config)
    messages: list[Message] = state["messages"]
    calls: list[ToolCall] = state.get("calls", [])

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

    tool_pass = _ToolPass.for_round(deps, state, config, messages)
    await tool_pass.fan_out(calls)
    await tool_pass.run(calls)
    return tool_pass.to_updates(synth_turns)


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


def _fallback_answer(final: AgentState, *, cancelled: bool) -> str:
    """What to say when the hub's loop ended without composing anything.

    There are four cases here and the old code had ONE net for all of them:
    ``"Done."`` whenever Stop had not been pressed. That is a claim of success
    made without looking at whether anything succeeded — an empty round, a
    refused ask and a model that returned nothing all read to the user as a
    finished job.

    Each of the four gets its own line, and the FOURTH is the reason there are
    four: a specialist's report is recorded on success only, so a turn whose
    specialist failed — or was refused by the no-such-specialist guard — has no
    report, no referent, and is not a turn where nothing ran. It used to be told
    "nothing was run and nothing was changed" while the step chip beside it was
    red.

    No model call anywhere in here. The findings baton already holds each
    specialist's report verbatim, the referent baton holds what was actually
    written and the action log holds what was attempted, so what happened this
    turn is a fact the loop already owns.
    """
    done = [
        f"**{label}** — "
        + (
            text.split(":", 1)[-1].strip()
            if text.startswith("Report from the")
            else text
        )
        for label, text in final.get("reports", [])
    ]
    if done:
        # Specialists finished real work and the hub never wrote it up. Handing
        # back "" threw all of it away and the user saw a turn that did nothing
        # — the actual harm behind "a crash/Stop discards completed work". Just
        # as true when nothing was stopped.
        head = (
            "Stopped. Here is what had already come back:"
            if cancelled
            else "I could not compose an answer, but here is what came back:"
        )
        return head + "\n\n" + "\n\n".join(done)
    if cancelled:
        # Stopped before anything came back: say nothing rather than invent it.
        return ""
    if final.get("referents"):
        # No report, but the room really did change — the artifacts are the
        # evidence, so "Done." is the truth here, and only here.
        return DONE_TEXT
    if final.get("progress"):
        # Something WAS run — it just came back with nothing. The action log is
        # the record of that, and it is written whatever the outcome (a failed
        # specialist, a refused one, a tool error), unlike `reports`.
        return NOTHING_USABLE_TEXT
    return NOTHING_TEXT


async def _refuse_tag(deps: Deps, tag: str, available: list[str]) -> str:
    """Answer a ``*`` tag this room cannot serve — and run nothing.

    NO MODEL, NO WORKER, NO FALLBACK. The three ways a tag can be unservable —
    a name no agent answers to, a room setting that is off, an engine tier that
    carries none of that agent's box — are one answer to the person who typed
    it, and `specialist_workers` deliberately does not tell them apart.

    Refusing HERE is what closes the substitution hole. The old shape sent the
    turn to the Main agent with a paragraph asking it to refuse, while leaving
    every other specialist in its catalog — so a model that skimmed the
    paragraph could still answer "what is the weather" out of the user's own
    documents under a File agent label (live QA 2026-07-24). A paragraph is a
    request; this is the whole turn.

    No `plan` event: nothing ran, so there is no node to draw, and drawing one
    would be the same claim the refusal exists to deny. The step chip carries
    the cause and the answer carries the refusal.
    """
    answer = tag_unavailable_answer(tag, available)
    await deps.emit({"t": "step", "v": f"No *{tag} specialist in this room"})
    await deps.emit({"t": "step_status", "ok": False})
    await deps.emit({"t": "final", "v": answer})
    return answer


async def _run_tagged(
    req: RunRequest,
    deps: Deps,
    tag: str,
    ask: str,
    messages: list[Message],
    *,
    write: bool,
    small_model: bool,
    run_max_rounds: int,
) -> str:
    """A ``*``-tagged turn: the specialist the user named, and only it.

    THE OWNER REPORT THIS EXISTS FOR (2026-08-04): "when calling specialist it
    still calls the main agent first not direct to him". The tag used to narrow
    the hub's catalog to one ``ask_*_agent`` tool — the Main agent still ran,
    still planned, still delegated, and the diagram lit a hub node for a route
    the user had already chosen. Here there is no hub at all: this invokes the
    specialist's own compiled graph as the turn.

    WHAT THE HUB WAS STILL CONTRIBUTING, and where it went:

    * Dispatch — `build_plan` already abstained on a tagged turn (the user's
      own routing beats any vocabulary), so nothing is lost.
    * The conversation — a delegated worker gets `worker_base_messages` plus a
      `delegation_note`; this one gets the REAL thread, the user's own words
      included, which is strictly more than the handoff carried.
    * The final wording — this is the one real loss. A delegated worker writes
      DID/FOUND/MISSING for the hub to turn into an answer, and there is no hub
      now, so `DIRECT_SPECIALIST_NOTE` tells it to write the answer instead.
      Without that paragraph a tagged turn would show the user a report form:
      not a wrong answer, but a visibly worse one, which is why it is a
      prompt change and not a silent behaviour change.
    * Answering out of its own head when the request suits nobody — the same
      paragraph tells it to say so and name the area, rather than reach.

    The catalog is listed HERE, one extra ``tools/list`` before the loop's own.
    It is the price of deciding reachability before anything runs, and the
    alternative — deciding it inside `prepare`, where the graph has already
    started — cannot refuse without a model.
    """
    served = await _list_tools(deps)
    served_names = {s.name for s in served}
    # THE routing table, and the same one the `*` menu is drawn from: a tag the
    # menu offered is a tag this resolves, and a tag it did not is refused. No
    # `resolve_worker` anywhere on this path — that is the function that falls
    # through to the DEFAULT worker for a domain it cannot serve, and its
    # fallthrough is the fabrication this whole feature is fenced against.
    live = specialist_workers(web_enabled=req.web_enabled, served_names=served_names)
    worker_id = live.get(tag)
    if worker_id is None:
        return await _refuse_tag(deps, tag, list(live))

    worker = get_agent(worker_id)
    # The turn's ONE node, and it is the specialist — not a Main agent that
    # never ran. `MAIN_NODE_KEY` is the ROOT slot's key, not a claim about who
    # is in it: the UI files this loop's step events under it and draws a single
    # chip carrying this agent's own label.
    entry: dict[str, Any] = {
        "agent": worker.id,
        "label": worker.label,
        "instruction": ask,
        "status": "running",
        "batch": None,
        "key": MAIN_NODE_KEY,
    }
    # A COPY per emit. `stream_events` puts the event on a queue and serialises
    # it when the queue is drained, so emitting this dict by reference lets the
    # status flip below rewrite an event that was already sent: the roster would
    # read "done" from the instant the turn started, and no consumer could tell
    # a running specialist from a finished one.
    await deps.emit({"t": "plan", "v": [dict(entry)]})
    await deps.emit(
        {
            "t": "agent",
            "v": {
                "id": worker.id,
                "label": worker.label,
                "step": 1,
                "total": 1,
                "active_steps": [1],
            },
        }
    )

    initial: AgentState = {
        # The ask WITHOUT the tag: `graphs.route_action` scores this string
        # against each action's hints, and "*file" would score as the word
        # "file". The messages keep the user's text verbatim — the transcript
        # must not quietly differ from the composer.
        "question": ask,
        "web_enabled": req.web_enabled,
        "write": write,
        "advisors": bool(req.advisors),
        "max_rounds": run_max_rounds,
        "run_max_rounds": run_max_rounds,
        "small_model": small_model,
        "agent_id": worker.id,
        "direct": True,
        "node_key": MAIN_NODE_KEY,
        # A single-step turn: the connector proxy pair stays offered, exactly as
        # it is for an undelegated hub turn. `plan_multi` withholds it to stop a
        # step jumping the queue in a multi-step plan, and there is no plan here.
        "plan_multi": False,
        "unlocked_groups": set(),
        "spills": [],
        "referents": [],
        "produced": [],
        "pipeline": [],
        "worker_base_messages": [],
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "stalls": 0,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "cancelled": False,
        "stop": False,
    }
    # This agent's OWN shape, the same one a delegation would have run.
    # Imported here, not at module scope: `graphs` composes these node functions.
    from .graphs import graph_for, recursion_limit_for, report_failure

    final: AgentState = await graph_for(worker.id).ainvoke(
        initial,
        config={
            "configurable": {"deps": deps},
            "recursion_limit": recursion_limit_for(worker.id, run_max_rounds),
        },
    )  # type: ignore[assignment]

    # The SAME rubric a delegated specialist's report is judged by (`report_
    # failure`, zero model calls), because the failure it catches is the same
    # one: "Done." after a round of tool calls, or the contract's own lines
    # filled with "nothing". Graded here the verdict drives both the chip and
    # the answer, so a green node cannot sit over `_fallback_answer`'s text.
    answer = (final.get("final_text", "") or "").strip()
    ok = bool(answer) and not report_failure(final) and not final.get("cancelled")
    if not ok:
        answer = _fallback_answer(final, cancelled=deps.cancel.cancelled)
    entry["status"] = "done" if ok else "failed"
    await deps.emit({"t": "plan", "v": [dict(entry)]})
    await deps.emit({"t": "final", "v": answer})
    return answer


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

    ONE EXCEPTION, and it is the user's: a question whose first token is the
    composer's ``*`` tag never reaches the hub at all — see :func:`_run_tagged`.
    """
    # Only `write` is read downstream (the state flag and the lane label). The
    # other four answers were computed for every question and handed to
    # `resolved_max_rounds`, which has narrowed nothing per-lane since the
    # per-lane budgets were removed — its own docstring says so. Four scans of
    # the question whose results went straight into the bin, which is why this
    # asks for the ONE lane it reads rather than taking `[0]` of all five.
    write = req.resolved_write()
    run_max_rounds = req.resolved_max_rounds()
    # No per-agent budget narrows this any more: the Main agent delegates until
    # it has what it needs, bounded only by the shared runaway backstop.
    max_rounds = run_max_rounds
    # The turn-wide ceiling is armed HERE rather than at the Deps construction
    # site, because this is the single choke point every ask goes through — the
    # HTTP route, a headless workflow `agent_run`, and the test harness all
    # arrive by calling this function, and a bound that some entry points miss
    # is not a bound. A caller that pre-set one keeps it.
    if deps.turn_round_budget is None:
        deps.turn_round_budget = req.resolved_turn_rounds()
    deps.turn_stall_budget = req.resolved_turn_stalls()

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

    # The composer's `*` tag rides in the question text, exactly as `/skill`
    # does — one parser, on the side that owns the roster, so the host never
    # has to keep a second copy of what a specialist is called. The tag is left
    # in the message the model reads: it is what the user typed, and a
    # transcript that quietly differs from the box is its own kind of untruth.
    #
    # AND IT ROUTES THE WHOLE TURN (2026-08-04). Everything below this branch is
    # the hub; a tagged turn does not run it.
    #
    # A plain local Ollama model (no API provider, no :cloud relay) gets the
    # small-model guardrails: one delegation per round + turn-progress
    # re-injection. Cloud-class models keep parallel calls and the lean prompt.
    # Read before the branch because BOTH paths run a loop that needs it.
    small_model = req.provider is None and not is_nonlocal_model(req.model)
    tagged, ask = tagged_specialist(req.question)
    if tagged:
        return await _run_tagged(
            req,
            deps,
            tagged,
            ask or req.question,
            messages,
            write=write,
            small_model=small_model,
            run_max_rounds=run_max_rounds,
        )

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

    initial: AgentState = {
        "question": req.question,
        "web_enabled": req.web_enabled,
        "write": write,
        "advisors": bool(req.advisors),
        "max_rounds": max_rounds,
        "run_max_rounds": run_max_rounds,
        "small_model": small_model,
        "agent_id": main.id,
        "direct": False,
        "node_key": MAIN_NODE_KEY,
        "plan_multi": False,
        "unlocked_groups": set(),
        "spills": [],
        "referents": [],
        "pipeline": pipeline,
        "worker_base_messages": [dict(m) for m in messages],  # type: ignore[misc]
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "stalls": 0,
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

    # The ONE final event for the whole pipeline. Never invent success over a
    # turn that produced nothing — see `_fallback_answer`.
    answer = (final.get("final_text", "") or "").strip()
    if not answer:
        answer = _fallback_answer(final, cancelled=deps.cancel.cancelled)
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
        except asyncio.CancelledError:
            # `finally` below still queues the sentinel, so the NDJSON stream closes
            # CLEANLY — with neither `final` nor `error`. The host read that as a
            # successful empty answer and saved a zero-byte reply (live QA 2026-07-30,
            # the Yahoo/ETF task). A torn-down run must never look like a finished one:
            # say so on the wire BEFORE propagating.
            # ...and to the LOG as well as the wire. The wire message is one
            # sentence for the user; the traceback is the only thing that says
            # WHICH await died, and it is what `arcelle-sidecar.log` exists for
            # (sidecar_lifecycle.rs mirrors stderr there — a bundled app has no
            # other copy). Live QA 2026-07-30: three agents "lost the reply" and
            # the log was empty, so the cause could only be guessed at.
            _log.error("run torn down before it produced an answer", exc_info=True)
            await queue.put(
                {"t": "error", "v": "the run was torn down before it produced an answer"}
            )
            raise
        except BaseException as exc:  # noqa: BLE001 - any failure must reach the host
            # BaseException, not Exception: a bare `Exception` clause let every
            # BaseException (SystemExit, KeyboardInterrupt, a nested CancelledError)
            # out through the same silent door as above. `_why` because str() on
            # several httpx/asyncio errors is the empty string, which would emit
            # {"t": "error", "v": ""} and tell the user nothing.
            _log.error("run failed: %s", type(exc).__name__, exc_info=True)
            await queue.put({"t": "error", "v": _why(exc)})
            if not isinstance(exc, Exception):
                raise
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
