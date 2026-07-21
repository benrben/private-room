"""Routing parity with the Rust (SPEC §3.1). The hint lists ARE product behaviour."""

from __future__ import annotations

import pathlib
import re

import pytest

import arcelle_sidecar
from arcelle_sidecar.routing import (
    JOB_TOOL_NAMES,
    MCP_MANAGEMENT_TOOL_NAMES,
    SKILL_TOOL_NAMES,
    UI_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    _JOB_HINTS,
    _MCP_MANAGEMENT_HINTS,
    _SKILL_HINTS,
    _UI_HINTS,
    _WRITE_HINTS,
    lane_label,
    wants_job_tools,
    wants_mcp_management_tools,
    wants_skill_tools,
    wants_ui_tools,
    wants_write_tools,
)

# --- verbatim parity with the Rust source (SPEC §3.1/§7) --------------------
#
# SPEC §7 requires "verbatim hint-list parity with the Rust lists". The prose
# tests below match sample questions, but an overlapping hint can mask a deleted
# entry — so those alone let the two engines drift while CI stays green. This
# block parses the actual arrays out of agent.rs and asserts order-exact
# equality, which is the only thing that keeps them from drifting.

_AGENT_RS = (
    pathlib.Path(arcelle_sidecar.__file__).resolve().parents[2]
    / "src-tauri"
    / "src"
    / "commands"
    / "agent.rs"
)


def _rust_str_list(src: str, marker: str) -> tuple[str, ...]:
    """The quoted strings of the first `&[ ... ];` array at/after ``marker``."""
    i = src.index(marker)
    o = src.index("&[", i)
    c = src.index("];", o)
    block = src[o:c]
    return tuple(re.findall(r'"((?:\\.|[^"\\])*)"', block))


@pytest.mark.skipif(not _AGENT_RS.exists(), reason="Rust source not present in this checkout")
def test_hint_lists_are_verbatim_ports_of_the_rust_arrays() -> None:
    src = _AGENT_RS.read_text()

    # NOTE (sidecar-only migration): the Rust `WRITE_TOOL_NAMES` const was the
    # tool-name filter for the now-deleted native `agent_loop` catalog. Tool
    # filtering moved entirely to the sidecar (routing.py owns WRITE_TOOL_NAMES);
    # Rust now only computes the routing *booleans* (`wants_write_tools` etc.,
    # sidecar.rs `routing`) and no longer carries the array. The tool-name list
    # is instead pinned self-containedly by `test_write_tool_names_match_the_rust_list`.
    # The HINT lists below DO still live in agent.rs as the source of truth and
    # remain order-exact parity-checked (their drift is the real product risk).

    # The three hint lists, order-exact. The UI list is the base HINTS followed
    # by APP_NAVIGATION_VERBS (agent.rs:807 `HINTS || APP_NAVIGATION_VERBS`).
    assert _rust_str_list(src, "fn wants_write_tools") == _WRITE_HINTS
    assert _rust_str_list(src, "fn wants_job_tools") == _JOB_HINTS
    assert _rust_str_list(src, "fn wants_skill_tools") == _SKILL_HINTS
    assert _rust_str_list(src, "fn wants_mcp_management_tools") == _MCP_MANAGEMENT_HINTS
    ui_expected = _rust_str_list(src, "fn wants_ui_tools") + _rust_str_list(
        src, "APP_NAVIGATION_VERBS: &[&str]"
    )
    assert ui_expected == _UI_HINTS

# --- the lists themselves ---------------------------------------------------


def test_management_tool_names_are_gated_in_their_own_lanes() -> None:
    assert WRITE_TOOL_NAMES == (
        "create_file",
        "edit_file",
        "edit_files",
        "write_file",
        "set_cells",
        "rename_file",
        "move_file",
        "add_memory",
    )
    assert SKILL_TOOL_NAMES == (
        "list_skills", "read_skill", "read_skill_resource", "save_skill",
        "write_skill_resource", "delete_skill_resource", "delete_skill", "run_skill_script",
    )
    assert MCP_MANAGEMENT_TOOL_NAMES == ("list_mcps", "read_mcp", "save_mcp", "delete_mcp")


def test_edit_files_is_a_write_tool() -> None:
    # Wave 2 (Idea 7): the atomic batch tool must be gated off read-only turns
    # (the sidecar filter DROPS listed write tools when write=False), and the
    # Rust/Python change lands in the same commit per the routing docstring.
    assert "edit_files" in WRITE_TOOL_NAMES


def test_show_tools_are_not_write_tools() -> None:
    # annotate_file / mark_image SHOW the user something; they don't mutate a
    # file, so they are always offered.
    assert "annotate_file" not in WRITE_TOOL_NAMES
    assert "mark_image" not in WRITE_TOOL_NAMES
    assert "open_file" not in WRITE_TOOL_NAMES
    assert "search_room" not in WRITE_TOOL_NAMES


def test_ui_and_job_tool_names() -> None:
    assert UI_TOOL_NAMES == ("ui_snapshot", "ui_act", "view_screenshot", "view_media_frame")
    # Workflow CRUD/run tools join the job tools so
    # _filter_catalog drops them off a plain turn (kept in sync with agent.rs).
    assert JOB_TOOL_NAMES == (
        "start_file_pass",
        "job_status",
        "list_workflows",
        "save_workflow",
        "update_workflow",
        "delete_workflow",
        "run_workflow",
        "test_workflow",
    )


def test_wants_job_tools_fires_on_workflow_intents() -> None:
    from arcelle_sidecar.routing import wants_job_tools

    assert wants_job_tools("make me a workflow that summarizes new files every morning")
    assert wants_job_tools("automate a weekly review")
    assert wants_job_tools("set up a recurring pipeline")
    assert not wants_job_tools("what does the lease say about pets?")


