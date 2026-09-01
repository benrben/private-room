"""Claim verification and worker report nodes."""

from __future__ import annotations

import re
from typing import Any

from .agents import get_agent
from .graph import AgentState
from .prompts import with_read_result

WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "create_file",
        "edit_file",
        "edit_files",
        "write_file",
        "set_cells",
        "rename_file",
        "move_file",
        # A drawing is a versioned write to a room file, so "I drew it" is
        # audited exactly like "I saved it".
        "draw",
        "studio_flashcards",
        "studio_mindmap",
        "generate_podcast_script",
        # OUTBOUND effects, 2026-07-27. `run_mcp_tool` is how the Connector
        # agent sends email and Slack messages — the least reversible thing any
        # agent here does — and it ran under plain `react` with no gate of any
        # kind, so a send that FAILED was reported to the user as sent. It
        # belongs to the same predicate as a file write for the same reason: the
        # claim "I sent it" must be backed by evidence that something happened,
        # and `graph._referent_names` records the tool id on success only.
        "run_mcp_tool",
    }
)

CLAIM_UNSUPPORTED = (
    "write tools ran but no file or artifact was recorded — the write did not "
    "land, so do not tell the user anything was saved or changed."
)

STUDIO_TOOLS: frozenset[str] = frozenset(
    {"studio_flashcards", "studio_mindmap", "generate_podcast_script"}
)
ARTIFACT_READ_REQUIRED = (
    "the generator returned a commit receipt, but the new artifact has not been "
    "read back yet. Call open_file on the recorded artifact before claiming it "
    "was saved."
)


def _produced_artifact_names(state: AgentState) -> set[str]:
    names = (str(entry).split(": ", 1)[-1] for entry in state.get("produced", []))
    return {name for name in names if name}


def _event_name(event: dict[str, Any]) -> str:
    return str(event.get("name") or "")


def _latest_studio_commit(events: list[dict[str, Any]]) -> int | None:
    for index, event in reversed(list(enumerate(events))):
        if _event_name(event) in STUDIO_TOOLS:
            return index
    return None


def _opens_any_artifact(event: dict[str, Any], names: set[str]) -> bool:
    if _event_name(event) != "open_file":
        return False
    opened = str((event.get("arguments") or {}).get("name") or "")
    return opened in names


def _opened_after_commit(
    events: list[dict[str, Any]], commit_index: int, names: set[str]
) -> bool:
    return any(_opens_any_artifact(event, names) for event in events[commit_index + 1 :])


def _opened_produced_artifact(state: AgentState) -> bool:
    """Whether a successful ``open_file`` followed the latest Studio commit."""
    names = _produced_artifact_names(state)
    if not names:
        return False
    events = list(state.get("tool_events", []))
    latest_commit = _latest_studio_commit(events)
    if latest_commit is None:
        return False
    return _opened_after_commit(events, latest_commit, names)

#: The re-offer note `stage_catalog` leaves when the model skipped a stage.
#:
#: Unlike `CLAIM_UNSUPPORTED` — a fact about the turn, which stays true — this
#: one is an ORDER TO CALL A TOOL, and nothing in `corrections` expires on its
#: own: `graph.call_model` re-injects the whole list every round. So the chain's
#: closing round, which offers ZERO tools by design, still carried "call
#: fetch_page now", and a 4B answered "I will now fetch the page" instead of
#: writing the answer. One template, so the retirement below can recognise it.
STAGE_MISSED_NOTE = (
    "You have not called {tool} yet, and this task is not finished without it. "
    "Call it now, then answer from what it returns."
)


def _live_corrections(state: AgentState) -> list[str]:
    """The corrections still true — i.e. minus the tool orders already obeyed.

    Only :data:`STAGE_MISSED_NOTE` retires: it is the one correction that tells
    the model to CALL something, so calling it is what makes the note false. A
    ground-truth correction about what the tools DID stays in the list, because
    it stays true — the model has to restate its answer, not run anything.
    """
    obeyed = {STAGE_MISSED_NOTE.format(tool=t) for t in state.get("attempted", set())}
    return [c for c in state.get("corrections", []) if c not in obeyed]


def _without_tool_orders(state: AgentState) -> list[str]:
    """The corrections minus EVERY order to call something, obeyed or not.

    `_live_corrections` retires an order once the tool has been called, which is
    the right predicate while there are still tools to call. It is the wrong one
    for the tool-less round: the note exists precisely BECAUSE the tool was not
    called, so the single case that round has to be rid of is the one that
    survives that filter. Here the round itself makes every such order
    impossible, so all of them go — and only they do, because a ground-truth
    correction stays true with or without a catalog.

    The candidate set is exact: `stage_catalog` is the only writer of
    `STAGE_MISSED_NOTE` and only ever formats it with one of this agent's own
    stages.
    """
    stages = get_agent(state.get("agent_id", "")).flow.stages
    orders = {STAGE_MISSED_NOTE.format(tool=s) for s in stages}
    return [c for c in state.get("corrections", []) if c not in orders]


