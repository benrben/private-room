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

from collections.abc import Iterable
from dataclasses import dataclass

from .prompts import (
    BROWSE_PROMPT,
    CONNECTORS_ADMIN_PROMPT,
    CONNECTORS_USE_PROMPT,
    FILE_PASS_PROMPT,
    FILES_PROMPT,
    MAIN_PROMPT_NO_SPECIALISTS,
    MAIN_PROMPT_TEMPLATE,
    SCRIPTS_PROMPT,
    SKILLS_AUTHOR_PROMPT,
    SKILLS_USE_PROMPT,
    STUDIO_PROMPT,
    TOOL_GROUP_LABELS,
    TRANSCRIBE_PROMPT,
    UI_PROMPT,
    VIDEO_PROMPT,
    WEB_OFF_NOTE,
    WEB_PROMPT,
    WORKFLOWS_PROMPT,
)
from .routing import (
    BROWSE_TOOL_NAMES,
    DOWNLOAD_TOOL_NAMES,
    JOB_TOOL_NAMES,
    MCP_MANAGEMENT_TOOL_NAMES,
    SKILL_TOOL_NAMES,
    UI_TOOL_NAMES,
    WRITE_TOOL_NAMES,
)

# --------------------------------------------------------------------------- #
# the spec
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Action:
    """One mutually-exclusive terminal verb a routing shape may pick.

    The classifier is the ``hints`` tuple and it runs in plain Python, which is
    the documented "rule-based logic" arm of LangGraph's Router pattern — not a
    model call. A deterministic pick is 100% reproducible where a 4B's is not.
    """

    tool: str
    hints: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Flow:
    """Per-agent DATA for a SHARED graph shape.

    The reason templates can be shared without becoming generic mush: two
    agents run the same wiring and behave differently because their ``Flow``
    differs. Behaviour stays testable data rather than a branch inside a node.
    """

    #: Routing shapes only: the exclusive terminal verbs, scored by `hints`.
    actions: tuple[Action, ...] = ()
    #: A tool fired deterministically as the FIRST act of the turn, for agents
    #: whose opening move is a constant. Zero model cost.
    probe: str = ""
    #: A tool that must have RUN before ``probe`` is worth firing. Empty = the
    #: probe has no precondition, which is the common case.
    #:
    #: THE BUG THIS EXISTS FOR (2026-07-30): `app.ui` can perceive at any time
    #: because the app's own interface always exists, and `chat.browse` copied
    #: that pattern — but a web PAGE does not exist until `browse_open` has run.
    #: So every browse task opened with a `browse_snapshot` that could only fail
    #: ("The browser isn't open. Use browse_open first."), which the host
    #: journals as an `error` the USER reads back. A guaranteed failed first
    #: step on every task of a whole feature, and a small model's opening
    #: context poisoned with an error it did not cause.
    probe_after: str = ""
    #: Substrings in the probe's result that mean "this cannot be done". The
    #: predicate fails OPEN when none match, so drifting Rust wording degrades
    #: to today's behaviour rather than to a refusal.
    blockers: tuple[str, ...] = ()
    #: The answer given when a blocker matched — composed in code, no model.
    blocked_answer: str = ""
    #: Substrings in a tool result that mean the action FAILED — a traceback,
    #: a validation list. Fed back raw: the code-assistant tutorial's A/B found
    #: raw-error feedback BEAT a reflection call, so this costs no model round.
    failure_markers: tuple[str, ...] = ()
    #: How many repair passes this agent may spend. 0 = report the failure
    #: honestly instead (looping a 4B on someone else's script invents output).
    repair_cap: int = 0
    #: An ORDERED chain of one-tool stages, for agents whose prompt already
    #: prescribes the order (so the order is not the model's to choose).
    stages: tuple[str, ...] = ()
    #: Tools that stay offered ALONGSIDE a narrowed verb — the resolvers a
    #: model needs to turn "the contract" into a real filename. Without these
    #: a narrowed round cannot recover from a loosely-named argument.
    keep: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """One sub-agent, fully described as data.

    Every field below is READ by the running loop. Two were not, and both went
    on 2026-08-01: ``read_only`` — decoration shaped like a safety switch, since
    a spec could be marked read-only and still be handed ``browse_do`` with no
    code path noticing — and ``description``, a one-liner carried on every row
    for a constrained classifier that was never built. An agent's role is
    already stated where something actually reads it: the first sentence of its
    ``prompt`` (the model reads that every turn) and the per-domain blurb in
    :data:`AGENT_TOOL_DOMAINS` (the Main agent's catalog).
    """

    #: Stable id, ``domain.name`` (e.g. ``"jobs.run"``).
    id: str
    #: Human label for step chips (``graph.py`` reads it for the agent strip and
    #: for the worker's report header).
    label: str
    #: Tools this agent ADDS on top of CORE. ≤ MAX_BOX_TOOLS; tests pin it.
    tools: tuple[str, ...]
    #: The tools WITHOUT WHICH this box cannot do its job. ``worker_reachable``
    #: requires ALL of them on top of its usual "some tool of this box was
    #: served" test. Empty — the normal case — means every tool in the box is
    #: equally load-bearing and any one of them is enough to be useful.
    #:
    #: THE BUG THIS EXISTS FOR (2026-08-01): ``app.ui``'s box is the four
    #: UI_TOOL_NAMES, one of which is ``view_media_frame`` — a room video's
    #: pixels, which ``room_mcp::ToolScope`` classes as CONTENT and therefore
    #: serves to a cloud-CLI room, while the three SCREEN tools stay local-only.
    #: An any-one-of-them test passed on that single unrelated tool, so a Claude
    #: or Codex room was offered an App agent that cannot see or click anything
    #: and was briefed by UI_PROMPT on ui_snapshot/ui_act regardless. Watching a
    #: video is already ``media.video``'s job under ``ask_file_agent``, so
    #: nothing is lost by dropping the domain on those tiers.
    requires: tuple[str, ...] = ()
    #: System-prompt paragraph appended while this agent is active ("" = the
    #: base prompt already covers it).
    prompt: str = ""
    #: Deterministic routing vocabulary (lowercase substrings, EN + Hebrew).
    hints: tuple[str, ...] = ()
    #: False while the host serves no tools for this box (documents the
    #: target tree without offering the unlockable).
    available: bool = True
    #: request_tools group this box belongs to ("" = not unlockable mid-turn).
    group: str = ""
    #: Which graph SHAPE this agent runs (owner decision 2026-07-25). Agents do
    #: not all do the same kind of work, so they do not all get the same
    #: topology: the Studio agent generates once and answers, the File agent
    #: needs a ground-truth check before it reports, the Main agent dispatches
    #: rather than acting. Templates are SHARED where the work really is the
    #: same and distinct where it is not — see :mod:`.graphs`. The SPEC §3.2
    #: invariants live in the shared NODE functions, not in the shape, so a new
    #: template cannot quietly drop the tool-less final round or the memo set.
    template: str = "react"
    #: Per-agent data for that shape (routed verbs, probe, stages, …).
    flow: Flow = Flow()
    #: True for THE MAIN AGENT (owner decision 2026-07-23, hub-and-spoke): the
    #: user's single interlocutor. It runs NO tools — every piece of work is
    #: delegated to a specialist worker, whose report comes BACK to the main
    #: agent, and the main agent alone composes the user-facing answer. Never
    #: routable as a plan step; run_agent appends its synthesis turn itself.
    main: bool = False


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
DOMAIN_BLURBS: dict[str, str] = {
    "file": "this room's own content",
    "web": "the internet and browsing sites",
    "app": "this app's interface",
    "jobs": "workflows and whole-file passes",
    "skills": "agent skills",
    "connector": "connected services",
}

