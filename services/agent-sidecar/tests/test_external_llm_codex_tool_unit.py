"""Pure payload tests for Codex tool catalog rendering.

These cover only dictionary transformation helpers.  They deliberately do not
construct a client or start an external engine.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar import external_llm


def _tool(name: str, parameters: object = None) -> dict[str, object]:
    return {
        "type": "function",
        "retained": {"source": "fixture"},
        "function": {
            "name": name,
            "description": f"Original description for {name}",
            "parameters": {} if parameters is None else parameters,
        },
    }


def test_codex_tool_leaves_malformed_and_unaliased_specs_intact() -> None:
    malformed = {"type": "function", "function": "not-a-function"}
    unaliased = _tool("fetch_page")

    assert external_llm._codex_tool(malformed, {"fetch_page": "read_page"}) is malformed
    assert external_llm._codex_tool(unaliased, {}) is unaliased


def test_codex_tool_renames_and_neutralizes_nested_schema_descriptions() -> None:
    parameters = {
        "type": "object",
        "description": "A Specialist assigns AGENTS.",
        "properties": {
            "task": {
                "type": "string",
                "description": "Ask a specialist agent to inspect this.",
            }
        },
        "oneOf": [{"description": "One AGENT can handle it."}],
    }
    original = _tool("custom_control", parameters)

    rendered = external_llm._codex_tool(
        original, {"custom_control": "arcelle_custom_control"}
    )

    assert rendered["retained"] == {"source": "fixture"}
    function = rendered["function"]
    assert function["name"] == "arcelle_custom_control"
    assert function["description"].startswith(
        "Connected Arcelle application control for the encrypted room."
    )
    assert function["parameters"] == {
        "type": "object",
        "description": "A Arcelle controls assigns Arcelle controls.",
        "properties": {
            "task": {
                "type": "string",
                "description": "Ask a Arcelle controls Arcelle controls to inspect this.",
            }
        },
        "oneOf": [{"description": "One Arcelle controls can handle it."}],
    }
    assert original["function"]["parameters"] is parameters
    assert parameters["description"] == "A Specialist assigns AGENTS."


def test_codex_tool_uses_native_description_for_known_control() -> None:
    original = _tool("ask_web_agent", {"type": "object"})

    rendered = external_llm._codex_tool(
        original, {"ask_web_agent": "work_with_the_web"}
    )

    function = rendered["function"]
    assert function["name"] == "work_with_the_web"
    assert function["description"] == external_llm._CODEX_NATIVE_TOOL_DESCRIPTIONS[
        "ask_web_agent"
    ]


def test_codex_tool_rejects_non_json_schema_before_catalog_is_served() -> None:
    original = _tool("custom_control", {"invalid": object()})

    with pytest.raises(TypeError, match="not JSON serializable"):
        external_llm._codex_tool(original, {"custom_control": "arcelle_custom_control"})


def test_codex_catalog_helpers_filter_hub_only_names_and_keep_aliases() -> None:
    tools = [
        _tool("fetch_page"),
        _tool("ask_web_agent"),
        _tool("request_tools"),
        {"type": "function", "function": {}},
    ]

    assert external_llm._bridge_tools(tools) == ["fetch_page"]
    rendered = external_llm._hub_tools(
        "codex-cli", tools, {"ask_web_agent": "work_with_the_web"}
    )
    assert external_llm._hub_tool_names(rendered) == [
        "fetch_page",
        "work_with_the_web",
        "request_tools",
        "",
    ]
