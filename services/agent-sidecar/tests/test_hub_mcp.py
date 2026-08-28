"""The hub's own MCP endpoint: delegation as a REAL tool for a harness engine.

Live QA 2026-07-25 (reproduced twice outside the app): handed ask_jobs_agent in
prose, Claude Code answered "the automation tool isn't responding" without ever
emitting an envelope or running a worker. `parse_tool_calls` returned [], the
room bridge saw zero calls, and the CLI's own report said num_turns=4 with no
permission denials — it looped internally and narrated a failure that never
happened. A harness CALLS tools; it does not narrate them.
"""

from __future__ import annotations

import http.client
import io
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from arcelle_sidecar import external_llm, hub_mcp, mcp_client
from arcelle_sidecar.agents import main_prompt
from arcelle_sidecar.hub_mcp import (
    DELEGATION_ACK,
    HubToolServer,
    dispatch,
    qualified,
    unqualify,
)

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


def test_the_ack_stops_the_answer_but_not_a_second_delegation() -> None:
    """`_Delegator.launch` fans out every delegation in a round before awaiting
    any, so a Claude room can hand three specialists their work in ONE turn. The
    ack used to say "do not call another tool", which threw that away: three
    round trips at three times the cost for a three-part request. What it must
    still stop is answering, because no report has come back yet."""
    assert "do not call another tool" not in DELEGATION_ACK
    assert "in this same turn" in DELEGATION_ACK
    assert "do not write the answer yet" in DELEGATION_ACK


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


def test_the_transport_carries_a_bodyless_reply_and_an_error_reply() -> None:
    """`dispatch` may answer with no body at all (a notification) or with an
    error instead of a result; the socket half has to write both. Live server
    on purpose — this is the wiring the socket-free tests below cannot see."""
    with HubToolServer([ASK_JOBS], "tok") as server:
        notice = httpx.post(
            server.url,
            content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            headers={"Authorization": "Bearer tok"},
            timeout=5.0,
        )
        assert notice.status_code == 202
        assert notice.content == b""

        unknown = rpc(server, "prompts/list")
        assert unknown.status_code == 200
        assert unknown.json()["error"]["code"] == -32601
        # A body that is valid JSON but not a JSON-RPC object is a bad request,
        # not a handler-thread traceback.
        bad = httpx.post(
            server.url,
            content="[1, 2]",
            headers={"Authorization": "Bearer tok"},
            timeout=5.0,
        )
        assert bad.status_code == 400
        assert server.calls == []


def test_the_transport_bounds_the_body_and_rejects_a_malformed_one() -> None:
    """Bounds and parse are the reading half of the handler; both answer before
    `dispatch` ever sees an envelope. The over-long case is decided from the
    HEADER, never by reading the bytes — a client that promises a megabyte and
    then stops talking must not pin the handler thread for the whole round."""
    with HubToolServer([ASK_JOBS], "tok") as server:
        conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5.0)
        conn.putrequest("POST", "/mcp", skip_host=True, skip_accept_encoding=True)
        conn.putheader("Authorization", "Bearer tok")
        conn.putheader("Content-Length", str(hub_mcp._MAX_BODY + 1))
        conn.endheaders()
        conn.send(b"{}")  # far less than promised: the 413 must not wait for it
        over_long = conn.getresponse()
        assert over_long.status == 413
        # The body was refused unread, so it is still queued on the socket: a
        # kept-alive connection would parse those bytes as the next request
        # line and answer a run of 400s until it died. The refusal ends it.
        assert over_long.getheader("Connection") == "close"
        assert over_long.will_close is True
        over_long.read()
        conn.close()

        malformed = httpx.post(
            server.url,
            content=b'{"jsonrpc": "2.0", "id": 1, "meth',
            headers={"Authorization": "Bearer tok"},
            timeout=5.0,
        )
        assert malformed.status_code == 400
        assert server.calls == []