def test_skill_and_connector_tools_are_only_requested_on_demand() -> None:
    assert wants_skill_tools("list my skills")
    assert wants_skill_tools("turn this policy into an agent instruction")
    assert not wants_skill_tools("what does the lease say")
    assert wants_mcp_management_tools("show my MCP connectors")
    assert wants_mcp_management_tools("remove that integration")
    assert not wants_mcp_management_tools("summarize the contract")


# --- wants_write_tools ------------------------------------------------------


@pytest.mark.parametrize(
    "question",
    [
        "edit the lease",
        "Change the rent to 1200",
        "replace that paragraph",
        "fix the typo",
        "update the numbers",
        "rewrite the intro",
        "write a summary",  # "write " has a trailing space in the hint list
        "add a row",
        "create a note",
        "make a table",
        "start a new file for this",
        "save this",
        "delete the draft",
        "remove that clause",
        "set the value to 4",
        "fill in the blanks",
        "insert a heading",
        "append the totals",
        "rename it to Q3",
        "correct the date",
        "remember that I hate mondays",
        "note this down",
        "jot that",
        "record the figure",
        "translate it to French",
        "highlight the pet clause",
        "mark that spot",
        "annotate the contract",
        "draft a reply",
        "generate a summary",
        "move it into stocks",
        "organize my files",
        "organise my files",
        "put it in the archive",
        "make a folder",
        "sort these",
        "tidy up",
    ],
)
def test_wants_write_tools_fires(question: str) -> None:
    assert wants_write_tools(question) is True


def test_skill_authoring_uses_the_skill_lane_not_the_file_write_lane() -> None:
    assert wants_skill_tools("turn the attached policy into a skill")
    assert wants_write_tools("turn the attached policy into a skill") is False


@pytest.mark.parametrize(
    "question",
    [
        "what does the contract say about rent",
        "who signed the lease",
        "summarize the key risks",  # no hint word: this is the big win case
        "when is the deadline",
        "how much did we spend",
    ],
)
def test_wants_write_tools_stays_quiet(question: str) -> None:
    assert wants_write_tools(question) is False


def test_routers_are_case_insensitive() -> None:
    assert wants_write_tools("EDIT the lease") is True
    assert wants_ui_tools("CLICK the button") is True
    assert wants_job_tools("the ENTIRE file") is True


# --- wants_ui_tools ---------------------------------------------------------


@pytest.mark.parametrize(
    "question",
    [
        "click the save button",
        "press enter",
        "take a screenshot",
        "what's on the screen",
        "scroll down",
        "navigate to settings",
        "open the menu",
        "look at the sidebar",
        "watch this",
        "grab a frame",
        "play the video",
        "look at the chart",
        "what are you looking at",
        "explain the interface",
        "use the app for me",
        "type in my name",
        "toggle it",
        "what do you see",
        "what am i doing",
        "there's an error on screen",
        # the ADD-25 follow-up: app surfaces and navigation verbs
        "open the Room Map",
        "show me the memory panel",
        "go to the front page",
        "switch to the Detail tab",
        "close the viewer",
        "open the map",
        "open the panel",
        "the Studio buttons",
        "generate flashcards",
        "make a mind map",
        "build a mindmap",
        "write a podcast script",
        "the dashboard",
        "pause it",
        "look at this image",
        "the photo",
        "that picture",
    ],
)
def test_wants_ui_tools_fires(question: str) -> None:
    assert wants_ui_tools(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "what does the contract say about rent",
        "summarize the risks",
        "who is the landlord",
    ],
)
def test_wants_ui_tools_stays_quiet(question: str) -> None:
    assert wants_ui_tools(question) is False


# --- wants_job_tools --------------------------------------------------------


@pytest.mark.parametrize(
    "question",
    [
        "the whole file",
        "read the entire book",
        "entirely",
        "all of it",
        "every page",
        "everything in there",
        "the full document",
        "fully translate it",
        "a complete summary",
        "completely",
        "cover the report",
        "a thorough review",
        "go in depth",
        "an in-depth pass",
        "translate the book",
        "throughout the file",
        "end to end",
        "cover to cover",
        "start to finish",
        "page by page",
        "chapter three",
        "it's a long file",
        "a large file",
        "a big file",
        "go deep",
        "how's the job going",
        "any progress",
        "run it in the background",
        "do a pass",
        "digest this",
        "no matter how long",
        "don't miss anything",
        "do not miss a line",
        "line by line",
    ],
)
def test_wants_job_tools_fires(question: str) -> None:
    assert wants_job_tools(question) is True


@pytest.mark.parametrize(
    "question",
    ["what is the rent", "who signed it", "when is it due"],
)
def test_wants_job_tools_stays_quiet(question: str) -> None:
    assert wants_job_tools(question) is False


# --- lane_label -------------------------------------------------------------


def test_lane_label_precedence() -> None:
    # UI wins over write (agent.rs:823). lane_label takes the RESOLVED booleans.
    assert lane_label(ui=True, write=True, web_enabled=False) == "Using the app"
    assert lane_label(ui=False, write=True, web_enabled=False) == "Working on your files"
    assert lane_label(ui=False, write=False, web_enabled=True) == "Answering (web available)"
    assert lane_label(ui=False, write=False, web_enabled=False) == "Answering"


def test_lane_label_follows_the_host_override_not_the_question() -> None:
    # D6: when the host overrides routing, the chip must follow the override, not
    # re-derive from the question. A "click the button" question whose UI tools
    # the host withheld must NOT still show "Using the app".
    assert wants_ui_tools("click the button") is True
    assert lane_label(ui=False, write=False, web_enabled=False) == "Answering"
