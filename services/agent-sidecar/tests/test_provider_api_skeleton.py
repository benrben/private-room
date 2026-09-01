"""Pure message-shape tests; these fixtures never create an HTTP client."""

from arcelle_sidecar import provider_api


def test_message_skeleton_keeps_only_roles_and_tool_pairing_ids() -> None:
    skeleton = provider_api._message_skeleton(
        [
            {"role": "system", "content": "SECRET SYSTEM TEXT"},
            {"role": "assistant", "content": "plain assistant"},
            {
                "role": "assistant",
                "content": "SECRET TOOL REQUEST",
                "tool_calls": [{"id": "call-1"}, {"function": {"name": "read"}}],
            },
            {"role": "tool", "content": "SECRET TOOL RESULT", "tool_call_id": "call-1"},
            {"role": "tool", "content": "missing id"},
            {"content": "missing role"},
        ]
    )

    assert skeleton == "system assistant assistant[calls:call-1,-] tool[for:call-1] tool[for:-] ?"
    assert "SECRET" not in skeleton
