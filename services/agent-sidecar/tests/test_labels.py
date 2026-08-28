"""tool_step_label (SPEC §3.4) — the exact map and the fallback.

This module is the drift gate: labels.py is the only step-label table left in
the product (the Rust one went away with the native loop), so a tool added to
the registry without a row there reaches the user as "Ran the run_workflow
tool". Thirty tools — the whole private browser, every workflow verb, both
connector proxies, both studio generators, transcription and scripts — shipped
that way until 2026-07-30.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS
from arcelle_sidecar.labels import _LABELS, tool_step_label

EXPECTED = {
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
    "add_memory": "Saved a memory",
    "list_memories": "Listed the saved memories",
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

#: The only labelled names that are NOT registry tools, and why each is exempt:
#: `consult_advisor` is injected by the host per turn (the cloud advisors the
#: user installed), and `request_tools` is resolved inside graph.py — the bridge
#: has no such tool. graph.py emits the step BEFORE that branch, so it still
#: needs a row. Anything else here is a typo in a `_LABELS` key.
#: Labelled but not in the registry: the host injects one and the loop mints
#: the other two, so the bridge never serves them and the drift check must
#: not read them as stale rows.
NON_REGISTRY_LABELS = {"consult_advisor", "request_tools", "read_result"}


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


def test_run_mcp_tool_label_names_the_outside_service() -> None:
    # Same reasoning one seam over: run_mcp_tool reaches a service off this Mac.
    assert "leaves this Mac" in tool_step_label("run_mcp_tool")


def test_drafts_are_not_labelled_as_installed() -> None:
    # save_mcp writes a DISABLED draft and save_workflow a draft the user
    # activates — a chip claiming otherwise is a false receipt.
    assert tool_step_label("save_mcp").startswith("Drafted")
    assert tool_step_label("save_workflow").startswith("Drafted")
    for word in ("nstalled", "nabled", "ctivated", "cheduled"):
        assert word not in tool_step_label("save_mcp")
        assert word not in tool_step_label("save_workflow")


#: Tools that only ENQUEUE or spawn work and return immediately: `start_file_pass`
#: and `run_workflow` (workflow.rs is fire-and-forget) and `retranscribe_file`
#: (files.rs `enqueue_stt` "queues behind any in-flight job", and the job is
#: dropped outright if the room changes). The chip is not transient — it lands in
#: the per-message receipt row — so a past-tense label is a claim the product
#: never made good on. 2026-07-30: `retranscribe_file` read "Transcribed a
#: recording again" when nothing had been transcribed yet.
FIRE_AND_FORGET = ("start_file_pass", "run_workflow", "retranscribe_file")


@pytest.mark.parametrize("name", FIRE_AND_FORGET)
def test_queued_work_is_not_labelled_as_finished(name: str) -> None:
    label = tool_step_label(name)
    assert label.startswith("Started"), (
        f"{name} only queues/spawns work and returns, so its label must say it "
        f"STARTED — {label!r} claims the work is done"
    )


# --------------------------------------------------------------------------- #
# drift gates
# --------------------------------------------------------------------------- #


def test_every_registry_tool_has_a_label() -> None:
    """No registry tool may fall through to the "Ran the {name} tool" fallback.

    The fallback exists for third-party MCP tools only. A registry tool hitting
    it is the 2026-07-30 bug: the user watching an answer stream read "Ran the
    browse_open tool" for six of the private browser's tools.
    """
    missing = sorted(ALL_REGISTRY_TOOLS - set(_LABELS))
    assert not missing, (
        f"{len(missing)} registry tool(s) have no human step label — add a row to "
        f"labels.py._LABELS for each: {missing}"
    )


def test_no_label_belongs_to_a_tool_the_registry_dropped() -> None:
    extra = sorted(set(_LABELS) - ALL_REGISTRY_TOOLS - NON_REGISTRY_LABELS)
    assert not extra, (
        f"labels.py labels {extra}, which the registry does not own — either a "
        "misspelled key, or a tool that was renamed/removed and left its label "
        "behind (add it to NON_REGISTRY_LABELS only if it is host-injected)"
    )


def test_no_label_is_empty_or_a_raw_tool_name() -> None:
    # A pasted identifier is the cheap way this table goes wrong. Every name in
    # this product has an underscore, so no human label may contain one.
    for name, label in sorted(_LABELS.items()):
        assert label.strip(), f"{name} has an empty label"
        assert name not in label, (
            f"{name}'s label is (or contains) the tool name: {label!r}"
        )
        assert "_" not in label, f"{name}'s label looks like an identifier: {label!r}"
        assert label[0].isupper(), (
            f"{name}'s label should read as a sentence: {label!r}"
        )


def test_every_loop_resolved_mini_tool_has_a_label_too() -> None:
    """`ALL_REGISTRY_TOOLS` cannot cover these — the bridge does not serve them,
    the loop mints them (`request_tools`, `read_result`). They still reach the
    step strip by name, so leaving one out puts "Ran the read_result tool" in
    front of the user: the same fallback leak the registry check exists to stop,
    arriving through the one door that check cannot see.
    """
    from arcelle_sidecar.external_llm import _HUB_ONLY_TOOLS

    minted = {name for name in _HUB_ONLY_TOOLS if not name.startswith("ask_")}
    missing = sorted(minted - set(_LABELS))
    assert not missing, (
        f"loop-resolved tool(s) with no human step label: {missing} — add a row "
        "to labels.py._LABELS and to NON_REGISTRY_LABELS above"
    )
    assert minted <= NON_REGISTRY_LABELS, (
        "a loop-resolved tool's label must be declared non-registry, or the "
        "stale-row check will read it as drift"
    )