def test_a_4xx_is_the_last_word_on_that_request(capfd) -> None:
    """One request, one reply — over a real kept-alive connection, where a second
    reply would be collected by the NEXT request as its own.

    `_read_body` answers the 4xx and returns None; `do_POST` returns on None. A
    client that reads one reply and hangs up cannot see either half fail, which
    is how this went unpinned: answering 400 with `{}` instead of `None` sends
    the 400 and then a 202, and dropping `do_POST`'s None guard sends the 400 and
    then raises on `None.get` in the handler thread — printing the socketserver
    traceback that the 400 was added to prevent.
    """
    with HubToolServer([ASK_JOBS], "tok") as server:
        alive = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5.0)
        alive.request(
            "POST",
            "/mcp",
            body=b'{"jsonrpc": "2.0", "id": 1, "meth',
            headers={"Authorization": "Bearer tok"},
        )
        malformed = alive.getresponse()
        assert malformed.status == 400
        malformed.read()

        alive.request(
            "POST",
            "/mcp",
            body=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            headers={"Authorization": "Bearer tok"},
        )
        after = alive.getresponse()
        answered = after.read()
        alive.close()
        assert after.status == 200, "the 400 was answered twice; this is reply two"
        assert json.loads(answered) == {"jsonrpc": "2.0", "id": 2, "result": {}}
        assert server.calls == []
        # Nothing on stderr: socketserver prints a full traceback per raising
        # request, the noise that buries the failures worth reading.
        assert capfd.readouterr().err == ""


def test_each_round_gets_its_own_token_and_its_own_catalog() -> None:
    """Two live endpoints at once. The handler class is built per server, so one
    round's token cannot read another's catalog and captures never cross."""
    with HubToolServer([ASK_JOBS], "tok-a") as a, HubToolServer([OPEN_FILE], "tok-b") as b:
        assert a.port != b.port
        assert [t["name"] for t in rpc(a, "tools/list").json()["result"]["tools"]] == [
            "ask_jobs_agent"
        ]
        assert [t["name"] for t in rpc(b, "tools/list").json()["result"]["tools"]] == [
            "open_file"
        ]
        assert rpc(a, "tools/list", token="tok-b").status_code == 401
        rpc(a, "tools/call", {"name": "ask_jobs_agent", "arguments": {}})
        assert a.calls == [("ask_jobs_agent", {})]
        assert b.calls == []


def test_qualification_round_trips() -> None:
    assert qualified("ask_jobs_agent") == "mcp__hub__ask_jobs_agent"
    assert unqualify("mcp__hub__ask_jobs_agent") == "ask_jobs_agent"
    assert unqualify("ask_jobs_agent") == "ask_jobs_agent"  # idempotent


# --------------------------------------------------------------------------- #
# the protocol itself, without a socket
#
# `dispatch` is the whole JSON-RPC contract, extracted from the nested handler
# precisely so these can be pinned directly: the tests above need a live server
# and a client, which is why the branch that answers an unknown method went
# years unexercised.
# --------------------------------------------------------------------------- #


def _listed(*tools: dict[str, Any]) -> list[dict[str, Any]]:
    """The `listed` argument `dispatch` takes: offered tools in MCP shape.

    Built with the module's own converter, not a hand-copy, so a change to the
    catalog shape cannot leave these tests asserting a shape nobody serves.
    """
    return [hub_mcp._to_mcp_tool(t) for t in tools]


def _call(name: str, arguments: Any) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


def test_dispatch_initialize_declares_tools_and_nothing_else() -> None:
    status, reply = dispatch(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, _listed(ASK_JOBS), []
    )
    assert status == 200
    assert reply is not None
    assert reply["id"] == 1
    assert reply["result"]["capabilities"] == {"tools": {}}
    assert reply["result"]["protocolVersion"] == "2024-11-05"
    assert reply["result"]["serverInfo"]["name"] == "arcelle-hub"


def test_both_halves_of_the_sidecar_announce_one_protocol_revision() -> None:
    # The hub endpoint and the room-bridge client are the two MCP speakers in
    # this process. Two literals could drift, and the CLI on the other side
    # would be told two different revisions by the same app.
    status, reply = dispatch(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, _listed(ASK_JOBS), []
    )
    assert status == 200 and reply is not None
    assert reply["result"]["protocolVersion"] == mcp_client.PROTOCOL_VERSION


