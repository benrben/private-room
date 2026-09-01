"""Declarative agent registry, part 1."""

from __future__ import annotations

from .agent_domains import DOMAIN_KEY_ORDER, main_prompt
from .agent_registry_common import _JOBS_RUN, _JOBS_WORKFLOWS
from .agent_types import Action, AgentSpec, Flow
from .prompts import (
    BROWSE_PROMPT,
    FILE_PASS_PROMPT,
    FILES_PROMPT,
    SCRIPTS_PROMPT,
    UI_PROMPT,
    WEB_PROMPT,
    WORKFLOWS_PROMPT,
)
from .routing import (
    BROWSE_TOOL_NAMES,
    DOWNLOAD_TOOL_NAMES,
    ORGANIZE_TOOL_NAMES,
    UI_TOOL_NAMES,
)

REGISTRY_1: tuple[AgentSpec, ...] = (
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
        tag="file",
        area="this room's own files and notes",
        summary=(
            "Lists, searches, reads, opens, summarizes, creates and edits the "
            "files, notes and memories in this room — and organizes them: "
            "filing into folders, renaming, merging, and deleting to the trash."
        ),
        # CORE (read + write verbs) plus the ORGANIZE box. Three tools against a
        # cap of seven, so this agent keeps room to grow.
        #
        # These are boxed on THIS agent rather than added to CORE deliberately.
        # CORE is offered to every worker, and "may reorganize and delete the
        # user's files" is not a power the web agent, the browser agent or the
        # transcriber has any use for — a tool nobody in that seat should call
        # is a tool that will eventually be called from it.
        #
        # A room whose engine tier is not served these (a consulted advisor)
        # simply gets a File agent without them: `toolbox_for` intersects the
        # box with what the host serves, so the box degrades rather than
        # advertising a verb the bridge would then refuse.
        tools=(*ORGANIZE_TOOL_NAMES, "view_file_image"),
        # Reading and editing this room's files is the job; organizing them is
        # an addition. Without this the File agent — the room's DEFAULT worker —
        # would go unreachable on any tier that withholds the organize box.
        core_capable=True,
        prompt=FILES_PROMPT,
        # Domain-level signals for requests that explicitly name Arcelle's
        # workspace/filesystem surface.  Keep these namespace-shaped rather
        # than broad verbs such as "delete" or "move": those verbs also
        # describe skills, jobs and messages, while these phrases mean the
        # room's files unambiguously.  Besides sibling selection, the
        # deterministic planner reads the default member's hints to route a
        # small local model before it has to invent a delegation itself.
        hints=(
            "workspace_",
            "workspace file",
            "workspace folder",
            "filesystem",
            "room file",
            "files in this room",
        ),
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
        tag="scripts",
        area="this room's own .py and .js scripts",
        summary=(
            "Lists this room's own .py/.js scripts, runs one, and reports what "
            "it produced."
        ),
        tools=("list_scripts", "run_script"),
        # Listing alone cannot fulfill this specialist's advertised job. Under
        # Cloud Privacy `run_script` is intentionally absent, so require the
        # action verb and offer an explicit local handoff before dispatch.
        requires=("run_script",),
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
        tag="web",
        area="searching and reading the internet",
        summary=(
            "Searches the internet and fetches pages to read them — news, "
            "weather, prices, documentation — and downloads a file from a link "
            "you give it. It READS pages; it does not operate them."
        ),
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
        # `probe_unless`: BROWSE-3c. A `browse_open` carrying plain words
        # SEARCHES and leaves no page, so the precondition is "browse_open ran
        # AND it navigated". These two phrases are the host's, from
        # `format_hits_for_agent` in src-tauri/src/commands/browse/search.rs —
        # a Rust test pins them for exactly this reason.
        flow=Flow(
            probe="browse_snapshot",
            probe_after="browse_open",
            probe_unless=(
                "searched the room's own engines",
                "no results across seven engines",
            ),
        ),
        template="perceive_act",
        label="Browser agent",
        tag="browse",
        area="driving a real page in the private browser",
        summary=(
            "Opens a site in this room's private browser and OPERATES the live "
            "page: reads what is on it, clicks, fills forms, signs in and works "
            "through a site. Name the address or the site you mean."
        ),
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
        tag="app",
        area="this app's own interface",
        summary=(
            "Sees and operates Arcelle itself: opens views, clicks buttons and "
            "shows the user around the app."
        ),
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
        tag="jobs",
        area="whole-file background passes",
        summary=(
            "Runs a durable background pass over an ENTIRE file — translate or "
            "summarize a whole book — and reports how a running job is going."
        ),
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
            failure_markers=(
                "invalid", "cycle", "unknown node", "validation", "validated: no"
            ),
            repair_cap=2,
            receipt_after=("save_workflow", "update_workflow"),
            receipt_tool="test_workflow",
            receipt_marker="VALIDATED: yes",
            receipt_missing=(
                "the workflow draft was not validated: test_workflow did not "
                "return VALIDATED: yes. Do not say it was tested, fixed, or is "
                "ready to activate."
            ),
        ),
        template="recall_act_check",
        label="Workflow agent",
        tag="workflows",
        area="saved workflows and automation",
        summary=(
            "Creates, edits, tests, schedules and runs saved multi-step "
            "workflows — anything recurring, \"every morning\", \"every week\"."
        ),
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
)
