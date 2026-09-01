"""Mutation receipts and asynchronous transcription completion checks."""

from __future__ import annotations

import re
from typing import Any

from .agents import Flow, get_agent
from .graph import AgentState

def _needs_transcription_terminal_check(agent_id: str, attempted: set[str]) -> bool:
    """Return whether this turn needs its re-transcription receipt gate."""
    return agent_id == "media.transcribe" and "retranscribe_file" in attempted


def _receipt_check_result(
    state: AgentState, flow: Flow, attempted: set[str]
) -> dict[str, Any] | None:
    """Return a receipt repair/final result when this flow requires one."""
    if not _receipt_check_due(flow, attempted):
        return None
    events = list(state.get("tool_events", []))
    latest_mutation = _latest_receipt_mutation(events, flow.receipt_after)
    if _receipt_is_valid(events, latest_mutation, flow):
        return None
    return _missing_receipt_result(state, flow)


def _receipt_check_due(flow: Flow, attempted: set[str]) -> bool:
    """A receipt applies only after one of its protected mutations ran."""
    return bool(flow.receipt_after and attempted & set(flow.receipt_after))


def _latest_receipt_mutation(
    events: list[dict[str, Any]], receipt_after: tuple[str, ...]
) -> tuple[int, dict[str, Any]] | None:
    """Find the newest mutation whose later receipt may prove success."""
    mutation_names = set(receipt_after)
    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        if str(event.get("name") or "") in mutation_names:
            return index, event
    return None


def _receipt_is_valid(
    events: list[dict[str, Any]],
    latest_mutation: tuple[int, dict[str, Any]] | None,
    flow: Flow,
) -> bool:
    """Require the matching validation receipt after the latest mutation."""
    if latest_mutation is None:
        return False
    mutation_index, mutation = latest_mutation
    identities = _receipt_identities(mutation.get("arguments") or {})
    return _has_matching_receipt(events[mutation_index + 1 :], identities, flow)


def _receipt_identities(arguments: dict[str, Any]) -> set[str]:
    """Collect the names by which a workflow mutation can be tested."""
    identities: set[str] = set()
    _add_receipt_identity(identities, arguments, "name")
    _add_receipt_identity(identities, arguments, "name_or_id")
    return identities


def _add_receipt_identity(
    identities: set[str], arguments: dict[str, Any], key: str
) -> None:
    """Add a non-blank, case-insensitive workflow identity."""
    identity = str(arguments.get(key) or "").strip().casefold()
    if identity:
        identities.add(identity)


def _has_matching_receipt(
    events: list[dict[str, Any]], identities: set[str], flow: Flow
) -> bool:
    """Find a successful validator receipt for the mutated workflow."""
    for event in events:
        if str(event.get("name") or "") != flow.receipt_tool:
            continue
        if _receipt_matches_mutation(event, identities, flow.receipt_marker):
            return True
    return False


def _receipt_matches_mutation(
    event: dict[str, Any], identities: set[str], marker: str
) -> bool:
    """Match one receipt to its mutation identity and success marker."""
    if not _receipt_names_mutation(event, identities):
        return False
    return marker in str(event.get("result") or "")


def _receipt_names_mutation(event: dict[str, Any], identities: set[str]) -> bool:
    """Require the validator to name the workflow that was just mutated."""
    arguments = event.get("arguments") or {}
    tested = str(arguments.get("name_or_id") or "").strip().casefold()
    return tested in identities


def _missing_receipt_result(state: AgentState, flow: Flow) -> dict[str, Any]:
    """Ask for a receipt once, then report an honest deterministic status."""
    repairs = state.get("repairs", 0)
    offered = _offered_tool_names(state)
    if _receipt_repair_available(flow, offered, repairs):
        return {
            "repair_needed": True,
            "repairs": repairs + 1,
            "corrections": [*state.get("corrections", []), flow.receipt_missing],
        }
    # The validation tool was unavailable, declined twice, or returned only
    # VALIDATED:no. Replace any model-authored success claim with a
    # deterministic status derived from the missing receipt.
    return {
        "repair_needed": False,
        "final_text": (
            "DID: the workflow may have been saved as a draft. "
            f"MISSING: {flow.receipt_missing}"
        ),
    }


