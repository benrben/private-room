from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, ChatMessage, HumanMessage, SystemMessage, ToolMessage

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.config import McpConfig, ProviderConfig, Routing, RunRequest
from arcelle_sidecar.deep_harness import (
    ArcelleHarnessModelAdapter,
    ArcelleWorkspaceBackend,
    DeepHarnessDecision,
    SAFE_WORKSPACE_FAILURE,
    _arcelle_messages,
    _subagent_initial_state,
    _workspace_mutation_tools,
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


def test_arcelle_messages_preserve_supported_roles_calls_and_order() -> None:
    messages = [
        SystemMessage(content=[{"type": "text", "text": "instructions"}, {"type": "image"}]),
        HumanMessage(content="question"),
        AIMessage(content="answer"),
        AIMessage(
            content="calling",
            tool_calls=[{"id": "call-1", "name": "save", "args": {"path": "/notes.md"}}],
        ),
        ToolMessage(content="written", tool_call_id="call-1", name="save"),
        ToolMessage(content="unnamed", tool_call_id="call-2"),
        ChatMessage(content="ignored", role="other"),
    ]

    assert _arcelle_messages(messages) == [
        {"role": "system", "content": "instructions"},
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
        {
            "role": "assistant",
            "content": "calling",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "save", "arguments": {"path": "/notes.md"}},
                }
            ],
        },
        {"role": "tool", "content": "written", "tool_name": "save", "tool_call_id": "call-1"},
        {"role": "tool", "content": "unnamed", "tool_name": "tool", "tool_call_id": "call-2"},
    ]


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
    assert (await backend.amove("/notes.md", "/Archive/notes.md"))["error"] == "This run was cancelled."
    assert len(bridge.calls) == 1


@pytest.mark.asyncio
async def test_workspace_backend_moves_and_renames_arbitrary_files_without_copying_bytes() -> None:
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True)

    moved = await backend.amove("/Recordings/raw.m4a", "/Archive/meeting.m4a")
    duplicate = await backend.amove("/Recordings/raw.m4a", "/Archive/meeting.m4a")
    renamed = await backend.arename("/Sketches/idea.sketch.json", "final.sketch.json")

    assert moved == duplicate == {"path": None}
    assert renamed == {"path": None}
    assert bridge.calls == [
        (
            "move",
            {
                "source_path": "/Recordings/raw.m4a",
                "destination_path": "/Archive/meeting.m4a",
            },
        ),
        (
            "rename",
            {
                "source_path": "/Sketches/idea.sketch.json",
                "new_name": "final.sketch.json",
                "destination_path": "/Sketches/final.sketch.json",
            },
        ),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("new_name", ["", " . ", "..", "folder/name", r"folder\\name", ".ArCeLlE"])
async def test_workspace_backend_rejects_unsafe_rename_names_without_calling_the_bridge(
    new_name: str,
) -> None:
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True)

    result = await backend.arename("/Sketches/idea.sketch.json", new_name)

    assert result == {"error": "The new name must be one safe file name."}
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_workspace_backend_rejects_private_rename_source_without_calling_the_bridge() -> None:
    bridge = Bridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True)

    result = await backend.arename("/.ArCeLlE/room.db", "copy.db")

    assert result == {"error": "The .arcelle directory is private."}
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_workspace_move_tools_require_write_baseline_and_validate_both_paths() -> None:
    bridge = Bridge()
    read_only = ArcelleWorkspaceBackend(bridge, write_enabled=False)
    assert (await read_only.adelete("/a.pdf")).error == "This run is read-only."
    assert (await read_only.amove("/a.pdf", "/Archive/a.pdf"))["error"] == "This run is read-only."
    assert (await read_only.arename("/a.pdf", "b.pdf"))["error"] == "This run is read-only."

    writable = ArcelleWorkspaceBackend(bridge, write_enabled=True)
    assert (await writable.adelete("/.arcelle/a.pdf")).error
    assert (await writable.amove("/a.pdf", "/.arcelle/a.pdf"))["error"]
    assert (await writable.amove("/../a.pdf", "/a.pdf"))["error"]
    assert (await writable.arename("/a.pdf", "../b.pdf"))["error"]
    assert bridge.calls == []

    tools = {tool.name: tool for tool in _workspace_mutation_tools(writable)}
    assert set(tools) == {"workspace_delete", "workspace_move", "workspace_rename"}
    assert tools["workspace_delete"].args_schema.model_json_schema()["required"] == ["path"]
    assert tools["workspace_rename"].args_schema.model_json_schema()["required"] == [
        "source_path",
        "new_name",
    ]
    await tools["workspace_delete"].ainvoke({"path": "obsolete.pdf"})
    await tools["workspace_move"].ainvoke(
        {"source_path": "/binary.pdf", "destination_path": "/Filed/binary.pdf"}
    )
    await tools["workspace_rename"].ainvoke(
        {"source_path": "/Filed/binary.pdf", "new_name": "signed.pdf"}
    )
    assert bridge.calls[0] == ("delete", {"path": "/obsolete.pdf"})
    assert [operation for operation, _arguments in bridge.calls] == ["delete", "move", "rename"]


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
    for result in [
        await backend.amove("/notes.md", "/Archive/notes.md"),
        await backend.arename("/notes.md", "final.md"),
    ]:
        assert result["error"] == SAFE_WORKSPACE_FAILURE
        assert "Ben Reich" not in result["error"]
        assert "secret-token" not in result["error"]
        assert "/Users/benreich" not in result["error"]


