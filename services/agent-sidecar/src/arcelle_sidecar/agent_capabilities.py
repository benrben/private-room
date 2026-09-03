"""Agent registry lookups, domain mappings, and capability constants."""

from __future__ import annotations

import re

from .agent_domains import DOMAIN_BLURBS, DOMAIN_KEY_ORDER
from .agent_registry_1 import REGISTRY_1
from .agent_registry_2 import REGISTRY_2
from .agent_registry_common import CORE_TOOLS
from .agent_types import AgentSpec
from .prompts import TOOL_GROUP_LABELS

REGISTRY: tuple[AgentSpec, ...] = (*REGISTRY_1, *REGISTRY_2)

#: Every agent by id. Defined HERE rather than beside the other lookups at the
#: foot of the module because the import-time guards below (the `*` tag table)
#: resolve domain members through it, and an assert that runs at import cannot
#: wait for a name defined later in the file.
_BY_ID: dict[str, AgentSpec] = {spec.id: spec for spec in REGISTRY}

#: Sub-agent boxes may not exceed this (CORE is exempt — its size is dictated
#: by the byte-stable Rust prompt, not by choice).
# Raised 6 → 7 for BROWSE-2: browse_save is a browse-native verb (capture the
# page you are looking at) and the browse box was already at the cap. Still a
# cap — a new tool must argue its way in, not ride a raise.
MAX_BOX_TOOLS = 7

#: The default WORKER for a clause nothing claims: the File agent (CORE
#: read+write) — every ask is delegated to a specialist; the main agent
#: (``MAIN_AGENT_ID``) only ever synthesizes.
DEFAULT_AGENT_ID = "files.read"

#: The user's single interlocutor (hub-and-spoke; see AgentSpec.main).
MAIN_AGENT_ID = "chat.answer"

#: The request_tools groups, in stable order (drives the unlock enum).
GROUPS: tuple[str, ...] = ("app_ui", "jobs", "skills", "connectors")

# The group NAMES live here and their human labels live in `prompts.py`, and
# both `prompts.request_tools_spec` and `graph.prepare` subscript
# TOOL_GROUP_LABELS directly with a name out of GROUPS. A group added here
# without a label would therefore raise KeyError in the middle of building a
# turn's catalog — a crash mid-answer, at the one moment the user is watching.
# The same import-time guard the domain blurbs get (see the assert beside
# DOMAIN_KEYS), so the mistake costs a failed start-up instead.
_MISSING_TOOL_GROUP_LABELS = set(GROUPS).difference(TOOL_GROUP_LABELS)
assert not _MISSING_TOOL_GROUP_LABELS, (
    "every request_tools group needs a prompts.TOOL_GROUP_LABELS row; missing="
    f"{sorted(_MISSING_TOOL_GROUP_LABELS)}"
)

# --------------------------------------------------------------------------- #
# agent-tools — the MAIN agent's catalog (owner decision 2026-07-23 v3):
# "the main agent is the one who calls other agents for actions; he can call
# as many as he needs, but things he knows he answers himself."
#
# Each entry is ONE tool the main agent sees: (tool name, member worker ids,
# description). Domains keep the main catalog at ≤6 entries (the 4B ceiling);
# when a domain has two member workers, the MANAGER's vocabulary scoring picks
# the concrete one from the instruction (deterministic, code-side).
# --------------------------------------------------------------------------- #

