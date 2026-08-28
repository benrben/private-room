"""Per-agent graph shapes (owner decision 2026-07-25).

Until now all thirteen agents ran ONE compiled graph — ``graph.AGENT_GRAPH`` —
re-entered by hand from inside its own ``execute_tools``, with ``agent_id``
acting as a switch for which prompt and toolbox to load. That made every agent
structurally identical, which they are not:

* the **Studio agent** generates a document and answers. It has no reason to
  own a tool-calling cycle at all.
* the **File agent** writes to the user's room. Its claims ("I saved X") are
  worth checking against what actually happened before they reach the user.
* the **Main agent** dispatches. It never touches a room tool, so the branch
  that guards against it is structural noise in every other shape.

So agents get their own graphs. Not one per agent — templates are
SHARED wherever the work genuinely is the same (most workers really are a
plain tool-calling loop) and DISTINCT where it is not.

The invariant that makes this safe
----------------------------------
SPEC §3.2's guarantees — the tool-less final round, only-successful-room-calls
are memoised, an all-duplicate round forces synthesis, cancellation between
rounds AND between tool calls, a blank answer never read back as success — are
properties of the NODE FUNCTIONS in :mod:`.graph`, not of the wiring. Every
template below composes those same functions. A new template therefore cannot
quietly drop an invariant: to break one you would have to write a new node, not
draw a new edge. ``test_graphs.py`` pins this for every registered template.

Two mechanisms make all of this nearly free
-------------------------------------------
Every LangGraph doc snippet for these patterns reaches for
``with_structured_output`` — which does not exist anywhere here — or calls
``bind_tools`` at the GRAPH layer, which is not available at that layer either:
:class:`.chat.ChatModel` is a Protocol with ONE method, ``stream``. (The Ollama
implementation of that seam does call ``bind_tools`` internally, but a node
cannot: it hands over a tool list and gets text plus calls back.) Reaching for
the patterns literally would mean the langchain umbrella package plus an adapter
over both the Ollama seam and ``external_llm``'s CLI text protocol, and putting
SPEC §3.2's invariants inside a loop we no longer own. We need none of it,
because two affordances already in :mod:`.graph` implement the patterns:

1. **Narrowing the catalog IS structured output.** ``call_model`` offers exactly
   what is in ``state["tools"]``, so a node returning one spec makes the round a
   constrained single-schema call — the model no longer picks a tool, it only
   fills arguments. ``execute_tools`` already rewrites the catalog mid-run for
   ``request_tools``, so this is precedent, not invention.
2. **A synthesized tool call is a zero-model-call workflow step.**
   ``execute_tools`` runs whatever is in ``state["calls"]`` and does not care
   whether a model produced them, so a plain Python node fires a real bridge
   call for free — and still gets step events, cancellation between calls,
   successful-only memoisation, the progress log and the referent baton.

Shapes
------
``react``            prepare -> call_model <-> execute_tools -> synthesize
                     The classic loop. connectors.admin, media.video.
``supervisor``       the same cycle, but its tools are specialists and a guard
                     rejects room tools. The Main agent only.
``react_verify``     ...-> verify -> {restate | synthesize}
                     A ground-truth gate that ROUTES. files.read,
                     connectors.use (a failed SEND must not read as sent),
                     creator.draw (nor a drawing that was never drawn).
``route_act``        prepare -> route_action -> call_model <-> execute_tools
                     Deterministic verb pick (the Router pattern's rule-based
                     arm), then a bounded cycle for its arguments.
                     jobs.run, creator.studio.
``probe_gate_act``   prepare -> probe -> {blocked answer | act}
                     Prompt chaining with a deterministic gate.
                     media.transcribe.
``perceive_act``     prepare -> perceive -> trim_images -> act -> perceive...
                     WebVoyager's see-act loop, one live screenshot. app.ui,
                     chat.browse.
``chain_stage``      an ORDERED chain of one-tool stages. chat.web.
``recall_act_check`` free index prefetch, act, check the result, bounded
                     repair. scripts.run, skills.use, skills.author,
                     jobs.workflows.

Sharing is justified, not convenient: ``route_act`` serves two agents because
both are "pick one exclusive terminal verb, then spend the model only on
arguments", and ``recall_act_check`` serves four because all four load their own
prior art for free, act, and verify for free. They differ through ``Flow`` DATA
— ``repair_cap``, ``probe``, ``failure_markers`` — not through branches in a
node, so the differences stay testable.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

from .agents import MAIN_AGENT_ID, REGISTRY, get_agent
from .config import AGENT_ROUND_BACKSTOP
from .graph import (
    AgentState,
    call_model,
    execute_tools,
    prepare,
    route_after_model,
    route_after_tools,
    synthesize,
)
from .messages import Message, ToolCall
from .prompts import with_read_result

#: Every shape a registered agent may declare. `AgentSpec.template` is
#: validated against this at import time, so a typo is a startup error rather
#: than a silent fallback to the default loop.
TEMPLATES: tuple[str, ...] = (
    "react",
    "supervisor",
    "react_verify",
    "route_act",
    "probe_gate_act",
    "perceive_act",
    "chain_stage",
    "recall_act_check",
)


# --------------------------------------------------------------------------- #
# template-specific nodes
# --------------------------------------------------------------------------- #
#
# These take `(state)` and NOTHING ELSE. None of them needs the RunnableConfig:
# the run's `Deps` live in it, but only `.graph`'s nodes read them (`graph._deps`)
# — these work off `state` plus the agent registry. Every one of them used to
# declare a `config` parameter it never touched, which is a lie about what the
# node depends on and hides which nodes really do have dependencies.
#
# Do NOT "tidy" that into `_config`. LangGraph resolves the config by the
# parameter's LITERAL NAME (`_internal._runnable.KWARGS_CONFIG_KEYS`): rename it
# and it is no longer injected, so the node is called with one argument and
# raises `TypeError: missing 1 required positional argument: '_config'` on the
# first turn. Verified against langgraph 1.2.9 (2026-07-30) all three ways —
# `(state, config)` works, `(state)` works, `(state, _config)` fails at invoke.
# Dropping it is the supported form, not a trick: `RunnableCallable.__init__`
# injects only the kwargs the signature actually asks for, and `add_node` infers
# the input schema from the FIRST parameter's hint, which is unchanged.
#
# The nodes in `.graph` (prepare/call_model/execute_tools/synthesize) keep their
# `config` — that is that module's call, and it is not ours to change here.


#: Tools whose whole purpose is to leave an artifact behind. If one of these
#: ran and the referent baton recorded nothing, the model is about to describe
#: a write that did not land.
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


def _opened_produced_artifact(state: AgentState) -> bool:
    """Whether a successful ``open_file`` followed the latest Studio commit."""
    names = {
        str(entry).split(": ", 1)[-1]
        for entry in state.get("produced", [])
        if str(entry).split(": ", 1)[-1]
    }
    if not names:
        return False
    events = list(state.get("tool_events", []))
    latest_commit = next(
        (
            index
            for index, event in reversed(list(enumerate(events)))
            if str(event.get("name") or "") in STUDIO_TOOLS
        ),
        None,
    )
    if latest_commit is None:
        return False
    return any(
        str(event.get("name") or "") == "open_file"
        and str((event.get("arguments") or {}).get("name") or "") in names
        for event in events[latest_commit + 1 :]
    )

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
        if ARTIFACT_READ_REQUIRED in state.get("corrections", []):
            if _opened_produced_artifact(state):
                return {"corrected": True}
            names = ", ".join(
                dict.fromkeys(
                    str(entry).split(": ", 1)[-1]
                    for entry in state.get("produced", [])
                )
            ) or "the generated artifact"
            return {
                "corrected": True,
                "final_text": (
                    f"MISSING: Arcelle received a commit receipt for {names}, but "
                    "could not read the artifact back, so I cannot confirm that it "
                    "was saved."
                ),
            }
        # Second visit: the model has had its correction round. Let it answer.
        return {"corrected": True}

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
    if attempted & STUDIO_TOOLS and produced and not _opened_produced_artifact(state):
        progress: list[str] = list(state.get("progress", []))
        progress.append(f"[check] {ARTIFACT_READ_REQUIRED}")
        return {
            "verified": True,
            "corrections": [ARTIFACT_READ_REQUIRED],
            "progress": progress,
            # Unlike an unsupported write, this correction needs open_file.
            "force_synthesis": False,
        }
    if not (attempted & WRITE_TOOLS) or produced:
        return {"verified": True}

    # Keep the action log truthful too — it is what a resumed/inspected turn
    # reads — but the load-bearing half is `corrections`, which call_model
    # re-injects on EVERY engine.
    progress: list[str] = list(state.get("progress", []))
    progress.append(f"[check] {CLAIM_UNSUPPORTED}")
    return {
        "verified": True,
        "corrections": [CLAIM_UNSUPPORTED],
        "progress": progress,
        # The correction round offers zero tools: this is an answer to restate,
        # not a write to retry. Retrying the write is the user's call.
        "force_synthesis": True,
    }


def route_after_verify(state: AgentState) -> str:
    """A finding sends the answer back for ONE tool-less restatement."""
    if state.get("cancelled", False):
        return "synthesize"
    if state.get("corrections") and not state.get("corrected", False):
        return "call_model"
    return "synthesize"


async def probe(state: AgentState) -> dict[str, Any]:
    """Fire this agent's opening tool call WITHOUT spending a model round.

    ``execute_tools`` runs whatever is in ``state["calls"]``; it does not care
    whether a model produced them. So a plain Python node can fire a real
    bridge call for zero model cost and still get the full SPEC §3.2 treatment
    — step/step_status events, cancellation between calls, successful-only
    memoisation, the progress log, the referent baton.

    This is worth a node because for some agents the first move is a CONSTANT.
    ``TRANSCRIBE_PROMPT`` says "stt_status tells you whether the speech model is
    installed — check it before promising anything", so the model was paying a
    whole round to rediscover something the graph already knows.
    """
    spec = get_agent(state.get("agent_id", ""))
    name = spec.flow.probe
    if not name:
        return {}
    # Only if the bridge actually served it this run.
    if not any(
        (t.get("function") or {}).get("name") == name for t in state.get("tools", [])
    ):
        return {}
    # ...and only once the probe's PRECONDITION has been met. `chat.browse`
    # cannot snapshot a page before `browse_open` has made one; firing anyway
    # spent a guaranteed failure — journalled where the user reads it — as the
    # opening move of every browse task. See `Flow.probe_after`.
    after = spec.flow.probe_after
    if after and after not in set(state.get("attempted", set())):
        return {}
    # ...and not when that tool ran WITHOUT establishing the precondition.
    # `browse_open` with plain words searches instead of navigating, so it is
    # "attempted" with no page behind it. See `Flow.probe_unless`.
    if spec.flow.probe_unless:
        last = ""
        for msg in reversed(state.get("messages", [])):
            if msg.get("role") == "tool":
                last = (msg.get("content") or "").lower()
                break
        if any(marker.lower() in last for marker in spec.flow.probe_unless):
            return {}
    probe_call = ToolCall(name=name, arguments={})
    # A re-capture is the GRAPH's decision, not the model looping, so it must be
    # exempt from duplicate suppression. `ui_snapshot` takes no arguments, so
    # every capture has an identical `key()`; left in `seen`, the second
    # perceive is swallowed by the `key in seen` guard, `all_dup` stays true and
    # the turn is forced into synthesis after ONE action — the UI agent clicks
    # once and stops. Dropping just this key keeps the guard intact for every
    # call the MODEL makes, which is the behaviour it exists to catch.
    seen: set[str] = set(state.get("seen", set())) - {probe_call.key()}
    # NOTE: only keys declared on AgentState survive. Verified against langgraph
    # 1.2.9: a node returning an undeclared key has it silently DROPPED — no
    # exception, no warning. A stray `"probed": True` here read as if it
    # recorded something and recorded nothing.
    return {"calls": [probe_call], "seen": seen, "synth": True}


def route_after_probe_fired(state: AgentState) -> str:
    """Skip the tool node when the probe ABSTAINED.

    A probe abstains when the bridge did not serve its tool this run (web off,
    a capability the host does not expose). Running `execute_tools` on an empty
    call list is not a no-op: `all_dup` starts True and nothing clears it, so
    the node sets `force_synthesis` and the very next model round is offered
    ZERO tools. The agent would silently lose its whole catalog because an
    optional prefetch was unavailable.
    """
    return "tools" if state.get("calls") else "skip"


def route_after_probe(state: AgentState) -> str:
    """Read the probe's answer in Python and decide whether acting is possible.

    The gate is a pure predicate over the tool result the probe just produced.
    When the probe says the capability is missing, the honest answer is a fixed
    sentence — so the blocked path costs ZERO model calls where it costs two
    today.

    Fails OPEN. The blocker strings are matched against Rust-authored result
    text; if that wording drifts, the predicate must fall through to the normal
    path, so the worst case is exactly today's behaviour rather than an agent
    that refuses work it could do.
    """
    if state.get("cancelled", False):
        return "synthesize"
    spec = get_agent(state.get("agent_id", ""))
    blockers = spec.flow.blockers
    if not blockers:
        return "call_model"
    last = ""
    for msg in reversed(state.get("messages", [])):
        if msg.get("role") == "tool":
            last = (msg.get("content") or "").lower()
            break
    return "blocked" if any(b.lower() in last for b in blockers) else "call_model"


async def probe_answer(state: AgentState) -> dict[str, Any]:
    """The blocked answer, composed in code. No model call at all."""
    spec = get_agent(state.get("agent_id", ""))
    return {"final_text": spec.flow.blocked_answer, "stop": True}


async def stage_catalog(state: AgentState) -> dict[str, Any]:
    """Offer exactly the ONE tool this stage is for, then advance the stage.

    Prompt chaining, with the chain expressed as wiring instead of as English.
    ``WEB_PROMPT`` already dictates the order — "web_search to find pages, then
    fetch_page on the most promising result — a search snippet is not a source"
    — so by the docs' own definition this is a workflow, not an agent: the
    model does not choose the order, it only fills each step's arguments.

    Today the same order is a plea the model may ignore, and a 4B routinely
    answers from the search snippet without ever fetching. Staging the catalog
    makes the fetch structural.
    """
    spec = get_agent(state.get("agent_id", ""))
    stages = spec.flow.stages
    idx = state.get("stage", 0)
    # Narrow from the FULL box, never from the previous stage's narrowed view.
    # Reading `tools` here instead cost stage 2 its own verb: stage 1 had
    # already reduced the catalog to {web_search, …}, so `fetch_page` was gone
    # and the chain silently degraded into repeating its first stage.
    box: list[dict[str, Any]] = list(
        state.get("full_tools") or state.get("tools", [])
    )
    if idx >= len(stages):
        # Every stage was offered but the model SKIPPED one and tried to answer
        # (`route_after_stage_model` sent it back). Re-offer the missed verb and
        # say why — once, guarded by `stage_retried`. Without this the chain was
        # opt-out: chat.web answered from a search snippet, which its own prompt
        # calls "not a source", and nothing said otherwise.
        missed = [s for s in stages if s not in set(state.get("attempted", set()))]
        if not missed or state.get("stage_retried", False):
            return {"full_tools": box}
        want_again = missed[0]
        served_now = {(t.get("function") or {}).get("name") for t in box}
        if want_again not in served_now:
            return {"full_tools": box, "stage_retried": True}
        keep_again = set(spec.flow.keep) | {want_again}
        return {
            "tools": narrowed(
                state,
                [t for t in box if (t.get("function") or {}).get("name") in keep_again],
            ),
            "full_tools": box,
            "stage_retried": True,
            "corrections": [
                *_live_corrections(state),
                STAGE_MISSED_NOTE.format(tool=want_again),
            ],
        }
    want = stages[idx]
    served = {(t.get("function") or {}).get("name") for t in box}
    # Abstain rather than narrow to nothing — web tools are absent entirely
    # when the room has web disabled, and an empty catalog is a dead round.
    if want not in served:
        return {"stage": idx + 1, "full_tools": box}
    keep = set(spec.flow.keep) | {want}
    this_stage = [t for t in box if (t.get("function") or {}).get("name") in keep]
    return {"tools": narrowed(state, this_stage), "stage": idx + 1, "full_tools": box}


def _stage_re_offer_due(state: AgentState) -> bool:
    """A staged verb was never actually called, and the one re-offer is unspent.

    Read by BOTH stage routers, which is the point. `stage` counts stages
    OFFERED, and ANY tool call advances the chain: `chat.web` keeps
    `search_room` and the download verbs offered alongside every stage
    (`flow.keep`), so a round that searched the ROOM consumed the "search the
    web" stage — the chain moved on to `fetch_page`, `web_search` was never
    offered again, and the Web agent could finish a web task having never
    touched the web. Only the declined-stage exit checked for that, and the exit
    taken after a tool ran is the one that case takes.
    """
    stages = get_agent(state.get("agent_id", "")).flow.stages
    attempted: set[str] = set(state.get("attempted", set()))
    return any(s not in attempted for s in stages) and not state.get(
        "stage_retried", False
    )


def route_after_stage_model(state: AgentState) -> str:
    """A DECLINED stage must not end the chain.

    `route_after_model` sends any round with no tool calls straight to
    `synthesize`, and `call_model` sets `stop` whenever the model emitted no
    calls. On this shape that made the chain opt-out: chat.web could answer from
    a `web_search` snippet — which WEB_PROMPT itself calls "not a source" — by
    simply not calling `fetch_page` when stage 2 offered it. `stage_catalog`'s
    docstring says "staging the catalog makes the fetch structural"; until
    2026-07-27 the wiring made it a plea the model could ignore.

    Bounded by construction: `stage_catalog` increments `stage` on every visit
    (including when it abstains because the verb is not served), so a model that
    declines every stage walks the chain once and lands on synthesize.
    """
    if state.get("cancelled", False):
        return "synthesize"
    if state.get("calls"):
        return "execute_tools"
    if state.get("force_synthesis", False):
        # The forced tool-less answer round. Not a declined stage.
        return "synthesize"
    # Stages the model has not been OFFERED yet.
    if state.get("stage", 0) < len(get_agent(state.get("agent_id", "")).flow.stages):
        return "stage_catalog"
    # Every stage was offered, and the model answered without calling one of
    # them. That is the skip this shape exists to prevent, so re-offer the
    # missed verb ONCE — bounded by `stage_retried`, so a model that declines
    # twice gets to answer rather than looping.
    if _stage_re_offer_due(state):
        return "stage_catalog"
    return "synthesize"


def route_after_stage_tools(state: AgentState) -> str:
    """Advance to the next stage, or close the chain with the answer round."""
    if state.get("cancelled", False):
        return "synthesize"
    # The shared runaway backstop, NOT 0. Defaulting to 0 made this router fail
    # CLOSED on any state without `max_rounds` — one tool round and out — while
    # `graph.route_after_tools` defaults to the backstop and fails open. Two
    # routers disagreeing about the same missing key is a bug generator.
    if state.get("round", 0) >= state.get("max_rounds", AGENT_ROUND_BACKSTOP):
        return "synthesize"
    spec = get_agent(state.get("agent_id", ""))
    if state.get("stage", 0) < len(spec.flow.stages):
        return "stage_catalog"
    # Every stage was OFFERED, but a side tool spent one of them: `stage` counts
    # offers, and a `flow.keep` verb advances the chain exactly as the staged one
    # does. Same single re-offer the declined-stage exit gets
    # (`_stage_re_offer_due`) — without it the chain could close with its own
    # verb never called.
    if _stage_re_offer_due(state):
        return "stage_catalog"
    return "force_final"


async def check_result(state: AgentState) -> dict[str, Any]:
    """Read the last tool result for a failure the model should be shown.

    The code-assistant tutorial's own A/B is the reason this is a predicate and
    not a reflection call: feeding the RAW error back beat asking a model to
    reflect on it first, which is why the shipped default there is
    "do not reflect". So this node adds no model call — it decides whether the
    NEXT one is worth spending.

    `verify_claims` asks "did a write land?"; this asks "did the thing we ran
    actually work?" — a script whose traceback is sitting in the transcript
    while the agent reports success is the failure mode.
    """
    spec = get_agent(state.get("agent_id", ""))
    flow = spec.flow
    attempted = set(state.get("attempted", set()))
    if spec.id == "media.transcribe" and "retranscribe_file" in attempted:
        return _check_transcription_terminal(state)
    if flow.receipt_after and attempted & set(flow.receipt_after):
        events = list(state.get("tool_events", []))
        latest_mutation = next(
            (
                (index, event)
                for index, event in reversed(list(enumerate(events)))
                if str(event.get("name") or "") in set(flow.receipt_after)
            ),
            None,
        )
        receipt_valid = False
        if latest_mutation is not None:
            mutation_index, mutation = latest_mutation
            mutation_args = mutation.get("arguments") or {}
            # save_workflow identifies the new draft by `name`; update_workflow
            # addresses it by `name_or_id` and may also rename it.  A successful
            # test may use either the old id/name or the new name, but must name
            # this workflow and must occur AFTER the latest mutation.
            identities = {
                str(mutation_args.get(key) or "").strip().casefold()
                for key in ("name", "name_or_id")
                if str(mutation_args.get(key) or "").strip()
            }
            for event in events[mutation_index + 1 :]:
                if str(event.get("name") or "") != flow.receipt_tool:
                    continue
                args = event.get("arguments") or {}
                tested = str(args.get("name_or_id") or "").strip().casefold()
                if (
                    tested
                    and tested in identities
                    and flow.receipt_marker in str(event.get("result") or "")
                ):
                    receipt_valid = True
                    break
        if not receipt_valid:
            repairs = state.get("repairs", 0)
            offered = {
                (tool.get("function") or {}).get("name")
                for tool in state.get("tools", [])
            }
            if flow.receipt_tool in offered and repairs < flow.repair_cap:
                return {
                    "repair_needed": True,
                    "repairs": repairs + 1,
                    "corrections": [
                        *state.get("corrections", []),
                        flow.receipt_missing,
                    ],
                }
            # The validation tool was unavailable, declined twice, or returned
            # only VALIDATED:no.  Replace any model-authored success claim with
            # a deterministic status derived from the missing receipt.
            return {
                "repair_needed": False,
                "final_text": (
                    "DID: the workflow may have been saved as a draft. "
                    f"MISSING: {flow.receipt_missing}"
                ),
            }
    markers = flow.failure_markers
    cap = flow.repair_cap
    if not markers or cap <= 0:
        return {"repair_needed": False}

    last = ""
    for msg in reversed(state.get("messages", [])):
        if msg.get("role") == "tool":
            last = (msg.get("content") or "").lower()
            break
    if not any(m.lower() in last for m in markers):
        # The latest attempt came back clean — whatever earlier passes cost, the
        # thing works now, so stop.
        return {"repair_needed": False}

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
    latest = next(
        (
            (index, event)
            for index, event in reversed(list(enumerate(events)))
            if str(event.get("name") or "") == "retranscribe_file"
        ),
        None,
    )
    target = "the requested recording"
    job_id = ""
    terminal = False
    if latest is not None:
        action_index, action = latest
        args = action.get("arguments") or {}
        target = str(args.get("name") or target).strip() or target
        action_result = str(action.get("result") or "")
        terminal = bool(_TRANSCRIPTION_TERMINAL_RE.search(action_result))
        match = _TRANSCRIPTION_JOB_RE.search(action_result)
        if match:
            job_id = match.group(1).rstrip(".,;)")

        if not terminal:
            identities = {target.casefold()}
            if job_id:
                identities.add(job_id.casefold())
            for event in events[action_index + 1 :]:
                if str(event.get("name") or "") != "job_status":
                    continue
                status = str(event.get("result") or "")
                folded = status.casefold()
                # A room-wide status receipt must name the job/file whose
                # action is being verified. Otherwise an unrelated completed
                # job could satisfy this turn.
                if any(identity in folded for identity in identities) and (
                    _TRANSCRIPTION_TERMINAL_RE.search(status)
                ):
                    terminal = True
                    break
    if terminal:
        return {"repair_needed": False}

    flow = get_agent("media.transcribe").flow
    repairs = state.get("repairs", 0)
    offered = {
        (tool.get("function") or {}).get("name") for tool in state.get("tools", [])
    }
    if "job_status" in offered and repairs < flow.repair_cap:
        identity = f"job {job_id}" if job_id else target
        return {
            "repair_needed": True,
            "repairs": repairs + 1,
            "corrections": [
                *state.get("corrections", []),
                f"Re-transcription for {identity} has no terminal receipt yet. "
                "Call job_status now; queued/running is not completion.",
            ],
        }

    identity = f"job {job_id}" if job_id else target
    return {
        "repair_needed": False,
        "final_text": (
            f"MISSING: re-transcription for {identity} is still pending; no "
            "completed transcript, no-speech result, or terminal failure receipt "
            "was returned."
        ),
    }


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
STALE_IMAGE = "[earlier screenshot — superseded by the current one below]"


async def trim_images(state: AgentState) -> dict[str, Any]:
    """Keep ONE live screenshot in context; strip the pixels from the rest.

    WebVoyager's shipped answer to the same problem. Every capture lands as a
    user message carrying base64 pixels (``IMAGE_HANDOFF``), and under a plain
    tool-calling loop they ACCUMULATE — one per action — inside a
    payload-fitted ``num_ctx``. That is the context-shift failure class already
    diagnosed in this repo on 2026-07-23 (the Ollama 4k default window: big
    turns silently truncated, producing "Done." and fabrications).

    A stale screenshot is also actively misleading: it shows a UI state that no
    longer exists, and the model cannot tell which one is current from pixels
    alone. So the fix is not only cheaper, it is more correct.
    """
    messages: list[Message] = list(state.get("messages", []))
    bearing = [i for i, m in enumerate(messages) if m.get("images")]
    if len(bearing) <= 1:
        return {}
    trimmed = list(messages)
    for i in bearing[:-1]:
        stale = dict(trimmed[i])
        stale.pop("images", None)
        stale["content"] = STALE_IMAGE
        trimmed[i] = stale
    return {"messages": trimmed}


def route_after_perceive(state: AgentState) -> str:
    """Cancellation is checked here too — a perceive round is still a round."""
    if state.get("cancelled", False):
        return "synthesize"
    # The shared backstop, NOT 0 — see route_after_stage_tools. Failing closed
    # on a missing key ended a UI task after its first capture.
    if state.get("round", 0) >= state.get("max_rounds", AGENT_ROUND_BACKSTOP):
        return "synthesize"
    return "trim_images"


async def route_action(state: AgentState) -> dict[str, Any]:
    """Pick the one terminal verb this ask wants, in plain Python.

    LangGraph's Router pattern is explicitly "a single LLM call **or
    rule-based logic**", and rule-based is the reliable arm here: a
    deterministic pick is 100% reproducible where a 4B's is roughly 22% on a
    multi-turn agency round. Studio's three generators and the Jobs agent's two
    verbs are mutually exclusive, and the vocabulary that separates them is
    already written — it is the ``Action.hints`` tuple.

    Narrowing the catalog to ONE verb turns the round from "choose among ~21
    tools, then fill arguments" into "fill arguments", which is the single
    regime small models are measured frontier-grade at.

    Deliberately abstains. On a tie, or a zero score, it returns ``{}`` and the
    model sees the full box exactly as it does today. A router that guessed
    would be worse than no router: the other verbs are no longer in the catalog,
    so a wrong narrow is unrecoverable. Narrow only when it is unambiguous.
    """
    spec = get_agent(state.get("agent_id", ""))
    actions = spec.flow.actions
    if not actions:
        return {}

    ask = (state.get("question", "") or "").lower()
    scores = {a.tool: sum(1 for h in a.hints if h in ask) for a in actions}
    best = max(scores.values(), default=0)
    if best == 0:
        return {}
    winners = [t for t, n in scores.items() if n == best]
    if len(winners) != 1:
        return {}

    keep = set(spec.flow.keep) | {winners[0]}
    routed = [
        t
        for t in state.get("tools", [])
        if (t.get("function") or {}).get("name") in keep
    ]
    # Never narrow to nothing: if the bridge did not serve the routed verb this
    # run, the full box is strictly better than an empty catalog.
    if not any((t.get("function") or {}).get("name") == winners[0] for t in routed):
        return {}
    return {"tools": narrowed(state, routed), "routed": winners[0]}


# --------------------------------------------------------------------------- #
# shape builders
# --------------------------------------------------------------------------- #


def _react(g: StateGraph) -> StateGraph:
    """The tool-calling cycle shared by most workers."""
    g.add_node("prepare", prepare)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "synthesize"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


async def _force_final(state: AgentState) -> dict[str, Any]:
    """End the tool phase: the next model round is the tool-less one.

    ...and retire EVERY correction that ORDERED a tool call, because that round
    has no tools to obey it with. This node is the ONLY door from the chain's
    tool phase into its answer round, which is what makes it the right place:
    `stage_catalog` is not visited again once every stage has been offered.

    It used to filter with `_live_corrections`, which drops an order only once
    the tool HAS been called — and the order is raised only because it was NOT,
    so it survived in exactly the case this is here to fix: the model spends the
    re-offer round on a `flow.keep` side tool, `route_after_stage_tools` sends
    it here, and the tool-less answer round is still told "call web_search now".
    A 4B answers "I will now search the web" instead of writing the answer.

    `state` was formerly unread and kept only because LangGraph passes it
    positionally (a zero-argument node raises ``TypeError: takes 0 positional
    arguments but 1 was given`` at invoke time, verified against langgraph
    1.2.9). It is read now.
    """
    return {"force_synthesis": True, "corrections": _without_tool_orders(state)}


# `_oneshot` lived here and is DELETED (2026-07-25). It allowed EXACTLY ONE
# tool round, which was structurally wrong for two of its three users:
#
# * media.transcribe — TRANSCRIBE_PROMPT says "stt_status ... check it before
#   promising anything", so an agent that OBEYED its own prompt spent its only
#   round on the probe and could never reach retranscribe_file. The prompt and
#   the template contradicted each other.
# * jobs.run — same trap latent: open with job_status and the pass never starts.
# * creator.studio — not broken, but `route_act` does the job with the same
#   call count, a 3-tool catalog instead of ~21, and a free classifier.
#
# Its one good idea survives: `_force_final`, which closes the tool phase by
# making the NEXT model round tool-less rather than skipping the answer. The
# regression its docstring recorded (execute_tools wired straight to synthesize,
# dropping the round that turns tool RESULTS into a report) is still pinned, now
# against the shapes that inherit the pattern.


def _react_verify(g: StateGraph) -> StateGraph:
    """The cycle, plus a ground-truth check before the answer."""
    g.add_node("prepare", prepare)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("verify", verify_claims)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "verify",
        route_after_verify,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _route_act(g: StateGraph) -> StateGraph:
    """Deterministic verb pick, then a BOUNDED cycle to fill its arguments.

    A cycle, not `oneshot`'s single round: the routed verb usually needs a real
    filename, and "the contract" is not one. `flow.keep` leaves the resolvers
    (list_room_files / search_room) in the narrowed catalog so the model can
    look one up, which needs a round it can come back from. What stops it is
    the duplicate guard and the tool-less final round, not a round budget.
    """
    g.add_node("prepare", prepare)
    g.add_node("route_action", route_action)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("verify", verify_claims)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "route_action")
    g.add_edge("route_action", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "verify"},
    )
    g.add_conditional_edges(
        "verify",
        route_after_verify,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _probe_gate_act(g: StateGraph) -> StateGraph:
    """Probe deterministically, gate on the answer, then act.

    Prompt chaining with a deterministic gate — the docs' generate ->
    check -> {Pass/Fail} wiring, where the gate is plain Python. Replaces
    `oneshot` for media.transcribe, which under `oneshot` could not do its job:
    its prompt tells it to check `stt_status` first, and that consumed the only
    tool round it had.

    The gate is the PROBE and nothing else. This shape used to ALSO cap the act
    phase at one model-driven tool round (`force_final` on the execute_tools
    back-edge), which reintroduced `oneshot`'s bug one level up — see the
    comment on that edge. The act phase is now an ordinary bounded cycle.

    Costs ONE FEWER model call than `react` on the happy path (the probe is
    free) and TWO fewer on the blocked path, which reaches no model at all.
    """
    g.add_node("prepare", prepare)
    g.add_node("probe", probe)
    g.add_node("probe_tools", execute_tools)
    g.add_node("probe_answer", probe_answer)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("check", check_result)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "probe")
    g.add_conditional_edges(
        "probe",
        route_after_probe_fired,
        {"tools": "probe_tools", "skip": "call_model"},
    )
    g.add_conditional_edges(
        "probe_tools",
        route_after_probe,
        {
            "call_model": "call_model",
            "blocked": "probe_answer",
            "synthesize": "synthesize",
        },
    )
    g.add_edge("probe_answer", "synthesize")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "check"},
    )
    # The gate is the PROBE, not the round count. `force_final` used to sit on
    # this edge and made every model-driven tool round the last one, which
    # recreated the exact contradiction `oneshot` was deleted for, one level up:
    # media.transcribe's prompt tells it to resolve a file name first, so a run
    # that opened with `list_room_files` spent its only round looking and ended
    # with the file FOUND and never transcribed — reported to the user as done.
    # It also made `request_tools` unreachable in this shape, since unlocking a
    # lane costs the round that would have used it. The ordinary react back-edge
    # still guarantees a model round after tools (pinned structurally by
    # test_a_tool_round_is_always_followed_by_a_model_round), so nothing that
    # `force_final` was defending here is lost.
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "check",
        route_after_check,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _perceive_act(g: StateGraph) -> StateGraph:
    """See, then act — the WebVoyager loop, for the agent that drives the app.

    The biggest structural win in the roster. Today a UI task costs TWO model
    rounds per action: one to ask for `ui_snapshot`, one to decide what to
    click. But the snapshot is not a decision — UI_PROMPT already says "Take a
    fresh ui_snapshot before each ui_act", so the order is prescribed and the
    model was paying to rediscover it. Firing the capture deterministically
    halves the rounds, and `trim_images` keeps exactly one live screenshot in
    context instead of one per action.

    The critic is the next screenshot (the CUA doctrine), which is why this
    shape has no `verify` node: for a pixel agent the following capture IS the
    verification, and it is free.
    """
    g.add_node("prepare", prepare)
    g.add_node("perceive", probe)
    g.add_node("perceive_tools", execute_tools)
    g.add_node("trim_images", trim_images)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "perceive")
    g.add_conditional_edges(
        "perceive",
        route_after_probe_fired,
        {"tools": "perceive_tools", "skip": "call_model"},
    )
    g.add_conditional_edges(
        "perceive_tools",
        route_after_perceive,
        {"trim_images": "trim_images", "synthesize": "synthesize"},
    )
    g.add_edge("trim_images", "call_model")
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "synthesize"},
    )
    # ...and back around to a FRESH capture, not straight to the model: acting
    # without re-perceiving is how a UI agent clicks a control that moved.
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "perceive", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


def _chain_stage(g: StateGraph) -> StateGraph:
    """A fixed chain of one-tool stages, then the grounded answer.

    Each stage offers ONE verb, so the round is "fill arguments" rather than
    "choose among ~20 tools, then fill arguments" — the single regime a 4B is
    measured frontier-grade at. Bounded by construction: the number of stages,
    plus the tool-less answer round.
    """
    g.add_node("prepare", prepare)
    g.add_node("stage_catalog", stage_catalog)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("force_final", _force_final)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "stage_catalog")
    g.add_edge("stage_catalog", "call_model")
    # NOT `route_after_model`: skipping a stage must re-offer the next verb, not
    # exit the chain. See `route_after_stage_model`.
    g.add_conditional_edges(
        "call_model",
        route_after_stage_model,
        {
            "execute_tools": "execute_tools",
            "stage_catalog": "stage_catalog",
            "synthesize": "synthesize",
        },
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_stage_tools,
        {
            "stage_catalog": "stage_catalog",
            "force_final": "force_final",
            "synthesize": "synthesize",
        },
    )
    g.add_edge("force_final", "call_model")
    g.add_edge("synthesize", END)
    return g


def _recall_act_check(g: StateGraph) -> StateGraph:
    """Load this agent's own prior art for free, act, check the result, repair.

    Episodic-memory retrieval (USACO) in front of the loop, plus a bounded
    generate -> check -> retry. The retrieval half is the cheap win: for all
    four users the FIRST move is an index call — `list_scripts`, `list_skills`,
    `list_workflows` — which is a constant, so paying a model round to
    rediscover it is waste. Firing it deterministically also doubles as the
    few-shot: existing skills and workflows are worked examples, which small
    models follow far better than schema prose.

    The check half is bounded by `flow.repair_cap`, and is DATA per agent:
    `skills.use` gets 0 (a skill that fails is the author's problem, and
    looping a 4B on someone else's script invents output), while
    `skills.author` gets a real budget because repairing its own draft is the
    job.
    """
    g.add_node("prepare", prepare)
    g.add_node("recall", probe)
    g.add_node("recall_tools", execute_tools)
    g.add_node("call_model", call_model)
    g.add_node("execute_tools", execute_tools)
    g.add_node("check", check_result)
    g.add_node("synthesize", synthesize)

    g.add_edge(START, "prepare")
    g.add_edge("prepare", "recall")
    g.add_conditional_edges(
        "recall",
        route_after_probe_fired,
        {"tools": "recall_tools", "skip": "call_model"},
    )
    g.add_edge("recall_tools", "call_model")
    # BOTH exits from the loop go through `check`, exactly as `_react_verify`
    # routes both of its exits through `verify`. Sending only `execute_tools`'s
    # exit there left the gate unreachable on the ordinary path — a model that
    # answers with no further calls leaves via `call_model`, which is what
    # happens on every successful run — so the gate ran only when the round
    # budget was exhausted or the turn was cancelled.
    g.add_conditional_edges(
        "call_model",
        route_after_model,
        {"execute_tools": "execute_tools", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "execute_tools",
        route_after_tools,
        {"call_model": "call_model", "synthesize": "check"},
    )
    g.add_conditional_edges(
        "check",
        route_after_check,
        {"call_model": "call_model", "synthesize": "synthesize"},
    )
    g.add_edge("synthesize", END)
    return g


#: shape name -> builder. `supervisor` shares `react`'s wiring: the Main agent's
#: difference is its CATALOG (specialists, not room tools) and the hub guard in
#: `execute_tools`, both of which are already keyed off `agent_id`. Kept as a
#: separate name so the roster reads truthfully and so the two can diverge
#: without touching every worker.
_BUILDERS: dict[str, Callable[[StateGraph], StateGraph]] = {
    "react": _react,
    "supervisor": _react,
    "route_act": _route_act,
    "probe_gate_act": _probe_gate_act,
    "perceive_act": _perceive_act,
    "chain_stage": _chain_stage,
    "recall_act_check": _recall_act_check,
    "react_verify": _react_verify,
}


def build_agent_graph(template: str) -> Any:
    """Compile one shape. Pure: no model, no bridge, no I/O bound in.

    NO CHECKPOINTER, deliberately (reviewed 2026-07-27). Both LangChain
    multi-agent references treat `.compile(checkpointer=…)` as the mechanism —
    langgraph-swarm's whole "remembers the last active agent" claim is one state
    key plus a saver — so its absence is a real difference and worth stating.

    An in-memory saver would buy nothing here and cost something: the sidecar is
    a long-lived process, so every turn's full state (including file content
    pulled into context) would be retained for the process lifetime with no
    reader, since there is no resume entry point. A DISK saver is the version
    that would actually survive a crash, and that one is a privacy decision, not
    an engineering one — it writes the user's room content outside the room, and
    SPEC §6 says content does not leave the box without an explicit seam. That
    is the owner's call to make, not a default to slip in.

    The user-visible harm it was proposed against — "Stop throws away completed
    work" — is handled where it actually occurs: `run_agent` composes a partial
    answer from the findings baton when Stop lands before the hub does.
    """
    if template not in _BUILDERS:
        raise ValueError(f"unknown agent graph template: {template!r}")
    return _BUILDERS[template](StateGraph(AgentState)).compile()


def _compile_shapes() -> dict[str, Any]:
    """Compile once per distinct WIRING, not once per template NAME.

    `react` and `supervisor` are the same builder — the Main agent differs from
    a worker through its CATALOG and its prompt (`prepare` branches on
    `agent.main`), not through its topology. Compiling the name twice produced
    two structurally identical graph objects, which is precisely the shape of
    the bug already killed once here: `build_graph()`/`AGENT_GRAPH` was a second
    compiled copy of `_react`, `run_agent` invoked it instead of the agent's
    declared template, and because the two wirings were identical NOTHING
    failed until an agent's shape actually diverged.

    Keying on the builder closes that off by construction: two names that mean
    the same wiring can never drift into two objects, and a name that gets a
    genuinely different builder automatically gets its own.
    """
    by_builder: dict[Any, Any] = {}
    out: dict[str, Any] = {}
    for name in TEMPLATES:
        builder = _BUILDERS[name]
        if builder not in by_builder:
            by_builder[builder] = build_agent_graph(name)
        out[name] = by_builder[builder]
    return out


#: Compiled once per WIRING, not per agent and not per template name — fourteen
#: agents, eight template names, seven distinct graphs.
_COMPILED: dict[str, Any] = _compile_shapes()


#: Distinct nodes per shape, used to size the recursion limit. Derived from the
#: compiled graph rather than hand-maintained, so a new shape cannot forget it.
_SHAPE_NODES: dict[str, int] = {
    name: len([n for n in _COMPILED[name].get_graph().nodes if not n.startswith("__")])
    for name in TEMPLATES
}


def recursion_limit_for(agent_id: str, max_rounds: int) -> int:
    """LangGraph counts SUPERSTEPS; this loop counts ROUNDS. They are not 1:1.

    The limit was `2 * max_rounds + 10` everywhere, a ratio that only holds for
    the two-node shapes (`call_model` -> `execute_tools`). `perceive_act` spends
    FIVE supersteps per two round increments — perceive, perceive_tools,
    trim_images, call_model, execute_tools, with both tool nodes bumping
    `round` — so a runaway `app.ui` worker hit `GraphRecursionError` at roughly
    round 8,000 instead of the backstop it was supposed to stop at, i.e. it
    crashed where it was meant to answer.

    Sized off the shape's own node count: a single round cannot traverse more
    distinct nodes than the shape has, so this can never under-provision, and
    over-provisioning costs nothing — this is a runaway guard, not a budget.
    """
    per_round = _SHAPE_NODES.get(get_agent(agent_id).template, 2)
    return per_round * max(1, max_rounds) + 10


def graph_for(agent_id: str) -> Any:
    """The compiled graph this agent runs."""
    return _COMPILED[get_agent(agent_id).template]


def template_for(agent_id: str) -> str:
    """The shape name this agent runs (for roster events and Studio)."""
    return get_agent(agent_id).template


#: The graph `run_agent` drives — the MAIN agent's declared shape, and the only
#: entry point. `graph.build_graph()`/`AGENT_GRAPH` used to be a second compiled
#: copy of `_react` that `run_agent` invoked instead, so the main agent silently
#: did not run the template it declares. Studio and devtools load this name.
MAIN_GRAPH: Any = graph_for(MAIN_AGENT_ID)


# Fail at import, not at the first delegation, if a spec names a shape that
# does not exist.
for _spec in REGISTRY:
    if _spec.template not in TEMPLATES:  # pragma: no cover - import-time guard
        raise ValueError(
            f"agent {_spec.id!r} declares unknown template {_spec.template!r}; "
            f"known: {', '.join(TEMPLATES)}"
        )


# --------------------------------------------------------------------------- #
# Studio entry points
# --------------------------------------------------------------------------- #
#
# `langgraph.json` needs a module-level NAME per graph it lists, so the roster
# is spelled out here rather than generated into `globals()` — an explicit name
# is greppable, survives a rename, and shows up in an editor's completion.
#
# Several of these deliberately resolve to the SAME compiled object: the
# roster runs fewer shapes than it has agents. That is not duplication to be
# cleaned up, it is the
# roster telling the truth — `test_agents_sharing_a_template_share_one_compiled_graph`
# pins that a shape is compiled exactly once no matter how many agents declare it.

GRAPH_CHAT_ANSWER = graph_for("chat.answer")
GRAPH_FILES_READ = graph_for("files.read")
GRAPH_CHAT_WEB = graph_for("chat.web")
GRAPH_CHAT_BROWSE = graph_for("chat.browse")
GRAPH_APP_UI = graph_for("app.ui")
GRAPH_JOBS_RUN = graph_for("jobs.run")
GRAPH_JOBS_WORKFLOWS = graph_for("jobs.workflows")
GRAPH_SCRIPTS_RUN = graph_for("scripts.run")
GRAPH_SKILLS_USE = graph_for("skills.use")
GRAPH_SKILLS_AUTHOR = graph_for("skills.author")
GRAPH_CONNECTORS_USE = graph_for("connectors.use")
GRAPH_CONNECTORS_ADMIN = graph_for("connectors.admin")
GRAPH_MEDIA_TRANSCRIBE = graph_for("media.transcribe")
GRAPH_MEDIA_VIDEO = graph_for("media.video")
GRAPH_CREATOR_STUDIO = graph_for("creator.studio")
GRAPH_CREATOR_DRAW = graph_for("creator.draw")

#: One per SHAPE, for looking at a template without picking an agent that runs it.
TEMPLATE_REACT = _COMPILED["react"]
TEMPLATE_SUPERVISOR = _COMPILED["supervisor"]
TEMPLATE_REACT_VERIFY = _COMPILED["react_verify"]
TEMPLATE_ROUTE_ACT = _COMPILED["route_act"]
TEMPLATE_PROBE_GATE_ACT = _COMPILED["probe_gate_act"]
TEMPLATE_PERCEIVE_ACT = _COMPILED["perceive_act"]
TEMPLATE_CHAIN_STAGE = _COMPILED["chain_stage"]
TEMPLATE_RECALL_ACT_CHECK = _COMPILED["recall_act_check"]


__all__ = [
    "MAIN_GRAPH",
    "TEMPLATES",
    "build_agent_graph",
    "graph_for",
    "probe",
    "route_action",
    "route_after_perceive",
    "check_result",
    "stage_catalog",
    "route_after_probe",
    "route_after_probe_fired",
    "route_after_verify",
    "template_for",
    "trim_images",
    "verify_claims",
]
