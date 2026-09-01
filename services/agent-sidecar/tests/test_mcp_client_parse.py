"""Pure payload regression tests for MCP result parsing.

These tests deliberately never construct a client or make a transport call.
"""

from arcelle_sidecar.mcp_client import _parse_tool_result, _tool_specs


def test_parse_tool_result_keeps_text_order_errors_and_valid_images() -> None:
    result = _parse_tool_result(
        {
            "isError": 1,
            "content": [
                {"type": "text", "text": "first"},
                {"type": "image", "data": "aW1hZ2U="},
                {"type": "text"},
                {"type": "image", "data": ""},
                {"type": "image", "data": 42},
                "not-a-content-block",
                {"type": "resource", "uri": "ignored"},
                {"type": "text", "text": 7},
            ],
        }
    )

    assert result.text == "first\n\n7"
    assert result.is_error is True
    assert result.images == ["aW1hZ2U="]


def test_parse_tool_result_stringifies_non_object_results() -> None:
    result = _parse_tool_result(["plain", "result"])

    assert result.text == "['plain', 'result']"
    assert result.is_error is False
    assert result.images == []


def test_tool_specs_filter_bad_items_and_preserve_defaults() -> None:
    specs = _tool_specs(
        {
            "tools": [
                {"name": "notes.list", "description": None, "inputSchema": "invalid"},
                {"name": "", "inputSchema": {}},
                {"description": "missing name"},
                "not-a-tool",
                {"name": "notes.get", "description": 5, "inputSchema": {"type": "object"}},
            ]
        }
    )

    assert [spec.name for spec in specs] == ["notes.list", "notes.get"]
    assert specs[0].description == ""
    assert specs[0].input_schema == {"type": "object", "properties": {}}
    assert specs[1].description == "5"
    assert specs[1].input_schema == {"type": "object"}
