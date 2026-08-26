"""The hub's own MCP server: ``ask_*_agent`` as REAL tools for a cloud CLI.

Why this exists (live QA 2026-07-25, reproduced outside the app twice)
---------------------------------------------------------------------
Claude Code is an agent HARNESS, not a text completion. Describe a tool to it
in prose and it tries to *invoke* that tool through its own machinery; finding
nothing, it narrates a failure that never happened::

    "I tried to set this up as a scheduled workflow, but the automation tool
     isn't responding right now (it's erroring out on my end)"

    -> parse_tool_calls() == []      # no envelope was ever emitted
    -> zero room-bridge calls        # no worker ever ran
    -> the CLI's own envelope: num_turns=4, permission_denials=[]

`external_llm` already learned this once and fixed it for ROOM tools by
handing them to Claude as real MCP tools on the room bridge. It exempted the
hub's own delegation tools — "which exist nowhere but graph.py — stays on the
text protocol, where it works". They do not work. This module closes that
exemption: the ``ask_*_agent`` tools get a real MCP endpoint too, so Claude
calls them natively instead of narrating.

What it deliberately does NOT do
--------------------------------
It does not RUN the specialist. A ``tools/call`` here only CAPTURES the call
and returns a stop-now acknowledgement; :meth:`ExternalChatModel.stream`
returns the captured calls as ordinary :class:`ToolCall` envelopes and the
existing graph loop runs the worker exactly as it does for a local model.
That keeps the whole hub — worker boxes, prompts, the agent strip, the report
contract — engine-independent, and it keeps re-entrancy out of the design:
nothing here reaches back into a graph that is mid-await.

Security: loopback only, ephemeral port, a fresh bearer token per round, and
it lives for exactly one CLI process. Same shape as the Rust room bridge.
"""

from __future__ import annotations

import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .mcp_client import PROTOCOL_VERSION

#: Ceiling on a single request's body. The only bodies this endpoint ever sees
#: are small JSON-RPC envelopes; a larger `Content-Length` is a bug or a stuck
#: client, and reading it would block the handler thread indefinitely.
_MAX_BODY = 1 << 20

#: Per-connection socket timeout. A client that opens a connection and then
#: stops talking must not hold a thread past the end of the round.
_SOCKET_TIMEOUT = 30.0

#: The MCP server name Claude namespaces these tools under: a call arrives as
#: ``mcp__hub__ask_jobs_agent``. Distinct from the room bridge's ``room``.
HUB_SERVER_NAME = "hub"

#: What a captured tool call returns to the CLI. It must read as SUCCESS while
#: stopping the harness from claiming the action is already complete — the
#: graph executes the captured call and supplies its real result next round.
#:
#: It used to say "do not call another tool", which serialized the one thing the
#: hub is built for: `_Delegator.launch` fans out every delegation in a round
#: before awaiting any, so a three-part request that Claude could have handed to
#: three specialists at once instead took three round trips, at three times the
#: cost. Delegating MORE is explicitly allowed; everything else still waits.
DELEGATION_ACK = (
    "Accepted. Arcelle will execute this tool call and return its real result "
    "in your next turn. You may call other independent tools now in this same "
    "turn; they run "
    "together. Do not claim the action succeeded and do not write the answer "
    "yet: you do not have the result back."
)


def qualified(name: str) -> str:
    """The tool name as Claude's allowlist and tool calls spell it."""
    return f"mcp__{HUB_SERVER_NAME}__{name}"


def unqualify(name: str) -> str:
    """``mcp__hub__ask_jobs_agent`` -> ``ask_jobs_agent`` (idempotent).

    An unprefixed name comes back untouched, which is what makes this safe to
    call on every incoming ``tools/call``: a CLI that spells the tool bare is
    answered the same as one that namespaces it.
    """
    return name.removeprefix(f"mcp__{HUB_SERVER_NAME}__")


def _to_mcp_tool(tool: dict[str, Any]) -> dict[str, Any]:
    """One offered tool in MCP's ``tools/list`` shape."""
    fn = tool.get("function") or {}
    return {
        "name": str(fn.get("name") or ""),
        "description": str(fn.get("description") or ""),
        "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
    }


def _initialize() -> dict[str, Any]:
    """The handshake result: wire contract, not decoration.

    A CLI's MCP client negotiates against ``protocolVersion`` and identifies
    the endpoint by ``serverInfo`` — floating either changes what the client
    on the other side agreed to. The revision itself is
    :data:`.mcp_client.PROTOCOL_VERSION`, the single copy the sidecar's two
    halves both announce; a second literal here could drift from it.
    """
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "arcelle-hub", "version": "1"},
    }


def _tools_list(listed: list[dict[str, Any]]) -> dict[str, Any]:
    """The catalog: exactly the tools this round offered, verbatim."""
    return {"tools": listed}


