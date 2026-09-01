from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar import deep_harness as harness


@pytest.mark.parametrize(
    ("write_enabled", "expected_mode"),
    [(True, "allow"), (False, "deny")],
)
def test_build_deep_agent_wires_only_fabricated_workspace_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    write_enabled: bool,
    expected_mode: str,
) -> None:
    captured: dict[str, Any] = {"compiled": []}
    result = object()
    mcp = object()
    cancel = object()
    chat = object()

    class FakeBridge:
        def __init__(self, received_mcp: object) -> None:
            captured["bridge_mcp"] = received_mcp
            captured["bridge"] = self

    class FakeBackend:
        def __init__(self, bridge: object, *, write_enabled: bool, cancel: object) -> None:
            captured["backend"] = (bridge, write_enabled, cancel)
            captured["backend_instance"] = self

    class FakeAdapter:
        def __init__(self, *args: object) -> None:
            captured["adapter_args"] = args

        def compile(self, agent_id: str) -> str:
            captured["compiled"].append(agent_id)
            return f"compiled:{agent_id}"

    class FakePermission:
        def __init__(self, **kwargs: object) -> None:
            captured.setdefault("permissions", []).append(kwargs)
            captured.setdefault("permission_instances", []).append(self)

    class FakeModel:
        def __init__(self, **kwargs: object) -> None:
            captured["model"] = kwargs
            captured["model_instance"] = self

    def fake_workspace_tools(backend: object) -> list[str]:
        captured["tools_backend"] = backend
        return ["fake-workspace-tool"]

    def fake_create_deep_agent(**kwargs: object) -> object:
        captured["create"] = kwargs
        return result

    agents = {
        "chat.answer": SimpleNamespace(id="chat.answer", prompt="fake system prompt"),
        "research": SimpleNamespace(id="research"),
        "writer": SimpleNamespace(id="writer"),
    }
    monkeypatch.setattr(harness, "McpWorkspaceBridge", FakeBridge)
    monkeypatch.setattr(harness, "ArcelleWorkspaceBackend", FakeBackend)
    monkeypatch.setattr(harness, "ArcelleCompiledSubAgentAdapter", FakeAdapter)
    monkeypatch.setattr(harness, "FilesystemPermission", FakePermission)
    monkeypatch.setattr(harness, "ArcelleHarnessModelAdapter", FakeModel)
    monkeypatch.setattr(harness, "_workspace_mutation_tools", fake_workspace_tools)
    monkeypatch.setattr(harness, "create_deep_agent", fake_create_deep_agent)
    monkeypatch.setattr(harness, "REGISTRY", list(agents.values()))
    monkeypatch.setattr(harness, "get_agent", agents.__getitem__)

    deps = SimpleNamespace(mcp=mcp, cancel=cancel, chat=chat)
    assert harness.build_deep_agent(
        deps,
        write_enabled=write_enabled,
        max_rounds=7,
        small_model=True,
        image_input_available=False,
        privacy_restricted=True,
    ) is result

    bridge, backend_write, backend_cancel = captured["backend"]
    assert captured["bridge_mcp"] is mcp
    assert bridge is captured["bridge"]
    assert backend_write is write_enabled
    assert backend_cancel is cancel
    assert captured["adapter_args"] == (
        deps,
        write_enabled,
        7,
        True,
        False,
        True,
    )
    assert captured["compiled"] == ["research", "writer"]
    assert captured["model"] == {"inner": chat, "cancel": cancel}
    assert captured["tools_backend"] is captured["backend_instance"]
    assert captured["permissions"] == [
        {"operations": ["read"], "paths": ["/.arcelle/**"], "mode": "deny"},
        {"operations": ["write"], "paths": ["/**"], "mode": expected_mode},
    ]
    created = captured["create"]
    assert created["model"] is captured["model_instance"]
    assert created["tools"] == ["fake-workspace-tool"]
    assert created["system_prompt"] == "fake system prompt"
    assert created["backend"] is captured["backend_instance"]
    assert created["permissions"] == captured["permission_instances"]
    assert created["subagents"] == ["compiled:research", "compiled:writer"]
    assert created["name"] == "arcelle-deep-harness"


