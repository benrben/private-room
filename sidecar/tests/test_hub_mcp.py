"""The hub's own MCP endpoint: delegation as a REAL tool for a harness engine.

Live QA 2026-07-25 (reproduced twice outside the app): handed ask_jobs_agent in
prose, Claude Code answered "the automation tool isn't responding" without ever
emitting an envelope or running a worker. `parse_tool_calls` returned [], the
room bridge saw zero calls, and the CLI's own report said num_turns=4 with no
permission denials — it looped internally and narrated a failure that never
happened. A harness CALLS tools; it does not narrate them.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from arcelle_sidecar import external_llm
from arcelle_sidecar.hub_mcp import DELEGATION_ACK, HubToolServer, qualified, unqualify

ASK_JOBS = {
    "type": "function",
    "function": {
        "name": "ask_jobs_agent",
        "description": "Ask the Jobs & Workflows agent for automation.",
        "parameters": {
            "type": "object",
            "properties": {"instruction": {"type": "string"}},
            "required": ["instruction"],
        },
    },
}
OPEN_FILE = {
    "type": "function",
    "function": {
        "name": "open_file",
        "description": "Open a file.",
        "parameters": {"type": "object", "properties": {}},
    },
}


async def _noop(_delta: str) -> None:
    """`stream` awaits on_delta for branch (B); these tests ignore the text."""


def rpc(server: HubToolServer, method: str, params: Any = None, *, token: str | None = None):
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return httpx.post(
        server.url,
        content=json.dumps(body),
        headers={"Authorization": f"Bearer {token if token is not None else server.token}"},
        timeout=5.0,
    )


def test_it_serves_only_the_tools_this_round_offered() -> None:
    with HubToolServer([ASK_JOBS], "tok") as server:
        tools = rpc(server, "tools/list").json()["result"]["tools"]
        assert [t["name"] for t in tools] == ["ask_jobs_agent"]
        assert tools[0]["inputSchema"]["required"] == ["instruction"]


def test_a_call_is_captured_and_acknowledged_not_executed() -> None:
    """The endpoint never runs the specialist — graph.py does, exactly as it
    does for a local model. Capturing is what keeps re-entrancy out of the
    design: nothing here reaches back into a graph that is mid-await."""
    with HubToolServer([ASK_JOBS], "tok") as server:
        out = rpc(
            server,
            "tools/call",
            {"name": qualified("ask_jobs_agent"), "arguments": {"instruction": "daily digest"}},
        ).json()["result"]
        assert out["isError"] is False
        assert out["content"][0]["text"] == DELEGATION_ACK
        assert server.calls == [("ask_jobs_agent", {"instruction": "daily digest"})]


def test_an_unoffered_specialist_is_refused_not_invented() -> None:
    with HubToolServer([ASK_JOBS], "tok") as server:
        out = rpc(
            server, "tools/call", {"name": "ask_connector_agent", "arguments": {}}
        ).json()["result"]
        assert out["isError"] is True
        assert server.calls == []


def test_the_endpoint_is_token_guarded() -> None:
    with HubToolServer([ASK_JOBS], "tok") as server:
        assert rpc(server, "tools/list", token="wrong").status_code == 401
        assert rpc(server, "tools/list", token="to").status_code == 401  # prefix
        assert httpx.get(server.url, timeout=5.0).status_code == 405
        assert server.calls == []


def test_qualification_round_trips() -> None:
    assert qualified("ask_jobs_agent") == "mcp__hub__ask_jobs_agent"
    assert unqualify("mcp__hub__ask_jobs_agent") == "ask_jobs_agent"
    assert unqualify("ask_jobs_agent") == "ask_jobs_agent"  # idempotent


# --------------------------------------------------------------------------- #
# the seam: which channel each tool rides
# --------------------------------------------------------------------------- #


def test_delegation_rides_the_hub_and_room_tools_ride_the_bridge() -> None:
    cmd = external_llm.build_agent_cmdline(
        "claude-cli",
        "sonnet",
        None,
        system_path="/s",
        mcp_path="/m",
        allowed=["open_file"],
        hub_allowed=["ask_jobs_agent"],
    )
    assert "'mcp__room__open_file'" in cmd
    assert "'mcp__hub__ask_jobs_agent'" in cmd
    # A main-agent round holds NO room tools; the hub alone must still turn the
    # tool machinery on, or delegation falls back to prose that gets narrated.
    hub_only = external_llm.build_agent_cmdline(
        "claude-cli", "sonnet", None, mcp_path="/m", hub_allowed=["ask_jobs_agent"]
    )
    assert "'mcp__hub__ask_jobs_agent'" in hub_only
    assert external_llm.CLAUDE_NO_TOOLS_FLAGS not in hub_only


def test_the_room_only_config_stays_byte_compatible_with_rust() -> None:
    """`Bridge::mcp_config_json` is the other half of this contract."""
    assert external_llm.mcp_config_json("http://x/mcp", "tok") == json.dumps(
        {
            "mcpServers": {
                "room": {
                    "type": "http",
                    "url": "http://x/mcp",
                    "headers": {"Authorization": "Bearer tok"},
                }
            }
        }
    )
    both = json.loads(external_llm.mcp_config_json("http://x/mcp", "tok", hub=("http://h/mcp", "h")))
    assert set(both["mcpServers"]) == {"room", "hub"}
    hub_only = json.loads(external_llm.mcp_config_json("", "", hub=("http://h/mcp", "h")))
    assert set(hub_only["mcpServers"]) == {"hub"}


@pytest.mark.asyncio
async def test_a_native_delegation_becomes_an_ordinary_tool_call(monkeypatch) -> None:
    """End to end through the seam: the CLI calls the hub endpoint, and
    `stream` returns a ToolCall indistinguishable from a text-protocol one —
    so graph.py runs the worker without knowing which channel was used."""
    model = external_llm.ExternalChatModel("claude-cli::sonnet")
    captured: dict[str, Any] = {}

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None):
        captured["system"] = system
        captured["hub_tools"] = list(hub_tools or [])
        # What the harness does: call the tool, then narrate around it.
        rpc(hub, "tools/call", {"name": qualified("ask_jobs_agent"),
                                "arguments": {"instruction": "summarize new files daily"}})
        return json.dumps({"result": "I've asked the Jobs agent to set that up."})

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)

    text, calls, _usage = await model.stream([{"role": "user", "content": "hi"}], [ASK_JOBS], _noop)

    assert [c.name for c in calls] == ["ask_jobs_agent"]
    assert calls[0].arguments == {"instruction": "summarize new files daily"}
    # Branch (A): the narration around a call is machinery, never transcript.
    assert text == ""
    assert captured["hub_tools"] == ["ask_jobs_agent"]
    # …and the delegation is NOT also described in the text protocol, which is
    # the prose that made the harness narrate instead of act.
    assert "ask_jobs_agent" not in captured["system"]


@pytest.mark.asyncio
async def test_a_native_round_still_disowns_the_harnesss_own_world(monkeypatch) -> None:
    """With every tool on a real endpoint there is no envelope to teach, and
    the paragraph that disowns the CLI's own tools used to ride the text
    protocol — so dropping the protocol dropped it too. Live QA 2026-07-25:
    "what skills do I have in this room?" made Claude Code list ITS OWN
    installed skills (claude-api, dataviz, loop, schedule…)."""
    model = external_llm.ExternalChatModel("claude-cli::sonnet")
    seen: dict[str, Any] = {}

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None):
        seen["system"] = system
        return json.dumps({"result": "ok"})

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)
    await model.stream(
        [{"role": "system", "content": "You are the room assistant."},
         {"role": "user", "content": "what skills do I have?"}],
        [ASK_JOBS],
        _noop,
    )

    system = seen["system"]
    assert "You are the room assistant." in system  # the room's own prompt survives
    assert "NOT connected to this task" in system
    # The words the harness's own runtime also owns must be claimed explicitly.
    for word in ("skills", "workflows", "scripts", "memories", "connectors"):
        assert word in system, f"the note must claim the room's {word}"


@pytest.mark.asyncio
async def test_room_tools_without_a_bridge_still_ride_the_text_protocol(monkeypatch) -> None:
    """The hub endpoint serves DELEGATION only. A worker round whose room
    tools have no bridge url must keep them in the text catalog rather than
    have them swept into the hub."""
    model = external_llm.ExternalChatModel("claude-cli::sonnet")
    seen: dict[str, Any] = {}

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None):
        seen["system"] = system
        seen["hub"] = hub
        seen["hub_tools"] = list(hub_tools or [])
        return json.dumps({"result": "There are three files."})

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)
    await model.stream([{"role": "user", "content": "hi"}], [OPEN_FILE], _noop)

    assert seen["hub_tools"] == []
    assert seen["hub"] is None
    assert "open_file" in seen["system"]
