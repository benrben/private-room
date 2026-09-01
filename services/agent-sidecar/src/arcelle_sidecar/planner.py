"""Arcelle builds the specialist plan; the model runs it (owner decision #2).

THE DEFECT THIS EXISTS FOR (owner, 2026-08-03). The same request produced
twelve specialists, then five, then none, because the MODEL decided the
specialist plan — and a plan is exactly the multi-turn agency BFCL V4 measures
a 4B worst at (22.12% multi-turn against 87.88% single-turn). The owner's binding
call: **Arcelle builds the plan and hands it to the model**, which then executes
a plan rather than inventing one. The dispatch-first layer lands at the one seam
that already knows both halves of the question.

Three rules hold this module together, and each one is a bug that has already
happened here:

* **The roster is DERIVED, never declared.** Every candidate is a row of
  :data:`.agents.AGENT_TOOL_DOMAINS` and every reachability answer is
  :func:`.agents.reachable_domain_keys` — the same function the live catalog,
  the batch enum, the Main prompt and the ``*`` menu are all built from. A
  hardcoded roster in a planner would be a second source of truth about what
  this room can do, and the last time prompt and catalog disagreed a harness
  engine believed the PROMPT: the Main prompt claimed one domain forever and
  Claude Code denied having a browser (see :func:`.agents.main_prompt`).
  Deriving both from one place is the fix for that whole class, so this module
  derives too.
* **The vocabulary is the manager's, not a copy of it** — and it is read at the
  level it was written for. A plan step is a DOMAIN, so domains are scored, and
  a domain's vocabulary is its DEFAULT member's: the first entry of its
  ``AGENT_TOOL_DOMAINS`` tuple, which is the member :func:`.manager.resolve_worker`
  falls back to on a tie and therefore the one whose hints are about the domain
  rather than about beating a sibling. Scoring EVERY member cross-domain reads
  those lists for a job they were not written for, and it misroutes at once:
  ``chat.browse``'s hints are documented as "the discriminator against its
  sibling … safe to be this broad because siblings are scored only WITHIN their
  own domain", so its generic ``"open "`` claimed "open lease.pdf" for the
  Browser agent. Which member of a chosen domain then runs stays
  :func:`.manager.resolve_worker`'s question, scored with the same
  :func:`.manager.rank_worker` key — so a ``+`` ALL-OF hint cannot be worth one
  thing when the plan picks a domain and another when the domain picks its
  worker.
* **Abstain rather than guess — per CLAUSE as well as per turn.** A single
  broad lane word is not a plan (:data:`MIN_CLAIM_SCORE`), a request whose words
  name no specialist gets no plan at all, and a plan too long to state compactly
  is withdrawn. A clause nobody claims is NOT quietly given to the default
  domain either: that read "unclaimed" as "belongs to the File agent" and then
  stated it under "run exactly these steps", so "search the web for rents;
  thanks!" planned a File agent sub-loop for "thanks!" and, with the web off,
  "search the web for rents; email dana" planned the WEB half as a File agent
  step. Unclaimed clauses ride back to the hub by name
  (:data:`.prompts.PLAN_REMAINDER_NOTE`) — neither substituted nor dropped.

  The default File agent carries only namespace-shaped hints such as
  ``workspace_`` and ``filesystem``. That lets explicit harness/file-tool
  requests be claimed without turning broad verbs such as "move" or "delete"
  into a hand-written default route. Everything else still abstains: a wrong
  plan handed over as fact is worse than no plan, whereas the model's own
  judgement remains the documented fallback.

What this module never does is fill a SLOT. Every instruction it hands over is
the user's own words, verbatim, cut only at separators they typed themselves —
the dispatch proposal's hard line (§2.2: "the classifier returns a label only;
slots come exclusively from the deterministic grammar over the actual
utterance"), and the reason a mis-planned step still cannot invent a filename.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from .agents import (
    AGENT_TOOL_DOMAINS,
    BATCH_TOOL_NAME,
    DEFAULT_AGENT_ID,
    DOMAIN_BLURBS,
    DOMAIN_KEYS,
    WEB_DEPENDENT_AGENT_IDS,
    AgentSpec,
    get_agent,
    normalize_domain_key,
    reachable_domain_keys,
    worker_reachable,
)
from .manager import rank_worker, resolve_worker
from .planner_clauses import _clauses
from .planner_intent import is_static_visual_intent, is_visual_video_intent
from .prompts import no_plan_note, plan_note

#: The score a clause must reach before a domain may CLAIM it.
#:
#: :func:`.manager.rank_worker` scores an agent's OWN hint double a
#: routing-inherited one, so 2 is exactly "one own hint, or two of the broad
#: lane words". The threshold is what keeps "translate this paragraph" — one
#: inherited JOB_HINTS word — out of the whole-file-pass agent, while
#: "translate the whole book" (three of them) still lands there. Below it the
#: planner abstains and the hub decides, which is the honest answer when the
#: only evidence is a word that means several things.
MIN_CLAIM_SCORE = 2

#: A plan longer than this is WITHDRAWN, not truncated.
#:
#: Six because that is the number the Main agent's catalog is capped at, for the
#: same measured reason (a small model picks reliably among no more). Folding
#: the overflow into the last step would hand somebody else's clause to the
#: wrong specialist and dropping it would silently lose part of the request —
#: both are worse than saying "I could not plan this one", which is a state this
#: module already has a truthful answer for.
MAX_PLAN_STEPS = 6


@dataclass(frozen=True, slots=True)
class PlanStep:
    """One specialist, one instruction — the unit the hub is handed."""

    #: Short domain key ("web"), i.e. which ``ask_*_agent`` tool this is.
    domain: str
    #: The CONCRETE worker :func:`.manager.resolve_worker` will pick for this
    #: instruction. Resolved here rather than guessed, so the step chip and the
    #: roster node name the same agent that actually runs.
    worker: str
    #: That worker's own label ("Web agent") — what the agent strip shows.
    label: str
    #: The at-a-glance area blurb, for the note's user-facing half.
    area: str
    #: The user's own words for this step. Never composed, never paraphrased.
    instruction: str
    #: True when the user's separator said this step needs the previous one's
    #: findings ("… and then save it").
    needs_previous: bool


@dataclass(frozen=True, slots=True)
class Plan:
    """What Arcelle decided this turn, and why there is (or is not) a plan.

    ``reason`` is the diagnosis, and it exists because the four empty-plan cases
    are NOT the same event and must not read as one:

    ``planned``          Arcelle named the steps (or named a part this room
                         cannot do). The note is the handover.
    ``abstained``        nothing in the words named a specialist — the hub keeps
                         its own judgement, and is told that this is the
                         exception rather than the norm.
    ``no-specialists``   the bridge served nothing. ``MAIN_PROMPT_NO_SPECIALISTS``
                         owns that turn; a plan note on top of it would be a
                         second, contradictory story.
    """

    steps: tuple[PlanStep, ...]
    #: (worker label, the user's words) for a part this room has no specialist
    #: for — the transcription box on a cloud tier, say. Named out loud instead
    #: of quietly re-routed: re-routing is how "redo the transcript" once got
    #: answered by re-saving an unrelated reply (live QA 2026-07-24).
    unavailable: tuple[tuple[str, str], ...]
    reason: str
    #: The user's words for a part of the request this module could not name a
    #: specialist for, on a turn where it named one for some other part. Handed
    #: to the hub as ITS judgement (`.prompts.PLAN_REMAINDER_NOTE`) rather than
    #: folded into the default domain: "unclaimed" and "belongs to the File
    #: agent" are different facts, and stating the second as the first is how
    #: "thanks!" became a File agent sub-loop.
    unplanned: tuple[str, ...] = ()
    #: The ``ask_*_agent`` tool for the registry's default worker, when it is
    #: reachable — the one tool the abstain note may name.
    default_tool: str = ""

    @property
    def summary(self) -> str:
        """The plan as one line, for the step chip: ``File agent → Web agent``."""
        return " → ".join(step.label for step in self.steps)

    @property
    def note(self) -> str:
        """The system-prompt paragraph handed to the hub ("" = nothing to add)."""
        if self.reason == "planned":
            return _plan_note_for(self)
        if self.reason == "abstained" and self.default_tool:
            return no_plan_note(self.default_tool)
        return ""


def _plan_note_for(plan: Plan) -> str:
    """Build the planned-turn note from its already-resolved steps."""
    steps = [
        (step.label, step.area, step.instruction, step.needs_previous)
        for step in plan.steps
    ]
    tools = [DOMAIN_KEYS[step.domain] for step in plan.steps]
    return plan_note(
        steps,
        tools=tools,
        batch_tool=BATCH_TOOL_NAME,
        unavailable=plan.unavailable,
        unplanned=plan.unplanned,
        default_tool=plan.default_tool,
    )


#: ``(domain key, the member whose vocabulary routes TO that domain)``.
#:
#: The default member — ``members[0]``, the one :func:`.manager.resolve_worker`
#: returns on a tie. Derived from :data:`.agents.AGENT_TOOL_DOMAINS`, so a
#: domain added or reordered there brings its vocabulary with it and there is
#: nothing here to keep in step by hand.
#:
#: The App domain resolves to a member with no hints at all (``app`` ->
#: ``app.ui``), so it is never planned. That is a real limit, stated rather
#: than papered over. The App agent's vocabulary
#: (``routing.UI_HINTS``) is a lane GATE that overlaps three other domains'
#: nouns — "flashcard", "video", "map" — so reading it as a router would steal
#: their work. The File agent has only explicit workspace/filesystem namespace
#: vocabulary because everywhere else in this codebase it is reached by being
#: the DEFAULT rather than by being named. Treating "default" as "claimed" is
#: what this module tried first and had to undo (see the third rule above), so
#: ordinary room-content clauses still go back to the hub. Explicit harness
#: workspace language is the narrow exception.
_DOMAIN_VOCABULARY: tuple[tuple[str, AgentSpec], ...] = tuple(
    (name.removeprefix("ask_").removesuffix("_agent"), get_agent(members[0]))
    for name, members, _ in AGENT_TOOL_DOMAINS
)


DomainRank: TypeAlias = tuple[str, AgentSpec, tuple[int, bool, int]]
Clause: TypeAlias = tuple[str, bool]
Pick: TypeAlias = tuple[str, str]
GroupedClauses: TypeAlias = tuple[str, list[str], bool]
ClassifiedClause: TypeAlias = tuple[Clause, Pick]


def _agent_domain(agent: AgentSpec) -> str:
    """Return an agent's domain, retaining File as the registry fallback."""
    return normalize_domain_key(agent.id) or "file"


