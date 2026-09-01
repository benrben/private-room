"""Reachability, tag routing, and specialist catalog presentation."""

from __future__ import annotations

import re

from .agent_capabilities import (
    AGENT_TOOL_DOMAINS,
    DOMAIN_KEYS,
    SPECIALIST_TAGS,
    WEB_DEPENDENT_AGENT_IDS,
    _BY_ID,
)
from .agent_domains import DOMAIN_KEY_ORDER
from .agent_registry_common import CORE_TOOLS
from .agent_types import AgentSpec

def worker_reachable(spec: AgentSpec, *, web_enabled: bool, served_names: set[str]) -> bool:
    """Could this worker actually ACT with what the bridge served this run?

    The tiers differ by engine (``room_mcp::ToolScope``): a cloud-CLI room is
    served the CloudAdvisor tier, which carries no job, workflow, script,
    studio or transcription tools at all. A worker whose whole box is missing
    has nothing to do, so routing to it produces a confident non-answer — the
    live 2026-07-24 QA symptom, where "redo the transcript" reached the
    Transcription agent and it re-saved an unrelated earlier answer.
    """
    if not spec.available:
        return False
    # Web access is a ROOM SETTING, so it is a NECESSARY condition for both
    # internet workers — never a sufficient one. Both halves matter and each
    # has its own live failure:
    #
    # * Without the setting check, a web-disabled room keeps "the internet" in
    #   its domain listing and the model dispatches to a worker that cannot
    #   act (`test_web_disabled_room_never_mentions_the_internet`).
    # * Without the served-tools check below, a tier that serves no `browse_*`
    #   (a cloud advisor) still routes browsing to an EMPTY box — the same
    #   confident-non-answer this function was written to kill.
    #
    # So this returns False early and then falls through to the box check,
    # rather than returning `web_enabled` as the whole answer.
    if not _web_worker_enabled(spec, web_enabled):
        return False
    # A box whose load-bearing tools are missing is dead however much of the
    # REST of it was served — the any-one-of-them test below cannot see that,
    # because to it one tool is as good as another. See `AgentSpec.requires`.
    if not _worker_requirements_served(spec, served_names):
        return False
    return _worker_tools_served(spec, served_names)


def _web_worker_enabled(spec: AgentSpec, web_enabled: bool) -> bool:
    return spec.id not in WEB_DEPENDENT_AGENT_IDS or web_enabled


def _worker_requirements_served(spec: AgentSpec, served_names: set[str]) -> bool:
    return set(spec.requires) <= served_names


def _worker_tools_served(spec: AgentSpec, served_names: set[str]) -> bool:
    if not spec.tools or spec.core_capable:
        # Workers whose job IS the always-served base: those with no box at
        # all, and those (the File agent) whose box only ADDS to it. See
        # `AgentSpec.core_capable` for the regression that split these two
        # cases apart — the room's default worker went unreachable on every
        # tier that withholds its box.
        return bool(set(CORE_TOOLS) & served_names)
    return bool(set(spec.tools) & served_names)


def reachable_members(
    members: tuple[str, ...], *, web_enabled: bool, served_names: set[str]
) -> tuple[str, ...]:
    """The members of one domain that could actually act this run."""
    return tuple(
        m
        for m in members
        if worker_reachable(_BY_ID[m], web_enabled=web_enabled, served_names=served_names)
    )


#: Every spelling of a domain a model might plausibly emit -> its short key.
#: Built from the registry, so it cannot drift: the short key ("web"), the full
#: tool name ("ask_web_agent"), and every member WORKER id ("chat.web") all
#: resolve to the same domain.
#:
#: Small models are loose with identifiers — they echo a worker id from a
#: report, or the tool name instead of the enum key. Accepting all three costs
#: nothing and turns a whole class of near-miss into a correct dispatch. What
#: it must NOT do is accept a spelling of a domain that is not available this
#: run: see `normalize_domain_key`.
_DOMAIN_ALIASES: dict[str, str] = {}
for _name, _members, _ in AGENT_TOOL_DOMAINS:
    _key = _name.removeprefix("ask_").removesuffix("_agent")
    _DOMAIN_ALIASES[_key] = _key
    _DOMAIN_ALIASES[_name] = _key
    for _m in _members:
        _DOMAIN_ALIASES[_m] = _key
del _name, _members, _key, _m


def normalize_domain_key(raw: str) -> str | None:
    """One domain key for any spelling a model might emit, else ``None``.

    ``None`` means "not a domain at all" — the caller should keep its existing
    tolerant fallback (route to the default worker) rather than refuse, which
    is how a garbled key has always behaved. A recognised-but-unavailable
    domain is a DIFFERENT case and must be refused; compare the result against
    :func:`reachable_domain_keys`.
    """
    return _DOMAIN_ALIASES.get(raw.strip().lower())


