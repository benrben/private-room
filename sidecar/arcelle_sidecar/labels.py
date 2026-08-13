"""Human step labels for the tool chips shown while an answer streams.

Ported from ``tool_step_label`` (agent.rs:1172). That Rust table went away with
the native agent loop in 14111c6, so this module is now the ONLY step-label
table in the product — a name missing here reaches the user as "Ran the
run_workflow tool". Unknown names — which is how every connected MCP tool
arrives, namespaced ``server_tool`` — fall back to "Ran the {name} tool".

``tests/test_labels.py`` asserts every ``agents.ALL_REGISTRY_TOOLS`` name has a
row here, so a new tool cannot ship label-less.
"""

from __future__ import annotations

_LABELS: dict[str, str] = {
    # Hub v3: the Main agent's delegation calls read as WHO was asked.
    "ask_file_agent": "Asked the File agent",
    "ask_web_agent": "Asked the Web agent",
    "ask_app_agent": "Asked the App agent",
    "ask_jobs_agent": "Asked the Jobs agent",
    "ask_skills_agent": "Asked the Skills agent",
    "ask_connector_agent": "Asked the Connector agent",
    # One batch call is a whole PLAN carrying several asks, so a chip reading
    # "Asked the File agent" would under-report what is happening. "at once"
    # is about the CALL, not the clock: a local room runs the children strictly
    # one after another (`Deps.worker_parallel = 1`), which is why the batch
    # tool's own description no longer promises wall-clock parallelism either.
    "ask_agents": "Asked several agents at once",
    # The lane escape hatch (2026-07-23). graph.py emits this step BEFORE the
    # request_tools branch resolves it locally, so the name DOES reach this
    # table even though the bridge has no such tool.
    "request_tools": "Asked for more tools",
    # The other loop-resolved mini-tool (2026-08-01, results.py). Same story: the
    # step is emitted before `_read_result` resolves it, so the name lands here
    # even though the bridge has never heard of it.
    "read_result": "Read more of a long result",
    "list_room_files": "Listed the room's files",
    "search_room": "Searched the room",
    "open_file": "Opened a file",
    "mark_image": "Marked an image",
    "annotate_file": "Highlighted a passage",
    "create_file": "Created a file",
    "edit_file": "Edited a file",
    "edit_files": "Edited several files",
    "write_file": "Rewrote a file",
    "set_cells": "Updated spreadsheet cells",
    "rename_file": "Renamed a file",
    "move_file": "Moved a file",
    # The organize box. "Tidied up the files" deliberately does NOT cover
    # trashing: the step chip is often the only place a user sees that a
    # deletion happened at all, and folding it into a tidy-up label would hide
    # the one action the trash's attribution column exists to surface.
    "organize_files": "Tidied up the files",
    "trash_files": "Moved files to the trash",
    "merge_files": "Merged files into one",
    "add_memory": "Saved a memory",
    # Wave 1b (idea 5): read-back for the budget-truncated injection.
    "list_memories": "Listed the saved memories",
    # A memory is the user's own sentence about themselves — changing one and
    # forgetting one are different enough that "Saved a memory" would hide it.
    "update_memory": "Corrected a memory",
    "delete_memory": "Forgot a memory",
    "list_skills": "Listed the room's skills",
    "read_skill": "Loaded a skill",
    "read_skill_resource": "Read a skill resource",
    "save_skill": "Drafted a skill",
    "write_skill_resource": "Saved a skill resource",
    "run_skill_script": "Ran a skill script",
    # The destructive half of the skills surface: only ever reached on an
    # explicit ask, and the chip is the user's receipt that it happened.
    "delete_skill_resource": "Deleted a skill resource",
    "delete_skill": "Deleted a skill",
    "web_search": "Searched the web",
    "fetch_page": "Fetched a page",
    # BROWSE-1: the room's private browser. "Read the page text" and "Looked at
    # the page" are the phrases browse.rs already journals for these same tools
    # (browse.rs:407/508) — one act must not carry two names across the two
    # surfaces the user reads. browse_open says WHICH browser, because
    # fetch_page ("Fetched a page") is the other way a page reaches the agent.
    "browse_open": "Opened a page in the private browser",
    "browse_read": "Read the page text",
    "browse_snapshot": "Looked at the page's controls",
    "browse_find": "Looked for a control on the page",
    "browse_do": "Operated the page",
    "browse_look": "Looked at the page",
    # BROWSE-2: web content arriving as room files. "Saved" only where the tool
    # result confirms a landed file; download_media only STARTS a job.
    "browse_save": "Saved the page into the room",
    "save_link": "Saved a link into the room",
    "download_url": "Downloaded a file into the room",
    "download_media": "Started a media download",
    # ADD-25: the agent is operating the app with the user watching.
    "ui_snapshot": "Looked at the app's controls",
    "ui_act": "Operated the app",
    "view_screenshot": "Looked at the screen",
    "view_media_frame": "Looked at a video frame",
    # ADD-32: the whole-file pass — durable background reading.
    "start_file_pass": "Started a whole-file pass",
    "job_status": "Checked the background jobs",
    # Workflows are DRAFTS until the user activates them on the Workflows page,
    # and an update returns an active one to draft — so no label here may read
    # as "scheduled" or "live". run_workflow only STARTS a background run, the
    # same honesty start_file_pass needs.
    "list_workflows": "Listed the room's workflows",
    "save_workflow": "Drafted a workflow",
    "update_workflow": "Changed a workflow",
    "test_workflow": "Tested a workflow",
    "run_workflow": "Started a workflow",
    "delete_workflow": "Deleted a workflow",
    # The room's own scripts. The user approves the exact contents before a run,
    # so the chip names the plain act — it is the receipt for what they allowed.
    "list_scripts": "Listed the room's scripts",
    "run_script": "Ran a script",
    # Connector administration. `save_mcp` writes a DISABLED draft (routing.py)
    # — the chip must not claim a connector was installed or switched on.
    "list_mcps": "Listed the room's connectors",
    "read_mcp": "Read a connector's setup",
    "save_mcp": "Drafted a connector (left off for you to review)",
    "delete_mcp": "Removed a connector",
    "search_mcp_tools": "Looked through the connected tools",
    # ADD-21 reasoning, second seam: run_mcp_tool reaches an OUTSIDE service, so
    # the chip names the exfiltration the way consult_advisor does. This is also
    # the tool whose failures once read to the user as "sent" — see the
    # connector-agent spec's ERRORED-still-read-as-"sent" note in agents.py.
    "run_mcp_tool": "Used a connected service (content leaves this Mac)",
    # On-device speech: nothing is uploaded. stt_status is only a CHECK — it
    # must never read as a transcription that happened.
    "stt_status": "Checked whether transcription is ready",
    # retranscribe_file only ENQUEUES (files.rs `enqueue_stt`: "queues behind any
    # in-flight job"), and the queued job is dropped if the room changes — so
    # this is a "Started", the same honesty start_file_pass and run_workflow
    # need. The Rust handler says it in the present progressive for exactly this
    # reason: "Re-transcribing {name} on this computer; nothing is uploaded."
    "retranscribe_file": "Started transcribing a recording again",
    # Also only STARTS a job — the chapters, highlights and notes land when it
    # finishes, which can be a minute later on a local model. "Read" past-tense
    # would claim a finished reading the user cannot yet see.
    "read_recording": "Started reading a recording",
    # The studio verbs each SAVE a new file in the room, so name the artefact
    # the user will find there rather than the generator that made it.
    "studio_flashcards": "Made flashcards",
    "studio_mindmap": "Made a mind map",
    "draw": "Drew on the sketch",
    "read_drawing": "Looked at the sketch",
    "generate_podcast_script": "Wrote a podcast script",
    # ADD-21: name the exfiltration plainly.
    "consult_advisor": "Consulting a cloud advisor (content leaves this Mac)",
}


def tool_step_label(name: str) -> str:
    """Short human label for a tool step chip."""
    return _LABELS.get(name, f"Ran the {name} tool")


__all__ = ["tool_step_label"]
