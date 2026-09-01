"""The agent tree — every domain agent as DATA (2026-07-23, "dispatch-first").

Owner decision, 2026-07-23: instead of one loop staring at the full catalog,
requests route through a MANAGER (:mod:`.manager`) to small DOMAIN SUB-AGENTS,
each a plain :class:`AgentSpec` row: a toolbox capped at ~6 tools on top of
CORE, its own system-prompt paragraph, and its own routing vocabulary. The
loop itself doesn't change — a sub-agent is "the same loop wearing a smaller
toolbox and a sharper prompt". This module REPLACES the old per-lane
drop-list filtering in graph.py; the lane tuples in :mod:`.routing` remain
the single source of truth for tool names and stay parity-locked to the Rust.

Two structural rules, both load-bearing:

* **The CORE box is always present.** The Rust base system prompt teaches the
  read+write file verbs by name on every turn (agent.rs, byte-stable for
  KV-cache reuse), and live QA proved that a catalog contradicting the prompt
  makes the model deny its own abilities ("I can't save files"). So CORE
  mirrors that prompt-taught set exactly, and domain boxes stack ON TOP of
  it. Shrinking CORE requires making the Rust prompt per-agent first.
* **A box may only name tools the bridge actually serves.** ``toolbox_for``
  intersects with the served catalog at run time; the tests pin every name.

An agent whose tools the host does not expose yet is declared with
``available=False`` so the tree documents the target shape without ever
offering an unlockable box. Every agent in the tree is available today; the
flag stays as the promotion mechanism for the next one.
"""

from __future__ import annotations

from .agent_types import Action as Action, AgentSpec as AgentSpec, Flow as Flow
from .agent_specialists import (
    normalize_domain_key as normalize_domain_key,
    reachable_domain_keys as reachable_domain_keys,
    reachable_members as reachable_members,
    specialist_catalog as specialist_catalog,
    specialist_roster as specialist_roster,
    specialist_workers as specialist_workers,
    tagged_specialist as tagged_specialist,
    worker_reachable as worker_reachable,
)
from .agent_capabilities import (
    AGENT_TOOL_DOMAINS as AGENT_TOOL_DOMAINS,
    AGENT_TOOL_NAMES as AGENT_TOOL_NAMES,
    ALL_REGISTRY_TOOLS as ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME as BATCH_TOOL_NAME,
    DEFAULT_AGENT_ID as DEFAULT_AGENT_ID,
    DOMAIN_KEYS as DOMAIN_KEYS,
    GROUPS as GROUPS,
    MAIN_AGENT_ID as MAIN_AGENT_ID,
    MAX_BOX_TOOLS as MAX_BOX_TOOLS,
    REGISTRY as REGISTRY,
    SPECIALIST_TAGS as SPECIALIST_TAGS,
    WEB_DEPENDENT_AGENT_IDS as WEB_DEPENDENT_AGENT_IDS,
    _BY_ID,
)
from .agent_domains import (
    DOMAIN_BLURBS as DOMAIN_BLURBS,
    DOMAIN_KEY_ORDER as DOMAIN_KEY_ORDER,
    domain_areas as domain_areas,
    domain_listing as domain_listing,
    main_prompt as main_prompt,
)
from .agent_registry_common import (
    CORE_TOOLS as CORE_TOOLS,
)
_INSTRUCTION_PARAM: dict[str, str] = {
    "type": "string",
    "description": (
        "What you need this agent to do, as one clear task. Name the files "
        "or targets."
    ),
}

# --------------------------------------------------------------------------- #
# the spec
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# DOMAIN VOCABULARY — the single source for every prose listing of "what the
# specialists cover". Defined ABOVE the registry because the Main agent's
# system paragraph is built from it (see `main_prompt`).
# --------------------------------------------------------------------------- #

#: One SHORT plain-words blurb per domain key.
#:
#: Why this exists (2026-07-28): the batch tool's ``agent`` enum description and
#: the Main agent's paragraph were both hardcoded six-domain literals, while the
#: catalog itself is built from REACHABLE domains only. In a web-disabled room
#: the enum correctly dropped ``web`` and ``ask_web_agent`` vanished from the
#: catalog — but the description still read "web = the internet", the only text
#: left in context claiming the capability existed, and the exact text a model
#: reads to pick a key. It would emit ``agent: "web"``, which ``DOMAIN_KEYS``
#: (unfiltered) resolves happily, and ``resolve_worker`` then falls back to the
#: File agent: a weather question answered from room content. That is precisely
#: the confident-non-answer failure ``worker_reachable`` was written to kill,
#: arriving through the DESCRIPTION instead of through the router.
#:
#: Generate every capability listing from this dict. Never hardcode one.
#: EVERY blurb is ONE comma-free noun phrase. `domain_areas` joins them WITH
#: commas, so a comma inside one garbles the whole capability sentence — it read
#: "…content, scripts, transcripts, studio, the internet, and browsing sites,
#: this app's interface…", where no item's boundary is findable. Claude Code then
#: dropped the web item when listing what it could do and refused to browse
#: (owner report 2026-07-30). The per-domain DETAIL lives in each
#: ``AGENT_TOOL_DOMAINS`` description, which the model sees in the same catalog;
#: this dict is the at-a-glance AREA name only. `test_no_domain_blurb_contains_a_comma`
#: pins it.
# --------------------------------------------------------------------------- #
# CORE — always offered: the base-prompt-taught set (agent.rs) + read tools
# --------------------------------------------------------------------------- #

