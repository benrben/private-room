"""The round loop (SPEC §3.2). Every invariant here is product behaviour."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

import pytest
from conftest import (
    BUILTIN_TOOL_NAMES,
    FakeChatModel,
    FakeMCP,
    Round,
    RunOutcome,
    call,
    drive,
    drive_worker,
    make_request,
    specs,
)

from arcelle_sidecar.agents import BATCH_TOOL_NAME, reachable_domain_keys
from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.mcp_client import ToolSpec

from arcelle_sidecar.config import (
    AGENT_ROUND_BACKSTOP,
    CLOUD_WORKER_PARALLEL,
    NO_PROGRESS_ROUNDS,
    TURN_ROUND_BACKSTOP,
)
from arcelle_sidecar.graph import (
    NOTHING_TEXT,
    NOTHING_USABLE_TEXT,
    PROGRESS_ELIDED,
    PROGRESS_NOTE_LINES,
    ROUND_BUDGET_STEP,
    CancelToken,
    Deps,
    Event,
    WorkerOutcome,
    _Delegator,
    _ToolPass,
    call_model,
    parse_plan,
    plan_waves,
    route_after_model,
    route_after_tools,
)
from arcelle_sidecar.graphs import MAIN_GRAPH
from arcelle_sidecar.mcp_client import ToolResult
from arcelle_sidecar.messages import Message, ToolCall
from arcelle_sidecar.prompts import (
    CONNECTORS_ADMIN_PROMPT,
    SKILLS_NOTE,
    EMPTY_PLAN_NOTE,
    FILE_PASS_PROMPT,
    IMAGE_HANDOFF,
    UI_PROMPT,
    WORKFLOWS_PROMPT,
    duplicate_call_note,
)
from arcelle_sidecar.routing import MCP_MANAGEMENT_TOOL_NAMES, SKILL_TOOL_NAMES, WRITE_TOOL_NAMES

WRITE_ON = {"write": True, "ui": False, "jobs": False}


# --------------------------------------------------------------------------- #
# the graph itself
# --------------------------------------------------------------------------- #


def test_graph_shape() -> None:
    g = MAIN_GRAPH.get_graph()
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
# the ask reaches the model (question vs. messages)
# --------------------------------------------------------------------------- #


async def test_question_only_request_seeds_a_user_turn() -> None:
    """A headless caller (workflow ``agent_run``) sends ``question`` with NO
    history. The graph must seed a user turn from it — otherwise the model is
    called with zero messages, Ollama answers the empty conversation with only a
    ``done_reason='load'`` response, langchain_ollama skips it, and the run dies
    with "No generation chunks were returned"."""
    chat = FakeChatModel([Round(content="up 3%"), Round(content="up 3%")])
    out = await drive(make_request("predict ETF performance", messages=[]), chat)
    seen = out.chat.seen_messages[0]
    assert any(
        m.get("role") == "user" and "predict ETF performance" in (m.get("content") or "")
        for m in seen
    ), seen
    assert out.final == "up 3%"


async def test_question_is_not_duplicated_when_history_already_has_the_user_turn() -> None:
    """Chat callers include the ask as the final user turn AND set ``question``.
    The seed must not double it."""
    chat = FakeChatModel([Round(content="ok")])
    msgs: list[Message] = [
        {"role": "system", "content": "You are the room assistant."},
        {"role": "user", "content": "hello there"},
    ]
    out = await drive(make_request("hello there", messages=msgs), chat)
    seen = out.chat.seen_messages[0]
    users = [m for m in seen if m.get("role") == "user"]
    assert len(users) == 1, users


# --------------------------------------------------------------------------- #
# the tool catalog
# --------------------------------------------------------------------------- #


async def test_catalog_comes_from_tools_list_not_a_hardcoded_list() -> None:
    mcp = FakeMCP(tools=specs(["list_room_files", "search_room"]))
    chat = FakeChatModel([Round(content="hi")])
    out = await drive_worker(make_request(routing=WRITE_ON), chat, mcp)
    assert mcp.list_calls == 1
    assert out.chat.offered_names[0] == ["list_room_files", "search_room"]


async def test_write_tools_are_always_offered_even_on_an_informational_turn() -> None:
    # 2026-07-23: the base system prompt teaches create_file/edit_file by name
    # on EVERY turn, so the catalog must agree — withholding the schemas made
    # the model tell users it could not save files.
    chat = FakeChatModel([Round(content="The rent is 1200.")])
    out = await drive_worker(make_request("what does the contract say about rent"), chat)
    offered = set(out.chat.offered_names[0])
    assert set(WRITE_TOOL_NAMES) <= offered
    # the read/show tools are always there
    assert {"search_room", "open_file", "annotate_file", "mark_image"} <= offered


async def test_write_tools_offered_when_the_question_asks_for_a_change() -> None:
    chat = FakeChatModel([Round(content="done")])
    out = await drive_worker(make_request("edit the lease and fix the rent"), chat)
    assert set(WRITE_TOOL_NAMES) <= set(out.chat.offered_names[0])


async def test_ui_and_job_tools_are_gated_by_the_worker_box() -> None:
    # v3: WHICH worker runs is the Main agent's choice (resolve_worker,
    # covered in test_manager); each worker's box stays scoped.
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what does the contract say about rent"), chat)
    offered = set(out.chat.offered_names[0])
    assert "ui_act" not in offered
    assert "start_file_pass" not in offered

    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive_worker(
        make_request("click the save button"), chat2, agent_id="app.ui"
    )
    assert {"ui_snapshot", "ui_act", "view_screenshot", "view_media_frame"} <= set(
        out2.chat.offered_names[0]
    )

    # jobs.run runs `route_act` (2026-07-25): an unambiguous ask is NARROWED to
    # its one terminal verb, so the round is "fill arguments" rather than
    # "choose among ~21 tools, then fill arguments". job_status is deliberately
    # absent here — offering the status verb on a "translate the whole book"
    # ask is what let the agent spend its round checking on nothing.
    chat3 = FakeChatModel([Round(content="ok")])
    out3 = await drive_worker(
        make_request("translate the entire book"), chat3, agent_id="jobs.run"
    )
    offered3 = set(out3.chat.offered_names[0])
    assert "start_file_pass" in offered3
    assert "job_status" not in offered3
    # The resolvers survive the narrow, or the model could never turn "the
    # contract" into a real filename.
    assert {"list_room_files", "search_room"} <= offered3

    # ...and when the vocabulary does NOT decide, the router abstains and the
    # whole box comes back. A router that guessed would be worse than none: the
    # dropped verbs are unrecoverable within the turn.
    chat4 = FakeChatModel([Round(content="ok")])
    out4 = await drive_worker(
        make_request("do the thing with the file"), chat4, agent_id="jobs.run"
    )
    assert {"start_file_pass", "job_status"} <= set(out4.chat.offered_names[0])


async def test_consult_advisor_is_offered_to_an_enabled_top_level_run() -> None:
    mcp = FakeMCP(tools=specs(["search_room", "consult_advisor"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(
        make_request(routing=WRITE_ON, advisors=["claude-cli"]), chat, mcp
    )
    assert "consult_advisor" in out.chat.offered_names[0]


async def test_consult_advisor_is_hidden_when_the_setting_is_off() -> None:
    mcp = FakeMCP(tools=specs(["search_room", "consult_advisor"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request(routing=WRITE_ON, advisors=[]), chat, mcp)
    assert "consult_advisor" not in out.chat.offered_names[0]


async def test_workflow_tools_are_dropped_off_a_plain_turn() -> None:
    # Wave 4a: the bridge always serves the workflow tools (LocalEngine scope),
    # so _filter_catalog must drop them unless the jobs router fires — else they'd
    # bloat every turn's catalog.
    mcp = FakeMCP(tools=specs(["search_room", "save_workflow", "run_workflow"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what is the rent"), chat, mcp)
    offered = set(out.chat.offered_names[0])
    assert "save_workflow" not in offered
    assert "run_workflow" not in offered
    # …but the Workflow agent's box carries them.
    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive_worker(
        make_request("make me a workflow to summarize new files every morning"),
        chat2,
        mcp,
        agent_id="jobs.workflows",
    )
    assert {"save_workflow", "run_workflow"} <= set(out2.chat.offered_names[0])


# --------------------------------------------------------------------------- #
# request_tools — the lane escape hatch (2026-07-23)
# --------------------------------------------------------------------------- #


async def test_request_tools_is_offered_when_served_groups_are_locked() -> None:
    # The default catalog serves ui/job/skill tools; a plain turn locks those
    # lanes — so the escape hatch must be in the catalog and the system prompt
    # must name the locked groups (the stable self-image).
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what is the rent"), chat)
    assert "request_tools" in out.chat.offered_names[0]
    system = out.chat.seen_messages[0][0]
    assert system.get("role") == "system"
    assert "request_tools" in (system.get("content") or "")


async def test_request_tools_is_absent_when_nothing_is_locked_or_served() -> None:
    # Bridge serves only always-on tools -> no locked group -> no escape hatch
    # (offering an unlockable group teaches the model to hallucinate).
    mcp = FakeMCP(tools=specs(["list_room_files", "search_room"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what is the rent"), chat, mcp)
    assert "request_tools" not in out.chat.offered_names[0]


async def test_request_tools_unlocks_the_jobs_lane_mid_turn() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("request_tools", group="jobs")]),
            Round(content="r1", calls=[call("start_file_pass", name="book", instruction="x")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP()
    out = await drive_worker(make_request("what is the rent", max_rounds=9), chat, mcp)
    # Round 0: jobs tools locked. Round 1: unlocked by the escape hatch.
    assert "start_file_pass" not in out.chat.offered_names[0]
    assert "start_file_pass" in out.chat.offered_names[1]
    # The unlock never reaches the bridge; the real tool call does.
    assert [c[0] for c in mcp.calls] == ["start_file_pass"]
    # The jobs paragraphs joined the system prompt at unlock time — BOTH of
    # them: an unlock hands over every member's tools, so it must hand over
    # every member's paragraph (first-wins would have dropped workflows).
    unlocked_system = out.chat.seen_messages[1][0].get("content") or ""
    assert FILE_PASS_PROMPT in unlocked_system
    assert WORKFLOWS_PROMPT in unlocked_system
    # The tool result confirms and names the new tools.
    unlock_result = [m for m in out.messages if m.get("role") == "tool"][0]
    assert "Unlocked" in unlock_result["content"]
    assert "start_file_pass" in unlock_result["content"]


async def test_a_read_only_agent_cannot_unlock_its_own_domain() -> None:
    """`skills.use` is read-and-run by its own paragraph; `save_skill` and
    `delete_skill` belong to its authoring sibling. The hatch is for a lane the
    keyword routers MISSED, so the agent's own group is neither offered nor
    granted — otherwise "never say you lack a capability from this list" read as
    permission to unlock straight past the one rule that agent has."""
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("request_tools", group="skills")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP()
    out = await drive_worker(
        make_request("delete the onboarding skill", max_rounds=9),
        chat,
        mcp,
        agent_id="skills.use",
    )
    # Never advertised...
    system = out.chat.seen_messages[0][0].get("content") or ""
    assert "skills (" not in system, system
    # ...and refused when asked for anyway. The write tools never appear.
    assert "delete_skill" not in out.chat.offered_names[1]
    assert "save_skill" not in out.chat.offered_names[1]
    assert not {"save_skill", "delete_skill"} & {c[0] for c in mcp.calls}
    refusals = [
        m["content"]
        for m in out.messages
        if m.get("role") == "tool" and "another specialist" in (m.get("content") or "")
    ]
    assert refusals, [m.get("content") for m in out.messages if m.get("role") == "tool"]


async def test_request_tools_rejects_an_unknown_group() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("request_tools", group="time_travel")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP()
    out = await drive_worker(make_request("what is the rent", max_rounds=9), chat, mcp)
    assert mcp.calls == []  # nothing reached the bridge
    assert [e["ok"] for e in out.of("step_status")] == [False]
    err = [m for m in out.messages if m.get("role") == "tool"][0]
    assert "Unknown tool group" in err["content"]


# --------------------------------------------------------------------------- #
# multi-step plans (dispatch-first, 2026-07-23)
# --------------------------------------------------------------------------- #


async def test_greetings_are_answered_by_the_main_agent_directly() -> None:
    # "hi bro" (live QA 2026-07-23): nothing to delegate — the Main agent
    # answers itself in ONE round, no worker wakes, and its catalog is its
    # specialists (never room tools).
    chat = FakeChatModel([Round(content="Hey! How can I help?")])
    out = await drive(make_request("hi bro"), chat)
    (plan,) = out.of("plan")
    assert [p["agent"] for p in plan["v"]] == ["chat.answer"]
    assert [(a["v"]["step"], a["v"]["total"]) for a in out.of("agent")] == [(1, 1)]
    assert out.chat.n == 1
    offered = set(out.chat.offered_names[0])
    assert "ask_file_agent" in offered  # the specialists were available…
    assert "search_room" not in offered  # …but no room tool ever is
    assert out.final == "Hey! How can I help?"

async def test_main_agent_delegates_to_the_file_agent_and_answers() -> None:
    # The canonical v3 pipeline: Main agent → ask_file_agent → report → Main
    # agent answers. The roster GROWS as the delegation happens.
    chat = FakeChatModel(
        [
            # main, round 1: delegate
            Round(content="", calls=[call("ask_file_agent", instruction="find what the contract says about rent")]),
            # the File agent's own loop: answers without tools here
            Round(content="The contract says the rent is 1200."),
            # main, round 2: the user-facing answer
            Round(content="The rent is 1200."),
        ]
    )
    out = await drive(make_request("what does the contract say about rent"), chat)
    plans = [e["v"] for e in out.of("plan")]
    assert [p["agent"] for p in plans[0]] == ["chat.answer"]
    assert [p["agent"] for p in plans[-1]] == ["files.read", "chat.answer"]
    walk = [(a["v"]["id"], a["v"]["step"], a["v"]["total"]) for a in out.of("agent")]
    assert walk == [
        ("chat.answer", 1, 1),  # thinking
        ("files.read", 1, 2),  # the delegation runs
        # The child FINISHED — its own slot flips to done the moment its
        # sub-loop ends, which with one child hands the turn straight back.
        ("chat.answer", 2, 2),
        ("chat.answer", 2, 2),  # …and the batch is collected
    ]
    # The report — and ONLY the report — joined the main thread.
    report = next(m for m in out.chat.seen_messages[-1] if m.get("role") == "tool")
    assert report["content"].startswith("Report from the File agent:")
    # The worker saw the delegation note, not the main's tool traffic.
    worker_seen = out.chat.seen_messages[1]
    assert "Arcelle orchestration frame" in worker_seen[-1]["content"]
    assert not any(m.get("role") == "tool" for m in worker_seen)
    # Worker offered room tools; main offered only specialists.
    assert "search_room" in out.chat.offered_names[1]
    assert all(n.startswith("ask_") for n in out.chat.offered_names[0])
    assert sum(1 for k in out.kinds if k == "final") == 1
    assert out.final == "The rent is 1200."

async def test_main_agent_chains_two_specialists_with_the_referent_baton() -> None:
    chat = FakeChatModel(
        [
            # main: first delegation
            Round(content="", calls=[call("ask_jobs_agent", instruction="translate the entire book")]),
            # the Jobs agent: starts the pass, then reports
            Round(content="starting", calls=[call("start_file_pass", name="book", instruction="translate")]),
            Round(content="The pass is underway."),
            # main: second delegation (pending until the first finished)
            Round(content="", calls=[call("ask_connector_agent", instruction="send it to Slack")]),
            # the Connector agent: reports
            Round(content="Sent it to Slack."),
            # main: the ONE user-facing answer
            Round(content="Translation started and sent to Slack."),
        ]
    )
    # Serve the connector proxy pair too, so the second worker could act.
    mcp = FakeMCP(tools=specs(BUILTIN_TOOL_NAMES + ["search_mcp_tools", "run_mcp_tool"]))
    out = await drive(
        make_request("translate the entire book and then send it to Slack", max_rounds=9),
        chat,
        mcp,
    )
    # The roster grew to the full pipeline, Main agent always last.
    plans = [e["v"] for e in out.of("plan")]
    assert [p["agent"] for p in plans[-1]] == ["jobs.run", "connectors.use", "chat.answer"]
    # The real tool ran exactly once, inside the Jobs agent.
    assert [c[0] for c in mcp.calls] == ["start_file_pass"]
    # The baton: the SECOND worker's kickoff names what the first produced.
    conn_seen = out.chat.seen_messages[4]
    assert "Arcelle orchestration frame" in conn_seen[-1]["content"]
    assert "start_file_pass: book" in conn_seen[-1]["content"]
    # Queue-jump guard: the Jobs agent never saw the connector proxy pair.
    assert "run_mcp_tool" not in out.chat.offered_names[1]
    assert "run_mcp_tool" in out.chat.offered_names[4]  # the Connector agent did
    # ONE final — the Main agent's own words.
    finals = out.of("final")
    assert len(finals) == 1
    assert finals[0]["v"] == "Translation started and sent to Slack."

async def test_small_model_rounds_are_no_longer_capped_to_one_call() -> None:
    """The one-call-per-round cap for small local models is GONE.

    BFCL says FC mode gets call COUNTS wrong more often than prompting does,
    which is why the cap existed — but it also silently dropped every parallel
    delegation the hub asked for, so a local room could never run two
    specialists at once. Repeats are the duplicate guard's job, not a cap's.
    """
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("open_file", name="x"), call("search_room", query="y")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP()
    await drive_worker(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)
    assert [c[0] for c in mcp.calls] == ["open_file", "search_room"]


async def test_turn_progress_note_is_reinjected_ephemerally_for_small_models() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="rent")]),
            Round(content="r1", calls=[call("open_file", name="lease.pdf")]),
            Round(content="done"),
        ]
    )
    out = await drive_worker(make_request(max_rounds=9, routing=WRITE_ON), chat)
    # Round 0: no progress yet — no note.
    assert not any(
        "Progress this turn" in (m.get("content") or "") for m in out.chat.seen_messages[0]
    )
    # Round 1: the note is the LAST message and names the completed call.
    # Role USER: a trailing system message silences qwen-class chat templates
    # (the "Done." live-QA regression) — user notes are the proven vehicle.
    note = out.chat.seen_messages[1][-1]
    assert note.get("role") == "user"
    assert "Progress this turn" in (note.get("content") or "")
    assert "search_room(query=rent) -> ok" in note["content"]
    # Ephemeral: exactly ONE note per round, however many rounds ran.
    for seen in out.chat.seen_messages[1:]:
        notes = [m for m in seen if "Progress this turn" in (m.get("content") or "")]
        assert len(notes) == 1


async def test_the_progress_note_is_bounded_but_the_log_itself_is_not() -> None:
    """The note is rebuilt and re-sent EVERY round, and the budget protects a
    note from trimming — so an unbounded one grows all turn and is paid for out
    of the same window as the tool RESULTS it summarises. On a long turn the
    fitter starts dropping the file contents and search hits to keep the
    one-line recap of them. The log in state stays whole; only the copy the
    model is charged for is bounded."""
    n = PROGRESS_NOTE_LINES + 6
    chat = FakeChatModel(
        [
            *(
                Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")])
                for i in range(n)
            ),
            Round(content="done"),
        ]
    )
    out = await drive_worker(
        make_request(max_rounds=n + 2, routing=WRITE_ON), chat, FakeMCP()
    )
    note = next(
        m
        for m in reversed(out.chat.seen_messages[-1])
        if "Progress this turn" in (m.get("content") or "")
    )
    lines = [ln for ln in note["content"].splitlines() if ln[:1].isdigit()]
    assert len(lines) == PROGRESS_NOTE_LINES, f"the note was unbounded: {len(lines)}"
    assert "q0" not in note["content"], "the oldest steps are still being re-sent"
    assert f"q{n - 1}" in note["content"], "the RECENT steps are what a 4B loses"
    # ...and nothing was thrown away: the turn's own log still holds every step.
    assert len(out.state["progress"]) == n


async def test_a_trimmed_progress_note_says_it_was_trimmed() -> None:
    """The note numbers whatever it is handed from 1, under a heading that reads
    like the turn's COMPLETE action list. So the tail alone told the model that
    actions 9-20 were actions 1-12, with nothing saying otherwise — and a model
    that reads the list as complete re-issues an older call. The duplicate guard
    catches that, so the cost is a wasted round rather than a wrong answer; one
    honest line inside the same budget removes it."""
    n = PROGRESS_NOTE_LINES + 6
    chat = FakeChatModel(
        [
            *(
                Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")])
                for i in range(n)
            ),
            Round(content="done"),
        ]
    )
    out = await drive_worker(
        make_request(max_rounds=n + 2, routing=WRITE_ON), chat, FakeMCP()
    )
    note = next(
        m
        for m in reversed(out.chat.seen_messages[-1])
        if "Progress this turn" in (m.get("content") or "")
    )
    shown = [ln for ln in note["content"].splitlines() if ln[:1].isdigit()]
    # Still exactly the budget — the marker takes one of those lines, it does
    # not add a thirteenth.
    assert len(shown) == PROGRESS_NOTE_LINES
    dropped = n - (PROGRESS_NOTE_LINES - 1)
    assert PROGRESS_ELIDED.format(n=dropped) in note["content"], (
        f"the trimmed log was presented as complete: {note['content']}"
    )
    # A short turn is complete, so it says nothing of the kind.
    short = out.chat.seen_messages[2][-1]
    assert "Progress this turn" in (short.get("content") or "")
    assert "earlier actions" not in short["content"]


async def test_cloud_models_get_no_progress_note_and_keep_parallel_calls() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="a")]),
            Round(content="done"),
        ]
    )
    out = await drive(
        make_request(max_rounds=9, routing=WRITE_ON, model="qwen3:cloud"), chat
    )
    assert not any(
        "Progress this turn" in (m.get("content") or "")
        for seen in out.chat.seen_messages
        for m in seen
    )


async def test_list_skills_is_scoped_to_the_calling_agent() -> None:
    """A skill may belong to ONE sub-agent, but the Rust bridge is built per RUN
    and cannot know which specialist is asking. The graph injects the caller's
    id so the host can scope the answer — the model is never asked to pass its
    own identity, which a 4B would forget."""
    mcp = FakeMCP(tools=specs(["search_room", "list_skills"]))
    chat = FakeChatModel([Round(calls=[call("list_skills")]), Round(content="ok")])
    await drive_worker(make_request("what can you do"), chat, mcp, agent_id="files.read")
    name, args = mcp.calls[0]
    assert name == "list_skills"
    assert args["agent"] == "files.read"


async def test_skills_note_reaches_workers_but_not_the_main_agent() -> None:
    """The paragraph is who an agent is; the note tells it that saved
    procedures exist and must be loaded before improvising. The Main agent
    delegates rather than executing procedures, so it never gets the note."""
    mcp = FakeMCP(tools=specs(["search_room", "list_skills"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what does the lease say"), chat, mcp)
    assert SKILLS_NOTE in out.messages[0]["content"]
    # It names no individual skill — which exist is room state, and advertising
    # one that was never authored is the tool-hallucination mistake again.
    assert "list_skills" in SKILLS_NOTE and "read_skill" in SKILLS_NOTE

    # Without the tool served there is nothing to call, so no note.
    bare = FakeMCP(tools=specs(["search_room"]))
    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive_worker(make_request("what does the lease say"), chat2, bare)
    assert SKILLS_NOTE not in out2.messages[0]["content"]


async def test_skill_and_connector_management_tools_are_search_gated() -> None:
    mcp = FakeMCP(
        tools=specs([
            "search_room", "list_skills", "read_skill", "save_skill", "delete_skill",
            "list_mcps", "save_mcp", "delete_mcp",
        ])
    )
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what does the lease say"), chat, mcp)
    offered = set(out.chat.offered_names[0])
    # 2026-07-24: the two skill DISCOVERY verbs are CORE — every agent may own
    # skills, and its answers are scoped to it (graph injects the caller id).
    # Everything that AUTHORS or RUNS a skill stays gated to the skills boxes.
    assert {"list_skills", "read_skill"} <= offered
    assert not offered & (set(SKILL_TOOL_NAMES) - {"list_skills", "read_skill"})
    assert not offered & set(MCP_MANAGEMENT_TOOL_NAMES)

    # skills.USE keeps the authoring verbs out of its box; skills.AUTHOR
    # carries them (resolve_worker picks between the siblings — test_manager).
    skill_chat = FakeChatModel([Round(content="ok")])
    skill_out = await drive_worker(
        make_request("list my skills"), skill_chat, mcp, agent_id="skills.use"
    )
    offered_use = set(skill_out.chat.offered_names[0])
    assert "list_skills" in offered_use
    assert "save_skill" not in offered_use

    author_chat = FakeChatModel([Round(content="ok")])
    author_out = await drive_worker(
        make_request("create a skill from this checklist"),
        author_chat,
        mcp,
        agent_id="skills.author",
    )
    offered_author = set(author_out.chat.offered_names[0])
    assert {"save_skill", "delete_skill"} <= offered_author

    mcp_chat = FakeChatModel([Round(content="ok")])
    mcp_out = await drive_worker(
        make_request("show my MCP connectors"), mcp_chat, mcp, agent_id="connectors.admin"
    )
    assert {"list_mcps", "save_mcp", "delete_mcp"} <= set(mcp_out.chat.offered_names[0])


# --------------------------------------------------------------------------- #
# system-prompt appends
# --------------------------------------------------------------------------- #


async def test_ui_prompt_is_appended_only_when_the_ui_router_fires() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("click the save button"), chat, agent_id="app.ui")
    assert UI_PROMPT in out.messages[0]["content"]
    assert FILE_PASS_PROMPT not in out.messages[0]["content"]

    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive_worker(make_request("what is the rent"), chat2)
    assert UI_PROMPT not in out2.messages[0]["content"]


async def test_connector_admin_prompt_is_appended_only_when_its_tools_are_offered() -> None:
    mcp = FakeMCP(tools=specs(["search_room", "list_skills", "list_mcps"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("what does the lease say"), chat, mcp)
    assert CONNECTORS_ADMIN_PROMPT not in out.messages[0]["content"]

    chat2 = FakeChatModel([Round(content="ok")])
    out2 = await drive_worker(
        make_request("show my MCP connectors"), chat2, mcp, agent_id="connectors.admin"
    )
    assert CONNECTORS_ADMIN_PROMPT in out2.messages[0]["content"]


async def test_file_pass_prompt_is_appended_only_when_the_job_router_fires() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(
        make_request("summarize the entire book"), chat, agent_id="jobs.run"
    )
    assert FILE_PASS_PROMPT in out.messages[0]["content"]


async def test_prompt_appends_need_the_tools_to_actually_be_served() -> None:
    # Telling the model about tools it was not given teaches it to hallucinate.
    mcp = FakeMCP(tools=specs(["search_room"]))  # CloudAdvisor-shaped scope
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(
        make_request("click the save button"), chat, mcp, agent_id="app.ui"
    )
    assert UI_PROMPT not in out.messages[0]["content"]


# --------------------------------------------------------------------------- #
# rounds
# --------------------------------------------------------------------------- #


async def test_plain_turn_uses_the_shared_high_backstop() -> None:
    rounds = [Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")]) for i in range(6)]
    chat = FakeChatModel(rounds)
    out = await drive_worker(make_request("what does the contract say about rent"), chat)
    assert AGENT_ROUND_BACKSTOP >= 70
    assert out.chat.n == 7  # six scripted tool rounds plus the fake's final fallback
    assert len(out.of("round")) == 7


async def test_a_capable_turn_gets_the_long_backstop() -> None:
    rounds = [Round(content=f"r{i}", calls=[call("search_room", query=f"q{i}")]) for i in range(20)]
    chat = FakeChatModel(rounds)
    out = await drive_worker(
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
    out = await drive_worker(make_request(web_enabled=True, max_rounds=3, routing=WRITE_ON), chat)
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
        ) -> tuple[str, list[ToolCall], RoundUsage]:
            self.offered.append(list(tools))
            self.seen_messages.append([dict(m) for m in messages])
            self.n += 1
            usage = RoundUsage(input_tokens=None, max_context=8192, is_real=False)
            return "text", [ToolCall(name="write_file", arguments={"name": "x"}, id="rogue")], usage

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
# uncapped context, wired into the loop
# --------------------------------------------------------------------------- #


async def test_a_large_served_catalog_does_not_trim_tool_results() -> None:
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
    out = await drive_worker(
        make_request("edit the lease", web_enabled=True, max_rounds=20, routing=WRITE_ON), chat, mcp
    )
    final_view = out.chat.seen_messages[-1]
    tool_contents = [m["content"] for m in final_view if m.get("role") == "tool"]
    assert tool_contents == ["r" * 500] * 3


async def test_an_oversized_tool_result_survives_every_round() -> None:
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
    out = await drive_worker(
        make_request("edit the lease", web_enabled=True, max_rounds=20, routing=WRITE_ON), chat, mcp
    )
    final_view = out.chat.seen_messages[-1]
    tool_contents = [m["content"] for m in final_view if m.get("role") == "tool"]
    assert tool_contents == [big, big, big]


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
    out = await drive_worker(make_request(web_enabled=True, max_rounds=6, routing=WRITE_ON), chat, mcp)

    assert mcp.calls == [("search_room", {"query": "rent"})]  # executed once
    notes = [m for m in out.messages if m.get("role") == "tool" and "Duplicate call" in m["content"]]
    assert len(notes) == 1
    assert notes[0]["content"] == (
        "Duplicate call: you already ran search_room with these exact arguments "
        "this turn; the result is above. Use it, or call with different arguments."
    )


async def test_one_wasted_round_does_not_end_the_turn() -> None:
    """The point of the progress gate: a single repeat is a model correcting
    itself, not a model stuck. It used to force synthesis on the spot."""
    dup = [call("search_room", query="rent")]
    chat = FakeChatModel(
        [
            Round(content="r0", calls=list(dup)),
            Round(content="r1", calls=list(dup)),  # stall #1 — survivable
            Round(content="r2", calls=[call("search_room", query="deposit")]),
            Round(content="the answer"),
        ]
    )
    out = await drive_worker(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
    # Still armed on the round after the repeat — that is the whole change.
    assert out.chat.offered_names[2] != []
    assert out.final == "the answer"


async def test_a_run_of_no_progress_rounds_forces_a_tool_less_synthesis() -> None:
    """…and a model that keeps repeating itself still gets stopped."""
    dup = [call("search_room", query="rent")]
    rounds = [Round(content="r0", calls=list(dup))]
    rounds += [
        Round(content=f"stall{i}", calls=list(dup)) for i in range(NO_PROGRESS_ROUNDS)
    ]
    rounds.append(Round(content="the answer"))  # must be tool-less
    chat = FakeChatModel(rounds)
    out = await drive_worker(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
    # The first round works, then NO_PROGRESS_ROUNDS stalls, then the disarmed
    # round — so the tool-less one lands exactly at that index.
    assert out.chat.offered_names[NO_PROGRESS_ROUNDS + 1] == []
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
    out = await drive_worker(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
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
    await drive_worker(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)
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
    out = await drive_worker(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat, mcp)

    assert len(mcp.calls) == 2  # the retry actually ran
    errors = [m for m in out.messages if m.get("role") == "tool" and "Tool error" in m["content"]]
    assert len(errors) == 2
    assert errors[0]["content"] == "Tool error: no such file"
    assert not any("Duplicate call" in (m.get("content") or "") for m in out.messages)
    # A failing round is not an all-duplicate round, so no forced synthesis.
    assert out.chat.n == 3


async def test_a_dropped_connection_is_a_tool_failure_not_a_dead_loop() -> None:
    """`McpClient.call_tool` catches its OWN protocol errors "so the round can
    still make progress" — but only those. A dropped connection or a timed-out
    request raised httpx straight through the tool loop, killing the specialist
    mid-task and putting raw transport text in the answer. The room refusing and
    the socket refusing are the same thing to the model: a result it can read.
    """

    class _DropsTheSocket(FakeMCP):
        async def call_tool(self, name, arguments):  # type: ignore[no-untyped-def]
            self.calls.append((name, dict(arguments)))
            raise ConnectionResetError("connection reset by peer")

    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("open_file", name="lease.pdf")]),
            Round(content="I could not open the lease."),
        ]
    )
    mcp = _DropsTheSocket()
    out = await drive_worker(make_request(routing=WRITE_ON), chat, mcp)

    assert out.final == "I could not open the lease.", "the loop died with the socket"
    errors = [
        m for m in out.messages if m.get("role") == "tool" and "Tool error" in m["content"]
    ]
    assert errors and "connection reset by peer" in errors[0]["content"], errors
    assert any(e.get("ok") is False for e in out.of("step_status"))


async def test_the_tool_catalog_is_retried_once_before_the_turn_is_lost() -> None:
    """`list_tools` is the FIRST thing every loop does, before any work — a
    transient hiccup there used to end the ask with raw JSON-RPC text and no
    retry, and the user had to notice and ask again by hand."""

    class _FlakyOnce(FakeMCP):
        async def list_tools(self):  # type: ignore[no-untyped-def]
            self.list_calls += 1
            if self.list_calls == 1:
                raise ConnectionResetError("connection reset by peer")
            return list(self.tools)

    mcp = _FlakyOnce()
    chat = FakeChatModel([Round(content="The rent is 1200.")])
    out = await drive_worker(make_request(routing=WRITE_ON), chat, mcp)
    assert mcp.list_calls == 2, "the catalog was never retried"
    assert out.final == "The rent is 1200."


async def test_a_catalog_that_stays_down_is_reported_in_words_not_swallowed() -> None:
    """Twice down is not transient. Say so — carrying on with an EMPTY catalog
    would be worse than stopping: an agent with no tools does not announce it,
    it answers from memory."""

    class _AlwaysDown(FakeMCP):
        async def list_tools(self):  # type: ignore[no-untyped-def]
            self.list_calls += 1
            raise TimeoutError()  # str() == ""

    with pytest.raises(RuntimeError) as exc:
        await drive_worker(make_request(routing=WRITE_ON), FakeChatModel([]), _AlwaysDown())
    assert "this room's tools could not be loaded" in str(exc.value)
    assert "TimeoutError" in str(exc.value), "no reason at all was given"


async def test_both_catalog_failures_are_recorded_even_though_one_is_shown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The sentence the user reads carries the RETRY's reason — `_why` never
    returns "", so the `or _why(first)` fallback that used to be in it could
    never be reached. The first attempt's reason is real information all the
    same (`ConnectionRefusedError` then `TimeoutError` is a bridge going down
    mid-turn), so it goes where a diagnosis is read: the log."""

    class _DownTwiceDifferently(FakeMCP):
        async def list_tools(self):  # type: ignore[no-untyped-def]
            self.list_calls += 1
            if self.list_calls == 1:
                raise ConnectionRefusedError("the bridge refused the connection")
            raise TimeoutError()  # str() == ""

    with caplog.at_level(logging.ERROR, logger="arcelle_sidecar.graph"):
        with pytest.raises(RuntimeError) as exc:
            await drive_worker(
                make_request(routing=WRITE_ON), FakeChatModel([]), _DownTwiceDifferently()
            )
    assert "TimeoutError" in str(exc.value), "the retry's reason is the one shown"
    assert any("the bridge refused the connection" in r.getMessage() for r in caplog.records), (
        "the first attempt's reason was thrown away"
    )