@pytest.mark.asyncio
async def test_workspace_edit_forwards_safe_arguments_maps_result_and_deduplicates() -> None:
    class EditBridge:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, Any]]] = []

        async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
            self.calls.append((operation, arguments))
            return {"path": arguments["path"], "occurrences": 2}

    bridge = EditBridge()
    backend = ArcelleWorkspaceBackend(bridge, write_enabled=True)

    first = await backend.aedit("notes.md", "draft", "final", replace_all=True)
    second = await backend.aedit("notes.md", "draft", "final", replace_all=True)

    assert first.path == second.path == "/notes.md"
    assert first.occurrences == second.occurrences == 2
    assert bridge.calls == [
        (
            "edit",
            {
                "path": "/notes.md",
                "old_string": "draft",
                "new_string": "final",
                "replace_all": True,
            },
        )
    ]


@pytest.mark.asyncio
async def test_workspace_edit_rejects_read_only_and_private_paths_before_the_bridge() -> None:
    bridge = Bridge()

    read_only = ArcelleWorkspaceBackend(bridge, write_enabled=False)
    private = ArcelleWorkspaceBackend(bridge, write_enabled=True)

    assert (await read_only.aedit("/notes.md", "old", "new")).error == "This run is read-only."
    assert (await private.aedit("/.arcelle/room.db", "old", "new")).error == (
        "The .arcelle directory is private."
    )
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_workspace_edit_hides_a_fabricated_bridge_failure() -> None:
    class FailingBridge:
        async def call(self, _operation: str, _arguments: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError("fabricated room contents")

    result = await ArcelleWorkspaceBackend(FailingBridge(), write_enabled=True).aedit(
        "/notes.md", "old", "new"
    )

    assert result.error == SAFE_WORKSPACE_FAILURE


@pytest.mark.asyncio
async def test_workspace_glob_uses_root_by_default_and_maps_matches() -> None:
    class GlobBridge:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, Any]]] = []

        async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
            self.calls.append((operation, arguments))
            return {"matches": ["/notes.md"], "truncated": True}

    bridge = GlobBridge()
    result = await ArcelleWorkspaceBackend(bridge, write_enabled=False).aglob("*.md")

    assert result.matches == ["/notes.md"]
    assert result.truncated is True
    assert result.error is None
    assert bridge.calls == [("glob", {"path": "/", "pattern": "*.md"})]


@pytest.mark.asyncio
async def test_workspace_glob_rejects_private_paths_before_the_bridge() -> None:
    bridge = Bridge()

    result = await ArcelleWorkspaceBackend(bridge, write_enabled=False).aglob(
        "*.md", "/.arcelle"
    )

    assert result.error == "The .arcelle directory is private."
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_workspace_glob_hides_a_fabricated_bridge_error_payload() -> None:
    class FailingBridge:
        async def call(self, _operation: str, _arguments: dict[str, Any]) -> dict[str, Any]:
            return {"error": "fabricated room contents"}

    result = await ArcelleWorkspaceBackend(FailingBridge(), write_enabled=False).aglob(
        "*.md", "/"
    )

    assert result.error == SAFE_WORKSPACE_FAILURE
    assert result.matches is None
    assert result.truncated is False


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
async def test_early_harness_decisions_preserve_their_reason_and_small_model_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def should_not_probe(_model: str, _base_url: str) -> list[str]:
        raise AssertionError("an early harness decision must not probe Ollama")

    monkeypatch.setattr("arcelle_sidecar.deep_harness.ollama_capabilities", should_not_probe)

    assert await select_deep_harness(deep_request(harness="classic", model="qwen3:4b")) == (
        DeepHarnessDecision("deterministic", "The classic harness was requested.", True)
    )
    assert await select_deep_harness(deep_request(mcp=None)) == DeepHarnessDecision(
        "deterministic", "No authenticated workspace bridge is available."
    )
    assert await select_deep_harness(deep_request(model="codex-cli::gpt-5")) == (
        DeepHarnessDecision(
            "deterministic", "This engine uses its native or compatibility harness."
        )
    )


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
    weak = await select_deep_harness(deep_request(model="tiny:12b"))
    assert not weak.use_deep_agent
    assert not weak.small_model
    assert "does not declare tool support" in weak.reason


@pytest.mark.asyncio
async def test_small_ollama_model_keeps_deterministic_4b_protection_even_with_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def tools(_model: str, _base_url: str) -> list[str]:
        nonlocal calls
        calls += 1
        return ["completion", "tools"]

    monkeypatch.setattr("arcelle_sidecar.deep_harness.ollama_capabilities", tools)
    decision = await select_deep_harness(deep_request(model="qwen3.5:4b"))
    assert not decision.use_deep_agent
    assert decision.small_model
    assert "deterministic workspace harness" in decision.reason
    # Size is enough to choose the protected adapter; no metadata/network probe
    # is needed before the run can begin.
    assert calls == 0


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
        image_input_available=False,
        privacy_restricted=True,
    )
    assert state["web_enabled"] is False
    assert state["advisors"] is False
    assert state["write"] is False
    assert state["small_model"] is True
    # ARC-024: a deep child must not regain pixel tools which its parent
    # provider or Cloud Privacy lane could not safely receive.
    assert state["image_input_available"] is False
    assert state["privacy_restricted"] is True
    assert is_small_parameter_model("qwen3.5:4b-mlx")
    assert not is_small_parameter_model("qwen3:14b")