def _function_spec(name: str, description: str, parameters: dict) -> dict:
    """One entry in the wire catalog (the OpenAI/Ollama ``function`` shape).

    Byte-for-byte what the two hand-typed literals produced, key order included:
    the host and every engine parse this, so the shape is a contract — see
    ``test_the_delegation_catalog_json_is_byte_stable``.
    """
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }


def _instruction_only_params() -> dict:
    """``{instruction}`` — the whole argument list of an ``ask_*_agent`` tool.

    A fresh dict per call (and a copy of :data:`_INSTRUCTION_PARAM` inside it):
    the catalog is handed out to be filtered, appended to and rendered, and one
    dict shared by every entry of every call would turn any in-place edit into a
    global one. The hand-typed literals built a new dict per entry; so does this.
    """
    return {
        "type": "object",
        "properties": {"instruction": dict(_INSTRUCTION_PARAM)},
        "required": ["instruction"],
    }


def _batch_tool_spec(keys: list[str]) -> dict:
    """The ``ask_agents`` fan-out entry, whose ``agent`` enum IS ``keys``."""
    task = {
        "type": "object",
        "properties": {
            "agent": {
                "type": "string",
                "enum": keys,
                # Generated from the SAME `keys` as the enum — never a
                # hardcoded list. See DOMAIN_BLURBS for why.
                "description": f"Which specialist: {domain_listing(keys)}.",
            },
            "instruction": dict(_INSTRUCTION_PARAM),
            "depends_on": {
                "type": "array",
                "items": {"type": "integer"},
                "description": (
                    "Positions (0-based) of tasks in THIS list whose findings "
                    "this task needs. Leave empty when it can run immediately."
                ),
            },
        },
        "required": ["agent", "instruction"],
    }
    # The description used to sell WALL-CLOCK parallelism — "run AT THE SAME
    # TIME, so the whole batch costs as long as its slowest task instead of the
    # sum". That is true only on a cloud room. A LOCAL room has one resident
    # model, so `server.py` sets `Deps.worker_parallel = 1` on purpose and the
    # children run strictly one after another: the batch costs the sum, and the
    # agent strip shows five specialists "working" while four wait for a slot.
    # The model was planning against a promise the room cannot keep. What is
    # true on BOTH engines is what the tool is actually for — one call instead
    # of several (the regime a small model is reliable in), one set of reports
    # back — so that is what it now says.
    return _function_spec(
        BATCH_TOOL_NAME,
        (
            "Ask SEVERAL specialists in ONE call. Prefer this whenever "
            "the request has more than one part: one call carrying every "
            "part is far more reliable than several separate calls, and "
            "all the reports come back together. Use depends_on only "
            "when a task genuinely needs an earlier task's findings — "
            "those wait for it, everything else starts straight away."
        ),
        {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "The tasks to run, in any order.",
                    "items": task,
                }
            },
            "required": ["tasks"],
        },
    )


def agent_tool_specs(*, web_enabled: bool, served_names: set[str]) -> list[dict]:
    """The main agent's tool catalog: one entry per REACHABLE domain.

    A domain is reachable when some member worker could actually act — its box
    intersects the served catalog (the File agent's box is CORE, which the
    bridge always serves in agent scope). Web is a room setting.

    THE ``*`` TAG IS NOT A NARROWING OF THIS (2026-08-04). It used to be: an
    ``only=`` argument cut the catalog to the tagged domain, and the Main agent
    still ran, still planned and still delegated — a hub node lighting up for a
    turn the user had already routed themselves, which is what the owner
    reported. A tagged turn no longer reaches the hub at all
    (`graph.run_agent`), so there is nothing here to narrow.
    """
    keys = reachable_domain_keys(web_enabled=web_enabled, served_names=served_names)
    live = {DOMAIN_KEYS[k] for k in keys}
    out: list[dict] = [
        _function_spec(name, description, _instruction_only_params())
        for name, _members, description in AGENT_TOOL_DOMAINS
        if name in live
    ]
    if not out:
        # No reachable specialist means no batch tool either: a fan-out over an
        # empty roster is a call the model can only get wrong.
        return out
    # `keys` came from reachable_domain_keys above — the enum, its description
    # and the Main agent's prompt therefore list the SAME domains in the SAME
    # order. A small model sees one consistent world, not three.
    out.append(_batch_tool_spec(keys))
    return out


# --------------------------------------------------------------------------- #
# lookups
# --------------------------------------------------------------------------- #