async def test_step_status_reports_failure() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("open_file", name="x"), call("search_room", query="y")]),
            Round(content="done"),
        ]
    )
    mcp = FakeMCP(results={"open_file": ToolResult(text="nope", is_error=True)})
    # A ':cloud' model keeps parallel calls (small-local mode caps rounds to one).
    out = await drive_worker(
        make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON, model="qwen3:cloud"),
        chat,
        mcp,
    )
    assert [e["ok"] for e in out.of("step_status")] == [False, True]
    assert [e["v"] for e in out.of("step")] == ["Opened a file", "Searched the room"]


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
            Round(content="I see a chart."),  # the main agent's synthesis
        ]
    )
    mcp = FakeMCP(
        results={"view_screenshot": ToolResult(text="captured", images=["PNG64"])}
    )
    out = await drive_worker(
        make_request("what do you see on screen", web_enabled=True, max_rounds=9), chat, mcp
    )

    roles = [m["role"] for m in out.messages]
    assert roles[-2:] == ["tool", "user"]
    handoff = out.messages[-1]
    assert handoff["role"] == "user"
    assert handoff["content"] == IMAGE_HANDOFF
    assert handoff["images"] == ["PNG64"]
    # RunOutcome.messages reflects the WORKER's transcript (the handoff is its
    # last message); the main agent's synthesis then answers the user.
    assert out.final == "I see a chart."


