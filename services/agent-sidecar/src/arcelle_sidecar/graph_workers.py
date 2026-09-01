"""Worker execution and dependency-aware batch planning."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import AgentState as AgentState, CancelToken as CancelToken, Deps as Deps, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, PROGRESS_ELIDED as PROGRESS_ELIDED, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, STUDIO_DEPS as STUDIO_DEPS, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, _NULL_SLOT as _NULL_SLOT, _NullSlot as _NullSlot, _TurnShared as _TurnShared, _pixel_checked_outcome as _pixel_checked_outcome, _required_pixel_tool as _required_pixel_tool, _room_identity_arguments as _room_identity_arguments
from .graph_prepare_core import _Preparation as _Preparation, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _deps as _deps, _held_plan_tools as _held_plan_tools, _list_tools as _list_tools, _locked_groups as _locked_groups, _preparation_context as _preparation_context, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _tool_is_visible as _tool_is_visible, _why as _why, _why_failed as _why_failed
from .graph_prepare import _agent_paragraph as _agent_paragraph, _announce_missing_specialists as _announce_missing_specialists, _announce_plan as _announce_plan, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_locked_groups_note as _append_locked_groups_note, _append_plan_note as _append_plan_note, _append_preparation_context as _append_preparation_context, _append_request_tools as _append_request_tools, _append_skills_note as _append_skills_note, _append_system_text as _append_system_text, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _bridge_tools as _bridge_tools, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _copied_messages as _copied_messages, _dedupe_hub_delegations as _dedupe_hub_delegations, _emit_worker_lane as _emit_worker_lane, _first_visual_instruction as _first_visual_instruction, _image_transportable_tools as _image_transportable_tools, _is_single_planned_step as _is_single_planned_step, _is_visual_instruction as _is_visual_instruction, _offered_tool_names as _offered_tool_names, _plan_for_preparation as _plan_for_preparation, _planned_visual_instruction as _planned_visual_instruction, _prepared_updates as _prepared_updates, _prepared_visual_calls as _prepared_visual_calls, _privacy_allowed_tools as _privacy_allowed_tools, _selected_tools as _selected_tools, _served_names as _served_names, _served_specs as _served_specs, _should_append_agent_paragraph as _should_append_agent_paragraph, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _system_message as _system_message, _terminal_visual_evidence as _terminal_visual_evidence, _visible_bridge_tools as _visible_bridge_tools, prepare as prepare
from .graph_model import _ModelResponse as _ModelResponse, _ModelRound as _ModelRound, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _call_model_update as _call_model_update, _can_retry_pixel_capture as _can_retry_pixel_capture, _correction_note as _correction_note, _deduplicated_hub_calls as _deduplicated_hub_calls, _emit_round_usage as _emit_round_usage, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _is_last_model_round as _is_last_model_round, _matches_pixel_event as _matches_pixel_event, _messages_for_model as _messages_for_model, _model_round_context as _model_round_context, _model_update as _model_update, _needs_pixel_correction as _needs_pixel_correction, _normal_pixel_update as _normal_pixel_update, _pixel_correction as _pixel_correction, _pixel_correction_update as _pixel_correction_update, _pixel_failure_count as _pixel_failure_count, _pixel_failures_must_stop as _pixel_failures_must_stop, _pixel_missing_text as _pixel_missing_text, _pixel_requirement as _pixel_requirement, _progress_note as _progress_note, _should_stop_model_round as _should_stop_model_round, _shown_progress as _shown_progress, _stream_model_round as _stream_model_round, _successful_pixel_event as _successful_pixel_event, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _terminal_visual_verdict as _terminal_visual_verdict, _visual_model_update as _visual_model_update, _without_pixel_correction as _without_pixel_correction, call_model as call_model
from .graph_tools import LEDGER_TOOLS as LEDGER_TOOLS, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _active_step as _active_step, _append_group_prompt as _append_group_prompt, _args_summary as _args_summary, _artifact_referent_names as _artifact_referent_names, _clip_report as _clip_report, _connector_referent_names as _connector_referent_names, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _emit_pipeline as _emit_pipeline, _live_domains as _live_domains, _nonartifact_referent_names as _nonartifact_referent_names, _nonempty_text as _nonempty_text, _nonnegative_integer as _nonnegative_integer, _own_group_note as _own_group_note, _parsed_artifact_receipt as _parsed_artifact_receipt, _referent_names as _referent_names, _renamed_referent_names as _renamed_referent_names, _run_one_tool as _run_one_tool, _single_referent as _single_referent, _starts_with_system_message as _starts_with_system_message, _stripped_referent as _stripped_referent, _truncated_referent as _truncated_referent, _unavailable_group_note as _unavailable_group_note, _unavailable_note as _unavailable_note, _unknown_group_note as _unknown_group_note, _unlock_group as _unlock_group, _unlocked_tool_specs as _unlocked_tool_specs, _valid_artifact_receipt as _valid_artifact_receipt, _valid_sha256 as _valid_sha256, _video_unavailable_note as _video_unavailable_note

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
        "tool_policy": str(state.get("tool_policy", "auto")),
        "privacy_restricted": bool(state.get("privacy_restricted", False)),
        "image_input_available": bool(state.get("image_input_available", True)),
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


def _decoded_plan(raw: str) -> Any:
    """Decode the JSON-shaped plan emitted by engines that stringify arguments."""
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _task_items(raw: Any) -> Any:
    """Unwrap the optional task envelope without validating its contents."""
    if isinstance(raw, dict):
        return raw.get("tasks", raw)
    return raw


def _bare_plan_task(item: Any) -> dict[str, Any] | None:
    """Turn a useful bare string into the default-routed task shape."""
    if not isinstance(item, str):
        return None
    instruction = item.strip()
    if not instruction:
        return None
    return dict(agent="", instruction=instruction, depends_on=[])


def _plan_instruction(item: dict[str, Any]) -> str:
    return str(item.get("instruction") or item.get("task") or "").strip()


def _plan_agent(item: dict[str, Any]) -> str:
    return str(item.get("agent") or item.get("domain") or "").strip().lower()


def _first_plan_dependencies(item: dict[str, Any]) -> Any:
    for key in ("depends_on", "after"):
        value = item.get(key)
        if value:
            return value
    return []


def _dependency_index(value: Any) -> int | None:
    if not isinstance(value, (int, float, str)):
        return None
    if not str(value).lstrip("-").isdigit():
        return None
    return int(value)


def _plan_dependencies(item: dict[str, Any]) -> list[int]:
    raw = _first_plan_dependencies(item)
    if not isinstance(raw, list):
        return []
    dependencies: list[int] = []
    for value in raw:
        dependency = _dependency_index(value)
        if dependency is not None:
            dependencies.append(dependency)
    return dependencies


def _structured_plan_task(item: dict[str, Any]) -> dict[str, Any] | None:
    instruction = _plan_instruction(item)
    if not instruction:
        return None
    return dict(
        agent=_plan_agent(item),
        instruction=instruction,
        depends_on=_plan_dependencies(item),
    )


def _plan_task(item: Any) -> dict[str, Any] | None:
    if isinstance(item, dict):
        return _structured_plan_task(item)
    return _bare_plan_task(item)


def parse_plan(raw: Any) -> list[dict[str, Any]]:
    """Normalise the ``ask_agents`` argument into a task list.

    Fails OPEN at every step. A malformed plan from a 4B is the expected case,
    not the exceptional one, and the alternatives to salvaging it are both
    worse than a slightly-wrong dispatch: refusing costs the user a whole round
    to be told off, and raising kills the turn. So a task keeps whatever it
    got — an unusable one is dropped rather than allowed to poison the batch.
    """
    if isinstance(raw, str):
        raw = _decoded_plan(raw)
    items = _task_items(raw)
    if not isinstance(items, list):
        return []
    tasks: list[dict[str, Any]] = []
    for item in items:
        task = _plan_task(item)
        if task is not None:
            tasks.append(task)
    return tasks


def _dependency_is_in_plan(dependency: int, task_count: int) -> bool:
    return 0 <= dependency < task_count


def _wave_dependencies(task: dict[str, Any], position: int, task_count: int) -> set[int]:
    dependencies = task.get("depends_on", [])
    return {
        dependency
        for dependency in dependencies
        if _dependency_is_in_plan(dependency, task_count) and dependency != position
    }


def _plan_dependencies_for_waves(tasks: list[dict[str, Any]]) -> list[set[int]]:
    task_count = len(tasks)
    return [
        _wave_dependencies(task, position, task_count)
        for position, task in enumerate(tasks)
    ]


def _unfinished_task_positions(task_count: int, done: set[int]) -> list[int]:
    return [position for position in range(task_count) if position not in done]


def _ready_wave(dependencies: list[set[int]], done: set[int]) -> list[int]:
    remaining = _unfinished_task_positions(len(dependencies), done)
    ready = [position for position in remaining if dependencies[position] <= done]
    return ready or remaining


def _schedule_waves(dependencies: list[set[int]]) -> list[list[int]]:
    task_count = len(dependencies)
    waves: list[list[int]] = []
    done: set[int] = set()
    while len(done) < task_count:
        wave = _ready_wave(dependencies, done)
        waves.append(wave)
        done.update(wave)
    return waves


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
    return _schedule_waves(_plan_dependencies_for_waves(tasks))
