"""The rubric a finished worker's REPORT is judged by (`graphs.report_failure`).

`_run_worker` used to score a delegation with `ok = bool(report_text)`, which
passes the one shape the local models actually produce: "Done." after a round of
real tool calls, or the report contract's own three lines filled with "nothing".
Both are empty reports wearing a green chip, and the Main agent composes the
user's answer out of them.

Same discipline as the write-claim gate next door: the worker's own final state
records what ran, so the check costs no model call — and, like that gate, its
whole value depends on never accusing a report that is genuinely fine. Half the
tests here are that half.
"""

from __future__ import annotations

from typing import Any

import pytest
from test_e2e_tasks import Room, run, tc

from arcelle_sidecar.graphs import (
    ARTIFACTS_NOTE,
    NO_REPORT,
    REPORT_IDLE,
    REPORT_SILENT,
    report_failure,
    report_substance,
    unreported_artifacts,
    worker_report,
)

CONTRACT_NOTHING = "DID: nothing\nFOUND: nothing\nMISSING: nothing"


def _final(text: str, **state: Any) -> dict[str, Any]:
    return {"final_text": text, **state}


def _delegation_result(out: Any) -> str:
    """What the Main agent was actually handed back by its specialist."""
    thread = out.chat.seen_by["main"][-1]
    return next(
        m.get("content") or ""
        for m in reversed(thread)
        if m.get("role") == "tool" and str(m.get("tool_name") or "").startswith("ask_")
    )


# --- report_substance: what a report actually carries -------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Done.",
        "done",
        "OK!",
        "Task completed",
        "All done…",
        CONTRACT_NOTHING,
        "DID: nothing\nFOUND: none\nMISSING: n/a",
        "FOUND:",
        "   \n  \n",
    ],
)
def test_a_report_carrying_nothing_has_no_substance(text: str) -> None:
    assert report_substance(text) == ""


@pytest.mark.parametrize(
    "text",
    [
        "FOUND: the rent is 1200/mo.",
        "DID: nothing\nFOUND: clause 7 forbids pets.\nMISSING: nothing",
        "DID: nothing\nFOUND: nothing\nMISSING: the file is not in the room.",
        "Whisper is installed.",
        "No.",
    ],
)
def test_a_report_that_says_something_keeps_it(text: str) -> None:
    """Including the terse ones. A one-word answer to a yes/no question is a
    real report, and a rubric that fails it is worse than no rubric."""
    assert report_substance(text)


def test_the_contract_labels_are_stripped_but_their_content_is_not() -> None:
    assert report_substance("DID: opened lease.pdf") == "opened lease.pdf"
    assert report_substance("did : opened lease.pdf") == "opened lease.pdf"


# --- report_failure: the verdict ----------------------------------------------


def test_a_real_report_is_not_accused() -> None:
    assert report_failure(_final("FOUND: rent is 1200.", attempted={"open_file"})) == ""


def test_an_empty_report_reads_exactly_as_it_always_did() -> None:
    assert report_failure(_final("")) == NO_REPORT
    assert report_failure(_final("   ")) == NO_REPORT


def test_an_acknowledgement_after_real_tool_work_is_caught() -> None:
    """The "Done." regression, at the delegation layer."""
    assert report_failure(_final("Done.", attempted={"search_room"})) == (
        REPORT_SILENT.format(tools="search_room")
    )


def test_the_contracts_own_empty_form_is_caught() -> None:
    assert report_failure(_final(CONTRACT_NOTHING, attempted={"search_room"})) == (
        REPORT_SILENT.format(tools="search_room")
    )


def test_the_verdict_names_what_ran_so_the_hub_can_tell_the_cases_apart() -> None:
    """A search that genuinely found nothing writes the same empty report as one
    that lost its results. The Main agent decides whether to re-dispatch, so it
    is told which tools actually ran rather than just that something did."""
    final = _final("Done.", attempted={"search_room", "open_file"})
    assert "open_file, search_room" in report_failure(final), "named, in a stable order"


def test_a_worker_that_did_nothing_and_said_nothing_is_caught() -> None:
    assert report_failure(_final("Done.", attempted=set())) == REPORT_IDLE


def test_the_two_failures_are_told_apart_by_what_actually_ran() -> None:
    """They read differently to the Main agent because they mean different
    things: one specialist worked and hid it, the other never started."""
    silent = _final(CONTRACT_NOTHING, attempted={"web_search"})
    idle = _final(CONTRACT_NOTHING, attempted=set())
    assert report_failure(silent) != report_failure(idle)


# --- unreported_artifacts: the room disagreeing with the narration ------------


def test_an_artifact_the_report_never_names_is_surfaced() -> None:
    final = _final("DID: saved it.", produced=["create_file: notes.md"])
    assert unreported_artifacts(final) == ["notes.md"]


def test_an_artifact_the_report_does_name_is_left_alone() -> None:
    final = _final("DID: saved notes.md.", produced=["create_file: notes.md"])
    assert unreported_artifacts(final) == []


def test_the_same_artifact_twice_is_named_once() -> None:
    final = _final("DID: saved it.", produced=["create_file: n.md", "edit_file: n.md"])
    assert unreported_artifacts(final) == ["n.md"]


