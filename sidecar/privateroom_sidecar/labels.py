"""Human step labels for the tool chips shown while an answer streams.

Ported from ``tool_step_label`` (agent.rs:1172). Unknown names — which is how
every connected MCP tool arrives, namespaced ``server_tool`` — fall back to
"Ran the {name} tool".
"""

from __future__ import annotations

_LABELS: dict[str, str] = {
    "list_room_files": "Listed the room's files",
    "search_room": "Searched the room",
    "open_file": "Opened a file",
    "mark_image": "Marked an image",
    "annotate_file": "Highlighted a passage",
    "create_file": "Created a file",
    "edit_file": "Edited a file",
    "write_file": "Rewrote a file",
    "set_cells": "Updated spreadsheet cells",
    "rename_file": "Renamed a file",
    "move_file": "Moved a file",
    "add_memory": "Saved a memory",
    "web_search": "Searched the web",
    "fetch_page": "Fetched a page",
    # ADD-25: the agent is operating the app with the user watching.
    "ui_snapshot": "Looked at the app's controls",
    "ui_act": "Operated the app",
    "view_screenshot": "Looked at the screen",
    "view_media_frame": "Looked at a video frame",
    # ADD-32: the whole-file pass — durable background reading.
    "start_file_pass": "Started a whole-file pass",
    "job_status": "Checked the background jobs",
    # ADD-21: name the exfiltration plainly.
    "consult_advisor": "Consulting a cloud advisor (content leaves this Mac)",
}


def tool_step_label(name: str) -> str:
    """Short human label for a tool step chip."""
    return _LABELS.get(name, f"Ran the {name} tool")


__all__ = ["tool_step_label"]
