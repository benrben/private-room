"""REAL end-to-end integration test for the Rust<->Python agent seam (ADD-33).

Unlike the rest of the suite, this test does NOT mock the sidecar. It stands up
the *real* FastAPI app (``arcelle_sidecar.server.create_app`` with its default
factories) so the run drives the real graph -> real ``chat.OllamaChatModel`` ->
real ``langchain_ollama.ChatOllama`` -> real ``ollama.AsyncClient`` HTTP, and the
real ``mcp_client.McpClient`` HTTP. The only things mocked are the two things the
sidecar legitimately talks to over the network:

* a **mock Ollama** HTTP server speaking the ``/api/chat`` streaming NDJSON
  protocol ``langchain_ollama`` expects (verified against the installed
  ``ollama`` client: it POSTs to ``{base}/api/chat`` and parses each response
  line with ``ChatResponse(**json.loads(line))``); and
* a **mock room MCP bridge** faithfully implementing the Rust ``room_mcp.rs``
  JSON-RPC wire: bearer auth, ``tools/list`` / ``tools/call`` ->
  ``{content:[{type,text}], isError}``, no-id notification -> ``202``.

Both mock servers are plain ``ThreadingHTTPServer``s on ephemeral loopback
ports, running in background threads; the sidecar app is driven in-process via
``httpx.ASGITransport``. The assertions pin the exact ``{"t":...}`` event
sequence that ``src-tauri/src/sidecar.rs::stream_run`` parses and the exact
``/run`` body ``sidecar.rs::run_via_sidecar`` builds, so a drift on either side
of the language boundary fails here rather than silently in production.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
import pytest

from arcelle_sidecar.mcp_client import McpClient, McpError
from arcelle_sidecar.server import create_app

# --------------------------------------------------------------------------- #
# Mock Ollama — the /api/chat streaming NDJSON protocol chat.py/langchain expect
# --------------------------------------------------------------------------- #

MODEL = "qwen3.5:9b"


def _text_chunk(text: str, *, done: bool = False) -> dict[str, Any]:
    """One streaming ``ChatResponse`` line carrying a content delta."""
    return {
        "model": MODEL,
        "created_at": "2026-07-12T00:00:00.000Z",
        "message": {"role": "assistant", "content": text},
        "done": done,
        **({"done_reason": "stop"} if done else {}),
    }


def _tool_chunk(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """One streaming line carrying a tool_call (arguments are an OBJECT, matching
    what ``ollama``'s ``Message.ToolCall.Function.arguments`` deserialises)."""
    return {
        "model": MODEL,
        "created_at": "2026-07-12T00:00:00.000Z",
        "message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": name, "arguments": arguments}}],
        },
        "done": False,
    }


def _done_chunk() -> dict[str, Any]:
    return _text_chunk("", done=True)


class _OllamaState:
    def __init__(self) -> None:
        # FIFO of scripted responses; each entry is a list of NDJSON chunk dicts.
        self.script: deque[list[dict[str, Any]]] = deque()
        self.requests: list[dict[str, Any]] = []  # every /api/chat body received
        self.lock = threading.Lock()


class _OllamaHandler(BaseHTTPRequestHandler):
    def log_message(self, *a: Any) -> None:  # silence
        pass

    def do_POST(self) -> None:  # noqa: N802
        state: _OllamaState = self.server.state  # type: ignore[attr-defined]
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        if self.path.rstrip("/") != "/api/chat":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            parsed = json.loads(body) if body else {}
        except ValueError:
            parsed = {"_unparseable": body.decode("utf-8", "replace")}
        with state.lock:
            state.requests.append(parsed)
            chunks = state.script.popleft() if state.script else [_text_chunk("(no script)", done=True)]
        payload = "".join(json.dumps(c) + "\n" for c in chunks).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


# --------------------------------------------------------------------------- #
# Mock room MCP bridge — faithful to src-tauri/src/room_mcp.rs
# --------------------------------------------------------------------------- #

