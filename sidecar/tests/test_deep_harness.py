from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.deep_harness import ArcelleHarnessModelAdapter, ArcelleWorkspaceBackend
from arcelle_sidecar.messages import ToolCall


class Bridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((operation, arguments))
        if operation == "read":
            return {
                "file_data": {
                    "content": "hello",
                    "encoding": "utf-8",
                    "created_at": "",
                    "modified_at": "",
                },
                "total_lines": 1,
                "start_line": 1,
                "end_line": 1,
            }
        return {"path": arguments.get("path")}


class Chat:
    async def stream(self, messages, tools, on_delta, cancel=None):
        assert messages[-1]["content"] == "hello"
        assert tools[0]["function"]["name"] == "save"
        await on_delta("done")
        return "done", [ToolCall(name="save", arguments={"x": 1}, id="c1")], RoundUsage(1, 100, True)


@pytest.mark.asyncio
async def test_workspace_backend_never_accepts_private_or_traversal_paths() -> None:
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True)
    assert (await backend.aread("/.arcelle/room.db")).error
    assert (await backend.awrite("/../outside", "no")).error
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_workspace_backend_uses_bridge_and_honours_read_only() -> None:
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=False)
    read = await backend.aread("/notes.md")
    assert read.file_data and read.file_data["content"] == "hello"
    assert (await backend.awrite("/notes.md", "changed")).error == "This run is read-only."
    assert bridge.calls == [("read", {"path": "/notes.md", "offset": 0, "limit": 2000})]


@pytest.mark.asyncio
async def test_model_adapter_preserves_tool_calls() -> None:
    model = ArcelleHarnessModelAdapter(inner=Chat()).bind_tools(
        [
            {
                "type": "function",
                "function": {
                    "name": "save",
                    "description": "save",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]
    )
    result = await model.ainvoke([HumanMessage(content="hello")])
    assert result.content == "done"
    assert result.tool_calls == [{"name": "save", "args": {"x": 1}, "id": "c1", "type": "tool_call"}]