def narrowed(state: AgentState, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A narrowed catalog that still reads back what this loop parked.

    Every node here that returns a ``tools`` key goes through this. A shape that
    narrows rebuilds the catalog from the agent's box, and the spill reader is
    in no box — ``execute_tools`` mints it the moment a tool result is parked
    (:mod:`.results`). So a stage that narrowed after a spill retired the only
    route back to that text and left the model holding a head it could not
    extend. ``test_graphs.py`` pins the set of nodes that must call this.
    """
    return with_read_result(tools, list(state.get("spills", [])))


# --------------------------------------------------------------------------- #
# the report rubric — a worker's own state judging its own report
# --------------------------------------------------------------------------- #

#: A report the contract's own scaffolding empties out. `delegation_note` asks
#: for three fixed lines and tells the worker to write "nothing" where it has
#: nothing, so "DID: nothing / FOUND: nothing / MISSING: nothing" is a
#: well-formed report carrying zero information — and any check that measured
#: LENGTH would wave it through.
_CONTRACT_LABEL = re.compile(r"^(?:did|found|missing)\s*:\s*", re.IGNORECASE)

#: Values the contract itself supplies for "I have none of this".
_EMPTY_VALUES = frozenset({"nothing", "none", "n/a", "na", "-", "—", "null"})

#: An acknowledgement is not a report, however confidently it is worded. Matched
#: WHOLE rather than by length: a real one-line answer ("Whisper is installed")
#: is short too, and accusing that one would make every terse specialist look
#: failed — which is the failure mode this rubric is supposed to remove, not add.
_ACK_ONLY = re.compile(
    r"^(?:done|ok|okay|complete|completed|finished|sure|got it|"
    r"task\s+complete[d]?|all\s+done)[\s.!…]*$",
    re.IGNORECASE,
)

#: The three ways a finished worker can hand back nothing usable. Each is a
#: sentence completing "The <specialist> …", because that is how `_run_worker`
#: puts it into the Main agent's thread.
NO_REPORT = "finished but returned no report."
#: Names the tools, because the alternative is harsher than the evidence. A
#: worker that searched and genuinely found nothing writes the same empty
#: report as one that lost its results — and the Main agent, which decides
#: whether to re-dispatch, is the one that needs to tell them apart.
REPORT_SILENT = (
    "ran {tools} but reported nothing about what they returned — treat this "
    "step as unfinished."
)
REPORT_IDLE = (
    "neither called a tool nor answered from what it knows — treat this step as "
    "unfinished."
)

#: Prefix for the artifacts a worker created but never mentioned.
ARTIFACTS_NOTE = "Artifacts this step produced: "


def report_substance(text: str) -> str:
    """What a worker's report actually carries, contract scaffolding removed."""
    kept = []
    for line in text.splitlines():
        body = _CONTRACT_LABEL.sub("", line.strip()).strip()
        if not body or _ACK_ONLY.match(body) or body.lower().strip(".!") in _EMPTY_VALUES:
            continue
        kept.append(body)
    return " ".join(kept)


def report_failure(final: AgentState) -> str:
    """Why this finished worker's report carries nothing — ``""`` when it does.

    The rubric ``ok = bool(report_text)`` already was, generalised. It costs zero
    model calls for the same reason :func:`verify_claims` does: the worker's own
    final state records what actually ran, so nothing has to be asked.

    Deliberately NOT a correction round. `verify_claims` can afford one because
    it costs a single tool-less model call; re-running a specialist costs a whole
    child loop, and the Main agent — which is told the truth here and keeps its
    own catalog of specialists — is better placed to decide whether that is worth
    paying for than a rule that always pays.
    """
    said = str(final.get("final_text") or "")
    if report_substance(said):
        return ""
    if not said.strip():
        return NO_REPORT
    attempted = sorted(final.get("attempted", set()))
    if attempted:
        return REPORT_SILENT.format(tools=", ".join(attempted))
    return REPORT_IDLE


def worker_report(label: str, final: AgentState) -> tuple[str, bool]:
    """What one finished specialist hands the Main agent, and whether it counts.

    The text and the verdict are one decision: a report that failed the rubric
    is REPLACED (there was nothing in it to keep), while one that merely
    under-reported is kept and extended. Composed here rather than in
    `graph._run_worker` so every wording the hub can read sits beside the
    predicates that choose it.
    """
    failure = report_failure(final)
    if failure:
        return f"The {label} {failure}", False
    body = str(final.get("final_text") or "").strip()
    unnamed = unreported_artifacts(final)
    if unnamed:
        body = f"{body}\n{ARTIFACTS_NOTE}{', '.join(unnamed)}"
    return f"Report from the {label}:\n{body}", True


def unreported_artifacts(final: AgentState) -> list[str]:
    """Artifacts this worker created that its own report never names.

    The baton records ``create_file: notes.md`` on success only, so a report
    that never says ``notes.md`` is about to have the Main agent write the user
    an answer that contradicts what the room now holds. Appending the names is
    cheaper and truer than sending the worker back for a round — and it is the
    same evidence :func:`verify_claims` gates on, pointed the other way.
    """
    said = str(final.get("final_text") or "")
    names = (str(entry).split(": ", 1)[-1] for entry in final.get("produced", []))
    return [name for name in dict.fromkeys(names) if name and name not in said]


def _produced_artifact_label(state: AgentState) -> str:
    names = dict.fromkeys(
        str(entry).split(": ", 1)[-1] for entry in state.get("produced", [])
    )
    return ", ".join(names) or "the generated artifact"


def _unread_artifact_result(state: AgentState) -> dict[str, Any]:
    if _opened_produced_artifact(state):
        return {"corrected": True}
    names = _produced_artifact_label(state)
    return {
        "corrected": True,
        "final_text": (
            f"MISSING: Arcelle received a commit receipt for {names}, but "
            "could not read the artifact back, so I cannot confirm that it "
            "was saved."
        ),
    }


def _completed_verification_result(state: AgentState) -> dict[str, Any]:
    if ARTIFACT_READ_REQUIRED in state.get("corrections", []):
        return _unread_artifact_result(state)
    # Second visit: the model has had its correction round. Let it answer.
    return {"corrected": True}


def _correction_update(state: AgentState, correction: str, force_synthesis: bool) -> dict[str, Any]:
    progress: list[str] = list(state.get("progress", []))
    progress.append(f"[check] {correction}")
    return {
        "verified": True,
        "corrections": [correction],
        "progress": progress,
        "force_synthesis": force_synthesis,
    }


def _needs_studio_readback(state: AgentState, attempted: set[str], produced: list[str]) -> bool:
    return bool(attempted & STUDIO_TOOLS) and bool(produced) and not _opened_produced_artifact(state)


def _initial_verification_result(state: AgentState) -> dict[str, Any]:
    # PRODUCED, not `referents`. `referents` is the baton, and a delegated
    # worker is SEEDED with the Main agent's — so reading it here meant the gate
    # passed automatically for every delegation after the first, i.e. it was
    # disabled on exactly the multi-step asks it exists for ("summarize the
    # lease, THEN save the notes": the writing step is the unchecked one).
    # `produced` is seeded empty per loop, like `attempted`.
    produced: list[str] = list(state.get("produced", []))
    # ATTEMPTED, not `seen`. `seen` holds only SUCCESSFUL calls by design, so a
    # write that errored is absent from it — which made the first version of
    # this predicate unable to detect the exact case it was written for. A
    # `test_an_unsupported_write_claim_is_sent_back_for_restatement` failure is
    # what surfaced it.
    attempted: set[str] = set(state.get("attempted", set()))
    if _needs_studio_readback(state, attempted, produced):
        # Unlike an unsupported write, this correction needs open_file.
        return _correction_update(state, ARTIFACT_READ_REQUIRED, force_synthesis=False)
    if not (attempted & WRITE_TOOLS) or produced:
        return {"verified": True}
    # Keep the action log truthful too — it is what a resumed/inspected turn
    # reads — but the load-bearing half is `corrections`, which call_model
    # re-injects on EVERY engine. The correction round must restate rather than
    # retry the write; retrying is the user's call.
    return _correction_update(state, CLAIM_UNSUPPORTED, force_synthesis=True)


async def verify_claims(state: AgentState) -> dict[str, Any]:
    """Ground-truth gate for agents that mutate the user's room.

    A small model will happily report "I saved the summary to notes.md" after a
    write that errored. The referent baton already records what a tool actually
    produced, so the check costs zero model calls.

    It ROUTES; it does not annotate. The first draft returned ``{"progress":
    [...]}``, and `progress` has exactly one reader — ``call_model``'s ephemeral
    re-injection, gated on ``small_model`` — which by construction cannot run
    after this node, because ``verify`` sits between the loop's exit and
    ``synthesize``. So the finding was written into state and discarded: never
    sent to a model, never emitted, never in the transcript. The File agent's
    write-claim check did nothing at all. Self-RAG's "not supported" edge is the
    documented shape: a grounding failure is a routing decision.

    Termination is structural, not a counter. First visit sets ``verified`` and,
    on a finding, forces ONE tool-less round (``route_after_verify`` sends it
    back to ``call_model``). That round's only exit is back here, where
    ``verified`` is already set, so it marks ``corrected`` and falls through to
    ``synthesize``. At most one extra model call, and only when the check fires.
    """
    if state.get("verified", False):
        return _completed_verification_result(state)
    return _initial_verification_result(state)


def route_after_verify(state: AgentState) -> str:
    """A finding sends the answer back for ONE tool-less restatement."""
    if state.get("cancelled", False):
        return "synthesize"
    if state.get("corrections") and not state.get("corrected", False):
        return "call_model"
    return "synthesize"
