"""The manager: deterministic support for the MAIN agent's delegation.

Hub v3 (owner decision 2026-07-23): the MAIN agent itself decides which
specialists to call — its tool catalog is the ask_*_agent list
(:func:`.agents.agent_tool_specs`), it calls as many as the request needs, and
answers directly what it already knows. What remains deterministic here is
deliberately tiny:

* **Domain → concrete worker.** A domain tool like ``ask_jobs_agent`` covers
  two registry workers (whole-file pass vs workflows); vocabulary scoring over
  the instruction picks the one, so the 4B never faces sibling ambiguity.

Labels only, never slot values — the model's words stay its own.
"""

from __future__ import annotations

from .agents import (
    AGENT_TOOL_DOMAINS,
    DEFAULT_AGENT_ID,
    AgentSpec,
    get_agent,
    reachable_members,
)
from .routing import JOB_HINTS, wants_navigation

#: Registry agents whose vocabulary lives in routing.py (the Rust-parity
#: lists stay the single source of truth — do not duplicate them in agents.py).
#:
#: ``jobs.run`` is the only real row: it has a SIBLING (``jobs.workflows``) to
#: be scored against. ``app.ui`` sat here too, with a matching "wired in
#: manager.py" comment on its spec, but ``app`` is a single-member domain —
#: ``resolve_worker`` returns ``members[0]`` before any scoring runs, so
#: UI_HINTS was never once consulted here. Removed 2026-08-01; the list itself
#: is untouched, it is what ``routing.wants_ui_tools`` matches on.
_ROUTING_HINTED: dict[str, tuple[str, ...]] = {
    "jobs.run": JOB_HINTS,
}


# --------------------------------------------------------------------------- #
# clause → agent
# --------------------------------------------------------------------------- #


def _matches(hint: str, q: str) -> bool:
    """One hint against the lowercased instruction.

    Plain hints are substrings, the same doctrine as the Rust routers. A hint
    written ``"create+skill"`` is an ALL-OF: every ``+``-separated part must
    appear somewhere in ``q``, in any order and at any distance.

    THE BUG THIS EXISTS FOR (self-test 2026-08-01, wave 2). ``skills.author``
    was reachable only through contiguous phrases like ``"create a skill"``, so
    "create a small draft skill called self-test-demo" scored author 0 / use 1
    and the request went to the READ-ONLY sibling, which correctly answered that
    it cannot create skills. Nothing was broken except the vocabulary — and no
    finite list of contiguous phrases covers "create a small draft skill",
    "create a skill for X", "make me a new skill that…". A verb and its noun in
    the same sentence is what the intent actually looks like.
    """
    if "+" in hint:
        return all(part in q for part in hint.split("+"))
    return hint in q


def _hits(q: str, spec: AgentSpec) -> tuple[list[str], list[str]]:
    """This agent's matching hints in ``q``: (its OWN, the routing-inherited).

    Substring matching, same doctrine (and same lists, where shared) as the
    Rust routers — erring toward a hit is safe, the box just gets offered.

    ``q`` is the ALREADY-LOWERCASED instruction: every rung of the tie-break in
    :func:`resolve_worker` reads these two lists, so the hint tuples are walked
    once per candidate instead of once per rung.
    """
    inherited = _ROUTING_HINTED.get(spec.id, ())
    return (
        [h for h in spec.hints if _matches(h, q)],
        [h for h in inherited if _matches(h, q)],
    )


def _rank(q: str, spec: AgentSpec) -> tuple[int, bool, int]:
    """The sort key for one candidate worker — bigger wins, ties keep order.

    Hit count first; then OWN vocabulary beats inherited-only; then the LONGEST
    matched hint ("create a skill" is more specific than the bare "skill" both
    siblings contain). A full tie leaves every candidate equal, so the caller's
    first member — the domain's stated default — stands.

    An agent's OWN hints score double the routing-inherited lists: the
    inherited lists are deliberately broad (they gate whole lanes), so a
    sibling with a specific vocabulary ("workflow", "schedule") must win the
    tie against the broad lane list that also happens to contain its words.

    The own-vocabulary rung is what makes that doubling actually decide:
    "summarize every file each morning" gave jobs.run TWO inherited hits
    ("every ", "each morning" — the broad lane list carries recurrence words)
    and jobs.workflows ONE own hit, tying 2-2 and falling through to the
    default, so a RECURRING request routed to the one-off file pass.
    """
    own, inherited = _hits(q, spec)
    return (
        2 * len(own) + len(inherited),
        bool(own),
        max((len(h) for h in own + inherited), default=0),
    )


