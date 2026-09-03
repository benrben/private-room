"""Deterministic tool routing — ported VERBATIM from the Rust.

Source of truth: the routing predicates in ``src-tauri/src/commands/agent.rs``,
referenced by name (line numbers rot) so they stay findable:
  - ``wants_write_tools`` — offer the file-mutating built-ins this turn?
  - ``wants_ui_tools``    — offer the UI/perception tools?
  - ``wants_job_tools``   — offer the whole-file pass + workflow tools?
  - ``wants_skill_tools`` — offer Agent Skill CRUD/resource tools?
  - ``wants_mcp_management_tools`` — offer connector CRUD tools?

``WRITE_TOOL_NAMES`` and ``lane_label`` below have no agent.rs counterpart: the
Rust inlines its hint lists inside each predicate and computes no lane label, so
only those five predicates — plus the tool-name reservations in agent.rs
``BUILTIN_TOOL_NAMES`` — need to stay in sync.

These are NOT model-driven: they are case-insensitive substring matches on the
raw user question. A small model picks the right tool far more reliably from a
short, relevant list, so the UI / job / management tools are withheld unless the
question sounds like it wants them. Erring toward YES is safe — it just restores
the fuller catalog. Three deliberate softenings of that doctrine (2026-07-23,
after live QA showed the agent "not knowing" it could save files):

* **The write tools are ALWAYS offered.** The Rust base system prompt teaches
  create_file/edit_file/… by name on every turn, so withholding the schemas made
  the prompt and the catalog contradict each other — the model claimed it could
  not save, or hallucinated calls. ``wants_write_tools`` now feeds only the
  cosmetic lane label.
* **Lanes latch per conversation** (Rust ``sidecar.rs`` ORs the routers over the
  chat's prior user turns) — "now save that as a workflow" keeps the jobs tools
  even when THIS phrasing has no keyword.
* **``request_tools`` is the escape hatch** (graph.py): a always-on mini-tool the
  model can call to unlock a lane the keywords missed entirely.

The hint lists include Hebrew equivalents: the matchers are plain substring
tests, so a Hebrew question ("שמור את זה כקובץ") must find Hebrew hints or a
lane can never fire for a Hebrew-speaking user.

The hint lists are product behaviour. If you change one here, change the Rust in
the same commit or the two engines drift. They are also PUBLIC (they lost their
leading underscore on 2026-07-30): ``manager.py`` scores ``jobs.run`` against
its sibling on ``JOB_HINTS`` rather than duplicating the list in the registry,
and ``agents.py`` cites them by name. An underscore that another module imports
across the boundary is a lie about the name's reach — this vocabulary is part of
what the module ships.

``UI_HINTS`` used to be named here as a second such consumer. It never was one:
``app`` is a single-member domain, so ``manager.resolve_worker`` returns
``app.ui`` before any scoring runs and the row that claimed to wire it in was
dead (removed 2026-08-01). Inside this module the list is very much alive — it
is what :func:`wants_ui_tools` matches on, and it is parity-locked to agent.rs.
"""

from __future__ import annotations

#: The file-MUTATING built-ins. Since 2026-07-23 they are ALWAYS offered (the
#: base system prompt teaches them by name every turn, so the catalog must
#: agree); the list is kept for the lane label, tests, and the name
#: reservations in agent.rs `BUILTIN_TOOL_NAMES`. Note `annotate_file` /
#: `mark_image` are deliberately NOT in this list —
#: they show the user something, they don't change a file.
WRITE_TOOL_NAMES: tuple[str, ...] = (
    "create_file",
    "edit_file",
    "edit_files",
    "write_file",
    "set_cells",
    "rename_file",
    "move_file",
    "add_memory",
)

#: The File agent's ORGANIZE box — tidying, deleting into the trash, merging.
#: Mirrors ``commands::agent::organize_tools_specs`` on the Rust side; the host
#: serves them only to the engine tiers (``include_organize_tools``), never to a
#: merely consulted advisor, so a room whose main engine is an advisor simply
#: never sees this box and the File agent degrades to its read/write CORE.
#:
#: NOT folded into ``WRITE_TOOL_NAMES``. Those are always-offered because the
#: base system prompt teaches them by name every turn; these are boxed on one
#: agent, and ``trash_files`` in particular must stay separately nameable — the
#: lane label and the host log are how "what did the AI delete" stays
#: answerable, and a verb hidden inside a general write set is not answerable.
ORGANIZE_TOOL_NAMES: tuple[str, ...] = (
    "organize_files",
    "trash_files",
    # Whether Home's Library also lists an object the user made inside a
    # destination. Organization, exactly like a move: it changes where a thing
    # is FOUND and nothing about the thing. Boxed here rather than added to
    # WRITE_TOOL_NAMES because those are taught by name in the base prompt every
    # turn — and a verb the model is reminded of on every turn is a verb it will
    # eventually apply to every output, which is precisely what the tool's own
    # description forbids.
    "set_in_library",
    "merge_files",
)