async def test_no_images_no_user_message() -> None:
    chat = FakeChatModel(
        [
            Round(content="r0", calls=[call("search_room", query="a")]),
            Round(content="done"),
        ]
    )
    out = await drive_worker(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat)
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
    # ':cloud' model: parallel calls survive to the loop, so the between-calls
    # Stop check is what prevents the second one (not the small-model cap).
    out = await drive_worker(
        make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON, model="qwen3:cloud"),
        chat,
        mcp,
        cancel=token,
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


async def test_a_loop_stays_quiet_while_a_sibling_holds_the_live_answer_area() -> None:
    """There is exactly ONE live answer area, and a `round` event BLANKS it.

    A hub round dispatches its whole batch at once and every child streamed into
    that same area: the user watched fragments of three specialists shuffled
    together and repeatedly erased, and read-aloud spoke the jumble. Whoever
    claims it first holds it for the round; the rest stay quiet — and still do
    all of their work, which is what the assertions below pin.
    """
    events: list[dict[str, Any]] = []

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    async def round_for(deps: Deps, node: str) -> dict[str, Any]:
        state = {
            "round": 0,
            "max_rounds": 9,
            "messages": [],
            "tools": [],
            "force_synthesis": False,
            "node_key": node,
        }
        return await call_model(state, {"configurable": {"deps": deps}})  # type: ignore[arg-type]

    deps = Deps(
        chat=FakeChatModel([Round(content="the sibling's words")] * 3),  # type: ignore[arg-type]
        emit=emit,
        cancel=CancelToken(),
        mcp=FakeMCP(),  # type: ignore[arg-type]
    )
    assert deps.claim_live("main") is True, "an idle area must be claimable"

    out = await round_for(deps, "files.read#0")
    assert [e for e in events if e["t"] in ("round", "delta")] == [], (
        "a second loop wrote into an area another one was already using"
    )
    assert out["final_text"] == "the sibling's words", "its work must still land"
    # Its own round still costs what it costs — the bar must not under-report.
    assert [e for e in events if e["t"] == "usage"], "the round went uncounted"

    # The holder finishes; the area is free and the next loop may speak.
    deps.release_live("main")
    events.clear()
    await round_for(deps, "files.read#0")
    assert [e["t"] for e in events if e["t"] in ("round", "delta")] == ["round", "delta"]
    assert all(e["node"] == "files.read#0" for e in events if e["t"] == "round")


async def test_the_live_area_is_handed_back_even_when_the_round_blows_up() -> None:
    """A lease nobody releases is a muted UI for the rest of the turn."""

    class _Boom:
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            raise RuntimeError("the engine fell over")

    async def emit(e: dict[str, Any]) -> None:
        return None

    deps = Deps(chat=_Boom(), emit=emit, cancel=CancelToken(), mcp=FakeMCP())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError):
        await call_model(
            {"round": 0, "max_rounds": 9, "messages": [], "tools": [], "node_key": "a#0"},  # type: ignore[arg-type]
            {"configurable": {"deps": deps}},
        )
    assert deps.claim_live("b#1") is True, "the crashed loop kept the area forever"


async def test_the_usage_bar_counts_the_ephemeral_notes_it_actually_sent() -> None:
    """The turn-progress and correction notes ride the request as user turns,
    so they cost real context — but the breakdown was built from `messages`,
    which is the thread WITHOUT them. On an engine that reports its own token
    count only the colours were off; on one that does not, the number the user
    reads was lower than what was actually sent."""
    events: list[dict[str, Any]] = []

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    async def run(state: dict[str, Any]) -> int:
        events.clear()
        chat = FakeChatModel([Round(content="ok")])
        deps = Deps(chat=chat, emit=emit, cancel=CancelToken(), mcp=FakeMCP())  # type: ignore[arg-type]
        await call_model(state, {"configurable": {"deps": deps}})  # type: ignore[arg-type]
        return next(e for e in events if e["t"] == "usage")["total_tokens"]

    base: dict[str, Any] = {
        "round": 1,
        "max_rounds": 9,
        "messages": [{"role": "user", "content": "what does the lease say"}],
        "tools": [],
        "force_synthesis": False,
        "small_model": True,
    }
    plain = await run(dict(base))
    with_note = await run(
        {**base, "corrections": ["write tools ran but no artifact was recorded"] * 8}
    )
    assert with_note > plain, (
        f"the notes were sent but not counted ({with_note} vs {plain})"
    )


# --------------------------------------------------------------------------- #
# final text
# --------------------------------------------------------------------------- #


async def test_a_turn_that_produced_nothing_does_not_claim_it_is_done() -> None:
    """`Done.` used to be the net for EVERY blank answer, chosen without
    looking at whether anything had happened. Nothing ran, nothing changed and
    the model said nothing — so the one thing the app must not do is report
    success. (Updated 2026-08-01; this test asserted `Done.` here.)"""
    chat = FakeChatModel([Round(content=""), Round(content="")])
    out = await drive(make_request(), chat)
    assert out.final == NOTHING_TEXT
    assert out.of("final")[0]["v"] == NOTHING_TEXT


async def test_whitespace_only_final_is_treated_as_no_answer() -> None:
    chat = FakeChatModel([Round(content="   \n "), Round(content="   \n ")])
    out = await drive(make_request(), chat)
    assert out.final == NOTHING_TEXT