AGENT_TOOL_DOMAINS: tuple[tuple[str, tuple[str, ...], str], ...] = (
    (
        "ask_file_agent",
        (
            "files.read",
            "scripts.run",
            "media.transcribe",
            "media.video",
            "creator.studio",
            "creator.draw",
        ),
        "Ask the File agent to work with this room's content: list, search, "
        "read, open, summarize, create, edit, rename, move, organize or delete "
        "files and notes, run this "
        "room's .py/.js scripts, transcribe its audio and video on-device, "
        "WATCH a video and report what is on screen at any moment, "
        "turn its material into flashcards, a mind map or a podcast script, "
        "and DRAW on its sketch pages — diagrams, flows and maps. "
        "Use it for ANY question about what is in this room — never answer "
        "those from memory.",
    ),
    (
        "ask_web_agent",
        ("chat.web", "chat.browse"),
        "Ask the Web agent about anything on the internet: search for current "
        "or outside information (news, weather, prices, docs), or OPEN and "
        "OPERATE a specific web page in the room's private browser — read it, "
        "click, fill a form, sign in, work through a site. ALWAYS repeat the "
        "exact address or site name the user gave (\"en.wikipedia.org\") in "
        "your instruction: it decides whether the page is opened in the "
        "browser or merely searched for.",
    ),
    (
        "ask_app_agent",
        ("app.ui", "app.design"),
        "Ask the App agent to see or operate this app's own interface, or to "
        "design its visual skin: colours, font roles, translucent materials, "
        "type rhythm, accessibility, motion, spacing and layout.",
    ),
    (
        "ask_jobs_agent",
        ("jobs.run", "jobs.workflows"),
        "Ask the Jobs & Workflows agent for AUTOMATION and heavy background "
        "work: saved multi-step WORKFLOWS and pipelines (create, edit, "
        "schedule, test or run one — anything recurring, \"every morning\", "
        "\"every week\"), covering an ENTIRE file with a durable background "
        "pass (translate or summarize a whole book), and job status. Every "
        "mention of a workflow, pipeline, automation or schedule belongs "
        "here.",
    ),
    (
        "ask_skills_agent",
        ("skills.use", "skills.author"),
        "Ask the Skills agent to find, read, run, create or edit Agent "
        "SKILLS: written instructions that teach an agent HOW to carry out a "
        "kind of task. NOT workflows, pipelines, schedules or automation — "
        "those are the Jobs & Workflows agent.",
    ),
    (
        "ask_connector_agent",
        ("connectors.use", "connectors.admin"),
        "Ask the Connector agent to reach the user's connected third-party "
        "tools (send email/Slack messages, calendars, external apps) or to "
        "inspect/configure those connections.",
    ),
)

AGENT_TOOL_NAMES: frozenset[str] = frozenset(n for n, _, _ in AGENT_TOOL_DOMAINS)

#: The BATCH delegation tool: one call carrying a LIST of tasks, with optional
#: dependencies between them.
#:
#: Why this exists alongside the per-domain tools, and why it is the primary
#: path for a local model: a small model asked to emit three separate tool
#: calls in one round is doing the exact thing BFCL measures it worst at (FC
#: mode gets call COUNTS wrong far more often than prompting does). Emitting
#: ONE call whose argument happens to be a list of three tasks is a single tool
#: call — the regime small models are frontier-grade in. The parallelism then
#: comes from the SHAPE OF THE ARGUMENT rather than from the model's ability to
#: batch, and `depends_on` states the ordering explicitly instead of leaving
#: the hub to guess which of the model's calls were independent.
BATCH_TOOL_NAME = "ask_agents"

#: Short enum keys for the batch tool: ``ask_file_agent`` -> ``file``. A short
#: key is deliberately cheaper for a small model to emit correctly than the
#: full tool name, and it cannot collide with a room tool.
DOMAIN_KEYS: dict[str, str] = {
    name.removeprefix("ask_").removesuffix("_agent"): name
    for name, _, _ in AGENT_TOOL_DOMAINS
}

# Every generated listing must cover exactly the real domains — a domain added
# without a blurb, or a blurb for a domain that no longer exists, would drift
# the prose away from the catalog again. Fail at import instead.
assert set(DOMAIN_BLURBS) == set(DOMAIN_KEYS) == set(DOMAIN_KEY_ORDER), (
    "DOMAIN_BLURBS/DOMAIN_KEY_ORDER must cover exactly the AGENT_TOOL_DOMAINS "
    f"keys; blurbs={sorted(DOMAIN_BLURBS)} order={sorted(DOMAIN_KEY_ORDER)} "
    f"domains={sorted(DOMAIN_KEYS)}"
)

#: ``*tag -> (domain key, worker id)`` for EVERY agent a user may tag.
#:
#: The `*` menu's index (owner feature 2026-08-03). It is per-AGENT where
#: :data:`DOMAIN_KEYS` is per-DOMAIN, and that difference is the whole point:
#: the Browser agent is a sibling of the Web agent under ``ask_web_agent``
#: because a 4B picks reliably among no more than six domain tools — a cap that
#: says nothing about a HUMAN reading a dropdown, who was shown only "web" and
#: could not tell that the room has a browser at all (owner report 2026-08-03).
#:
#: The domain key rides along because a tag still routes through the domain
#: TOOL: tagging the Browser narrows the hub's catalog to ``ask_web_agent`` and
#: pins the worker behind it (`resolve_worker`'s ``pin``). The model-facing
#: catalog is untouched.
#:
#: Built by walking :data:`AGENT_TOOL_DOMAINS`, so an agent that is in no domain
#: is in no menu — a specialist the hub has no tool to reach must not be
#: offered as one.
SPECIALIST_TAGS: dict[str, tuple[str, str]] = {
    _spec.tag: (_name.removeprefix("ask_").removesuffix("_agent"), _spec.id)
    for _name, _members, _ in AGENT_TOOL_DOMAINS
    for _spec in (_BY_ID[_m] for _m in _members)
}

