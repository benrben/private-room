"""Deterministic tool routing — ported VERBATIM from the Rust.

Source of truth: ``src-tauri/src/commands/agent.rs``
  - ``WRITE_TOOL_NAMES``  (agent.rs:737)
  - ``wants_write_tools`` (agent.rs:751)
  - ``wants_ui_tools``    (agent.rs:767)
  - ``wants_job_tools``   (agent.rs:788)
  - ``lane_label``        (agent.rs:823)

These are NOT model-driven: they are case-insensitive substring matches on the
raw user question. A small model picks the right tool far more reliably from a
short, relevant list, so the mutating / UI / job tools are withheld unless the
question sounds like it wants them. Erring toward YES is safe — it just restores
the fuller catalog.

The hint lists are product behaviour. If you change one here, change the Rust in
the same commit or the two engines drift.
"""

from __future__ import annotations

#: The file-MUTATING built-ins (agent.rs:737). Withheld on a plain informational
#: turn. Note `annotate_file` / `mark_image` are deliberately NOT in this list —
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

#: The UI/perception tools (ADD-25). Never in the bridge's cloud scope.
UI_TOOL_NAMES: tuple[str, ...] = (
    "ui_snapshot",
    "ui_act",
    "view_screenshot",
    "view_media_frame",
)

#: The whole-file pass tools (ADD-32) plus the Wave 4a workflow authoring tools.
#: These MUST be dropped when the jobs router does not fire (graph._filter_catalog
#: is a drop-list) — else they'd bloat every turn's catalog and defeat the
#: short-catalog doctrine. Kept in sync with agent.rs BUILTIN_TOOL_NAMES.
JOB_TOOL_NAMES: tuple[str, ...] = (
    "start_file_pass",
    "job_status",
    "list_workflows",
    "save_workflow",
    "update_workflow",
    "run_workflow",
)

#: Never offered to anyone but the top-level local agent — closes the recursion
#: path (a consulted cloud CLI must not be able to spawn another one). The
#: sidecar ignores it if the bridge ever serves it (SPEC §2.1).
FORBIDDEN_TOOL_NAMES: tuple[str, ...] = ("consult_advisor",)

# --- hint lists, verbatim from the Rust -------------------------------------

_WRITE_HINTS: tuple[str, ...] = (
    "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
    "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
    "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
    "translate", "highlight", "mark ", "annotate", "draft", "generate",
    "move ", "rename", "organize", "organise", "put ", "folder", "sort ", "tidy",
)

_UI_HINTS: tuple[str, ...] = (
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
)

_JOB_HINTS: tuple[str, ...] = (
    "whole", "entire", "entirely", "all of", "every ", "everything", "full",
    "fully", "complete", "completely", "cover", "thorough", "in depth",
    "in-depth", "translate", "book", "throughout", "end to end", "cover to cover",
    "start to finish", "page by page", "chapter", "long file", "large file",
    "big file", "deep", "job", "progress", "background", "pass", "digest",
    "no matter", "don't miss", "do not miss", "line by line",
    # Wave 4a: the workflow authoring tools ride the jobs routing flag.
    "workflow", "automate", "automat", "every morning", "every day", "every week",
    "each morning", "each day", "schedule", "recurring", "routine", "pipeline",
)


def _any_hint(question: str, hints: tuple[str, ...]) -> bool:
    q = question.lower()
    return any(h in q for h in hints)


def wants_write_tools(question: str) -> bool:
    """Offer the file-mutating built-ins this turn? (agent.rs:751)"""
    return _any_hint(question, _WRITE_HINTS)


def wants_ui_tools(question: str) -> bool:
    """Offer the UI/perception tools (and their system-prompt paragraph)? (agent.rs:767)"""
    return _any_hint(question, _UI_HINTS)


def wants_job_tools(question: str) -> bool:
    """Offer the whole-file pass tools (and their paragraph)? (agent.rs:788)"""
    return _any_hint(question, _JOB_HINTS)


def lane_label(*, ui: bool, write: bool, web_enabled: bool) -> str:
    """The lane shown to the user, so an odd answer is explainable (agent.rs:823).

    Purely cosmetic. Order matters: UI wins over write, write over web.

    Takes the RESOLVED routing booleans (not the raw question) so the chip always
    matches the catalog the model was actually offered. In the Rust these are the
    same ``wants_*`` calls on the same question and cannot disagree; in the sidecar
    the host can override routing (SPEC §5), and the label must follow the override
    or the user sees "Using the app" while the UI tools were withheld.
    """
    if ui:
        return "Using the app"
    if write:
        return "Working on your files"
    if web_enabled:
        return "Answering (web available)"
    return "Answering"


__all__ = [
    "WRITE_TOOL_NAMES",
    "UI_TOOL_NAMES",
    "JOB_TOOL_NAMES",
    "FORBIDDEN_TOOL_NAMES",
    "wants_write_tools",
    "wants_ui_tools",
    "wants_job_tools",
    "lane_label",
]
