"""Usage-byte accounting remains after removal of the sidecar context cap."""

from arcelle_sidecar.budget import (
    fit_oversized_results,
    json_chars,
    msg_len,
    total_chars,
)


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


# --------------------------------------------------------------------------- #
# the CLOUD hole: one oversized tool result, and nothing to catch it
#
# Live report 2026-07-30: "open finance.yahoo.com, use the screener ... list the
# first five" failed four times running, and the Web agent failed with it. Every
# guard has a hole a single big result walks through — `clamp_tool_result` is a
# no-op, `trim_messages_to_window` returns on `num_ctx is None` (every cloud and
# CLI engine) and is only ever called by `chat.py`, and compaction keeps the
# recent tail verbatim. So the request went out oversized, the provider rejected
# it, the worker returned no report, and `_run_worker` scored that `ok=False`.
# --------------------------------------------------------------------------- #


def test_one_oversized_tool_result_is_cut_down_to_the_budget() -> None:
    """The shape of the failing turn: a `fetch_page` of a heavy site."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "list the first five"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": _big(600_000), "tool_name": "fetch_page"},
    ]
    budget = 50_000
    assert total_chars(messages, 0) > budget

    out, cut = fit_oversized_results(messages, budget)
    assert cut is True
    assert total_chars(out, 0) <= budget, (
        "the payload still exceeds the window the provider stated — this is "
        "the request that comes back rejected"
    )
    # The parts that make the remainder intelligible are untouched...
    assert out[0]["content"] == "rules"
    assert out[1]["content"] == "list the first five"
    assert out[2]["tool_calls"] == [{"id": "1"}]
    # ...and the cut is legible rather than silent.
    assert "cut here" in out[3]["content"]
    assert out[3]["content"].startswith("x")


def test_fitting_never_mutates_the_caller_s_messages() -> None:
    """`compact_to_budget` promises the input list is not mutated; this runs
    inside it, so it has to keep that promise too."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "tool", "content": _big(200_000), "tool_name": "browse_read"},
    ]
    before = [dict(m) for m in messages]
    out, cut = fit_oversized_results(messages, 10_000)
    assert cut is True
    assert messages == before
    assert out is not messages


def test_a_payload_that_already_fits_is_returned_unchanged() -> None:
    messages = [{"role": "tool", "content": "short", "tool_name": "web_search"}]
    out, cut = fit_oversized_results(messages, 1_000_000)
    assert cut is False and out is messages


def test_an_unknown_window_is_left_alone() -> None:
    """No stated window means no authority to cut — same contract as the trim."""
    messages = [{"role": "tool", "content": _big(900_000), "tool_name": "fetch_page"}]
    out, cut = fit_oversized_results(messages, None)
    assert cut is False and out is messages


def test_a_turn_with_nothing_but_prose_is_left_alone() -> None:
    """Only tool results are ever cut. An oversized USER turn is the user's own
    words, and stubbing those would answer a question nobody asked."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": _big(300_000)},
    ]
    out, cut = fit_oversized_results(messages, 1_000)
    assert cut is False and out is messages


def test_many_results_share_what_the_fixed_parts_leave() -> None:
    messages = [{"role": "system", "content": "rules"}] + [
        {"role": "tool", "content": _big(120_000), "tool_name": f"t{i}"}
        for i in range(4)
    ]
    out, cut = fit_oversized_results(messages, 40_000)
    assert cut is True
    assert total_chars(out, 0) <= 40_000
    # Every one of them survives in part — the failure being prevented is one
    # result being kept whole while the others vanish.
    for m in out[1:]:
        assert m["content"].startswith("x") and "cut here" in m["content"]


def test_the_tool_catalog_counts_against_the_same_budget() -> None:
    """`reserved_bytes` is the offered catalog, which is billed with the
    messages. Ignoring it fits the messages and still overflows the request."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "tool", "content": _big(40_000), "tool_name": "fetch_page"},
    ]
    # Fits comfortably on its own...
    assert fit_oversized_results(messages, 50_000)[1] is False
    # ...and does not once a 30 KB catalog is billed alongside it.
    out, cut = fit_oversized_results(messages, 50_000, 30_000)
    assert cut is True
    assert total_chars(out, 30_000) <= 50_000