def test_dispatch_lists_exactly_the_offered_tools() -> None:
    listed = _listed(ASK_JOBS)
    status, reply = dispatch({"id": 2, "method": "tools/list"}, listed, [])
    assert (status, reply) == (
        200,
        {"jsonrpc": "2.0", "id": 2, "result": {"tools": listed}},
    )
    assert [t["name"] for t in listed] == ["ask_jobs_agent"]
    assert listed[0]["inputSchema"]["required"] == ["instruction"]


def test_dispatch_captures_a_call_under_either_spelling() -> None:
    """Claude sends the qualified name; the text protocol and our own tests
    send the bare one. Both name the same specialist."""
    for name in (qualified("ask_jobs_agent"), "ask_jobs_agent"):
        calls: list[tuple[str, dict[str, Any]]] = []
        status, reply = dispatch(
            _call(name, {"instruction": "daily digest"}), _listed(ASK_JOBS), calls
        )
        assert status == 200
        assert reply is not None
        assert reply["result"]["isError"] is False
        assert reply["result"]["content"] == [{"type": "text", "text": DELEGATION_ACK}]
        assert calls == [("ask_jobs_agent", {"instruction": "daily digest"})]


def test_dispatch_refuses_a_tool_this_round_did_not_offer() -> None:
    """Never invent a specialist — an isError result, not a capture, so the
    harness learns immediately instead of waiting on a worker nobody ran."""
    calls: list[tuple[str, dict[str, Any]]] = []
    _status, reply = dispatch(_call("ask_connector_agent", {}), _listed(ASK_JOBS), calls)
    assert reply is not None
    assert reply["result"]["isError"] is True
    assert "ask_connector_agent" in reply["result"]["content"][0]["text"]
    assert calls == []


def test_dispatch_coerces_arguments_that_are_not_an_object() -> None:
    """A harness that sends `"arguments": null` (or a string, or a list) still
    made a real delegation; the specialist's own prompt defaults handle the
    empty case, so this captures rather than erroring."""
    for arguments in (None, "instruction=go", ["go"], 3):
        calls: list[tuple[str, dict[str, Any]]] = []
        _status, reply = dispatch(
            _call("ask_jobs_agent", arguments), _listed(ASK_JOBS), calls
        )
        assert reply is not None
        assert reply["result"]["isError"] is False
        assert calls == [("ask_jobs_agent", {})]


def test_dispatch_answers_a_notification_with_no_body() -> None:
    """`notifications/initialized` has no id: a body would be a protocol error."""
    calls: list[tuple[str, dict[str, Any]]] = []
    assert dispatch(
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        _listed(ASK_JOBS),
        calls,
    ) == (202, None)
    # Even a delegation-shaped notification is not a delegation.
    body = _call("ask_jobs_agent", {"instruction": "go"})
    del body["id"]
    assert dispatch(body, _listed(ASK_JOBS), calls) == (202, None)
    assert calls == []


def test_dispatch_reports_an_unknown_method_as_an_error_not_a_success() -> None:
    """It used to answer `200 {"result": {}}` — a client probing `resources/list`
    was told everything was fine and handed nothing. -32601 at status 200 is
    what the room bridge's `dispatch_jsonrpc` answers, byte for byte."""
    status, reply = dispatch({"id": 9, "method": "resources/list"}, _listed(ASK_JOBS), [])
    assert status == 200
    assert reply == {
        "jsonrpc": "2.0",
        "id": 9,
        "error": {"code": -32601, "message": "method not found: resources/list"},
    }
    assert "result" not in reply


def test_dispatch_still_answers_ping_with_success() -> None:
    """The one method the -32601 rule must not catch: a client whose keepalive
    errors may treat the connection as dead and drop a round mid-delegation.
    The room bridge answers `{}` here too."""
    assert dispatch({"id": 4, "method": "ping"}, _listed(ASK_JOBS), []) == (
        200,
        {"jsonrpc": "2.0", "id": 4, "result": {}},
    )