#: A composer message whose FIRST token is ``*<name>`` — the owner's tag for
#: "run this specialist" (2026-08-03).
#:
#: ``[a-z]`` and nothing else, because this token is typed by a PERSON out of
#: the ``*`` menu and the menu inserts a domain key. It once read ``[\w.]`` so
#: that every spelling `normalize_domain_key` accepts (``*ask_web_agent``,
#: ``*chat.browse``) would match here too — but the host's parser
#: (``composer.ts parseComposer``) cannot even lex those, so it sent them as
#: ordinary prose while this side quietly dispatched the Web agent for a turn
#: the composer had shown as untagged. The alias table is for what a MODEL
#: emits; it has no business reading a human's first token.
#:
#: The tight charset is also what makes the name safe to quote back to the user
#: in the refusal (`prompts.TAG_UNAVAILABLE_ANSWER`): a-z cannot carry an
#: instruction, and no model is asked to relay it.
_TAG_RE = re.compile(r"^\s*\*([a-z]+)(?=\s|$)")


def tagged_specialist(question: str) -> tuple[str, str]:
    """``("web", "what is the weather")`` for ``"*web what is the weather"``.

    The FIRST token only, exactly like ``/skill`` (``agent.rs``
    ``explicit_skill_request``) — a ``*`` mid-sentence is multiplication, a
    footnote or a bullet, and must stay literal text. ``("", question)`` when
    there is no tag at all.

    The name comes back AS TYPED and is not checked against anything here. That
    is the whole judgement: this function used to return ``None`` for a name no
    domain answers to, which made a typo indistinguishable from an untagged
    turn — the hub then ran an ordinary turn and nothing, anywhere, told the
    user their ``*banana`` had gone nowhere. The host refuses that message
    outright (``composer.ts``, the same refusal ``#cmd`` and ``/skill`` get);
    when one reaches us anyway — a headless ``agent_run``, or a composer whose
    roster never loaded — `graph.run_agent` names it back and refuses it, by the
    same sentence a REACHABLE-but-unavailable tag gets. Both are "this room has
    no such specialist", and the room's served catalog is the only thing that
    can tell them apart — see :func:`specialist_workers`.
    """
    m = _TAG_RE.match(question)
    if not m:
        return "", question
    return m.group(1), question[m.end() :].strip()


def reachable_domain_keys(*, web_enabled: bool, served_names: set[str]) -> list[str]:
    """The short domain keys offered this run, in :data:`DOMAIN_KEY_ORDER`.

    THE definition of "which specialists exist right now". Everything that has
    to agree with the catalog derives from this one function: the ``ask_agents``
    enum, that enum's prose description, the Main agent's system paragraph, and
    the batch dispatcher's phantom-key guard. Four consumers, one truth — that
    is the whole point (2026-07-28).
    """
    live = {
        name
        for name, members, _ in AGENT_TOOL_DOMAINS
        if reachable_members(members, web_enabled=web_enabled, served_names=served_names)
    }
    return [k for k in DOMAIN_KEY_ORDER if DOMAIN_KEYS[k] in live]


def specialist_roster(
    *, web_enabled: bool, served_names: set[str]
) -> list[dict[str, str]]:
    """The reachable specialists as DATA, for the composer's ``*`` menu.

    The owner's ``*`` tag (2026-08-03) lets a user name the specialist a turn
    goes to, which means the HOST has to draw a menu of them — and a menu is
    one more thing that can claim a capability the room does not have. So it is
    generated from :func:`worker_reachable` like every other listing, rather
    than shipped as a roster the frontend keeps in step by hand: a web-disabled
    room offers neither internet specialist in the menu for exactly the same
    reason its catalog carries no ``ask_web_agent``.

    ONE ROW PER AGENT, not per domain (owner report 2026-08-03: the menu showed
    only "web" and the Browser agent was nowhere in it). The Main agent's
    catalog is capped at six DOMAIN tools because that is the number a 4B picks
    among reliably — a constraint on a model choosing under a context budget,
    and it says nothing about a person reading a dropdown. To that person "the
    internet" is two different jobs (search a question vs drive a page), and a
    menu that names only the first hides the second entirely. So the
    model-facing catalog stays exactly as it was and the MENU goes finer.

    Every row is still a route: ``agent`` is the worker the tag runs, and it is
    read from :func:`specialist_workers` — the SAME function routing reads — so
    "what the menu offers" and "what a tag reaches" are one set rather than two
    lists to keep in step. ``tool`` is the ``ask_*_agent`` that worker's domain
    hangs under, kept on the row because the delegation guard and the agent
    diagram both still speak in domains.
    """
    live = specialist_workers(web_enabled=web_enabled, served_names=served_names)
    out: list[dict[str, str]] = []
    for tag, worker in live.items():
        spec = _BY_ID[worker]
        out.append(
            {
                "key": tag,
                "tool": DOMAIN_KEYS[SPECIALIST_TAGS[tag][0]],
                "agent": spec.id,
                "label": spec.label,
                "area": spec.area,
                "description": spec.summary,
            }
        )
    return out