def _offered_tool_names(state: AgentState) -> set[Any]:
    """Return the tool names available for a one-round repair."""
    names: set[Any] = set()
    for tool in state.get("tools", []):
        names.add((tool.get("function") or {}).get("name"))
    return names


def _receipt_repair_available(flow: Flow, offered: set[Any], repairs: int) -> bool:
    """The repair round is usable only while its validator remains offered."""
    return flow.receipt_tool in offered and repairs < flow.repair_cap


def _failure_check_result(state: AgentState, flow: Flow) -> dict[str, Any]:
    """Spend a bounded repair pass when the last tool response still failed."""
    markers = flow.failure_markers
    cap = flow.repair_cap
    if not markers or cap <= 0:
        return {"repair_needed": False}
    if not _last_tool_has_failure_marker(state, markers):
        # The latest attempt came back clean — whatever earlier passes cost, the
        # thing works now, so stop.
        return {"repair_needed": False}
    return _failure_repair_result(state, cap)


def _last_tool_has_failure_marker(
    state: AgentState, markers: tuple[str, ...]
) -> bool:
    """Check the newest tool message, exactly as the repair contract requires."""
    last = _last_tool_content(state)
    return any(marker.lower() in last for marker in markers)


def _last_tool_content(state: AgentState) -> str:
    """Read the latest tool message, ignoring earlier tool failures."""
    for message in reversed(state.get("messages", [])):
        if message.get("role") == "tool":
            return (message.get("content") or "").lower()
    return ""


def _failure_repair_result(state: AgentState, cap: int) -> dict[str, Any]:
    """Produce the bounded response to a still-visible failure marker."""
    # A failure marker is still present. Spend a pass if one is left.
    #
    # This used to latch instead of count: the first line of the node was
    # `if state.get("checked"): return {"repaired": True}`, and the router
    # required `not repaired` — so the SECOND visit ended the gate no matter
    # what `repair_cap` said. Verified before the fix: scripts.run (cap 1),
    # skills.author (cap 2) and jobs.workflows (cap 2) produced byte-identical
    # runs. Two agents declared a budget of two and were silently given one.
    #
    # `checked` and `repaired` went on being written on every branch after the
    # counter replaced the latch, and nothing anywhere read either one (removed
    # 2026-08-01). `repairs` is the whole gate: it bounds the loop, and it is
    # what the visit count is measured against.
    repairs = state.get("repairs", 0)
    if repairs >= cap:
        # Out of passes. Report the failure honestly rather than loop — looping
        # a 4B on a broken script is how it starts inventing output.
        return {"repair_needed": False}
    return {"repair_needed": True, "repairs": repairs + 1}


_TRANSCRIPTION_TERMINAL_RE = re.compile(
    r"(?i)(?:\bcompleted?\b|\bterminal\b|\btranscript\s*:|\bno[ -]speech\b|"
    r"\bfailed?\b|\bfailure\b|\berror\b)"
)
_TRANSCRIPTION_JOB_RE = re.compile(
    r"(?i)\b(?:job(?:[_ -]?id)?|id)\s*[:=#]?\s*([A-Za-z0-9][A-Za-z0-9._:-]{2,127})"
)


def _check_transcription_terminal(state: AgentState) -> dict[str, Any]:
    """ARC-027: queued/running is not a completed re-transcription.

    ``retranscribe_file`` may return a terminal transcript itself, or enqueue a
    durable job. In the latter case the same worker now owns ``job_status`` and
    must inspect it. The gate is receipt-driven: model wording is not evidence,
    and an unknown bridge response fails closed as pending.
    """
    events = list(state.get("tool_events", []))
    target, job_id, terminal = _transcription_terminal_receipt(events)
    if terminal:
        return {"repair_needed": False}
    return _pending_transcription_result(state, target, job_id)


def _transcription_terminal_receipt(
    events: list[dict[str, Any]],
) -> tuple[str, str, bool]:
    """Read the latest re-transcription action and any receipt that proves it."""
    latest = _latest_transcription_action(events)
    if latest is None:
        return "the requested recording", "", False
    action_index, action = latest
    target = _transcription_target(action)
    result = str(action.get("result") or "")
    job_id = _transcription_job_id(result)
    if _is_terminal_transcription_result(result):
        return target, job_id, True
    return target, job_id, _has_terminal_transcription_status(
        events[action_index + 1 :], target, job_id
    )


