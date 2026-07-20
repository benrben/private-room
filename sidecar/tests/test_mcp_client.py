"""The room MCP bridge client (SPEC §2) — against a faithful fake of room_mcp.rs."""

from __future__ import annotations

import json

import httpx
import pytest

from arcelle_sidecar.mcp_client import McpClient, McpError

TOKEN = "s3cret"
URL = "http://127.0.0.1:53421/mcp"


def bridge(handler=None) -> httpx.AsyncClient:
    """A stand-in for room_mcp.rs: bearer gate, JSON-RPC, 202 for notifications."""
    seen: list[dict] = []

    def default(request: httpx.Request) -> httpx.Response:
        # Auth first, exactly like the Rust (room_mcp.rs:127).
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={})
        body = json.loads(request.content)
        seen.append(body)
        # A request without an id is a notification: 202, EMPTY body.
        if "id" not in body:
            return httpx.Response(202, content=b"")
        method = body.get("method")
        if method == "initialize":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "arcelle", "version": "0.2.3"},
                    },
                },
            )
        if method == "ping":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}})
        if method == "tools/list":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "tools": [
                            {
                                "name": "search_room",
                                "description": "Search all room files",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {"query": {"type": "string"}},
                                    "required": ["query"],
                                },
                            },
                            {"name": "list_room_files", "description": "List files"},
                            # SPEC §2.1: must never be served. If it ever is, drop it.
                            {"name": "consult_advisor", "description": "cloud"},
                        ]
                    },
                },
            )
        if method == "tools/call":
            name = body["params"]["name"]
            if name == "boom":
                # A tool FAILURE is not a JSON-RPC error: isError, so the model sees it.
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "result": {
                            "content": [{"type": "text", "text": "file not found"}],
                            "isError": True,
                        },
                    },
                )
            if name == "view_screenshot":
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "result": {
                            "content": [
                                {"type": "text", "text": "captured"},
                                {"type": "image", "data": "BASE64PNG", "mimeType": "image/png"},
                            ],
                            "isError": False,
                        },
                    },
                )
            if name == "unknown_tool":
                # Protocol-level failure: a real JSON-RPC error (room_mcp.rs:246).
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "error": {"code": -32601, "message": "unknown tool: unknown_tool"},
                    },
                )
            args = body["params"].get("arguments", {})
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "content": [{"type": "text", "text": f"ran {name} with {args}"}],
                        "isError": False,
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {"code": -32601, "message": f"method not found: {method}"},
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler or default))
    client.seen = seen  # type: ignore[attr-defined]
    return client


async def test_initialize_and_notification_no_id() -> None:
    http = bridge()
    async with McpClient(URL, TOKEN, client=http) as mcp:
        info = await mcp.initialize()
    assert info["serverInfo"]["name"] == "arcelle"
    bodies = http.seen  # type: ignore[attr-defined]
    # The initialized notification carries no id — and its 202/empty body must
    # not be parsed as JSON.
    assert bodies[-1]["method"] == "notifications/initialized"
    assert "id" not in bodies[-1]


async def test_ping() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        await mcp.ping()  # no exception == pass


async def test_tools_list_and_ollama_shape() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        tools = await mcp.list_tools()
    names = [t.name for t in tools]
    assert names == ["search_room", "list_room_files"]  # consult_advisor dropped
    spec = tools[0].to_ollama()
    assert spec["type"] == "function"
    assert spec["function"]["name"] == "search_room"
    assert spec["function"]["parameters"]["properties"]["query"]["type"] == "string"
    # A tool served without a schema still gets a valid empty one.
    assert tools[1].to_ollama()["function"]["parameters"] == {"type": "object", "properties": {}}


async def test_consult_advisor_is_never_used_even_if_served() -> None:
    # The recursion guard must hold even if the host regresses (SPEC §2.1).
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        tools = await mcp.list_tools()
    assert not any(t.name == "consult_advisor" for t in tools)


async def test_tools_call_success() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        result = await mcp.call_tool("search_room", {"query": "rent"})
    assert result.is_error is False
    assert "ran search_room" in result.text
    assert result.images == []


async def test_tools_call_is_error_is_not_an_exception() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        result = await mcp.call_tool("boom", {})
    assert result.is_error is True
    assert result.text == "file not found"


async def test_tools_call_image_blocks_become_images() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        result = await mcp.call_tool("view_screenshot", {})
    assert result.text == "captured"
    assert result.images == ["BASE64PNG"]
    assert result.is_error is False


async def test_jsonrpc_error_surfaces_as_a_tool_error() -> None:
    # An unknown tool is a protocol error, but the round must still make progress.
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        result = await mcp.call_tool("unknown_tool", {})
    assert result.is_error is True
    assert "unknown tool" in result.text


async def test_bearer_token_is_required() -> None:
    async with McpClient(URL, "wrong-token", client=bridge()) as mcp:
        with pytest.raises(McpError, match="bearer token"):
            await mcp.list_tools()


async def test_unknown_method_raises() -> None:
    async with McpClient(URL, TOKEN, client=bridge()) as mcp:
        with pytest.raises(McpError, match="method not found"):
            await mcp._rpc("resources/list")


async def test_non_200_raises() -> None:
    def five_hundred(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"")

    async with McpClient(URL, TOKEN, client=bridge(five_hundred)) as mcp:
        with pytest.raises(McpError, match="HTTP 500"):
            await mcp.list_tools()


async def test_call_ids_increment() -> None:
    http = bridge()
    async with McpClient(URL, TOKEN, client=http) as mcp:
        await mcp.ping()
        await mcp.ping()
    ids = [b["id"] for b in http.seen]  # type: ignore[attr-defined]
    assert ids == [1, 2]


async def test_handshake_precedes_tool_traffic_and_runs_once() -> None:
    # The MCP lifecycle handshake (initialize + notifications/initialized) is run
    # automatically before the first tools/* call — a stricter third-party server
    # rejects tool traffic until it has — and exactly once per connection.
    http = bridge()
    async with McpClient(URL, TOKEN, client=http) as mcp:
        await mcp.list_tools()
        await mcp.call_tool("search_room", {"query": "rent"})
    methods = [b.get("method") for b in http.seen]  # type: ignore[attr-defined]
    assert methods[0] == "initialize"
    assert methods[1] == "notifications/initialized"
    assert methods.count("initialize") == 1
    assert methods.index("initialize") < methods.index("tools/list")
    assert methods.index("notifications/initialized") < methods.index("tools/call")
