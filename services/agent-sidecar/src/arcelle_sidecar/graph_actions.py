"""Tool-node execution, synthesis, fallback, and tagged-agent flow."""

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
from .graph_toolpass import _ToolPass as _ToolPass

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


def _fallback_report_line(label: str, text: str) -> str:
    report = text.split(":", 1)[-1].strip() if text.startswith("Report from the") else text
    return f"**{label}** — {report}"


def _fallback_reports(final: AgentState) -> list[str]:
    return [_fallback_report_line(label, text) for label, text in final.get("reports", [])]


def _fallback_report_answer(reports: list[str], cancelled: bool) -> str:
    head = (
        "Stopped. Here is what had already come back:"
        if cancelled
        else "I could not compose an answer, but here is what came back:"
    )
    return head + "\n\n" + "\n\n".join(reports)


def _fallback_without_reports(final: AgentState, cancelled: bool) -> str:
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
    reports = _fallback_reports(final)
    if reports:
        # Specialists finished real work and the hub never wrote it up. Handing
        # back "" threw all of it away and the user saw a turn that did nothing
        # — the actual harm behind "a crash/Stop discards completed work". Just
        # as true when nothing was stopped.
        return _fallback_report_answer(reports, cancelled)
    return _fallback_without_reports(final, cancelled)


async def _refuse_tag(
    deps: Deps,
    tag: str,
    available: list[str],
    *,
    capability_reason: str = "",
) -> str:
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
    if capability_reason:
        answer = f"{answer}\n\n{capability_reason}"
    await deps.emit({"t": "step", "v": f"No *{tag} specialist in this room"})
    await deps.emit({"t": "step_status", "ok": False})
    await deps.emit({"t": "final", "v": answer})
    return answer


def _tagged_tool_allowed(
    tool: Any,
    *,
    privacy_restricted: bool,
    image_input_available: bool,
) -> bool:
    """Keep only tools the directly selected specialist may honestly use."""
    return (
        (not privacy_restricted or cloud_privacy_tool_allowed(tool.name))
        and (image_input_available or tool.name not in PIXEL_RESULT_TOOLS)
    )


async def _tagged_specialists(req: RunRequest, deps: Deps) -> dict[str, str]:
    """Resolve the specialists this request can reach before a graph starts."""
    privacy_restricted = req.cloud_privacy_restricted()
    image_input_available = req.image_input_available()
    served_names = {
        tool.name
        for tool in await _list_tools(deps)
        if _tagged_tool_allowed(
            tool,
            privacy_restricted=privacy_restricted,
            image_input_available=image_input_available,
        )
    }
    return specialist_workers(web_enabled=req.web_enabled, served_names=served_names)


def _tagged_unavailable_reason(req: RunRequest, tag: str) -> str:
    """Explain the two capability failures unique to the Video specialist."""
    if tag != "video":
        return ""
    if req.cloud_privacy_restricted():
        return (
            "The Video agent cannot inspect pixels while Cloud Privacy is "
            "protecting this cloud turn. Switch to On this Mac or use the "
            "one-turn privacy bypass to inspect the frame."
        )
    if not req.image_input_available():
        return (
            "The Video agent cannot inspect frames because the selected "
            "model has no usable image-input channel. Choose a model with "
            "Vision capability, including an On this Mac vision model."
        )
    return ""


def _tagged_entry(worker: AgentSpec, ask: str) -> dict[str, Any]:
    """Create the direct specialist's single node for the turn diagram."""
    return dict(
        agent=worker.id,
        label=worker.label,
        instruction=ask,
        status="running",
        batch=None,
        key=MAIN_NODE_KEY,
    )


async def _emit_tagged_start(
    deps: Deps, entry: dict[str, Any], worker: AgentSpec
) -> None:
    """Publish the one direct-specialist node before its graph begins."""
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


