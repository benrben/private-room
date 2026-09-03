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
                     creator.draw (nor a drawing that was never drawn),
                     app.design (nor a skin change that did not land).
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

from typing import Any

from langgraph.graph import StateGraph

from .agents import MAIN_AGENT_ID, REGISTRY, Flow, get_agent
from .graph import (
    AgentState,
)
from .graph_shapes import _BUILDERS
from . import graphs_probe as _probe_nodes
from . import graphs_receipts as _receipt_nodes
from . import graphs_route as _route_nodes
from . import graphs_verify as _verify_nodes
WRITE_TOOLS = _verify_nodes.WRITE_TOOLS
CLAIM_UNSUPPORTED = _verify_nodes.CLAIM_UNSUPPORTED
STUDIO_TOOLS = _verify_nodes.STUDIO_TOOLS
ARTIFACT_READ_REQUIRED = _verify_nodes.ARTIFACT_READ_REQUIRED
_produced_artifact_names = _verify_nodes._produced_artifact_names
_event_name = _verify_nodes._event_name
_latest_studio_commit = _verify_nodes._latest_studio_commit
_opens_any_artifact = _verify_nodes._opens_any_artifact
_opened_after_commit = _verify_nodes._opened_after_commit
_opened_produced_artifact = _verify_nodes._opened_produced_artifact
STAGE_MISSED_NOTE = _verify_nodes.STAGE_MISSED_NOTE
_live_corrections = _verify_nodes._live_corrections
_without_tool_orders = _verify_nodes._without_tool_orders
narrowed = _verify_nodes.narrowed
_CONTRACT_LABEL = _verify_nodes._CONTRACT_LABEL
_EMPTY_VALUES = _verify_nodes._EMPTY_VALUES
_ACK_ONLY = _verify_nodes._ACK_ONLY
NO_REPORT = _verify_nodes.NO_REPORT
REPORT_SILENT = _verify_nodes.REPORT_SILENT
REPORT_IDLE = _verify_nodes.REPORT_IDLE
ARTIFACTS_NOTE = _verify_nodes.ARTIFACTS_NOTE
report_substance = _verify_nodes.report_substance
report_failure = _verify_nodes.report_failure
worker_report = _verify_nodes.worker_report
unreported_artifacts = _verify_nodes.unreported_artifacts
_produced_artifact_label = _verify_nodes._produced_artifact_label
_unread_artifact_result = _verify_nodes._unread_artifact_result
_completed_verification_result = _verify_nodes._completed_verification_result
_correction_update = _verify_nodes._correction_update
_needs_studio_readback = _verify_nodes._needs_studio_readback
_initial_verification_result = _verify_nodes._initial_verification_result
verify_claims = _verify_nodes.verify_claims
route_after_verify = _verify_nodes.route_after_verify
_tool_is_served = _probe_nodes._tool_is_served
_probe_precondition_is_met = _probe_nodes._probe_precondition_is_met
_last_tool_text = _probe_nodes._last_tool_text
_probe_precondition_failed = _probe_nodes._probe_precondition_failed
_probe_is_ready = _probe_nodes._probe_is_ready
probe = _probe_nodes.probe
route_after_probe_fired = _probe_nodes.route_after_probe_fired
_probe_is_blocked = _probe_nodes._probe_is_blocked
route_after_probe = _probe_nodes.route_after_probe
probe_answer = _probe_nodes.probe_answer
stage_catalog = _probe_nodes.stage_catalog
_stage_catalog_box = _probe_nodes._stage_catalog_box
def _completed_stage_catalog(
    state: AgentState, flow: Flow, box: list[dict[str, Any]]
) -> dict[str, Any]:
    """Re-offer one skipped stage, or restore the complete catalog to answer."""
    missed = _missing_stage_names(flow, state)
    if not missed or state.get("stage_retried", False):
        return {"full_tools": box}
    want_again = missed[0]
    if want_again not in _catalog_tool_names(box):
        return {"full_tools": box, "stage_retried": True}
    return {
        "tools": narrowed(state, _stage_tools(flow, want_again, box)),
        "full_tools": box,
        "stage_retried": True,
        "corrections": [
            *_live_corrections(state),
            STAGE_MISSED_NOTE.format(tool=want_again),
        ],
    }