def _video_pick(
    clause: str,
    *,
    web_enabled: bool,
    served_names: set[str],
) -> tuple[str, str] | None:
    """Return the dedicated video decision, when the clause asks for pixels."""
    if not is_visual_video_intent(clause):
        return None
    video = get_agent("media.video")
    if worker_reachable(
        video,
        web_enabled=web_enabled,
        served_names=served_names,
    ):
        return ("domain", _agent_domain(video))
    return ("unavailable", video.label)


def _static_image_pick(
    clause: str,
    *,
    web_enabled: bool,
    served_names: set[str],
) -> tuple[str, str] | None:
    """Return the dedicated still-image decision, when the clause needs pixels."""
    if not is_static_visual_intent(clause):
        return None
    file_agent = get_agent("files.read")
    if "view_file_image" in served_names and worker_reachable(
        file_agent,
        web_enabled=web_enabled,
        served_names=served_names,
    ):
        return ("domain", _agent_domain(file_agent))
    return ("unavailable", file_agent.label)


def _ranked_domain(clause: str) -> DomainRank | None:
    """Return the highest-scoring default domain in stable registry order."""
    best: DomainRank | None = None
    for key, spec in _DOMAIN_VOCABULARY:
        rank = rank_worker(clause.lower(), spec)
        if best is None or rank > best[2]:
            best = (key, spec, rank)
    return best