def get_agent(agent_id: str) -> AgentSpec:
    """The spec for ``agent_id``; unknown ids degrade to the read-only default
    (a stale/foreign id must never crash a turn)."""
    return _BY_ID.get(agent_id) or _BY_ID[DEFAULT_AGENT_ID]


def group_tools(group: str) -> set[str]:
    """Every tool behind one request_tools group."""
    out: set[str] = set()
    for spec in REGISTRY:
        if spec.group == group and spec.available:
            out |= set(spec.tools)
    return out


def group_servable(group: str, served_names: set[str]) -> bool:
    """Could unlocking ``group`` actually give the model something to DO?

    THE question both request_tools gates ask, and until now both asked it as
    "was ANY tool of this group served" — the same any-one-of-them test
    :func:`worker_reachable` had to stop trusting. On the cloud-CLI tier
    ``app_ui`` passes that test on ``view_media_frame`` alone (a room video's
    pixels, served as CONTENT) while the three SCREEN tools stay local-only, so
    the group was offered in the prompt, a round could be spent unlocking it,
    and :func:`group_prompt` then briefed the model on ui_snapshot/ui_act —
    exactly the failure :attr:`AgentSpec.requires` was added to kill, reached
    through the other entrance.

    A group is servable when at least one MEMBER is reachable, which is one
    definition (this delegates) rather than two that can drift apart.
    """
    return any(
        worker_reachable(spec, web_enabled=True, served_names=served_names)
        for spec in REGISTRY
        if spec.group == group
    )


def group_prompt(group: str) -> str:
    """EVERY paragraph a group unlock appends, concatenated in registry order.

    A ``request_tools`` unlock hands the model ``group_tools(group)`` — the
    boxes of ALL members at once — so every member's paragraph applies, and
    the "describe only tools you actually have" rule is still satisfied.

    This used to return the FIRST non-empty prompt, which was correct only
    while siblings shared one domain paragraph. Since 2026-07-24 each agent
    owns its own, so first-wins would silently drop the sibling's guidance:
    unlocking ``jobs`` would describe the whole-file pass and never mention
    workflows. Deduped, so any pair that still shares text contributes once.
    """
    seen: list[str] = []
    for spec in REGISTRY:
        if spec.group == group and spec.available and spec.prompt and spec.prompt not in seen:
            seen.append(spec.prompt)
    return "".join(seen)


def toolbox_for(agent_id: str, served_names: set[str]) -> set[str]:
    """CORE + the agent's own box, intersected with what the bridge served.

    The intersection is the anti-hallucination rule: scope (LocalEngine vs
    advisor), room settings, and host version all shrink the served catalog,
    and the offered box must never exceed it.
    """
    spec = get_agent(agent_id)
    return (set(CORE_TOOLS) | set(spec.tools)) & served_names


def agent_roster() -> list[dict[str, str]]:
    """Every worker, ``{"id", "label"}``, in registry order.

    The published provider × agent matrix's ROW headings. Read straight off
    :data:`REGISTRY` so a new agent appears in the matrix the moment it exists —
    a hand-kept list would have been wrong by the next commit. The Main agent is
    excluded because it runs no tools of its own (``AgentSpec.main``): it is the
    interlocutor every tier always has, so a column of unbroken yeses would say
    nothing.
    """
    return [{"id": spec.id, "label": spec.label} for spec in REGISTRY if not spec.main]


def reachable_agent_ids(served_names: set[str], *, web_enabled: bool) -> list[str]:
    """Which workers could actually act, given the tools a tier serves.

    The SAME :func:`worker_reachable` predicate the live run uses — not a
    parallel re-implementation — so the matrix cannot claim an agent a real turn
    would find empty, or hide one a real turn would offer. That predicate is
    also what already refuses a box whose ``requires`` tools are missing, which
    is the whole reason the App agent must not appear for a tier that serves
    only ``view_media_frame``.
    """
    return [
        spec.id
        for spec in REGISTRY
        if not spec.main
        and worker_reachable(spec, web_enabled=web_enabled, served_names=served_names)
    ]


__all__ = [
    "AGENT_TOOL_DOMAINS",
    "AGENT_TOOL_NAMES",
    "BATCH_TOOL_NAME",
    "DOMAIN_BLURBS",
    "DOMAIN_KEYS",
    "DOMAIN_KEY_ORDER",
    "AgentSpec",
    "CORE_TOOLS",
    "agent_roster",
    "reachable_agent_ids",
    "DEFAULT_AGENT_ID",
    "MAIN_AGENT_ID",
    "GROUPS",
    "agent_tool_specs",
    "domain_areas",
    "domain_listing",
    "main_prompt",
    "normalize_domain_key",
    "reachable_domain_keys",
    "MAX_BOX_TOOLS",
    "REGISTRY",
    "get_agent",
    "group_prompt",
    "group_servable",
    "reachable_members",
    "SPECIALIST_TAGS",
    "specialist_roster",
    "specialist_catalog",
    "specialist_workers",
    "tagged_specialist",
    "worker_reachable",
    "group_tools",
    "toolbox_for",
]