# The two built-in tools this test serves (a subset of the real LocalEngine
# catalog). Shapes mirror room_mcp.rs::to_mcp_tool: {name, description, inputSchema}.
_BRIDGE_TOOLS = [
    {
        "name": "list_room_files",
        "description": "List the files in the room",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_room",
        "description": "Full-text search across the room",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
]

_SEARCH_RESULT = "Clause 7 of lease.pdf: No pets of any kind are permitted on the premises."


class _BridgeState:
    def __init__(self, token: str) -> None:
        self.token = token
        self.rpc: list[dict[str, Any]] = []  # {method, params, auth, had_id}
        self.tool_calls: list[dict[str, Any]] = []  # {name, arguments, auth}
        self.lock = threading.Lock()


class _BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a: Any) -> None:
        pass

    def _reply(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        state: _BridgeState = self.server.state  # type: ignore[attr-defined]
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        auth = self.headers.get("Authorization")

        # Bearer auth exactly like room_mcp.rs::authorize (401 -> {} on mismatch).
        if auth is None or auth.strip() != f"Bearer {state.token}":
            self._reply(401, b"{}")
            return

        try:
            req = json.loads(raw)
        except ValueError:
            self._reply(400, b"{}")
            return

        rid = req.get("id")
        method = req.get("method", "")
        params = req.get("params", {})
        with state.lock:
            state.rpc.append(
                {"method": method, "params": params, "auth": auth, "had_id": rid is not None}
            )

        # A request without an id is a notification -> 202 Accepted, empty body.
        if rid is None:
            self._reply(202, b"")
            return

        if method == "initialize":
            result: Any = {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "arcelle", "version": "test"},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": _BRIDGE_TOOLS}
        elif method == "tools/call":
            name = params.get("name", "")
            arguments = params.get("arguments", {})
            with state.lock:
                state.tool_calls.append({"name": name, "arguments": arguments, "auth": auth})
            if name == "search_room":
                text = _SEARCH_RESULT
            elif name == "list_room_files":
                text = "lease.pdf\nnotice.txt"
            else:
                text = f"unknown tool: {name}"
            body = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {"content": [{"type": "text", "text": text}], "isError": False},
                }
            ).encode()
            self._reply(200, body)
            return
        else:
            body = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32601, "message": f"method not found: {method}"},
                }
            ).encode()
            self._reply(200, body)
            return

        body = json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}).encode()
        self._reply(200, body)


# --------------------------------------------------------------------------- #
# server plumbing
# --------------------------------------------------------------------------- #


def _spawn(handler_cls: type[BaseHTTPRequestHandler], state: Any) -> tuple[ThreadingHTTPServer, str]:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    srv.state = state  # type: ignore[attr-defined]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    return srv, f"http://127.0.0.1:{port}"


def _rust_chat_message(
    role: str,
    content: str,
    *,
    images: list[str] | None = None,
    tool_calls: Any = None,
    tool_name: str | None = None,
) -> dict[str, Any]:
    """A message serialised exactly as Rust ``ollama::ChatMessage`` would.

    ChatMessage (src-tauri/src/ollama.rs:69) is ``{role, content}`` always, with
    ``images`` / ``tool_calls`` / ``tool_name`` each ``skip_serializing_if =
    Option::is_none`` — i.e. present only when set. Mirroring that here is the
    point of the cross-language field-shape check.
    """
    m: dict[str, Any] = {"role": role, "content": content}
    if images is not None:
        m["images"] = images
    if tool_calls is not None:
        m["tool_calls"] = tool_calls
    if tool_name is not None:
        m["tool_name"] = tool_name
    return m


