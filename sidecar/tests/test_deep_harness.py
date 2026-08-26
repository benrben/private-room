from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.config import McpConfig, ProviderConfig, Routing, RunRequest
from arcelle_sidecar.deep_harness import (
    ArcelleHarnessModelAdapter,
    ArcelleWorkspaceBackend,
    SAFE_WORKSPACE_FAILURE,
    _subagent_initial_state,
    is_small_parameter_model,
    select_deep_harness,
)
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
async def test_workspace_backend_suppresses_duplicate_mutations_and_honours_cancel() -> None:
    class Cancel:
        cancelled = False

    cancel = Cancel()
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True, cancel=cancel)
    first = await backend.awrite("/notes.md", "changed")
    second = await backend.awrite("/notes.md", "changed")
    assert first.path == second.path == "/notes.md"
    assert bridge.calls == [("write", {"path": "/notes.md", "content": "changed"})]

    cancel.cancelled = True
    assert (await backend.aread("/other.md")).error == "This run was cancelled."
    assert len(bridge.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["raise", "error-result"])
async def test_workspace_backend_never_forwards_raw_bridge_failures(mode: str) -> None:
    secret = "Ben Reich Bearer secret-token /Users/benreich/private-room"

    class FailingBridge:
        async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
            del operation, arguments
            if mode == "raise":
                raise RuntimeError(secret)
            return {"error": secret}

    backend = ArcelleWorkspaceBackend(FailingBridge(), write_enabled=True)
    results = [
        await backend.aread("/notes.md"),
        await backend.awrite("/notes.md", "changed"),
        await backend.als("/"),
        await backend.agrep("secret", "/"),
    ]
    for result in results:
        assert result.error == SAFE_WORKSPACE_FAILURE
        assert "Ben Reich" not in result.error
        assert "secret-token" not in result.error
        assert "/Users/benreich" not in result.error


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
    assert result.usage_metadata == {"input_tokens": 1, "output_tokens": 0, "total_tokens": 1}


def deep_request(**changes: Any) -> RunRequest:
    values: dict[str, Any] = {
        "model": "qwen3:14b",
        "question": "read notes",
        "harness": "deep",
        "run_id": "run-1",
        "mcp": {"url": "http://127.0.0.1:1/mcp", "token": "secret"},
    }
    values.update(changes)
    return RunRequest(**values)


@pytest.mark.asyncio
async def test_ollama_capability_selects_deep_or_deterministic(monkeypatch: pytest.MonkeyPatch) -> None:
    async def tools(_model: str, _base_url: str) -> list[str]:
        return ["completion", "tools"]

    monkeypatch.setattr("arcelle_sidecar.deep_harness.ollama_capabilities", tools)
    capable = await select_deep_harness(deep_request())
    assert capable.use_deep_agent

    async def no_tools(_model: str, _base_url: str) -> list[str]:
        return ["completion"]

    monkeypatch.setattr("arcelle_sidecar.deep_harness.ollama_capabilities", no_tools)
    weak = await select_deep_harness(deep_request(model="tiny:4b"))
    assert not weak.use_deep_agent
    assert weak.small_model
    assert "does not declare tool support" in weak.reason


@pytest.mark.asyncio
async def test_openrouter_declared_tool_capability_is_authoritative() -> None:
    provider = ProviderConfig(
        id="openrouter",
        api_key="not-used",
        base_url="https://openrouter.ai/api/v1",
        model="vendor/model",
        supports_tools=True,
    )
    assert (await select_deep_harness(deep_request(model="openrouter::vendor/model", provider=provider))).use_deep_agent
    no_tools = provider.model_copy(update={"supports_tools": False})
    assert not (await select_deep_harness(deep_request(model="openrouter::vendor/model", provider=no_tools))).use_deep_agent


def test_deep_write_needs_matching_baseline_capability() -> None:
    requested = deep_request(question="edit notes", routing=Routing(write=True))
    assert not requested.deep_workspace_write_authorized()
    mismatched = requested.model_copy(
        update={
            "mcp": McpConfig(
                url="http://127.0.0.1:1/mcp",
                token="secret",
                workspace_write=True,
                baseline_run_id="other-run",
            )
        }
    )
    assert not mismatched.deep_workspace_write_authorized()
    authorized = mismatched.model_copy(
        update={"mcp": mismatched.mcp.model_copy(update={"baseline_run_id": "run-1"})}
    )
    assert authorized.deep_workspace_write_authorized()


def test_deep_specialists_do_not_inherit_network_or_connector_access() -> None:
    state = _subagent_initial_state(
        "web.browser",
        "look it up",
        [],
        write_enabled=False,
        max_rounds=4,
        small_model=True,
    )
    assert state["web_enabled"] is False
    assert state["advisors"] is False
    assert state["write"] is False
    assert state["small_model"] is True
    assert is_small_parameter_model("qwen3.5:4b-mlx")
    assert not is_small_parameter_model("qwen3:14b")