def _tagged_initial_state(
    req: RunRequest,
    worker: AgentSpec,
    messages: list[Message],
    *,
    ask: str,
    write: bool,
    small_model: bool,
    run_max_rounds: int,
) -> AgentState:
    """Build the selected worker's state without adding a hub step."""
    return {
        # The ask WITHOUT the tag: `graphs.route_action` scores this string
        # against each action's hints, and "*file" would score as the word
        # "file". The messages keep the user's text verbatim — the transcript
        # must not quietly differ from the composer.
        "question": ask,
        "tool_policy": req.resolved_tool_policy(),
        "privacy_restricted": req.cloud_privacy_restricted(),
        "image_input_available": req.image_input_available(),
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


async def _run_direct_specialist(
    worker: AgentSpec,
    initial: AgentState,
    deps: Deps,
    run_max_rounds: int,
) -> AgentState:
    """Invoke the selected worker's declared graph directly."""
    from .graphs import graph_for, recursion_limit_for

    return await graph_for(worker.id).ainvoke(
        initial,
        config={
            "configurable": {"deps": deps},
            "recursion_limit": recursion_limit_for(worker.id, run_max_rounds),
        },
    )  # type: ignore[return-value]


def _tagged_result(
    final: AgentState,
    *,
    report_failed: bool,
    cancelled: bool,
) -> tuple[str, str]:
    """Return the direct answer and the matching diagram status."""
    answer = (final.get("final_text", "") or "").strip()
    if answer and not report_failed and not final.get("cancelled"):
        return answer, "done"
    return _fallback_answer(final, cancelled=cancelled), "failed"


async def _emit_tagged_completion(
    deps: Deps, entry: dict[str, Any], answer: str, status: str
) -> None:
    """Publish a terminal node state that agrees with the final answer."""
    entry["status"] = status
    await deps.emit({"t": "plan", "v": [dict(entry)]})
    await deps.emit({"t": "final", "v": answer})


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
    # THE routing table, and the same one the `*` menu is drawn from: a tag the
    # menu offered is a tag this resolves, and a tag it did not is refused. No
    # `resolve_worker` anywhere on this path — that is the function that falls
    # through to the DEFAULT worker for a domain it cannot serve, and its
    # fallthrough is the fabrication this whole feature is fenced against.
    live = await _tagged_specialists(req, deps)
    worker_id = live.get(tag)
    if worker_id is None:
        return await _refuse_tag(
            deps,
            tag,
            list(live),
            capability_reason=_tagged_unavailable_reason(req, tag),
        )

    worker = get_agent(worker_id)
    # The turn's ONE node, and it is the specialist — not a Main agent that
    # never ran. `MAIN_NODE_KEY` is the ROOT slot's key, not a claim about who
    # is in it: the UI files this loop's step events under it and draws a single
    # chip carrying this agent's own label.
    entry = _tagged_entry(worker, ask)
    # A COPY per emit. `stream_events` puts the event on a queue and serialises
    # it when the queue is drained, so emitting this dict by reference lets the
    # status flip below rewrite an event that was already sent: the roster would
    # read "done" from the instant the turn started, and no consumer could tell
    # a running specialist from a finished one.
    await _emit_tagged_start(deps, entry, worker)
    initial = _tagged_initial_state(
        req,
        worker,
        messages,
        ask=ask,
        write=write,
        small_model=small_model,
        run_max_rounds=run_max_rounds,
    )
    # This agent's OWN shape, the same one a delegation would have run.
    # Imported here, not at module scope: `graphs` composes these node functions.
    from .graphs import report_failure

    final = await _run_direct_specialist(worker, initial, deps, run_max_rounds)

    # The SAME rubric a delegated specialist's report is judged by (`report_
    # failure`, zero model calls), because the failure it catches is the same
    # one: "Done." after a round of tool calls, or the contract's own lines
    # filled with "nothing". Graded here the verdict drives both the chip and
    # the answer, so a green node cannot sit over `_fallback_answer`'s text.
    answer, status = _tagged_result(
        final,
        report_failed=report_failure(final),
        cancelled=deps.cancel.cancelled,
    )
    await _emit_tagged_completion(deps, entry, answer, status)
    return answer
