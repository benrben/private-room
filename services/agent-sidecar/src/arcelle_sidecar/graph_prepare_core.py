"""Dependency and catalog selection for graph preparation."""

from __future__ import annotations

from .graph_runtime import ADVISOR_TOOL_NAMES as ADVISOR_TOOL_NAMES, AGENT_ROUND_BACKSTOP as AGENT_ROUND_BACKSTOP, AGENT_TOOL_NAMES as AGENT_TOOL_NAMES, ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS, AgentSpec as AgentSpec, Any as Any, Awaitable as Awaitable, BATCH_TOOL_NAME as BATCH_TOOL_NAME, CORE_TOOLS as CORE_TOOLS, Callable as Callable, ChatModel as ChatModel, DIRECT_SPECIALIST_NOTE as DIRECT_SPECIALIST_NOTE, DOMAIN_KEYS as DOMAIN_KEYS, DONE_TEXT as DONE_TEXT, EMPTY_PLAN_NOTE as EMPTY_PLAN_NOTE, Emit as Emit, Event as Event, GROUPS as GROUPS, IMAGE_HANDOFF as IMAGE_HANDOFF, MAIN_AGENT_ID as MAIN_AGENT_ID, MAIN_NODE_KEY as MAIN_NODE_KEY, McpClient as McpClient, Message as Message, NO_PROGRESS_ROUNDS as NO_PROGRESS_ROUNDS, NamedTuple as NamedTuple, PIXEL_RESULT_TOOLS as PIXEL_RESULT_TOOLS, READ_RESULT_TOOL as READ_RESULT_TOOL, ResultStore as ResultStore, RunRequest as RunRequest, RunnableConfig as RunnableConfig, SKILLS_NOTE as SKILLS_NOTE, SPILL_BYTES as SPILL_BYTES, TOOL_GROUPS_PROMPT as TOOL_GROUPS_PROMPT, TOOL_GROUP_LABELS as TOOL_GROUP_LABELS, ToolCall as ToolCall, ToolResult as ToolResult, TypedDict as TypedDict, _log as _log, agent_tool_specs as agent_tool_specs, assistant_message as assistant_message, asyncio as asyncio, build_plan as build_plan, build_usage_event as build_usage_event, byte_len as byte_len, categorize_messages as categorize_messages, cloud_privacy_tool_allowed as cloud_privacy_tool_allowed, correction_note as correction_note, dataclass as dataclass, delegation_note as delegation_note, duplicate_call_note as duplicate_call_note, field as field, get_agent as get_agent, group_prompt as group_prompt, group_servable as group_servable, group_tools as group_tools, is_nonlocal_model as is_nonlocal_model, is_static_visual_intent as is_static_visual_intent, is_visual_video_intent as is_visual_video_intent, json as json, json_chars as json_chars, lane_label as lane_label, logging as logging, main_prompt as main_prompt, normalize_domain_key as normalize_domain_key, re as re, reachable_domain_keys as reachable_domain_keys, read_spill as read_spill, replace as replace, request_tools_spec as request_tools_spec, resolve_worker as resolve_worker, specialist_workers as specialist_workers, spill_note as spill_note, sys as sys, tag_unavailable_answer as tag_unavailable_answer, tagged_specialist as tagged_specialist, tool_message as tool_message, tool_step_label as tool_step_label, toolbox_for as toolbox_for, turn_progress_note as turn_progress_note, unlocked_note as unlocked_note, user_message as user_message, weakref as weakref, with_read_result as with_read_result, worker_reachable as worker_reachable
from .graph_types import STUDIO_DEPS as STUDIO_DEPS, _pixel_checked_outcome as _pixel_checked_outcome, _room_identity_arguments as _room_identity_arguments, _required_pixel_tool as _required_pixel_tool, CancelToken as CancelToken, _NullSlot as _NullSlot, _TurnShared as _TurnShared, Deps as Deps, AgentState as AgentState