async def test_a_blank_answer_over_real_work_still_says_done() -> None:
    """The one case `Done.` is true: the model produced no words, but the room
    really did change — the referent baton is the evidence."""

    class _WritesThenGoesQuiet(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            usage = RoundUsage(
                input_tokens=None, max_context=8192, is_real=False
            )
            who = self._who(names)
            turn = self.turns.get(who, 0)
            self.turns[who] = turn + 1
            if who == "main" and turn == 0 and names:
                return "", [call("ask_file_agent", instruction="save the notes")], usage
            if who != "main" and turn == 0 and names:
                return "", [call("create_file", name="notes.md", content="x")], usage
            return "", [], usage  # nobody ever writes a word

    out = await drive(make_request("save the notes"), _WritesThenGoesQuiet())  # type: ignore[arg-type]
    assert out.final == "Done."


async def test_a_blank_answer_over_finished_reports_hands_them_back() -> None:
    """The specialists worked and the hub never wrote it up. Their reports are
    already in the findings baton verbatim, so throwing them away and saying
    "Done." was losing real work AND claiming credit for it."""

    class _HubGoesQuiet(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) == "main" and self.turns.get("main", 0) > 0:
                self.turns["main"] += 1
                usage = RoundUsage(
                    input_tokens=None, max_context=8192, is_real=False
                )
                return "", [], usage  # the hub never writes anything up
            return await super().stream(messages, tools, on_delta, cancel)

    out = await drive(
        make_request("what does the lease say"),
        _HubGoesQuiet(batch=[{"agent": "file", "instruction": "read the lease"}]),  # type: ignore[arg-type]
    )
    assert "here is what came back" in out.final
    assert "file did its part" in out.final


async def test_a_turn_whose_specialist_failed_does_not_claim_nothing_ran() -> None:
    """The fourth case. A specialist's report is recorded on SUCCESS only, so a
    turn that dispatched one, had it refused, and then wrote no words had no
    report and no referent — and fell into the "nothing was run and nothing was
    changed" net, which the user read beside a red step chip and a failed node
    in the roster. Two untruths for the price of one."""
    chat = FakeChatModel(
        [
            # web is OFF in this room, so there is no Web specialist to ask.
            Round(content="", calls=[call("ask_web_agent", instruction="the rate")]),
            Round(content=""),  # ...and the hub never writes anything up
        ]
    )
    out = await drive(make_request("what is the central-bank rate?"), chat)
    assert out.final == NOTHING_USABLE_TEXT
    assert out.final != NOTHING_TEXT
    # ...and the roster the user is looking at really does show the failure.
    assert any(e["t"] == "step_status" and not e["ok"] for e in out.events)


async def test_blank_final_stays_blank_when_cancelled() -> None:
    # Never invent "Done." over an answer the user stopped.
    token = CancelToken()
    chat = FakeChatModel([Round(content="", on_stream=token.cancel)])
    out = await drive(make_request(), chat, cancel=token)
    assert out.final == ""
    assert out.of("final")[0]["v"] == ""


async def test_a_real_answer_is_never_overwritten() -> None:
    chat = FakeChatModel(
        [Round(content="The rent is 1200."), Round(content="The rent is 1200.")]
    )
    out = await drive(make_request(), chat)
    assert out.final == "The rent is 1200."


# --------------------------------------------------------------------------- #
# events + message shape
# --------------------------------------------------------------------------- #


async def test_event_sequence() -> None:
    chat = FakeChatModel(
        [
            Round(content="", calls=[call("ask_file_agent", instruction="find the rent")]),
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="Found it; the rent is 1200."),
            Round(content="The rent is 1200."),
        ]
    )
    out = await drive(
        make_request("edit the lease and fix the rent", web_enabled=True, max_rounds=9), chat
    )
    assert out.kinds == [
        "plan",  # roster: the Main agent, thinking
        "agent",
        "round",  # main round 1 (no lane — the Main agent opens no toolbox)
        "usage",
        # The roster is emitted at DISPATCH, before the step chip: the batch of
        # children is launched as a unit, so the UI learns all of it at once
        # rather than one entry at a time as each is awaited.
        "plan",  # roster grew: File agent → Main agent
        "agent",  # File agent active
        "step",  # "Asked the File agent"
        "lane",  # the worker's lane
        "round",
        "delta",  # "looking"
        "usage",
        "step",  # "Searched the room"
        "step_status",
        "round",
        "delta",  # the worker's report text
        "usage",
        # A child FINISHED: its own roster slot flips to done the moment its
        # sub-loop ends — not when the parent gets round to collecting it, or a
        # fast sibling would keep pulsing until the slowest one returned.
        "plan",
        "agent",
        "step_status",  # the delegation call completed
        # The Main agent is marked active once the whole batch is collected,
        # not once per child — with parallel delegation "the batch is done" is
        # a single moment, at the end of the round.
        "plan",  # the Main agent resumes
        "agent",
        "round",  # main round 2
        "delta",  # the user-facing answer
        "usage",
        "final",
    ]
    assert out.of("lane")[0] == {"t": "lane", "v": "Working on your files"}
    assert out.of("delta")[-1]["v"] == "The rent is 1200."
    assert out.of("final")[0]["v"] == "The rent is 1200."

async def test_message_thread_shape() -> None:
    chat = FakeChatModel(
        [
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="done"),
        ]
    )
    out = await drive_worker(make_request(web_enabled=True, max_rounds=9, routing=WRITE_ON), chat)
    roles = [m["role"] for m in out.messages]
    assert roles == ["system", "user", "assistant", "tool"]
    assistant = out.messages[2]
    assert assistant["content"] == "looking"
    assert assistant["tool_calls"][0]["function"]["name"] == "search_room"
    tool = out.messages[3]
    assert tool["tool_name"] == "search_room"
    assert tool["content"] == "ok"


# --- 2026-07-25 regression fixes ---------------------------------------------


def test_seen_key_roundtrips_through_langgraph_serde() -> None:
    """`seen` must survive a checkpoint.

    `ToolCall.key()` used to return a tuple, and LangGraph's JsonPlusSerializer
    turns a `set[tuple]` into `None` — silently, no exception. A checkpointed
    turn would resume with duplicate suppression wiped and then crash on the
    next `set` operation. This pins the key as a string.
    """
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

    key = call("search_room", query="rent").key()
    assert isinstance(key, str), "a tuple key silently serialises to None"

    serde = JsonPlusSerializer()
    memo = {key, call("read_file", name="lease").key()}
    assert serde.loads_typed(serde.dumps_typed(memo)) == memo


async def test_delegation_is_no_longer_capped() -> None:
    """The 5-delegation cap is GONE: every specialist the model asks for runs.

    There used to be a MAX_WORKER_CALLS budget whose refusal had to be memoised
    to stop the turn spinning. With the cap removed the refusal path is gone
    too, so the thing to pin is simply that a sixth (and seventh, and eighth)
    delegation is served rather than refused.
    """
    # Distinct instructions throughout: an identical repeat would be caught by
    # duplicate suppression first, which is a different (already correct) path.
    rounds: list[Round] = []
    for i in range(8):
        rounds.append(
            Round(content="", calls=[call("ask_file_agent", instruction=f"find clause {i}")])
        )
        rounds.append(Round(content=f"Clause {i} says 1200."))
    rounds.append(Round(content="The rent is 1200."))
    chat = FakeChatModel(rounds)
    out = await drive(make_request("what is the rent"), chat)

    assert sum(1 for k in out.kinds if k == "final") == 1
    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert not any("already used all specialist calls" in m["content"] for m in tools)
    # All eight specialists actually ran — none was refused for budget.
    plans = [e["v"] for e in out.of("plan")]
    workers = [p["agent"] for p in plans[-1] if p["agent"] != "chat.answer"]
    assert len(workers) == 8
    assert all("Report from the" in m["content"] for m in tools)


class _NeverStops:
    """A model that asks for one more specialist every single round.

    Not a strawman: measured 2026-07-28, a Main agent starved of conversation
    history (the pre-compaction hand-off) did exactly this — 32 rounds, 890 s,
    16 delegations, ``search_room`` called 14 times, and a final answer of
    "not included in this room's content". Nothing in the loop said stop,
    because ``max_rounds`` bounds ONE loop and every child starts a fresh one.
    """

    def __init__(self) -> None:
        self.rounds = 0

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], Awaitable[None]],
        cancel: Any = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        self.rounds += 1
        usage = RoundUsage(input_tokens=None, max_context=8192, is_real=False)
        names = [t["function"]["name"] for t in tools]
        if "ask_file_agent" in names:
            return "", [call("ask_file_agent", instruction=f"find clause {self.rounds}")], usage
        if "search_room" in names:
            return "", [call("search_room", query=f"clause {self.rounds}")], usage
        # Offered nothing — the tool-less round. This is the ONLY way out.
        await on_delta("Here is what I have.")
        return "Here is what I have.", [], usage


async def _drive_never_stops(turn_max_rounds: int | None) -> tuple[RunOutcome, _NeverStops]:
    chat = _NeverStops()
    # `max_rounds` (per loop) is held at 4 in BOTH arms, so the only difference
    # between them is the turn-wide budget. Without some per-loop cap the
    # unbounded arm would run to AGENT_ROUND_BACKSTOP and never finish.
    out = await drive(
        make_request("what is the rent", max_rounds=4, turn_max_rounds=turn_max_rounds),
        chat,  # type: ignore[arg-type]
    )
    return out, chat


async def test_the_turn_budget_bounds_the_WHOLE_tree_not_one_loop() -> None:
    """The bound the product was missing.

    Mutation-shaped on purpose: the SAME runaway script is driven twice, and
    the only difference is the turn budget. If `Deps.spend_round` stopped
    working, the two arms would spend the same number of rounds and this fails.
    """
    bounded, bounded_chat = await _drive_never_stops(6)
    unbounded, unbounded_chat = await _drive_never_stops(0)  # 0 = disabled

    assert bounded_chat.rounds < unbounded_chat.rounds, (
        "the turn budget changed nothing: per-loop max_rounds is still the only "
        f"bound ({bounded_chat.rounds} vs {unbounded_chat.rounds} rounds)"
    )
    # Every loop still live when the budget trips costs ONE more (tool-less)
    # round to unwind. That is the slack, and it is bounded by tree depth.
    assert bounded_chat.rounds <= 6 + 4
    # Both arms still terminate properly — the budget is not an abort.
    assert sum(1 for k in bounded.kinds if k == "final") == 1
    assert bounded.final.strip(), "an exhausted budget must still produce an answer"


async def test_the_exhausted_budget_is_announced_exactly_once() -> None:
    """The user is told the answer came from what was gathered, not from the
    loop deciding it was finished — once, not once per unwinding loop."""
    out, _ = await _drive_never_stops(6)
    said = [e for e in out.events if e.get("t") == "step" and e.get("v") == ROUND_BUDGET_STEP]
    assert len(said) == 1, f"announced {len(said)} times"


async def test_a_healthy_turn_never_trips_the_budget() -> None:
    """The default is a backstop, not a policy: a normal delegate-then-answer
    turn on the SHIPPED default must not see it at all."""
    chat = FakeChatModel(
        [
            Round(content="", calls=[call("ask_file_agent", instruction="find the rent")]),
            Round(content="The lease says 4200."),
            Round(content="The rent is 4200."),
        ]
    )
    out = await drive(make_request("what is the rent"), chat)  # default budget

    assert not [e for e in out.events if e.get("v") == ROUND_BUDGET_STEP]
    assert "4200" in out.final


def test_the_shipped_default_leaves_room_for_a_full_fan_out() -> None:
    """Six specialists at eight rounds each, plus the hub's own, is 52. The
    default must sit above that or it would be cutting real work short."""
    assert TURN_ROUND_BACKSTOP > 6 * 8 + 4


class _BarrierMCP(FakeMCP):
    """Releases a tool call only once ``width`` of them are in flight at once.

    The proof of real concurrency, and it cannot pass by accident: if the hub
    still ran its children one at a time the first would wait here forever and
    the test would time out rather than quietly assert nothing.
    """

    def __init__(self, width: int, **kw: Any) -> None:
        super().__init__(**kw)
        self.width = width
        self.in_flight = 0
        self.opened = asyncio.Event()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, dict(arguments)))
        self.in_flight += 1
        if self.in_flight >= self.width:
            self.opened.set()
        await asyncio.wait_for(self.opened.wait(), timeout=10)
        return self.results.get(name, self.default)


class _ByCatalogChat:
    """A chat double that answers by WHO is asking, not by call index.

    ``FakeChatModel`` replays a flat list positionally, which is exactly what
    parallel sub-loops scramble — three workers interleaving pull each other's
    scripted rounds. This one identifies the caller from the catalog it was
    offered (only the Main agent is given ask_*; only the web worker gets
    web_search) and keeps a per-caller counter, so the script is stable however
    the children interleave.
    """

    def __init__(self, batch: list[dict[str, Any]] | None = None) -> None:
        self.turns: dict[str, int] = {}
        self.offered: list[list[dict[str, Any]]] = []
        self.seen_messages: list[list[Message]] = []
        self.cancels: list[Any] = []
        #: When set, the Main agent opens with ONE ask_agents call carrying this
        #: plan instead of N separate ask_*_agent calls.
        self.batch = batch
        #: Messages grouped by which worker saw them — the interleaving makes
        #: positional indexing into `seen_messages` meaningless.
        self.seen_by_worker: dict[str, list[list[Message]]] = {}

    @staticmethod
    def _who(names: set[str]) -> str:
        if any(n.startswith("ask_") for n in names):
            return "main"
        if "web_search" in names:
            return "web"
        if "job_status" in names or "start_file_pass" in names:
            return "jobs"
        return "file"

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], Awaitable[None]],
        cancel: Any = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        self.offered.append(list(tools))
        self.seen_messages.append([dict(m) for m in messages])
        self.cancels.append(cancel)
        names = {t["function"]["name"] for t in tools}
        who = self._who(names)
        self.seen_by_worker.setdefault(who, []).append([dict(m) for m in messages])
        turn = self.turns.get(who, 0)
        self.turns[who] = turn + 1
        usage = RoundUsage(input_tokens=None, max_context=8192, is_real=False)

        main_open = (
            [call("ask_agents", tasks=self.batch)]
            if self.batch is not None
            else [
                call("ask_file_agent", instruction="read the lease"),
                call("ask_web_agent", instruction="check the market rate"),
                call("ask_jobs_agent", instruction="how is the pass going"),
            ]
        )
        first_call = {
            "main": main_open,
            "file": [call("search_room", query="rent")],
            "web": [call("web_search", query="market rate")],
            "jobs": [call("job_status")],
        }[who]

        # Round 0 acts; every later round answers. A shape that inserts an extra
        # round (files.read verifies before reporting) just gets the answer.
        if turn == 0 and tools:
            return "", [c for c in first_call if c.name in names], usage
        text = "The rent is 1200." if who == "main" else f"FOUND: {who} did its part."
        await on_delta(text)
        return text, [], usage


def test_plan_waves_groups_independent_tasks_and_orders_dependents() -> None:
    plan = [
        {"instruction": "a", "depends_on": []},
        {"instruction": "b", "depends_on": []},
        {"instruction": "c", "depends_on": [0, 1]},
        {"instruction": "d", "depends_on": [2]},
    ]
    assert plan_waves(plan) == [[0, 1], [2], [3]]


