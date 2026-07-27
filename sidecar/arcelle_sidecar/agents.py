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

from dataclasses import dataclass

from .prompts import (
    CONNECTORS_ADMIN_PROMPT,
    CONNECTORS_USE_PROMPT,
    FILE_PASS_PROMPT,
    FILES_PROMPT,
    MAIN_PROMPT,
    SCRIPTS_PROMPT,
    SKILLS_AUTHOR_PROMPT,
    SKILLS_USE_PROMPT,
    STUDIO_PROMPT,
    TRANSCRIBE_PROMPT,
    UI_PROMPT,
    VIDEO_PROMPT,
    WEB_PROMPT,
    WORKFLOWS_PROMPT,
)
from .routing import (
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
    """One sub-agent, fully described as data."""

    #: Stable id, ``domain.name`` (e.g. ``"jobs.run"``).
    id: str
    #: Human label for step chips.
    label: str
    #: One-liner for the (future) constrained classifier and for docs.
    description: str
    #: Tools this agent ADDS on top of CORE. ≤ MAX_BOX_TOOLS; tests pin it.
    tools: tuple[str, ...]
    #: System-prompt paragraph appended while this agent is active ("" = the
    #: base prompt already covers it).
    prompt: str = ""
    #: Deterministic routing vocabulary (lowercase substrings, EN + Hebrew).
    hints: tuple[str, ...] = ()
    #: True when the box only reads/presents — the safe default lane.
    read_only: bool = False
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
        # Delegations one ask may chain, not work per specialist. Eight covers the
        # longest real pipeline seen in e2e (file -> jobs -> connector) with room
        # to spare; past that the Main agent is looping, not planning.
        flow=Flow(),
        # dispatches to specialists; never touches a room tool
        template="supervisor",
        label="Main agent",
        description="The user's single interlocutor: calls specialist agents "
        "for anything that needs the room or tools, answers directly what it "
        "knows, and composes every final answer itself.",
        tools=(),  # its ONLY tools are the ask_*_agent calls (agent_tool_specs)
        prompt=MAIN_PROMPT,
        read_only=True,
        main=True,
    ),
    AgentSpec(
        id="files.read",
        # Read/search/edit over many files genuinely varies. Twelve lets "fix the
        # typo in each of these five notes" finish; it no longer lets a stuck
        # loop run to 10,000.
        flow=Flow(),
        # mutates the user's room — claims get a ground-truth check
        template="react_verify",
        label="File agent",
        description="Read, search, open and edit the room's files — the default specialist.",
        tools=(),  # CORE alone (read + write verbs)
        prompt=FILES_PROMPT,
        read_only=False,
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
        description="See and run this room's .py/.js scripts (the user approves each new one).",
        tools=("list_scripts", "run_script"),
        prompt=SCRIPTS_PROMPT,
        hints=(
            "script", "run it", "run the", ".py", ".js", "python", "execute",
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
            keep=("search_room",),
        ),
        template="chain_stage",
        label="Web agent",
        description="Find or fetch current information from the internet.",
        tools=("web_search", "fetch_page"),
        hints=(
            "web", "online", "internet", "news", "latest", "google",
            "חפש ברשת", "באינטרנט", "חדשות", "מזג אוויר",
        ),
        prompt=WEB_PROMPT,
        read_only=True,
        # No group: web access is a ROOM SETTING, not something an agent may
        # unlock mid-turn.
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
        description="See and operate this app's own interface for the user.",
        tools=UI_TOOL_NAMES,
        prompt=UI_PROMPT,
        # Vocabulary: routing._UI_HINTS (Rust-parity) — wired in manager.py.
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
        description="Cover an ENTIRE file with a durable background job; report job status.",
        tools=_JOBS_RUN,
        prompt=FILE_PASS_PROMPT,
        # Vocabulary: routing._JOB_HINTS (Rust-parity) — wired in manager.py.
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
        description="Author, test, schedule or run saved multi-step workflows.",
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
        description="Find, read and run Agent Skills.",
        tools=_SKILLS_USE,
        prompt=SKILLS_USE_PROMPT,
        hints=("skill", "agent instruction", "מיומנות", "סקיל"),
        read_only=True,
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
        description="Create, modify or delete Agent Skills (drafts, human-reviewed).",
        tools=_SKILLS_AUTHOR,
        prompt=SKILLS_AUTHOR_PROMPT,
        hints=(
            "create a skill", "new skill", "edit the skill", "update the skill",
            "delete the skill", "turn this into a skill", "מיומנות חדשה", "צור מיומנות",
        ),
        group="skills",
    ),
    AgentSpec(
        id="connectors.admin",
        # inspect then edit a small fixed set of server configs.
        flow=Flow(),
        label="Connector setup agent",
        description="Inspect or configure MCP connector integrations (drafts only).",
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
        description="Reach the user's connected third-party tools (email, calendar, chat…).",
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
        description="Transcribe or re-transcribe audio/video on-device.",
        # NOT transcribe_audio (it takes base64 bytes from the recorder UI)
        # and NOT rec_retranscribe (it drives a live recording session) — an
        # agent can supply neither. Re-transcribing a room FILE is the
        # operation it can actually perform.
        tools=("stt_status", "retranscribe_file"),
        prompt=TRANSCRIBE_PROMPT,
        hints=("transcribe", "transcript", "re-transcribe", "תמלל", "תמלול"),
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
        description="Watch a room video: look at what is on screen at a moment.",
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
        read_only=True,
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
        description="Generate flashcards, mind maps or podcast scripts from room content.",
        # stage_preview_html is a UI staging call, not an agent verb.
        tools=("studio_flashcards", "studio_mindmap", "generate_podcast_script"),
        prompt=STUDIO_PROMPT,
        hints=("flashcard", "mind map", "mindmap", "podcast", "study", "כרטיסי", "מפת חשיבה"),
    ),
)

