"""Usage-byte accounting remains after removal of the sidecar context cap."""

from arcelle_sidecar.budget import (
    IMAGE_BYTES,
    fit_oversized_results,
    fit_to_window,
    json_chars,
    msg_len,
    total_chars,
    trim_messages_to_window,
    window_budget_bytes,
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


def test_an_attached_picture_costs_what_it_costs() -> None:
    """An image doesn't ride the context as text, so counting only its caption
    sized the window as if it weren't there — and the daemon's answer to the
    overflow is to delete the system prompt and the question."""
    plain = {"role": "user", "content": "look at this"}
    with_two = {"role": "user", "content": "look at this", "images": ["b64", "b64"]}
    assert msg_len(with_two) == msg_len(plain) + 2 * IMAGE_BYTES


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


def test_an_oversized_user_turn_is_cut_but_keeps_the_question() -> None:
    """An attachment folds a whole file into the user's turn with no limit
    upstream, so one turn can be bigger than any window on its own. Nothing
    could shrink it — both routines only ever cut tool results — so the request
    went out oversized: a red failure on a cloud model, and locally the daemon
    deleting the front of the prompt.

    It is cut here, last, and from the MIDDLE: the host composes the turn as
    room context, then the attached text, then "Question: …", so a head-only cut
    throws away the question itself.
    """
    question = "Question: what is the notice period?"
    messages = [
        {"role": "system", "content": "rules"},
        {
            "role": "user",
            "content": "[attached file: lease.txt]\n" + _big(300_000) + question,
        },
    ]
    out, cut = fit_oversized_results(messages, 20_000)
    assert cut is True
    assert total_chars(out, 0) <= 20_000
    assert out[0]["content"] == "rules", "the system prompt is never touched"
    body = out[1]["content"]
    assert body.startswith("[attached file: lease.txt]")
    assert body.endswith(question), "the question was cut away with the attachment"
    assert "cut here" in body


def test_a_user_turn_is_never_cut_down_to_its_own_marker() -> None:
    """The share a user turn is cut to has a FLOOR, and it is not the tool
    stub's 80 bytes: the marker alone is 62 of those, which leaves ~14 bytes of
    the attachment and ~4 of the question — a deletion wearing a cut's marker.
    """
    question = (
        "Question: what is the notice period, who has to be told, and does the "
        "answer change if the tenant leaves before the break clause? Quote it."
    )
    messages = [
        # A system prompt that nearly fills the budget on its own, so the share
        # left for the turn is far below the floor.
        {"role": "system", "content": _big(9_000)},
        {"role": "user", "content": _big(50_000) + question},
    ]
    out, cut = fit_oversized_results(messages, 9_500)
    assert cut is True
    body = out[1]["content"]
    assert body.endswith(question), (
        f"the question was cut away with the attachment: {body[-120:]!r}"
    )
    assert "cut here" in body


def test_a_user_turn_is_left_whole_when_cutting_it_cannot_make_the_payload_fit() -> None:
    """A local 8k window in a room with a big inventory-bearing system prompt:
    the system prompt and the tool catalog exceed the budget between them, and
    neither can be cut. The request goes out oversized whatever this pass does,
    so shredding the question the user just typed buys nothing — and the daemon's
    own context-shift eats the FRONT of the prompt, leaving the question (which
    the host composes LAST) standing.

    It also stays shredded: the trim mutates in place and the local path shares
    these dicts with the graph's history, so one hopeless cut would follow the
    turn through every remaining round.
    """
    question = "Question: which of my files mentions the notice period?"
    messages = [
        {"role": "system", "content": _big(12_000)},
        {"role": "user", "content": "[room context]\n" + _big(5_000) + question},
    ]
    catalog = 20_000  # the serialized tool catalog, billed with the messages
    assert total_chars(messages, catalog) > window_budget_bytes(8_192)

    assert trim_messages_to_window(messages, catalog, 8_192) is False
    assert messages[1]["content"].endswith(question)
    assert "cut here" not in messages[1]["content"]


def test_the_user_s_words_are_the_last_thing_cut() -> None:
    """Tool results first, always: they have been read once already, and the
    user's own turn is the one thing nothing else can reconstruct."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "Question: summarise the page"},
        {"role": "tool", "content": _big(300_000), "tool_name": "fetch_page"},
    ]
    out, cut = fit_oversized_results(messages, 50_000)
    assert cut is True
    assert out[1]["content"] == "Question: summarise the page"
    assert "cut here" in out[2]["content"]


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


# --------------------------------------------------------------------------- #
# nothing is cut that does not have to be
# --------------------------------------------------------------------------- #


def test_a_fresh_result_is_not_cut_when_stubbing_already_made_it_fit() -> None:
    """Pass 1 stubs the old results, and that can be enough on its own. Running
    the equal-share pass anyway chops whatever is biggest — a page the model has
    just read, halved for nothing, on a turn that already fit."""
    messages = [
        {"role": "system", "content": "rules"},
        {"role": "tool", "tool_name": "fetch_page", "content": _big(20_000)},  # old
        {"role": "tool", "tool_name": "browse_read", "content": _big(12_000)},
        {"role": "tool", "tool_name": "search_room", "content": _big(1_000)},
        {"role": "tool", "tool_name": "list_room_files", "content": _big(1_000)},
        {"role": "user", "content": "and now?"},
    ]
    assert trim_messages_to_window(messages, 0, 8_192) is True
    assert "already used above" in messages[1]["content"], "pass 1 did not run"
    assert messages[2]["content"] == _big(12_000), (
        "the freshest result was cut on a turn that already fit"
    )
    assert total_chars(messages, 0) <= window_budget_bytes(8_192)


# --------------------------------------------------------------------------- #
# the one-shot jobs: translate, summarise a whole file, generate a document
# --------------------------------------------------------------------------- #


def test_a_one_shot_payload_is_fitted_to_the_window_it_asked_for() -> None:
    """These paths compose a payload, ask for a window and send whatever they
    have. Past the biggest window this Mac may ask for, the daemon deletes the
    FRONT of the prompt — the instruction — and answers a question it can no
    longer see, plausibly and wrongly."""
    messages = [
        {"role": "system", "content": "Translate the text below into French."},
        {"role": "user", "content": _big(400_000) + "\n[end]"},
    ]
    before = [dict(m) for m in messages]
    out, cut = fit_to_window(messages, 8_192)
    assert cut is True
    assert total_chars(out, 0) <= window_budget_bytes(8_192)
    assert out[0]["content"] == "Translate the text below into French."
    assert out[1]["content"].endswith("[end]")
    assert messages == before, "the caller's own messages were mutated"


def test_a_one_shot_call_on_a_model_that_owns_its_window_is_untouched() -> None:
    messages = [{"role": "user", "content": _big(400_000)}]
    out, cut = fit_to_window(messages, None)
    assert cut is False and out is messages