def test_plan_waves_fails_open_on_a_model_that_miscounted() -> None:
    """Every failure mode here is a 4B miscounting, and the cost of dropping a
    task the user asked for is higher than the cost of running it early."""
    # Out-of-range, negative and self-referential deps are ignored, not fatal.
    assert plan_waves([{"instruction": "a", "depends_on": [99, -2, 0]}]) == [[0]]
    # A cycle cannot be scheduled at all — the tasks still run, together.
    cyclic = [
        {"instruction": "a", "depends_on": [1]},
        {"instruction": "b", "depends_on": [0]},
    ]
    assert plan_waves(cyclic) == [[0, 1]]
    # A partial cycle still lets the schedulable part go first.
    mixed = [
        {"instruction": "a", "depends_on": []},
        {"instruction": "b", "depends_on": [2]},
        {"instruction": "c", "depends_on": [1]},
    ]
    waves = plan_waves(mixed)
    assert waves[0] == [0]
    assert sorted(i for w in waves for i in w) == [0, 1, 2], "no task may be dropped"


def test_parse_plan_salvages_what_a_small_model_actually_emits() -> None:
    # The arguments object arriving as a JSON STRING (some engines do this).
    assert parse_plan('[{"agent": "web", "instruction": "x"}]') == [
        {"agent": "web", "instruction": "x", "depends_on": []}
    ]
    # A dict rather than the bare list.
    assert parse_plan({"tasks": [{"agent": "file", "instruction": "y"}]})[0]["agent"] == "file"
    # Bare strings — a plausible shortcut — become default-routed tasks.
    assert parse_plan(["just do it"]) == [
        {"agent": "", "instruction": "just do it", "depends_on": []}
    ]
    # Aliases the model reaches for, and string dep indices.
    got = parse_plan([{"domain": "jobs", "task": "run it", "after": ["0"]}])
    assert got == [{"agent": "jobs", "instruction": "run it", "depends_on": [0]}]
    # Unusable input yields nothing rather than a half-formed task.
    assert parse_plan(None) == []
    assert parse_plan([{"agent": "file"}]) == []


async def test_ask_agents_runs_independent_tasks_in_one_parallel_wave() -> None:
    """The whole point of the batch tool: ONE tool call, N concurrent children.

    A small model emitting three separate calls in a round is the thing BFCL
    measures it worst at; emitting one call whose argument is a list of three
    is the regime it is reliable in. So the parallelism has to come from the
    plan's shape, and this pins that it does.
    """
    chat = _ByCatalogChat(
        batch=[
            {"agent": "file", "instruction": "read the lease"},
            {"agent": "web", "instruction": "check the market rate"},
            {"agent": "jobs", "instruction": "how is the pass going"},
        ]
    )
    mcp = _BarrierMCP(width=3)
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        chat,  # type: ignore[arg-type]
        mcp=mcp,
    )

    assert mcp.opened.is_set(), "the three tasks never overlapped"
    tools = [m for m in out.messages if m.get("role") == "tool"]
    batch_msgs = [m for m in tools if m.get("tool_name") == "ask_agents"]
    assert len(batch_msgs) == 1, "one call in, one tool message out"
    # Every task's report is in it, labelled by the position depends_on uses.
    for i in range(3):
        assert f"Task {i} —" in batch_msgs[0]["content"]


async def test_only_one_loop_at_a_time_streams_into_the_live_answer_area() -> None:
    """There is exactly ONE live answer area in the UI, and a `round` event
    BLANKS it before the deltas that follow.

    A hub round dispatches its whole batch at once, and every child streamed
    into that same area: the user watched fragments of three specialists
    shuffled together and repeatedly erased, and read-aloud spoke the jumble.
    Whoever claims the area first holds it for its round; the rest stay quiet
    and are still visible as step chips and roster nodes.
    """
    class _Streaming(_ByCatalogChat):
        """A round that SUSPENDS, the way a real streaming engine does. The
        plain double never awaits anything, so its siblings can only ever run
        one-at-a-time and the interleaving under test cannot happen."""

        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            await asyncio.sleep(0)
            return await super().stream(messages, tools, on_delta, cancel)

    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        _Streaming(),  # the 3-way per-domain fan-out  # type: ignore[arg-type]
        mcp=_BarrierMCP(width=3),  # nothing proceeds until all three overlap
    )

    # Every `round`/`delta` names the loop it came from, so a consumer can
    # attribute the words rather than assume whose they are...
    live = [e for e in out.events if e["t"] in ("round", "delta")]
    assert all(e.get("node") for e in live)
    # ...and inside one live block — a `round` and the deltas it precedes —
    # there is only ever ONE of them.
    owner = ""
    for e in live:
        if e["t"] == "round":
            owner = e["node"]
        else:
            assert e["node"] == owner, (
                f"{e['node']}'s words landed in {owner}'s live block: {e['v']!r}"
            )
    # ...and the user's actual answer is unaffected.
    assert out.final == "The rent is 1200."


async def test_ask_agents_holds_a_dependent_task_until_its_deps_report() -> None:
    """`depends_on` has to actually gate, and the dependency's findings have to
    travel — otherwise it is decoration and the dependent agent re-does the
    work its sibling already did."""
    order: list[str] = []

    class _OrderedMCP(FakeMCP):
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
            order.append(name)
            self.calls.append((name, dict(arguments)))
            return ToolResult(text=f"result of {name}")

    chat = _ByCatalogChat(
        batch=[
            {"agent": "file", "instruction": "read the lease"},
            {"agent": "web", "instruction": "check the market rate", "depends_on": [0]},
        ]
    )
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        chat,  # type: ignore[arg-type]
        mcp=_OrderedMCP(),
    )

    # The dependent wave cannot start before the wave it depends on finished.
    assert order.index("search_room") < order.index("web_search")
    # ...and the dependency's report reached it, verbatim, in its kickoff note.
    web_kickoff = next(
        m
        for msgs in chat.seen_by_worker["web"]
        for m in msgs
        if "earlier steps this one depends on" in (m.get("content") or "")
    )
    assert "file did its part" in web_kickoff["content"]

    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert any("Task 0 —" in m["content"] and "Task 1 —" in m["content"] for m in tools)


async def test_a_later_round_specialist_gets_the_earlier_rounds_findings() -> None:
    """Cross-ROUND delegations carried artifact NAMES, not findings.

    `depends_on` inside one `ask_agents` call already handed a task its
    dependencies' reports verbatim. The round-to-round chain — "find X", then
    next round "act on X" — got only the referent baton, which lists files a
    sibling WROTE and can say nothing about what a sibling READ. So the hub had
    to restate the finding inside its next instruction, which is exactly the
    "no model should have to remember another's work" rule this design states.
    """
    seen_by_second: list[str] = []

    class _TwoRounds(_ByCatalogChat):
        """Round 1 delegates to the File agent; round 2 to the Web agent."""

        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            who = self._who(names)
            usage = RoundUsage(
                input_tokens=None, max_context=8192, is_real=False
            )
            if who == "main":
                turn = self.turns.get("main", 0)
                self.turns["main"] = turn + 1
                if turn == 0:
                    return "", [call("ask_file_agent", instruction="what is the rent")], usage
                if turn == 1:
                    return "", [call("ask_web_agent", instruction="is that above market")], usage
                await on_delta("It is above market.")
                return "It is above market.", [], usage
            if who == "web":
                seen_by_second.extend(
                    str(m.get("content") or "") for m in messages if m.get("role") == "user"
                )
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _TwoRounds()
    out = await drive(
        make_request("is my rent above market", web_enabled=True),
        chat,  # type: ignore[arg-type]
    )

    assert out.final
    joined = "\n".join(seen_by_second)
    assert "reported earlier in this turn" in joined, (
        "round 2's specialist was never told what round 1 found"
    )
    assert "file did its part" in joined, (
        f"the earlier FINDING did not travel, only its shape: {joined[:400]}"
    )


async def test_a_delegation_that_returns_nothing_is_reported_as_failed() -> None:
    """`ok` was a hardcoded True, so a delegation could never fail.

    Consequences, all of them lies the user could see: `step_status` was always
    green, the roster entry always flipped to "done" (the UI's `failed` state
    was unreachable), and the turn progress log — which this file's own comment
    calls "the small model's only record of what actually happened" — said
    "report received" on the exact branch whose message is "returned no report".
    """

    class _SilentWorker(_ByCatalogChat):
        """The worker answers with empty text — nothing to report."""

        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) != "main":
                usage = RoundUsage(
                    input_tokens=None, max_context=8192, is_real=False
                )
                return "", [], usage
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _SilentWorker(batch=[{"agent": "file", "instruction": "read the lease"}])
    out = await drive(make_request("what does the lease say"), chat)  # type: ignore[arg-type]

    assert any(e.get("ok") is False for e in out.of("step_status")), (
        "a specialist that returned nothing was reported as a success"
    )
    plans = [e["v"] for e in out.of("plan")]
    kids = [e for e in plans[-1] if e["key"] != "main"]
    assert any(e["status"] == "failed" for e in kids), (
        f"the roster shows no failed node: {[e['status'] for e in kids]}"
    )


async def test_a_specialist_this_room_lacks_is_refused_on_the_direct_path_too() -> None:
    """The batch dispatcher has always refused a domain the room cannot serve.
    The direct `ask_*_agent` path checked nothing and just called
    `resolve_worker`, which falls back to the DEFAULT worker when every member
    of a domain is unreachable — so a weather question in a web-off room was
    answered out of the user's own documents, labelled "File agent"."""

    class _AsksForWeb(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            usage = RoundUsage(
                input_tokens=None, max_context=8192, is_real=False
            )
            who = self._who(names)
            turn = self.turns.get(who, 0)
            self.turns[who] = turn + 1
            self.seen_messages.append([dict(m) for m in messages])
            if who == "main" and turn == 0 and names:
                # A domain that is NOT in this room's catalog — a small model
                # naming a specialist it remembers from another room.
                return "", [call("ask_web_agent", instruction="the weather")], usage
            return "I cannot check the weather in this room.", [], usage

    chat = _AsksForWeb()
    out = await drive(make_request("what's the weather", web_enabled=False), chat)  # type: ignore[arg-type]

    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert any("no 'web' specialist" in (m.get("content") or "") for m in tools), (
        f"the phantom domain was dispatched instead of refused: {tools}"
    )
    assert "MISSING" in tools[0]["content"]
    # No worker ran at all: the File agent was never handed the web question.
    assert set(chat.turns) == {"main"}, chat.turns
    # ...and it is in the live picture as the failed node it is (finding 416).
    roster = out.of("plan")[-1]["v"]
    kids = [e for e in roster if e["key"] != "main"]
    assert [e["status"] for e in kids] == ["failed"], roster


async def test_an_impossible_batch_task_is_drawn_as_a_failed_node() -> None:
    """It was reported in TEXT and silently absent from the diagram — so the
    picture showed a turn that never asked for the thing the user asked for."""
    out = await drive(
        make_request("compare my rent to the market", web_enabled=False),
        _ByCatalogChat(  # type: ignore[arg-type]
            batch=[
                {"agent": "file", "instruction": "read the lease"},
                {"agent": "web", "instruction": "check the market rate"},
            ]
        ),
    )
    roster = out.of("plan")[-1]["v"]
    kids = [e for e in roster if e["key"] != "main"]
    assert len(kids) == 2, f"the impossible task is missing from the roster: {kids}"
    assert sorted(e["status"] for e in kids) == ["done", "failed"], kids


async def test_a_repeated_delegation_is_answered_from_the_first_outcome() -> None:
    """Even when the first one came back EMPTY.

    Memoisation was gated on `ok`, which is the right rule for a room tool — a
    failed call may be transient, so SPEC §3.2 leaves it out of `seen` and lets
    a later round retry it. A delegation is not one call: re-running it spends a
    whole child loop, which is real waiting and, on a cloud room, real money.
    The empty report is already in the thread, and `duplicate_call_note` points
    the model at it while inviting a DIFFERENT instruction — which, having its
    own `ToolCall.key`, still runs.
    """

    class _AsksTwice(_ByCatalogChat):
        #: Rounds where a FILE worker was actually handed its own box — i.e. how
        #: many times the specialist was run. A tool-less round carries no
        #: catalog at all, so `_who` cannot tell those apart.
        worker_runs = 0

        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            usage = RoundUsage(
                input_tokens=None, max_context=8192, is_real=False
            )
            who = self._who(names)
            turn = self.turns.get(who, 0)
            self.turns[who] = turn + 1
            self.seen_messages.append([dict(m) for m in messages])
            if who != "main":
                if "search_room" in names:
                    self.worker_runs += 1
                return "", [], usage  # the specialist reports nothing
            if turn < 2 and names:
                return "", [call("ask_file_agent", instruction="read the lease")], usage
            return "I could not read the lease.", [], usage

    chat = _AsksTwice()
    out = await drive(make_request("what does the lease say"), chat)  # type: ignore[arg-type]

    assert chat.worker_runs == 1, (
        f"the empty specialist was re-run from scratch ({chat.worker_runs}x)"
    )
    assert any(
        "Duplicate call" in (m.get("content") or "")
        for m in out.messages
        if m.get("role") == "tool"
    ), "the repeat was not answered from the first outcome"


async def test_one_crashing_specialist_does_not_kill_the_whole_ask() -> None:
    """A single delegation's crash used to re-raise and end the turn — throwing
    away every sibling report that had already succeeded — while the identical
    crash inside `ask_agents` degraded to one failure line. The safe behaviour
    is now the default, not the special case."""

    class _Boom(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) == "web":
                raise RuntimeError("the web model fell over")
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _Boom()  # the 3-way per-domain fan-out, not the batch tool
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        chat,  # type: ignore[arg-type]
    )

    assert out.final, "the ask died instead of answering with what it had"
    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert any("could not finish" in (m.get("content") or "") for m in tools), (
        "the crash was not reported to the Main agent"
    )
    # ...and the healthy siblings' reports still arrived.
    assert sum(1 for m in tools if "Report from the" in (m.get("content") or "")) >= 2


async def test_a_crash_with_no_message_is_still_reported_with_a_reason() -> None:
    """"failed:" with nothing after it is not a report.

    `str()` on several of the errors that actually reach these paths — the
    asyncio timeout, a bare httpx transport error — is the EMPTY STRING, and
    both delegation paths interpolated the exception raw. The line then travels
    to the Main agent and from there to the user, saying nothing at all.
    """

    class _SilentBoom(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) == "web":
                raise asyncio.TimeoutError()  # str() == ""
            return await super().stream(messages, tools, on_delta, cancel)

    # The direct ask_*_agent path...
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        _SilentBoom(),  # type: ignore[arg-type]
    )
    tools = [m for m in out.messages if m.get("role") == "tool"]
    crash = next(m for m in tools if "could not finish" in (m.get("content") or ""))
    assert crash["content"].rstrip().endswith("TimeoutError"), (
        f"the crash was reported with no reason at all: {crash['content']!r}"
    )

    # ...and the batch path, which formats its own failure line.
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        _SilentBoom(  # type: ignore[arg-type]
            batch=[
                {"agent": "file", "instruction": "read the lease"},
                {"agent": "web", "instruction": "check the market rate"},
            ]
        ),
    )
    tools = [m for m in out.messages if m.get("role") == "tool"]
    batch_msg = next(m for m in tools if m.get("tool_name") == "ask_agents")
    assert "failed: TimeoutError" in batch_msg["content"], (
        f"the failed task carries no reason: {batch_msg['content']!r}"
    )