#: Sub-agent boxes may not exceed this (CORE is exempt — its size is dictated
#: by the byte-stable Rust prompt, not by choice).
MAX_BOX_TOOLS = 6

#: The default WORKER for a clause nothing claims: the File agent (CORE
#: read+write) — every ask is delegated to a specialist; the main agent
#: (``MAIN_AGENT_ID``) only ever synthesizes.
DEFAULT_AGENT_ID = "files.read"

#: The user's single interlocutor (hub-and-spoke; see AgentSpec.main).
MAIN_AGENT_ID = "chat.answer"

#: The request_tools groups, in stable order (drives the unlock enum).
GROUPS: tuple[str, ...] = ("app_ui", "jobs", "skills", "connectors")

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
        ("chat.web",),
        "Ask the Web agent to search the internet or fetch a page for current "
        "or outside information (news, weather, prices, docs).",
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
    if spec.id == "chat.web":
        return web_enabled
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


def agent_tool_specs(*, web_enabled: bool, served_names: set[str]) -> list[dict]:
    """The main agent's tool catalog: one entry per REACHABLE domain.

    A domain is reachable when some member worker could actually act — its box
    intersects the served catalog (the File agent's box is CORE, which the
    bridge always serves in agent scope). Web is a room setting.
    """
    out: list[dict] = []
    for name, members, description in AGENT_TOOL_DOMAINS:
        if not reachable_members(members, web_enabled=web_enabled, served_names=served_names):
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "instruction": {
                                "type": "string",
                                "description": (
                                    "What you need this agent to do, as one "
                                    "clear task. Name the files or targets."
                                ),
                            }
                        },
                        "required": ["instruction"],
                    },
                },
            }
        )
    if not out:
        return out
    keys = sorted(k for k, name in DOMAIN_KEYS.items() if any(o["function"]["name"] == name for o in out))
    out.append(
        {
            "type": "function",
            "function": {
                "name": BATCH_TOOL_NAME,
                "description": (
                    "Ask SEVERAL specialists in ONE call. Prefer this whenever "
                    "the request has more than one part: tasks that do not "
                    "depend on each other run AT THE SAME TIME, so the whole "
                    "batch costs as long as its slowest task instead of the "
                    "sum. Use depends_on only when a task genuinely needs an "
                    "earlier task's findings — those wait, everything else "
                    "runs together."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "description": "The tasks to run, in any order.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "agent": {
                                        "type": "string",
                                        "enum": keys,
                                        "description": (
                                            "Which specialist: file = this "
                                            "room's content, scripts, "
                                            "transcripts, studio; web = the "
                                            "internet; app = this app's "
                                            "interface; jobs = workflows and "
                                            "whole-file passes; skills = agent "
                                            "skills; connector = connected "
                                            "services."
                                        ),
                                    },
                                    "instruction": {
                                        "type": "string",
                                        "description": (
                                            "What you need this agent to do, as "
                                            "one clear task. Name the files or "
                                            "targets."
                                        ),
                                    },
                                    "depends_on": {
                                        "type": "array",
                                        "items": {"type": "integer"},
                                        "description": (
                                            "Positions (0-based) of tasks in "
                                            "THIS list whose findings this task "
                                            "needs. Leave empty when it can run "
                                            "immediately."
                                        ),
                                    },
                                },
                                "required": ["agent", "instruction"],
                            },
                        }
                    },
                    "required": ["tasks"],
                },
            },
        }
    )
    return out


# --------------------------------------------------------------------------- #
# lookups
# --------------------------------------------------------------------------- #

_BY_ID: dict[str, AgentSpec] = {spec.id: spec for spec in REGISTRY}


def get_agent(agent_id: str) -> AgentSpec:
    """The spec for ``agent_id``; unknown ids degrade to the read-only default
    (a stale/foreign id must never crash a turn)."""
    return _BY_ID.get(agent_id) or _BY_ID[DEFAULT_AGENT_ID]


def available_agents(*, web_enabled: bool) -> list[AgentSpec]:
    """WORKER agents the manager may route to this run. The main agent is
    never a routing candidate — it only synthesizes (run_agent appends it)."""
    return [
        spec
        for spec in REGISTRY
        if spec.available and not spec.main and (spec.id != "chat.web" or web_enabled)
    ]


def group_tools(group: str) -> set[str]:
    """Every tool behind one request_tools group."""
    out: set[str] = set()
    for spec in REGISTRY:
        if spec.group == group and spec.available:
            out |= set(spec.tools)
    return out


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
    "DOMAIN_KEYS",
    "AgentSpec",
    "CORE_TOOLS",
    "DEFAULT_AGENT_ID",
    "MAIN_AGENT_ID",
    "GROUPS",
    "agent_tool_specs",
    "MAX_BOX_TOOLS",
    "REGISTRY",
    "available_agents",
    "get_agent",
    "group_prompt",
    "reachable_members",
    "worker_reachable",
    "group_tools",
    "toolbox_for",
]