def _run_body(*, ollama_base: str, mcp_url: str, token: str, question: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    """The /run body EXACTLY as sidecar.rs::run_via_sidecar builds it.

    Keys, and only these keys: model, question, messages, temperature,
    ollama_base_url, mcp{url,token}, routing{write,ui,jobs}, web_enabled,
    mcp_routes, advisors, run_id. Rust does NOT send max_rounds.
    """
    return {
        "model": MODEL,
        "question": question,
        "messages": messages,
        "temperature": 0.7,
        "ollama_base_url": ollama_base,
        "mcp": {"url": mcp_url, "token": token},
        "routing": {"write": False, "ui": False, "jobs": False},
        "web_enabled": False,
        "mcp_routes": 0,
        "advisors": [],
        "run_id": token,
    }


async def _post_run(app: Any, body: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
    """POST /run against the real app, return (status, parsed NDJSON events)."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar", timeout=30.0) as client:
        resp = await client.post("/run", json=body)
        text = resp.text
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            events.append(json.loads(line))
    return resp.status_code, events


def _kinds(events: list[dict[str, Any]]) -> list[str]:
    return [e["t"] for e in events]


# --------------------------------------------------------------------------- #
# Test 1 — the happy-path single-tool run
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_live_seam_single_tool_run():
    ollama_state = _OllamaState()
    token = "run-token-abc123"
    bridge_state = _BridgeState(token)

    ollama_srv, ollama_base = _spawn(_OllamaHandler, ollama_state)
    bridge_srv, bridge_base = _spawn(_BridgeHandler, bridge_state)
    mcp_url = bridge_base + "/mcp"

    # Round 1: ask for search_room. Round 2 (after the tool result): stream the
    # final answer in two pieces, no tool calls.
    answer_pieces = ["The lease ", "prohibits pets (clause 7)."]
    final_answer = "".join(answer_pieces)
    ollama_state.script.append([_tool_chunk("search_room", {"query": "pets"}), _done_chunk()])
    ollama_state.script.append(
        [_text_chunk(answer_pieces[0]), _text_chunk(answer_pieces[1]), _done_chunk()]
    )

    app = create_app()  # real factories: real OllamaChatModel + real McpClient
    question = "what does the contract say about pets"
    messages = [
        _rust_chat_message("system", "You are the room assistant."),
        _rust_chat_message("user", question),
    ]
    try:
        status, events = await _post_run(
            app,
            _run_body(
                ollama_base=ollama_base,
                mcp_url=mcp_url,
                token=token,
                question=question,
                messages=messages,
            ),
        )
    finally:
        ollama_srv.shutdown()
        bridge_srv.shutdown()

    # (a) The real app accepted the Rust-shaped body (no 422 -> the RunRequest /
    #     ChatMessage wire shapes are compatible across the language boundary).
    assert status == 200, f"/run rejected the Rust-shaped body: {status} {events}"

    # (b) The EXACT event sequence sidecar.rs::stream_run parses:
    #     lane -> round -> usage -> (delta*) -> step -> step_status -> round ->
    #     usage -> (delta*) -> final. `usage` (the token-budget bar's snapshot)
    #     fires once per round, right after that round's model call returns.
    kinds = _kinds(events)
    assert kinds[0] == "lane"
    # squeeze out delta runs to compare the structural skeleton
    skeleton = [k for i, k in enumerate(kinds) if k != "delta"]
    assert skeleton == [
        "lane",
        "round",
        "usage",
        "step",
        "step_status",
        "round",
        "usage",
        "final",
    ], f"unexpected event skeleton: {kinds}"

    # (c) Every event matches the {"t":..,"v":..}/{"t":"step_status","ok":..} shape
    #     the Rust side reads (str_v() reads "v"; step_status reads "ok").
    lane = events[0]
    assert lane == {"t": "lane", "v": "Answering"}  # ui=False,write=False,web=False
    step = next(e for e in events if e["t"] == "step")
    assert step == {"t": "step", "v": "Searched the room"}  # labels.py tool_step_label
    step_status = next(e for e in events if e["t"] == "step_status")
    assert step_status == {"t": "step_status", "ok": True}
    for d in [e for e in events if e["t"] == "delta"]:
        assert set(d.keys()) == {"t", "v"} and isinstance(d["v"], str)

    # (d) The deltas belong to the SECOND round and reconstruct the answer, and the
    #     final event is exactly what the mock model returned.
    delta_text = "".join(e["v"] for e in events if e["t"] == "delta")
    assert delta_text == final_answer
    final = events[-1]
    assert final == {"t": "final", "v": final_answer}

    # (e) The mock bridge actually received tools/call for the tool the model asked
    #     for, with the right arguments and the right bearer token.
    assert len(bridge_state.tool_calls) == 1, bridge_state.tool_calls
    tc = bridge_state.tool_calls[0]
    assert tc["name"] == "search_room"
    assert tc["arguments"] == {"query": "pets"}
    assert tc["auth"] == f"Bearer {token}"

    # (f) The bridge saw the MCP lifecycle handshake (initialize + its
    #     notifications/initialized notification) BEFORE the first tools/* call,
    #     then tools/list before tools/call — all bearer-authed. The handshake is
    #     what lets a stricter third-party MCP server accept the subsequent calls.
    methods = [r["method"] for r in bridge_state.rpc]
    assert methods == [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
    ], methods
    assert all(r["auth"] == f"Bearer {token}" for r in bridge_state.rpc)

    # (g) The model was called exactly twice (two rounds) and its second request
    #     carried the tool result the graph fed back.
    assert len(ollama_state.requests) == 2, ollama_state.requests
    round2_roles = [m.get("role") for m in ollama_state.requests[1]["messages"]]
    assert "tool" in round2_roles, round2_roles


# --------------------------------------------------------------------------- #
# Test 2 — duplicate identical tool call is suppressed (SPEC §3.2)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_duplicate_tool_call_suppressed():
    ollama_state = _OllamaState()
    token = "dup-token-xyz789"
    bridge_state = _BridgeState(token)

    ollama_srv, ollama_base = _spawn(_OllamaHandler, ollama_state)
    bridge_srv, bridge_base = _spawn(_BridgeHandler, bridge_state)
    mcp_url = bridge_base + "/mcp"

    # Round 1 and round 2 ask for the SAME tool with IDENTICAL args. The second
    # must be suppressed (no bridge call); the all-duplicate round forces a
    # tool-less synthesis in round 3.
    final_answer = "Based on the search, pets are not allowed."
    ollama_state.script.append([_tool_chunk("search_room", {"query": "pets"}), _done_chunk()])
    ollama_state.script.append([_tool_chunk("search_room", {"query": "pets"}), _done_chunk()])
    ollama_state.script.append([_text_chunk(final_answer), _done_chunk()])

    app = create_app()
    question = "what does the contract say about pets"
    messages = [
        _rust_chat_message("system", "You are the room assistant."),
        _rust_chat_message("user", question),
    ]
    try:
        status, events = await _post_run(
            app,
            _run_body(
                ollama_base=ollama_base,
                mcp_url=mcp_url,
                token=token,
                question=question,
                messages=messages,
            ),
        )
    finally:
        ollama_srv.shutdown()
        bridge_srv.shutdown()

    assert status == 200, events

    # Exactly ONE tools/call reached the bridge despite two identical asks.
    assert len(bridge_state.tool_calls) == 1, bridge_state.tool_calls
    assert bridge_state.tool_calls[0]["name"] == "search_room"

    # Exactly one "step" was emitted (the duplicate round emits its round marker
    # but no step, because the call was suppressed before exec).
    kinds = _kinds(events)
    assert kinds.count("step") == 1, kinds
    assert kinds.count("step_status") == 1, kinds
    # Three model rounds ran (round marker per round: 3), ending in a final.
    assert kinds.count("round") == 3, kinds
    assert kinds[-1] == "final"
    assert events[-1] == {"t": "final", "v": final_answer}
    assert len(ollama_state.requests) == 3, ollama_state.requests


# --------------------------------------------------------------------------- #
# Test 3 — /health against the real app
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_health_endpoint():
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sidecar") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is True
    assert isinstance(payload["version"], str) and payload["version"]


# --------------------------------------------------------------------------- #
# Test 4 — the real McpClient against the faithful bridge: bearer auth +
# notification (no-id) -> 202. Exercises the initialize/ping/notify wire directly
# (the run path now runs the initialize handshake before tool traffic too; see
# Test 1 assertion (f)).
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_mcp_client_wire_auth_and_notifications():
    token = "wire-token-42"
    bridge_state = _BridgeState(token)
    bridge_srv, bridge_base = _spawn(_BridgeHandler, bridge_state)
    mcp_url = bridge_base + "/mcp"
    try:
        # Right token: initialize (which internally fires the notifications/
        # initialized notification -> 202) then tools/list then a tool call.
        async with McpClient(mcp_url, token) as client:
            info = await client.initialize()
            assert info["serverInfo"]["name"] == "arcelle"
            await client.ping()
            tools = await client.list_tools()
            names = {t.name for t in tools}
            assert {"list_room_files", "search_room"} <= names
            result = await client.call_tool("search_room", {"query": "pets"})
            assert result.is_error is False
            assert result.text == _SEARCH_RESULT

        # The notification reached the bridge with no id (had_id False).
        notes = [r for r in bridge_state.rpc if not r["had_id"]]
        assert any(r["method"] == "notifications/initialized" for r in notes), bridge_state.rpc

        # Wrong token: the bridge returns 401 and the client raises McpError.
        async with McpClient(mcp_url, "not-the-token") as bad:
            with pytest.raises(McpError):
                await bad.list_tools()
    finally:
        bridge_srv.shutdown()
