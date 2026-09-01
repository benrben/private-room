"""Concurrent delegation and plan-wave scheduling."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, facade as _facade_module, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model
from .graph_tools import LEDGER_TOOLS as LEDGER_TOOLS, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _active_step as _active_step, _append_group_prompt as _append_group_prompt, _args_summary as _args_summary, _artifact_referent_names as _artifact_referent_names, _clip_report as _clip_report, _connector_referent_names as _connector_referent_names, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _emit_pipeline as _emit_pipeline, _live_domains as _live_domains, _nonartifact_referent_names as _nonartifact_referent_names, _nonempty_text as _nonempty_text, _nonnegative_integer as _nonnegative_integer, _own_group_note as _own_group_note, _parsed_artifact_receipt as _parsed_artifact_receipt, _referent_names as _referent_names, _renamed_referent_names as _renamed_referent_names, _run_one_tool as _run_one_tool, _single_referent as _single_referent, _starts_with_system_message as _starts_with_system_message, _stripped_referent as _stripped_referent, _truncated_referent as _truncated_referent, _unavailable_group_note as _unavailable_group_note, _unavailable_note as _unavailable_note, _unknown_group_note as _unknown_group_note, _unlock_group as _unlock_group, _unlocked_tool_specs as _unlocked_tool_specs, _valid_artifact_receipt as _valid_artifact_receipt, _valid_sha256 as _valid_sha256, _video_unavailable_note as _video_unavailable_note
from .graph_workers import WorkerOutcome as WorkerOutcome, _bare_plan_task as _bare_plan_task, _decoded_plan as _decoded_plan, _dependency_index as _dependency_index, _dependency_is_in_plan as _dependency_is_in_plan, _first_plan_dependencies as _first_plan_dependencies, _plan_agent as _plan_agent, _plan_dependencies as _plan_dependencies, _plan_dependencies_for_waves as _plan_dependencies_for_waves, _plan_instruction as _plan_instruction, _plan_task as _plan_task, _ready_wave as _ready_wave, _run_worker as _run_worker, _schedule_waves as _schedule_waves, _structured_plan_task as _structured_plan_task, _task_items as _task_items, _unfinished_task_positions as _unfinished_task_positions, _wave_dependencies as _wave_dependencies, parse_plan as parse_plan, plan_waves as plan_waves

@dataclass(slots=True)
class _Batch:
    """Per-plan accumulators keyed by the model's task indexes."""
    reports: dict[int, str] = field(default_factory=dict)
    task_ok: dict[int, bool] = field(default_factory=dict)
    gathered: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _Delegator:
    """One round's concurrent delegation fan-out and tracked cleanup."""

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

    def unavailable(
        self, domain_key: str | None, instruction: str = ""
    ) -> str | None:
        """The refusal for work this room cannot serve, else ``None``.

        ``None`` for an UNRECOGNISED name keeps the tolerant fallback a garbled
        key has always had: `resolve_worker` lands on the default worker.
        Recognised-but-unavailable is the first case this refuses.

        The second is an unavailable *member* of an otherwise-live domain.
        Most sibling domains intentionally fall back to a reachable member
        (Browser to Web search, for example). Video perception may not: a frame
        request resolved as ``media.video`` must never become ``files.read``
        merely because Cloud Privacy removed its pixel tools.
        """
        if domain_key is None:
            return None
        if domain_key not in self.live_domain_keys:
            return _unavailable_note(domain_key, self.live_domain_keys)
        if not instruction:
            return None
        domain_tool = DOMAIN_KEYS.get(domain_key, "")
        intended = _facade_module().resolve_worker(
            domain_tool,
            instruction,
            web_enabled=bool(self.state.get("web_enabled", False)),
        )
        if intended != "media.video":
            return None
        if _facade_module().worker_reachable(
            get_agent(intended),
            web_enabled=bool(self.state.get("web_enabled", False)),
            served_names=self.served_names,
        ):
            return None
        return _video_unavailable_note(
            privacy_restricted=bool(self.state.get("privacy_restricted", False))
        )

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
        entry = self.register(_facade_module().resolve_worker(tool, instruction), instruction, batch)
        entry["status"] = "failed"
        if refusal:
            entry["report"] = refusal
        # The server emits this policy-owned aggregate after the graph finishes.
        # A protected-cloud frame was withheld before capture (the safe
        # pre-dispatch boundary), so ``redact_messages`` never sees image bytes
        # to count. Record the refused frame here so the existing one-turn
        # privacy valve is offered without weakening the tool gate.
        if (
            entry["agent"] == "media.video"
            and bool(self.state.get("privacy_restricted", False))
        ):
            policy = getattr(self.deps.chat, "privacy", None)
            report = getattr(policy, "report", None)
            if report is not None and hasattr(report, "images_blocked"):
                report.images_blocked += 1
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
        result = await self._tracked_worker(
            entry, worker_id, instruction, node_key, baton, upstream
        )
        await self._finish_tracked_worker(entry, node_key, result)
        return result

    async def _tracked_worker(
        self,
        entry: dict[str, Any],
        worker_id: str,
        instruction: str,
        node_key: str,
        baton: list[str] | None,
        upstream: tuple[str, ...],
    ) -> WorkerOutcome:
        """Run the child and keep cancellation and crash handling distinct."""
        try:
            return await _facade_module()._run_worker(
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
            await self._report_tracked_failure(node_key, exc)
            raise

    async def _report_tracked_failure(self, node_key: str, exc: Exception) -> None:
        """Make a child crash visible both now and in the durable run log."""
        reason = _why_failed(exc)
        _log.warning("delegation to %s failed: %s", node_key, reason, exc_info=True)
        await self._emit_report(node_key, reason, ok=False)
        await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))

    async def _finish_tracked_worker(
        self, entry: dict[str, Any], node_key: str, result: WorkerOutcome
    ) -> None:
        """Publish a finished child after its roster slot reached a terminal state."""
        entry["status"] = "done" if result.ok and not result.cancelled else "failed"
        await self._emit_report(
            node_key, result.report, ok=result.ok and not result.cancelled
        )
        await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))

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
        for wave_no, wave in enumerate(waves):
            if self.deps.cancel.cancelled:
                return self._plan_outcome(batch, cancelled=True)
            if await self._run_plan_wave(plan, wave, wave_no, batch):
                return self._plan_outcome(batch, cancelled=True)
        return self._plan_outcome(batch, cancelled=False)

    async def _run_plan_wave(
        self,
        plan: list[dict[str, Any]],
        wave: list[int],
        wave_no: int,
        batch: _Batch,
    ) -> bool:
        """Launch and collect one dependency-ready wave of a planned batch."""
        running = self._launch_wave(plan, wave, wave_no, batch)
        await _emit_pipeline(self.deps, self.pipeline, _active_step(self.pipeline))
        return await self._collect_wave(running, batch)

    def _plan_outcome(self, batch: _Batch, *, cancelled: bool) -> WorkerOutcome:
        """Build the one tool result that represents the completed batch."""
        text = "\n\n".join(batch.reports[i] for i in sorted(batch.reports)) or (
            "No tasks ran — the plan was empty."
        )
        new_refs = [r for r in batch.gathered if r not in self.referents_at_launch]
        return WorkerOutcome(text, any(batch.task_ok.values()), cancelled, new_refs)

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
            instruction = str(task_spec["instruction"])
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
            refusal = self.unavailable(norm, instruction)
            if refusal is not None:
                batch.reports[idx] = f"Task {idx} could not run. {refusal}"
                batch.task_ok[idx] = False
                # ...and it shows up in the live picture as the failed node it
                # is, rather than being silently absent from the diagram while
                # the assistant is told about it in text.
                self.register_unavailable(
                    DOMAIN_KEYS.get(norm or "", ""),
                    instruction,
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
        worker_id = _facade_module().resolve_worker(
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
            if isinstance(result, BaseException):
                self._collect_failed_task(batch, idx, entry, result)
                continue
            cancelled_any = self._collect_finished_task(
                batch, idx, result, cancelled_any
            )
        return cancelled_any

    @staticmethod
    def _collect_failed_task(
        batch: _Batch, idx: int, entry: dict[str, Any], error: BaseException
    ) -> None:
        """Keep a failed sibling visible while allowing the wave to finish."""
        label = get_agent(str(entry["agent"])).label
        batch.reports[idx] = f"Task {idx} ({label}) failed: {_why(error)}"
        batch.task_ok[idx] = False

    @staticmethod
    def _collect_finished_task(
        batch: _Batch, idx: int, result: WorkerOutcome, cancelled_any: bool
    ) -> bool:
        """Record one completed child in the batch's call-order result."""
        report, child_ok, child_cancelled, child_refs = result
        batch.task_ok[idx] = bool(child_ok)
        batch.reports[idx] = f"Task {idx} — {report}"
        for ref in child_refs:
            if ref not in batch.gathered:
                batch.gathered.append(ref)
        return cancelled_any or child_cancelled

    def _already_dispatched(self, call: ToolCall, seen: set[str]) -> bool:
        key = call.key()
        return key in seen or key in self.launched

    def _launch_batch(self, call: ToolCall, seen: set[str]) -> None:
        if self._already_dispatched(call, seen):
            return
        plan = parse_plan((call.arguments or {}).get("tasks"))
        if not plan:
            return  # answered inline by the caller with a corrective note
        key = call.key()
        self.launched.add(key)
        self.launched_label[call.id] = "task plan"
        # The size is recorded HERE, where the plan is already parsed:
        # the progress line used to re-parse the whole argument just to
        # count its tasks.
        self.plan_sizes[call.id] = len(plan)
        self.tasks[call.id] = asyncio.create_task(self.run_plan(plan))

    def _delegation_instruction(self, call: ToolCall) -> str:
        arguments = call.arguments or {}
        return str(arguments.get("instruction") or self.state.get("question", ""))

    def _start_delegation(self, call: ToolCall, instruction: str) -> None:
        # Resolve HERE, not inside the worker: the pipeline roster has to be
        # registered in call order before anything runs concurrently.
        worker_id = _facade_module().resolve_worker(
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

    def _launch_delegation(self, call: ToolCall, seen: set[str]) -> None:
        # Same-round duplicate: the sequential pass answers the repeat from
        # `seen`/the duplicate note, so it must not get its own worker.
        if self._already_dispatched(call, seen):
            return
        # A domain this room cannot serve gets no worker at all — the
        # sequential pass answers it with the same MISSING note the batch
        # path uses (`_ToolPass._delegation`). Launching it would hand the
        # ask to `resolve_worker`'s DEFAULT specialist under the label of
        # the one the model asked for.
        instruction = self._delegation_instruction(call)
        if self.unavailable(normalize_domain_key(call.name), instruction) is not None:
            return
        self.launched.add(call.key())
        self._start_delegation(call, instruction)

    def _launch_call(self, call: ToolCall, seen: set[str]) -> None:
        if call.name == BATCH_TOOL_NAME:
            self._launch_batch(call, seen)
            return
        if call.name in AGENT_TOOL_NAMES:
            self._launch_delegation(call, seen)

    async def launch(self, calls: list[ToolCall], seen: set[str]) -> None:
        """Start every delegation in ``calls``; collect none of them.

        Each one is parked in ``self.tasks`` under its call id for the
        sequential pass to await IN CALL ORDER. ``seen`` is the caller's memo of
        this turn's already-successful calls, read-only.
        """
        for call in calls:
            self._launch_call(call, seen)

    async def drain(self) -> None:
        """Cancellation between calls must not orphan running sub-loops."""
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
