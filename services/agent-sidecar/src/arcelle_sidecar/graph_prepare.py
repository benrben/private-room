"""Prompt and visual-evidence preparation for graph rounds."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import _pixel_checked_outcome as _pixel_checked_outcome, _room_identity_arguments as _room_identity_arguments, _required_pixel_tool as _required_pixel_tool, CancelToken as CancelToken, _NullSlot as _NullSlot, _TurnShared as _TurnShared, Deps as Deps, AgentState as AgentState
from .graph_prepare_core import _deps as _deps, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _held_plan_tools as _held_plan_tools, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed, _list_tools as _list_tools, _locked_groups as _locked_groups, _Preparation as _Preparation, _preparation_context as _preparation_context

async def _emit_worker_lane(context: _Preparation) -> None:
    """Report the active worker before it receives its toolbox."""
    if context.agent.main:
        return
    await context.deps.emit(
        {
            "t": "lane",
            "v": lane_label(
                ui=context.agent.id == "app.ui",
                write=context.write,
                web_enabled=context.web_enabled,
                agent_id=context.agent.id,
            ),
        }
    )


async def _bridge_tools(context: _Preparation) -> list[Any]:
    """List the bridge catalog unless this turn forbids all tools."""
    if context.no_tools:
        return []
    return await _list_tools(context.deps)


def _privacy_allowed_tools(served: list[Any]) -> list[Any]:
    return [tool for tool in served if cloud_privacy_tool_allowed(tool.name)]


def _image_transportable_tools(served: list[Any]) -> list[Any]:
    return [tool for tool in served if tool.name not in PIXEL_RESULT_TOOLS]


def _visible_bridge_tools(served: list[Any], state: AgentState) -> list[Any]:
    """Apply the privacy and image-transport boundaries to a bridge catalog."""
    if state.get("privacy_restricted", False):
        served = _privacy_allowed_tools(served)
    if not state.get("image_input_available", True):
        served = _image_transportable_tools(served)
    return served


async def _served_specs(context: _Preparation, state: AgentState) -> list[dict[str, Any]]:
    """List only the bridge tools this model may receive this turn."""
    served = await _bridge_tools(context)
    visible = _visible_bridge_tools(served, state)
    return [tool.to_ollama() for tool in visible]


def _served_names(served_specs: list[dict[str, Any]]) -> set[str]:
    return {spec.get("function", {}).get("name") for spec in served_specs}


def _selected_tools(
    context: _Preparation, served_specs: list[dict[str, Any]], served_names: set[str]
) -> list[dict[str, Any]]:
    """Choose the hub's specialists or the worker's scoped room tools."""
    if context.agent.main:
        return agent_tool_specs(web_enabled=context.web_enabled, served_names=served_names)
    return _select_tools(
        served_specs,
        agent_id=context.agent.id,
        unlocked=context.unlocked,
        advisors=context.advisors,
        plan_multi=context.plan_multi,
    )


async def _announce_missing_specialists(
    context: _Preparation, tools: list[dict[str, Any]], served_specs: list[dict[str, Any]]
) -> None:
    """Make a missing bridge catalog visible before the model describes it."""
    if not context.agent.main:
        return
    if tools or context.no_tools:
        return
    await context.deps.emit(
        {
            "t": "step",
            "v": (
                "No specialists available — the room tool bridge served "
                f"{len(served_specs)} tools this run"
            ),
        }
    )
    await context.deps.emit({"t": "step_status", "ok": False})


def _plan_for_preparation(
    context: _Preparation, state: AgentState, served_names: set[str]
) -> Any:
    """Build one hub plan; workers use the catalog already chosen for them."""
    if not context.agent.main or context.no_tools:
        return None
    return build_plan(
        str(state.get("question") or ""),
        web_enabled=context.web_enabled,
        served_names=served_names,
    )


async def _announce_plan(context: _Preparation, state: AgentState, plan: Any) -> None:
    if plan is None or not plan.steps:
        return
    node = str(state.get("node_key") or MAIN_NODE_KEY)
    await context.deps.emit({"t": "step", "v": f"Plan: {plan.summary}", "node": node})
    await context.deps.emit({"t": "step_status", "ok": True, "node": node})


def _copied_messages(state: AgentState) -> list[Message]:
    return [dict(message) for message in state.get("messages", [])]  # type: ignore[misc]


def _offered_tool_names(tools: list[dict[str, Any]]) -> set[str]:
    return {spec.get("function", {}).get("name") for spec in tools}


def _append_request_tools(
    context: _Preparation,
    served_names: set[str],
    tools: list[dict[str, Any]],
    offered: set[str],
) -> list[str]:
    """Expose the worker-only escape hatch when a served group is locked."""
    if context.agent.main:
        return []
    locked = _locked_groups(served_names, offered, context.unlocked, context.agent.group)
    if locked:
        tools.append(request_tools_spec(locked))
    return locked


def _system_message(messages: list[Message], no_tools: bool) -> Message | None:
    if no_tools or not messages:
        return None
    if messages[0].get("role") != "system":
        return None
    return messages[0]


def _append_system_text(system: Message, text: str) -> None:
    content = system.get("content") or ""
    if text not in content:
        system["content"] = content + text


def _agent_paragraph(
    context: _Preparation, offered: set[str]
) -> str:
    if context.agent.main:
        return main_prompt(
            (key for key, name in DOMAIN_KEYS.items() if name in offered),
            web_off=not context.web_enabled,
        )
    return context.agent.prompt


def _should_append_agent_paragraph(
    context: _Preparation, offered: set[str], paragraph: str
) -> bool:
    return bool(paragraph) and (
        context.agent.main
        or bool(set(context.agent.tools) & offered)
        or (context.agent.core_capable and bool(set(CORE_TOOLS) & offered))
    )


def _append_agent_paragraph(
    system: Message, context: _Preparation, offered: set[str]
) -> None:
    paragraph = _agent_paragraph(context, offered)
    if _should_append_agent_paragraph(context, offered, paragraph):
        _append_system_text(system, paragraph)


def _append_direct_specialist_note(
    system: Message, context: _Preparation, state: AgentState
) -> None:
    note = (
        DIRECT_SPECIALIST_NOTE.format(label=context.agent.label, area=context.agent.area)
        if state.get("direct", False) and not context.agent.main
        else ""
    )
    _append_system_text(system, note)


def _append_plan_note(system: Message, plan: Any) -> None:
    if plan is not None:
        _append_system_text(system, plan.note)


def _append_skills_note(
    system: Message, context: _Preparation, offered: set[str]
) -> None:
    if not context.agent.main and "list_skills" in offered:
        _append_system_text(system, SKILLS_NOTE)


def _append_locked_groups_note(system: Message, locked: list[str]) -> None:
    if locked:
        _append_system_text(
            system,
            TOOL_GROUPS_PROMPT.format(
                groups="; ".join(TOOL_GROUP_LABELS[group] for group in locked)
            ),
        )


def _append_preparation_context(
    messages: list[Message],
    context: _Preparation,
    state: AgentState,
    offered: set[str],
    plan: Any,
    locked: list[str],
) -> None:
    system = _system_message(messages, context.no_tools)
    if system is None:
        return
    _append_agent_paragraph(system, context, offered)
    _append_direct_specialist_note(system, context, state)
    _append_plan_note(system, plan)
    _append_skills_note(system, context, offered)
    _append_locked_groups_note(system, locked)


def _is_visual_instruction(instruction: str) -> bool:
    return is_visual_video_intent(instruction) or is_static_visual_intent(instruction)


def _first_visual_instruction(steps: tuple[Any, ...]) -> str:
    first = steps[0]
    if (
        first.worker in {"media.video", "files.read"}
        and not first.needs_previous
        and _is_visual_instruction(first.instruction)
    ):
        return first.instruction
    return ""


def _sole_unavailable_visual_instruction(plan: Any) -> str:
    instruction = (
        plan.unavailable[0][1]
        if len(plan.unavailable) == 1 and not plan.unplanned
        else ""
    )
    return instruction if _is_visual_instruction(instruction) else ""


def _planned_visual_instruction(plan: Any) -> str:
    if plan is None or plan.reason != "planned":
        return ""
    if plan.steps:
        return _first_visual_instruction(plan.steps)
    return _sole_unavailable_visual_instruction(plan)


def _can_prepare_visual_evidence(
    context: _Preparation, instruction: str, offered: set[str]
) -> bool:
    if not context.agent.main:
        return False
    if context.no_tools or not instruction:
        return False
    return "ask_file_agent" in offered


def _prepared_visual_calls(
    context: _Preparation, instruction: str, offered: set[str]
) -> list[ToolCall]:
    if not _can_prepare_visual_evidence(context, instruction, offered):
        return []
    return [
        ToolCall(
            name="ask_file_agent",
            arguments={"instruction": instruction},
            id="arcelle-visual-evidence",
        )
    ]


def _is_single_planned_step(plan: Any) -> bool:
    return bool(
        plan
        and plan.reason == "planned"
        and len(plan.steps) == 1
        and not plan.unplanned
        and not plan.unavailable
    )


def _artifact_delegation_is_terminal(plan: Any) -> bool:
    if plan is None:
        return False
    return plan.reason == "abstained" or _is_single_planned_step(plan)


def _terminal_visual_evidence(calls: list[ToolCall], plan: Any) -> bool:
    if not calls:
        return False
    return _is_single_planned_step(plan)


def _prepared_updates(
    context: _Preparation,
    plan: Any,
    tools: list[dict[str, Any]],
    served_specs: list[dict[str, Any]],
    messages: list[Message],
    prepared_calls: list[ToolCall],
) -> dict[str, Any]:
    return {
        "tools": tools,
        "served_specs": served_specs,
        "messages": messages,
        "seen": set(),
        "planned_step_count": len(plan.steps) if plan is not None else 0,
        "artifact_delegation_is_terminal": _artifact_delegation_is_terminal(plan),
        "force_synthesis": False,
        "stalls": 0,
        "round": 0,
        "calls": prepared_calls,
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "video_evidence_retries": 0,
        "terminal_visual_evidence": _terminal_visual_evidence(prepared_calls, plan),
        "synth": bool(prepared_calls),
        "cancelled": context.deps.cancel.cancelled,
        "stop": False,
    }


async def prepare(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """The active sub-agent's toolbox, system-prompt appends, and first calls."""
    context = _preparation_context(state, config)
    await _emit_worker_lane(context)
    served_specs = await _served_specs(context, state)
    served_names = _served_names(served_specs)
    tools = _selected_tools(context, served_specs, served_names)
    await _announce_missing_specialists(context, tools, served_specs)
    plan = _plan_for_preparation(context, state, served_names)
    await _announce_plan(context, state, plan)
    messages = _copied_messages(state)
    offered = _offered_tool_names(tools)
    locked = _append_request_tools(context, served_names, tools, offered)
    _append_preparation_context(messages, context, state, offered, plan, locked)
    visual_instruction = _planned_visual_instruction(plan)
    prepared_calls = _prepared_visual_calls(context, visual_instruction, offered)
    return _prepared_updates(context, plan, tools, served_specs, messages, prepared_calls)



def _dedupe_hub_delegations(calls: list[ToolCall]) -> list[ToolCall]:
    """Keep the first delegation to each domain in one hub model round.

    A domain call carries an arbitrary instruction, so two calls to the same
    specialist are not two capabilities — they are a model-invented expansion
    of one domain step. The worker can receive both requested file operations
    in one instruction, while two File agents race blind and can contradict
    each other's receipts. Room tools are left untouched; workers legitimately
    call the same verb for different files.
    """
    seen: set[str] = set()
    kept: list[ToolCall] = []
    for call in calls:
        is_delegation = call.name in AGENT_TOOL_NAMES or call.name == BATCH_TOOL_NAME
        if is_delegation and call.name in seen:
            continue
        if is_delegation:
            seen.add(call.name)
        kept.append(call)
    return kept