def specialist_catalog(
    *, web_enabled: bool, served_names: set[str]
) -> list[dict[str, object]]:
    """All canonical specialists, with their effective availability.

    Routing still consumes :func:`specialist_workers` and therefore cannot
    dispatch an unavailable row.  This fuller view is for capability discovery:
    hiding Web, Browser and Connector made the roster appear to contain 12,
    then 14, then 15 unrelated agents instead of one stable registry with clear
    prerequisites.
    """
    live = specialist_workers(web_enabled=web_enabled, served_names=served_names)
    return [
        _specialist_catalog_row(tag, domain, worker, live, web_enabled)
        for tag, (domain, worker) in SPECIALIST_TAGS.items()
    ]


def _specialist_catalog_row(
    tag: str, domain: str, worker: str, live: dict[str, str], web_enabled: bool
) -> dict[str, object]:
    spec = _BY_ID[worker]
    available, reason, local_handoff = _specialist_availability(tag, spec, live, web_enabled)
    return {
        "key": tag,
        "tool": DOMAIN_KEYS[domain],
        "agent": spec.id,
        "label": spec.label,
        "area": spec.area,
        "description": spec.summary,
        "capability": "full" if available else "unavailable",
        "capabilityReason": reason,
        "localHandoff": local_handoff,
    }


def _specialist_availability(
    tag: str, spec: AgentSpec, live: dict[str, str], web_enabled: bool
) -> tuple[bool, str, bool]:
    if live.get(tag) == spec.id:
        return True, "", False
    reason, local_handoff = _unavailable_specialist_reason(tag, spec, web_enabled)
    return False, reason, local_handoff


def _unavailable_specialist_reason(tag: str, spec: AgentSpec, web_enabled: bool) -> tuple[str, bool]:
    if spec.id in WEB_DEPENDENT_AGENT_IDS and not web_enabled:
        return "Turn on room internet", False
    if tag == "connector":
        return "Install and enable a connector", False
    return (
        f"The selected provider or privacy mode does not expose the "
        f"tools required by *{tag}. Switch to On this Mac to use it.",
        True,
    )


def specialist_workers(
    *, web_enabled: bool, served_names: set[str]
) -> dict[str, str]:
    """``{"web": "chat.web", "browse": "chat.browse", …}`` — the tags that WORK.

    THE definition of "which specialists a person can tag right now", and the
    one thing allowed to answer it: the ``*`` menu is drawn from it and a tagged
    turn is routed by it, so a row that cannot be run and a run that was never
    offered are both unrepresentable.

    A tag missing from this mapping means "this room has no such specialist",
    which covers all three ways that happens and deliberately does not
    distinguish them: a name no agent answers to (``*banana``), an agent whose
    ROOM SETTING is off (``*browse`` with the web off), and an agent whose box
    this engine's bridge tier does not serve (``*browse`` on a cloud-CLI room,
    which is served no ``browse_*`` at all). They are one answer to the person
    who typed it, and the callers refuse them with one sentence.

    Note what is tested: THE AGENT, via the same :func:`worker_reachable` a real
    dispatch uses — never its domain. ``*browse`` in a room that can search but
    cannot drive a page must be refused, because falling back to the domain
    there would answer a browsing request with the Web agent under the Browser
    agent's name: the substituted-specialist fabrication this whole feature is
    fenced against.

    Ordered by :data:`DOMAIN_KEY_ORDER` then by member order, so the menu leads
    with the default worker of the most-used domain and a domain's own default
    always precedes its siblings.
    """
    members_by_tool = {name: members for name, members, _ in AGENT_TOOL_DOMAINS}
    return {
        _BY_ID[member].tag: member
        for key in DOMAIN_KEY_ORDER
        for member in members_by_tool[DOMAIN_KEYS[key]]
        if worker_reachable(
            _BY_ID[member], web_enabled=web_enabled, served_names=served_names
        )
    }
