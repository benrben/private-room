"""Arcelle builds the specialist plan; the model runs it (owner decision #2).

THE DEFECT THIS EXISTS FOR (owner, 2026-08-03). The same request produced
twelve specialists, then five, then none, because the MODEL decided the
specialist plan — and a plan is exactly the multi-turn agency BFCL V4 measures
a 4B worst at (22.12% multi-turn against 87.88% single-turn; see
``pm-request/small-model-agent-reliability-2026-07-23.md``). The owner's binding
call: **Arcelle builds the plan and hands it to the model**, which then executes
a plan rather than inventing one. That is the dispatch-first proposal's Layer 1
(``pm-request/dispatch-first-agent-proposal-2026-07-23.md`` §2.2) landing at the
one seam that already knows both halves of the question.

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

  The cost of that rule is stated plainly: ``files.read`` carries no hints, so
  the FILE domain — the room's own default specialist — is never *claimed* by
  vocabulary and, now that it is no longer *assumed*, never appears in a plan at
  all. Its clauses arrive at the hub as remainder, with the room-content
  sentence attached. Closing that needs a domain-level file vocabulary that does
  not exist yet, and inventing one here would be the hand-synced substring list
  the design docs warn against. A wrong plan
  handed over as fact is worse than no plan: the model's own judgement is the
  documented fallback and it is a good one, whereas a forced-but-wrong
  specialist is a confident non-answer, which is the failure this codebase
  spends most of its guardrails on.

What this module never does is fill a SLOT. Every instruction it hands over is
the user's own words, verbatim, cut only at separators they typed themselves —
the dispatch proposal's hard line (§2.2: "the classifier returns a label only;
slots come exclusively from the deterministic grammar over the actual
utterance"), and the reason a mis-planned step still cannot invent a filename.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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
)
from .manager import rank_worker, resolve_worker
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

#: Separators a USER typed. Deliberately conservative: no bare "and" (it joins
#: two halves of one errand far more often than two errands — "find the rent and
#: the notice period"), and a capturing group so the delimiter itself survives
#: the split and can be read for sequencing below.
#:
#: Over-splitting is the failure mode to fear here, because every extra fragment
#: is a candidate extra specialist — i.e. the very "twelve specialists" symptom
#: this module exists to remove. Under-splitting costs one specialist a
#: two-part instruction, which is a thing workers handle every day.
_SPLIT_RE = re.compile(
    r"("
    r"\n+"
    r"|;"
    r"|,?\s+and\s+then\s+"
    r"|,?\s+then\s+"
    r"|,?\s+after\s+that,?\s+"
    r"|,?\s+afterwards,?\s+"
    r"|,?\s+and\s+also\s+"
    r"|,?\s+also,?\s+"
    r"|\s+ואז\s+"
    r"|\s+אחר\s+כך\s+"
    r"|\s+לאחר\s+מכן\s+"
    r"|\s+וגם\s+"
    r")",
    re.IGNORECASE,
)

#: Which of those separators mean "and USE what the last step found". A newline
#: or a semicolon does not; "then" does. This is the only source of a step's
#: ``depends_on``, so a plan never serialises work the user wrote as parallel.
_SEQ_RE = re.compile(
    r"then|after\s+that|afterwards|ואז|אחר\s+כך|לאחר\s+מכן", re.IGNORECASE
)


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
    ``tagged``           the user picked the specialist themselves with ``*``,
                         which is a stronger, more explicit routing than
                         anything this module could compute; the catalog is
                         already narrowed to it.
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
            return plan_note(
                [
                    (s.label, s.area, s.instruction, s.needs_previous)
                    for s in self.steps
                ],
                tools=[DOMAIN_KEYS[s.domain] for s in self.steps],
                batch_tool=BATCH_TOOL_NAME,
                unavailable=self.unavailable,
                unplanned=self.unplanned,
                default_tool=self.default_tool,
            )
        if self.reason == "abstained" and self.default_tool:
            return no_plan_note(self.default_tool)
        return ""


def _clauses(question: str) -> list[tuple[str, bool]]:
    """The request as ``(clause, needs_previous)`` in the order it was written.

    Falls back to the whole question as one clause when nothing splits — which
    is the common case and the safe one.
    """
    parts = _SPLIT_RE.split(question.strip())
    out: list[tuple[str, bool]] = []
    seq = False
    for i, part in enumerate(parts):
        if i % 2:  # a delimiter: it describes the clause that FOLLOWS it
            seq = bool(_SEQ_RE.search(part))
            continue
        text = part.strip().strip(",.;:- \t")
        if text:
            out.append((text, seq and bool(out)))
    return out or [(question.strip(), False)]


#: ``(domain key, the member whose vocabulary routes TO that domain)``.
#:
#: The default member — ``members[0]``, the one :func:`.manager.resolve_worker`
#: returns on a tie. Derived from :data:`.agents.AGENT_TOOL_DOMAINS`, so a
#: domain added or reordered there brings its vocabulary with it and there is
#: nothing here to keep in step by hand.
#:
#: Two domains resolve to a member with no hints at all (``file`` ->
#: ``files.read``, ``app`` -> ``app.ui``), so NEITHER IS EVER PLANNED. That is a
#: real limit, stated rather than papered over. The App agent's vocabulary
#: (``routing.UI_HINTS``) is a lane GATE that overlaps three other domains'
#: nouns — "flashcard", "video", "map" — so reading it as a router would steal
#: their work; the File agent simply has no vocabulary of its own, because
#: everywhere else in this codebase it is reached by being the DEFAULT rather
#: than by being named. Treating "default" as "claimed" is what this module
#: tried first and had to undo (see the third rule above), so both domains'
#: clauses go back to the hub — which is exactly today's behaviour for them, and
#: leaves the room's most-used specialist outside every plan until a
#: domain-level file vocabulary exists.
_DOMAIN_VOCABULARY: tuple[tuple[str, AgentSpec], ...] = tuple(
    (name.removeprefix("ask_").removesuffix("_agent"), get_agent(members[0]))
    for name, members, _ in AGENT_TOOL_DOMAINS
)


def _pick(
    clause: str, *, web_enabled: bool, live: list[str]
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
    q = clause.lower()
    best: tuple[str, AgentSpec] | None = None
    best_rank = (0, False, 0)
    for key, spec in _DOMAIN_VOCABULARY:
        rank = rank_worker(q, spec)
        if rank > best_rank:
            best, best_rank = (key, spec), rank
    if best is None or best_rank[0] < MIN_CLAIM_SCORE:
        return ("none", "")
    key, spec = best
    if spec.id in WEB_DEPENDENT_AGENT_IDS and not web_enabled:
        # The internet is off, which is a SETTING the user controls — and
        # :data:`.prompts.WEB_OFF_NOTE` is already the app's one carefully
        # worded answer to it, ending on where the switch is. Reporting it here
        # as well would put a second answer in the same system message, and
        # this one's wording ("this room has no specialist for that") is the
        # exact permanence claim that note exists to stop: live QA 2026-07-30
        # had the model tell a user their app had no browser at all and send
        # them looking for a feature they already own.
        return ("none", "")
    if key not in live:
        return ("unavailable", spec.label)
    return ("domain", key)


def build_plan(
    question: str,
    *,
    web_enabled: bool,
    served_names: set[str],
    tagged: str = "",
) -> Plan:
    """The specialist plan for one turn — deterministic, and capability-derived.

    A pure function of ``(question, web_enabled, served_names, tagged)``: the
    same request against the same room always produces the same plan, which is
    the whole point (the defect was that it did not). ``served_names`` is only
    ever membership-tested, so the caller's set ordering cannot reach the
    output.
    """
    live = reachable_domain_keys(web_enabled=web_enabled, served_names=served_names)
    if not live:
        # The degenerate tier. `prepare` already emits the diagnostic and
        # `MAIN_PROMPT_NO_SPECIALISTS` already tells the model it can reach
        # nothing; a plan note here would be a second story about the same turn.
        return Plan(steps=(), unavailable=(), reason="no-specialists")
    if tagged:
        # The user named the specialist themselves. That is a stronger routing
        # than any vocabulary — and `agent_tool_specs(only=…)` has already
        # narrowed the catalog to it, so there is nothing left to plan.
        return Plan(steps=(), unavailable=(), reason="tagged")

    default_key = normalize_domain_key(DEFAULT_AGENT_ID) or ""
    default_tool = DOMAIN_KEYS[default_key] if default_key in live else ""

    clauses = _clauses(question)
    picks = [_pick(text, web_enabled=web_enabled, live=live) for text, _ in clauses]
    if not any(kind != "none" for kind, _ in picks):
        # Nothing in the words named a specialist. The vocabulary genuinely
        # cannot see "compare my rent to the market" as file+web, and forcing a
        # single specialist on it would lose half the request — so this is the
        # one case the hub still decides, and it is told so.
        return Plan(
            steps=(), unavailable=(), reason="abstained", default_tool=default_tool
        )

    unavailable: list[tuple[str, str]] = []
    unplanned: list[str] = []
    # [domain key, [the user's clauses], needs_previous]
    grouped: list[tuple[str, list[str], bool]] = []
    for (text, seq), (kind, value) in zip(clauses, picks):
        if kind == "unavailable":
            unavailable.append((value, text))
            continue
        if kind != "domain":
            # UNCLAIMED — and that is not the same fact as "this belongs to the
            # default specialist". Sending it there anyway, then STATING it in a
            # paragraph that ends "do not drop one it does", is a substituted
            # specialist asserted as fact: "search the web for rents; thanks!"
            # planned a File agent sub-loop for "thanks!", and with the web off
            # "search the web for rents; email dana" planned the WEB half as a
            # File agent step — the exact re-routing this module's own docstring
            # forbids. The clause is not dropped either (that loses part of the
            # request): it goes back to the hub by name, which is what abstaining
            # already means one level up.
            unplanned.append(text)
            continue
        key = value
        if key not in live:
            # Defensive: `_pick` already refused an unreachable domain, so this
            # is unreachable in practice. Kept rather than asserted, because the
            # honest answer to "I cannot place this" is the remainder note.
            unplanned.append(text)
            continue
        if grouped and grouped[-1][0] == key:
            # Two clauses in a row for the same specialist are ONE step. Asking
            # the same agent twice in a round is the "twelve specialists" shape
            # in miniature, and it costs a whole extra sub-loop.
            grouped[-1][1].append(text)
            continue
        grouped.append((key, [text], seq and bool(grouped)))

    if len(grouped) > MAX_PLAN_STEPS:
        return Plan(
            steps=(), unavailable=(), reason="abstained", default_tool=default_tool
        )

    steps: list[PlanStep] = []
    for key, texts, seq in grouped:
        instruction = "; ".join(texts)
        # The CONCRETE worker comes from the dispatcher itself, so the label in
        # the plan is the label that will actually light up. Re-deriving it here
        # would be a second answer to a question `resolve_worker` already owns.
        worker = resolve_worker(
            DOMAIN_KEYS[key],
            instruction,
            served_names=served_names,
            web_enabled=web_enabled,
        )
        steps.append(
            PlanStep(
                domain=key,
                worker=worker,
                label=get_agent(worker).label,
                area=DOMAIN_BLURBS[key],
                instruction=instruction,
                needs_previous=seq,
            )
        )

    if not steps and not unavailable:
        return Plan(
            steps=(), unavailable=(), reason="abstained", default_tool=default_tool
        )
    return Plan(
        steps=tuple(steps),
        unavailable=tuple(unavailable),
        reason="planned",
        unplanned=tuple(unplanned),
        default_tool=default_tool,
    )


__all__ = [
    "MAX_PLAN_STEPS",
    "MIN_CLAIM_SCORE",
    "Plan",
    "PlanStep",
    "build_plan",
]