def _is_claimable(pick: DomainRank | None) -> bool:
    """Whether the highest-scoring domain meets the abstention threshold."""
    return pick is not None and pick[2][0] >= MIN_CLAIM_SCORE


def _web_is_disabled(spec: AgentSpec, *, web_enabled: bool) -> bool:
    """Whether this candidate is intentionally silent while the web is off."""
    return spec.id in WEB_DEPENDENT_AGENT_IDS and not web_enabled


def _ranked_pick(
    clause: str,
    *,
    web_enabled: bool,
    live: list[str],
) -> tuple[str, str]:
    """Classify a non-visual clause using the derived domain vocabulary."""
    pick = _ranked_domain(clause)
    if not _is_claimable(pick):
        return ("none", "")
    key, spec, _ = pick
    if _web_is_disabled(spec, web_enabled=web_enabled):
        return ("none", "")
    if key not in live:
        return ("unavailable", spec.label)
    return ("domain", key)


def _pick(
    clause: str,
    *,
    web_enabled: bool,
    live: list[str],
    served_names: set[str],
) -> tuple[str, str]:
    """Which domain this clause names: ``("domain"|"unavailable"|"none", v)``.

    Ranked over EVERY domain, reachable or not, and the reachability test comes
    after — deliberately. Scoring only what is reachable would let a clause that
    plainly names the Jobs agent fall to whichever domain is left, which is the
    confident-non-answer failure :func:`.agents.worker_reachable` was written to
    kill. Ranking first means the answer is "this room cannot do that", which is
    true and useful.

    Strictly-greater keeps :data:`.agents.AGENT_TOOL_DOMAINS` order on a tie, so
    the pick is a pure function of the clause — never of set iteration order.
    """
    # A visual-video request is a high-confidence NON-DEFAULT member of the
    # broad File domain.  The generic planner intentionally scores only domain
    # defaults because sibling vocabularies such as Browser's ``open`` are too
    # broad cross-domain.  Keeping this receipt-critical exception explicit
    # prevents ``frame 6:00 in @video.mp4`` from becoming an abstained plan.
    if visual_pick := _video_pick(
        clause,
        web_enabled=web_enabled,
        served_names=served_names,
    ):
        return visual_pick

    # `files.read` is core-capable, so ordinary reachability would still call
    # it available after a blind provider or Cloud Privacy removed its pixels.
    if visual_pick := _static_image_pick(
        clause,
        web_enabled=web_enabled,
        served_names=served_names,
    ):
        return visual_pick

    return _ranked_pick(clause, web_enabled=web_enabled, live=live)


