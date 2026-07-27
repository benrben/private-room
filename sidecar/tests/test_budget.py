"""Usage-byte accounting remains after removal of the sidecar context cap."""

from arcelle_sidecar.budget import json_chars, msg_len, total_chars


def test_message_and_tool_bytes_are_counted_without_mutation() -> None:
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "tool", "content": "שלום", "tool_name": "search_room"},
    ]
    before = [dict(message) for message in messages]
    assert msg_len(messages[1]) == len("שלום".encode("utf-8"))
    assert total_chars(messages, 7) == sum(msg_len(m) for m in messages) + 7
    assert messages == before


def test_json_chars_matches_compact_utf8_wire_shape() -> None:
    value = {"name": "write_file", "text": "שלום"}
    assert json_chars(value) == len(
        '{"name":"write_file","text":"שלום"}'.encode("utf-8")
    )


# --------------------------------------------------------------------------- #
# the trimmer must not eat the user's answer
# --------------------------------------------------------------------------- #


def _big(n: int) -> str:
    return "x" * n


def test_room_tool_results_are_trimmed_before_specialist_reports() -> None:
    """A REPORT is answer material; a room-tool result has already been read.

    Pass 1's stub says "already used above". For a room-tool result that is
    true — the assistant turn after it summarised what it found. For a
    specialist's report it is false: in the hub thread the turn after a report
    is the next delegation, and the only turn that consumes reports is the
    tool-less synthesis that has not run yet. Stubbing one deletes a part of the
    user's answer while the agent strip still shows that specialist green.
    """
    from arcelle_sidecar.budget import trim_messages_to_window

    messages = [
        {"role": "system", "content": "rules"},
        {"role": "tool", "tool_name": "search_room", "content": _big(4000)},
        {"role": "tool", "tool_name": "ask_file_agent", "content": "FOUND: " + _big(4000)},
        {"role": "assistant", "content": "thinking"},
        {"role": "user", "content": "and?"},
        {"role": "assistant", "content": "…"},
        {"role": "user", "content": "?"},
    ]
    assert trim_messages_to_window(messages, 0, num_ctx=4096) is True

    room = messages[1]["content"]
    report = messages[2]["content"]
    assert "already used above" in room, "the room-tool result should go first"
    assert "already used above" not in report, (
        "the specialist's report was stubbed while a room-tool result survived"
    )


def test_a_report_that_must_be_cut_keeps_its_head() -> None:
    """When even the reports have to shrink, a four-part answer should degrade
    to four PARTIAL parts — never to three parts and a silent hole."""
    from arcelle_sidecar.budget import trim_messages_to_window

    messages = [
        {"role": "system", "content": "rules"},
        {
            "role": "tool",
            "tool_name": "ask_file_agent",
            "content": "FOUND: the rent is 1200. " + _big(20000),
        },
        {
            "role": "tool",
            "tool_name": "ask_web_agent",
            "content": "FOUND: the market is 1300. " + _big(20000),
        },
        {"role": "assistant", "content": "…"},
        {"role": "user", "content": "?"},
        {"role": "assistant", "content": "…"},
        {"role": "user", "content": "?"},
    ]
    assert trim_messages_to_window(messages, 0, num_ctx=2048) is True

    for m in messages[1:3]:
        body = m["content"]
        assert body.startswith("FOUND:"), (
            f"a report lost its head, which is the part the answer is built "
            f"from: {body[:80]!r}"
        )
        assert "cut here" in body
        # ...and never replaced wholesale by pass 1's stub, which would leave
        # this specialist contributing nothing while its chip reads green.
        assert "already used above" not in body
    # BOTH survive: the failure mode being prevented is one report vanishing
    # entirely while the other is untouched.
    assert messages[1]["content"] != messages[2]["content"]