def _latest_transcription_action(
    events: list[dict[str, Any]],
) -> tuple[int, dict[str, Any]] | None:
    """Find the latest action whose result this receipt gate must verify."""
    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        if str(event.get("name") or "") == "retranscribe_file":
            return index, event
    return None


def _transcription_target(action: dict[str, Any]) -> str:
    """Return the supplied recording name or the stable missing-receipt label."""
    arguments = action.get("arguments") or {}
    target = str(arguments.get("name") or "").strip()
    return target or "the requested recording"


def _transcription_job_id(result: str) -> str:
    """Extract and normalize a durable job identifier from one bridge reply."""
    match = _TRANSCRIPTION_JOB_RE.search(result)
    return match.group(1).rstrip(".,;)") if match else ""


def _is_terminal_transcription_result(result: str) -> bool:
    """Return whether a bridge reply names a terminal re-transcription state."""
    return bool(_TRANSCRIPTION_TERMINAL_RE.search(result))


def _has_terminal_transcription_status(
    events: list[dict[str, Any]], target: str, job_id: str
) -> bool:
    """Require a later job-status receipt for this action, not another job."""
    identities = _transcription_identities(target, job_id)
    for event in events:
        if str(event.get("name") or "") != "job_status":
            continue
        if _status_is_terminal_for_transcription(event, identities):
            return True
    return False


def _transcription_identities(target: str, job_id: str) -> set[str]:
    """Collect the file and durable-job names a status receipt may identify."""
    identities = {target.casefold()}
    if job_id:
        identities.add(job_id.casefold())
    return identities


def _status_is_terminal_for_transcription(
    event: dict[str, Any], identities: set[str]
) -> bool:
    """Match a status reply to this action before accepting its terminal state."""
    status = str(event.get("result") or "")
    if not _transcription_status_names_action(status, identities):
        return False
    return _is_terminal_transcription_result(status)


def _transcription_status_names_action(status: str, identities: set[str]) -> bool:
    """Keep an unrelated room-wide job status from satisfying this action."""
    folded = status.casefold()
    return any(identity in folded for identity in identities)


def _pending_transcription_result(
    state: AgentState, target: str, job_id: str
) -> dict[str, Any]:
    """Ask once for a status receipt, then replace a claim with honest pending text."""
    identity = _transcription_identity(target, job_id)
    repairs = state.get("repairs", 0)
    if _transcription_repair_available(state, repairs):
        return {
            "repair_needed": True,
            "repairs": repairs + 1,
            "corrections": [
                *state.get("corrections", []),
                f"Re-transcription for {identity} has no terminal receipt yet. "
                "Call job_status now; queued/running is not completion.",
            ],
        }
    return {
        "repair_needed": False,
        "final_text": (
            f"MISSING: re-transcription for {identity} is still pending; no "
            "completed transcript, no-speech result, or terminal failure receipt "
            "was returned."
        ),
    }


def _transcription_identity(target: str, job_id: str) -> str:
    """Prefer the durable job id in messages when the bridge supplied one."""
    return f"job {job_id}" if job_id else target


def _transcription_repair_available(state: AgentState, repairs: int) -> bool:
    """A status check is possible only while its tool and retry budget remain."""
    flow = get_agent("media.transcribe").flow
    return "job_status" in _offered_tool_names(state) and repairs < flow.repair_cap


def route_after_check(state: AgentState) -> str:
    """Repair while the result is still failing and passes remain.

    Reads ONE flag, set by `check_result`, which owns the whole decision — the
    router used to re-derive it from `repairs`/`repaired` and the two disagreed.
    """
    if state.get("cancelled", False):
        return "synthesize"
    return "call_model" if state.get("repair_needed", False) else "synthesize"


#: The note left where a screenshot's pixels used to be. Keeping the TURN but
#: dropping the payload preserves the conversation's shape — the model still
#: sees that it looked, and when — without re-paying for a stale view.