# --------------------------------------------------------------------------- #
# the per-method handlers, without `dispatch`
#
# `dispatch` is a router over `_METHODS`; these pin what each entry answers, so
# a wrong table wiring cannot hide behind a right envelope.
# --------------------------------------------------------------------------- #


def test_the_method_table_holds_exactly_the_implemented_methods() -> None:
    """Anything absent here is the -32601 path, so the table IS the capability
    list a harness's client probes against."""
    assert set(hub_mcp._METHODS) == {"initialize", "ping", "tools/list", "tools/call"}


def test_initialize_pins_the_versions_a_client_negotiates_against() -> None:
    assert hub_mcp._initialize() == {
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "arcelle-hub", "version": "1"},
    }


def test_tools_list_hands_back_the_round_s_own_catalog() -> None:
    """The same list, not a copy: `HubToolServer` builds it once per round and
    the handler must not be able to serve a stale or divergent catalog."""
    listed = _listed(ASK_JOBS, OPEN_FILE)
    assert hub_mcp._tools_list(listed) == {"tools": listed}
    assert hub_mcp._tools_list(listed)["tools"] is listed


def test_tools_call_captures_unqualifies_and_coerces() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    out = hub_mcp._tools_call(
        {"name": qualified("ask_jobs_agent"), "arguments": "not-an-object"},
        _listed(ASK_JOBS),
        calls,
    )
    assert out == {"content": [{"type": "text", "text": DELEGATION_ACK}], "isError": False}
    assert calls == [("ask_jobs_agent", {})]


def test_tools_call_appends_in_call_order() -> None:
    """`_hub_calls` re-keys these by index, so the order is the contract.

    The sequence is non-palindromic and every call carries a distinct argument
    on purpose. This test first shipped pinning names only, in the order
    ("open_file", "ask_jobs_agent", "open_file") — which reads the same
    reversed, so swapping `calls.append` for `calls.insert(0, ...)` left the
    only order test in the repo green. Reversed capture order would hand the
    model tool messages answering the wrong calls.
    """
    calls: list[tuple[str, dict[str, Any]]] = []
    listed = _listed(ASK_JOBS, OPEN_FILE)
    for i, name in enumerate(("open_file", "open_file", "ask_jobs_agent")):
        hub_mcp._tools_call({"name": name, "arguments": {"i": i}}, listed, calls)
    assert calls == [
        ("open_file", {"i": 0}),
        ("open_file", {"i": 1}),
        ("ask_jobs_agent", {"i": 2}),
    ]


def test_tools_call_refuses_a_name_the_round_never_offered() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    out = hub_mcp._tools_call({"name": "ask_connector_agent"}, _listed(ASK_JOBS), calls)
    assert out["isError"] is True
    assert out["content"][0]["text"] == "No tool named ask_connector_agent."
    assert calls == []


def test_ping_is_an_empty_success() -> None:
    assert hub_mcp._ping() == {}


# --------------------------------------------------------------------------- #
# the reading half, without a socket
#
# `_read_body` answers a 4xx and returns None, and `do_POST` returns on None.
# A live client reads one reply and hangs up, so neither half can be watched
# failing over HTTP; these swap the socket for a recorder instead.
# --------------------------------------------------------------------------- #


class _NoSocket(hub_mcp._HubRequestHandler):
    """The handler with the socket taken out, so the reading half can be read.

    `BaseHTTPRequestHandler.__init__` *serves* a request, so it must not run:
    everything `_read_body` and `do_POST` touch is set here instead, and `_send`
    records what would have gone on the wire. That recording is the only way to
    see a 4xx is the WHOLE answer — over HTTP a client reads one reply and hangs
    up, so a second reply (or a handler-thread raise after the first) is
    invisible, which is how both halves of the contract shipped unpinned.
    """

    def __init__(
        self,
        body: bytes,
        hub: Any,
        listed: list[dict[str, Any]],
        headers: dict[str, str] | None = None,
    ) -> None:
        # The real container, not a dict: `.get` differs on a repeated header and
        # one of these headers is the auth check.
        self.headers = http.client.HTTPMessage()
        base = {"Authorization": "Bearer tok", "Content-Length": str(len(body))}
        for name, value in {**base, **(headers or {})}.items():
            self.headers[name] = value
        self.rfile = io.BytesIO(body)
        self.hub = hub
        self.listed_tools = listed
        self.sent: list[tuple[int, bytes]] = []

    def _send(self, code: int, payload: bytes = b"") -> None:
        self.sent.append((code, payload))