#: Definition order, not alphabetical — ``file`` is the default worker's domain
#: and the most common pick, so it leads every generated list a model reads.
#: A literal (not derived from ``DOMAIN_KEYS``) because the registry below is
#: built before ``AGENT_TOOL_DOMAINS`` exists; the assert beside ``DOMAIN_KEYS``
#: pins the two together.
DOMAIN_KEY_ORDER: tuple[str, ...] = (
    "file",
    "web",
    "app",
    "jobs",
    "skills",
    "connector",
)


def domain_listing(keys: Iterable[str]) -> str:
    """``"file = this room's content…; web = the internet"`` for `keys`.

    Ordered by :data:`DOMAIN_KEY_ORDER` regardless of the caller's order, so
    the string is deterministic and always leads with the default domain.
    """
    wanted = set(keys)
    return "; ".join(
        f"{k} = {DOMAIN_BLURBS[k]}" for k in DOMAIN_KEY_ORDER if k in wanted
    )


def domain_areas(keys: Iterable[str]) -> str:
    """The same domains as plain AREAS, for user-facing prose in the prompt.

    ``"the internet, this app's interface and connected services"`` — no keys,
    no tool names: the Main agent describes areas to the user, never plumbing.
    """
    wanted = set(keys)
    parts = [DOMAIN_BLURBS[k] for k in DOMAIN_KEY_ORDER if k in wanted]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def main_prompt(keys: Iterable[str], *, web_off: bool = False) -> str:
    """The Main agent's system paragraph for exactly the REACHABLE domains.

    ``keys`` are the short domain keys whose ``ask_*_agent`` tool is actually
    in the catalog this turn. Both capability sentences are filled from them,
    so the prompt can never advertise a specialist the model has no tool for.

    THE BUG THIS SHAPE EXISTS FOR (owner report 2026-07-30). This was:

        wanted = [k for k in DOMAIN_KEY_ORDER if k in set(keys)]

    `set(keys)` sits in the comprehension's CONDITION, so it is re-evaluated
    once per item of ``DOMAIN_KEY_ORDER``. Against a list that is merely
    wasteful; against the GENERATOR ``graph.prepare`` actually passes, the first
    evaluation drains it and every later one builds `set()` from an exhausted
    iterator — so only ``DOMAIN_KEY_ORDER[0]`` (`file`) could ever survive.

    The Main agent's prompt therefore claimed ONE domain no matter how many its
    catalog held, on every single turn. A local model mostly ignored the prose
    and called the tools it could see; **Claude Code trusted the prompt** — the
    documented harness-engine order of authority — and answered "I have no
    web-browsing specialist" with zero delegations, for a room that had one.
    Every unit test passed a list, which re-iterates, so the suite never saw it.

    Materialised ONCE, and the tests below pass a generator on purpose.

    ``web_off`` appends :data:`WEB_OFF_NOTE`. The catalog alone says only that
    the web domain is absent; without a reason the model invents one, and it
    picks permanence ("this room has no browsing tool") over the truth (a switch
    is off). See the note for the live refusal that prompted it.

    NO reachable domain at all gets :data:`MAIN_PROMPT_NO_SPECIALISTS` instead.
    The normal template's first sentence orders the model to call
    ``ask_file_agent``, and that half cannot be filtered — it is the sentence's
    subject — so on the tier where ``agent_tool_specs`` returns an EMPTY catalog
    the model was told to call the one tool it certainly does not have.
    """
    have = set(keys)
    wanted = [k for k in DOMAIN_KEY_ORDER if k in have]
    if not wanted:
        return (
            MAIN_PROMPT_NO_SPECIALISTS + WEB_OFF_NOTE
            if web_off
            else MAIN_PROMPT_NO_SPECIALISTS
        )
    paragraph = MAIN_PROMPT_TEMPLATE.format(
        # The sentence already named ask_file_agent, so this half lists the
        # others. With file the only reachable domain it degrades to a plain
        # "there are no other specialists" rather than a dangling "for .".
        other_areas=domain_areas([k for k in wanted if k != "file"])
        or "nothing else — you have no other specialists",
        all_areas=domain_areas(wanted) or "this room's content",
    )
    return paragraph + WEB_OFF_NOTE if web_off else paragraph