#: The Sketch page's drawing box. Two tools, because `draw` takes a WHOLE
#: script — every shape in one call — rather than one call per shape, and
#: `read_drawing` both reads the page and measures what is wrong with it.
DRAW_TOOL_NAMES: tuple[str, ...] = (
    "draw",
    "read_drawing",
)

#: Agent Skills are a distinct administrative surface. They are withheld until
#: the user asks about a skill, so ordinary chat does not carry their CRUD,
#: resource, or script schemas.
SKILL_TOOL_NAMES: tuple[str, ...] = (
    "list_skills",
    "read_skill",
    "read_skill_resource",
    "save_skill",
    "write_skill_resource",
    "delete_skill_resource",
    "delete_skill",
    "run_skill_script",
)

#: Connector CRUD is local-agent-only at the bridge layer and also withheld
#: from normal chat. `save_mcp` produces a disabled draft; it cannot start a
#: local command or contact a new remote endpoint.
MCP_MANAGEMENT_TOOL_NAMES: tuple[str, ...] = (
    "list_mcps",
    "read_mcp",
    "save_mcp",
    "delete_mcp",
)

#: The UI/perception tools (ADD-25). Never in the bridge's cloud scope.
UI_TOOL_NAMES: tuple[str, ...] = (
    "ui_snapshot",
    "ui_act",
    "view_screenshot",
    "view_media_frame",
)

#: Skin Studio's typed visual-system box. These are separate from app.ui:
#: changing the skin is a data-model operation with revisions and permissions,
#: not a sequence of screen clicks.
DESIGN_TOOL_NAMES: tuple[str, ...] = (
    "read_skin",
    "update_skin_draft",
    "undo_skin_change",
    "validate_skin",
    "save_skin",
)

#: BROWSE-1: the private browser's tools. Mirrors
#: ``commands::browse::BROWSE_TOOL_NAMES`` on the Rust side — the host only
#: serves these when the room's web setting is on, so a browser box is
#: automatically unreachable in a web-disabled room without a special case.
BROWSE_TOOL_NAMES: tuple[str, ...] = (
    "browse_open",
    "browse_read",
    "browse_find",
    "browse_snapshot",
    "browse_do",
    "browse_look",
    # BROWSE-2: capture the live page (or the user's selection) into the room.
    "browse_save",
)

#: BROWSE-2 (D17): fetch web content INTO the room. The host serves these with
#: the same web gate as the browse tools. Boxed on ``chat.web`` only: the
#: Browser agent ingests by CLICKING download links (the browser imports the
#: file automatically) and by ``browse_save`` — its box stays within the
#: small-model choice budget.
DOWNLOAD_TOOL_NAMES: tuple[str, ...] = (
    "save_link",
    "download_url",
    "download_media",
)

#: NAVIGATION INTENT — "take me to a place on the web", as opposed to "find out
#: something from the web". When the Browser agent is reachable, ANY of these
#: sends the ask to it outright, ahead of all hint scoring.
#:
#: THE BUG THIS EXISTS FOR (owner report 2026-07-30): "go to Google and search
#: for X" routed to the SEARCH agent. Both siblings scored 2 — `go to` for the
#: browser, `google` for search — and the tie fell to the longest matched hint,
#: where "google" (6) beats "go to" (5). So the single most natural way to ask
#: for the browser reliably got the thing that is not the browser, and the
#: search agent then answered from a snippet of a page it never opened.
#:
#: Scoring cannot fix this, because the two lists overlap by design: a
#: destination is very often a site whose NAME is also a search word. Navigation
#: intent is not one more hint to weigh, it is a decision already made by the
#: user — so it is a gate in front of the scorer, not an entry in it.
#:
#: Deliberately verbs and prepositions ONLY — never bare site names. "google
#: the tallest building" is a search and must stay one; "go to google" is a
#: destination. The verb is the whole signal.
NAV_INTENT: tuple[str, ...] = (
    # English: the verb, plus the "…to" forms people actually type. Both
    # "go to" and "going to" are needed — neither is a substring of the other.
    "go to",
    "goto",
    "going to",
    "browse to",
    "browse ",
    "navigate to",
    "navigate ",
    "open the site",
    "open the page",
    "open the url",
    "open up",
    "visit",
    "pull up",
    "head to",
    "head over to",
    "take me to",
    "load the page",
    "load up",
    # ANCHORED (2026-08-01). A bare "surf" is a substring of "surface", and this
    # gate wins outright ahead of all scoring — so "what is the surface
    # temperature of Mars" was a navigation instruction and the Browser agent
    # had to guess an address for a plain web question. The verb only ever
    # appears as "surf the web" / "surf reddit" / "surfing", all of which the
    # two anchored forms below still catch.
    "surf ",
    "surfing",
    "on the browser",
    "in the browser",
    "use the browser",
    "with the browser",
    # Hebrew: same split — an imperative form and a "to the site" form.
    "כנס ל",
    "היכנס ל",
    "תיכנס ל",
    "לך ל",
    "גלוש",
    "פתח את האתר",
    "פתח את הדף",
    "נווט ל",
    "בדפדפן",
    "עם הדפדפן",
)


