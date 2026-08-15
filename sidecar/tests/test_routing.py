"""Routing parity with the Rust (SPEC §3.1). The hint lists ARE product behaviour."""

from __future__ import annotations

import pathlib
import re

import pytest

import arcelle_sidecar
from arcelle_sidecar.routing import (
    JOB_HINTS,
    JOB_TOOL_NAMES,
    MCP_MANAGEMENT_HINTS,
    MCP_MANAGEMENT_TOOL_NAMES,
    SKILL_HINTS,
    SKILL_TOOL_NAMES,
    UI_HINTS,
    UI_TOOL_NAMES,
    WRITE_HINTS,
    ORGANIZE_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    lane_label,
    wants_job_tools,
    wants_mcp_management_tools,
    wants_navigation,
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
    assert _rust_str_list(src, "fn wants_write_tools") == WRITE_HINTS
    assert _rust_str_list(src, "fn wants_job_tools") == JOB_HINTS
    assert _rust_str_list(src, "fn wants_skill_tools") == SKILL_HINTS
    assert _rust_str_list(src, "fn wants_mcp_management_tools") == MCP_MANAGEMENT_HINTS
    ui_expected = _rust_str_list(src, "fn wants_ui_tools") + _rust_str_list(
        src, "APP_NAVIGATION_VERBS: &[&str]"
    )
    assert ui_expected == UI_HINTS

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
    assert ORGANIZE_TOOL_NAMES == (
        "organize_files",
        "trash_files",
        "set_in_library",
        "merge_files",
    )


@pytest.mark.skipif(not _AGENT_RS.exists(), reason="Rust source not present in this checkout")
def test_the_organize_box_matches_the_tools_rust_actually_serves() -> None:
    """The box the File agent asks for must be the box the host can serve.

    These two lists live in different languages and neither imports the other:
    `routing.ORGANIZE_TOOL_NAMES` decides what goes in the agent's toolbox, and
    `commands::agent::organize_tools_specs` decides what the bridge advertises
    and what `exec_tool` can run. Drift is silent in the worst direction — a
    name here with no spec there is a tool the model is told it holds and gets
    an "unknown tool" for, mid-errand, after it has already promised the user.

    Parsed from the spec function rather than from `BUILTIN_TOOL_NAMES`, which
    is a reservation list: a name can sit there (correctly, so MCP cannot shadow
    it) long before or after anything serves it.
    """
    src = _AGENT_RS.read_text()
    body_at = src.index("pub(crate) fn organize_tools_specs")
    body_end = src.index("\n}", body_at)
    served = tuple(
        re.findall(r'"function", "function": \{"name": "([a-z_]+)"', src[body_at:body_end])
    )
    assert served == ORGANIZE_TOOL_NAMES

    # …and every one of them is reserved, so no connector can shadow an arm.
    reserved = _rust_str_list(src, "BUILTIN_TOOL_NAMES: &[&str]")
    assert set(ORGANIZE_TOOL_NAMES) <= set(reserved)

    # The agent must never be handed a way to destroy a file. These two are
    # room commands with no tool spec anywhere, and this asserts they stay that
    # way — the trash is only a safety net while nothing can empty it.
    assert "delete_file_permanently" not in reserved
    assert "empty_trash" not in reserved


def test_edit_files_is_a_write_tool() -> None:
    # Wave 2 (Idea 7): edit_files belongs to the write set. (2026-07-23: the
    # write set is no longer dropped from the catalog — it is always offered —
    # but the list still drives the lane label and the agent.rs name
    # reservations, so membership stays pinned.)
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


def test_hebrew_questions_route_every_lane() -> None:
    # 2026-07-23 live QA: the hint lists were English-only substrings, so a
    # Hebrew speaker could NEVER open a lane — the agent permanently lacked
    # write/ui/job tools in Hebrew conversations. (to_lowercase is identity for
    # Hebrew; plain substring matching.)
    assert wants_write_tools("שמור את זה כקובץ") is True
    assert wants_write_tools("ערוך את החוזה") is True
    assert wants_write_tools("תרגם לעברית") is True
    assert wants_ui_tools("פתח את הקובץ") is True
    assert wants_ui_tools("צלם צילום מסך") is True
    assert wants_job_tools("סכם את כל הספר") is True
    assert wants_job_tools("תזמן משימה כל בוקר") is True
    assert wants_skill_tools("צור מיומנות חדשה") is True
    assert wants_mcp_management_tools("הצג את המחברים שלי") is True
    # A plain Hebrew question opens nothing (the short-catalog win case).
    assert wants_ui_tools("מה שכר הדירה בחוזה?") is False
    assert wants_job_tools("מה שכר הדירה בחוזה?") is False


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


# --- wants_navigation (NAV_INTENT) ------------------------------------------
#
# This one is not a catalog widener like the `wants_*` predicates above: a hit
# here wins the web domain OUTRIGHT, ahead of all sibling scoring
# (`manager.resolve_worker`). So a false positive costs a real answer — the ask
# goes to the Browser agent, which has no search tool and must guess an address
# — rather than merely offering one more schema.


@pytest.mark.parametrize(
    "question",
    [
        "surf the web for espresso reviews",
        "surf reddit for me",
        "let's go surfing on hacker news",
        "go to google and search for espresso machines",
        "visit nytimes.com",
        "כנס לאתר של הבנק",
    ],
)
def test_wants_navigation_fires_on_a_destination(question: str) -> None:
    assert wants_navigation(question) is True


@pytest.mark.parametrize(
    "question",
    [
        # THE bug: the bare stem "surf" matched inside "surface", and this gate
        # overrides everything, so an ordinary web question became "open a
        # website" and the Browser agent had to invent an address.
        "what is the surface temperature of Mars",
        "compare the surface area of the two plots",
        "resurface the driveway — what does that cost",
        # The line the gate must not cross either way: a site NAME with no
        # navigation verb is still a search.
        "google the tallest building",
        "what's the latest news about the election",
    ],
)
def test_wants_navigation_stays_quiet_without_a_destination(question: str) -> None:
    assert wants_navigation(question) is False


# --- lane_label -------------------------------------------------------------


def test_lane_label_precedence() -> None:
    # UI wins over write (agent.rs:823). lane_label takes the RESOLVED booleans.
    assert lane_label(ui=True, write=True, web_enabled=False) == "Using the app"
    assert lane_label(ui=False, write=True, web_enabled=False) == "Working on your files"
    assert lane_label(ui=False, write=False, web_enabled=True) == "Answering (web available)"
    assert lane_label(ui=False, write=False, web_enabled=False) == "Answering"


def test_lane_label_names_the_web_workers() -> None:
    """The chip had no wording about the internet at all: while the app was
    actually searching or clicking through pages it read "Answering (web
    available)" — or, if the question also tripped the write hints, "Working on
    your files". Both are the odd answers the chip exists to explain. The web
    workers are named by the ACTIVE agent, which no routing boolean can tell
    apart, so they win over every hint match."""
    assert lane_label(ui=False, write=False, web_enabled=True, agent_id="chat.web") == (
        "Searching the web"
    )
    assert lane_label(ui=False, write=True, web_enabled=True, agent_id="chat.browse") == (
        "Browsing the web"
    )
    # Every other agent keeps the four booleans-only wordings, unchanged.
    assert lane_label(ui=False, write=True, web_enabled=True, agent_id="files.read") == (
        "Working on your files"
    )


def test_lane_label_follows_the_host_override_not_the_question() -> None:
    # D6: when the host overrides routing, the chip must follow the override, not
    # re-derive from the question. A "click the button" question whose UI tools
    # the host withheld must NOT still show "Using the app".
    assert wants_ui_tools("click the button") is True
    assert lane_label(ui=False, write=False, web_enabled=False) == "Answering"