def _default_tool(live: list[str]) -> str:
    """Return the reachable default-domain tool, if the registry has one."""
    default_key = normalize_domain_key(DEFAULT_AGENT_ID) or ""
    return DOMAIN_KEYS[default_key] if default_key in live else ""


def _classified_clauses(
    clauses: list[Clause],
    *,
    web_enabled: bool,
    live: list[str],
    served_names: set[str],
) -> list[ClassifiedClause]:
    """Classify every user clause without changing its order or text."""
    return [
        (
            clause,
            _pick(
                clause[0],
                web_enabled=web_enabled,
                live=live,
                served_names=served_names,
            ),
        )
        for clause in clauses
    ]


def _has_recognized_pick(classified: list[ClassifiedClause]) -> bool:
    """Whether at least one clause named a specialist or unavailable capability."""
    return any(kind != "none" for _, (kind, _) in classified)


def _domain_key_or_record_remainder(
    *,
    kind: str,
    value: str,
    text: str,
    unavailable: list[tuple[str, str]],
    unplanned: list[str],
) -> str | None:
    """Keep unavailable and unclaimed clauses out of specialist grouping."""
    if kind == "unavailable":
        unavailable.append((value, text))
        return None
    if kind != "domain":
        unplanned.append(text)
        return None
    return value


def _append_grouped_clause(
    grouped: list[GroupedClauses], *, key: str, text: str, needs_previous: bool
) -> None:
    """Merge adjacent clauses only when they name the same specialist domain."""
    if grouped and grouped[-1][0] == key:
        grouped[-1][1].append(text)
        return
    grouped.append((key, [text], needs_previous and bool(grouped)))


def _group_classified_clauses(
    classified: list[ClassifiedClause], *, live: list[str]
) -> tuple[list[GroupedClauses], list[tuple[str, str]], list[str]]:
    """Group reachable domain clauses while preserving visible remainders."""
    unavailable: list[tuple[str, str]] = []
    unplanned: list[str] = []
    grouped: list[GroupedClauses] = []
    for ((text, needs_previous), (kind, value)) in classified:
        key = _domain_key_or_record_remainder(
            kind=kind,
            value=value,
            text=text,
            unavailable=unavailable,
            unplanned=unplanned,
        )
        if key is None:
            continue
        if key not in live:
            unplanned.append(text)
            continue
        _append_grouped_clause(
            grouped,
            key=key,
            text=text,
            needs_previous=needs_previous,
        )
    return grouped, unavailable, unplanned


