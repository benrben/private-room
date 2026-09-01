"""Model-round execution and pixel-evidence decisions."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare

@dataclass(frozen=True, slots=True)
class _ModelRound:
    number: int
    node: str
    last: bool
    messages: list[Message]
    offered: list[dict[str, Any]]


class _ModelResponse(NamedTuple):
    content: str
    calls: list[ToolCall]
    usage: Any
    sent: list[Message]


@dataclass(frozen=True, slots=True)
class _PixelRequirement:
    tool: str
    correction: str


async def _announce_round_budget_exhaustion(
    deps: Deps, node: str, within_turn_budget: bool
) -> None:
    if within_turn_budget:
        return
    if deps.just_exhausted():
        await deps.emit({"t": "step", "v": ROUND_BUDGET_STEP, "node": node})


def _is_last_model_round(
    state: AgentState, rnd: int, max_rounds: int, within_turn_budget: bool
) -> bool:
    if rnd + 1 == max_rounds:
        return True
    if bool(state.get("force_synthesis", False)):
        return True
    return not within_turn_budget


async def _model_round_context(state: AgentState, deps: Deps) -> _ModelRound:
    rnd = state.get("round", 0)
    node = str(state.get("node_key") or MAIN_NODE_KEY)
    within_turn_budget = deps.spend_round()
    await _announce_round_budget_exhaustion(deps, node, within_turn_budget)
    last = _is_last_model_round(
        state,
        rnd,
        state.get("max_rounds", AGENT_ROUND_BACKSTOP),
        within_turn_budget,
    )
    tools: list[dict[str, Any]] = state.get("tools", [])
    return _ModelRound(rnd, node, last, state["messages"], [] if last else tools)


def _shown_progress(progress: list[str]) -> list[str]:
    if len(progress) <= PROGRESS_NOTE_LINES:
        return progress
    kept = progress[-(PROGRESS_NOTE_LINES - 1):]
    return [PROGRESS_ELIDED.format(n=len(progress) - len(kept)), *kept]


def _progress_note(state: AgentState) -> str:
    if not bool(state.get("small_model", False)):
        return ""
    progress: list[str] = list(state.get("progress", []))
    if not progress:
        return ""
    return turn_progress_note(_shown_progress(progress))


def _correction_note(state: AgentState) -> str:
    corrections: list[str] = list(state.get("corrections", []))
    if not corrections:
        return ""
    return correction_note(corrections)


def _messages_for_model(state: AgentState, messages: list[Message]) -> list[Message]:
    notes = [note for note in (_progress_note(state), _correction_note(state)) if note]
    if not notes:
        return messages
    return messages + [{"role": "user", "content": note} for note in notes]


async def _stream_model_round(
    state: AgentState, deps: Deps, round_context: _ModelRound
) -> _ModelResponse:
    live = deps.claim_live(round_context.node)
    if live:
        await deps.emit({"t": "round", "node": round_context.node})

    async def on_delta(delta: str) -> None:
        if live:
            await deps.emit({"t": "delta", "v": delta, "node": round_context.node})

    sent = _messages_for_model(state, round_context.messages)
    try:
        content, calls, usage = await deps.chat.stream(
            sent, round_context.offered, on_delta, deps.cancel
        )
    finally:
        deps.release_live(round_context.node)
    return _ModelResponse(content, calls, usage, sent)


async def _emit_round_usage(
    deps: Deps, round_context: _ModelRound, response: _ModelResponse
) -> None:
    breakdown_chars = categorize_messages(response.sent, json_chars(round_context.offered))
    await deps.emit(
        {
            "t": "usage",
            "node": round_context.node,
            **build_usage_event(round_context.number, response.usage, breakdown_chars),
        }
    )


def _deduplicated_hub_calls(state: AgentState, calls: list[ToolCall]) -> list[ToolCall]:
    if get_agent(str(state.get("agent_id", ""))).main:
        return _dedupe_hub_delegations(calls)
    return calls


def _terminal_visual_evidence_applies(state: AgentState) -> bool:
    if not get_agent(str(state.get("agent_id", ""))).main:
        return False
    return bool(state.get("terminal_visual_evidence", False))


def _terminal_visual_verdict(messages: list[Message]) -> str:
    message_text = "\n".join(str(message.get("content") or "") for message in messages)
    for verdict in (VIDEO_FRAME_MISSING, PIXEL_EVIDENCE_MISSING):
        if verdict in message_text:
            return verdict
    return ""


def _terminal_visual_evidence_update(
    state: AgentState, messages: list[Message], cancelled: bool
) -> dict[str, Any] | None:
    if not _terminal_visual_evidence_applies(state):
        return None
    terminal_missing = _terminal_visual_verdict(messages)
    if not terminal_missing:
        return None
    return {
        "messages": messages,
        "final_text": terminal_missing,
        "calls": [],
        "cancelled": cancelled,
        "stop": True,
        "video_evidence_retries": int(state.get("video_evidence_retries", 0)),
    }


def _pixel_requirement(state: AgentState) -> _PixelRequirement | None:
    tool = _required_pixel_tool(
        str(state.get("agent_id", "")), str(state.get("question") or "")
    )
    if not tool:
        return None
    return _PixelRequirement(tool, _pixel_correction(tool))


def _pixel_correction(tool: str) -> str:
    if tool == "view_media_frame":
        return VIDEO_FRAME_REQUIRED
    return (
        "This request requires real pixels. Call "
        f"{tool} and inspect its attached image before answering; "
        "text, OCR, metadata, or a receipt alone is not visual evidence."
    )


def _matches_pixel_event(event: dict[str, Any], tool: str) -> bool:
    return str(event.get("name") or "") == tool


def _successful_pixel_event(event: dict[str, Any], tool: str) -> bool:
    if not _matches_pixel_event(event, tool):
        return False
    return not bool(event.get("error", False))


def _failed_pixel_event(event: dict[str, Any], tool: str) -> bool:
    if not _matches_pixel_event(event, tool):
        return False
    return bool(event.get("error", False))


def _has_pixel_evidence(events: list[dict[str, Any]], tool: str) -> bool:
    return any(_successful_pixel_event(event, tool) for event in events)


def _pixel_failure_count(events: list[dict[str, Any]], tool: str) -> int:
    return sum(_failed_pixel_event(event, tool) for event in events)


def _pixel_missing_text(requirement: _PixelRequirement) -> str:
    if requirement.tool == "view_media_frame":
        return VIDEO_FRAME_MISSING
    return PIXEL_EVIDENCE_MISSING


def _should_stop_model_round(last: bool, cancelled: bool, calls: list[ToolCall]) -> bool:
    if last:
        return True
    if cancelled:
        return True
    return not calls


def _pixel_failures_must_stop(
    evidence: bool, failures: int, cancelled: bool
) -> bool:
    return not evidence and not cancelled and failures >= 2


def _needs_pixel_correction(
    evidence: bool, calls: list[ToolCall], cancelled: bool
) -> bool:
    if evidence:
        return False
    if calls:
        return False
    return not cancelled


def _can_retry_pixel_capture(last: bool, retries: int) -> bool:
    return not last and retries < 1


def _without_pixel_correction(corrections: list[str], correction: str) -> list[str]:
    return [note for note in corrections if note != correction]


def _model_update(
    messages: list[Message],
    content: str,
    calls: list[ToolCall],
    cancelled: bool,
    stop: bool,
    video_retries: int,
    corrections_update: list[str] | None,
) -> dict[str, Any]:
    update: dict[str, Any] = {
        "messages": messages,
        "final_text": content,
        "calls": [] if stop else calls,
        "cancelled": cancelled,
        "stop": stop,
        "video_evidence_retries": video_retries,
    }
    if corrections_update is not None:
        update["corrections"] = corrections_update
    return update


def _pixel_correction_update(
    messages: list[Message],
    content: str,
    calls: list[ToolCall],
    cancelled: bool,
    requirement: _PixelRequirement,
    last: bool,
    retries: int,
    corrections: list[str],
) -> dict[str, Any]:
    if _can_retry_pixel_capture(last, retries):
        updated = list(dict.fromkeys([*corrections, requirement.correction]))
        return _model_update(
            messages, content, calls, cancelled, False, retries + 1, updated
        )
    return _model_update(
        messages,
        _pixel_missing_text(requirement),
        [],
        cancelled,
        True,
        retries,
        _without_pixel_correction(corrections, requirement.correction),
    )


def _normal_pixel_update(
    messages: list[Message],
    content: str,
    calls: list[ToolCall],
    cancelled: bool,
    last: bool,
    retries: int,
    corrections: list[str],
    requirement: _PixelRequirement,
    evidence: bool,
) -> dict[str, Any]:
    corrections_update: list[str] | None = None
    if evidence:
        if requirement.correction in corrections:
            corrections_update = _without_pixel_correction(
                corrections, requirement.correction
            )
    return _model_update(
        messages,
        content,
        calls,
        cancelled,
        _should_stop_model_round(last, cancelled, calls),
        retries,
        corrections_update,
    )


def _visual_model_update(
    state: AgentState,
    messages: list[Message],
    content: str,
    calls: list[ToolCall],
    cancelled: bool,
    last: bool,
    requirement: _PixelRequirement,
) -> dict[str, Any]:
    events: list[dict[str, Any]] = state.get("tool_events", [])
    evidence = _has_pixel_evidence(events, requirement.tool)
    failures = _pixel_failure_count(events, requirement.tool)
    retries = int(state.get("video_evidence_retries", 0))
    corrections: list[str] = list(state.get("corrections", []))
    if _pixel_failures_must_stop(evidence, failures, cancelled):
        return _model_update(
            messages, _pixel_missing_text(requirement), [], cancelled, True, retries, None
        )
    if _needs_pixel_correction(evidence, calls, cancelled):
        return _pixel_correction_update(
            messages, content, calls, cancelled, requirement, last, retries, corrections
        )
    return _normal_pixel_update(
        messages,
        content,
        calls,
        cancelled,
        last,
        retries,
        corrections,
        requirement,
        evidence,
    )


def _call_model_update(
    state: AgentState,
    messages: list[Message],
    content: str,
    calls: list[ToolCall],
    cancelled: bool,
    last: bool,
) -> dict[str, Any]:
    requirement = _pixel_requirement(state)
    if requirement is None:
        return _model_update(
            messages,
            content,
            calls,
            cancelled,
            _should_stop_model_round(last, cancelled, calls),
            int(state.get("video_evidence_retries", 0)),
            None,
        )
    return _visual_model_update(
        state, messages, content, calls, cancelled, last, requirement
    )


async def call_model(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """One model round: prepare its context, stream, then decide how it ends."""
    deps = _deps(config)
    if deps.cancel.cancelled:
        return {"cancelled": True, "stop": True, "calls": []}
    round_context = await _model_round_context(state, deps)
    response = await _stream_model_round(state, deps, round_context)
    await _emit_round_usage(deps, round_context, response)
    calls = _deduplicated_hub_calls(state, response.calls)
    cancelled = deps.cancel.cancelled
    terminal = _terminal_visual_evidence_update(state, round_context.messages, cancelled)
    if terminal is not None:
        return terminal
    return _call_model_update(
        state,
        round_context.messages,
        response.content,
        calls,
        cancelled,
        round_context.last,
    )
