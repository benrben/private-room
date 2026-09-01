"""Fake-transport unit coverage for the MCP workspace bridge."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar.deep_harness import McpWorkspaceBridge, SAFE_WORKSPACE_FAILURE


class FakeMcp:
    def __init__(self, result: SimpleNamespace) -> None:
        self.result = result
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        self.calls.append((name, arguments))
        return self.result


@pytest.mark.asyncio
async def test_mcp_workspace_bridge_forwards_the_workspace_operation_and_object_payload() -> None:
    mcp = FakeMcp(SimpleNamespace(is_error=False, text='{"path":"/notes.md","size":7}'))
    bridge = McpWorkspaceBridge(mcp=mcp)  # type: ignore[arg-type]

    result = await bridge.call("read", {"path": "/notes.md"})

    assert result == {"path": "/notes.md", "size": 7}
    assert mcp.calls == [("workspace_read", {"path": "/notes.md"})]


@pytest.mark.asyncio
async def test_mcp_workspace_bridge_hides_fake_transport_errors() -> None:
    mcp = FakeMcp(SimpleNamespace(is_error=True, text="fake private transport detail"))

    assert await McpWorkspaceBridge(mcp=mcp).call("write", {"path": "/notes.md"}) == {
        "error": SAFE_WORKSPACE_FAILURE
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("not fake json", {"error": "The workspace bridge returned an invalid response."}),
        ("[\"not\", \"an\", \"object\"]", {"error": "Invalid workspace response."}),
    ],
)
async def test_mcp_workspace_bridge_rejects_invalid_fake_payloads(
    text: str,
    expected: dict[str, str],
) -> None:
    mcp = FakeMcp(SimpleNamespace(is_error=False, text=text))

    assert await McpWorkspaceBridge(mcp=mcp).call("list", {}) == expected