async def test_a_failing_task_does_not_strand_its_siblings() -> None:
    """One task blowing up must cost that task, not the batch — the Main agent
    is told which one failed and still gets everything else."""

    class _Boom(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) == "web":
                raise RuntimeError("the web agent exploded")
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _Boom(
        batch=[
            {"agent": "file", "instruction": "read the lease"},
            {"agent": "web", "instruction": "check the market rate"},
        ]
    )
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True),
        chat,  # type: ignore[arg-type]
    )

    tools = [m for m in out.messages if m.get("role") == "tool"]
    batch_msg = next(m for m in tools if m.get("tool_name") == "ask_agents")
    assert "failed" in batch_msg["content"], "the failure must be reported, not hidden"
    assert "Task 0 —" in batch_msg["content"], "the healthy sibling still reports"


async def test_a_partial_batch_is_memoised_and_its_findings_reach_the_next_round() -> None:
    """Two tasks, one of them impossible: the ONE that worked must still count.

    `run_plan`'s `ok` was the AND of the per-task outcomes, and in the batch
    branch `ok=False` skips BOTH `seen.add(key)` and `reports_so_far.append`. So
    a partial batch (the common shape — one unavailable domain among several
    real tasks) lost the successful task's report out of the findings baton, and
    left the whole batch unmemoised so the model could re-emit it and the work
    that HAD succeeded was re-run and re-paid for. Partial success counts as
    success for exactly those two purposes; the report text stays truthful about
    the task that could not run.
    """
    # Web is OFF in this room, so task 1's domain is recognised-but-unavailable
    # — the phantom-key guard reports it MISSING instead of misrouting it.
    plan = [
        {"agent": "file", "instruction": "read the lease"},
        {"agent": "web", "instruction": "check the market rate"},
    ]

    class _RepeatsTheBatch(_ByCatalogChat):
        """Round 0: the batch. Round 1: the SAME batch plus one fresh
        delegation — the second live call keeps the round from being
        all-duplicate, so the loop still reaches round 2. Round 2: the answer."""

        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) != "main":
                return await super().stream(messages, tools, on_delta, cancel)
            self.seen_by_worker.setdefault("main", []).append([dict(m) for m in messages])
            usage = RoundUsage(
                input_tokens=None, max_context=8192, is_real=False
            )
            turn = self.turns.get("main", 0)
            self.turns["main"] = turn + 1
            if turn == 0:
                return "", [call("ask_agents", tasks=plan)], usage
            if turn == 1:
                return (
                    "",
                    [
                        call("ask_agents", tasks=plan),
                        call("ask_file_agent", instruction="now act on the rent"),
                    ],
                    usage,
                )
            await on_delta("The rent is 1200.")
            return "The rent is 1200.", [], usage

    chat = _RepeatsTheBatch()
    out = await drive(make_request("compare my rent to the market"), chat)  # type: ignore[arg-type]
    assert out.final

    main_thread = chat.seen_by_worker["main"][-1]
    batch_msgs = [
        m
        for m in main_thread
        if m.get("role") == "tool" and m.get("tool_name") == "ask_agents"
    ]
    assert len(batch_msgs) == 2, "the repeat should have been answered, not re-run"
    # The report is still exactly as truthful as before: the good task reports,
    # the impossible one says so in its own line.
    assert "Task 0 —" in batch_msgs[0]["content"]
    assert "could not run" in batch_msgs[0]["content"]
    # Memoised: round 1's identical batch got the duplicate note, so the two
    # real tasks were never re-run or re-paid for.
    assert batch_msgs[1]["content"] == duplicate_call_note("ask_agents"), (
        f"the partial batch was re-run instead of memoised: {batch_msgs[1]['content'][:200]}"
    )
    # ...and the successful task's report entered the findings baton, so the
    # NEXT round's specialist was told what the last one found.
    kickoffs = [
        str(m.get("content") or "")
        for msgs in chat.seen_by_worker["file"]
        for m in msgs
        if "reported earlier in this turn" in (m.get("content") or "")
    ]
    assert kickoffs, "the partial batch's findings never reached the next round"
    assert "file did its part" in kickoffs[0], (
        f"the finding did not travel, only its shape: {kickoffs[0][:400]}"
    )
    # The progress log names the plan's SIZE — the count is carried from the
    # fan-out's parse rather than re-parsed here, so it must still be right.
    notes = [
        str(m.get("content") or "")
        for msgs in chat.seen_by_worker["main"]
        for m in msgs
        if "Progress this turn" in (m.get("content") or "")
    ]
    assert any("ask_agents(2 tasks) -> reports received" in n for n in notes), notes


async def test_an_unusable_plan_gets_a_corrective_note_not_silence() -> None:
    """An empty report reads as "done" to the model. A plan it can't run has to
    come back as a correction with the shape spelled out."""
    chat = _ByCatalogChat(batch=[{"agent": "file"}])  # no instruction anywhere
    out = await drive(make_request("do several things"), chat)  # type: ignore[arg-type]
    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert any(m["content"] == EMPTY_PLAN_NOTE for m in tools)


async def test_delegations_in_one_round_run_in_parallel() -> None:
    """Three ask_*_agent calls in ONE reply overlap in time.

    The hub used to await each sub-loop before starting the next, so three
    delegations cost the sum of their latencies. They are now launched as a
    batch and awaited in call order, so a round costs the SLOWEST child rather
    than the sum. Pinned on a barrier the children must reach together, not on
    wall-clock, which would be flaky under load.
    """
    chat = _ByCatalogChat()
    mcp = _BarrierMCP(width=3)
    # A ':cloud' model opts out of small-model mode, which caps a round to ONE
    # call — the product does the same. Parallel delegation needs several.
    out = await drive(
        make_request(
            "compare my rent to the market",
            web_enabled=True,
            model="qwen3:cloud",
        ),
        chat,  # type: ignore[arg-type]
        mcp=mcp,
    )

    assert mcp.opened.is_set(), "three children never overlapped — still sequential"
    # Reports land in CALL order, whatever order the children finished in.
    tools = [m for m in out.messages if m.get("role") == "tool"]
    delegations = [m for m in tools if str(m.get("tool_name", "")).startswith("ask_")]
    assert [m["tool_name"] for m in delegations] == [
        "ask_file_agent",
        "ask_web_agent",
        "ask_jobs_agent",
    ]
    assert all("Report from the" in m["content"] for m in delegations)


async def test_a_parallel_batch_is_legible_in_the_roster() -> None:
    """The graph view's whole contract, asserted on the event stream.

    A flat roster plus one active marker cannot say "three of these are running
    right now" — which is exactly what the hub does since delegations went
    parallel. So every `plan` is a COMPLETE snapshot in which each entry carries
    its own status, the round that dispatched it (`batch`), and a `key` that
    addresses it uniquely; and every `step` names the node that emitted it.
    Without those four facts the UI is guessing, and with concurrent children
    guessing is wrong.
    """
    chat = _ByCatalogChat()
    mcp = _BarrierMCP(width=3)
    out = await drive(
        make_request("compare my rent to the market", web_enabled=True, model="qwen3:cloud"),
        chat,  # type: ignore[arg-type]
        mcp=mcp,
    )
    plans = [e["v"] for e in out.of("plan")]

    # The dispatch snapshot: all three children live AT ONCE, one batch, and the
    # hub explicitly NOT running (it is waiting on them).
    dispatch = next(p for p in plans if sum(1 for e in p if e["status"] == "running") == 3)
    kids = [e for e in dispatch if e["key"] != "main"]
    assert [e["agent"] for e in kids] == ["files.read", "chat.web", "jobs.run"]
    assert {e["batch"] for e in kids} == {0}, "one round dispatched them; one batch"
    assert len({e["key"] for e in kids}) == 3, "keys must address nodes uniquely"
    assert dispatch[-1]["key"] == "main" and dispatch[-1]["status"] == "pending"

    # Children finish INDEPENDENTLY: some snapshot has a done child beside a
    # still-running sibling. That frame is the feature — it cannot be inferred
    # from roster growth, because the roster stops growing at dispatch.
    assert any(
        any(e["status"] == "done" for e in p if e["key"] != "main")
        and any(e["status"] == "running" for e in p if e["key"] != "main")
        for p in plans
    ), "no frame showed one child done while another still ran"

    # Terminal state: every child done, hub running its answer round.
    final_plan = plans[-1]
    assert [e["status"] for e in final_plan] == ["done", "done", "done", "running"]

    # Every step is attributed, and the delegation steps belong to the hub while
    # the room-tool steps belong to the child that actually ran them.
    by_node: dict[str, list[str]] = {}
    for e in out.of("step"):
        by_node.setdefault(e["node"], []).append(e["v"])
    assert by_node["main"] == ["Asked the File agent", "Asked the Web agent", "Asked the Jobs agent"]
    assert {k for k in by_node if k != "main"} == {e["key"] for e in kids}
    assert by_node["files.read#0"] == ["Searched the room"]


# --------------------------------------------------------------------------- #
# bounded fan-out + the shared-ChatModel denominator race
# --------------------------------------------------------------------------- #


async def test_a_local_room_serializes_its_children() -> None:
    """N concurrent children against ONE resident model is contention, not
    throughput — and each inflates the payload the others fit a window to.

    `wf_nodes.NodeDeps.parallel` already makes this call for the workflow lanes
    and defaults to 1; the hub's fan-out shipped unbounded, which is the gap.
    Asserted on peak overlap, not on wall-clock.
    """
    peak = {"now": 0, "max": 0}

    class _Tracking(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) != "main":
                peak["now"] += 1
                peak["max"] = max(peak["max"], peak["now"])
                try:
                    await asyncio.sleep(0)
                    return await super().stream(messages, tools, on_delta, cancel)
                finally:
                    peak["now"] -= 1
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _Tracking()
    events: list[dict[str, Any]] = []

    async def emit(e):  # type: ignore[no-untyped-def]
        events.append(e)

    deps = Deps(
        chat=chat,  # type: ignore[arg-type]
        emit=emit,
        cancel=CancelToken(),
        mcp=FakeMCP(),
        worker_parallel=1,
    )
    from arcelle_sidecar.graph import run_agent

    await run_agent(make_request("compare my rent", web_enabled=True), deps)
    assert peak["max"] == 1, (
        f"a local room ran {peak['max']} children at once against one resident model"
    )


