"""Cross-language wire-compatibility test for the Electron-ported MCP bridge.

This is the single most important test in this migration batch. Every future
agent turn in the shipped app reaches the room's files over this bridge, so
``src/main/mcpBridge.ts`` (a fresh TypeScript port of
``src-tauri/src/room_mcp.rs``'s wire transport) has to be byte-for-byte
compatible with the client that will be talking to it. That client is
``arcelle_sidecar.mcp_client.McpClient`` — the REAL, UNCHANGED production
client, imported here directly, not a reimplementation and not a mock.

So this test does not assert about the wire; it *runs* both sides. The bridge
is a real child process (``npx vite-node
src/main/mcpBridgeRunner.ts`` — this workspace ships ``vite-node`` via
its ``vitest``/``vite`` dependency, and neither ``tsx`` nor ``ts-node`` is
installed) serving a small FAKE ``ToolDispatcher`` (an ``echo`` tool and an
always-failing ``boom`` tool), and every assertion below is made through the
real client over a real loopback socket.

The tool catalog and the real ``exec_tool`` dispatch are explicitly out of
scope for this batch (see ``mcpBridge.ts``'s module doc). What IS proven here
is the transport, and in particular the four things ``mcp_client.py``'s own
docstring and code depend on:

* ``initialize`` -> ``notifications/initialized`` -> ``tools/list`` ->
  ``tools/call`` all agree end to end.
* A **notification** (no ``id``) is answered ``202 Accepted`` with an *empty
  body*. ``notify()`` deliberately never calls ``.json()`` on it, so a bridge
  that sent ``{}`` would pass every ordinary test and only be caught here.
* A **tool failure is not a JSON-RPC error** — it arrives as a normal result
  with ``isError: true``, which is also how the already-cancelled-run refusal
  arrives. Neither raises.
* A protocol-level failure (bad bearer, a body over the bridge's cap) *does*
  surface, through the client's own ``McpError`` path.

The unit-level half of this batch's coverage — the constant-time compare, the
oversize guard's internals, the shutdown severing — lives in
``apps/desktop/src/main/mcpBridge.test.ts``.
"""

from __future__ import annotations

import asyncio
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from arcelle_sidecar.mcp_client import McpClient, McpError

# services/agent-sidecar/tests/test_mcp_bridge_wire_compat.py -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_ELECTRON_APP_DIR = _REPO_ROOT / "apps" / "desktop"
_RUNNER_RELATIVE = "src/main/mcpBridgeRunner.ts"

#: How long to wait for `vite-node` to cold-start and print its port line.
_STARTUP_TIMEOUT = 60.0

#: Must match MAX_REQUEST_BODY in src/main/mcpBridge.ts (and
#: MAX_REQUEST_BODY in src-tauri/src/room_mcp.rs, which it was ported from).
MAX_REQUEST_BODY = 16 * 1024 * 1024


class _BridgeProcess:
    """A running `mcpBridgeRunner.ts` child process."""

    def __init__(self, process: asyncio.subprocess.Process, port: int) -> None:
        self.process = process
        self.port = port

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/mcp"


async def _read_port_line(stream: asyncio.StreamReader) -> int:
    """Read stdout until the `MCP_BRIDGE_PORT=` handshake — the same handshake
    shape `sidecar.ts`'s `parsePortLine` reads from the real sidecar."""
    while True:
        raw = await stream.readline()
        if not raw:
            raise RuntimeError("mcpBridgeRunner exited before announcing its port")
        line = raw.decode("utf-8", errors="replace").strip()
        if line.startswith("MCP_BRIDGE_PORT="):
            return int(line[len("MCP_BRIDGE_PORT=") :])