def test_a_connector_send_is_an_artifact_like_any_other() -> None:
    final = _final("DID: sent it.", produced=["run_mcp_tool: gmail.send"])
    assert unreported_artifacts(final) == ["gmail.send"]


def test_a_baton_entry_without_a_tool_prefix_is_still_read() -> None:
    """`_referent_names` fails open on shapes it does not recognise; this must
    not turn a salvaged entry into a crash."""
    assert unreported_artifacts(_final("DID: saved it.", produced=["notes.md"])) == [
        "notes.md"
    ]
    assert unreported_artifacts(_final("x", produced=["create_file: "])) == []


# --- worker_report: the text and the verdict are one decision -----------------


def test_a_failed_report_is_replaced_not_annotated() -> None:
    """There was nothing in it worth keeping, and leaving it in front of the
    honest sentence would let the Main agent quote it anyway."""
    report, ok = worker_report("File agent", _final("Done.", attempted={"open_file"}))
    assert not ok
    assert report.startswith("The File agent ran open_file but reported nothing")
    assert "Done." not in report


def test_an_under_reported_result_is_kept_and_extended() -> None:
    report, ok = worker_report(
        "File agent", _final("DID: saved it.", produced=["create_file: notes.md"])
    )
    assert ok
    assert report == f"Report from the File agent:\nDID: saved it.\n{ARTIFACTS_NOTE}notes.md"


def test_a_good_report_is_handed_over_verbatim() -> None:
    report, ok = worker_report("Web agent", _final("FOUND: the rate is 4.25%."))
    assert ok
    assert report == "Report from the Web agent:\nFOUND: the rate is 4.25%."


# --- through the real hub -----------------------------------------------------


async def test_a_specialist_that_reports_nothing_is_a_failed_step() -> None:
    """End to end: the chip is red, the roster says failed, and the Main agent
    is told the step is unfinished rather than handed an empty report."""
    room = Room(files={"lease.pdf": "Rent: 1200/mo."})
    out = await run(
        "what is my rent?",
        {
            "main": [
                [tc("ask_file_agent", instruction="what is my rent")],
                "I could not get that.",
            ],
            "files.read": [[tc("search_room", query="rent")], "Done."],
        },
        room,
    )

    assert "unfinished" in _delegation_result(out)
    roster = out.of("plan")[-1]["v"]
    assert roster[0]["status"] == "failed"
    assert any(e["ok"] is False for e in out.of("step_status"))


async def test_a_specialist_with_a_real_report_is_handed_over_unchanged() -> None:
    """The other half. This wording is what every hub prompt is written around."""
    room = Room(files={"lease.pdf": "Rent: 1200/mo."})
    out = await run(
        "what is my rent?",
        {
            "main": [
                [tc("ask_file_agent", instruction="what is my rent")],
                "Your rent is 1200.",
            ],
            "files.read": [[tc("search_room", query="rent")], "FOUND: rent is 1200/mo."],
        },
        room,
    )

    handed = _delegation_result(out)
    assert handed.startswith("Report from the")
    assert "FOUND: rent is 1200/mo." in handed
    assert out.of("plan")[-1]["v"][0]["status"] == "done"


async def test_a_write_the_report_never_mentions_is_named_for_the_main_agent() -> None:
    """The room holds `notes.md`; the report says only "saved it". Without the
    note the Main agent writes the user an answer that cannot name the file."""
    room = Room(files={"lease.pdf": "Rent: 1200/mo."})
    out = await run(
        "save a summary of my lease",
        {
            "main": [
                [tc("ask_file_agent", instruction="save a summary of the lease")],
                "Saved.",
            ],
            "files.read": [
                [tc("create_file", name="notes.md", content="Rent 1200")],
                "DID: saved it.\nFOUND: nothing\nMISSING: nothing",
            ],
        },
        room,
    )

    handed = _delegation_result(out)
    assert f"{ARTIFACTS_NOTE}notes.md" in handed
    assert out.of("plan")[-1]["v"][0]["status"] == "done", "a real write is not a failure"


async def test_a_report_that_names_its_write_gets_no_note() -> None:
    room = Room(files={"lease.pdf": "Rent: 1200/mo."})
    out = await run(
        "save a summary of my lease",
        {
            "main": [
                [tc("ask_file_agent", instruction="save a summary of the lease")],
                "Saved notes.md.",
            ],
            "files.read": [
                [tc("create_file", name="notes.md", content="Rent 1200")],
                "DID: saved notes.md.\nFOUND: nothing\nMISSING: nothing",
            ],
        },
        room,
    )

    assert ARTIFACTS_NOTE not in _delegation_result(out)


async def test_an_empty_report_still_reads_the_way_it_always_did() -> None:
    """The one branch that existed before this rubric — its wording is load
    bearing for the hub prompt, so generalising must not have moved it."""
    room = Room()
    out = await run(
        "what is my rent?",
        {
            "main": [[tc("ask_file_agent", instruction="what is my rent")], "No answer."],
            "files.read": [""],
        },
        room,
    )
    assert _delegation_result(out).endswith(NO_REPORT)