@pytest.mark.parametrize(
    ("body", "headers", "code"),
    [
        (b'{"jsonrpc": "2.0", "id": 1, "meth', None, 400),  # unparseable
        (b"[1, 2]", None, 400),  # parses, but is not a JSON-RPC envelope
        (b"{}", {"Content-Length": str(hub_mcp._MAX_BODY + 1)}, 413),  # over bounds
    ],
)
def test_every_4xx_from_the_reading_half_is_the_whole_answer(
    body: bytes, headers: dict[str, str] | None, code: int
) -> None:
    """`_read_body` answers the 4xx and returns None; `do_POST` returns on None.

    All three refusal paths, because each one is a place the contract can break
    on its own: a path that answers and then returns `{}` sends its 4xx and then
    a second reply (the next request on a kept-alive connection collects it), and
    a `do_POST` missing the None guard sends the 4xx and then raises on
    `None.get`, printing a socketserver traceback per malformed request — the
    exact noise `_read_body`'s 400 was added to stop.
    """
    listed = _listed(ASK_JOBS)
    hub = SimpleNamespace(token="tok", calls=[])

    reading = _NoSocket(body, hub, listed, headers)
    assert reading._read_body() is None, "None is what tells `do_POST` it is done"
    assert [c for c, _ in reading.sent] == [code]

    whole = _NoSocket(body, hub, listed, headers)
    whole.do_POST()
    assert [c for c, _ in whole.sent] == [code], "a 4xx must not be followed by a reply"
    assert hub.calls == []


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

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None, **kwargs):
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
async def test_codex_gets_rename_and_organize_as_real_scoped_tools(monkeypatch) -> None:
    """Regression: Codex used to receive only a prose catalog and denied the
    same file operations Claude could perform. Its per-round MCP now exposes
    exactly the tools offered by the File agent and captures the real call for
    the unchanged graph executor."""
    rename = {
        "type": "function",
        "function": {
            "name": "rename_file",
            "description": "Rename one room file",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}}},
        },
    }
    organize = {
        "type": "function",
        "function": {
            "name": "organize_files",
            "description": "Rename or move several room files",
            "parameters": {"type": "object", "properties": {"files": {"type": "array"}}},
        },
    }
    model = external_llm.ExternalChatModel("codex-cli::gpt-5.6-sol")
    seen: dict[str, Any] = {}

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None, **kwargs):
        seen["system"] = system
        seen["hub_tools"] = list(hub_tools or [])
        listed = rpc(hub, "tools/list").json()["result"]["tools"]
        seen["listed"] = [tool["name"] for tool in listed]
        rpc(
            hub,
            "tools/call",
            {"name": "arcelle_organize_files", "arguments": {"files": []}},
        )
        return '\n'.join([
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "working"}}),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 1}}),
        ])

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)
    text, calls, _usage = await model.stream(
        [{"role": "system", "content": "You are the File agent."},
         {"role": "user", "content": "organize these files"}],
        [rename, organize],
        _noop,
    )

    assert seen["hub_tools"] == ["arcelle_rename_file", "arcelle_organize_files"]
    assert seen["listed"] == ["arcelle_rename_file", "arcelle_organize_files"]
    assert "tool_calls" not in seen["system"]
    assert [call.name for call in calls] == ["organize_files"]
    assert text == ""


