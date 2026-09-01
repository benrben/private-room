"""Room-tool execution, artifact receipts, and availability messages."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model

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


def _unknown_group_note(group: str) -> str | None:
    if group in GROUPS:
        return None
    return f"Unknown tool group '{group}'. Valid groups: {', '.join(GROUPS)}."


def _own_group_note(group: str, own_group: str | None) -> str | None:
    if group != own_group:
        return None
    # The hatch widens a MISSED lane, never an agent inside its own domain
    # (see `_locked_groups`). The enum never offers this, so reaching here
    # means the model asked for it anyway.
    return (
        f"The rest of the {group} tools belong to another specialist. Do what "
        "your own instructions allow and report the rest as MISSING."
    )


def _unavailable_group_note(group: str, served_names: set[str]) -> str | None:
    # The same servability question `_locked_groups` asks, asked the same way:
    # a group whose load-bearing tools this tier withholds is NOT unlockable,
    # however many of its incidental tools were served. Answering "here you go"
    # here would append `group_prompt` — a briefing on tools the model does not
    # hold — which is the whole failure this gate exists to prevent.
    if group_servable(group, served_names):
        return None
    # An advisor-scope bridge never serves these — don't pretend otherwise.
    return f"The {group} tools are not available in this context."


def _unlocked_tool_specs(
    state: AgentState,
    unlocked: set[str],
    served_specs: list[dict[str, Any]],
    served_names: set[str],
    own_group: str | None,
) -> list[dict[str, Any]]:
    tools = _select_tools(
        served_specs,
        agent_id=str(state.get("agent_id", "")),
        unlocked=unlocked,
        advisors=bool(state.get("advisors", False)),
        plan_multi=bool(state.get("plan_multi", False)),
    )
    offered = {spec.get("function", {}).get("name") for spec in tools}
    still_locked = _locked_groups(served_names, offered, unlocked, own_group)
    if still_locked:
        tools.append(request_tools_spec(still_locked))
    return tools


def _starts_with_system_message(messages: list[Message]) -> bool:
    return bool(messages) and messages[0].get("role") == "system"


def _append_group_prompt(messages: list[Message], prompt: str) -> None:
    if _starts_with_system_message(messages):
        content = messages[0].get("content") or ""
        if prompt and prompt not in content:
            messages[0]["content"] = content + prompt


def _unlock_group(
    group: str,
    state: AgentState,
    unlocked: set[str],
    messages: list[Message],
) -> tuple[str, bool, list[dict[str, Any]] | None]:
    """Handle one request_tools call. Returns (result text, ok, new tools or None)."""
    served_specs: list[dict[str, Any]] = list(state.get("served_specs", []))
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    unknown = _unknown_group_note(group)
    if unknown is not None:
        return unknown, False, None
    own = get_agent(str(state.get("agent_id", ""))).group
    own_group = _own_group_note(group, own)
    if own_group is not None:
        return own_group, False, None
    names = group_tools(group)
    unavailable = _unavailable_group_note(group, served_names)
    if unavailable is not None:
        return unavailable, False, None

    unlocked.add(group)
    tools = _unlocked_tool_specs(state, unlocked, served_specs, served_names, own)
    # The group is unlocked, so NOW its system-prompt paragraph applies (same
    # doctrine as prepare: describe only tools the model actually has).
    _append_group_prompt(messages, group_prompt(group))
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
        # LEDGER_TOOLS must stay a SUPERSET of graphs.WRITE_TOOLS, or
        # verify_claims fires a guaranteed false accusation at the one tool
        # that did the work.
        "draw",
        "studio_flashcards",
        "studio_mindmap",
        "generate_podcast_script",
    }
)


_POST_COMMIT_READ_TOOLS = frozenset(
    {"studio_flashcards", "studio_mindmap", "generate_podcast_script"}
)


_ARTIFACT_RECEIPT = re.compile(r"(?:^|\n)ARCELLE_ARTIFACT_RECEIPT\s+(\{[^\n]+\})")


_ARTIFACT_RECEIPT_TOOLS = frozenset(
    {"studio_flashcards", "studio_mindmap", "generate_podcast_script"}
)


def _nonempty_text(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return bool(value.strip())


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _nonnegative_integer(value: Any) -> bool:
    if not isinstance(value, int):
        return False
    return value >= 0


def _parsed_artifact_receipt(result_text: str) -> dict[str, Any] | None:
    match = _ARTIFACT_RECEIPT.search(result_text)
    if match is None:
        return None
    try:
        receipt = json.loads(match.group(1))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return receipt if isinstance(receipt, dict) else None


def _valid_artifact_receipt(receipt: dict[str, Any]) -> bool:
    return all(
        (
            _nonempty_text(receipt.get("name")),
            _nonempty_text(receipt.get("fileId")),
            _valid_sha256(receipt.get("sha256")),
            _nonnegative_integer(receipt.get("size")),
        )
    )


def _artifact_referent_names(result_text: str) -> list[str]:
    receipt = _parsed_artifact_receipt(result_text)
    if receipt is None:
        return []
    if not _valid_artifact_receipt(receipt):
        return []
    name = receipt["name"]
    return [name.strip()[:80]]


def _truncated_referent(value: Any) -> str | None:
    if not value:
        return None
    return str(value)[:80]


def _single_referent(value: Any) -> list[str]:
    name = _truncated_referent(value)
    return [name] if name is not None else []


def _stripped_referent(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    name = value.strip()
    if not name:
        return None
    return name[:80]


def _edit_referent(edit: Any) -> str | None:
    if not isinstance(edit, dict):
        return _stripped_referent(edit)
    return _truncated_referent(edit.get("new_name") or edit.get("name"))


def _edit_referent_names(edits: Any) -> list[str]:
    flattened = _stripped_referent(edits)
    if flattened is not None:
        return [flattened]
    if not isinstance(edits, list):
        return []
    return [name for edit in edits if (name := _edit_referent(edit)) is not None]


def _connector_referent_names(args: dict[str, Any]) -> list[str]:
    ran = args.get("tool") or args.get("name")
    return _single_referent(ran) or ["a connector tool"]


def _renamed_referent_names(args: dict[str, Any]) -> list[str]:
    return _single_referent(args.get("new_name") or args.get("name"))


def _nonartifact_referent_names(tool: str, args: dict[str, Any]) -> list[str]:
    if tool == "draw":
        # The artifact is the SKETCH, which `draw` names directly — and a name
        # that did not exist yet is still the right referent, because the tool
        # creates it.
        return _single_referent(args.get("name"))
    if tool == "edit_files":
        # A 4B sometimes flattens `edits` to a bare string; take it rather than
        # recording nothing and accusing itself of a failed write.
        return _edit_referent_names(args.get("edits"))
    if tool == "rename_file":
        # A rename's RESULT is new_name; that is the artifact that now exists,
        # and the name a later step has to be able to open.
        return _renamed_referent_names(args)
    if tool == "run_mcp_tool":
        # {tool, arguments} (room_mcp.rs MCP_RUN_TOOL). The evidence is WHICH
        # connector tool ran — the id is what a later step, and the user, can
        # check. Recorded only on success, which is what lets the write-claim
        # gate catch "I sent the email" after a send that errored.
        return _connector_referent_names(args)
    return _single_referent(args.get("name"))


def _referent_names(
    tool: str, args: dict[str, Any] | None, result_text: str = ""
) -> list[str]:
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
    if tool in _ARTIFACT_RECEIPT_TOOLS:
        return _artifact_referent_names(result_text)
    return _nonartifact_referent_names(tool, args or {})


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


def _video_unavailable_note(*, privacy_restricted: bool) -> str:
    """Fail closed when a file-domain request really needs video pixels.

    ``ask_file_agent`` is intentionally a broad domain tool: ordinary file
    reads remain reachable while Cloud Privacy removes ``view_media_frame``.
    That means a domain-only availability check is insufficient. Resolving the
    instruction against the filtered catalog silently changes the intended
    ``media.video`` worker into the domain default (``files.read``), which then
    receives a frame question it cannot answer. Name the blocked capability
    and the user's recovery path instead.
    """
    if privacy_restricted:
        reason = (
            "Cloud Privacy keeps the requested video pixels on this Mac in this "
            "protected-cloud turn"
        )
        recovery = (
            "Switch to On this Mac, or use the app's one-turn approval to send "
            "this question again with the blocked image"
        )
    else:
        reason = "the selected model or provider has no usable video-image channel"
        recovery = "Switch to an image-capable model or to On this Mac"
    return (
        f"The Video agent cannot inspect that frame because {reason}. MISSING: "
        f"{recovery}. Do not substitute the File agent or infer the frame from "
        "a transcript or text receipt."
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
