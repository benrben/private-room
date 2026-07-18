"""The round loop (SPEC §3.2). Every invariant here is product behaviour."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from conftest import (
    FakeChatModel,
    FakeMCP,
    Round,
    call,
    drive,
    make_request,
    specs,
)

from privateroom_sidecar.mcp_client import ToolSpec

from privateroom_sidecar.config import PLAIN_MAX_ROUNDS
from privateroom_sidecar.graph import (
    AGENT_GRAPH,
    CancelToken,
    Deps,
    call_model,
    route_after_model,
    route_after_tools,
)
from privateroom_sidecar.mcp_client import ToolResult
from privateroom_sidecar.messages import Message, ToolCall
from privateroom_sidecar.prompts import (
    IMAGE_HANDOFF,
    JOBS_PROMPT,
    NEAR_BUDGET_NOTE,
    UI_PROMPT,
)
from privateroom_sidecar.routing import WRITE_TOOL_NAMES

WRITE_ON = {"write": True, "ui": False, "jobs": False}


# --------------------------------------------------------------------------- #
# the graph itself
# --------------------------------------------------------------------------- #


def test_graph_shape() -> None:
    g = AGENT_GRAPH.get_graph()
    nodes = set(g.nodes)
    assert {"prepare", "call_model", "execute_tools", "synthesize"} <= nodes
    edges = {(e.source, e.target) for e in g.edges}
    assert ("prepare", "call_model") in edges
    assert ("call_model", "execute_tools") in edges
    assert ("call_model", "synthesize") in edges
    assert ("execute_tools", "call_model") in edges  # the round cycle
    assert ("execute_tools", "synthesize") in edges  # cancellation exit


def test_routers() -> None:
    assert route_after_model({"stop": True}) == "synthesize"  # type: ignore[arg-type]
    assert route_after_model({"stop": False}) == "execute_tools"  # type: ignore[arg-type]
    assert route_after_tools({"cancelled": True, "round": 1, "max_rounds": 9}) == "synthesize"  # type: ignore[arg-type]
    assert route_after_tools({"cancelled": False, "round": 1, "max_rounds": 9}) == "call_model"  # type: ignore[arg-type]
    # the runaway backstop
    assert route_after_tools({"cancelled": False, "round": 9, "max_rounds": 9}) == "synthesize"  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# the tool catalog
# --------------------------------------------------------------------------- #


async def test_catalog_comes_from_tools_list_not_a_hardcoded_list() -> None:
    mcp = FakeMCP(tools=specs(["list_room_files", "search_room"]))
    chat = FakeChatModel([Round(content="hi")])
    out = await drive(make_request(routing=WRITE_ON), chat, mcp)
    assert mcp.list_calls == 1
    assert out.chat.offered_names[0] == ["list_room_files", "search_room"]


async def test_write_tools_are_withheld_on_an_informational_turn() -> None:
    chat = FakeChatModel([Round(content="The rent is 1200.")])
    out = await drive(make_request("what does the contract say about rent"), chat)
    offered = set(out.chat.offered_names[0])
    assert offered.isdisjoint(WRITE_TOOL_NAMES)
    # the read/show tools are always there
    assert {"search_room", "open_file", "annotate_file", "mark_image"} <= offered


async def test_write_tools_return_when_the_question_asks_for_a_change() -> None:
    chat = FakeChatModel([Round(content="done")])
    out = await drive(make_request("edit the lease and fix the rent"), chat)
    assert set(WRITE_TOOL_NAMES) <= set(out.chat.offered_names[0])


async def test_ui_and_job_tools_are_gated_by_their_routers() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("what does the contract say about rent"), chat)
    offered = set(out.chat.offered_names[0])
    assert "ui_act" not in offered
    assert "start_file_pass" not in offered

    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive(make_request("click the save button"), chat2)
    assert {"ui_snapshot", "ui_act", "view_screenshot", "view_media_frame"} <= set(
        out2.chat.offered_names[0]
    )

    chat3 = FakeChatModel([Round(content="ok")])
    out3 = await drive(make_request("translate the entire book"), chat3)
    assert {"start_file_pass", "job_status"} <= set(out3.chat.offered_names[0])


async def test_consult_advisor_is_never_offered_even_if_the_bridge_serves_it() -> None:
    mcp = FakeMCP(tools=specs(["search_room", "consult_advisor"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request(routing=WRITE_ON), chat, mcp)
    assert "consult_advisor" not in out.chat.offered_names[0]


async def test_workflow_tools_are_dropped_off_a_plain_turn() -> None:
    # Wave 4a: the bridge always serves the workflow tools (LocalEngine scope),
    # so _filter_catalog must drop them unless the jobs router fires — else they'd
    # bloat every turn's catalog.
    mcp = FakeMCP(tools=specs(["search_room", "save_workflow", "run_workflow"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("what is the rent"), chat, mcp)
    offered = set(out.chat.offered_names[0])
    assert "save_workflow" not in offered
    assert "run_workflow" not in offered
    # …but a workflow-intent turn offers them.
    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive(
        make_request("make me a workflow to summarize new files every morning"), chat2, mcp
    )
    assert {"save_workflow", "run_workflow"} <= set(out2.chat.offered_names[0])


# --------------------------------------------------------------------------- #
# system-prompt appends
# --------------------------------------------------------------------------- #


async def test_ui_prompt_is_appended_only_when_the_ui_router_fires() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("click the save button"), chat)
    assert UI_PROMPT in out.messages[0]["content"]
    assert JOBS_PROMPT not in out.messages[0]["content"]

    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive(make_request("what is the rent"), chat2)
    assert UI_PROMPT not in out2.messages[0]["content"]


async def test_job_prompt_is_appended_only_when_the_job_router_fires() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("summarize the entire book"), chat)
    assert JOBS_PROMPT in out.messages[0]["content"]


async def test_prompt_appends_need_the_tools_to_actually_be_served() -> None:
    # Telling the model about tools it was not given teaches it to hallucinate.
    mcp = FakeMCP(tools=specs(["search_room"]))  # CloudAdvisor-shaped scope
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("click the save button"), chat, mcp)
    assert UI_PROMPT not in out.messages[0]["content"]


# --------------------------------------------------------------------------- #
# rounds
# --------------------------------------------------------------------------- #


async def test_plain_turn_gets_four_rounds() -> None:
    rounds = [Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")]) for i in range(6)]
    chat = FakeChatModel(rounds)
    out = await drive(make_request("what does the contract say about rent"), chat)
    assert PLAIN_MAX_ROUNDS == 4
    assert out.chat.n == 4  # the loop ran exactly max_rounds rounds
    assert len(out.of("round")) == 4


async def test_a_capable_turn_gets_the_long_backstop() -> None:
    rounds = [Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")]) for i in range(20)]
    chat = FakeChatModel(rounds)
    out = await drive(
        make_request("edit the lease", web_enabled=True, max_rounds=8, routing=WRITE_ON), chat
    )
    assert out.chat.n == 8


async def test_the_final_round_offers_zero_tools() -> None:
    # Otherwise the loop's last act is a side-effect call nobody reads, and the
    # user gets no answer at all.
    rounds = [
        Round(content="looking", calls=[call("search_room", query="a")]),
        Round(content="still looking", calls=[call("search_room", query="b")]),
        Round(content="The rent is 1200."),
    ]
    chat = FakeChatModel(rounds)
    out = await drive(make_request(web_enabled=True, max_rounds=3, routing=WRITE_ON), chat)
    assert out.chat.offered_names[0] != []
    assert out.chat.offered_names[1] != []
    assert out.chat.offered_names[2] == []  # tool-less
    assert out.final == "The rent is 1200."


async def test_a_rogue_call_on_the_tool_less_round_is_never_executed() -> None:
    """Even if the model emits a call with an empty catalog, we do not run it."""

    class RogueChatModel:
        def __init__(self) -> None:
            self.n = 0
            self.offered: list[list[dict[str, Any]]] = []
            self.seen_messages: list[list[Message]] = []

        @property
        def offered_names(self) -> list[list[str]]:
            return [[t["function"]["name"] for t in tools] for tools in self.offered]

        async def stream(
            self,
            messages: list[Message],
            tools: list[dict[str, Any]],
            on_delta: Callable[[str], Awaitable[None]],
            cancel: Any = None,
        ) -> tuple[str, list[ToolCall]]:
            self.offered.append(list(tools))
            self.seen_messages.append([dict(m) for m in messages])
            self.n += 1
            return "text", [ToolCall(name="write_file", arguments={"name": "x"}, id="rogue")]

    mcp = FakeMCP()
    chat = RogueChatModel()
    out = await drive(
        make_request(web_enabled=True, max_rounds=1, routing=WRITE_ON),
        chat,  # type: ignore[arg-type]
        mcp,
    )
    assert out.chat.offered_names == [[]]
    assert mcp.calls == []  # the rogue write never ran
    assert out.final == "text"


# --------------------------------------------------------------------------- #
# the context budget, wired into the loop
# --------------------------------------------------------------------------- #


async def test_the_served_catalog_size_counts_against_the_budget_in_the_loop() -> None:
    # SPEC §3.3: total = tools_chars + sum(msg_len). This drives a REAL multi-round
    # run whose messages are tiny but whose tool CATALOG alone exceeds the budget,
    # then asserts the message list the model actually saw had an old tool result
    # stubbed. Kills both "trim call deleted from call_model" and "tools_chars set
    # to 0 in prepare" — either leaves nothing stubbed here.
    catalog = [ToolSpec(name=f"srv_t{i}", description="d" * 4000) for i in range(20)]
    mcp = FakeMCP(tools=catalog, default=ToolResult(text="r" * 500))
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("srv_t0", x="a")]),
            Round(content="r1", calls=[call("srv_t1", x="b")]),
            Round(content="r2", calls=[call("srv_t2", x="c")]),  # pushes tool0 out of the last 4
            Round(content="done"),
        ]
    )
    out = await drive(
        make_request("edit the lease", web_enabled=True, max_rounds=20, routing=WRITE_ON), chat, mcp
    )
    final_view = out.chat.seen_messages[-1]
    tool_contents = [m["content"] for m in final_view if m.get("role") == "tool"]
    assert any("result trimmed to fit context" in c for c in tool_contents), tool_contents
    # The newest tool result (inside the last-4 window) is never stubbed.
    assert tool_contents[-1] == "r" * 500


async def test_an_oversized_tool_result_is_stubbed_before_the_next_round() -> None:
    # The classic case: one huge tool result, several rounds later it is stubbed
    # in the list the model sees, while the freshest results survive.
    big = "y" * 20_000
    mcp = FakeMCP(default=ToolResult(text=big))
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="0")]),
            Round(content="r1", calls=[call("open_file", name="1")]),
            Round(content="r2", calls=[call("annotate_file", name="2")]),
            Round(content="done"),
        ]
    )
    out = await drive(
        make_request("edit the lease", web_enabled=True, max_rounds=20, routing=WRITE_ON), chat, mcp
    )
    final_view = out.chat.seen_messages[-1]
    tool_contents = [m["content"] for m in final_view if m.get("role") == "tool"]
    assert tool_contents[0].startswith("[search_room result trimmed")  # oldest stubbed
    assert tool_contents[-1] == big  # freshest survives


async def test_the_cancel_token_is_threaded_into_the_model_stream() -> None:
    # F1: the loop must hand the Stop token to the stream so it can break the
    # token loop mid-flight, not merely wait it out between rounds.
    chat = FakeChatModel([Round(content="hi")])
    out = await drive(make_request(), chat)
    assert out.chat.cancels  # something was passed
    assert out.chat.cancels[0] is out.cancel  # and it is THIS run's Stop token


# --------------------------------------------------------------------------- #
# duplicate suppression
# --------------------------------------------------------------------------- #


async def test_duplicate_call_is_suppressed_with_the_exact_note() -> None:
    dup = [call("search_room", query="rent")]
    chat = FakeChatModel(
        [
            Round(content="looking", calls=list(dup)),
            Round(content="looking again", calls=list(dup)),
            Round(content="final"),
        ]
    )
    mcp = FakeMCP()
    out = await drive(make_request(web_enabled=True, max_rounds=6, routing=WRITE_ON), chat, mcp)

    assert mcp.calls == [("search_room", {"query": "rent"})]  # executed once
    notes = [m for m in out.messages if m.get("role") == "tool" and "Duplicate call" in m["content"]]
    assert len(notes) == 1
    assert notes[0]["content"] == (
        "Duplicate call: you already ran search_room with these exact arguments "
        "this turn; the result is above. Use it, or call with different arguments."
    )


async def test_an_all_duplicate_round_forces_a_tool_less_synthesis() -> None:
    dup = [call("search_room", query="rent")]
    chat = FakeChatModel(
        [
            Round(content="r0", calls=list(dup)),
            Round(content="r1", calls=list(dup)),  # all duplicates -> stuck
            Round(content="the answer"),  # must be tool-less
            Round(content="never reached"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
    assert out.chat.n == 3
    assert out.chat.offered_names[2] == []
    assert out.final == "the answer"


async def test_a_partially_duplicate_round_does_not_force_synthesis() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="rent")]),
            Round(
                content="r1",
                calls=[
                    call("search_room", query="rent"),  # dup
                    call("open_file", name="lease.pdf"),  # new -> not all_dup
                ],
            ),
            Round(content="r2", calls=[call("annotate_file", name="lease.pdf")]),
            Round(content="done"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
    assert out.chat.n == 4
    assert out.chat.offered_names[2] != []  # round 2 still had tools


async def test_duplicate_key_ignores_argument_order() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[ToolCall(name="set_cells", arguments={"a": 1, "b": 2})]),
            Round(content="r1", calls=[ToolCall(name="set_cells", arguments={"b": 2, "a": 1})]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP()
    await drive(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)
    assert len(mcp.calls) == 1


# --------------------------------------------------------------------------- #
# failure handling
# --------------------------------------------------------------------------- #


async def test_a_failed_call_is_not_memoised_and_may_retry() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("open_file", name="lease.pdf")]),
            Round(content="r1", calls=[call("open_file", name="lease.pdf")]),  # retry
            Round(content="done"),
        ]
    )
    mcp = FakeMCP(results={"open_file": ToolResult(text="no such file", is_error=True)})
    out = await drive(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)

    assert len(mcp.calls) == 2  # the retry actually ran
    errors = [m for m in out.messages if m.get("role") == "tool" and "Tool error" in m["content"]]
    assert len(errors) == 2
    assert errors[0]["content"] == "Tool error: no such file"
    assert not any("Duplicate call" in (m.get("content") or "") for m in out.messages)
    # A failing round is not an all-duplicate round, so no forced synthesis.
    assert out.chat.n == 3


async def test_step_status_reports_failure() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("open_file", name="x"), call("search_room", query="y")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP(results={"open_file": ToolResult(text="nope", is_error=True)})
    out = await drive(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)
    assert [e["ok"] for e in out.of("step_status")] == [False, True]
    assert [e["v"] for e in out.of("step")] == ["Opened a file", "Searched the room"]


# --------------------------------------------------------------------------- #
# near-budget note
# --------------------------------------------------------------------------- #


async def test_near_budget_note_is_appended_on_the_penultimate_round() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="a")]),
            Round(content="done"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=2, routing=WRITE_ON), chat)
    tool_msgs = [m for m in out.messages if m.get("role") == "tool"]
    assert tool_msgs[0]["content"].endswith(NEAR_BUDGET_NOTE)


async def test_no_near_budget_note_when_rounds_remain() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="a")]),
            Round(content="r1", calls=[call("search_room", query="b")]),
            Round(content="done"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
    tool_msgs = [m for m in out.messages if m.get("role") == "tool"]
    assert not tool_msgs[0]["content"].endswith(NEAR_BUDGET_NOTE)


# --------------------------------------------------------------------------- #
# images
# --------------------------------------------------------------------------- #


async def test_captured_pixels_become_a_user_message() -> None:
    # Ollama reads images from user turns, not tool turns. Attach them to the
    # tool result and the model is blind to what it just captured.
    chat = FakeChatModel(
        [
            Round(content="looking", calls=[call("view_screenshot")]),
            Round(content="I see a chart."),
        ]
    )
    mcp = FakeMCP(
        results={"view_screenshot": ToolResult(text="captured", images=["PNG64"])}
    )
    out = await drive(
        make_request("what do you see on screen", web_enabled=True, max_rounds=9), chat, mcp
    )

    roles = [m["role"] for m in out.messages]
    assert roles[-2:] == ["tool", "user"]
    handoff = out.messages[-1]
    assert handoff["role"] == "user"
    assert handoff["content"] == IMAGE_HANDOFF
    assert handoff["images"] == ["PNG64"]
    assert out.final == "I see a chart."


async def test_no_images_no_user_message() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="a")]),
            Round(content="done"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat)
    assert out.messages[-1]["role"] == "tool"


# --------------------------------------------------------------------------- #
# cancellation
# --------------------------------------------------------------------------- #


async def test_cancel_during_the_stream_stops_before_any_tool_runs() -> None:
    token = CancelToken()
    chat = FakeChatModel(
        [
            Round(content="partial", calls=[call("write_file", name="x")], on_stream=token.cancel),
            Round(content="never"),
        ]
    )
    mcp = FakeMCP()
    out = await drive(
        make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp, cancel=token
    )
    assert mcp.calls == []  # the write never happened
    assert out.chat.n == 1
    assert out.final == "partial"


async def test_cancel_between_tool_calls_skips_the_rest_of_the_round() -> None:
    token = CancelToken()

    def stop_after_first(name: str, arguments: dict[str, Any]) -> None:
        token.cancel()

    chat = FakeChatModel(
        [
            Round(
                content="r0",
                calls=[call("search_room", query="a"), call("write_file", name="b")],
            ),
            Round(content="never"),
        ]
    )
    mcp = FakeMCP(on_call=stop_after_first)
    out = await drive(
        make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp, cancel=token
    )
    assert [c[0] for c in mcp.calls] == ["search_room"]  # second call never ran
    assert out.chat.n == 1  # and no further round


async def test_cancel_between_rounds_short_circuits_call_model() -> None:
    token = CancelToken()
    token.cancel()
    events: list[dict[str, Any]] = []

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    chat = FakeChatModel([Round(content="should not run")])
    deps = Deps(chat=chat, emit=emit, cancel=token, mcp=FakeMCP())  # type: ignore[arg-type]
    state = {
        "round": 1,
        "max_rounds": 9,
        "messages": [],
        "tools": [],
        "tools_chars": 0,
        "force_synthesis": False,
    }
    out = await call_model(state, {"configurable": {"deps": deps}})  # type: ignore[arg-type]

    assert out == {"cancelled": True, "stop": True, "calls": []}
    assert chat.n == 0  # the model was never called
    assert events == []  # not even a "round" event


# --------------------------------------------------------------------------- #
# final text
# --------------------------------------------------------------------------- #


async def test_blank_final_becomes_done() -> None:
    chat = FakeChatModel([Round(content="")])
    out = await drive(make_request(), chat)
    assert out.final == "Done."
    assert out.of("final")[0]["v"] == "Done."


async def test_whitespace_only_final_becomes_done() -> None:
    chat = FakeChatModel([Round(content="   \n ")])
    out = await drive(make_request(), chat)
    assert out.final == "Done."


async def test_blank_final_stays_blank_when_cancelled() -> None:
    # Never invent "Done." over an answer the user stopped.
    token = CancelToken()
    chat = FakeChatModel([Round(content="", on_stream=token.cancel)])
    out = await drive(make_request(), chat, cancel=token)
    assert out.final == ""
    assert out.of("final")[0]["v"] == ""


async def test_a_real_answer_is_never_overwritten() -> None:
    chat = FakeChatModel([Round(content="The rent is 1200.")])
    out = await drive(make_request(), chat)
    assert out.final == "The rent is 1200."


# --------------------------------------------------------------------------- #
# events + message shape
# --------------------------------------------------------------------------- #


async def test_event_sequence() -> None:
    chat = FakeChatModel(
        [
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="The rent is 1200."),
        ]
    )
    out = await drive(
        make_request("edit the lease and fix the rent", web_enabled=True, max_rounds=9), chat
    )
    assert out.kinds == [
        "lane",
        "round",
        "delta",  # "looking"
        "step",
        "step_status",
        "round",  # the frontend clears its live text here
        "delta",  # "The rent is 1200."
        "final",
    ]
    assert out.events[0] == {"t": "lane", "v": "Working on your files"}
    assert out.of("delta")[1]["v"] == "The rent is 1200."
    assert out.of("final")[0]["v"] == "The rent is 1200."


async def test_message_thread_shape() -> None:
    chat = FakeChatModel(
        [
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="done"),
        ]
    )
    out = await drive(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat)
    roles = [m["role"] for m in out.messages]
    assert roles == ["system", "user", "assistant", "tool"]
    assistant = out.messages[2]
    assert assistant["content"] == "looking"
    assert assistant["tool_calls"][0]["function"]["name"] == "search_room"
    tool = out.messages[3]
    assert tool["tool_name"] == "search_room"
    assert tool["content"] == "ok"
