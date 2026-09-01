"""Result recording and state updates for a graph tool pass."""

from __future__ import annotations

from .graph_runtime import facade as _facade_module

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model
from .graph_tools import LEDGER_TOOLS as LEDGER_TOOLS, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _active_step as _active_step, _append_group_prompt as _append_group_prompt, _args_summary as _args_summary, _artifact_referent_names as _artifact_referent_names, _clip_report as _clip_report, _connector_referent_names as _connector_referent_names, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _emit_pipeline as _emit_pipeline, _live_domains as _live_domains, _nonartifact_referent_names as _nonartifact_referent_names, _nonempty_text as _nonempty_text, _nonnegative_integer as _nonnegative_integer, _own_group_note as _own_group_note, _parsed_artifact_receipt as _parsed_artifact_receipt, _referent_names as _referent_names, _renamed_referent_names as _renamed_referent_names, _run_one_tool as _run_one_tool, _single_referent as _single_referent, _starts_with_system_message as _starts_with_system_message, _stripped_referent as _stripped_referent, _truncated_referent as _truncated_referent, _unavailable_group_note as _unavailable_group_note, _unavailable_note as _unavailable_note, _unknown_group_note as _unknown_group_note, _unlock_group as _unlock_group, _unlocked_tool_specs as _unlocked_tool_specs, _valid_artifact_receipt as _valid_artifact_receipt, _valid_sha256 as _valid_sha256, _video_unavailable_note as _video_unavailable_note
from .graph_workers import WorkerOutcome as WorkerOutcome, _bare_plan_task as _bare_plan_task, _decoded_plan as _decoded_plan, _dependency_index as _dependency_index, _dependency_is_in_plan as _dependency_is_in_plan, _first_plan_dependencies as _first_plan_dependencies, _plan_agent as _plan_agent, _plan_dependencies as _plan_dependencies, _plan_dependencies_for_waves as _plan_dependencies_for_waves, _plan_instruction as _plan_instruction, _plan_task as _plan_task, _ready_wave as _ready_wave, _run_worker as _run_worker, _schedule_waves as _schedule_waves, _structured_plan_task as _structured_plan_task, _task_items as _task_items, _unfinished_task_positions as _unfinished_task_positions, _wave_dependencies as _wave_dependencies, parse_plan as parse_plan, plan_waves as plan_waves
from .graph_delegator import _Batch as _Batch, _Delegator as _Delegator