def _deps(config: RunnableConfig) -> Deps:
    deps = (config or {}).get("configurable", {}).get("deps")
    if isinstance(deps, Deps):
        return deps
    if STUDIO_DEPS is not None:  # pragma: no cover - dev-only path
        return STUDIO_DEPS
    raise RuntimeError("graph invoked without Deps in config.configurable")


def _select_tools(
    served_specs: list[dict[str, Any]],
    *,
    agent_id: str,
    unlocked: set[str],
    advisors: bool,
    plan_multi: bool = False,
) -> list[dict[str, Any]]:
    """The offered catalog: CORE + the active sub-agent's box + any groups
    unlocked mid-turn, intersected with what the bridge served (agents.py).

    Connected third-party MCP tools are namespaced ``server_tool`` and never
    collide with registry names, so a name the registry doesn't know is kept —
    the user connected those explicitly. ``consult_advisor`` is retained only
    when Rust says this is an enabled top-level run.

    ``plan_multi``: during a MULTI-step plan the connector proxy pair
    (search_mcp_tools/run_mcp_tool — always offered on single-step turns so
    an unrouted ask can still reach a connector) is withheld from steps whose
    agent doesn't own it. Live e2e caught the 4B jumping ahead: with the pair
    visible during the jobs step it sent to Slack BEFORE starting the pass —
    exactly the ordering "pending sequential execution" exists to prevent.
    The connectors step of the plan still gets its box.
    """
    served_names = {s.get("function", {}).get("name") for s in served_specs}
    keep = _selected_tool_names(agent_id, unlocked, served_names)
    hold = _held_plan_tools(plan_multi, keep)
    registry_names = ALL_REGISTRY_TOOLS | keep
    return [
        spec
        for spec in served_specs
        if _tool_is_visible(spec, keep, hold, registry_names, advisors)
    ]


def _selected_tool_names(
    agent_id: str, unlocked: set[str], served_names: set[str | None]
) -> set[str]:
    keep = toolbox_for(agent_id, served_names)
    for group in unlocked:
        keep |= group_tools(group) & served_names
    return keep


def _held_plan_tools(plan_multi: bool, keep: set[str]) -> set[str]:
    if not plan_multi:
        return set()
    return set(get_agent("connectors.use").tools) - keep


def _tool_is_visible(
    spec: dict[str, Any],
    keep: set[str],
    hold: set[str],
    registry_names: set[str],
    advisors: bool,
) -> bool:
    name = spec.get("function", {}).get("name")
    if name in ADVISOR_TOOL_NAMES:
        return advisors
    if name in hold:
        return False
    # Every name the registry owns — NOT just the grouped ones. Testing against
    # the grouped subset let ungrouped registry tools fall through the
    # third-party escape hatch and reach every agent.
    return name in keep or name not in registry_names


def _why(exc: BaseException) -> str:
    """A reason a person can read.

    ``str()`` on several httpx/asyncio errors is the EMPTY STRING, so every
    place that reports a failure by interpolating the exception could produce
    "failed:" with nothing after it — a line that is then handed to the Main
    agent and from there to the user. ``stream_events`` already solved this for
    the run-level error; the delegation paths interpolated raw and did not.
    """
    return str(exc) or type(exc).__name__


#: Exceptions whose message is already a whole sentence aimed at the user. For
#: everything else the class name is kept, because it is often the only clue
#: there is: bare ``'model'`` from a KeyError explains nothing, while
#: ``KeyError: 'model'`` at least says an internal lookup missed.
_SELF_EXPLAINING_ERRORS = ("ProviderApiError", "LlmError", "ToolError")


def _why_failed(exc: BaseException) -> str:
    """``_why`` for a failure shown in a UI, where jargon costs the reader.

    Prefixing every reason with its Python class turned a provider's own
    sentence into "ProviderApiError: …", which reads as an internal fault the
    user caused. The prefix is dropped only when the message stands alone.
    """
    name = type(exc).__name__
    reason = str(exc).strip()
    if not reason:
        return name
    return reason if name in _SELF_EXPLAINING_ERRORS else f"{name}: {reason}"