def wants_navigation(text: str) -> bool:
    """Did the user ask to GO somewhere, rather than to find something out?

    Substring matching like every other router here. A false positive costs a
    page open where a search would have done; a false negative is the bug above.
    """
    q = text.lower()
    return any(h in q for h in NAV_INTENT)

#: The whole-file pass tools (ADD-32) plus the workflow CRUD/run tools.
#: These MUST be dropped when the jobs router does not fire (graph._filter_catalog
#: is a drop-list) — else they'd bloat every turn's catalog and defeat the
#: short-catalog doctrine. Kept in sync with agent.rs BUILTIN_TOOL_NAMES.
JOB_TOOL_NAMES: tuple[str, ...] = (
    "start_file_pass",
    "job_status",
    "list_workflows",
    "save_workflow",
    "update_workflow",
    "delete_workflow",
    "run_workflow",
    "test_workflow",
)

#: Offered only when the host marks this run as a top-level turn with an
#: installed advisor. Consulted advisors receive a separate bridge without this
#: capability, so they cannot recursively consult another advisor.
ADVISOR_TOOL_NAMES: tuple[str, ...] = ("consult_advisor",)

# --- hint lists, verbatim from the Rust -------------------------------------

WRITE_HINTS: tuple[str, ...] = (
    "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
    "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
    "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
    "translate", "highlight", "mark ", "annotate", "draft", "generate",
    "move ", "rename", "organize", "organise", "put ", "folder", "sort ", "tidy",
    # Hebrew (substring matchers see no word boundaries, so stems suffice):
    "ערוך", "עריכה", "שנה", "תקן", "עדכן", "כתוב", "צור ", "שמור", "שמרי",
    "מחק", "הוסף", "תרגם", "סמן", "זכור", "תזכור", "רשום", "העבר", "תיקיה",
    "תיקייה", "טיוטה", "קובץ חדש",
)

UI_HINTS: tuple[str, ...] = (
    "click", "press ", "button", "screenshot", "screen", "scroll", "navigate",
    "menu", "sidebar", "watch", "frame", "video", "look at", "looking at",
    "interface", "use the app", "the app", "type in", "toggle", "what do you see",
    "what am i", "on screen",
    # "open the Room Map" / "switch to the Detail tab" / "generate flashcards"
    # matched none of the above, so ui_act was never offered and the agent
    # couldn't drive the app at all. App surfaces and navigation verbs:
    "open ", "show me", "go to", "switch", "close ", "map", "panel", "tab",
    "studio", "flashcard", "mind map", "mindmap", "podcast", "front page",
    "dashboard", "play", "pause", "image", "photo", "picture",
    # Hebrew navigation/operation verbs and surfaces:
    "לחץ", "לחצי", "פתח", "פתחי", "הצג", "הציגי", "מסך", "צילום מסך", "גלול",
    "כפתור", "סרטון", "וידאו", "תמונה", "סגור", "עבור אל", "תפריט", "לוח",
)