#: :func:`_rank` under a public name, for :mod:`.planner`.
#:
#: The planner ranks the WHOLE registry with the same key this module ranks
#: siblings with, so a hint cannot be worth one thing when the plan picks a
#: domain and another when the domain picks its worker — a second scorer beside
#: this one is precisely the drift the shared vocabulary lists exist to prevent.
#: ``q`` must already be lowercased (see :func:`_hits`).
rank_worker = _rank


def _domain_members(tool: str) -> tuple[str, ...]:
    """Return the registered members for ``tool``, or no members if unknown."""
    for name, members, _ in AGENT_TOOL_DOMAINS:
        if name == tool:
            return members
    return ()


def _served_members(
    members: tuple[str, ...], *, web_enabled: bool, served_names: set[str] | None
) -> tuple[str, ...]:
    """Keep the members that can act now, defaulting an empty domain subset."""
    if served_names is None:
        return members
    usable = reachable_members(
        members, web_enabled=web_enabled, served_names=served_names
    )
    return usable or (DEFAULT_AGENT_ID,)


def _navigation_worker(members: tuple[str, ...], instruction: str) -> str | None:
    """Return the browser worker when a reachable browser owns the intent."""
    if "chat.browse" in members and wants_navigation(instruction):
        return "chat.browse"
    return None


def _best_ranked_member(members: tuple[str, ...], instruction: str) -> str:
    """Choose the highest-ranked member, retaining domain order on a tie."""
    q = instruction.lower()
    best_id, best_key = members[0], (-1, False, -1)
    for member_id in members:
        key = _rank(q, get_agent(member_id))
        if key > best_key:
            best_id, best_key = member_id, key
    return best_id


def resolve_worker(
    tool: str,
    instruction: str,
    *,
    served_names: set[str] | None = None,
    web_enabled: bool = True,
) -> str:
    """The concrete worker behind one ask_*_agent call.

    Single-member domains pass through. For sibling domains (jobs: whole-file
    pass vs workflows; skills: use vs author; connectors: use vs admin) the
    instruction's vocabulary picks — ties fall to the FIRST member, the
    domain's stated default.

    ``served_names`` restricts the candidates to workers that can actually act
    this run. The Main agent's catalog offers a DOMAIN when ANY member is
    reachable, so on a tier that serves only some of them, vocabulary alone
    would happily pick one whose whole box is missing. Live QA 2026-07-24, on
    a cloud-CLI room: "redo the transcript" matched the Transcription agent,
    whose tools that tier never serves, and the empty-handed sub-loop answered
    by re-saving an unrelated earlier reply. Omitted (tests, callers with no
    catalog) means "assume everything is served".
    """
    members = _domain_members(tool)
    if not members:
        return DEFAULT_AGENT_ID
    # Every member unreachable: the domain should not have been offered at all,
    # so fall back to the default worker rather than an empty box.
    members = _served_members(
        members, web_enabled=web_enabled, served_names=served_names
    )
    if len(members) == 1:
        return members[0]

    # NAVIGATION INTENT WINS OUTRIGHT, ahead of all scoring (owner decision
    # 2026-07-30). "go to Google and search for X" is a destination, and it used
    # to lose to the search agent because `google` is a longer hint than `go to`
    # — see `routing.NAV_INTENT` for why no amount of re-weighting fixes that.
    #
    # Only when the browser is actually reachable: the `members` list above is
    # already filtered to workers that can act this run, so a room with the
    # Browser agent switched off falls through to the scorer and lands on the
    # Web agent, which searches instead (owner decision: fall back, don't
    # refuse).
    navigation_worker = _navigation_worker(members, instruction)
    if navigation_worker is not None:
        return navigation_worker
    return _best_ranked_member(members, instruction)


__all__ = [
    "rank_worker",
    "resolve_worker",
]