# --------------------------------------------------------------------------- #
# CORE — always offered: the base-prompt-taught set (agent.rs) + read tools
# --------------------------------------------------------------------------- #

CORE_TOOLS: tuple[str, ...] = (
    "list_room_files",
    "search_room",
    "open_file",
    "annotate_file",
    "mark_image",
    "list_memories",
    # 2026-07-24: the agent could save a memory but never correct or drop one,
    # so a wrong note it wrote was permanent. Both match on the note's text.
    "update_memory",
    "delete_memory",
    # 2026-07-24: every agent may own SKILLS — procedures for its domain, held
    # outside the prompt and loaded only when one applies. These two verbs are
    # how it discovers and loads them, so they belong to CORE rather than to a
    # box: a box is capped at MAX_BOX_TOOLS and jobs.workflows is already full,
    # and skills are no longer one domain's business. `list_skills` answers are
    # scoped to the calling agent (graph.execute_tools injects its id).
    "list_skills",
    "read_skill",
    *WRITE_TOOL_NAMES,  # create/edit/edit_files/write/set_cells/rename/move/add_memory
)

#: JOB_TOOL_NAMES split into the two jobs boxes (whole-file pass vs workflows).
_JOBS_RUN: tuple[str, ...] = ("start_file_pass", "job_status")
_JOBS_WORKFLOWS: tuple[str, ...] = tuple(n for n in JOB_TOOL_NAMES if n not in _JOBS_RUN)
#: SKILL_TOOL_NAMES split into use vs author.
_SKILLS_USE: tuple[str, ...] = ("list_skills", "read_skill", "read_skill_resource", "run_skill_script")
_SKILLS_AUTHOR: tuple[str, ...] = tuple(n for n in SKILL_TOOL_NAMES if n not in _SKILLS_USE)

# --------------------------------------------------------------------------- #
# the tree
# --------------------------------------------------------------------------- #