# Same import-time discipline as the blurbs above, for the same reason: a menu
# is one more thing that can claim a capability the room does not have, and
# every way it could go wrong is a start-up failure rather than a live one.
#
# * a tag the composer cannot lex (`tagged_specialist` matches `[a-z]+`, and
#   `composer.ts parseComposer` matches the same) would be a menu row that
#   inserts text the host then refuses to send;
# * two agents sharing a tag would make one of them unreachable while both are
#   listed;
# * an agent in a domain with no tag at all would be missing from the menu with
#   nothing to say so;
# * and a domain whose FIRST member does not carry the DOMAIN's own key would
#   silently change what "*web" has always meant — the default member is what a
#   bare domain tag reaches (`resolve_worker` returns ``members[0]`` on a tie).
assert all(
    _s.tag and re.fullmatch(r"[a-z]+", _s.tag) and _s.area and _s.summary
    for _s in REGISTRY
    if not _s.main
), (
    "every non-main agent needs an a-z `tag`, an `area` and a `summary` for "
    "the `*` menu; bad="
    f"{sorted(s.id for s in REGISTRY if not s.main and not (s.tag and re.fullmatch(r'[a-z]+', s.tag) and s.area and s.summary))}"
)
assert len(SPECIALIST_TAGS) == sum(len(m) for _, m, _ in AGENT_TOOL_DOMAINS), (
    "`*` tags must be unique across every domain member; "
    f"tags={sorted(SPECIALIST_TAGS)}"
)
assert all(
    _BY_ID[_members[0]].tag == _name.removeprefix("ask_").removesuffix("_agent")
    for _name, _members, _ in AGENT_TOOL_DOMAINS
), (
    "a domain's FIRST member must carry the domain's own key as its `*` tag; "
    f"defaults={[(n, _BY_ID[m[0]].tag) for n, m, _ in AGENT_TOOL_DOMAINS]}"
)

#: EVERY tool name this registry knows: CORE, every agent's box, and the
#: ask_*_agent domain tools. This is the test for "did the registry mean to
#: own this name?", used by ``graph._select_tools`` to tell a genuine
#: third-party MCP tool (which the user connected deliberately, and which is
#: namespaced ``server_tool``) from a registry tool that simply belongs to no
#: request_tools GROUP.
#:
#: That distinction used to be made against the grouped names alone, so the
#: eleven ungrouped registry tools — web_search, fetch_page, list_scripts,
#: run_script, stt_status, retranscribe_file, the three studio verbs, and the
#: connector proxy pair — fell through the third-party escape hatch and were
#: offered to EVERY agent, the Main agent included. Measured before the fix:
#: 132 leaked tool-offers across the thirteen agents; the File agent saw 35
#: tools against a box of 18, including the internet its own prompt says
#: "belong[s] to other agents".
ALL_REGISTRY_TOOLS: frozenset[str] = frozenset(
    set(CORE_TOOLS)
    | set(AGENT_TOOL_NAMES)
    | {BATCH_TOOL_NAME}
    | {name for spec in REGISTRY for name in spec.tools}
)


#: Workers that exist only when the room's web setting is on.
WEB_DEPENDENT_AGENT_IDS: frozenset[str] = frozenset({"chat.web", "chat.browse"})

# Neither internet worker belongs to a request_tools GROUP — web access is a
# room setting, never something an agent unlocks mid-turn — which is what lets
# `group_servable` answer without knowing the setting. Same import-time guard
# as GROUPS/TOOL_GROUP_LABELS above: if a web-dependent agent is ever grouped,
# a web-disabled room would be offered that unlock, and the mistake should cost
# a failed start-up rather than a hallucinated capability.
assert not (WEB_DEPENDENT_AGENT_IDS & {s.id for s in REGISTRY if s.group}), (
    "a web-dependent agent may not belong to a request_tools group; "
    f"grouped={sorted(WEB_DEPENDENT_AGENT_IDS & {s.id for s in REGISTRY if s.group})}"
)