def test_build_deep_agent_refuses_to_construct_any_dependency_without_mcp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise AssertionError("a missing MCP bridge must fail before any constructor")

    monkeypatch.setattr(harness, "McpWorkspaceBridge", unexpected)
    monkeypatch.setattr(harness, "create_deep_agent", unexpected)

    with pytest.raises(RuntimeError, match="authenticated Arcelle MCP bridge"):
        harness.build_deep_agent(
            SimpleNamespace(mcp=None, cancel=object(), chat=object()),
            write_enabled=False,
            max_rounds=1,
        )


@pytest.mark.asyncio
async def test_compiled_subagent_runs_only_through_fabricated_graph_dependencies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {
        "finals": [{"final_text": "Fabricated result"}, {}, RuntimeError("fake graph failure")]
    }
    spec = SimpleNamespace(id="writer", summary="Fabricated specialist")

    class FakeStateGraph:
        def __init__(self, state_type: object) -> None:
            captured["state_type"] = state_type

        def add_node(self, name: str, runnable: object) -> None:
            captured["node"] = (name, runnable)

        def add_edge(self, start: object, end: object) -> None:
            captured.setdefault("edges", []).append((start, end))

        def compile(self) -> object:
            return "fake-compiled-graph"

    class FakeCompiledSubAgent:
        def __init__(self, **kwargs: object) -> None:
            captured["subagent"] = kwargs

    class FakeGraph:
        async def ainvoke(self, initial: dict[str, Any], *, config: dict[str, Any]) -> dict[str, str]:
            captured.setdefault("invocations", []).append((initial, config))
            final = captured["finals"].pop(0)
            if isinstance(final, Exception):
                raise final
            return final

    class FakeDeps:
        def for_child(self, agent_id: str) -> str:
            captured.setdefault("child_ids", []).append(agent_id)
            return f"fake-child:{agent_id}"

    def fake_messages(raw: list[object]) -> list[dict[str, str]]:
        captured.setdefault("raw_messages", []).append(raw)
        if not raw:
            return [{"role": "system", "content": "Fabricated system"}]
        return [
            {"role": "system", "content": "Fabricated system"},
            {"role": "user", "content": "Earlier fake question"},
            {"role": "user", "content": "Latest fake question"},
        ]

    monkeypatch.setattr(harness, "get_agent", lambda agent_id: spec)
    monkeypatch.setattr(harness, "StateGraph", FakeStateGraph)
    monkeypatch.setattr(harness, "CompiledSubAgent", FakeCompiledSubAgent)
    monkeypatch.setattr(harness, "_arcelle_messages", fake_messages)
    monkeypatch.setattr(harness, "graph_for", lambda agent_id: FakeGraph())
    monkeypatch.setattr(harness, "recursion_limit_for", lambda agent_id, rounds: 73)

    adapter = harness.ArcelleCompiledSubAgentAdapter(
        FakeDeps(),
        write_enabled=True,
        max_rounds=9,
        small_model=True,
        image_input_available=False,
        privacy_restricted=True,
    )
    compiled = adapter.compile("writer")
    run = captured["node"][1]
    source_messages = [object()]

    first = await run({"messages": source_messages})
    second = await run({})
    with pytest.raises(RuntimeError, match="fake graph failure"):
        await run({})

    assert compiled is not None
    assert captured["subagent"] == {
        "name": "writer",
        "description": "Fabricated specialist",
        "runnable": "fake-compiled-graph",
    }
    assert captured["raw_messages"] == [source_messages, [], []]
    assert captured["child_ids"] == ["writer", "writer", "writer"]
    first_initial, first_config = captured["invocations"][0]
    assert first_initial["question"] == "Latest fake question"
    assert first_initial["messages"][0] == {"role": "system", "content": "Fabricated system"}
    assert first_initial["write"] is True
    assert first_initial["max_rounds"] == 9
    assert first_initial["small_model"] is True
    assert first_initial["image_input_available"] is False
    assert first_initial["privacy_restricted"] is True
    assert first_config == {
        "configurable": {"deps": "fake-child:writer"},
        "recursion_limit": 73,
    }
    assert first["messages"][0].content == "Fabricated result"
    second_initial, _second_config = captured["invocations"][1]
    assert second_initial["question"] == ""
    assert second["messages"][0].content == "Done."
