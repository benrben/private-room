"""Sequential graph tool-pass dispatch and catalog management."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model
from .graph_tools import LEDGER_TOOLS as LEDGER_TOOLS, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _active_step as _active_step, _append_group_prompt as _append_group_prompt, _args_summary as _args_summary, _artifact_referent_names as _artifact_referent_names, _clip_report as _clip_report, _connector_referent_names as _connector_referent_names, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _emit_pipeline as _emit_pipeline, _live_domains as _live_domains, _nonartifact_referent_names as _nonartifact_referent_names, _nonempty_text as _nonempty_text, _nonnegative_integer as _nonnegative_integer, _own_group_note as _own_group_note, _parsed_artifact_receipt as _parsed_artifact_receipt, _referent_names as _referent_names, _renamed_referent_names as _renamed_referent_names, _run_one_tool as _run_one_tool, _single_referent as _single_referent, _starts_with_system_message as _starts_with_system_message, _stripped_referent as _stripped_referent, _truncated_referent as _truncated_referent, _unavailable_group_note as _unavailable_group_note, _unavailable_note as _unavailable_note, _unknown_group_note as _unknown_group_note, _unlock_group as _unlock_group, _unlocked_tool_specs as _unlocked_tool_specs, _valid_artifact_receipt as _valid_artifact_receipt, _valid_sha256 as _valid_sha256, _video_unavailable_note as _video_unavailable_note
from .graph_workers import WorkerOutcome as WorkerOutcome, _bare_plan_task as _bare_plan_task, _decoded_plan as _decoded_plan, _dependency_index as _dependency_index, _dependency_is_in_plan as _dependency_is_in_plan, _first_plan_dependencies as _first_plan_dependencies, _plan_agent as _plan_agent, _plan_dependencies as _plan_dependencies, _plan_dependencies_for_waves as _plan_dependencies_for_waves, _plan_instruction as _plan_instruction, _plan_task as _plan_task, _ready_wave as _ready_wave, _run_worker as _run_worker, _schedule_waves as _schedule_waves, _structured_plan_task as _structured_plan_task, _task_items as _task_items, _unfinished_task_positions as _unfinished_task_positions, _wave_dependencies as _wave_dependencies, parse_plan as parse_plan, plan_waves as plan_waves
from .graph_delegator import _Batch as _Batch, _Delegator as _Delegator
from .graph_toolpass_results import _ToolPassResultMixin as _ToolPassResultMixin

@dataclass(slots=True)
class _ToolPass(_ToolPassResultMixin):
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
    tool_events: list[dict[str, Any]]
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
    artifact_delegation_done: bool = False

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
            tool_events=[dict(event) for event in state.get("tool_events", [])],
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
            if not await self._run_call(call):
                break
        await self._resume_after_children()

    async def _run_call(self, call: ToolCall) -> bool:
        """Run one call, returning false only when this pass must stop."""
        if await self._cancel_before_call():
            return False
        self._scope_list_skills(call)
        key = call.key()
        if self._answer_duplicate(call, key):
            return True
        self.all_dup = False
        if self._rejected_by_catalog_guard(call):
            return True
        await self._announce_call(call)
        return await self._arm_for(call)(call, key)

    async def _cancel_before_call(self) -> bool:
        # ADD-7: stop between tool calls.
        if not self.deps.cancel.cancelled:
            return False
        self.cancelled = True
        await self.delegator.drain()
        return True

    def _scope_list_skills(self, call: ToolCall) -> None:
        # The Rust bridge is built per RUN, not per worker, so it cannot know
        # which specialist is asking. Inject the active worker id here.
        if call.name == "list_skills":
            call.arguments = {**(call.arguments or {}), "agent": self.agent.id}

    def _answer_duplicate(self, call: ToolCall, key: str) -> bool:
        if key not in self.seen:
            return False
        # CHG-3: don't re-run an identical call or re-flood the context.
        self.messages.append(tool_message(duplicate_call_note(call.name), call.name, call.id))
        return True

    async def _announce_call(self, call: ToolCall) -> None:
        # CHG-5: a human step label, not inline "⚙ name…" answer text. Stamped
        # with the emitting loop's node so the UI can file it under the right
        # agent — siblings run concurrently, so arrival order proves nothing.
        await self.deps.emit({"t": "step", "v": tool_step_label(call.name), "node": self.node})

    async def _resume_after_children(self) -> None:
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
            await self._record_unusable_batch(call)
            return True
        outcome = await self._await_batch(task)
        return await self._record_batch_outcome(call, key, outcome)

    async def _record_unusable_batch(self, call: ToolCall) -> None:
        # `parse_plan` salvaged nothing. Say what was wrong rather than
        # returning an empty report the model will read as "done".
        await self.deps.emit({"t": "step_status", "ok": False, "node": self.node})
        self.progress.append(f"{BATCH_TOOL_NAME}() -> unusable plan")
        self.messages.append(tool_message(EMPTY_PLAN_NOTE, call.name, call.id))

    async def _await_batch(self, task: "asyncio.Task[WorkerOutcome]") -> WorkerOutcome:
        try:
            return await task
        except BaseException:
            await self.delegator.drain()
            raise

    async def _record_batch_outcome(
        self, call: ToolCall, key: str, outcome: WorkerOutcome
    ) -> bool:
        report, ok, plan_cancelled, plan_refs = outcome
        self._merge_delegation_refs(plan_refs)
        self._record_batch_report(ok, report)
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        self._memoise_delegation(key)
        self._record_batch_message(call, report, ok)
        return await self._continue_after_child_cancellation(plan_cancelled)