_missing_stage_names = _probe_nodes._missing_stage_names
_catalog_tool_names = _probe_nodes._catalog_tool_names
def _next_stage_catalog(
    state: AgentState, flow: Flow, idx: int, box: list[dict[str, Any]]
) -> dict[str, Any]:
    """Offer the next staged verb while retaining this flow's side tools."""
    want = flow.stages[idx]
    if want not in _catalog_tool_names(box):
        return {"stage": idx + 1, "full_tools": box}
    return {
        "tools": narrowed(state, _stage_tools(flow, want, box)),
        "stage": idx + 1,
        "full_tools": box,
    }
_stage_tools = _probe_nodes._stage_tools
_stage_re_offer_due = _probe_nodes._stage_re_offer_due
route_after_stage_model = _probe_nodes.route_after_stage_model
route_after_stage_tools = _probe_nodes.route_after_stage_tools
check_result = _probe_nodes.check_result
_needs_transcription_terminal_check = _receipt_nodes._needs_transcription_terminal_check
_receipt_check_result = _receipt_nodes._receipt_check_result
_receipt_check_due = _receipt_nodes._receipt_check_due
_latest_receipt_mutation = _receipt_nodes._latest_receipt_mutation
_receipt_is_valid = _receipt_nodes._receipt_is_valid
_receipt_identities = _receipt_nodes._receipt_identities
_add_receipt_identity = _receipt_nodes._add_receipt_identity
_has_matching_receipt = _receipt_nodes._has_matching_receipt
_receipt_matches_mutation = _receipt_nodes._receipt_matches_mutation
_receipt_names_mutation = _receipt_nodes._receipt_names_mutation
_missing_receipt_result = _receipt_nodes._missing_receipt_result
_offered_tool_names = _receipt_nodes._offered_tool_names
_receipt_repair_available = _receipt_nodes._receipt_repair_available
_failure_check_result = _receipt_nodes._failure_check_result
_last_tool_has_failure_marker = _receipt_nodes._last_tool_has_failure_marker
_last_tool_content = _receipt_nodes._last_tool_content
_failure_repair_result = _receipt_nodes._failure_repair_result
_TRANSCRIPTION_TERMINAL_RE = _receipt_nodes._TRANSCRIPTION_TERMINAL_RE
_TRANSCRIPTION_JOB_RE = _receipt_nodes._TRANSCRIPTION_JOB_RE
_check_transcription_terminal = _receipt_nodes._check_transcription_terminal
_transcription_terminal_receipt = _receipt_nodes._transcription_terminal_receipt
_latest_transcription_action = _receipt_nodes._latest_transcription_action
_transcription_target = _receipt_nodes._transcription_target
_transcription_job_id = _receipt_nodes._transcription_job_id
_is_terminal_transcription_result = _receipt_nodes._is_terminal_transcription_result
_has_terminal_transcription_status = _receipt_nodes._has_terminal_transcription_status
_transcription_identities = _receipt_nodes._transcription_identities
_status_is_terminal_for_transcription = _receipt_nodes._status_is_terminal_for_transcription
_transcription_status_names_action = _receipt_nodes._transcription_status_names_action
_pending_transcription_result = _receipt_nodes._pending_transcription_result
_transcription_identity = _receipt_nodes._transcription_identity
_transcription_repair_available = _receipt_nodes._transcription_repair_available
route_after_check = _receipt_nodes.route_after_check
STALE_IMAGE = _route_nodes.STALE_IMAGE
trim_images = _route_nodes.trim_images
route_after_perceive = _route_nodes.route_after_perceive
_action_scores = _route_nodes._action_scores
_hint_score = _route_nodes._hint_score
_unambiguous_winner = _route_nodes._unambiguous_winner
_tool_name = _route_nodes._tool_name
_routed_catalog = _route_nodes._routed_catalog
_catalog_contains = _route_nodes._catalog_contains
async def route_action(state: AgentState) -> dict[str, Any]:
    """Narrow an action flow only when its routing vocabulary has one winner."""
    spec = get_agent(state.get("agent_id", ""))
    actions = spec.flow.actions
    if not actions:
        return {}
    ask = (state.get("question", "") or "").lower()
    target = _unambiguous_winner(_action_scores(actions, ask))
    if not target:
        return {}
    keep = set(spec.flow.keep) | {target}
    routed = _routed_catalog(state.get("tools", []), keep)
    if not _catalog_contains(routed, target):
        return {}
    return {"tools": narrowed(state, routed), "routed": target}
route_after_react_prepare = _route_nodes.route_after_react_prepare

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
GRAPH_APP_DESIGN = graph_for("app.design")
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
