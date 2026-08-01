"""Parking oversized tool results, wired into the real loop.

The bug this closes is not "the context overflowed" — `budget.
fit_oversized_results` already handles that. It is that the truncation was
IRREVERSIBLE: `seen` memoises on `name|arguments`, so the only route back to a
cut tail is an exact-duplicate call, and `_ToolPass.run` answers a duplicate
with a note instead of running it. A 60 KB page was unreadable past its first
few KB for the rest of the turn, and nothing told the model so.

`results.py` proves the store and the reader in isolation. This file proves the
wiring: what lands in the thread, who is offered the reader, what survives a
catalog rebuild, and that the bridge never sees a `read_result` call.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request, specs

from arcelle_sidecar.budget import byte_len
from arcelle_sidecar.mcp_client import ToolResult
from arcelle_sidecar.prompts import READ_RESULT_TOOL
from arcelle_sidecar.results import SLICE_BYTES

#: Comfortably over `SPILL_BYTES`, and self-describing so a window can be
#: located inside it.
BIG = "\n".join(f"clause {i:04d}: the rent is {1000 + i} a month" for i in range(1000))

WRITE_ON = {"write": True}


def _page(mcp_text: str = BIG) -> FakeMCP:
    return FakeMCP(results={"fetch_page": ToolResult(text=mcp_text)})


def _tool_results(out: Any, name: str) -> list[str]:
    return [
        m.get("content") or ""
        for m in out.state["messages"]
        if m.get("role") == "tool" and m.get("tool_name") == name
    ]


def _offered(out: Any, round_index: int) -> set[str]:
    return set(out.chat.offered_names[round_index])


async def _fetch_then(*rounds: Round, mcp: FakeMCP | None = None) -> Any:
    """A web worker that fetches a big page, then does whatever `rounds` say."""
    chat = FakeChatModel(
        [Round(calls=[call("fetch_page", url="https://x.test")]), *rounds]
    )
    return await drive_worker(
        make_request("read the lease page", web_enabled=True, model="qwen3:cloud"),
        chat,
        mcp or _page(),
        agent_id="files.read",
    )


# --- what lands in the thread -------------------------------------------------


async def test_an_oversized_result_is_parked_and_the_thread_gets_a_head() -> None:
    out = await _fetch_then(Round(content="FOUND: rents are listed by clause."))

    (result,) = _tool_results(out, "fetch_page")
    assert result.startswith("clause 0000"), "the head is real content, not a stub"
    # ONE READ'S WORTH, not one spill threshold. Parking a page and then pasting
    # `SPILL_BYTES` of it straight back leaves a local model exactly where it
    # started — the head has to cost what a `read_result` costs.
    assert byte_len(result) <= SLICE_BYTES + 400, "frame aside, the head is one slice"
    assert "res_1" in result and "read_result" in result
    assert str(len(BIG)) in result, "the model is told how much it has not seen"
    assert out.deps.results.get("res_1").text == BIG, "the whole page is kept"
    assert out.state["spills"] == ["res_1"]


async def test_an_ordinary_result_is_passed_through_byte_for_byte() -> None:
    """The common case must be untouched — a stub where a small result used to
    be is a regression in every other test in this suite."""
    out = await _fetch_then(
        Round(content="FOUND: 4.25%."), mcp=_page("the rate is 4.25%")
    )
    assert _tool_results(out, "fetch_page") == ["the rate is 4.25%"]
    assert out.state["spills"] == []
    assert not out.deps.results, "nothing was parked"


async def test_an_oversized_failure_is_parked_with_its_diagnosis_still_first() -> None:
    """No special case for errors — a 60 KB failure is as unreadable as a 60 KB
    page. What must survive is the part the model reasons about: that it failed,
    and why, at the very front of the head."""
    mcp = FakeMCP(results={"fetch_page": ToolResult(text=BIG, is_error=True)})
    out = await _fetch_then(Round(content="MISSING: the page would not load."), mcp=mcp)
    (result,) = _tool_results(out, "fetch_page")
    assert result.startswith("Tool error: clause 0000")
    assert out.state["spills"] == ["res_1"]
    assert "fetch_page" not in out.state["seen"], "a failure is still retryable"


# --- the reader ---------------------------------------------------------------


async def test_the_reader_is_offered_only_after_something_is_parked() -> None:
    out = await _fetch_then(Round(content="FOUND: rents are listed by clause."))
    assert READ_RESULT_TOOL not in _offered(out, 0), "nothing was parked yet"
    assert READ_RESULT_TOOL in _offered(out, 1)


async def test_the_reader_survives_the_rounds_after_the_one_that_minted_it() -> None:
    """`spills` has to be declared on `AgentState`: LangGraph silently drops
    unknown keys from a node's update, which would retire the reader one round
    after it appeared."""
    out = await _fetch_then(
        Round(calls=[call("search_room", query="rent")]),
        Round(content="FOUND: clause 7."),
    )
    assert READ_RESULT_TOOL in _offered(out, 1)
    assert READ_RESULT_TOOL in _offered(out, 2)
    assert out.state["spills"] == ["res_1"]


async def test_reading_more_reaches_text_the_head_never_showed() -> None:
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_1", find="clause 0900")]),
        Round(content="FOUND: clause 900 says 1900 a month."),
    )
    (answer,) = _tool_results(out, "read_result")
    assert "clause 0900: the rent is 1900" in answer
    assert "clause 0900" not in _tool_results(out, "fetch_page")[0], (
        "the fixture is pointless unless the head really stopped short of it"
    )


async def test_the_bridge_never_sees_a_read_result_call() -> None:
    """Resolved in the loop like `request_tools` — the room has no such tool."""
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_1", offset=100)]),
        Round(content="FOUND: more clauses."),
    )
    assert [name for name, _ in out.mcp.calls] == ["fetch_page"]


async def test_a_read_is_not_recorded_as_a_room_tool() -> None:
    """`attempted` is the write gate's ground truth about ROOM tools. Reading
    text this loop already fetched changed nothing in the room."""
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_1", offset=0)]),
        Round(content="FOUND: more clauses."),
    )
    assert "read_result" not in out.state["attempted"]
    assert not out.state.get("corrections"), "and it must not trip the write gate"


async def test_a_read_is_logged_in_the_turns_progress() -> None:
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_1", find="clause 0900")]),
        Round(content="FOUND: clause 900."),
    )
    assert any(
        line.startswith("read_result(") and line.endswith("-> ok")
        for line in out.state["progress"]
    )


async def test_a_bad_read_is_a_failed_step_and_may_be_retried() -> None:
    """Only successful calls are memoised, so a model that fixes its arguments
    is not answered with a duplicate note."""
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_99")]),
        Round(calls=[call("read_result", ref="res_1", offset=0)]),
        Round(content="FOUND: clause 0."),
    )
    first, second = _tool_results(out, "read_result")
    assert "res_99" in first and "res_1" in first
    assert "clause 0000" in second
    assert [e["ok"] for e in out.of("step_status")] == [True, False, True]


async def test_two_positions_are_two_calls_but_the_same_one_twice_is_not() -> None:
    """Paging works only because the memo keys on arguments; an identical
    re-read is still the loop refusing to re-flood its own context."""
    out = await _fetch_then(
        Round(calls=[call("read_result", ref="res_1", offset=0)]),
        Round(calls=[call("read_result", ref="res_1", offset=SLICE_BYTES)]),
        Round(calls=[call("read_result", ref="res_1", offset=SLICE_BYTES)]),
        Round(content="FOUND: read it all."),
    )
    first, second, third = _tool_results(out, "read_result")
    assert "from position 0 " in first
    assert f"from position {SLICE_BYTES} " in second
    assert "Duplicate call" in third


# --- the catalog rebuilds that used to retire the reader -----------------------


async def test_unlocking_a_group_does_not_retire_the_reader() -> None:
    """`request_tools` rebuilds the catalog from the SERVED specs, and the
    bridge never serves `read_result`."""
    out = await _fetch_then(
        Round(calls=[call("request_tools", group="skills")]),
        Round(content="FOUND: nothing more."),
    )
    offered = _offered(out, 2)
    assert "list_skills" in offered, "the unlock itself still works"
    assert READ_RESULT_TOOL in offered


async def test_a_narrowing_stage_does_not_retire_the_reader() -> None:
    """`chat.web` runs `chain_stage`, which rebuilds the catalog from the
    agent's full box between rounds — and the reader is in no box.

    The spill has to land on the FIRST stage, so that a narrowing runs after it:
    once the stages are exhausted the node stops returning a `tools` key at all,
    and the reader would survive by omission rather than by design.
    """
    chat = FakeChatModel(
        [
            Round(calls=[call("web_search", query="rent")]),
            Round(calls=[call("fetch_page", url="https://x.test")]),
            Round(content="FOUND: the page is long."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["web_search", "fetch_page"]),
        results={
            "web_search": ToolResult(text=BIG),
            "fetch_page": ToolResult(text="x.test — the rate is 4.25%"),
        },
    )
    out = await drive_worker(
        make_request("what are the rents", web_enabled=True, model="qwen3:cloud"),
        chat,
        mcp,
        agent_id="chat.web",
    )
    assert out.state["spills"] == ["res_1"]
    assert "fetch_page" in _offered(out, 1), "the stage itself still narrows"
    assert READ_RESULT_TOOL in _offered(out, 1), (
        "the stage after the spill narrowed the reader away"
    )


async def test_the_reader_is_never_offered_twice() -> None:
    """Two spills mean two refs in one spec, not two specs."""
    chat = FakeChatModel(
        [
            Round(calls=[call("fetch_page", url="https://a.test")]),
            Round(calls=[call("fetch_page", url="https://b.test")]),
            Round(content="FOUND: two long pages."),
        ]
    )
    out = await drive_worker(
        make_request("read both", web_enabled=True, model="qwen3:cloud"),
        chat,
        _page(),
        agent_id="files.read",
    )
    specs_offered = [
        t for t in out.chat.offered[2] if t["function"]["name"] == READ_RESULT_TOOL
    ]
    assert len(specs_offered) == 1
    assert specs_offered[0]["function"]["parameters"]["properties"]["ref"]["enum"] == [
        "res_1",
        "res_2",
    ]


# --- scoping ------------------------------------------------------------------


async def test_a_child_cannot_read_what_its_parent_parked() -> None:
    """The store hangs off `Deps` and is shared by the whole delegation tree;
    `spills` is what scopes a read to the loop that actually saw the text."""
    from arcelle_sidecar.graph import Deps
    from arcelle_sidecar.results import read_spill

    deps = Deps(chat=None, emit=None)  # type: ignore[arg-type]
    parent = deps.results.put("fetch_page", BIG)
    text, ok = read_spill(deps.results, [], {"ref": parent.ref})
    assert not ok
    assert "Nothing has been shortened" in text


async def test_a_worker_that_parked_nothing_is_told_so_rather_than_crashing() -> None:
    """A model can emit a tool it was never offered; the arm has to answer."""
    chat = FakeChatModel(
        [
            Round(calls=[call("read_result", ref="res_1")]),
            Round(content="MISSING: nothing was shortened."),
        ]
    )
    out = await drive_worker(
        make_request("read more", model="qwen3:cloud"), chat, FakeMCP()
    )
    (answer,) = _tool_results(out, "read_result")
    assert "Nothing has been shortened" in answer
    assert out.of("step_status")[0]["ok"] is False


@pytest.mark.parametrize("arguments", [{}, {"ref": None}, {"ref": 7}, {"offset": 5}])
async def test_a_malformed_read_never_breaks_the_round(arguments: dict) -> None:
    out = await _fetch_then(
        Round(calls=[call("read_result", **arguments)]),
        Round(content="FOUND: recovered."),
    )
    assert out.final == "FOUND: recovered."
    assert len(_tool_results(out, "read_result")) == 1
