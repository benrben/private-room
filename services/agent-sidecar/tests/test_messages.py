"""Message wire-shape helpers stay non-mutating while attaching vision input."""

from arcelle_sidecar.messages import (
    ToolCall,
    assistant_message,
    attach_images,
    canonical_json,
    compact_json,
    system_message,
    tool_message,
    user_message,
)


def test_wire_message_helpers_keep_the_ollama_shape() -> None:
    assert compact_json({"b": "שלום", "a": 1}) == '{"b":"שלום","a":1}'
    assert canonical_json({"b": 2, "a": 1}) == '{"a":1,"b":2}'

    no_id = ToolCall(name="search", arguments={"q": "lease"})
    with_id = ToolCall(name="search", arguments={"b": 2, "a": 1}, id="call-1")
    raw = {"type": "function", "function": {"name": "saved", "arguments": {}}, "id": "saved-1"}

    assert no_id.to_raw() == {"type": "function", "function": {"name": "search", "arguments": {"q": "lease"}}}
    assert with_id.key() == 'search|{"a":1,"b":2}'
    assert with_id.to_raw()["id"] == "call-1"
    assert ToolCall(name="ignored", raw=raw).to_raw() is raw
    assert system_message("rules") == {"role": "system", "content": "rules"}
    assert user_message("look") == {"role": "user", "content": "look"}
    assert user_message("look", ["image"]) == {"role": "user", "content": "look", "images": ["image"]}
    assert assistant_message("ready") == {"role": "assistant", "content": "ready"}
    assert assistant_message("ready", [with_id])["tool_calls"] == [with_id.to_raw()]
    assert tool_message("found", "search") == {"role": "tool", "content": "found", "tool_name": "search"}
    assert tool_message("found", "search", "call-1")["tool_call_id"] == "call-1"


def test_attach_images_returns_plain_copies_when_no_images_are_supplied() -> None:
    messages = [{"role": "user", "content": "describe this"}]

    attached = attach_images(messages, None)

    assert attached == messages
    assert attached[0] is not messages[0]


def test_attach_images_uses_the_latest_user_turn_and_preserves_existing_images() -> None:
    messages = [
        {"role": "user", "content": "older", "images": ["older-image"]},
        {"role": "assistant", "content": "what else?"},
        {"role": "user", "content": "latest", "images": ["latest-image"]},
    ]

    attached = attach_images(messages, ["new-image"])

    assert attached[-1] == {
        "role": "user",
        "content": "latest",
        "images": ["latest-image", "new-image"],
    }
    assert messages[-1]["images"] == ["latest-image"]
    assert attached[0]["images"] == ["older-image"]


def test_attach_images_creates_a_user_turn_when_the_message_list_has_none() -> None:
    messages = [{"role": "system", "content": "rules"}, {"role": "assistant", "content": "ready"}]

    attached = attach_images(messages, ["image-a"])

    assert attached[-1] == {"role": "user", "content": "", "images": ["image-a"]}
    assert messages == [{"role": "system", "content": "rules"}, {"role": "assistant", "content": "ready"}]
