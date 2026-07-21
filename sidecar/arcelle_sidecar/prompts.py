"""System-prompt paragraphs appended when a router fires.

Verbatim from ``agent_loop`` (agent.rs:1267 jobs, agent.rs:1281 ui). They are
appended to the system message *only* when the matching tool subset is offered:
telling a model about tools it hasn't been given is how you teach it to
hallucinate calls.
"""

from __future__ import annotations

#: ADD-32 — appended when `wants_job_tools` fires (agent.rs:1270).
JOBS_PROMPT = (
    "\n\nFor work that must cover an ENTIRE file — summarize/analyze/translate "
    "all of it, however large — do NOT try to read it through search_room "
    "excerpts. Call start_file_pass instead: it reads every part of the file in "
    "a durable background job and saves the result as a new file in the room. "
    "Then tell the user it is underway (they see a live progress card) and do "
    "not wait for it. job_status reports how background jobs are doing."
    "\n\nFor RECURRING or multi-step automation — 'every morning', 'summarize new "
    "files daily', a saved pipeline — use the workflow tools: list_workflows to "
    "see or fetch one, save_workflow to draft a new multi-step pipeline (nodes + "
    "edges), update_workflow to change one, delete_workflow only when explicitly "
    "asked, test_workflow to validate a draft, and run_workflow to run an active one now. "
    "save_workflow always creates a DRAFT the user reviews and activates on the "
    "Workflows page; if a definition is invalid it comes back with a numbered list "
    "to fix and retry."
)

#: ADD-25 — appended when `wants_ui_tools` fires (agent.rs:1284).
UI_PROMPT = (
    "\n\nYou can also OPERATE this app's own interface, with the user watching: "
    "ui_snapshot lists every visible control as numbered marks; ui_act clicks, "
    "types into, or scrolls one mark. view_screenshot attaches what the user "
    "currently sees; view_media_frame grabs a video frame at a timestamp. Take a "
    "fresh ui_snapshot before each ui_act. Privacy/consent controls (Settings, "
    "approval dialogs) are excluded and will refuse. Prefer answering directly — "
    "drive the interface only when the user asked you to do something in the app. "
    'Know the app\'s surfaces by name: the "Room Map" is the Map toggle in the '
    'Files header (a constellation view of the files); the "Memory panel" lists '
    'remembered facts in the sidebar; the "Front Page" dashboard has Studio '
    "buttons (Flashcards, Mind map, Podcast script) and AI actions; file viewers "
    "have their own tabs and a History button. When the user names one of these, "
    "do not ask what they mean — ui_snapshot to find the control, then ui_act it."
)

#: Appended only when the user explicitly asks about Skills or MCP connectors.
#: These tools are deliberately absent from ordinary document chat.
MANAGEMENT_PROMPT = (
    "\n\nYou have on-demand management tools for Skills and/or MCP connectors. "
    "Inspect first with the relevant list/read tool before changing or deleting "
    "anything. Skill edits remain disabled drafts for human review. Connector "
    "edits are saved disabled and credentials are never available to you; tell "
    "the user to review, add credentials, and explicitly enable/approve a "
    "connector in Connectors before it can run or reach the network."
)


def duplicate_call_note(name: str) -> str:
    """CHG-3 (agent.rs:1405): don't re-run an identical call or re-flood context."""
    return (
        f"Duplicate call: you already ran {name} with these exact arguments this "
        "turn; the result is above. Use it, or call with different arguments."
    )


#: Appended to a tool result on the penultimate round — nudge a small model to
#: wrap up rather than start another chain it can't finish (agent.rs:1441).
NEAR_BUDGET_NOTE = "\n[Note: tool budget nearly exhausted — answer the user in your next reply.]"

#: ADD-25 (agent.rs:1459): the perception tools captured pixels. Ollama reads
#: images from USER turns, not tool turns — so the capture is handed back as a
#: user message right after the tool result.
IMAGE_HANDOFF = (
    "[The capture you requested is attached. Look at it, then continue — "
    "answer the user or take the next action.]"
)

#: agent.rs:1476 — a genuine dead-path net after the tool-less final round.
DONE_TEXT = "Done."

__all__ = [
    "JOBS_PROMPT",
    "UI_PROMPT",
    "MANAGEMENT_PROMPT",
    "NEAR_BUDGET_NOTE",
    "IMAGE_HANDOFF",
    "DONE_TEXT",
    "duplicate_call_note",
]