def _tools_call(
    params: dict[str, Any],
    listed: list[dict[str, Any]],
    calls: list[tuple[str, dict[str, Any]]],
) -> dict[str, Any]:
    """Capture one delegation and acknowledge it — this never runs a worker.

    Appends ``(name, arguments)`` to ``calls`` in call order; the graph loop
    runs the specialist afterwards, exactly as it does for a local model (see
    the module docstring on why capture, not execution).
    """
    name = unqualify(str(params.get("name") or ""))
    args = params.get("arguments")
    if not isinstance(args, dict):
        args = {}
    if name not in {t["name"] for t in listed}:
        # Never invent a specialist the round did not offer.
        return {
            "content": [{"type": "text", "text": f"No tool named {name}."}],
            "isError": True,
        }
    calls.append((name, args))
    return {
        "content": [{"type": "text", "text": DELEGATION_ACK}],
        "isError": False,
    }


def _ping() -> dict[str, Any]:
    """MCP's keepalive: the one method that must answer SUCCESS, empty result.

    A client whose ping errors is entitled to treat the connection as dead,
    which would kill a round mid-delegation. The room bridge answers ``{}``
    here too — this handler is why the -32601 in :func:`dispatch` is safe to
    add without breaking Claude Code's client.
    """
    return {}


#: What every entry in :data:`_METHODS` accepts: the request's ``params``, the
#: round's offered tools, and the capture list.
_MethodFn = Callable[
    [dict[str, Any], list[dict[str, Any]], list[tuple[str, dict[str, Any]]]],
    dict[str, Any],
]

#: JSON-RPC method -> the function that answers it, mirroring the `match` in
#: ``dispatch_jsonrpc`` (src-tauri/src/room_mcp.rs). A table, not an if/elif
#: chain: :func:`dispatch` stays a router that cannot grow a branch, and a
#: method missing from here is the -32601 path rather than a silent success.
#: Each handler takes only the arguments it uses; the adapters drop the rest.
_METHODS: dict[str, _MethodFn] = {
    "initialize": lambda _params, _listed, _calls: _initialize(),
    "ping": lambda _params, _listed, _calls: _ping(),
    "tools/list": lambda _params, listed, _calls: _tools_list(listed),
    "tools/call": _tools_call,
}


def dispatch(
    body: dict[str, Any],
    listed: list[dict[str, Any]],
    calls: list[tuple[str, dict[str, Any]]],
) -> tuple[int, dict[str, Any] | None]:
    """One JSON-RPC request -> ``(http status, response body or None)``.

    Socket-free on purpose. This and the handlers in :data:`_METHODS` are the
    whole protocol — the tool catalog, the "never invent a specialist" refusal,
    and the capture that makes delegation work on a harness engine — so it can
    be pinned by tests without standing up a server;
    :class:`_HubRequestHandler` keeps nothing but transport. ``None`` as the
    body means "answer this status with no body at all" (a notification).

    ``listed`` is the round's offered tools already in ``tools/list`` shape;
    ``calls`` is appended to in place when a delegation is captured.

    Deliberate port of ``dispatch_jsonrpc`` in ``src-tauri/src/room_mcp.rs``,
    the other half of this contract: same statuses, same error shape.
    """
    rid = body.get("id")
    method = str(body.get("method") or "")
    if rid is None:  # a notification wants no response body
        return 202, None
    handler = _METHODS.get(method)
    if handler is None:
        # Errors must never pass silently. This used to fall through to
        # `result = {}`, so a client probing `resources/list` or `prompts/list`
        # was told 200 OK, everything is fine, and handed nothing. -32601 is the
        # spec's answer to an unimplemented method and is what a harness expects
        # when it probes an optional capability. Status 200 and the lowercase
        # message copy the room bridge's `dispatch_jsonrpc` verbatim, so both
        # engines put the same bytes on the wire.
        return 200, {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32601, "message": f"method not found: {method}"},
        }
    result = handler(body.get("params") or {}, listed, calls)
    return 200, {"jsonrpc": "2.0", "id": rid, "result": result}