def _step_worker(
    *,
    key: str,
    instruction: str,
    served_names: set[str],
    web_enabled: bool,
) -> str:
    """Resolve the concrete worker behind a previously selected domain."""
    if is_static_visual_intent(instruction):
        return "files.read"
    return resolve_worker(
        DOMAIN_KEYS[key],
        instruction,
        served_names=served_names,
        web_enabled=web_enabled,
    )


def _plan_step(
    grouped: GroupedClauses, *, served_names: set[str], web_enabled: bool
) -> PlanStep:
    """Build one displayed plan step from an adjacent-domain clause group."""
    key, texts, needs_previous = grouped
    instruction = "; ".join(texts)
    worker = _step_worker(
        key=key,
        instruction=instruction,
        served_names=served_names,
        web_enabled=web_enabled,
    )
    return PlanStep(
        domain=key,
        worker=worker,
        label=get_agent(worker).label,
        area=DOMAIN_BLURBS[key],
        instruction=instruction,
        needs_previous=needs_previous,
    )


def _plan_steps(
    grouped: list[GroupedClauses], *, served_names: set[str], web_enabled: bool
) -> list[PlanStep]:
    """Resolve each grouped domain into the worker the dispatcher will use."""
    return [
        _plan_step(
            group,
            served_names=served_names,
            web_enabled=web_enabled,
        )
        for group in grouped
    ]


def _abstained_plan(default_tool: str) -> Plan:
    """Return the hub-owned fallback when no compact plan can be stated."""
    return Plan(steps=(), unavailable=(), reason="abstained", default_tool=default_tool)


def _completed_plan(
    *,
    steps: list[PlanStep],
    unavailable: list[tuple[str, str]],
    unplanned: list[str],
    default_tool: str,
) -> Plan:
    """Return a stated plan unless the request named no usable capability."""
    if not steps and not unavailable:
        return _abstained_plan(default_tool)
    return Plan(
        steps=tuple(steps),
        unavailable=tuple(unavailable),
        reason="planned",
        unplanned=tuple(unplanned),
        default_tool=default_tool,
    )


def build_plan(
    question: str,
    *,
    web_enabled: bool,
    served_names: set[str],
) -> Plan:
    """The specialist plan for one turn — deterministic, and capability-derived.

    A pure function of ``(question, web_enabled, served_names)``: the same
    request against the same room always produces the same plan, which is the
    whole point (the defect was that it did not). ``served_names`` is only ever
    membership-tested, so the caller's set ordering cannot reach the output.

    There is no ``tagged`` case any more (2026-08-04). It returned an empty
    plan for the composer's ``*`` tag because the user's own routing beats any
    vocabulary — true, and now moot: a tagged turn never reaches the hub, so it
    never reaches this function either (`graph._run_tagged`).
    """
    live = reachable_domain_keys(web_enabled=web_enabled, served_names=served_names)
    if not live:
        # The degenerate tier. `prepare` already emits the diagnostic and
        # `MAIN_PROMPT_NO_SPECIALISTS` already tells the model it can reach
        # nothing; a plan note here would be a second story about the same turn.
        return Plan(steps=(), unavailable=(), reason="no-specialists")

    default_tool = _default_tool(live)
    classified = _classified_clauses(
        _clauses(question),
        web_enabled=web_enabled,
        live=live,
        served_names=served_names,
    )
    if not _has_recognized_pick(classified):
        # Nothing in the words named a specialist. The vocabulary genuinely
        # cannot see "compare my rent to the market" as file+web, and forcing a
        # single specialist on it would lose half the request — so this is the
        # one case the hub still decides, and it is told so.
        return _abstained_plan(default_tool)

    grouped, unavailable, unplanned = _group_classified_clauses(
        classified,
        live=live,
    )

    if len(grouped) > MAX_PLAN_STEPS:
        return _abstained_plan(default_tool)

    steps = _plan_steps(
        grouped,
        served_names=served_names,
        web_enabled=web_enabled,
    )
    return _completed_plan(
        steps=steps,
        unavailable=unavailable,
        unplanned=unplanned,
        default_tool=default_tool,
    )


__all__ = [
    "MAX_PLAN_STEPS",
    "MIN_CLAIM_SCORE",
    "Plan",
    "PlanStep",
    "build_plan",
    "is_static_visual_intent",
    "is_visual_video_intent",
]