REGISTRY: tuple[AgentSpec, ...] = (
    AgentSpec(
        id="chat.answer",
        # This carried a delegation-chain budget of eight ("the longest real
        # pipeline seen in e2e — file -> jobs -> connector — with room to
        # spare"). The per-agent round budgets were removed (2026-07-27, owner
        # call) and `Flow` no longer has the field, so NOTHING caps how many
        # delegations one ask may chain. What bounds the hub today is turn-wide,
        # not per-agent: `config.TURN_ROUND_BACKSTOP` (400, carried down the whole
        # tree by `graph.Deps.turn_round_budget`) counts this agent's rounds plus
        # every round of every specialist it delegates to, and tripping it does
        # not abort — the remaining rounds are served TOOL-LESS so each loop
        # unwinds into a text answer. `config.AGENT_ROUND_BACKSTOP` bounds this
        # single loop and is deliberately far above real work.
        flow=Flow(),
        # dispatches to specialists; never touches a room tool
        template="supervisor",
        label="Main agent",
        tools=(),  # its ONLY tools are the ask_*_agent calls (agent_tool_specs)
        # The all-domains default, for anything reading the spec statically.
        # `graph.prepare` substitutes the REACHABLE-domain paragraph per turn
        # (see `main_prompt`), so this exact string is never what a live turn
        # sees when a domain is unreachable.
        prompt=main_prompt(DOMAIN_KEY_ORDER),
        main=True,
    ),
    AgentSpec(
        id="files.read",
        # This carried a round budget of twelve, sized so that "fix the typo in
        # each of these five notes" could finish while a stuck loop could not run
        # to 10,000. The per-agent budgets were removed (2026-07-27, owner call),
        # so a many-file errand is now bounded only by the shared runaway
        # backstop `config.AGENT_ROUND_BACKSTOP` (10,000 — i.e. the exact number
        # that budget existed to avoid) and by the turn-wide
        # `config.TURN_ROUND_BACKSTOP` it shares with the hub and its siblings.
        # What keeps this agent honest is `react_verify`'s ground-truth check on
        # what it claims to have changed, not a cap.
        flow=Flow(),
        # mutates the user's room — claims get a ground-truth check
        template="react_verify",
        label="File agent",
        tools=(),  # CORE alone (read + write verbs)
        prompt=FILES_PROMPT,
    ),
    AgentSpec(
        id="scripts.run",
        flow=Flow(
            # The first move is ALWAYS list_scripts — you cannot run a script
            # you have not named — so a model round spent rediscovering it is
            # pure waste. One repair pass: re-run with corrected arguments.
            probe="list_scripts",
            failure_markers=("traceback", "error:", "exception", "no such file"),
            repair_cap=1,
        ),
        template="recall_act_check",
        label="Scripts agent",
        tools=("list_scripts", "run_script"),
        prompt=SCRIPTS_PROMPT,
        hints=(
            # " script" is SPACE-ANCHORED because "transcript" ends in "script":
            # once the bare noun stopped claiming media.transcribe (below),
            # "summarize the meeting transcript" fell to THIS agent instead —
            # the same everyday-word bug one seat along. "javascript" is spelled
            # out for the same reason, since the anchor drops it.
            " script", "javascript", "run it", "run the", ".py", ".js",
            "execute",
            # ALL-OF (see `manager._matches`). A bare "python" was a hint, and
            # it is far more often the SUBJECT of a room question than an
            # instruction: "what does the report say about python" reached this
            # agent, which opens by listing scripts. The language name only
            # counts when the sentence also asks for a program to be run or
            # written.
            "python+run", "python+script", "python+write", "python+execute",
            "סקריפט", "הרץ", "להריץ", "פייתון",
        ),
        # Sibling of files.read under ask_file_agent: a script IS a room file,
        # and the Main agent's domain catalog is capped at 6 (a 4B picks
        # reliably among no more), so this rides an existing domain rather
        # than claiming a seventh.
    ),
    AgentSpec(
        id="chat.web",
        # WEB_PROMPT already dictates the order in English — "web_search to find
        # pages, then fetch_page on the most promising result — a search snippet
        # is not a source". Under a plain loop that is a plea a 4B routinely
        # ignores, answering from the snippet and never fetching. As stages it
        # is structural. Bounded at 3 model calls vs unbounded before.
        flow=Flow(
            stages=("web_search", "fetch_page"),
            # BROWSE-2: the download verbs stay offered through every stage —
            # `stage_catalog` narrows each round to keep ∪ {stage tool}, so a
            # verb not in `keep` would be unreachable in this box.
            keep=("search_room", *DOWNLOAD_TOOL_NAMES),
        ),
        template="chain_stage",
        label="Web agent",
        tools=("web_search", "fetch_page", *DOWNLOAD_TOOL_NAMES),
        hints=(
            "web", "online", "internet", "news", "latest", "google",
            "download", "save the link", "save this link",
            "חפש ברשת", "באינטרנט", "חדשות", "מזג אוויר", "הורד",
        ),
        prompt=WEB_PROMPT,
        # No group: web access is a ROOM SETTING, not something an agent may
        # unlock mid-turn.
    ),
    AgentSpec(
        id="chat.browse",
        # BROWSE-1. A SIBLING of chat.web under ask_web_agent rather than a
        # seventh domain: the Main agent's catalog is capped at 6 because a 4B
        # picks reliably among no more, and "the internet" is one idea to a
        # user whether it is answered by fetching a page or by driving one.
        #
        # `perceive_act` for the same reason app.ui uses it: browsing is a
        # see-then-act loop, and firing the snapshot deterministically as the
        # probe makes a round ONE action instead of a snapshot-then-action
        # pair. `trim_images` then keeps exactly one live page picture in
        # context, which is what makes browse_look affordable to use freely on
        # a small model.
        # `probe_after`: the free snapshot is worth exactly as much as it is on
        # app.ui, but only once a page EXISTS — see `Flow.probe_after` for the
        # guaranteed-failure this gate removes from the opening round.
        flow=Flow(probe="browse_snapshot", probe_after="browse_open"),
        template="perceive_act",
        label="Browser agent",
        # BROWSE-2: browse_save rode into BROWSE_TOOL_NAMES; the download verbs
        # deliberately did NOT — "download the report on that page" is a
        # browse_do CLICK (the browser imports the file automatically), and
        # explicit-URL downloads are chat.web's job. Keeping this box at the
        # browse verbs holds it inside the small-model choice budget.
        tools=BROWSE_TOOL_NAMES,
        # The discriminator against its sibling is NOT "does this mention the
        # web" — both do. It is: **is a specific destination named, or is a
        # page to be operated?** Open-ended questions ("the latest news", "the
        # weather") carry chat.web's vocabulary and no destination, so they
        # keep falling to the search agent, which is the domain's default.
        #
        # Live QA 2026-07-29 wrote this list: the first pass only carried
        # interaction verbs ("click", "fill in"), so every ordinary phrasing —
        # "go to en.wikipedia.org and search for X", "open example.com and tell
        # me what it says" — scored ZERO here, tied at 0-0 and fell through to
        # chat.web. The browser was fully wired and simply never chosen. Hence
        # the navigation verbs and the URL/domain fragments, which are what a
        # named destination actually looks like as a substring.
        hints=(
            # a destination was named
            "http", "www.", ".com", ".org", ".net", ".io/", ".gov", ".edu",
            ".co.", ".ai/", ".dev",
            # navigation verbs
            "go to", "open ", "visit", "browse", "browser", "navigate",
            "pull up", "head to", "load the",
            # page/site nouns
            "website", "web page", "webpage", "the site", "on the site",
            "the page", "on the page", "this page",
            # operating a page. " form" is SPACE-ANCHORED: the bare stem is a
            # substring of "information", and because this scorer breaks a tie
            # on the LONGEST matched hint, "form" (4) beat chat.web's "web" (3)
            # — so "search the web for information about X" was handed to the
            # Browser agent, which holds no search tool and had to guess an
            # address. The anchored form still catches "the form"/"a form"/"web
            # form" and drops information/platform/perform/transform.
            "click", "fill in", "fill out", "log in", "logging in", "sign in",
            " form", "checkout", "add to cart", "book a", "submit",
            "select the", "dropdown",
            "דפדפן", "גלוש", "פתח את האתר", "באתר", "לחץ", "מלא", "טופס",
            "כנס ל", "היכנס", "אתר", "דף",
        ),
        prompt=BROWSE_PROMPT,
        # No group, for the same reason as chat.web — web access is a room
        # setting, never something an agent unlocks mid-turn.
    ),
    AgentSpec(
        id="app.ui",
        # The agent that runs longest by nature: WebVoyager budgets 150 steps
        # and CUA 100, against LangGraph's default of 25. It carried the roster's
        # largest per-agent budget until those were removed (2026-07-27); what
        # keeps it honest now is `probe` firing the snapshot for free — so a
        # round is one ACTION, not a snapshot-then-action pair — plus
        # `trim_images` keeping exactly one live screenshot in context.
        flow=Flow(probe="ui_snapshot"),
        template="perceive_act",
        label="App agent",
        tools=UI_TOOL_NAMES,
        # SEEING and CLICKING are what this agent IS: `flow.probe` fires
        # ui_snapshot as its opening move and UI_PROMPT briefs it on ui_act.
        # Without both, everything the prompt tells it to do is a tool it does
        # not hold — see `AgentSpec.requires` for the cloud-CLI tier where the
        # box's fourth tool (view_media_frame) alone kept the domain offered.
        requires=("ui_snapshot", "ui_act"),
        prompt=UI_PROMPT,
        # This agent's vocabulary is routing.UI_HINTS, and NOTHING consults it:
        # `app` is a single-member domain, so `resolve_worker` returns app.ui
        # before any scoring runs. The `_ROUTING_HINTED` row that claimed to
        # wire it in was removed 2026-08-01; UI_HINTS itself is still the Rust
        # parity list `routing.wants_ui_tools` matches on.
        group="app_ui",
    ),
    AgentSpec(
        id="jobs.run",
        # Two exclusive terminal verbs with disjoint vocabulary — "translate the
        # whole book" vs "how is it going" — which is the Router pattern
        # verbatim. Was "oneshot" (ONE tool round), a latent version of the
        # media.transcribe bug: open with job_status and the single round is
        # spent, so start_file_pass could never run. The cycle is bounded by the
        # runaway backstop, not by the shape, because "the contract" has to be
        # resolved to a real filename first.
        flow=Flow(
            actions=(
                Action(
                    tool="start_file_pass",
                    hints=("whole", "entire", "all of", "translate", "every page",
                           "full", "כל הקובץ", "תרגם"),
                ),
                Action(
                    tool="job_status",
                    hints=("status", "progress", "how is", "how's", "still running",
                           "finished", "done yet", "מצב", "התקדמות"),
                ),
            ),
            keep=("list_room_files", "search_room"),
        ),
        template="route_act",
        label="Jobs agent",
        tools=_JOBS_RUN,
        prompt=FILE_PASS_PROMPT,
        # Vocabulary: routing.JOB_HINTS (Rust-parity) — wired in manager.py.
        group="jobs",
    ),
    AgentSpec(
        id="jobs.workflows",
        flow=Flow(
            # WORKFLOWS_PROMPT already demands author -> test -> read the
            # numbered failures -> fix -> retest. That is plan-and-execute
            # hand-rolled in a prompt and enforced by a 4B's willpower; the
            # index call in front of it is free and doubles as the few-shot.
            probe="list_workflows",
            failure_markers=("invalid", "cycle", "unknown node", "validation"),
            repair_cap=2,
        ),
        template="recall_act_check",
        label="Workflow agent",
        tools=_JOBS_WORKFLOWS,
        prompt=WORKFLOWS_PROMPT,
        hints=(
            "workflow", "automate", "automat", "pipeline", "recurring", "routine",
            "schedule", "every morning", "every day", "every week", "each morning",
            "each day", "תהליך", "אוטומצ", "אוטומט", "תזמן", "מתוזמן", "כל בוקר",
            "כל יום", "כל שבוע",
        ),
        group="jobs",
    ),
    AgentSpec(
        id="skills.use",
        flow=Flow(
            # The skill INDEX is always the first move. repair_cap=0 on purpose:
            # a skill that fails is the AUTHOR's problem, and looping a 4B on
            # someone else's script is how you get invented output.
            probe="list_skills",
            repair_cap=0,
        ),
        template="recall_act_check",
        label="Skills agent",
        tools=_SKILLS_USE,
        prompt=SKILLS_USE_PROMPT,
        hints=("skill", "agent instruction", "מיומנות", "סקיל"),
        group="skills",
    ),
    AgentSpec(
        id="skills.author",
        flow=Flow(
            # Two existing skills as verbatim examples teach frontmatter shape,
            # directory layout and house style by demonstration — the highest
            # leverage cheap win in the roster. NOTE: the full "does the script
            # RUN" check needs a Rust dry-run verb that does not exist yet
            # (the sidecar may not exec anything), so `check` degrades to the
            # save-errored predicate until that lands.
            probe="list_skills",
            failure_markers=("error", "invalid", "failed"),
            repair_cap=2,
        ),
        template="recall_act_check",
        label="Skill-builder agent",
        tools=_SKILLS_AUTHOR,
        prompt=SKILLS_AUTHOR_PROMPT,
        # ALL-OF hints (see `manager._matches`): the discriminator against the
        # read-only sibling is an AUTHORING VERB somewhere in a sentence that is
        # already about skills — not a contiguous phrase. The contiguous list
        # alone sent "create a small draft skill called self-test-demo" to
        # `skills.use`, which answered that it has no create verb (self-test
        # 2026-08-01, wave 2). Safe to be this broad because siblings are scored
        # only WITHIN their own domain: the ask already reached `ask_skills_agent`.
        hints=(
            "create+skill", "make+skill", "write+skill", "build+skill",
            "author+skill", "new+skill", "draft+skill", "add+skill",
            "edit+skill", "update+skill", "change+skill", "modify+skill",
            "improve+skill", "rename+skill", "delete+skill", "remove+skill",
            "turn this into a skill",
            "צור+מיומנות", "כתוב+מיומנות", "בנה+מיומנות", "חדשה+מיומנות",
            "ערוך+מיומנות", "עדכן+מיומנות", "מחק+מיומנות",
        ),
        group="skills",
    ),
    AgentSpec(
        id="connectors.admin",
        # inspect then edit a small fixed set of server configs.
        flow=Flow(),
        label="Connector setup agent",
        tools=MCP_MANAGEMENT_TOOL_NAMES,
        prompt=CONNECTORS_ADMIN_PROMPT,
        # ADMINISTRATIVE INTENT ONLY — never the bare subject noun. Live QA
        # 2026-07-24: "get the price for NVDA from the Yahoo connector" scored
        # this agent 2 (on "connector") against 0 for the sibling that owns
        # search_mcp_tools/run_mcp_tool, so a plain lookup was handed to the
        # SETUP agent, which answered "the Yahoo tools weren't in its toolbox"
        # and did nothing. Any sentence that merely NAMES a connector while
        # asking to use one must fall through to `connectors.use` (the domain's
        # first member, so a 0–0 tie already lands there).
        hints=(
            "add connector", "add a connector", "add an mcp", "add mcp",
            "new connector", "install connector", "install a connector",
            "install mcp", "connect a new", "set up connector",
            "set up a connector", "set up the connector", "configure connector",
            "configure the connector", "connector settings", "connector config",
            "mcp config", "mcp server", "remove connector", "remove the connector",
            "delete connector", "disable connector", "enable connector",
            "reconnect", "list connectors", "list my connectors",
            "which connectors", "what connectors", "my connectors",
            # "mcp connector(s)" as a NAMED SUBJECT is administrative talk —
            # someone using a connector says "the Yahoo connector", not "my MCP
            # connectors". The bare "mcp" is still not a hint.
            "mcp connector", "show connectors", "see connectors", "view connectors",
            "הוסף מחבר", "התקן מחבר", "הגדר מחבר", "הגדרות מחבר", "מחק מחבר",
            "הסר מחבר", "אילו מחברים", "רשימת מחברים", "המחברים שלי",
        ),
        group="connectors",
    ),
    AgentSpec(
        id="connectors.use",
        # discover the tool, invoke it, CHECK, report.
        #
        # `react_verify`, not plain `react` (2026-07-27). This is the agent that
        # sends email and Slack messages, i.e. the least reversible thing in the
        # roster, and it was the one worker doing outbound effects with no
        # ground-truth gate at all — a `run_mcp_tool` that ERRORED still reached
        # the user as "sent". `run_mcp_tool` is in `graphs.WRITE_TOOLS`, so the
        # same predicate that catches a claimed file write now catches a claimed
        # send: evidence is recorded on success only.
        template="react_verify",
        flow=Flow(),
        label="Connector agent",
        tools=("search_mcp_tools", "run_mcp_tool"),
        prompt=CONNECTORS_USE_PROMPT,
        hints=(
            "send ", "post ", "email", "mail", "slack", "calendar", "notion",
            "github", "jira", "שלח ", "מייל", "יומן", "לוח שנה",
        ),
        # No group: the user connected those servers explicitly, so the proxy
        # pair is ALWAYS offered when served (pre-registry behavior preserved);
        # routing here just adds the sharper prompt/label.
    ),
    AgentSpec(
        id="media.transcribe",
        # probe status, retranscribe, report.
        flow=Flow(
            probe="stt_status",
            # Matched against Rust-authored result text; the gate fails OPEN so
            # drifting wording costs us today's behaviour, never a false
            # refusal. Parity-locked by test_transcribe_blockers_match_rust.
            blockers=("not installed", "no speech model", "unavailable"),
            blocked_answer=(
                "MISSING: the on-device speech model is not installed, so "
                "nothing can be transcribed until it is."
            ),
        ),
        # Was "oneshot" (ONE tool round) while TRANSCRIBE_PROMPT tells it
        # "stt_status ... check it before promising anything". An agent that
        # OBEYED its own prompt spent its single round on the probe and could
        # never reach retranscribe_file — the prompt and the template were in
        # direct contradiction. Now the probe is deterministic and free, so the
        # model round is available for the actual work.
        template="probe_gate_act",
        label="Transcription agent",
        # NOT transcribe_audio (it takes base64 bytes from the recorder UI)
        # and NOT rec_retranscribe (it drives a live recording session) — an
        # agent can supply neither. Re-transcribing a room FILE is the
        # operation it can actually perform.
        tools=("stt_status", "retranscribe_file"),
        prompt=TRANSCRIBE_PROMPT,
        # VERBS, plus the noun only when the sentence asks for a transcript to
        # be MADE (or made again). The bare noun "transcript" used to be a hint,
        # and it is what a user says when they want to READ one: "summarize the meeting
        # transcript" scored here 1-0 against the hintless File agent and was
        # briefed to re-run the speech model on a file it was asked to
        # summarize. ("re-transcribe" was also redundant — it contains
        # "transcribe".)
        hints=(
            "transcribe", "transcription", "תמלל", "תמלול",
            # ALL-OF (see `manager._matches`): noun + a remake verb/complaint.
            "transcript+redo", "transcript+again", "transcript+wrong",
            "transcript+missing", "transcript+no ", "transcript+fix",
            "transcript+bad", "transcript+poor", "transcript+empty",
            # …and the ask that wants one MADE without saying "transcribe"
            # ("make me a transcript of the standup"). The tell is the
            # INDEFINITE article: you ask for "a transcript" when it does not
            # exist yet and for "THE transcript" when you want to read the one
            # that does. These stay CONTIGUOUS phrases on purpose — the obvious
            # ALL-OF spelling (transcript+make / +create / +need) re-opens the
            # false positive the pairs above were narrowed to close, and worse:
            # "make flashcards from the transcript" would match it, and because
            # the last tie-break rung prefers the LONGEST matched hint, the
            # 15-character pair beats creator.studio's "flashcard" outright.
            "a transcript of", "me a transcript", "new transcript",
        ),
    ),
    AgentSpec(
        id="media.video",
        # This agent used to carry a deliberately small round budget: every
        # round can pull a full FRAME IMAGE into context, so its budget was a
        # CONTEXT budget as much as a work budget. The per-agent budgets were
        # removed (2026-07-27, owner call), so nothing bounds frame accumulation
        # here any more — if long video sessions start context-shifting, this is
        # the agent to give an image-aware trim (the `trim_images` node
        # `perceive_act` uses) rather than to give a round cap back.
        flow=Flow(),
        # Not `perceive_act`: that shape opens with a constant probe and keeps
        # exactly ONE live image (right for a screen, whose past states are
        # worthless). A video agent has no constant opening move — the frame it
        # wants depends on the question — and comparing two moments is the
        # normal case, so the frames must stay.
        template="react",
        label="Video agent",
        # One tool, deliberately. The value of this box is not its size — it is
        # that SOMEBODY owns watching, with CORE's search_room (which returns
        # the transcript's [m:ss] stamps) as the way in.
        tools=("view_media_frame",),
        prompt=VIDEO_PROMPT,
        # Substring matching with no word boundaries, so a bare "frame" claims
        # "framework" and "the clip" claims "the clipboard" (both caught by
        # test_watching_a_video_reaches_the_video_agent_not_the_transcriber).
        # Every short stem here is anchored; a sentence-final "the clip" is
        # deliberately left to the default worker rather than widened back.
        hints=(
            "video", "footage", "clip ", "scene", "watch",
            "frame at", ".mp4", ".mov", "on screen at",
            "וידאו", "סרטון", "קליפ", "סצנה", "פריים",
        ),
    ),
    AgentSpec(
        id="creator.studio",
        # Three mutually exclusive terminal generators, each with its own hint
        # vocabulary — the clearest sub-action routing in the registry. The
        # product already asks for this: STUDIO_PROMPT says "One well-made
        # artifact beats several thin ones", which is the product requesting a
        # router and getting a tool loop. On a tie route_action abstains and the
        # model picks among all three, exactly as before.
        flow=Flow(
            actions=(
                Action(
                    tool="studio_flashcards",
                    hints=("flashcard", "flash card", "quiz", "revise", "memoris",
                           "memoriz", "כרטיסי"),
                ),
                Action(
                    tool="studio_mindmap",
                    hints=("mind map", "mindmap", "diagram", "map out", "concept map",
                           "מפת חשיבה"),
                ),
                Action(
                    tool="generate_podcast_script",
                    hints=("podcast", "script", "episode", "dialogue", "narrat",
                           "פודקאסט"),
                ),
            ),
            keep=("list_room_files", "search_room", "open_file"),
        ),
        template="route_act",
        label="Studio agent",
        # stage_preview_html is a UI staging call, not an agent verb.
        tools=("studio_flashcards", "studio_mindmap", "generate_podcast_script"),
        prompt=STUDIO_PROMPT,
        # "study" was a bare hint, and it is an ordinary English verb for
        # READING something carefully: "study the lease" scored here 1-0 against
        # the hintless File agent and was briefed to generate flashcards. Only
        # the phrases that name a study ARTIFACT survive.
        hints=(
            "flashcard", "flash card", "mind map", "mindmap", "podcast", "quiz",
            "study guide", "study aid", "study material", "help me study",
            "כרטיסי", "מפת חשיבה",
        ),
    ),
)

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
assert set(GROUPS) <= set(TOOL_GROUP_LABELS), (
    "every request_tools group needs a prompts.TOOL_GROUP_LABELS row; missing="
    f"{sorted(set(GROUPS) - set(TOOL_GROUP_LABELS))}"
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
        ("files.read", "scripts.run", "media.transcribe", "media.video", "creator.studio"),
        "Ask the File agent to work with this room's content: list, search, "
        "read, open, summarize, create or edit files and notes, run this "
        "room's .py/.js scripts, transcribe its audio and video on-device, "
        "WATCH a video and report what is on screen at any moment, and "
        "turn its material into flashcards, a mind map or a podcast script. "
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
        ("app.ui",),
        "Ask the App agent to see or operate this app's own interface: open "
        "views, click buttons, show the user around.",
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
    if spec.id in WEB_DEPENDENT_AGENT_IDS and not web_enabled:
        return False
    # A box whose load-bearing tools are missing is dead however much of the
    # REST of it was served — the any-one-of-them test below cannot see that,
    # because to it one tool is as good as another. See `AgentSpec.requires`.
    if not set(spec.requires) <= served_names:
        return False
    if not spec.tools:
        # CORE-only workers (the File agent) ride the always-served base.
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


#: The ONE argument every delegation carries, per-domain and per batch task
#: alike. The two were hand-typed separately and differed only in where the
#: lines wrapped — the sentence a model reads was already byte-identical, so
#: there is one copy and no chance of them drifting apart.
_INSTRUCTION_PARAM: dict[str, str] = {
    "type": "string",
    "description": (
        "What you need this agent to do, as one clear task. Name the files "
        "or targets."
    ),
}


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

_BY_ID: dict[str, AgentSpec] = {spec.id: spec for spec in REGISTRY}


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


__all__ = [
    "AGENT_TOOL_DOMAINS",
    "AGENT_TOOL_NAMES",
    "BATCH_TOOL_NAME",
    "DOMAIN_BLURBS",
    "DOMAIN_KEYS",
    "DOMAIN_KEY_ORDER",
    "AgentSpec",
    "CORE_TOOLS",
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
    "worker_reachable",
    "group_tools",
    "toolbox_for",
]
