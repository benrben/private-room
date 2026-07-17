"""tool_step_label (SPEC §3.4) — the exact map and the fallback."""

from __future__ import annotations

import pytest

from privateroom_sidecar.labels import tool_step_label

EXPECTED = {
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
    "ui_snapshot": "Looked at the app's controls",
    "ui_act": "Operated the app",
    "view_screenshot": "Looked at the screen",
    "view_media_frame": "Looked at a video frame",
    "start_file_pass": "Started a whole-file pass",
    "job_status": "Checked the background jobs",
    "consult_advisor": "Consulting a cloud advisor (content leaves this Mac)",
}


@pytest.mark.parametrize(("name", "label"), sorted(EXPECTED.items()))
def test_known_labels(name: str, label: str) -> None:
    assert tool_step_label(name) == label


def test_unknown_name_falls_back() -> None:
    # Every connected MCP tool arrives here, namespaced server_tool.
    assert tool_step_label("github_create_issue") == "Ran the github_create_issue tool"
    assert tool_step_label("") == "Ran the  tool"


def test_advisor_label_names_the_exfiltration() -> None:
    # The user must be able to see that content just left the Mac.
    assert "leaves this Mac" in tool_step_label("consult_advisor")