class _ToolPassResultMixin:
    def _merge_delegation_refs(self, refs: list[str]) -> None:
        for ref in refs:
            if ref not in self.referents:
                self.referents.append(ref)
        if refs:
            self.artifact_delegation_done = True

    def _record_batch_report(self, ok: bool, report: str) -> None:
        if ok:
            self.reports_so_far.append(("specialists", report))

    def _record_batch_message(self, call: ToolCall, report: str, ok: bool) -> None:
        self.progress.append(
            f"{BATCH_TOOL_NAME}({self.delegator.plan_sizes.get(call.id, 0)} tasks)"
            + (" -> reports received" if ok else " -> no reports")
        )
        self.messages.append(tool_message(report, call.name, call.id))

    async def _continue_after_child_cancellation(self, child_cancelled: bool) -> bool:
        if child_cancelled:
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
        instruction = self.delegator._delegation_instruction(call)
        if await self._record_unavailable_delegation(call, key, instruction):
            return True
        outcome = await self._child_outcome(call, instruction)
        return await self._record_delegation_outcome(call, key, instruction, outcome)

    async def _record_unavailable_delegation(
        self, call: ToolCall, key: str, instruction: str
    ) -> bool:
        # ...unless this room has no such specialist. The batch path has always
        # refused that; this one dispatched it to `resolve_worker`'s DEFAULT
        # worker instead, so "ask the Web agent what the weather is" in a
        # web-off room was answered out of the user's own files under the File
        # agent's label. Same note as the batch path, and no worker runs.
        refusal = self.delegator.unavailable(
            normalize_domain_key(call.name), instruction
        )
        if refusal is None:
            return False
        self.delegator.register_unavailable(call.name, instruction, self.delegator.batch, refusal)
        await _emit_pipeline(
            self.deps, self.delegator.pipeline, _active_step(self.delegator.pipeline)
        )
        await self.deps.emit({"t": "step_status", "ok": False, "node": self.node})
        # Memoised like any other delegation: this one cannot start succeeding
        # later in the turn, so an identical repeat is answered from this note.
        self._memoise_delegation(key)
        self.progress.append(f"{call.name}({instruction[:60]}) -> no such specialist")
        self.messages.append(tool_message(refusal, call.name, call.id))
        return True

    async def _record_delegation_outcome(
        self, call: ToolCall, key: str, instruction: str, outcome: WorkerOutcome
    ) -> bool:
        report, ok, worker_cancelled, worker_refs = outcome
        # Merge the child's baton in CALL order, de-duplicated: siblings ran
        # blind to each other, so the union is what later rounds must see.
        self._merge_delegation_refs(worker_refs)
        self._record_delegation_report(call, report, ok)
        # No `tool` discriminator here: `report` is the specialist's single
        # normalized completion. Adding the ask_* name would count it twice.
        await self.deps.emit({"t": "step_status", "ok": ok, "node": self.node})
        self._memoise_delegation(key)
        # Truthful either way: this log is the small model's only record of
        # what actually happened, so it must never claim a report it lacks.
        self.progress.append(
            f"{call.name}({instruction[:60]}) -> "
            + ("report received" if ok else "no report")
        )
        self.messages.append(tool_message(report, call.name, call.id))
        return await self._continue_after_child_cancellation(worker_cancelled)

    def _record_delegation_report(self, call: ToolCall, report: str, ok: bool) -> None:
        if ok:
            # Into the FINDINGS baton, so the NEXT round's specialists get
            # this verbatim instead of the hub having to restate it.
            label = self.delegator.launched_label.get(call.id, "specialist")
            self.reports_so_far.append((label, report))

    async def _child_outcome(self, call: ToolCall, instruction: str) -> WorkerOutcome:
        """Await ONE specialist and hand back its outcome, whatever happened."""
        # Already running since the fan-out (`_Delegator.launch`) — this awaits
        # it, it does not start it. A delegation with no task was launched by
        # neither branch (only reachable if the batch scan and this one
        # disagree), so run it inline rather than drop the call on the floor.
        task = self.delegator.tasks.get(call.id)
        try:
            if task is None:
                worker_id = _facade_module().resolve_worker(
                    call.name,
                    instruction,
                    served_names=self.delegator.served_names,
                    web_enabled=bool(self.state.get("web_enabled", False)),
                )
                fallback = self.delegator.register(
                    worker_id, instruction, self.delegator.batch
                )
                result = await _facade_module()._run_worker(
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
        outcome = _pixel_checked_outcome(call, await _run_one_tool(self.deps, call))
        self.attempted.add(call.name)
        ok = not outcome.is_error
        # ADD-22: tell the UI whether the step succeeded, so a failed chip doesn't
        # look identical to a successful one.
        await self.deps.emit(
            {"t": "step_status", "ok": ok, "node": self.node, "tool": call.name}
        )
        result = self._room_result(call, key, outcome)
        self._record_room_progress(call, ok)
        self.messages.append(
            tool_message(self._park_if_oversized(call.name, result), call.name, call.id)
        )
        self._handoff_room_images(outcome.images)
        return True

    def _room_result(self, call: ToolCall, key: str, outcome: ToolResult) -> str:
        """Record a bridge outcome and return the matching model-visible text."""
        if outcome.is_error:
            self._record_pixel_tool_error(call, outcome)
            return f"Tool error: {outcome.text}"
        # Only remember successful calls, so a failed one may be re-attempted
        # in a later round (bounded by the round backstop, not a retry cap).
        self.seen.add(key)
        self._record_room_success(call, outcome.text)
        self._record_room_referents(call, outcome.text)
        return outcome.text

    def _record_room_success(self, call: ToolCall, result: str) -> None:
        """Keep a bounded event receipt for a successful room-tool call."""
        self.tool_events.append(
            {
                "name": call.name,
                "arguments": _room_identity_arguments(call),
                # Workflow validation appends VALIDATED at the end. Keep the
                # tail so a long per-step preview cannot push it out.
                "result": result[-4096:],
            }
        )

    def _record_room_referents(self, call: ToolCall, result: str) -> None:
        """Add successful write receipts to both state batons."""
        if call.name not in LEDGER_TOOLS:
            return
        for artifact in _referent_names(call.name, call.arguments, result):
            entry_text = f"{call.name}: {artifact}"
            self.referents.append(entry_text)
            self.produced.append(entry_text)
            self._allow_post_commit_read(call, artifact)

    def _allow_post_commit_read(self, call: ToolCall, artifact: str) -> None:
        """Let studio artifacts be read again after their successful commit."""
        if call.name not in _POST_COMMIT_READ_TOOLS:
            return
        # A successful commit invalidates an earlier read of the same name.
        # Allow open_file to run again so the verifier can obtain a genuinely
        # post-commit receipt instead of duplicate-suppressing the only proof it
        # accepts.
        self.seen.discard(
            ToolCall(name="open_file", arguments={"name": artifact}).key()
        )

    def _record_pixel_tool_error(self, call: ToolCall, outcome: ToolResult) -> None:
        """Keep failed perception receipts for the visual-evidence gate."""
        if call.name not in PIXEL_RESULT_TOOLS:
            return
        self.tool_events.append(
            {
                "name": call.name,
                "arguments": _room_identity_arguments(call),
                "result": outcome.text[-4096:],
                "error": True,
            }
        )

    def _record_room_progress(self, call: ToolCall, ok: bool) -> None:
        """Make the tool's actual outcome available to the next model round."""
        status = "ok" if ok else "error"
        self.progress.append(f"{call.name}({_args_summary(call.arguments)}) -> {status}")

    def _handoff_room_images(self, images: list[str]) -> None:
        """Place newly captured pixels in the next model-visible user turn."""
        self.pending_images.extend(images)
        if not self.pending_images:
            return
        # ADD-25: a perception tool captured pixels. Hand them to the (vision-
        # capable) chat model as a USER message right after the tool result —
        # Ollama reads images from user turns, not tool turns.
        self.messages.append(user_message(IMAGE_HANDOFF, self.pending_images))
        self.pending_images = []

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
        stalls = self._next_stall_count()
        updates = self._state_updates(stalls, synth_turns)
        if self.tools_update is not None:
            updates["tools"] = self.tools_update
        return updates

    def _next_stall_count(self) -> int:
        if not self.all_dup:
            return 0
        return int(self.state.get("stalls", 0)) + 1

    def _force_synthesis(self, stalls: int) -> bool:
        if self.state.get("force_synthesis", False):
            return True
        if self._stall_budget_reached(stalls):
            return True
        return self._artifact_delegation_requires_final_round()

    def _stall_budget_reached(self, stalls: int) -> bool:
        budget = self.deps.turn_stall_budget
        return bool(budget and budget > 0 and stalls >= budget)

    def _artifact_delegation_requires_final_round(self) -> bool:
        # A sole planned specialist has returned a successful write receipt.
        # Give the hub one tool-less final round to report that evidence.
        return bool(
            self.agent.main
            and self.state.get("artifact_delegation_is_terminal", False)
            and self.artifact_delegation_done
        )

    def _state_updates(self, stalls: int, synth_turns: list[int]) -> dict[str, Any]:
        return {
            "messages": self.messages,
            "seen": self.seen,
            "stalls": stalls,
            "force_synthesis": self._force_synthesis(stalls),
            "round": self.state.get("round", 0) + 1,
            "calls": [],
            "pending_images": self.pending_images,
            "progress": self.progress,
            "referents": self.referents,
            "produced": self.produced,
            "reports": self.reports_so_far,
            "attempted": self.attempted,
            "tool_events": self.tool_events,
            "synth_turns": synth_turns,
            "synth": False,
            "unlocked_groups": self.unlocked,
            "spills": self.spills,
            "pipeline": self.delegator.pipeline,
            "cancelled": self.cancelled or self.deps.cancel.cancelled,
        }
