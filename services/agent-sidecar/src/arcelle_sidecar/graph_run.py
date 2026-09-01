"""Public agent-run orchestration and event streaming."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, facade as _facade_module, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model
from .graph_tools import LEDGER_TOOLS as LEDGER_TOOLS, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _active_step as _active_step, _append_group_prompt as _append_group_prompt, _args_summary as _args_summary, _artifact_referent_names as _artifact_referent_names, _clip_report as _clip_report, _connector_referent_names as _connector_referent_names, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _emit_pipeline as _emit_pipeline, _live_domains as _live_domains, _nonartifact_referent_names as _nonartifact_referent_names, _nonempty_text as _nonempty_text, _nonnegative_integer as _nonnegative_integer, _own_group_note as _own_group_note, _parsed_artifact_receipt as _parsed_artifact_receipt, _referent_names as _referent_names, _renamed_referent_names as _renamed_referent_names, _run_one_tool as _run_one_tool, _single_referent as _single_referent, _starts_with_system_message as _starts_with_system_message, _stripped_referent as _stripped_referent, _truncated_referent as _truncated_referent, _unavailable_group_note as _unavailable_group_note, _unavailable_note as _unavailable_note, _unknown_group_note as _unknown_group_note, _unlock_group as _unlock_group, _unlocked_tool_specs as _unlocked_tool_specs, _valid_artifact_receipt as _valid_artifact_receipt, _valid_sha256 as _valid_sha256, _video_unavailable_note as _video_unavailable_note
from .graph_workers import WorkerOutcome as WorkerOutcome, _bare_plan_task as _bare_plan_task, _decoded_plan as _decoded_plan, _dependency_index as _dependency_index, _dependency_is_in_plan as _dependency_is_in_plan, _first_plan_dependencies as _first_plan_dependencies, _plan_agent as _plan_agent, _plan_dependencies as _plan_dependencies, _plan_dependencies_for_waves as _plan_dependencies_for_waves, _plan_instruction as _plan_instruction, _plan_task as _plan_task, _ready_wave as _ready_wave, _run_worker as _run_worker, _schedule_waves as _schedule_waves, _structured_plan_task as _structured_plan_task, _task_items as _task_items, _unfinished_task_positions as _unfinished_task_positions, _wave_dependencies as _wave_dependencies, parse_plan as parse_plan, plan_waves as plan_waves
from .graph_delegator import _Batch as _Batch, _Delegator as _Delegator
from .graph_toolpass_results import _ToolPassResultMixin as _ToolPassResultMixin
from .graph_toolpass import _ToolPass as _ToolPass
from .graph_actions import _emit_tagged_completion as _emit_tagged_completion, _emit_tagged_start as _emit_tagged_start, _fallback_answer as _fallback_answer, _fallback_report_answer as _fallback_report_answer, _fallback_report_line as _fallback_report_line, _fallback_reports as _fallback_reports, _fallback_without_reports as _fallback_without_reports, _refuse_tag as _refuse_tag, _run_direct_specialist as _run_direct_specialist, _run_tagged as _run_tagged, _tagged_entry as _tagged_entry, _tagged_initial_state as _tagged_initial_state, _tagged_result as _tagged_result, _tagged_specialists as _tagged_specialists, _tagged_tool_allowed as _tagged_tool_allowed, _tagged_unavailable_reason as _tagged_unavailable_reason, execute_tools as execute_tools, route_after_model as route_after_model, route_after_tools as route_after_tools, synthesize as synthesize

@dataclass(frozen=True, slots=True)
class _RunSettings:
    """Values shared by the hub and direct-specialist entry paths."""

    tool_policy: str
    write: bool
    run_max_rounds: int
    small_model: bool


def _run_settings(req: RunRequest) -> _RunSettings:
    """Resolve the request choices once before either graph path starts."""
    tool_policy = req.resolved_tool_policy()
    return _RunSettings(
        tool_policy=tool_policy,
        write=False if tool_policy == "none" else req.resolved_write(),
        run_max_rounds=req.resolved_max_rounds(),
        small_model=req.provider is None and not is_nonlocal_model(req.model),
    )


def _configure_turn_limits(req: RunRequest, deps: Deps) -> None:
    """Install the turn-wide limits while retaining a caller-provided ceiling."""
    if deps.turn_round_budget is None:
        deps.turn_round_budget = req.resolved_turn_rounds()
    deps.turn_stall_budget = req.resolved_turn_stalls()


def _last_user_content(messages: list[Message]) -> str:
    """Return the final user text from a copied conversation history."""
    last_user = next((message for message in reversed(messages) if message.get("role") == "user"), None)
    return str(last_user.get("content") or "").strip() if last_user else ""


def _current_question_is_present(question: str, last_user_content: str) -> bool:
    """Recognise both plain and Electron-enriched final user turns."""
    return bool(question) and (
        last_user_content == question or last_user_content.endswith(f"Question: {question}")
    )


def _messages_for_current_question(req: RunRequest) -> list[Message]:
    """Copy history and append the authoritative ask only when it is missing."""
    messages: list[Message] = [dict(message) for message in req.messages]  # type: ignore[misc]
    question = req.question.strip()
    if question and not _current_question_is_present(question, _last_user_content(messages)):
        messages.append(user_message(req.question))
    return messages


async def _tagged_run_answer(
    req: RunRequest,
    deps: Deps,
    tag: str,
    ask: str,
    messages: list[Message],
    settings: _RunSettings,
) -> str | None:
    """Run a requested specialist directly, or leave an untagged turn to the hub."""
    if not tag or settings.tool_policy == "none":
        return None
    return await _run_tagged(
        req,
        deps,
        tag,
        ask or req.question,
        messages,
        write=settings.write,
        small_model=settings.small_model,
        run_max_rounds=settings.run_max_rounds,
    )


async def _emit_main_start(deps: Deps, main: AgentSpec, tool_policy: str) -> None:
    """Publish the hub's initial roster and active-agent marker."""
    instruction = (
        "answer without tools or sources"
        if tool_policy == "none"
        else "decide, delegate to specialists, answer"
    )
    await deps.emit(
        {
            "t": "plan",
            "v": [
                {
                    "agent": main.id,
                    "label": main.label,
                    "instruction": instruction,
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


def _main_initial_state(
    req: RunRequest,
    main: AgentSpec,
    messages: list[Message],
    settings: _RunSettings,
) -> AgentState:
    """Build the MAIN agent's state without sharing mutable per-run containers."""
    pipeline: list[dict[str, str]] = []
    return {
        "question": req.question,
        "tool_policy": settings.tool_policy,
        "privacy_restricted": req.cloud_privacy_restricted(),
        "image_input_available": req.image_input_available(),
        "web_enabled": req.web_enabled,
        "write": settings.write,
        "advisors": bool(req.advisors),
        "max_rounds": settings.run_max_rounds,
        "run_max_rounds": settings.run_max_rounds,
        "small_model": settings.small_model,
        "agent_id": main.id,
        "direct": False,
        "node_key": MAIN_NODE_KEY,
        "plan_multi": False,
        "unlocked_groups": set(),
        "spills": [],
        "referents": [],
        "pipeline": pipeline,
        "worker_base_messages": [dict(message) for message in messages],  # type: ignore[misc]
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


async def _run_main_graph(
    initial: AgentState, deps: Deps, run_max_rounds: int
) -> AgentState:
    """Invoke the graph shape declared by the Main agent."""
    from .graphs import graph_for, recursion_limit_for

    config = {
        "configurable": {"deps": deps},
        "recursion_limit": recursion_limit_for(MAIN_AGENT_ID, run_max_rounds),
    }
    return await graph_for(MAIN_AGENT_ID).ainvoke(initial, config=config)  # type: ignore[arg-type, no-any-return]


def _main_answer(final: AgentState, deps: Deps) -> str:
    """Use the factual fallback when the hub did not compose a final answer."""
    answer = (final.get("final_text", "") or "").strip()
    return answer or _fallback_answer(final, cancelled=deps.cancel.cancelled)


async def run_agent(req: RunRequest, deps: Deps) -> str:
    """Run one ask to completion. Emits SPEC §4 events through ``deps.emit``.

    A composer's ``*`` specialist tag takes the direct worker path; every other
    request starts the Main-agent hub and emits exactly one final event.
    """
    settings = _run_settings(req)
    _configure_turn_limits(req, deps)
    messages = _messages_for_current_question(req)
    tag, ask = tagged_specialist(req.question)
    tagged_answer = await _tagged_run_answer(req, deps, tag, ask, messages, settings)
    if tagged_answer is not None:
        return tagged_answer

    main = get_agent(MAIN_AGENT_ID)
    await _emit_main_start(deps, main, settings.tool_policy)
    initial = _main_initial_state(req, main, messages, settings)
    final = await _run_main_graph(initial, deps, settings.run_max_rounds)
    answer = _main_answer(final, deps)
    await deps.emit({"t": "final", "v": answer})
    return answer


def _deep_harness_is_enabled(req: RunRequest) -> bool:
    return req.harness == "deep" and req.resolved_tool_policy() != "none"


async def _run_selected_deep_agent(req: RunRequest, deps: Deps, decision: Any) -> None:
    requested_write = req.resolved_write()
    write_enabled = req.deep_workspace_write_authorized()
    if requested_write and not write_enabled:
        await deps.emit(
            {
                "t": "step",
                "v": "Deep Harness is read-only because no completed rollback baseline authorized this run.",
            }
        )
    from .deep_harness import run_deep_agent

    await run_deep_agent(
        req.question,
        deps,
        write_enabled=write_enabled,
        max_rounds=req.resolved_max_rounds(),
        small_model=decision.small_model,
        image_input_available=req.image_input_available(),
        privacy_restricted=req.cloud_privacy_restricted(),
    )


async def _run_deep_or_classic_agent(req: RunRequest, deps: Deps) -> None:
    from .deep_harness import select_deep_harness

    decision = await select_deep_harness(req)
    if decision.use_deep_agent:
        await _run_selected_deep_agent(req, deps, decision)
        return
    await deps.emit(
        {"t": "step", "v": f"Using deterministic Arcelle harness: {decision.reason}"}
    )
    await _facade_module().run_agent(req, deps)


async def _run_stream_request(req: RunRequest, deps: Deps) -> None:
    if _deep_harness_is_enabled(req):
        await _run_deep_or_classic_agent(req, deps)
        return
    await _facade_module().run_agent(req, deps)


async def _emit_torn_down_run(queue: asyncio.Queue[Event | None]) -> None:
    # `finally` still queues the sentinel, so a cancelled NDJSON stream closes
    # cleanly. Without this event the host read that as a successful empty
    # answer and saved a zero-byte reply (live QA 2026-07-30, the Yahoo/ETF
    # task). A torn-down run must never look like a finished one.
    _log.error("run torn down before it produced an answer", exc_info=True)
    await queue.put(
        {"t": "error", "v": "the run was torn down before it produced an answer"}
    )


async def _emit_stream_failure(queue: asyncio.Queue[Event | None], exc: BaseException) -> None:
    # `_why` is required because several httpx/asyncio errors stringify to an
    # empty string, which would otherwise emit an unusable error event.
    _log.error("run failed: %s", type(exc).__name__, exc_info=True)
    await queue.put({"t": "error", "v": _why(exc)})


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
            await _facade_module()._run_stream_request(req, deps)
        except asyncio.CancelledError:
            await _emit_torn_down_run(queue)
            raise
        except BaseException as exc:  # noqa: BLE001 - any failure must reach the host
            await _emit_stream_failure(queue, exc)
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