@asynccontextmanager
async def _running_bridge(token: str, *, cancelled: bool = False) -> AsyncIterator[_BridgeProcess]:
    """Start the real TS bridge as a child process and yield it, guaranteeing
    it is torn down (even on a failing assertion) when the block ends."""
    if not _ELECTRON_APP_DIR.is_dir():
        pytest.skip(f"electron-app workspace not found at {_ELECTRON_APP_DIR}")

    env = dict(os.environ)
    env["MCP_BRIDGE_TOKEN"] = token
    if cancelled:
        env["MCP_BRIDGE_CANCELLED"] = "1"

    process = await asyncio.create_subprocess_exec(
        "npx",
        "vite-node",
        _RUNNER_RELATIVE,
        cwd=str(_ELECTRON_APP_DIR),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        try:
            port = await asyncio.wait_for(_read_port_line(process.stdout), timeout=_STARTUP_TIMEOUT)
        except asyncio.TimeoutError:
            stderr = b""
            if process.stderr is not None:
                stderr = await process.stderr.read()
            raise RuntimeError(
                f"mcpBridgeRunner never announced a port within {_STARTUP_TIMEOUT}s; "
                f"stderr:\n{stderr.decode('utf-8', errors='replace')}"
            ) from None
        yield _BridgeProcess(process, port)
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


@asynccontextmanager
async def _client(token: str, *, cancelled: bool = False) -> AsyncIterator[McpClient]:
    """A real `McpClient` pointed at a real running bridge."""
    async with _running_bridge(token, cancelled=cancelled) as bridge:
        client = McpClient(bridge.url, token)
        try:
            yield client
        finally:
            await client.aclose()


async def test_initialize_list_tools_and_call_a_known_good_tool() -> None:
    """The full lifecycle a real turn drives: initialize -> list_tools ->
    call_tool, all through the REAL McpClient against the REAL TS bridge."""
    token = secrets.token_hex(16)
    async with _client(token) as client:
        init_result = await client.initialize()
        assert isinstance(init_result, dict)
        assert init_result.get("serverInfo", {}).get("name") == "arcelle"
        # The bridge echoes the version the client asked for, rather than
        # imposing its own — mcp_client.PROTOCOL_VERSION is what it sends.
        assert init_result.get("protocolVersion") == "2024-11-05"
        assert init_result.get("capabilities") == {"tools": {}}

        tools = await client.list_tools()
        assert sorted(t.name for t in tools) == ["boom", "echo"]
        echo = next(t for t in tools if t.name == "echo")
        assert echo.description == "Echoes back its `text` argument."
        assert echo.input_schema["type"] == "object"
        assert "text" in echo.input_schema["properties"]
        # to_ollama() is what the chat model actually receives; it must survive
        # the round trip with a real schema, not the empty-object fallback
        # list_tools() substitutes when a spec arrives malformed.
        assert echo.to_ollama()["function"]["parameters"] == echo.input_schema

        result = await client.call_tool("echo", {"text": "hello from the sidecar"})
        assert result.is_error is False
        assert result.text == "hello from the sidecar"
        assert result.images == []


async def test_call_tool_on_a_failing_tool_reports_isError_not_an_exception() -> None:
    """A tool FAILURE is a normal result with isError:true, never a JSON-RPC
    error — mcp_client.py's own docstring calls this out explicitly."""
    token = secrets.token_hex(16)
    async with _client(token) as client:
        result = await client.call_tool("boom", {})
        assert result.is_error is True
        assert result.text == "boom failed on purpose"


async def test_call_tool_on_an_already_cancelled_run_is_stopped_not_an_error() -> None:
    """The already-cancelled-run synthesized refusal: a normal ToolResult with
    is_error=True and the exact "Stopped by the user" text, not an McpError.

    initialize/list_tools must still succeed on a cancelled run — refusing
    tools/list would report an EMPTY CATALOG, which reads as a wiring failure
    rather than a clean user Stop.
    """
    token = secrets.token_hex(16)
    async with _client(token, cancelled=True) as client:
        await client.initialize()
        await client.ping()
        tools = await client.list_tools()
        assert {t.name for t in tools} == {"echo", "boom"}

        result = await client.call_tool("echo", {"text": "should not run"})
        assert result.is_error is True
        assert result.text == "Stopped by the user — this tool was not run."


async def test_a_notification_is_answered_202_with_a_literally_empty_body() -> None:
    """`notify()` is documented never to parse the reply, so a bridge that
    answered `{}` (or `null`, or a single space) would pass every other test
    here and only be caught by looking at the bytes.

    Proven twice: through the real client's own `notify()` — which raises on
    any status outside {200, 202} — and by reading the raw response.
    """
    token = secrets.token_hex(16)
    async with _running_bridge(token) as bridge:
        client = McpClient(bridge.url, token)
        try:
            await client.notify("notifications/initialized")  # no exception == accepted
        finally:
            await client.aclose()

        async with httpx.AsyncClient(timeout=30.0) as raw:
            resp = await raw.post(
                bridge.url,
                json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
            assert resp.status_code == 202
            assert resp.content == b""
            assert resp.headers.get("content-length") == "0"

            # …and an explicit `"id": null` is NOT a notification: the key is
            # present, so it gets a real reply.
            with_id = await raw.post(
                bridge.url,
                json={"jsonrpc": "2.0", "id": None, "method": "ping"},
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
            assert with_id.status_code == 200
            assert with_id.json() == {"jsonrpc": "2.0", "id": None, "result": {}}


async def test_the_handshake_runs_itself_before_any_tool_traffic() -> None:
    """`ensure_ready()` fires initialize + the initialized NOTIFICATION before
    the first tools/* request. A caller that never calls initialize() by hand
    still exercises the 202-empty-body path on every real turn, so it has to
    work without the client noticing it at all."""
    token = secrets.token_hex(16)
    async with _client(token) as client:
        result = await client.call_tool("echo", {"text": "no explicit initialize"})
        assert result.is_error is False
        assert result.text == "no explicit initialize"


async def test_wrong_bearer_token_is_a_protocol_error_not_a_tool_result() -> None:
    """A rejected bearer is exactly the sort of protocol-level failure
    mcp_client.py's docstring says raises McpError, unlike a tool failure."""
    token = secrets.token_hex(16)
    async with _running_bridge(token) as bridge:
        client = McpClient(bridge.url, "the-wrong-token")
        try:
            with pytest.raises(McpError, match="rejected the bearer token"):
                await client.initialize()
        finally:
            await client.aclose()


async def test_a_bearer_that_merely_starts_with_the_real_token_is_rejected() -> None:
    """The bridge's compare is over the WHOLE value, not a prefix, at every
    length — a truncated token, an extended one, and a wrong scheme.

    Not tested here: the byte-level regression that a length difference of
    exactly 256 must not fold away. That needs NUL bytes inside the header
    value, and no conforming HTTP client will emit one (h11 refuses locally,
    llhttp answers 400 on the far side), so it lives as a unit test on `ctEq`
    itself in src/main/mcpBridge.test.ts. What this proves is the part a
    real client can actually reach.
    """
    token = secrets.token_hex(16)
    async with _running_bridge(token) as bridge:
        async with httpx.AsyncClient(timeout=30.0) as raw:
            forged = [
                f"Bearer {token}x",  # one byte too long
                f"Bearer {token}" + "a" * 255,
                f"Bearer {token}" + "a" * 256,  # the length fold's blind spot
                f"Bearer {token}" + "a" * 512,
                f"Bearer {token[:-1]}",  # one byte too short
                f"Bearer {token[: len(token) // 2]}",  # a genuine prefix
                token,  # the right token, without the scheme
                f"bearer {token}",  # the scheme is compared byte for byte
                "",
            ]
            for value in forged:
                resp = await raw.post(
                    bridge.url,
                    json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                    headers={"Authorization": value},
                )
                assert resp.status_code == 401, f"{value[:40]!r}… was accepted"

            # No Authorization header at all is its own branch.
            missing = await raw.post(
                bridge.url, json={"jsonrpc": "2.0", "id": 1, "method": "ping"}
            )
            assert missing.status_code == 401

            # …and the real one still works, so this is not a blanket refusal.
            ok = await raw.post(
                bridge.url,
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert ok.status_code == 200


async def test_a_request_body_over_the_cap_is_refused_with_413() -> None:
    """The oversize guard, seen from the far side of a real socket and through
    the real client's own error path.

    The cap exists because the bearer token is only checked once the head is
    parsed: anything already running on this Mac could otherwise open the
    loopback port and push bytes into the host's memory until it died, without
    ever knowing the token. `call_tool` turns the resulting protocol failure
    into an isError result rather than an exception, which is how the model
    gets to see it.
    """
    token = secrets.token_hex(16)
    async with _client(token) as client:
        await client.ensure_ready()
        oversized = "a" * (MAX_REQUEST_BODY + 1024)
        result = await client.call_tool("echo", {"text": oversized})
        assert result.is_error is True
        assert "413" in result.text

        # The bridge is still serving afterwards: refusing one caller's
        # oversized body must not take the run's whole tool bridge down.
        ok = await client.call_tool("echo", {"text": "still here"})
        assert ok.is_error is False
        assert ok.text == "still here"


async def test_a_slow_oversized_upload_still_gets_to_READ_its_413() -> None:
    """A refused peer that is STILL UPLOADING must be allowed to finish and read
    the 413 — not reset mid-body.

    ``test_a_request_body_over_the_cap_is_refused_with_413`` above hands httpx a
    16 MiB string, which goes out in well under a second on loopback, so it
    could never see this: the bridge's lingering drain stalled after 500 ms and
    severed the connection, and an RST discards whatever the peer has not read
    yet — including the 413. httpx writes its whole request before reading a
    single reply byte, so the client would have surfaced ``ConnectError`` /
    ``RemoteProtocolError`` instead of the refusal, and the model would have
    been told the room's tool bridge died rather than that its argument was too
    big.

    Raw asyncio streams rather than httpx, because the point is the TIMING of
    the bytes: a body pushed slowly, over a window several times the drain's
    500 ms idle budget.
    """
    token = secrets.token_hex(16)
    async with _running_bridge(token) as bridge:
        reader, writer = await asyncio.open_connection("127.0.0.1", bridge.port)
        try:
            writer.write(
                (
                    f"POST /mcp HTTP/1.1\r\n"
                    f"Host: 127.0.0.1\r\n"
                    f"Authorization: Bearer {token}\r\n"
                    f"Content-Type: application/json\r\n"
                    f"Content-Length: {MAX_REQUEST_BODY * 4}\r\n\r\n"
                ).encode()
            )
            await writer.drain()

            # Push for ~2s — four times the bridge's idle-linger budget —
            # WITHOUT reading anything, exactly as httpx would.
            payload = b"a" * 4096
            for _ in range(20):
                writer.write(payload)
                await writer.drain()
                await asyncio.sleep(0.1)

            # Only now read the reply, the way the real client does.
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
        except (ConnectionResetError, asyncio.IncompleteReadError) as exc:
            raise AssertionError(
                f"the bridge reset a peer that was still uploading, so it never "
                f"delivered its 413 ({type(exc).__name__})"
            ) from None
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError):
                pass

        assert head.startswith(b"HTTP/1.1 413"), head[:64]

    # The same bridge is unusable from here (we tore it down), so prove the
    # ordinary path still works on a fresh one rather than reusing this socket.
    token = secrets.token_hex(16)
    async with _client(token) as client:
        assert (await client.call_tool("echo", {"text": "still fine"})).text == "still fine"


async def test_an_unknown_method_is_a_protocol_error() -> None:
    """Only protocol-level failures are JSON-RPC errors; `_rpc` raises McpError
    carrying the bridge's own message."""
    token = secrets.token_hex(16)
    async with _client(token) as client:
        with pytest.raises(McpError, match="method not found: resources/list"):
            await client._rpc("resources/list")
