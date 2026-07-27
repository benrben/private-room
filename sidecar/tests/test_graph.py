"""The round loop (SPEC §3.2). Every invariant here is product behaviour."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from conftest import (
    BUILTIN_TOOL_NAMES,
    FakeChatModel,
    FakeMCP,
    Round,
    call,
    drive,
    drive_worker,
    make_request,
    specs,
)

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.mcp_client import ToolSpec

from arcelle_sidecar.config import AGENT_ROUND_BACKSTOP
from arcelle_sidecar.graph import (
    CancelToken,
    Deps,
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
    assert "The Main agent delegated this task" in worker_seen[-1]["content"]
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
    assert "The Main agent delegated this task" in conn_seen[-1]["content"]
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
            usage = RoundUsage(input_tokens=None, output_tokens=None, max_context=8192, is_real=False)
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


async def test_an_all_duplicate_round_forces_a_tool_less_synthesis() -> None:
    dup = [call("search_room", query="rent")]
    chat = FakeChatModel(
        [
            Round(content="r0", calls=list(dup)),
            Round(content="r1", calls=list(dup)),  # all duplicates -> stuck
            Round(content="the answer"),  # must be tool-less
        ]
    )
    out = await drive_worker(make_request(web_enabled=True, max_rounds=20, routing=WRITE_ON), chat)
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


# --------------------------------------------------------------------------- #
# final text
# --------------------------------------------------------------------------- #


async def test_blank_final_becomes_done() -> None:
    chat = FakeChatModel([Round(content=""), Round(content="")])
    out = await drive(make_request(), chat)
    assert out.final == "Done."
    assert out.of("final")[0]["v"] == "Done."


async def test_whitespace_only_final_becomes_done() -> None:
    chat = FakeChatModel([Round(content="   \n "), Round(content="   \n ")])
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
        usage = RoundUsage(input_tokens=None, output_tokens=None, max_context=8192, is_real=False)

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
        if "The task(s) you depend on have already run" in (m.get("content") or "")
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
                input_tokens=None, output_tokens=None, max_context=8192, is_real=False
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
                    input_tokens=None, output_tokens=None, max_context=8192, is_real=False
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
    """The bound is a LOCAL concession. A cloud engine holds no resident model,
    so bounding it would throw away the whole point of the parallel hub."""
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
        worker_parallel=None,  # cloud
    )
    from arcelle_sidecar.graph import run_agent

    await run_agent(make_request("compare my rent", web_enabled=True), deps)
    assert peak["max"] > 1, "the cloud fan-out was serialized"


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
                    input_tokens=None, output_tokens=None, max_context=8192, is_real=False
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