@pytest.mark.asyncio
async def test_codex_delegation_names_avoid_harness_agent_collision(monkeypatch) -> None:
    """Codex's stock harness treats ``ask_*_agent`` as its own sub-agent
    machinery and refused a mounted tool with that name in the packaged app.
    It sees a neutral Arcelle capability name, while the graph receives its
    unchanged stable tool name back."""
    delegate = {
        "type": "function",
        "function": {
            "name": "ask_file_agent",
            "description": "Work with this room's files",
            "parameters": {
                "type": "object",
                "properties": {"instruction": {"type": "string"}},
                "required": ["instruction"],
            },
        },
    }
    model = external_llm.ExternalChatModel("codex-cli::gpt-5.6-sol")
    seen: dict[str, Any] = {}

    async def fake_run(
        self,
        prompt,
        cancel=None,
        system="",
        bridge_tools=None,
        hub=None,
        hub_tools=None,
        **kwargs,
    ):
        seen["prompt"] = prompt
        seen["system"] = system
        seen["hub_tools"] = list(hub_tools or [])
        listed = rpc(hub, "tools/list").json()["result"]["tools"]
        seen["listed"] = [tool["name"] for tool in listed]
        rpc(
            hub,
            "tools/call",
            {
                "name": "work_with_room_files",
                "arguments": {"instruction": "Rename alpha.md to beta.md"},
            },
        )
        return json.dumps(
            {
                "type": "turn.completed",
                "usage": {"input_tokens": 10, "output_tokens": 1},
            }
        )

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)
    text, calls, _usage = await model.stream(
        [
            {
                "role": "system",
                "content": "Call ask_file_agent for every room file change.",
            },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "function": {
                            "name": "ask_file_agent",
                            "arguments": {"instruction": "List files"},
                        }
                    }
                ],
            },
            {
                "role": "tool",
                "tool_name": "ask_file_agent",
                "content": "FOUND alpha.md",
            },
            {"role": "user", "content": "rename it"},
        ],
        [delegate],
        _noop,
    )

    assert seen["hub_tools"] == ["work_with_room_files"]
    assert seen["listed"] == ["work_with_room_files"]
    assert "ask_file_agent" not in seen["system"]
    assert "ask_file_agent" not in seen["prompt"]
    assert "work_with_room_files" in seen["prompt"]
    assert [(call.name, call.arguments) for call in calls] == [
        (
            "ask_file_agent",
            {"instruction": "Rename alpha.md to beta.md"},
        )
    ]
    assert text == ""


def test_codex_replaces_harness_shaped_main_prompt_with_app_controls() -> None:
    original = main_prompt(["file"], web_off=True)
    [rendered] = external_llm._codex_messages(  # noqa: SLF001 - regression seam
        [{"role": "system", "content": original}]
    )
    content = rendered["content"]
    assert "ROOM COORDINATOR" in content
    assert "direct controls for the Arcelle application" in content
    assert "work_with_room_files" in content
    assert "you never touch files or tools yourself" not in content.lower()
    assert "ask_file_agent" not in content


@pytest.mark.asyncio
async def test_a_native_round_still_disowns_the_harnesss_own_world(monkeypatch) -> None:
    """With every tool on a real endpoint there is no envelope to teach, and
    the paragraph that disowns the CLI's own tools used to ride the text
    protocol — so dropping the protocol dropped it too. Live QA 2026-07-25:
    "what skills do I have in this room?" made Claude Code list ITS OWN
    installed skills (claude-api, dataviz, loop, schedule…)."""
    model = external_llm.ExternalChatModel("claude-cli::sonnet")
    seen: dict[str, Any] = {}

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None, **kwargs):
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

    async def fake_run(self, prompt, cancel=None, system="", bridge_tools=None, hub=None, hub_tools=None, **kwargs):
        seen["system"] = system
        seen["hub"] = hub
        seen["hub_tools"] = list(hub_tools or [])
        return json.dumps({"result": "There are three files."})

    monkeypatch.setattr(external_llm.ExternalChatModel, "_run", fake_run)
    await model.stream([{"role": "user", "content": "hi"}], [OPEN_FILE], _noop)

    assert seen["hub_tools"] == []
    assert seen["hub"] is None
    assert "open_file" in seen["system"]