class _HubRequestHandler(BaseHTTPRequestHandler):
    """The request handler for one :class:`HubToolServer`: transport only.

    Socket timeout, bearer auth, body bounds, body parse, write the reply —
    every protocol decision belongs to :func:`dispatch`.
    """

    protocol_version = "HTTP/1.1"
    timeout = _SOCKET_TIMEOUT

    #: Bound per round by :func:`_make_handler`. Annotation-only on purpose: a
    #: subclass that forgot them raises rather than serving an endpoint whose
    #: token is the empty string.
    hub: HubToolServer
    listed_tools: list[dict[str, Any]]

    def log_message(self, *args: Any) -> None:  # noqa: N802 - silence
        pass

    def handle_one_request(self) -> None:  # noqa: N802
        # A silent client must not pin this thread. `timeout` above only
        # applies once BaseHTTPRequestHandler has a socket with one set,
        # so set it explicitly and treat a timeout as "close it".
        self.connection.settimeout(_SOCKET_TIMEOUT)
        try:
            super().handle_one_request()
        except (TimeoutError, OSError):
            self.close_connection = True

    def _send(self, code: int, payload: bytes = b"") -> None:
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            if self.close_connection:
                # Set by `_read_body` when it refused a body it never read (and
                # by the client's own `Connection: close`). Say so on the wire:
                # a keep-alive reply here would be followed by the leftover
                # bytes, which the next `parse_request` reads as a request line.
                self.send_header("Connection", "close")
            self.end_headers()
            if payload:
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # The CLI hung up before reading its reply — normal when a
            # turn is cancelled or the process is killed on timeout, and
            # there is nobody left to tell. Without this, socketserver
            # prints a full traceback per occurrence: noise that buries
            # the failures worth reading in a long unattended run.
            pass

    def _authorized(self) -> bool:
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, f"Bearer {self.hub.token}")

    def _read_body(self) -> dict[str, Any] | None:
        """This request's JSON-RPC envelope, or ``None`` once 4xx is answered.

        Owns the bounds and the parse so :meth:`do_POST` stays authorize ->
        read -> dispatch -> send. ``None`` means the reply is already written:
        413 for a `Content-Length` past :data:`_MAX_BODY`, 400 for a body that
        is not a JSON object.

        The two refusals that never consume the body also END the connection.
        Those bytes are still queued on the socket, and on a kept-alive
        connection the next `parse_request` reads them as a request line —
        a run of confusing 400s until the connection dies. A body we did read
        leaves the connection reusable, malformed or not.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            # An unparseable Content-Length means we cannot tell where this
            # body ends, so we cannot skip past it either.
            self.close_connection = True
            self._send(400)
            return None
        if length < 0 or length > _MAX_BODY:
            self.close_connection = True
            self._send(413)
            return None
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            self._send(400)
            return None
        if not isinstance(body, dict):
            # A JSON array or scalar is not a JSON-RPC envelope. Answering
            # 400 is what the parse above always meant: before, `.get` on a
            # list raised inside the handler thread and the client got a
            # socketserver traceback instead of a reply.
            self._send(400)
            return None
        return body

    def do_GET(self) -> None:  # noqa: N802 - only POST speaks JSON-RPC
        self._send(405)

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._send(401)
            return
        body = self._read_body()
        if body is None:  # `_read_body` already answered 400 or 413
            return
        status, reply = dispatch(body, self.listed_tools, self.hub.calls)
        self._send(status, b"" if reply is None else json.dumps(reply).encode())


def _make_handler(
    server: HubToolServer, listed: list[dict[str, Any]]
) -> type[BaseHTTPRequestHandler]:
    """Bind the transport to one round: this server's token, these tools.

    A subclass rather than a closure so every transport method reads (and can
    be pinned) on its own, at module level.
    """

    class Handler(_HubRequestHandler):
        hub = server
        listed_tools = listed

    return Handler


class HubToolServer:
    """A loopback MCP endpoint serving the hub tools for ONE CLI round.

    Start it, pass :attr:`url` and :attr:`token` to the CLI as a second MCP
    server, read :attr:`calls` when the process exits, then :meth:`close`.
    """

    def __init__(self, tools: list[dict[str, Any]], token: str) -> None:
        #: Captured delegations, in call order: ``(name, arguments)``.
        #:
        #: Written from handler threads, read once by the asyncio task after the
        #: CLI process has exited (so every request is finished by then).
        #: ``list.append`` is atomic under the GIL, which is the only guarantee
        #: needed — concurrent delegations have no meaningful order anyway, and
        #: `_hub_calls` re-keys them by index on read.
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.token = token
        listed = [t for t in (_to_mcp_tool(t) for t in tools) if t["name"]]
        handler = _make_handler(self, listed)

        # THREADING, not plain HTTPServer. `protocol_version = "HTTP/1.1"` means
        # keep-alive, and a single-threaded server serves one connection to
        # completion before accepting the next — so a client that holds an idle
        # keep-alive connection open (Claude Code's MCP client does) blocks every
        # later request until the round ends on its own, and `close()`'s
        # `shutdown()` blocks behind the same handler. Both hangs would sit
        # inside `ExternalChatModel.stream`'s `finally`, taking the whole ask
        # with them. Daemon threads so a wedged handler can never keep the
        # sidecar process alive either.
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self.port: int = self._server.server_port
        self.url = f"http://127.0.0.1:{self.port}/mcp"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        # Best-effort and never fatal: this runs in a `finally` around a live
        # CLI round, so a failure here must not replace the round's real result
        # (or its real exception) with a teardown error.
        try:
            self._server.shutdown()
        finally:
            self._server.server_close()

    def __enter__(self) -> HubToolServer:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


__all__ = [
    "DELEGATION_ACK",
    "HUB_SERVER_NAME",
    "HubToolServer",
    "dispatch",
    "qualified",
    "unqualify",
]