async def _list_tools(deps: Deps) -> list[Any]:
    """The bridge's catalog, with ONE retry and a sentence the user can act on.

    This is the FIRST thing every loop does, before any work — so a hiccup here
    costs nothing but the turn, and the turn used to end in whatever raw
    httpx/JSON-RPC text the exception carried, with no retry and no explanation.
    One retry covers the transient case. A second failure is reported as itself
    rather than swallowed, because continuing with an EMPTY catalog would be
    worse: an agent with no tools does not say so, it answers from memory.
    """
    if deps.mcp is None:
        return []
    try:
        return await deps.mcp.list_tools()
    except asyncio.CancelledError:
        raise
    except Exception as first:  # noqa: BLE001 - retried once, then reported
        try:
            return await deps.mcp.list_tools()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # BOTH reasons, and they are often different — "connection refused"
            # then "timed out" is the shape of a bridge coming down mid-turn.
            # Only the retry's reason goes in the sentence the user reads; the
            # first attempt's belongs in the log with the traceback.
            _log.error(
                "the room's tool catalog could not be loaded (first attempt: %s)",
                _why(first),
                exc_info=True,
            )
            raise RuntimeError(
                # `_why` falls back to the exception's class NAME, which is never
                # empty, so this used to read `_why(exc) or _why(first)` with a
                # second half that could not be reached.
                "this room's tools could not be loaded, so nothing could be "
                f"done safely: {_why(exc)}"
            ) from exc


def _locked_groups(
    served_names: set[str], current: set[str], unlocked: set[str], own: str = ""
) -> list[str]:
    """request_tools groups still locked AND actually servable this run (an
    advisor-scope bridge never serves ui tools — offering an unlockable group
    would teach the model to hallucinate).

    "Servable" is `agents.group_servable`, NOT "was any tool of this group
    served": on the cloud-CLI tier `app_ui` passes the any-one-of-them test on
    `view_media_frame` alone (a room video's pixels, served as CONTENT) while
    the three SCREEN tools stay local-only — so the group was still offered
    here, a round could be spent unlocking it, and `group_prompt` then briefed
    the model on ui_snapshot/ui_act. That is the failure `AgentSpec.requires`
    was added to kill, reached through this entrance instead.

    ``own`` is the asking agent's OWN group, and it is never offered. The hatch
    exists for a lane the keyword routers MISSED — a reader that turns out to
    need the jobs tools — not for widening an agent inside its own domain,
    where the box is a deliberate scope decision and a sibling already holds the
    rest. Without this, `skills.use` (read and run only, by its own paragraph)
    could unlock the `skills` group and reach save_skill and delete_skill; the
    Main agent routes an authoring ask to `skills.author` instead.
    """
    return [
        g
        for g in GROUPS
        if g not in unlocked
        and g != own
        and group_servable(g, served_names)
        and not (group_tools(g) <= current)
    ]


@dataclass(frozen=True, slots=True)
class _Preparation:
    """Inputs collected once at the start of a graph loop."""

    deps: Deps
    web_enabled: bool
    write: bool
    advisors: bool
    agent: AgentSpec
    no_tools: bool
    unlocked: set[str]
    plan_multi: bool


def _preparation_context(state: AgentState, config: RunnableConfig) -> _Preparation:
    return _Preparation(
        deps=_deps(config),
        web_enabled=bool(state.get("web_enabled", False)),
        write=bool(state.get("write", False)),
        advisors=bool(state.get("advisors", False)),
        agent=get_agent(str(state.get("agent_id", ""))),
        no_tools=state.get("tool_policy") == "none",
        unlocked=set(state.get("unlocked_groups", set())),
        plan_multi=bool(state.get("plan_multi", False)),
    )