JOB_HINTS: tuple[str, ...] = (
    "whole", "entire", "entirely", "all of", "every ", "everything", "full",
    "fully", "complete", "completely", "cover", "thorough", "in depth",
    "in-depth", "translate", "book", "throughout", "end to end", "cover to cover",
    "start to finish", "page by page", "chapter", "long file", "large file",
    "big file", "deep", "job", "progress", "background", "pass", "digest",
    "no matter", "don't miss", "do not miss", "line by line",
    # Wave 4a: the workflow authoring tools ride the jobs routing flag.
    "workflow", "automate", "automat", "every morning", "every day", "every week",
    "each morning", "each day", "schedule", "recurring", "routine", "pipeline",
    # Hebrew whole-file / automation intents:
    "כל הקובץ", "הקובץ כולו", "כולו", "את כל", "הכל", "הספר", "יסודי", "מקיף",
    "לעומק", "ברקע", "משימת רקע", "תהליך", "אוטומצ", "אוטומט", "תזמן", "מתוזמן",
    "כל בוקר", "כל יום", "כל שבוע", "פרק אחר פרק", "שורה אחר שורה",
)

SKILL_HINTS: tuple[str, ...] = ("skill", "agent instruction", "מיומנות", "סקיל")

MCP_MANAGEMENT_HINTS: tuple[str, ...] = (
    "mcp", "connector", "connectors", "integration", "integrations",
    "מחבר", "מחברים", "אינטגרצ",
)


def _any_hint(question: str, hints: tuple[str, ...]) -> bool:
    q = question.lower()
    return any(h in q for h in hints)


def wants_write_tools(question: str) -> bool:
    """Offer the file-mutating built-ins this turn? (agent.rs `wants_write_tools`)"""
    return _any_hint(question, WRITE_HINTS)


def wants_ui_tools(question: str) -> bool:
    """Offer the UI/perception tools (and their system-prompt paragraph)? (agent.rs `wants_ui_tools`)"""
    return _any_hint(question, UI_HINTS)


def wants_job_tools(question: str) -> bool:
    """Offer the whole-file pass tools (and their paragraph)? (agent.rs `wants_job_tools`)"""
    return _any_hint(question, JOB_HINTS)


def wants_skill_tools(question: str) -> bool:
    """Offer Agent Skill CRUD/resource tools only for a skill request."""
    return _any_hint(question, SKILL_HINTS)


def wants_mcp_management_tools(question: str) -> bool:
    """Offer connector CRUD only when the user asks about MCP/connectors."""
    return _any_hint(question, MCP_MANAGEMENT_HINTS)


#: The two workers whose whole job is the internet, and what the chip should say
#: while each one holds the turn. Keyed off the ACTIVE agent because the routing
#: booleans cannot tell these apart: `web_enabled` only means the room ALLOWS the
#: web, so a live search read "Answering (web available)" and a room whose
#: question also tripped the write hints read "Working on your files" while the
#: app was in fact clicking through pages. The label's whole job is making an odd
#: answer explainable, and those two were the odd answers.
_WEB_AGENT_LABELS: dict[str, str] = {
    "chat.web": "Searching the web",
    "chat.browse": "Browsing the web",
}


def lane_label(*, ui: bool, write: bool, web_enabled: bool, agent_id: str = "") -> str:
    """The lane shown to the user, so an odd answer is explainable (Python-only —
    no agent.rs counterpart).

    Purely cosmetic. Order matters: the internet workers win outright (they are
    named by the ACTIVE agent, which is more specific than any hint match), then
    UI over write, write over web.

    Takes the RESOLVED routing booleans (not the raw question) so the chip always
    matches the catalog the model was actually offered. In the Rust these are the
    same ``wants_*`` calls on the same question and cannot disagree; in the sidecar
    the host can override routing (SPEC §5), and the label must follow the override
    or the user sees "Using the app" while the UI tools were withheld.
    """
    if agent_id in _WEB_AGENT_LABELS:
        return _WEB_AGENT_LABELS[agent_id]
    if ui:
        return "Using the app"
    if write:
        return "Working on your files"
    if web_enabled:
        return "Answering (web available)"
    return "Answering"


__all__ = [
    "WRITE_TOOL_NAMES",
    "ORGANIZE_TOOL_NAMES",
    "SKILL_TOOL_NAMES",
    "MCP_MANAGEMENT_TOOL_NAMES",
    "UI_TOOL_NAMES",
    "BROWSE_TOOL_NAMES",
    "NAV_INTENT",
    "JOB_TOOL_NAMES",
    "ADVISOR_TOOL_NAMES",
    "WRITE_HINTS",
    "UI_HINTS",
    "JOB_HINTS",
    "SKILL_HINTS",
    "MCP_MANAGEMENT_HINTS",
    "wants_navigation",
    "wants_write_tools",
    "wants_ui_tools",
    "wants_job_tools",
    "wants_skill_tools",
    "wants_mcp_management_tools",
    "lane_label",
]
