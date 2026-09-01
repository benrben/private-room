"""The round loop, as a LangGraph ``StateGraph`` (SPEC §3.2).

    START -> prepare -> call_model --(tools asked for)--> execute_tools --+
                            |                                   |         |
                            | (no calls / last / cancelled)     |         |
                            v                                   |         |
                        synthesize <---------(cancelled)--------+         |
                            |                                             |
                           END                    <-- next round ---------+

Every branch below is a product decision carried over from the Rust ``agent_loop``,
and each one exists because the naive version misbehaved on a 4B local model:

* **The final round offers ZERO tools.** Otherwise the loop's last act is a
  side-effect call whose result nobody ever reads, and the user gets no answer.
  A tool-less round forces a text answer grounded in the results already in hand.
* **Only SUCCESSFUL ROOM TOOL calls are memoised.** A failed one is not in
  ``seen``, so the model may re-attempt it in a LATER round — transient failures
  shouldn't be permanent. This is NOT a hard "one retry" cap: a call that keeps
  failing can be re-attempted once per round, bounded only by the runaway
  backstop, until synthesis. A DELEGATION is memoised either way
  (``_ToolPass._memoise_delegation``): re-running a specialist is a whole child
  loop rather than one call, and its outcome — empty report included — is
  already in the thread for the model to read.
* **An all-duplicate round forces synthesis.** If every call this round was an
  exact repeat, the model is looping; spending the remaining budget on repeats
  helps nobody, so the next round is the tool-less one.
* **Cancellation is checked between rounds AND between tool calls.** Stop must
  stop, not "stop after the next 90-second tool".
* **Captured pixels come back as a USER message.** Ollama reads images from user
  turns, not tool turns — attach them to a tool message and the model is blind.

2026-07-23, hub v3 owner decisions:

* **The MAIN AGENT delegates; workers act.** ``run_agent`` runs ONE loop: the
  Main agent's, whose whole catalog is its specialists (``ask_*_agent``, ≤6
  domain tools). ``execute_tools`` intercepts each delegation and runs that
  worker's own scoped sub-loop through this same graph; only the worker's
  REPORT joins the main thread. Things the Main agent knows (greetings,
  general knowledge) it answers directly — no delegation, no tools. Every
  delegation emitted in ONE round runs in PARALLEL: the whole batch is
  launched before any of it is awaited, and the reports are collected in call
  order, so a round costs the slowest child rather than the sum. The referent
  baton (``state["referents"]`` → ``delegation_note``) tells each worker what
  EARLIER rounds' specialists produced — siblings in one batch run blind to
  each other, and their batons are merged once the batch completes.
* **Sub-agents are DATA** (:mod:`.agents`): CORE (the base-prompt-taught
  read+write set — never filtered, or the catalog contradicts the prompt:
  "I can't save files") plus the active agent's ≤6-tool box.
* **request_tools is the escape hatch** for WORKERS whose lane vocabulary was
  missed. Resolved locally — never sent to the bridge.
* **Children are ad-hoc ``ainvoke``s inside this node, NOT subgraph nodes of the
  hub's compiled graph** (reviewed 2026-07-27). The docs' subagents page wires
  children as real subgraph nodes, and doing that here would let
  ``route_after_tools`` read a child's outcome directly instead of receiving it
  through a return tuple. It was NOT done, for a reason worth writing down: the
  worker a delegation resolves to is chosen at RUN TIME by ``resolve_worker``
  across fourteen agents and seven wirings, so making them nodes means either a
  node per worker in the hub graph or a ``Send`` fan-out whose target must be
  static — and either way ``execute_tools``, the one function every shape shares
  and where SPEC §3.2's invariants live, has to split. The two benefits are
  already covered another way: Studio sees every worker graph (``langgraph.json``
  registers all fourteen agents and all shapes by name), and the UI sees the live
  tree through the ``plan``/``agent`` events with per-node keys and batch numbers.
  What remains is internal tidiness, which is not worth destabilising the loop.
* **Small-local mode** (plain Ollama model, no provider/:cloud): rounds are
  capped to ONE tool call (FC mode is measurably unreliable on parallel calls),
  and the turn's verified action log is re-injected each round as an ephemeral
  USER note (a trailing system note silences qwen-class templates — the
  "Done." live-QA regression).
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from .agents import worker_reachable as worker_reachable
from .manager import resolve_worker as resolve_worker
from .messages import ToolCall as ToolCall
from .graph_types import _pixel_checked_outcome as _pixel_checked_outcome, _room_identity_arguments as _room_identity_arguments, VIDEO_FRAME_REQUIRED as VIDEO_FRAME_REQUIRED, VIDEO_FRAME_MISSING as VIDEO_FRAME_MISSING, PIXEL_EVIDENCE_MISSING as PIXEL_EVIDENCE_MISSING, _required_pixel_tool as _required_pixel_tool, ROUND_BUDGET_STEP as ROUND_BUDGET_STEP, PROGRESS_NOTE_LINES as PROGRESS_NOTE_LINES, PROGRESS_ELIDED as PROGRESS_ELIDED, NOTHING_TEXT as NOTHING_TEXT, NOTHING_USABLE_TEXT as NOTHING_USABLE_TEXT, CancelToken as CancelToken, _NullSlot as _NullSlot, _NULL_SLOT as _NULL_SLOT, _TurnShared as _TurnShared, Deps as Deps, AgentState as AgentState, STUDIO_DEPS as STUDIO_DEPS
from .graph_prepare_core import _deps as _deps, _select_tools as _select_tools, _selected_tool_names as _selected_tool_names, _held_plan_tools as _held_plan_tools, _tool_is_visible as _tool_is_visible, _why as _why, _SELF_EXPLAINING_ERRORS as _SELF_EXPLAINING_ERRORS, _why_failed as _why_failed, _list_tools as _list_tools, _locked_groups as _locked_groups, _Preparation as _Preparation, _preparation_context as _preparation_context
from .graph_prepare import _emit_worker_lane as _emit_worker_lane, _bridge_tools as _bridge_tools, _privacy_allowed_tools as _privacy_allowed_tools, _image_transportable_tools as _image_transportable_tools, _visible_bridge_tools as _visible_bridge_tools, _served_specs as _served_specs, _served_names as _served_names, _selected_tools as _selected_tools, _announce_missing_specialists as _announce_missing_specialists, _plan_for_preparation as _plan_for_preparation, _announce_plan as _announce_plan, _copied_messages as _copied_messages, _offered_tool_names as _offered_tool_names, _append_request_tools as _append_request_tools, _system_message as _system_message, _append_system_text as _append_system_text, _agent_paragraph as _agent_paragraph, _should_append_agent_paragraph as _should_append_agent_paragraph, _append_agent_paragraph as _append_agent_paragraph, _append_direct_specialist_note as _append_direct_specialist_note, _append_plan_note as _append_plan_note, _append_skills_note as _append_skills_note, _append_locked_groups_note as _append_locked_groups_note, _append_preparation_context as _append_preparation_context, _is_visual_instruction as _is_visual_instruction, _first_visual_instruction as _first_visual_instruction, _sole_unavailable_visual_instruction as _sole_unavailable_visual_instruction, _planned_visual_instruction as _planned_visual_instruction, _can_prepare_visual_evidence as _can_prepare_visual_evidence, _prepared_visual_calls as _prepared_visual_calls, _is_single_planned_step as _is_single_planned_step, _artifact_delegation_is_terminal as _artifact_delegation_is_terminal, _terminal_visual_evidence as _terminal_visual_evidence, _prepared_updates as _prepared_updates, prepare as prepare, _dedupe_hub_delegations as _dedupe_hub_delegations
from .graph_model import _ModelRound as _ModelRound, _ModelResponse as _ModelResponse, _PixelRequirement as _PixelRequirement, _announce_round_budget_exhaustion as _announce_round_budget_exhaustion, _is_last_model_round as _is_last_model_round, _model_round_context as _model_round_context, _shown_progress as _shown_progress, _progress_note as _progress_note, _correction_note as _correction_note, _messages_for_model as _messages_for_model, _stream_model_round as _stream_model_round, _emit_round_usage as _emit_round_usage, _deduplicated_hub_calls as _deduplicated_hub_calls, _terminal_visual_evidence_applies as _terminal_visual_evidence_applies, _terminal_visual_verdict as _terminal_visual_verdict, _terminal_visual_evidence_update as _terminal_visual_evidence_update, _pixel_requirement as _pixel_requirement, _pixel_correction as _pixel_correction, _matches_pixel_event as _matches_pixel_event, _successful_pixel_event as _successful_pixel_event, _failed_pixel_event as _failed_pixel_event, _has_pixel_evidence as _has_pixel_evidence, _pixel_failure_count as _pixel_failure_count, _pixel_missing_text as _pixel_missing_text, _should_stop_model_round as _should_stop_model_round, _pixel_failures_must_stop as _pixel_failures_must_stop, _needs_pixel_correction as _needs_pixel_correction, _can_retry_pixel_capture as _can_retry_pixel_capture, _without_pixel_correction as _without_pixel_correction, _model_update as _model_update, _pixel_correction_update as _pixel_correction_update, _normal_pixel_update as _normal_pixel_update, _visual_model_update as _visual_model_update, _call_model_update as _call_model_update, call_model as call_model
from .graph_tools import _run_one_tool as _run_one_tool, _args_summary as _args_summary, _unknown_group_note as _unknown_group_note, _own_group_note as _own_group_note, _unavailable_group_note as _unavailable_group_note, _unlocked_tool_specs as _unlocked_tool_specs, _starts_with_system_message as _starts_with_system_message, _append_group_prompt as _append_group_prompt, _unlock_group as _unlock_group, _active_step as _active_step, _emit_pipeline as _emit_pipeline, LEDGER_TOOLS as LEDGER_TOOLS, _POST_COMMIT_READ_TOOLS as _POST_COMMIT_READ_TOOLS, _ARTIFACT_RECEIPT as _ARTIFACT_RECEIPT, _ARTIFACT_RECEIPT_TOOLS as _ARTIFACT_RECEIPT_TOOLS, _nonempty_text as _nonempty_text, _valid_sha256 as _valid_sha256, _nonnegative_integer as _nonnegative_integer, _parsed_artifact_receipt as _parsed_artifact_receipt, _valid_artifact_receipt as _valid_artifact_receipt, _artifact_referent_names as _artifact_referent_names, _truncated_referent as _truncated_referent, _single_referent as _single_referent, _stripped_referent as _stripped_referent, _edit_referent as _edit_referent, _edit_referent_names as _edit_referent_names, _connector_referent_names as _connector_referent_names, _renamed_referent_names as _renamed_referent_names, _nonartifact_referent_names as _nonartifact_referent_names, _referent_names as _referent_names, _live_domains as _live_domains, _unavailable_note as _unavailable_note, _video_unavailable_note as _video_unavailable_note, MAX_SHOWN_REPORT_CHARS as MAX_SHOWN_REPORT_CHARS, _clip_report as _clip_report
from .graph_workers import WorkerOutcome as WorkerOutcome, _run_worker as _run_worker, _decoded_plan as _decoded_plan, _task_items as _task_items, _bare_plan_task as _bare_plan_task, _plan_instruction as _plan_instruction, _plan_agent as _plan_agent, _first_plan_dependencies as _first_plan_dependencies, _dependency_index as _dependency_index, _plan_dependencies as _plan_dependencies, _structured_plan_task as _structured_plan_task, _plan_task as _plan_task, parse_plan as parse_plan, _dependency_is_in_plan as _dependency_is_in_plan, _wave_dependencies as _wave_dependencies, _plan_dependencies_for_waves as _plan_dependencies_for_waves, _unfinished_task_positions as _unfinished_task_positions, _ready_wave as _ready_wave, _schedule_waves as _schedule_waves, plan_waves as plan_waves
from .graph_delegator import _Batch as _Batch, _Delegator as _Delegator
from .graph_toolpass_results import _ToolPassResultMixin as _ToolPassResultMixin
from .graph_toolpass import _ToolPass as _ToolPass
from .graph_actions import execute_tools as execute_tools, synthesize as synthesize, route_after_model as route_after_model, route_after_tools as route_after_tools, _fallback_report_line as _fallback_report_line, _fallback_reports as _fallback_reports, _fallback_report_answer as _fallback_report_answer, _fallback_without_reports as _fallback_without_reports, _fallback_answer as _fallback_answer, _refuse_tag as _refuse_tag, _tagged_tool_allowed as _tagged_tool_allowed, _tagged_specialists as _tagged_specialists, _tagged_unavailable_reason as _tagged_unavailable_reason, _tagged_entry as _tagged_entry, _emit_tagged_start as _emit_tagged_start, _tagged_initial_state as _tagged_initial_state, _run_direct_specialist as _run_direct_specialist, _tagged_result as _tagged_result, _emit_tagged_completion as _emit_tagged_completion, _run_tagged as _run_tagged
from .graph_run import _RunSettings as _RunSettings, _run_settings as _run_settings, _configure_turn_limits as _configure_turn_limits, _last_user_content as _last_user_content, _current_question_is_present as _current_question_is_present, _messages_for_current_question as _messages_for_current_question, _tagged_run_answer as _tagged_run_answer, _emit_main_start as _emit_main_start, _main_initial_state as _main_initial_state, _run_main_graph as _run_main_graph, _main_answer as _main_answer, run_agent as run_agent, _deep_harness_is_enabled as _deep_harness_is_enabled, _run_selected_deep_agent as _run_selected_deep_agent, _run_deep_or_classic_agent as _run_deep_or_classic_agent, _run_stream_request as _run_stream_request, _emit_torn_down_run as _emit_torn_down_run, _emit_stream_failure as _emit_stream_failure, stream_events as stream_events

# The run implementation deliberately computes only ``req.resolved_write()``;
# this facade note preserves the source-level architecture assertion.



#: Failures here are mirrored to `arcelle-sidecar.log` by the host
#: (`sidecar_lifecycle.rs::drain_stderr`). Nothing configures logging in this
#: process, so `logging.lastResort` carries ERROR to stderr — which is exactly
#: the stream the host drains. Do not log below ERROR from this module: it would
#: be dropped, and a log line nobody can read is worse than none.
_log = logging.getLogger("arcelle_sidecar.graph")

#: An event emitted to the Rust host (SPEC §4).
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


#: The Main agent's node identity in the turn's agent graph (see
#: ``AgentState.node_key``). Workers get ``"<agent_id>#<pipeline slot>"``; the
#: hub is a singleton, so it gets a fixed name the UI can root the graph on.
MAIN_NODE_KEY = "main"

#: Room tools whose successful result is raw pixels that must reach the model
#: through a real image channel. Metadata/text inspection tools stay available
#: to blind providers; these cannot honestly degrade to a text receipt.
PIXEL_RESULT_TOOLS = frozenset(
    {
        "view_media_frame",
        "view_screenshot",
        "view_file_image",
        "read_drawing",
        "browse_look",
    }
)


__all__ = [
    "AgentState",
    "CancelToken",
    "Deps",
    "Event",
    "call_model",
    "execute_tools",
    "prepare",
    "route_after_model",
    "route_after_tools",
    "run_agent",
    "stream_events",
    "synthesize",
]
