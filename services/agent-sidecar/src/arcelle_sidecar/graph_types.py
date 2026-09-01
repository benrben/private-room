"""Core graph state, cancellation, and dependency types."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable

def _pixel_checked_outcome(call: ToolCall, outcome: ToolResult) -> ToolResult:
    """Fail closed when a perception receipt does not carry its pixels."""
    # A video-frame receipt is evidence ABOUT a capture, not the capture.
    # Treating its timestamp/hash text as a successful perception result lets a
    # text-only model infer pixels it never received. Electron normally returns
    # both parts, but this is the last trust boundary before the model.
    if (
        call.name not in PIXEL_RESULT_TOOLS
        or outcome.is_error
        or outcome.images
    ):
        return outcome
    return ToolResult(
        text=(
            "The perception tool returned a text receipt but no image pixels. "
            "No visual interpretation was performed; capture the image again."
        ),
        is_error=True,
    )


def _room_identity_arguments(call: ToolCall) -> dict[str, str]:
    """Return the short identifying arguments included in a tool receipt."""
    return {
        name: str(call.arguments[name])[:512]
        for name in ("name", "name_or_id", "job_id", "id")
        if name in (call.arguments or {})
        and isinstance(call.arguments[name], (str, int))
    }


# A transcript is useful for locating a moment, but it is not evidence of what
# was visible there.  This correction is injected once when the Video worker
# tries to finish a visual ask without a successful pixel-bearing frame call.
VIDEO_FRAME_REQUIRED = (
    "This is a visual-video request. A transcript or search result cannot show "
    "what was visible. Call view_media_frame for the requested moment before "
    "answering."
)
VIDEO_FRAME_MISSING = (
    "MISSING: I could not inspect the requested video frame because no "
    "successful pixel-bearing frame capture was available. I will not infer "
    "what was visible from the transcript."
)

PIXEL_EVIDENCE_MISSING = (
    "MISSING: I could not inspect the requested pixels because no successful "
    "pixel-bearing capture was available. I will not infer visual details "
    "from OCR, extracted text, filenames, transcripts, shape metadata, or a "
    "text-only receipt."
)


def _required_pixel_tool(agent_id: str, question: str) -> str:
    """The pixel verb that must evidence this worker's visual answer."""
    if agent_id == "media.video" and is_visual_video_intent(question):
        return "view_media_frame"
    if agent_id == "creator.draw":
        return "read_drawing"
    if not is_static_visual_intent(question):
        return ""
    return {
        "files.read": "view_file_image",
        "app.ui": "view_screenshot",
        "chat.browse": "browse_look",
    }.get(agent_id, "")

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
    tool_policy: str
    #: Defense-in-depth capability boundary for a non-local model while the
    #: room's Cloud Privacy policy is active.  Inherited by every worker.
    privacy_restricted: bool
    #: The chosen provider/model has an actual channel for raw image input.
    #: False removes pixel-returning tools before routing, so an unavailable
    #: Video specialist cannot degrade into the File agent or capture pixels a
    #: blind adapter will later discard.
    image_input_available: bool
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
    #: Number of specialist steps Arcelle planned for the hub at prepare time.
    #: A successful artifact-producing one-step delegation is terminal work:
    #: the next round summarizes its receipt instead of dispatching new agents
    #: to "verify" an operation the room bridge already confirmed.
    planned_step_count: int
    #: True when one successful artifact-producing delegation completes every
    #: specialist obligation Arcelle could identify for this turn. This covers
    #: a clean one-step plan and the planner's single-domain abstain fallback;
    #: it excludes mixed planned/unplanned and unavailable work.
    artifact_delegation_is_terminal: bool
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
    #: Successful room-tool events in execution order.  Unlike ``seen`` this
    #: preserves identity arguments and ordering, so a verifier can distinguish
    #: a stale receipt from one produced after the mutation it is meant to
    #: prove. Results are bounded tails; this state must never duplicate a full
    #: file or workflow definition.
    tool_events: list[dict[str, Any]]
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
    #: One bounded retry after a visual worker tried to answer without its
    #: successful pixel-bearing evidence tool.
    video_evidence_retries: int
    #: The planner found one visual-only clause and structurally delegated it.
    #: If that child returns the deterministic no-pixels verdict, Main cannot
    #: replace it with ambient transcript/OCR prose during synthesis.
    terminal_visual_evidence: bool
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
