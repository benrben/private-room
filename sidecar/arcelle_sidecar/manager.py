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
from .routing import _JOB_HINTS, _UI_HINTS

#: Registry agents whose vocabulary lives in routing.py (the Rust-parity
#: lists stay the single source of truth — do not duplicate them in agents.py).
_ROUTING_HINTED: dict[str, tuple[str, ...]] = {
    "app.ui": _UI_HINTS,
    "jobs.run": _JOB_HINTS,
}


# --------------------------------------------------------------------------- #
# clause → agent
# --------------------------------------------------------------------------- #


def _score(clause: str, spec: AgentSpec) -> int:
    """Vocabulary hits of this agent's hint list in the clause. Substring
    matching, same doctrine (and same lists, where shared) as the Rust
    routers — erring toward a hit is safe, the box just gets offered.

    An agent's OWN hints score double the routing-inherited lists: the
    inherited lists are deliberately broad (they gate whole lanes), so a
    sibling with a specific vocabulary ("workflow", "schedule") must win the
    tie against the broad lane list that also happens to contain its words.
    """
    q = clause.lower()
    own = sum(2 for h in spec.hints if h in q)
    inherited = sum(1 for h in _ROUTING_HINTED.get(spec.id, ()) if h in q)
    return own + inherited


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
    members: tuple[str, ...] = ()
    for name, domain_members, _ in AGENT_TOOL_DOMAINS:
        if name == tool:
            members = domain_members
            break
    if not members:
        return DEFAULT_AGENT_ID
    if served_names is not None:
        usable = reachable_members(
            members, web_enabled=web_enabled, served_names=served_names
        )
        # Every member unreachable: the domain should not have been offered at
        # all, so fall back to the default worker rather than an empty box.
        members = usable or (DEFAULT_AGENT_ID,)
    if len(members) == 1:
        return members[0]
    q = instruction.lower()

    def longest_hit(member_id: str) -> int:
        spec = get_agent(member_id)
        hits = [len(h) for h in spec.hints if h in q]
        hits += [len(h) for h in _ROUTING_HINTED.get(member_id, ()) if h in q]
        return max(hits, default=0)

    # Hit count first; then OWN vocabulary beats inherited-only; then the
    # LONGEST matched hint ("create a skill" is more specific than the bare
    # "skill" both siblings contain); a full tie falls to the first member —
    # the domain's stated default.
    #
    # The own-vocabulary rung is what makes the doubling in `_score` actually
    # decide: "summarize every file each morning" gave jobs.run TWO inherited
    # hits ("every ", "each morning" — the broad lane list carries recurrence
    # words) and jobs.workflows ONE own hit, tying 2-2 and falling through to
    # the default, so a RECURRING request routed to the one-off file pass.
    def owns_vocabulary(member_id: str) -> bool:
        q = instruction.lower()
        return any(h in q for h in get_agent(member_id).hints)

    best_id, best_key = members[0], (-1, False, -1)
    for member_id in members:
        key = (
            _score(instruction, get_agent(member_id)),
            owns_vocabulary(member_id),
            longest_hit(member_id),
        )
        if key > best_key:
            best_id, best_key = member_id, key
    return best_id


__all__ = [
    "resolve_worker",
]
