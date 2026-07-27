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
from typing import Any

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

#: What a captured delegation returns to the CLI. It must read as SUCCESS (the
#: specialist really is about to run) while stopping the harness from doing
#: anything else — the real report arrives as the next round's transcript.
DELEGATION_ACK = (
    "Delegated. That specialist is running now; its report will reach you in "
    "your next turn. Stop here: do not call another tool and do not write the "
    "answer yet."
)


def qualified(name: str) -> str:
    """The tool name as Claude's allowlist and tool calls spell it."""
    return f"mcp__{HUB_SERVER_NAME}__{name}"


def unqualify(name: str) -> str:
    """``mcp__hub__ask_jobs_agent`` -> ``ask_jobs_agent`` (idempotent)."""
    prefix = f"mcp__{HUB_SERVER_NAME}__"
    return name[len(prefix) :] if name.startswith(prefix) else name


def _to_mcp_tool(tool: dict[str, Any]) -> dict[str, Any]:
    """One offered tool in MCP's ``tools/list`` shape."""
    fn = tool.get("function") or {}
    return {
        "name": str(fn.get("name") or ""),
        "description": str(fn.get("description") or ""),
        "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
    }


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
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            timeout = _SOCKET_TIMEOUT

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
                return hmac.compare_digest(got, f"Bearer {server.token}")

            def do_GET(self) -> None:  # noqa: N802 - only POST speaks JSON-RPC
                self._send(405)

            def do_POST(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._send(401)
                    return
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    if length < 0 or length > _MAX_BODY:
                        self._send(413)
                        return
                    body = json.loads(self.rfile.read(length) or b"{}")
                except (ValueError, OSError):
                    self._send(400)
                    return
                rid = body.get("id")
                method = str(body.get("method") or "")
                if rid is None:  # a notification wants no response body
                    self._send(202)
                    return
                if method == "initialize":
                    result: Any = {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "arcelle-hub", "version": "1"},
                    }
                elif method == "tools/list":
                    result = {"tools": listed}
                elif method == "tools/call":
                    params = body.get("params") or {}
                    name = unqualify(str(params.get("name") or ""))
                    args = params.get("arguments")
                    if not isinstance(args, dict):
                        args = {}
                    if name not in {t["name"] for t in listed}:
                        # Never invent a specialist the round did not offer.
                        result = {
                            "content": [
                                {"type": "text", "text": f"No tool named {name}."}
                            ],
                            "isError": True,
                        }
                    else:
                        server.calls.append((name, args))
                        result = {
                            "content": [{"type": "text", "text": DELEGATION_ACK}],
                            "isError": False,
                        }
                else:
                    result = {}
                self._send(
                    200, json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}).encode()
                )

        # THREADING, not plain HTTPServer. `protocol_version = "HTTP/1.1"` means
        # keep-alive, and a single-threaded server serves one connection to
        # completion before accepting the next — so a client that holds an idle
        # keep-alive connection open (Claude Code's MCP client does) blocks every
        # later request until the round's 300s timeout, and `close()`'s
        # `shutdown()` blocks behind the same handler. Both hangs would sit
        # inside `ExternalChatModel.stream`'s `finally`, taking the whole ask
        # with them. Daemon threads so a wedged handler can never keep the
        # sidecar process alive either.
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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
    "qualified",
    "unqualify",
]