async def test_a_cloud_room_still_fans_out() -> None:
    """The bound of 1 is a LOCAL concession — a cloud engine holds no resident
    model, and serializing it would throw away the whole point of the parallel
    hub. It is bounded all the same (`config.CLOUD_WORKER_PARALLEL`): unbounded
    meant a twenty-task plan opened twenty PAID conversations at once."""
    peak = {"now": 0, "max": 0}

    class _Tracking(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self._who(names) != "main":
                peak["now"] += 1
                peak["max"] = max(peak["max"], peak["now"])
                try:
                    await asyncio.sleep(0.01)
                    return await super().stream(messages, tools, on_delta, cancel)
                finally:
                    peak["now"] -= 1
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _Tracking()

    async def emit(e):  # type: ignore[no-untyped-def]
        return None

    deps = Deps(
        chat=chat,  # type: ignore[arg-type]
        emit=emit,
        cancel=CancelToken(),
        mcp=FakeMCP(),
        worker_parallel=CLOUD_WORKER_PARALLEL,  # cloud (server.py)
    )
    from arcelle_sidecar.graph import run_agent

    await run_agent(make_request("compare my rent", web_enabled=True), deps)
    assert peak["max"] > 1, "the cloud fan-out was serialized"
    assert peak["max"] <= CLOUD_WORKER_PARALLEL, "the cloud fan-out is unbounded again"


async def test_the_token_bar_denominator_is_per_call_not_per_instance() -> None:
    """ONE ChatModel is shared by every concurrent child (`Deps.chat`), so
    instance state is last-writer-wins.

    `_round_usage` read `self._last_num_ctx`, which a sibling could overwrite
    between the write and the read — two local children whose payloads land in
    different NUM_CTX_BUCKETS published each other's denominator. That is the
    same class of untruthful token bar the 2026-07-21 live QA already fixed.
    """
    from arcelle_sidecar.chat import OllamaChatModel

    model = OllamaChatModel(model="qwen3.5:4b", base_url="http://127.0.0.1:11434")
    # A sibling has just clobbered the instance field...
    model._last_num_ctx = 4096
    # ...but THIS call resolved a different window, and passes it explicitly.
    usage = await model._round_usage(None, 32768)
    assert usage.max_context == 32768, (
        "the denominator came from shared instance state, not from this call"
    )
    # Callers that have not threaded it keep the old fallback.
    assert (await model._round_usage(None)).max_context == 4096


async def test_stop_keeps_the_work_that_already_finished() -> None:
    """Stop must not throw away specialists that already reported.

    The turn returned `final_text`, which is empty when Stop lands before the
    hub composes — so a user who stopped after two specialists had genuinely
    finished saw a turn that did nothing. Their work is already in the findings
    baton, verbatim, so surfacing it costs no model call and invents nothing.
    """
    token = CancelToken()

    class _StopAfterFirstReport(_ByCatalogChat):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            who = self._who(names)
            if who == "main":
                turn = self.turns.get("main", 0)
                self.turns["main"] = turn + 1
                usage = RoundUsage(
                    input_tokens=None, max_context=8192, is_real=False
                )
                if turn == 0:
                    return "", [call("ask_file_agent", instruction="read the lease")], usage
                # The report is in; the user hits Stop before the hub answers.
                token.cancel()
                return "", [], usage
            return await super().stream(messages, tools, on_delta, cancel)

    chat = _StopAfterFirstReport()
    out = await drive(make_request("what does the lease say"), chat, cancel=token)  # type: ignore[arg-type]

    assert out.final, "Stop discarded a specialist's completed work"
    assert "file did its part" in out.final, (
        f"the finished report did not survive Stop: {out.final!r}"
    )
    # ...and it must not be dressed up as a complete answer.
    assert "Stopped" in out.final


async def test_stop_with_nothing_finished_still_says_nothing() -> None:
    """The other half: never invent an answer over a turn the user stopped
    before anything came back. SPEC §3.2's rule, unchanged."""
    token = CancelToken()
    chat = FakeChatModel([Round(content="", on_stream=token.cancel)])
    out = await drive(make_request(), chat, cancel=token)
    assert out.final == ""


# --------------------------------------------------------------------------- #
# the fan-out unit, on its own (`_Delegator`)
# --------------------------------------------------------------------------- #
#
# The whole point of extracting `_Delegator` out of `execute_tools`
# (2026-07-30): wave scheduling, a failing sibling and the drain-on-Stop path
# used to be reachable only through a full `run_agent` with a scripted model per
# child. These drive the fan-out directly, with `_run_worker` stubbed, so a
# scheduling regression fails here instead of somewhere in a 9-event stream.


def _delegator(
    *,
    events: list[Event] | None = None,
    cancel: CancelToken | None = None,
    web_enabled: bool = True,
) -> _Delegator:
    """A `_Delegator` wired to doubles, with an empty roster."""
    sink = events if events is not None else []

    async def emit(event: Event) -> None:
        sink.append(event)

    deps = Deps(
        chat=FakeChatModel([]),  # type: ignore[arg-type]
        emit=emit,
        cancel=cancel if cancel is not None else CancelToken(),
        mcp=FakeMCP(),  # type: ignore[arg-type]
    )
    return _Delegator(
        deps=deps,
        config={"configurable": {"deps": deps}},
        state={  # type: ignore[typeddict-item]
            "question": "compare my rent to the market",
            "web_enabled": web_enabled,
            "run_max_rounds": AGENT_ROUND_BACKSTOP,
        },
        pipeline=[],
        batch=0,
        referents_at_launch=[],
        carryover=(),
        served_names=set(BUILTIN_TOOL_NAMES),
        # Derived exactly as `for_round` derives it: the guard and the catalog
        # the model chose from must read the same list.
        live_domain_keys=reachable_domain_keys(
            web_enabled=web_enabled, served_names=set(BUILTIN_TOOL_NAMES)
        ),
    )


async def test_the_delegator_holds_a_wave_until_its_dependency_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`depends_on` gates the SCHEDULE, and the dependency's report travels."""
    order: list[str] = []
    upstreams: dict[str, tuple[str, ...]] = {}

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        order.append(f"start {instruction}")
        upstreams[instruction] = tuple(upstream)
        # Yield: if these two ran in ONE wave they would interleave here, and
        # the ordering assertion below could not pass by accident.
        await asyncio.sleep(0)
        order.append(f"end {instruction}")
        return WorkerOutcome(f"FOUND: {instruction}", True, False, [])

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    d = _delegator()
    out = await d.run_plan(
        [
            {"agent": "file", "instruction": "read the lease", "depends_on": []},
            {"agent": "web", "instruction": "check the market", "depends_on": [0]},
        ]
    )

    assert order.index("end read the lease") < order.index("start check the market")
    assert upstreams["read the lease"] == (), "wave 0 has nothing upstream of it"
    assert any("FOUND: read the lease" in u for u in upstreams["check the market"]), (
        f"the dependency's finding did not travel: {upstreams['check the market']}"
    )
    assert out.ok
    assert "Task 0 —" in out.report and "Task 1 —" in out.report
    # Waves are legible in the roster — that is what the batch number is for.
    assert [e["batch"] for e in d.pipeline] == [0, 1]
    assert [e["status"] for e in d.pipeline] == ["done", "done"]


async def test_two_plans_in_one_round_do_not_share_a_later_band(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The batch number is the ONE fact that says "these ran at the same time".

    It used to be `round batch + wave index`, so two `ask_agents` calls emitted
    in the same round had their SECOND waves drawn as one group however far
    apart they actually ran. Only the opening waves genuinely start together —
    that is what a round dispatching both plans at once means — so those keep
    the round's band and every later wave takes its own.
    """

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        await asyncio.sleep(0)
        return WorkerOutcome(f"FOUND: {instruction}", True, False, [])

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    d = _delegator()
    chain = [
        {"agent": "file", "instruction": "first", "depends_on": []},
        {"agent": "web", "instruction": "second", "depends_on": [0]},
    ]
    await asyncio.gather(
        d.run_plan([dict(t) for t in chain]), d.run_plan([dict(t) for t in chain])
    )

    bands = {e["instruction"]: e["batch"] for e in d.pipeline}
    firsts = [e["batch"] for e in d.pipeline if e["instruction"] == "first"]
    seconds = [e["batch"] for e in d.pipeline if e["instruction"] == "second"]
    assert firsts == [d.batch, d.batch], f"the opening waves did not run together: {bands}"
    assert len(set(seconds)) == 2, f"two unrelated later waves share a band: {bands}"
    assert d.batch not in seconds, "a later wave was drawn inside the opening band"


async def test_the_delegator_keeps_a_batch_alive_when_one_task_blows_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One task's crash costs that task, not the batch — and the surviving
    task's report still makes the plan a success (the partial-batch rule)."""

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        if "market" in instruction:
            raise RuntimeError("the web model fell over")
        return WorkerOutcome("FOUND: rent is 1200", True, False, ["create_file: notes.md"])

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    d = _delegator()
    out = await d.run_plan(
        [
            {"agent": "file", "instruction": "read the lease"},
            {"agent": "web", "instruction": "check the market"},
        ]
    )

    assert "Task 0 —" in out.report, "the healthy sibling was stranded"
    assert "Task 1" in out.report and "failed" in out.report, "the crash was hidden"
    assert out.ok, "a partial batch must still count as a success (2026-07-30)"
    assert not out.cancelled
    assert out.referents == ["create_file: notes.md"], "the survivor's baton was lost"
    assert [e["status"] for e in d.pipeline] == ["done", "failed"]


async def test_the_delegator_drain_cancels_a_child_still_in_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop between tool calls must not orphan a running sub-loop — and the
    child's roster slot must stop pulsing rather than hang on `running`."""
    started = asyncio.Event()

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        started.set()
        await asyncio.sleep(3600)  # only cancellation gets us out of here
        raise AssertionError("unreachable")

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    d = _delegator()
    await d.launch([call("ask_file_agent", instruction="read the lease")], set())
    assert len(d.tasks) == 1 and len(d.pipeline) == 1
    assert list(d.launched_label) == ["c_ask_file_agent"]
    await asyncio.wait_for(started.wait(), timeout=5)

    await d.drain()

    task = next(iter(d.tasks.values()))
    assert task.done() and task.cancelled(), "the child outlived the turn"
    assert [e["status"] for e in d.pipeline] == ["failed"]


async def test_the_delegator_never_launches_a_duplicate_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`seen` (this turn's successes) and `launched` (this round's dispatches)
    both have to suppress a second worker — the sequential pass answers the
    repeat from the duplicate note, and a second child would re-pay for it."""

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        return WorkerOutcome("FOUND: rent is 1200", True, False, [])

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    repeat = call("ask_file_agent", instruction="read the lease")

    memoised = _delegator()
    await memoised.launch([repeat], {repeat.key()})
    assert memoised.tasks == {} and memoised.pipeline == []

    same_round = _delegator()
    await same_round.launch([repeat, repeat], set())
    assert len(same_round.tasks) == 1
    assert len(same_round.pipeline) == 1, "the repeat got its own worker"
    await same_round.drain()


async def test_the_delegator_stops_between_waves_when_stop_lands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`run_plan` checks Stop BETWEEN waves, so a plan the user stopped costs
    the waves already running and nothing more. Wave 1 must not launch, the
    batch must report itself cancelled, and no roster slot may be claimed for a
    task that never ran (a claimed slot pulses forever in the UI)."""
    token = CancelToken()
    started: list[str] = []

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        started.append(instruction)
        # Stop lands WHILE wave 0 runs — the child itself finishes cleanly, so
        # `cancelled` can only come from the between-waves check.
        token.cancel()
        return WorkerOutcome(f"FOUND: {instruction}", True, False, [])

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    d = _delegator(cancel=token)
    out = await d.run_plan(
        [
            {"agent": "file", "instruction": "read the lease", "depends_on": []},
            {"agent": "web", "instruction": "check the market", "depends_on": [0]},
        ]
    )

    assert started == ["read the lease"], f"wave 1 ran after Stop: {started}"
    assert out.cancelled, "the batch did not report the Stop back to the hub"
    assert out.ok, "wave 0's real report still counts"
    assert "Task 0 —" in out.report
    assert "Task 1" not in out.report, "a task that never ran got a report line"
    assert len(d.pipeline) == 1, "a roster slot was claimed for a wave that never ran"
    assert d.pipeline[0]["status"] == "done", "wave 0's slot is still pulsing"


# --------------------------------------------------------------------------- #
# the sequential pass, on its own (`_ToolPass`)
# --------------------------------------------------------------------------- #
#
# The other half of the same 2026-07-30 split. SPEC §3.2's invariants live in
# this pass — duplicate suppression, "only SUCCESSFUL calls are memoised", the
# hub guard, the LEDGER baton, the image handoff, drain-on-Stop — and until the
# extraction every one of them could be reached only by driving a compiled graph
# with a scripted model. These drive the pass directly.


def _pass(
    *,
    agent_id: str = "files.read",
    seen: set[str] | None = None,
    events: list[Event] | None = None,
    cancel: CancelToken | None = None,
    mcp: FakeMCP | None = None,
    tools: list[ToolSpec] | None = None,
    on_event: Callable[[Event], None] | None = None,
    pipeline: list[dict[str, Any]] | None = None,
) -> _ToolPass:
    """A `_ToolPass` built the way `execute_tools` builds one — through
    `for_round`, so the accumulator unpacking is under test too.

    ``on_event`` is the deterministic seam for "Stop was pressed at THIS point":
    the event stream is the only thing the pass emits mid-loop, so hooking it is
    how a test lands the token flip between two specific calls.

    ``pipeline`` seeds a roster from EARLIER rounds — the only way to say "this
    is not round 1", which is what the active-marker arithmetic reads."""
    sink = events if events is not None else []

    async def emit(event: Event) -> None:
        sink.append(event)
        if on_event is not None:
            on_event(event)

    deps = Deps(
        chat=FakeChatModel([]),  # type: ignore[arg-type]
        emit=emit,
        cancel=cancel if cancel is not None else CancelToken(),
        mcp=mcp if mcp is not None else FakeMCP(),  # type: ignore[arg-type]
    )
    served = [s.to_ollama() for s in (tools if tools is not None else specs())]
    state: dict[str, Any] = {
        "question": "what does the lease say about rent",
        "web_enabled": True,
        "write": True,
        "run_max_rounds": AGENT_ROUND_BACKSTOP,
        "agent_id": agent_id,
        "served_specs": served,
        "messages": [{"role": "system", "content": "You are the room assistant."}],
        "seen": set(seen or set()),
        "round": 3,
        "pipeline": list(pipeline or []),
    }
    return _ToolPass.for_round(
        deps,
        state,  # type: ignore[arg-type]
        {"configurable": {"deps": deps}},
        state["messages"],
    )


def _tool_texts(p: _ToolPass) -> list[str]:
    return [str(m.get("content")) for m in p.messages if m.get("role") == "tool"]


async def test_the_pass_answers_a_duplicate_from_the_memo_without_re_running_it() -> None:
    """CHG-3 / SPEC §3.2: an exact repeat gets the note, not a second execution
    — and a round of ONLY repeats COUNTS a stall rather than ending the turn."""
    repeat = call("open_file", name="lease.pdf")
    mcp = FakeMCP()
    p = _pass(seen={repeat.key()}, mcp=mcp)

    await p.run([repeat])

    assert mcp.calls == [], "the duplicate was re-executed"
    assert _tool_texts(p) == [duplicate_call_note("open_file")]
    assert p.all_dup, "the round was nothing but a repeat"
    updates = p.to_updates([])
    assert updates["stalls"] == 1
    assert updates["force_synthesis"] is False, "one repeat must not end the turn"


async def test_the_stall_count_reaching_its_budget_forces_synthesis() -> None:
    repeat = call("open_file", name="lease.pdf")
    p = _pass(seen={repeat.key()}, mcp=FakeMCP())
    p.state["stalls"] = NO_PROGRESS_ROUNDS - 1  # one short of the budget

    await p.run([repeat])

    updates = p.to_updates([])
    assert updates["stalls"] == NO_PROGRESS_ROUNDS
    assert updates["force_synthesis"] is True


async def test_a_refused_request_tools_is_remembered_like_a_refused_delegation() -> None:
    """A refusal that can NEVER succeed has to count as a duplicate the second
    time, or the termination policy never fires.

    `GROUPS` is a constant, an agent's own group does not change, and
    `served_specs` is derived once in `prepare` — so all three ways
    `_unlock_group` can refuse are permanent for the turn. Recorded on success
    only, the identical repeat re-ran the refusal, cleared `all_dup`, and a model
    that kept asking burned rounds to the turn-wide backstop instead of tripping
    the no-progress gate. The delegation side already memoises its
    no-such-specialist refusal for exactly this reason."""
    from arcelle_sidecar.prompts import duplicate_call_note

    # `jobs.run` owns the `jobs` group, so asking for it is refused — and the
    # enum does not even offer it, so the model had to invent the value.
    own = call("request_tools", group="jobs")
    p = _pass(agent_id="jobs.run")
    await p.run([own])
    refusal = _tool_texts(p)
    assert refusal and "belong to another specialist" in refusal[0]
    assert not p.all_dup, "the FIRST ask did tell the model something new"
    assert own.key() in p.seen, "a refusal that cannot change was not remembered"

    # The identical ask again: answered from the memo, and the round is a stall.
    again = _pass(agent_id="jobs.run", seen=p.seen)
    await again.run([call("request_tools", group="jobs")])
    assert _tool_texts(again) == [duplicate_call_note("request_tools")]
    assert again.all_dup
    assert again.to_updates([])["stalls"] == 1


async def test_a_productive_round_resets_the_stall_count() -> None:
    """Consecutive is the operative word — progress wipes the slate."""
    p = _pass(seen=set(), mcp=FakeMCP())
    p.state["stalls"] = NO_PROGRESS_ROUNDS - 1

    await p.run([call("open_file", name="lease.pdf")])  # a NEW call

    assert not p.all_dup
    updates = p.to_updates([])
    assert updates["stalls"] == 0
    assert updates["force_synthesis"] is False


async def test_the_pass_only_memoises_a_call_that_actually_worked() -> None:
    """SPEC §3.2's retry rule: a failed call reports `Tool error:` and stays OUT
    of `seen`, so a later round may try it again. `attempted` records it either
    way — that is the ground truth a `verify` shape reads."""
    mcp = FakeMCP(results={"open_file": ToolResult(text="no such file", is_error=True)})
    bad = call("open_file", name="ghost.pdf")
    p = _pass(mcp=mcp)

    await p.run([bad])

    assert _tool_texts(p) == ["Tool error: no such file"]
    assert bad.key() not in p.seen, "a failed call was memoised and can never retry"
    assert p.attempted == {"open_file"}
    updates = p.to_updates([])
    # set[tuple] serialises to None through LangGraph's JsonPlusSerializer,
    # silently, so a checkpointed resume would come back with no memo at all.
    assert all(isinstance(k, str) for k in updates["seen"])
    assert all(isinstance(k, str) for k in updates["attempted"])


async def test_a_successful_write_lands_in_BOTH_batons() -> None:
    """A LEDGER_TOOLS success is recorded twice on purpose: `referents` is what
    later specialists are told about, `produced` is what `graphs.verify_claims`
    reads. Seeding only one of them disables the write-claim gate."""
    p = _pass()

    await p.run([call("create_file", name="notes.md")])

    assert p.referents == ["create_file: notes.md"]
    assert p.produced == ["create_file: notes.md"]
    updates = p.to_updates([])
    assert updates["referents"] == ["create_file: notes.md"]
    assert updates["produced"] == ["create_file: notes.md"]


async def test_a_failed_write_records_no_referent() -> None:
    """The other half of the gate: recorded on SUCCESS ONLY, or every claim
    looks supported and `verify_claims` can never fire."""
    mcp = FakeMCP(results={"create_file": ToolResult(text="disk full", is_error=True)})
    p = _pass(mcp=mcp)

    await p.run([call("create_file", name="notes.md")])

    assert p.referents == [] and p.produced == []


async def test_the_hub_guard_corrects_the_main_agent_instead_of_acting() -> None:
    """Hub v3: the MAIN agent never touches a room tool. Even if the model
    drifts and emits one it is rejected before the bridge, with the note that
    steers it back to delegation."""
    mcp = FakeMCP()
    p = _pass(agent_id="chat.answer", mcp=mcp)

    await p.run([call("open_file", name="lease.pdf")])

    assert mcp.calls == [], "the Main agent reached the bridge"
    assert len(_tool_texts(p)) == 1
    assert "you are the Main" in _tool_texts(p)[0]
    assert "ask_*_agent" in _tool_texts(p)[0]
    assert p.seen == set(), "a rejected call must not be memoised"


async def test_a_worker_that_invents_a_delegation_is_refused_not_obeyed() -> None:
    """The mirror of the hub guard, and it was missing.

    `_arm_for` dispatches on the tool NAME alone, so a worker's invented
    `ask_file_agent` reached `_delegation`, found no launched task (only the hub
    fans out) and ran the child INLINE — off `worker_base_messages`, which is
    seeded EMPTY for a worker. A whole nested assistant with no system prompt,
    no room context and no rules, whose answer rejoined the thread as a genuine
    specialist report; and nothing bounded the nesting.
    """
    p = _pass(agent_id="files.read")

    await p.run([call("ask_file_agent", instruction="read the lease")])

    assert p.delegator.pipeline == [], "a phantom child claimed a roster slot"
    texts = _tool_texts(p)
    assert len(texts) == 1
    assert "You have no tool named 'ask_file_agent'" in texts[0]
    assert "cannot hand work to another agent" in texts[0]
    assert p.seen == set(), "a rejected call must not be memoised"


async def test_a_worker_asking_for_the_plan_tool_is_told_it_has_none() -> None:
    """It used to get `EMPTY_PLAN_NOTE` — a lecture on how to format a task list
    for a tool it does not have. The Main agent gets the plain truth in the
    mirror-image case; so does a worker now."""
    p = _pass(agent_id="files.read")

    await p.run([call(BATCH_TOOL_NAME, tasks=[{"agent": "web", "instruction": "x"}])])

    texts = _tool_texts(p)
    assert texts and EMPTY_PLAN_NOTE not in texts[0], texts
    assert f"You have no tool named '{BATCH_TOOL_NAME}'" in texts[0]


async def test_captured_pixels_come_back_as_a_user_turn_right_after_the_result() -> None:
    """ADD-25: Ollama reads images from USER turns, not tool turns — attach them
    to the tool message and the model is blind. `pending_images` drains when the
    handoff lands, so the next round cannot re-attach them."""
    mcp = FakeMCP(
        results={"ui_snapshot": ToolResult(text="captured", images=["b64-pixels"])}
    )
    p = _pass(mcp=mcp)

    await p.run([call("ui_snapshot")])

    assert [m["role"] for m in p.messages[-2:]] == ["tool", "user"]
    assert p.messages[-1]["content"] == IMAGE_HANDOFF
    assert p.messages[-1].get("images") == ["b64-pixels"]
    assert p.pending_images == [], "the pixels would be re-attached next round"
    assert p.to_updates([])["pending_images"] == []


async def test_room_tools_run_one_at_a_time_in_the_models_call_order() -> None:
    """Strictly sequential, and the tool messages land in the SAME order the
    model emitted the calls — a provider that pairs them positionally sees a
    scrambled transcript otherwise."""
    order: list[str] = []
    mcp = FakeMCP(on_call=lambda name, args: order.append(name))
    p = _pass(mcp=mcp)

    await p.run(
        [call("search_room", query="rent"), call("open_file", name="lease.pdf"), call("list_room_files")]
    )

    assert order == ["search_room", "open_file", "list_room_files"]
    assert [m.get("tool_name") for m in p.messages if m.get("role") == "tool"] == [
        "search_room",
        "open_file",
        "list_room_files",
    ]
    assert not p.all_dup


async def test_list_skills_is_scoped_to_the_calling_agent_by_the_pass() -> None:
    """The Rust bridge is built per RUN, not per worker, so it cannot know which
    specialist is asking — the pass injects the id before dispatch."""
    mcp = FakeMCP()
    p = _pass(agent_id="skills.use", mcp=mcp)

    await p.run([call("list_skills")])

    assert mcp.calls == [("list_skills", {"agent": "skills.use"})]


async def test_a_mid_round_unlock_is_the_only_thing_that_returns_a_new_catalog() -> None:
    """`tools` is the one conditional key in the update: request_tools rebuilt
    the offered catalog, so the next round must be offered the new one."""
    plain = _pass()
    await plain.run([call("open_file", name="lease.pdf")])
    assert "tools" not in plain.to_updates([])

    unlocking = _pass()
    await unlocking.run([call("request_tools", group="jobs")])
    updates = unlocking.to_updates([])
    assert "jobs" in updates["unlocked_groups"]
    assert "start_file_pass" in {t["function"]["name"] for t in updates["tools"]}


async def test_stop_between_tool_calls_drains_the_children_it_launched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC §3.2: Stop is checked BETWEEN calls, and cancelling DRAINS the
    in-flight children — an orphaned sub-loop outlives the turn and emits into a
    dead run. The second delegation must never produce a tool message."""
    token = CancelToken()

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        if "lease" in instruction:
            return WorkerOutcome("Report from the File agent:\nrent is 1200", True, False, [])
        await asyncio.sleep(3600)  # only cancellation gets us out of here
        raise AssertionError("unreachable")

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    def stop_once_the_first_call_is_recorded(event: Event) -> None:
        if event["t"] == "step_status":
            token.cancel()

    first = ToolCall(name="ask_file_agent", arguments={"instruction": "read the lease"}, id="c1")
    second = ToolCall(name="ask_web_agent", arguments={"instruction": "check the market"}, id="c2")
    p = _pass(
        agent_id="chat.answer", cancel=token, on_event=stop_once_the_first_call_is_recorded
    )

    await p.fan_out([first, second])
    assert len(p.delegator.tasks) == 2, "both delegations should have been launched"
    await p.run([first, second])

    assert p.cancelled, "the pass did not notice Stop"
    assert len(_tool_texts(p)) == 1, "the stopped call still produced a tool message"
    assert "rent is 1200" in _tool_texts(p)[0]
    orphan = p.delegator.tasks["c2"]
    assert orphan.done() and orphan.cancelled(), "the child outlived the turn"
    assert p.to_updates([])["cancelled"] is True


async def test_stop_inside_a_child_stops_the_pass_and_drains_its_siblings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The OTHER way Stop reaches the pass: not the between-calls check, but a
    child reporting `cancelled` back (Stop landed while it was working). Its
    report still lands — it did real work — and then the pass stops, so the
    calls behind it never run and their children are drained.

    Pinned because that stop is now a `return False` from the arm rather than a
    `break` inside the loop (the 2026-07-30 `_ToolPass` split): dropping the
    return value left the whole suite green, which is exactly the lost-break
    regression this test exists to catch."""

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        if "lease" in instruction:
            # ok AND cancelled: the child got something before Stop landed.
            return WorkerOutcome("Report from the File agent:\nrent is 1200", True, True, [])
        await asyncio.sleep(3600)  # only cancellation gets us out of here
        raise AssertionError("unreachable")

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    first = ToolCall(name="ask_file_agent", arguments={"instruction": "read the lease"}, id="c1")
    second = ToolCall(name="ask_web_agent", arguments={"instruction": "check the market"}, id="c2")
    p = _pass(agent_id="chat.answer")

    await p.fan_out([first, second])
    # wait_for, not a bare await: if the Stop stopped stopping the pass it would
    # walk on to the sleeping sibling and HANG the suite instead of failing it.
    await asyncio.wait_for(p.run([first, second]), timeout=5)

    assert p.cancelled, "a cancelled child did not stop the pass"
    assert len(_tool_texts(p)) == 1, "the pass kept walking after the Stop"
    assert "rent is 1200" in _tool_texts(p)[0], "the child's real work was thrown away"
    orphan = p.delegator.tasks["c2"]
    assert orphan.done() and orphan.cancelled(), "the sibling outlived the turn"
    assert p.to_updates([])["cancelled"] is True


async def test_stop_inside_a_batch_stops_the_pass_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same rule on the `ask_agents` arm, which has its own copy of it: a plan
    that comes back cancelled reports what it got and then stops the pass, so
    the delegation queued behind it is drained instead of run."""

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        if "lease" in instruction:
            return WorkerOutcome("FOUND: rent is 1200", True, True, [])
        await asyncio.sleep(3600)  # only cancellation gets us out of here
        raise AssertionError("unreachable")

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    plan = ToolCall(
        name=BATCH_TOOL_NAME,
        arguments={"tasks": [{"agent": "file", "instruction": "read the lease"}]},
        id="c1",
    )
    after = ToolCall(name="ask_web_agent", arguments={"instruction": "check the market"}, id="c2")
    p = _pass(agent_id="chat.answer")

    await p.fan_out([plan, after])
    await asyncio.wait_for(p.run([plan, after]), timeout=5)  # see the test above

    assert p.cancelled, "a cancelled batch did not stop the pass"
    assert len(_tool_texts(p)) == 1, "the pass kept walking after the Stop"
    assert "rent is 1200" in _tool_texts(p)[0], "the batch's real report was thrown away"
    orphan = p.delegator.tasks["c2"]
    assert orphan.done() and orphan.cancelled(), "the sibling outlived the turn"


async def test_an_ask_agents_call_does_not_walk_the_active_marker_off_the_roster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fan-out's active marker is read OFF THE ROSTER, never counted from the
    in-flight tasks. An `ask_agents` call parks a whole plan without claiming a
    slot of its own (its tasks claim theirs later, wave by wave), so tasks
    outnumber slots and `len(pipeline) - len(tasks) + 1` walked BACKWARDS off the
    front: with an empty prior roster one such call silently lit the Main agent
    and two raised `IndexError: list index out of range` out of `execute_tools`,
    killing the turn (found 2026-07-30, live in 0.12.0)."""

    async def _stub(
        state: Any,
        config: Any,
        worker_id: str,
        instruction: str,
        referents: list[str],
        node_key: str,
        upstream: tuple[str, ...] = (),
    ) -> WorkerOutcome:
        await asyncio.sleep(3600)  # nothing finishes; the marker is under test
        raise AssertionError("unreachable")

    monkeypatch.setattr("arcelle_sidecar.graph._run_worker", _stub)

    def plan_call(cid: str) -> ToolCall:
        return ToolCall(
            name=BATCH_TOOL_NAME,
            arguments={"tasks": [{"agent": "file", "instruction": f"read {cid}"}]},
            id=cid,
        )

    events: list[Event] = []
    only_plans = _pass(agent_id="chat.answer", events=events)
    await only_plans.fan_out([plan_call("c1"), plan_call("c2")])
    marker = events[-1]["v"]
    assert 1 <= marker["step"] <= marker["total"], f"off the roster: {marker}"
    # No slot is claimed yet, so the only slot there IS is the Main agent's.
    assert marker["step"] == marker["total"]
    await only_plans.delegator.drain()

    # The in-range-but-wrong half: a round that mixes the two kinds must point at
    # the child that DID claim a slot, not count the plan against it.
    mixed_events: list[Event] = []
    mixed = _pass(agent_id="chat.answer", events=mixed_events)
    child = ToolCall(name="ask_file_agent", arguments={"instruction": "read the lease"}, id="c3")
    await mixed.fan_out([plan_call("c4"), child])
    assert len(mixed.delegator.pipeline) == 1, "only the ask_*_agent child claims a slot here"
    marker = mixed_events[-1]["v"]
    assert marker["step"] == 1
    assert marker["id"] == mixed.delegator.pipeline[0]["agent"]
    await mixed.delegator.drain()

    # And it must never land on a slot that already FINISHED — a done chip that
    # pulses reads as work still in flight. With an earlier round in the roster
    # and only plans in this one, nothing running is the honest answer, which is
    # `_active_step`'s documented fallback: the Main agent's own slot.
    prior = [
        {
            "agent": "files.read",
            "instruction": "read the lease",
            "status": "done",
            "batch": 0,
            "key": "files.read#0",
        }
    ]
    later_events: list[Event] = []
    later = _pass(agent_id="chat.answer", events=later_events, pipeline=prior)
    await later.fan_out([plan_call("c5")])
    marker = later_events[-1]["v"]
    assert marker["step"] == marker["total"] == 2, f"lit a finished child: {marker}"
    await later.delegator.drain()
