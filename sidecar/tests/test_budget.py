"""trim_messages_to_budget (SPEC §3.3) — the arithmetic and the two hard exclusions."""

from __future__ import annotations

from privateroom_sidecar.budget import (
    CTX_CHAR_BUDGET,
    msg_len,
    total_chars,
    trim_messages_to_budget,
)
from privateroom_sidecar.messages import Message


def test_budget_matches_the_rust_constant() -> None:
    # commands.rs:90
    assert CTX_CHAR_BUDGET == 36_000


def test_msg_len_counts_tool_calls_json() -> None:
    m: Message = {
        "role": "assistant",
        "content": "abc",
        "tool_calls": [{"function": {"name": "x", "arguments": {}}}],
    }
    assert msg_len(m) == 3 + len('[{"function":{"name":"x","arguments":{}}}]')


def _tool(content: str, name: str = "search_room") -> Message:
    return {"role": "tool", "content": content, "tool_name": name}


def test_under_budget_is_a_no_op() -> None:
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        _tool("x" * 500),
        {"role": "assistant", "content": "a"},
    ]
    before = [dict(m) for m in messages]
    trim_messages_to_budget(messages, tools_chars=100)
    assert messages == before


def test_over_budget_stubs_old_tool_messages_oldest_first() -> None:
    big = "y" * 20_000
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        _tool(big, "search_room"),  # idx 2 — oldest, stubbed first
        _tool(big, "open_file"),  # idx 3 — stubbed next if still over
        {"role": "assistant", "content": "a"},  # last 4 start here
        _tool("z" * 5_000, "web_search"),
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)

    assert messages[2]["content"] == "[search_room result trimmed to fit context — already used above]"
    # One stub freed ~20k, which is enough: the second big result survives.
    assert messages[3]["content"] == big
    assert total_chars(messages, 0) <= CTX_CHAR_BUDGET


def test_stubs_more_than_one_when_one_is_not_enough() -> None:
    big = "y" * 30_000
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        _tool(big, "search_room"),
        _tool(big, "open_file"),
        _tool(big, "fetch_page"),
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "c"},
        {"role": "user", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    # 90k over a 36k budget: two stubs get us under, and the loop stops there —
    # it frees exactly what it must and no more.
    assert messages[1]["content"].startswith("[search_room result trimmed")
    assert messages[2]["content"].startswith("[open_file result trimmed")
    assert messages[3]["content"] == big  # untouched: `over` already reached 0
    assert total_chars(messages, 0) <= CTX_CHAR_BUDGET


def test_never_stubs_the_system_message() -> None:
    # A system message that is itself enormous must survive: it carries the room
    # context and the rules. Index 0 is untouchable even when it's the biggest.
    messages: list[Message] = [
        {"role": "system", "content": "s" * 50_000},
        _tool("t" * 10_000),
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    assert len(messages[0]["content"]) == 50_000


def test_never_stubs_the_last_four_messages() -> None:
    big = "y" * 40_000
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        _tool(big, "a"),
        _tool(big, "b"),
        _tool(big, "c"),
        _tool(big, "d"),
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    # len 5 -> keep_from = 1 -> the loop range [1, 1) is empty: nothing is stubbed.
    assert all(len(m["content"]) == 40_000 for m in messages[1:])


def test_short_tool_results_are_left_alone() -> None:
    # Under 80 chars the stub would save nothing worth the loss.
    short = "z" * 79
    messages: list[Message] = [
        {"role": "system", "content": "s" * 40_000},
        _tool(short),
        _tool("q" * 200),
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    assert messages[1]["content"] == short
    assert messages[2]["content"].startswith("[search_room result trimmed")


def test_budget_counts_utf8_bytes_not_codepoints() -> None:
    # D1: the Rust counts String::len() — BYTES (agent.rs:1145). A Hebrew tool
    # result of 20k codepoints is 40k UTF-8 bytes and MUST be stubbed; counting
    # codepoints (20k) would slip under the 36k budget and overflow num_ctx on
    # exactly the RTL rooms this app ships for (CHG-4/CHG-30).
    hebrew = "א" * 20_000
    assert len(hebrew) == 20_000  # codepoints
    assert len(hebrew.encode("utf-8")) == 40_000  # bytes
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        _tool(hebrew, "search_room"),  # idx 2 — outside the last 4, must be stubbed
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "c"},
        {"role": "user", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    # Under the old codepoint arithmetic total was 20_008 < 36_000: no trim at all.
    assert messages[2]["content"].startswith("[search_room result trimmed")


def test_msg_len_counts_bytes_for_multibyte_content() -> None:
    assert msg_len({"role": "tool", "content": "א" * 10}) == 20  # 10 codepoints, 20 bytes


def test_the_stub_boundary_is_strictly_greater_than_80_bytes() -> None:
    # SPEC §3.3: stub tool results whose content is *> 80* (strictly). Exactly 80
    # bytes is left alone; 81 is stubbed. (Guards the `>` vs `>=` boundary.)
    at = "z" * 80
    over = "z" * 81
    messages: list[Message] = [
        {"role": "system", "content": "s" * 40_000},
        _tool(at, "search_room"),  # idx 1 — exactly 80: left alone
        _tool(over, "open_file"),  # idx 2 — 81: stubbed
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    assert messages[1]["content"] == at
    assert messages[2]["content"].startswith("[open_file result trimmed")


def test_exactly_at_budget_is_a_no_op() -> None:
    # SPEC §3.3: trim only when total *> budget* (`<=` returns unchanged). Guards
    # the exact-budget boundary (`<=` vs `<`).
    messages: list[Message] = [
        {"role": "system", "content": "s" * 100},
        _tool("t" * 20_000, "search_room"),  # idx 1 — stubbable were we over
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    used = total_chars(messages, 0)
    trim_messages_to_budget(messages, tools_chars=CTX_CHAR_BUDGET - used)  # total == budget
    assert total_chars(messages, CTX_CHAR_BUDGET - used) == CTX_CHAR_BUDGET
    assert messages[1]["content"] == "t" * 20_000  # equal to budget: untouched


def test_index_zero_is_guarded_by_index_not_by_role() -> None:
    # The system message lives at index 0 in production, but the guard is the
    # INDEX (messages[1:]), not the `role == "tool"` check. Prove it with a
    # (contrived) tool message at index 0: it must survive, while an equally big
    # tool message at index 1 is stubbed.
    big = "y" * 40_000
    messages: list[Message] = [
        _tool(big, "search_room"),  # idx 0 — untouchable by index
        _tool(big, "open_file"),  # idx 1 — stubbable
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    assert messages[0]["content"] == big
    assert messages[1]["content"].startswith("[open_file result trimmed")


def test_tools_chars_count_against_the_budget() -> None:
    body = "y" * 30_000
    messages: list[Message] = [
        {"role": "system", "content": "sys"},
        _tool(body),
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    trim_messages_to_budget(messages, tools_chars=0)
    assert messages[1]["content"] == body  # 30k alone fits

    messages[1]["content"] = body
    trim_messages_to_budget(messages, tools_chars=10_000)  # 40k does not
    assert messages[1]["content"].startswith("[search_room result trimmed")
